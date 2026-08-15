/**
 * Video and image playback mapped into shapes.
 *
 * Playback position comes from show time, not from the video element's own
 * clock, so the same clip on two projectors stays frame-aligned and scrubbing
 * the transport scrubs the footage (see core/media.js).
 *
 * For stock effect footage shot on black, set Blend to "screen" or "lighter" —
 * black becomes transparent and you get a free luma key without touching pixels.
 */

import { clamp, rgba, frac } from '../../core/math.js';

/** Source rect and destination rect for a given fit mode. */
function fitRects(mediaW, mediaH, bbox, mode, scale, offsetX, offsetY) {
  const dest = {
    x: bbox.x + offsetX * bbox.w,
    y: bbox.y + offsetY * bbox.h,
    w: bbox.w,
    h: bbox.h,
  };

  if (!mediaW || !mediaH || mode === 'stretch') {
    return { src: { x: 0, y: 0, w: mediaW || 1, h: mediaH || 1 }, dest };
  }

  const mediaAspect = mediaW / mediaH;
  const boxAspect = bbox.w / bbox.h;

  if (mode === 'cover') {
    // Crop the source so the destination fills completely.
    let sw = mediaW;
    let sh = mediaH;
    if (mediaAspect > boxAspect) sw = mediaH * boxAspect;
    else sh = mediaW / boxAspect;
    sw /= scale;
    sh /= scale;
    sw = Math.min(sw, mediaW);
    sh = Math.min(sh, mediaH);
    return {
      src: { x: (mediaW - sw) / 2, y: (mediaH - sh) / 2, w: sw, h: sh },
      dest,
    };
  }

  // contain: letterbox inside the shape.
  let dw = bbox.w * scale;
  let dh = bbox.h * scale;
  if (mediaAspect > boxAspect) dh = dw / mediaAspect;
  else dw = dh * mediaAspect;
  return {
    src: { x: 0, y: 0, w: mediaW, h: mediaH },
    dest: {
      x: bbox.cx - dw / 2 + offsetX * bbox.w,
      y: bbox.cy - dh / 2 + offsetY * bbox.h,
      w: dw,
      h: dh,
    },
  };
}

const mediaEffect = {
  id: 'media',
  name: 'Video / Image',
  category: 'media',
  scope: 'shape',
  description:
    'Maps a video or image from the media library into the shape. Use Blend "screen" for footage shot on black.',
  params: [
    { key: 'source', type: 'media', label: 'Media', default: '' },
    { key: 'fit', type: 'select', label: 'Fit', default: 'cover', options: ['cover', 'contain', 'stretch', 'tile'] },
    { key: 'blend', type: 'select', label: 'Blend', default: 'source-over', options: ['source-over', 'screen', 'lighter', 'multiply', 'overlay', 'difference'] },
    { key: 'scale', type: 'range', label: 'Scale', default: 1, min: 0.1, max: 4, step: 0.01 },
    { key: 'offsetX', type: 'range', label: 'Offset X', default: 0, min: -1, max: 1, step: 0.005 },
    { key: 'offsetY', type: 'range', label: 'Offset Y', default: 0, min: -1, max: 1, step: 0.005 },
    { key: 'rotate', type: 'range', label: 'Rotate', default: 0, min: -180, max: 180, step: 1 },
    { key: 'mirror', type: 'bool', label: 'Mirror', default: false },
    { key: 'tint', type: 'color', label: 'Tint', default: '#ffffff' },
    { key: 'tintAmount', type: 'range', label: 'Tint amount', default: 0, min: 0, max: 1, step: 0.01 },
    { key: 'brightness', type: 'range', label: 'Brightness', default: 1, min: 0, max: 2, step: 0.01 },
    { key: 'tileScale', type: 'range', label: 'Tile size', default: 0.4, min: 0.05, max: 2, step: 0.01 },
    { key: 'scrollX', type: 'range', label: 'Tile scroll X', default: 0, min: -1, max: 1, step: 0.005 },
    { key: 'scrollY', type: 'range', label: 'Tile scroll Y', default: 0, min: -1, max: 1, step: 0.005 },
  ],
  draw({ g, p, shape, media, t }) {
    if (!p.source) return;
    const el = media(p.source);
    if (!el) return;

    const mediaW = el.videoWidth || el.naturalWidth || 0;
    const mediaH = el.videoHeight || el.naturalHeight || 0;
    if (!mediaW || !mediaH) return;

    const { bbox } = shape;
    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = p.blend;
    g.globalAlpha *= clamp(p.brightness, 0, 2);

    if (p.rotate || p.mirror) {
      g.translate(bbox.cx, bbox.cy);
      if (p.rotate) g.rotate((p.rotate * Math.PI) / 180);
      if (p.mirror) g.scale(-1, 1);
      g.translate(-bbox.cx, -bbox.cy);
    }

    if (p.fit === 'tile') {
      const tw = bbox.w * p.tileScale * p.scale;
      const th = (tw * mediaH) / mediaW;
      // Offsetting by a fraction of a tile scrolls the pattern seamlessly.
      const ox = -frac(t * p.scrollX) * tw + p.offsetX * bbox.w;
      const oy = -frac(t * p.scrollY) * th + p.offsetY * bbox.h;
      const cols = Math.ceil(bbox.w / tw) + 2;
      const rows = Math.ceil(bbox.h / th) + 2;
      if (cols * rows <= 4000) {
        for (let r = -1; r < rows; r++) {
          for (let c = -1; c < cols; c++) {
            g.drawImage(el, bbox.x + ox + c * tw, bbox.y + oy + r * th, tw, th);
          }
        }
      }
    } else {
      const { src, dest } = fitRects(mediaW, mediaH, bbox, p.fit, p.scale, p.offsetX, p.offsetY);
      g.drawImage(el, src.x, src.y, src.w, src.h, dest.x, dest.y, dest.w, dest.h);
    }

    if (p.tintAmount > 0) {
      g.globalCompositeOperation = 'multiply';
      g.globalAlpha = clamp(p.tintAmount, 0, 1);
      g.fillStyle = p.tint;
      g.fill(shape.path);
    }
    g.restore();
  },
};

const cameraFeed = {
  id: 'camera-feed',
  name: 'Live Camera',
  category: 'media',
  scope: 'shape',
  description:
    'Projects a camera feed back onto the house. Point a second webcam at the front path for a ghostly mirror of whoever is standing on it.',
  params: [
    /**
     * Which camera, and by default not the one doing the alignment.
     *
     * The alignment camera is a measuring instrument on a tripod pointed at the
     * wall you are projecting onto — feed that back into the projection and you
     * have built a feedback loop. Leave this on "alignment camera" and you get
     * the old behaviour, which is occasionally what you want; pick a second
     * device and this layer opens it on its own.
     */
    { key: 'device', type: 'camera', label: 'Camera', default: '' },
    { key: 'fit', type: 'select', label: 'Fit', default: 'cover', options: ['cover', 'contain', 'stretch'] },
    { key: 'blend', type: 'select', label: 'Blend', default: 'source-over', options: ['source-over', 'screen', 'lighter', 'difference'] },
    { key: 'mirror', type: 'bool', label: 'Mirror', default: true },
    { key: 'brightness', type: 'range', label: 'Brightness', default: 1, min: 0, max: 2, step: 0.01 },
    { key: 'tint', type: 'color', label: 'Tint', default: '#66ff99' },
    { key: 'tintAmount', type: 'range', label: 'Tint amount', default: 0.35, min: 0, max: 1, step: 0.01 },
  ],
  draw({ g, p, shape, camera }) {
    // Only the control tab holds a camera stream; projector tabs get null and
    // simply draw nothing rather than erroring. Same for a device that is still
    // opening, or one that has been unplugged.
    const el = camera?.(p.device || null);
    if (!el) return;
    const mediaW = el.videoWidth || 0;
    const mediaH = el.videoHeight || 0;
    if (!mediaW || !mediaH) return;

    const { bbox } = shape;
    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = p.blend;
    g.globalAlpha *= clamp(p.brightness, 0, 2);
    if (p.mirror) {
      g.translate(bbox.cx, bbox.cy);
      g.scale(-1, 1);
      g.translate(-bbox.cx, -bbox.cy);
    }
    const { src, dest } = fitRects(mediaW, mediaH, bbox, p.fit, 1, 0, 0);
    g.drawImage(el, src.x, src.y, src.w, src.h, dest.x, dest.y, dest.w, dest.h);

    if (p.tintAmount > 0) {
      g.globalCompositeOperation = 'multiply';
      g.globalAlpha = clamp(p.tintAmount, 0, 1);
      g.fillStyle = p.tint;
      g.fill(shape.path);
    }
    g.restore();
  },
};

const gradientMap = {
  id: 'colour-cycle',
  name: 'Colour Cycle',
  category: 'media',
  scope: 'shape',
  description: 'Cycles the shape through a hue ramp. Cheap, bright, and reads from the street.',
  params: [
    { key: 'speed', type: 'range', label: 'Speed', default: 0.1, min: -2, max: 2, step: 0.005 },
    { key: 'saturation', type: 'range', label: 'Saturation', default: 100, min: 0, max: 100, step: 1 },
    { key: 'lightness', type: 'range', label: 'Lightness', default: 50, min: 0, max: 100, step: 1 },
    { key: 'spread', type: 'range', label: 'Spread across shapes', default: 0.2, min: 0, max: 1, step: 0.01 },
    { key: 'bandsAcross', type: 'range', label: 'Bands across shape', default: 0, min: 0, max: 12, step: 1 },
    { key: 'angle', type: 'range', label: 'Band angle', default: 90, min: 0, max: 360, step: 1 },
  ],
  draw({ g, p, shape, t, i, n }) {
    const baseHue = (t * p.speed * 360 + (i / Math.max(1, n)) * 360 * p.spread) % 360;
    const { bbox } = shape;

    g.save();
    if (p.bandsAcross > 0) {
      const a = (p.angle * Math.PI) / 180;
      const len = Math.hypot(bbox.w, bbox.h) * 0.5;
      const grad = g.createLinearGradient(
        bbox.cx - Math.cos(a) * len,
        bbox.cy - Math.sin(a) * len,
        bbox.cx + Math.cos(a) * len,
        bbox.cy + Math.sin(a) * len
      );
      const steps = Math.min(24, Math.round(p.bandsAcross) * 3);
      for (let s = 0; s <= steps; s++) {
        const f = s / steps;
        const hue = (baseHue + f * 360 * (p.bandsAcross / 3)) % 360;
        grad.addColorStop(f, `hsl(${hue} ${p.saturation}% ${p.lightness}%)`);
      }
      g.fillStyle = grad;
    } else {
      g.fillStyle = `hsl(${baseHue} ${p.saturation}% ${p.lightness}%)`;
    }
    g.fill(shape.path);
    g.restore();
  },
};

const solidPreview = {
  id: 'test-grid',
  name: 'Alignment Grid',
  category: 'media',
  scope: 'shape',
  description:
    'A labelled grid inside the shape. Handy for checking a mesh warp is landing where you think.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#00ff88' },
    { key: 'divisions', type: 'range', label: 'Divisions', default: 8, min: 2, max: 40, step: 1 },
    { key: 'width', type: 'range', label: 'Line width', default: 2, min: 0.5, max: 12, step: 0.25 },
    { key: 'diagonals', type: 'bool', label: 'Diagonals', default: true },
    { key: 'border', type: 'bool', label: 'Border', default: true },
  ],
  draw({ g, p, shape }) {
    const { bbox } = shape;
    const n = Math.round(p.divisions);
    g.save();
    g.clip(shape.path);
    g.strokeStyle = p.color;
    g.lineWidth = p.width;
    g.beginPath();
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      g.moveTo(bbox.x + f * bbox.w, bbox.y);
      g.lineTo(bbox.x + f * bbox.w, bbox.y + bbox.h);
      g.moveTo(bbox.x, bbox.y + f * bbox.h);
      g.lineTo(bbox.x + bbox.w, bbox.y + f * bbox.h);
    }
    if (p.diagonals) {
      g.moveTo(bbox.x, bbox.y);
      g.lineTo(bbox.x + bbox.w, bbox.y + bbox.h);
      g.moveTo(bbox.x + bbox.w, bbox.y);
      g.lineTo(bbox.x, bbox.y + bbox.h);
    }
    g.stroke();
    g.restore();

    if (p.border) {
      g.save();
      g.strokeStyle = rgba(p.color, 1);
      g.lineWidth = p.width * 2.5;
      g.stroke(shape.path);
      g.restore();
    }
  },
};

export default [mediaEffect, cameraFeed, gradientMap, solidPreview];
