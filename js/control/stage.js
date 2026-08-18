/**
 * The stage: camera view, live preview, and all shape editing.
 *
 * Everything you draw here is stored in normalised *world* coordinates, which is
 * what lets one traced window drive several projectors at once — each projector
 * converts world coordinates into its own output through its homography, so the
 * geometry is authored once and warped many times.
 *
 * The stage itself is the camera's picture, and stays the camera's picture even
 * once the wall has been squared up. Two reasons. Resampling somebody's
 * photograph so the wall looks square would throw away sharpness at exactly the
 * end of the building where there is least of it to spare. And squaring the wall
 * is a thing you do *to* the camera view, so the tool for it has to be able to
 * see the camera view. So world coordinates are converted at the boundary —
 * `intoWorld` on the way in from a pointer, `ontoCamera` on the way out to a
 * pixel — and the conversion is the identity until somebody squares the wall.
 *
 * The preview deliberately runs the real renderer rather than a simplified
 * version, so what you tune indoors is what appears on the wall.
 */

import { clamp, distToSegment, pointInPolygon, boundingBox, applyH, solveHomography } from '../core/math.js';
import { worldSize, createShape } from '../core/state.js';
import { rectifyMatrix, rectifyInverse, worldToProjector } from '../core/rectify.js';
import { projectorOutline } from './calibration.js';

const HANDLE_RADIUS = 5;
const HIT_RADIUS = 10;

const PROJECTOR_COLOURS = ['#4cc2ff', '#ff7a18', '#35d07f', '#bf5af2', '#ffd60a', '#ff4d6a'];

export function createStage({ canvas, wrap, app }) {
  const g = canvas.getContext('2d');

  let cssWidth = 0;
  let cssHeight = 0;
  let dpr = 1;

  /** In-progress polygon/path being drawn. */
  let drafting = null;
  /** Active pointer gesture. */
  let gesture = null;
  let hover = { shapeId: null, vertex: -1, edge: -1, corner: -1 };
  let pointerWorld = null;

  /* ---------------------------------------------------------------- *
   * Sizing
   * ---------------------------------------------------------------- */

  function resize() {
    // The camera's aspect, not the world's: the backdrop is what fills this
    // canvas, and letterboxing it to a rectified world aspect would squash the
    // photograph everything is traced against.
    const aspect = app.backdropAspect?.() || worldSize(app.project).aspect;
    const rect = wrap.getBoundingClientRect();
    const available = { w: Math.max(80, rect.width - 16), h: Math.max(60, rect.height - 16) };

    // Letterbox that aspect inside whatever space the layout gives us.
    let w = available.w;
    let h = w / aspect;
    if (h > available.h) {
      h = available.h;
      w = h * aspect;
    }

    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cssWidth = Math.round(w);
    cssHeight = Math.round(h);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
  }

  /* ---------------------------------------------------------------- *
   * Coordinate conversion
   * ---------------------------------------------------------------- */

  /** Pointer event -> normalised camera coordinates, which is what the canvas is. */
  function toCamera(ev) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - rect.left) / rect.width,
      y: (ev.clientY - rect.top) / rect.height,
    };
  }

  /** Camera -> world, for anything about to be stored. */
  function intoWorld(p) {
    const inv = rectifyInverse(app.project);
    if (!inv) return { x: p.x, y: p.y };
    return applyH(inv, p.x, p.y) || { x: p.x, y: p.y };
  }

  /** World -> camera, for anything about to be drawn or hit-tested. */
  function ontoCamera(p) {
    const H = rectifyMatrix(app.project);
    if (!H) return { x: p.x, y: p.y };
    return applyH(H, p.x, p.y) || { x: p.x, y: p.y };
  }

  const camPoints = (points) => points.map(ontoCamera);

  /** Pointer event -> normalised world coordinates. */
  const toWorld = (ev) => intoWorld(toCamera(ev));

  /**
   * Distance in camera units that corresponds to a screen-pixel radius.
   *
   * Hit testing happens in camera space rather than world space precisely so
   * that this stays one number. Rectification scales the two axes differently
   * and by a different amount at each end of the wall, so a tolerance expressed
   * in world units would make handles at the far end of an oblique wall
   * unclickable and handles at the near end grab from a mile off.
   */
  const hitTolerance = (px) => px / Math.max(1, cssWidth);

  /**
   * The body font, read once.
   *
   * `getComputedStyle` forces the browser to flush pending style and layout
   * work before it can answer, and this was being asked two or three times a
   * frame, in the middle of drawing, for a value that never changes. The
   * synchronous flush is the expensive part, not the lookup — it is why a
   * canvas-only render loop was showing style-recalculation time at all.
   */
  let bodyFont = null;
  const labelFont = (px) => {
    if (!bodyFont) bodyFont = getComputedStyle(document.body).fontFamily;
    return `${px}px ${bodyFont}`;
  };

  /* ---------------------------------------------------------------- *
   * Hit testing
   * ---------------------------------------------------------------- */

  function hitTest(cam) {
    const tol = hitTolerance(HIT_RADIUS);
    const result = { shapeId: null, vertex: -1, edge: -1, corner: -1 };

    // The squaring handles own the canvas while that tool is active.
    if (app.tool === 'square') {
      const quad = app.rectifyDraft?.quad;
      if (quad) {
        for (let i = 0; i < quad.length; i++) {
          if (Math.hypot(quad[i].x - cam.x, quad[i].y - cam.y) < tol * 1.6) {
            result.corner = i;
            return result;
          }
        }
      }
      return result;
    }

    // Manual projector corners take precedence while the corners tool is active.
    if (app.tool === 'corners') {
      const projector = app.selectedProjector();
      const quad = projector?.calibration?.worldQuad;
      if (quad) {
        for (let i = 0; i < quad.length; i++) {
          const c = ontoCamera(quad[i]);
          if (Math.hypot(c.x - cam.x, c.y - cam.y) < tol * 1.4) {
            result.corner = i;
            return result;
          }
        }
      }
      return result;
    }

    // Search selected shape first, then the rest, so a shape stays grabbable
    // when it overlaps others.
    const shapes = app.project.shapes.filter((s) => s.visible !== false && !s.locked);
    const ordered = [...shapes].sort((a, b) => {
      const aSel = a.id === app.selection.id ? 1 : 0;
      const bSel = b.id === app.selection.id ? 1 : 0;
      return bSel - aSel;
    });

    // One conversion per shape, reused by all three passes below.
    const projected = new Map(ordered.map((shape) => [shape.id, camPoints(shape.points)]));

    for (const shape of ordered) {
      const pts = projected.get(shape.id);
      for (let i = 0; i < pts.length; i++) {
        if (Math.hypot(pts[i].x - cam.x, pts[i].y - cam.y) < tol) {
          result.shapeId = shape.id;
          result.vertex = i;
          return result;
        }
      }
    }

    for (const shape of ordered) {
      const pts = projected.get(shape.id);
      const last = shape.closed ? pts.length : pts.length - 1;
      for (let i = 0; i < last; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        if (distToSegment(cam, a, b).dist < tol * 0.8) {
          result.shapeId = shape.id;
          result.edge = i;
          return result;
        }
      }
    }

    for (const shape of ordered) {
      const pts = projected.get(shape.id);
      if (shape.closed && pts.length > 2 && pointInPolygon(cam, pts)) {
        result.shapeId = shape.id;
        return result;
      }
    }

    return result;
  }

  /* ---------------------------------------------------------------- *
   * Pointer handling
   * ---------------------------------------------------------------- */

  function onPointerDown(ev) {
    if (ev.button === 2) return;
    canvas.setPointerCapture(ev.pointerId);
    const cam = toCamera(ev);
    const world = clampWorld(intoWorld(cam));

    // The squaring quad is marked on the camera picture and never leaves it:
    // it is the description of that picture's point of view, so it cannot be
    // expressed in a space that only exists once it has been applied.
    if (app.tool === 'square') {
      const hit = hitTest(cam);
      if (hit.corner >= 0) gesture = { kind: 'square', index: hit.corner };
      return;
    }

    if (app.tool === 'polygon' || app.tool === 'path') {
      addDraftPoint(world, ev.shiftKey);
      return;
    }

    if (app.tool === 'rect') {
      gesture = { kind: 'rect', origin: world, current: world };
      return;
    }

    const hit = hitTest(cam);

    if (app.tool === 'corners') {
      if (hit.corner >= 0) {
        app.pushUndo();
        gesture = { kind: 'corner', index: hit.corner };
      }
      return;
    }

    if (!hit.shapeId) {
      app.select(null);
      return;
    }

    app.select({ type: 'shape', id: hit.shapeId });
    const shape = app.project.shapes.find((s) => s.id === hit.shapeId);
    if (!shape) return;

    if (hit.vertex >= 0) {
      if (ev.altKey) {
        // Alt-click a vertex to remove it, as long as a usable shape remains.
        if (shape.points.length > (shape.closed ? 3 : 2)) {
          app.pushUndo();
          shape.points.splice(hit.vertex, 1);
          app.commit();
        }
        return;
      }
      app.pushUndo();
      gesture = { kind: 'vertex', shapeId: shape.id, index: hit.vertex };
      return;
    }

    if (hit.edge >= 0 && ev.altKey) {
      // Alt-click an edge to insert a vertex there.
      app.pushUndo();
      shape.points.splice(hit.edge + 1, 0, { x: world.x, y: world.y });
      app.commit();
      gesture = { kind: 'vertex', shapeId: shape.id, index: hit.edge + 1 };
      return;
    }

    app.pushUndo();
    gesture = {
      kind: 'move',
      shapeId: shape.id,
      start: world,
      original: shape.points.map((p) => ({ ...p })),
    };
  }

  function onPointerMove(ev) {
    const cam = toCamera(ev);
    const world = clampWorld(intoWorld(cam));
    pointerWorld = world;
    app.onPointerWorld?.(world);

    if (!gesture) {
      hover = app.tool === 'select' || app.tool === 'corners' || app.tool === 'square'
        ? hitTest(cam)
        : hover;
      if (drafting) drafting.preview = world;
      return;
    }

    switch (gesture.kind) {
      case 'vertex': {
        const shape = app.project.shapes.find((s) => s.id === gesture.shapeId);
        if (!shape) break;
        const target = ev.shiftKey ? snapToNeighbours(shape, gesture.index, world) : world;
        shape.points[gesture.index] = target;
        app.commitLive();
        break;
      }
      case 'move': {
        const shape = app.project.shapes.find((s) => s.id === gesture.shapeId);
        if (!shape) break;
        const dx = world.x - gesture.start.x;
        const dy = world.y - gesture.start.y;
        shape.points = gesture.original.map((p) => ({
          x: clamp(p.x + dx, -0.5, 1.5),
          y: clamp(p.y + dy, -0.5, 1.5),
        }));
        app.commitLive();
        break;
      }
      case 'rect':
        gesture.current = world;
        break;
      case 'corner': {
        const projector = app.selectedProjector();
        if (!projector?.calibration?.worldQuad) break;
        projector.calibration.worldQuad[gesture.index] = world;
        app.onCornersChanged?.(projector);
        app.commitLive();
        break;
      }
      case 'square': {
        const quad = app.rectifyDraft?.quad;
        if (!quad) break;
        quad[gesture.index] = { x: clamp(cam.x, -0.4, 1.4), y: clamp(cam.y, -0.4, 1.4) };
        app.onRectifyDraftChanged?.();
        break;
      }
      default:
        break;
    }
  }

  function onPointerUp(ev) {
    if (gesture?.kind === 'square') {
      gesture = null;
      if (canvas.hasPointerCapture?.(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
      return;
    }
    if (gesture?.kind === 'rect') {
      const a = gesture.origin;
      const b = gesture.current;
      if (Math.abs(a.x - b.x) > 0.004 && Math.abs(a.y - b.y) > 0.004) {
        app.pushUndo();
        const shape = createShape(
          [
            { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
            { x: Math.max(a.x, b.x), y: Math.min(a.y, b.y) },
            { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) },
            { x: Math.min(a.x, b.x), y: Math.max(a.y, b.y) },
          ],
          { name: `Area ${app.project.shapes.length + 1}` }
        );
        app.project.shapes.push(shape);
        app.select({ type: 'shape', id: shape.id });
        app.commit();
        app.nameNewShape?.(shape.id);
      }
    } else if (gesture) {
      app.commit();
    }
    gesture = null;
    if (canvas.hasPointerCapture?.(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
  }

  function onDoubleClick() {
    if (drafting) finishDraft();
  }

  function clampWorld(p) {
    // A little slack outside the frame is useful — a roofline often runs off
    // the edge of what the camera can see.
    return { x: clamp(p.x, -0.5, 1.5), y: clamp(p.y, -0.5, 1.5) };
  }

  /** Shift-drag constrains a vertex to line up with one of its neighbours. */
  function snapToNeighbours(shape, index, world) {
    const n = shape.points.length;
    const prev = shape.points[(index - 1 + n) % n];
    const next = shape.points[(index + 1) % n];
    const candidates = [prev, next].filter(Boolean);
    let best = { ...world };
    let bestDist = Infinity;
    for (const c of candidates) {
      const dx = Math.abs(world.x - c.x);
      const dy = Math.abs(world.y - c.y);
      if (dx < dy && dx < bestDist) {
        best = { x: c.x, y: world.y };
        bestDist = dx;
      } else if (dy <= dx && dy < bestDist) {
        best = { x: world.x, y: c.y };
        bestDist = dy;
      }
    }
    return best;
  }

  /* ---------------------------------------------------------------- *
   * Drafting new shapes
   * ---------------------------------------------------------------- */

  function addDraftPoint(world, shiftKey) {
    if (!drafting) {
      drafting = { points: [world], closed: app.tool === 'polygon', preview: world };
      return;
    }

    const last = drafting.points[drafting.points.length - 1];
    const point = shiftKey
      ? Math.abs(world.x - last.x) > Math.abs(world.y - last.y)
        ? { x: world.x, y: last.y }
        : { x: last.x, y: world.y }
      : world;

    // Clicking the first point again closes the shape. Measured on the canvas,
    // like every other tolerance here — the points are in world coordinates, and
    // comparing those against a screen-pixel radius would make the first point
    // uncatchable at the far end of a squared-up wall.
    if (drafting.points.length > 2) {
      const here = ontoCamera(point);
      const start = ontoCamera(drafting.points[0]);
      if (Math.hypot(here.x - start.x, here.y - start.y) < hitTolerance(HIT_RADIUS)) {
        finishDraft();
        return;
      }
    }

    drafting.points.push(point);
  }

  function finishDraft() {
    if (!drafting) return;
    const closed = drafting.closed;
    const minPoints = closed ? 3 : 2;
    if (drafting.points.length >= minPoints) {
      app.pushUndo();
      const shape = createShape(drafting.points, {
        type: closed ? 'polygon' : 'path',
        closed,
        name: closed
          ? `Area ${app.project.shapes.filter((s) => s.closed).length + 1}`
          : `Path ${app.project.shapes.filter((s) => !s.closed).length + 1}`,
      });
      app.project.shapes.push(shape);
      app.select({ type: 'shape', id: shape.id });
      app.commit();
      app.nameNewShape?.(shape.id);
    }
    drafting = null;
  }

  function cancelDraft() {
    drafting = null;
  }

  function undoDraftPoint() {
    if (!drafting) return false;
    drafting.points.pop();
    if (!drafting.points.length) drafting = null;
    return true;
  }

  /* ---------------------------------------------------------------- *
   * Rendering
   * ---------------------------------------------------------------- */

  function draw({ previewCanvas, cameraElement, stillImage, cameraOpacity, showEffects }) {
    const w = canvas.width;
    const h = canvas.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, h);

    // Backdrop: the live camera, or the captured still if the camera is off.
    const backdrop = cameraElement || stillImage;
    if (backdrop && cameraOpacity > 0) {
      g.globalAlpha = cameraOpacity;
      try {
        g.drawImage(backdrop, 0, 0, w, h);
      } catch {
        /* the video may not be ready on the first frames */
      }
      g.globalAlpha = 1;
    }

    if (showEffects && previewCanvas) {
      g.globalCompositeOperation = 'lighter';
      g.drawImage(previewCanvas, 0, 0, w, h);
      g.globalCompositeOperation = 'source-over';
    }

    drawProjectorOutlines(w, h);
    drawShapes(w, h);
    drawDraft(w, h);
    drawRectGesture(w, h);
    drawCorners(w, h);
    drawSquaring(w, h);
  }

  function drawProjectorOutlines(w, h) {
    if (!app.project.settings?.showSafeArea) return;
    g.save();
    g.lineWidth = Math.max(1, dpr);
    g.setLineDash([8 * dpr, 6 * dpr]);
    g.font = labelFont(12 * dpr);
    g.textBaseline = 'top';

    app.project.projectors.forEach((projector, index) => {
      const outline = projectorOutline(worldToProjector(app.project, projector), 6);
      if (!outline) return;
      const colour = PROJECTOR_COLOURS[index % PROJECTOR_COLOURS.length];
      const selected = app.selection.type === 'projector' && app.selection.id === projector.id;

      g.strokeStyle = colour;
      g.globalAlpha = selected ? 1 : 0.5;
      g.lineWidth = (selected ? 2.5 : 1.4) * dpr;
      const seen = camPoints(outline);
      g.beginPath();
      seen.forEach((p, i) => {
        const c = { x: p.x * w, y: p.y * h };
        if (i === 0) g.moveTo(c.x, c.y);
        else g.lineTo(c.x, c.y);
      });
      g.closePath();
      g.stroke();

      const bb = boundingBox(seen);
      g.setLineDash([]);
      g.fillStyle = colour;
      g.globalAlpha = selected ? 1 : 0.75;
      g.fillText(projector.name, bb.x * w + 6 * dpr, bb.y * h + 6 * dpr);
      g.setLineDash([8 * dpr, 6 * dpr]);
    });
    g.restore();
  }

  function drawShapes(w, h) {
    const showNames = app.showShapeNames;
    g.save();
    g.lineJoin = 'round';
    g.font = labelFont(11 * dpr);
    g.textBaseline = 'bottom';

    for (const shape of app.project.shapes) {
      if (shape.visible === false) continue;
      const selected = app.selection.type === 'shape' && app.selection.id === shape.id;
      // Highlighted from the panels: hovering a layer lights up everything it
      // draws into, so "which one is Area 3" is answered by pointing at it
      // rather than by reading names off a list.
      const linked = app.highlightedShapes?.includes(shape.id);
      const hovered = hover.shapeId === shape.id || linked;
      const points = camPoints(shape.points).map((p) => ({ x: p.x * w, y: p.y * h }));
      if (!points.length) continue;

      g.beginPath();
      g.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) g.lineTo(points[i].x, points[i].y);
      if (shape.closed) g.closePath();

      if (shape.closed) {
        g.fillStyle = selected
          ? 'rgba(255,122,24,0.16)'
          : linked ? 'rgba(76,194,255,0.20)'
          : hovered ? 'rgba(255,255,255,0.07)'
          : 'rgba(255,255,255,0.03)';
        g.fill();
      }
      g.strokeStyle = selected ? '#ff7a18'
          : linked ? '#4cc2ff'
          : shape.locked ? '#6b7488'
          : hovered ? '#ffffff' : '#8fa0bd';
      g.lineWidth = (selected || linked ? 2 : 1.2) * dpr;
      g.setLineDash(shape.closed ? [] : [6 * dpr, 4 * dpr]);
      g.stroke();
      g.setLineDash([]);

      if (selected) {
        for (let i = 0; i < points.length; i++) {
          const isHover = hover.shapeId === shape.id && hover.vertex === i;
          g.beginPath();
          g.arc(points[i].x, points[i].y, HANDLE_RADIUS * dpr * (isHover ? 1.5 : 1), 0, Math.PI * 2);
          g.fillStyle = isHover ? '#ffffff' : '#ff7a18';
          g.fill();
          g.strokeStyle = '#000';
          g.lineWidth = 1 * dpr;
          g.stroke();
        }
      }

      if (showNames) {
        const bb = boundingBox(points);
        g.fillStyle = selected ? '#ff7a18' : 'rgba(231,234,242,0.75)';
        g.fillText(shape.name, bb.x, bb.y - 3 * dpr);
      }
    }
    g.restore();
  }

  function drawDraft(w, h) {
    if (!drafting) return;
    const points = camPoints(drafting.points).map((p) => ({ x: p.x * w, y: p.y * h }));
    const previewCam = drafting.preview ? ontoCamera(drafting.preview) : null;
    const preview = previewCam ? { x: previewCam.x * w, y: previewCam.y * h } : null;

    g.save();
    g.strokeStyle = '#4cc2ff';
    g.lineWidth = 1.8 * dpr;
    g.setLineDash([5 * dpr, 4 * dpr]);
    g.beginPath();
    g.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) g.lineTo(points[i].x, points[i].y);
    if (preview) g.lineTo(preview.x, preview.y);
    if (drafting.closed && points.length > 1) g.lineTo(points[0].x, points[0].y);
    g.stroke();
    g.setLineDash([]);

    for (const point of points) {
      g.beginPath();
      g.arc(point.x, point.y, HANDLE_RADIUS * dpr, 0, Math.PI * 2);
      g.fillStyle = '#4cc2ff';
      g.fill();
    }
    g.restore();
  }

  function drawRectGesture(w, h) {
    if (gesture?.kind !== 'rect') return;
    const a = gesture.origin;
    const b = gesture.current;
    // Drawn as a quad rather than a rect: it is a rectangle in world space, and
    // once the wall is squared up that is not a rectangle on the camera picture.
    const corners = camPoints([
      { x: a.x, y: a.y },
      { x: b.x, y: a.y },
      { x: b.x, y: b.y },
      { x: a.x, y: b.y },
    ]);
    g.save();
    g.strokeStyle = '#4cc2ff';
    g.setLineDash([5 * dpr, 4 * dpr]);
    g.lineWidth = 1.8 * dpr;
    g.beginPath();
    corners.forEach((p, i) => {
      if (i === 0) g.moveTo(p.x * w, p.y * h);
      else g.lineTo(p.x * w, p.y * h);
    });
    g.closePath();
    g.stroke();
    g.restore();
  }

  function drawCorners(w, h) {
    if (app.tool !== 'corners') return;
    const projector = app.selectedProjector();
    const quad = projector?.calibration?.worldQuad;
    if (!quad) return;

    const seen = camPoints(quad);
    g.save();
    g.strokeStyle = '#ffd60a';
    g.lineWidth = 2 * dpr;
    g.beginPath();
    seen.forEach((p, i) => {
      const c = { x: p.x * w, y: p.y * h };
      if (i === 0) g.moveTo(c.x, c.y);
      else g.lineTo(c.x, c.y);
    });
    g.closePath();
    g.stroke();

    const labels = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
    g.font = labelFont(11 * dpr);
    g.textBaseline = 'middle';
    seen.forEach((p, i) => {
      const c = { x: p.x * w, y: p.y * h };
      g.beginPath();
      g.arc(c.x, c.y, (hover.corner === i ? 9 : 7) * dpr, 0, Math.PI * 2);
      g.fillStyle = hover.corner === i ? '#ffffff' : '#ffd60a';
      g.fill();
      g.strokeStyle = '#000';
      g.lineWidth = 1.5 * dpr;
      g.stroke();
      g.fillStyle = '#ffd60a';
      g.fillText(labels[i], c.x + 12 * dpr, c.y);
    });
    g.restore();
  }

  /**
   * The squaring quad, and a grid ruled inside it.
   *
   * The grid is the part that does the work. Four handles on four corners tell
   * you nothing about whether you have found a rectangle — a quadrilateral looks
   * plausible from almost anywhere — but a grid ruled across it in perspective
   * lands its lines on the brick courses when the marking is right and visibly
   * skews off them when it is not. It is the same reason a spirit level has a
   * bubble rather than a number.
   */
  let gridCache = { key: '', H: null };

  function squaringGrid(quad) {
    const key = quad.map((p) => `${p.x.toFixed(5)},${p.y.toFixed(5)}`).join(';');
    if (gridCache.key !== key) {
      gridCache = {
        key,
        H: solveHomography(
          [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
          quad.map((p) => ({ x: p.x, y: p.y }))
        ),
      };
    }
    return gridCache.H;
  }

  function drawSquaring(w, h) {
    if (app.tool !== 'square') return;
    const quad = app.rectifyDraft?.quad;
    if (!quad || quad.length !== 4) return;
    const aspect = app.rectifyDraft.aspect > 0.02 ? app.rectifyDraft.aspect : 1;

    const H = squaringGrid(quad);
    const at = (u, v) => {
      const p = H ? applyH(H, u, v) : null;
      return p ? { x: p.x * w, y: p.y * h } : null;
    };

    g.save();

    // Cells as close to square as whole numbers allow, so a skew shows up as a
    // cell that is visibly a different shape from its neighbours.
    const rows = 4;
    const cols = Math.max(2, Math.min(14, Math.round(rows * aspect)));
    g.strokeStyle = 'rgba(76,194,255,0.45)';
    g.lineWidth = 1 * dpr;
    const rule = (from, to, steps) => {
      g.beginPath();
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const p = at(from.u + (to.u - from.u) * t, from.v + (to.v - from.v) * t);
        if (!p) return;
        if (i === 0) g.moveTo(p.x, p.y);
        else g.lineTo(p.x, p.y);
      }
      g.stroke();
    };
    for (let c = 1; c < cols; c++) rule({ u: c / cols, v: 0 }, { u: c / cols, v: 1 }, 1);
    for (let r = 1; r < rows; r++) rule({ u: 0, v: r / rows }, { u: 1, v: r / rows }, 1);

    g.strokeStyle = '#4cc2ff';
    g.lineWidth = 2.2 * dpr;
    g.beginPath();
    quad.forEach((p, i) => {
      if (i === 0) g.moveTo(p.x * w, p.y * h);
      else g.lineTo(p.x * w, p.y * h);
    });
    g.closePath();
    g.stroke();

    const labels = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
    g.font = labelFont(11 * dpr);
    g.textBaseline = 'middle';
    quad.forEach((p, i) => {
      const c = { x: p.x * w, y: p.y * h };
      g.beginPath();
      g.arc(c.x, c.y, (hover.corner === i ? 10 : 8) * dpr, 0, Math.PI * 2);
      g.fillStyle = hover.corner === i ? '#ffffff' : '#4cc2ff';
      g.fill();
      g.strokeStyle = '#000';
      g.lineWidth = 1.5 * dpr;
      g.stroke();
      g.fillStyle = '#4cc2ff';
      g.fillText(labels[i], c.x + 13 * dpr, c.y);
    });
    g.restore();
  }

  /* ---------------------------------------------------------------- *
   * Wiring
   * ---------------------------------------------------------------- */

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('dblclick', onDoubleClick);
  canvas.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    if (drafting) finishDraft();
  });
  canvas.addEventListener('pointerleave', () => {
    pointerWorld = null;
    if (drafting) drafting.preview = null;
  });

  return {
    resize,
    draw,
    finishDraft,
    cancelDraft,
    undoDraftPoint,
    get drafting() {
      return drafting;
    },
    get pointerWorld() {
      return pointerWorld;
    },
    get size() {
      return { cssWidth, cssHeight, dpr };
    },
  };
}

/** Default corner quad for manual alignment: a centred rectangle to drag out. */
export function defaultWorldQuad() {
  return [
    { x: 0.2, y: 0.2 },
    { x: 0.8, y: 0.2 },
    { x: 0.8, y: 0.8 },
    { x: 0.2, y: 0.8 },
  ];
}

export { PROJECTOR_COLOURS };
