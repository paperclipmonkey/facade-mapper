/**
 * Does everybody end up with the same drawing?
 *
 * Somebody in the garden draws on a tablet and the ink appears on the house.
 * What actually travels is a stream of small messages — a stroke beginning,
 * some points, a stroke ending — and every tab in the show runs them through
 * the same store and has to arrive at the same picture. Where two projectors
 * overlap on one wall, a tab that got a different answer paints a different
 * drawing onto the same brickwork.
 *
 * The case that is easy to get wrong is the tab that arrived late. It missed
 * every message that made the picture, so it is sent the whole thing in one
 * go — and "the whole thing" has to be indistinguishable from having watched
 * it being drawn.
 *
 *   node test/drawing.test.mjs
 */

import {
  applyDrawMessage,
  drawingFor,
  snapshotOf,
  resetDrawings,
  surfaceIds,
  strokeAge,
  DRAW_SCALE,
  PRESSURE_SCALE,
} from '../js/core/drawing.js';
import { setClockOffset, resetClockOffset } from '../js/core/time.js';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

/** What a drawing actually is, for comparing two of them. */
const shapeOf = (id) =>
  JSON.stringify(
    (drawingFor(id)?.strokes || []).map((s) => [s.id, s.color, s.width, s.erase, s.done, s.pts])
  );

/** A hand drawing one stroke, in the batches a frame at a time would produce. */
function drawStroke(surface, id, { color = '#ffffff', width = 4, erase = false, points = 30, batch = 7 } = {}) {
  applyDrawMessage({ surface, kind: 'begin', id, color, width, erase, at: 1000 });
  let pending = [];
  for (let i = 0; i < points; i++) {
    pending.push(
      Math.round((i / points) * DRAW_SCALE),
      Math.round(Math.sin(i / 4) * 1000 + DRAW_SCALE / 2),
      Math.round((0.3 + (0.6 * i) / points) * PRESSURE_SCALE)
    );
    if (pending.length / 3 >= batch) {
      applyDrawMessage({ surface, kind: 'points', id, pts: pending });
      pending = [];
    }
  }
  if (pending.length) applyDrawMessage({ surface, kind: 'points', id, pts: pending });
  applyDrawMessage({ surface, kind: 'end', id });
}

/* ------------------------------------------------------------------ *
 * One stroke
 * ------------------------------------------------------------------ */

console.log('\n— A stroke —');

resetDrawings();
drawStroke('wall', 'a', { points: 30, batch: 7 });

{
  const surface = drawingFor('wall');
  ok('a stroke arrives in one piece', surface.strokes.length === 1 && surface.strokes[0].pts.length === 90);
  ok('and is counted', surface.points === 30, `${surface.points}`);
  ok('and knows it finished', surface.strokes[0].done === true);
  ok('the surface was created on demand', surfaceIds().includes('wall'));
}

{
  // The batch boundary is the thing to get wrong: 30 points delivered 7 at a
  // time is five messages, and the last one is short.
  resetDrawings();
  drawStroke('wall', 'a', { points: 30, batch: 7 });
  const oneGo = shapeOf('wall');
  resetDrawings();
  drawStroke('wall', 'a', { points: 30, batch: 30 });
  ok('how the points were batched makes no difference', shapeOf('wall') === oneGo);
}

{
  resetDrawings();
  applyDrawMessage({ surface: 'wall', kind: 'begin', id: 'a', color: '#fff', width: 3 });
  // A truncated message: the last point never finished arriving. Keeping the
  // stray pair would put the renderer half a point off for the rest of the
  // stroke, which is a smear rather than an error.
  applyDrawMessage({ surface: 'wall', kind: 'points', id: 'a', pts: [1, 2, 3, 4, 5, 6, 7, 8] });
  ok('a partial point at the end of a message is dropped', drawingFor('wall').strokes[0].pts.length === 6);

  ok(
    'points for a stroke that never began are ignored',
    applyDrawMessage({ surface: 'wall', kind: 'points', id: 'nope', pts: [1, 2, 3] }) === false
  );
  ok('so is a message with no kind', applyDrawMessage({ surface: 'wall' }) === false);
  ok('and one that is not a message at all', applyDrawMessage(null) === false);
}

/* ------------------------------------------------------------------ *
 * Taking it back
 * ------------------------------------------------------------------ */

console.log('\n— Undo and clear —');

resetDrawings();
drawStroke('wall', 'a');
drawStroke('wall', 'b');
drawStroke('wall', 'c');

{
  const before = drawingFor('wall').generation;
  applyDrawMessage({ surface: 'wall', kind: 'undo' });
  const surface = drawingFor('wall');
  ok('undo takes the last stroke', surface.strokes.map((s) => s.id).join(',') === 'a,b');
  ok('and its points with it', surface.points === 60, `${surface.points}`);
  /**
   * The generation is what tells an accumulating renderer to start again.
   * Adding ink can be done on top of what is already in its buffer; taking ink
   * away cannot, and a renderer that misses this leaves the undone stroke on
   * the wall for the rest of the evening.
   */
  ok('and says the drawing lost something', surface.generation > before);
}

{
  const before = drawingFor('wall').generation;
  applyDrawMessage({ surface: 'wall', kind: 'clear' });
  const surface = drawingFor('wall');
  ok('clear empties the surface', surface.strokes.length === 0 && surface.points === 0);
  ok('and also says so', surface.generation > before);
  ok('clearing an empty surface changes nothing', applyDrawMessage({ surface: 'wall', kind: 'clear' }) === false);
  ok('nor does undoing one', applyDrawMessage({ surface: 'wall', kind: 'undo' }) === false);
}

/* ------------------------------------------------------------------ *
 * Arriving late
 * ------------------------------------------------------------------ */

console.log('\n— A tab that arrived late —');

{
  resetDrawings();
  drawStroke('wall', 'a', { color: '#ff7a18', width: 6 });
  drawStroke('wall', 'b', { color: '#4cc2ff', width: 2, points: 12 });
  drawStroke('wall', 'c', { erase: true, points: 5 });
  applyDrawMessage({ surface: 'wall', kind: 'undo' });
  const watched = shapeOf('wall');
  const snapshot = snapshotOf('wall');

  // A projector tab opened at nine o'clock: nothing but the snapshot.
  resetDrawings();
  applyDrawMessage(snapshot);
  ok('the snapshot is indistinguishable from having watched it', shapeOf('wall') === watched);
  ok('including how much is on it', drawingFor('wall').points === 42, `${drawingFor('wall').points}`);

  // And it survives the wire, which is the only way it ever actually travels.
  resetDrawings();
  applyDrawMessage(JSON.parse(JSON.stringify(snapshot)));
  ok('and survives the round trip through JSON', shapeOf('wall') === watched);

  const surface = drawingFor('wall');
  ok('adopting one counts as losing what was there', surface.generation > 0);
}

{
  resetDrawings();
  applyDrawMessage({ kind: 'full', surface: 'wall', strokes: [{ id: 'x', pts: [1, 2, 3] }] });
  const stroke = drawingFor('wall').strokes[0];
  ok('a snapshot missing its optional fields still loads', stroke.color === '#ffffff' && stroke.width === 1);
  ok('an empty snapshot is a way of saying "nothing here"', applyDrawMessage({ kind: 'full', surface: 'empty' }) === true);
  ok('and leaves an empty surface', drawingFor('empty').strokes.length === 0);
}

/* ------------------------------------------------------------------ *
 * Not for ever
 * ------------------------------------------------------------------ */

console.log('\n— Bounded —');

{
  /**
   * An evening of this in every tab, unbounded, would end as a projector tab
   * that has run out of memory at half past ten. Oldest first, which is also
   * what somebody drawing would expect if they noticed at all.
   */
  resetDrawings();
  for (let i = 0; i < 520; i++) drawStroke('wall', `s${i}`, { points: 2, batch: 2 });
  const surface = drawingFor('wall');
  ok('a very long evening is capped', surface.strokes.length <= 500, `${surface.strokes.length} strokes`);
  ok('the newest strokes are the ones kept', surface.strokes[surface.strokes.length - 1].id === 's519');
  ok('the oldest are gone', !surface.strokes.some((s) => s.id === 's0'));
  ok('and the point count still matches the strokes', surface.points === surface.strokes.reduce((n, s) => n + s.pts.length / 3, 0));
  ok('dropping them counts as losing something', surface.generation > 0);
}

/* ------------------------------------------------------------------ *
 * Two surfaces
 * ------------------------------------------------------------------ */

console.log('\n— Separate surfaces —');

{
  resetDrawings();
  drawStroke('window', 'a');
  drawStroke('door', 'b');
  applyDrawMessage({ surface: 'window', kind: 'clear' });
  ok('clearing one leaves the other alone', drawingFor('door').strokes.length === 1);
  ok('and surfaces are only made when used', surfaceIds().sort().join(',') === 'door,window');
  ok('an unknown surface reads as nothing, not as a new one', drawingFor('roof') === null && !surfaceIds().includes('roof'));
}

/* ------------------------------------------------------------------ *
 * Age
 * ------------------------------------------------------------------ */

console.log('\n— Fading —');

{
  const realNow = Date.now;
  let fake = 5_000_000;
  Date.now = () => fake;
  try {
    resetClockOffset();
    resetDrawings();
    applyDrawMessage({ surface: 'wall', kind: 'begin', id: 'a', color: '#fff', width: 3 });
    const stroke = drawingFor('wall').strokes[0];
    ok('a stroke is stamped as it arrives', stroke.at === fake, `${stroke.at}`);

    fake += 4000;
    ok('and ages in seconds', Math.abs(strokeAge(stroke) - 4) < 0.001, `${strokeAge(stroke)}`);

    /**
     * The stamp is on the shared clock, so a stroke drawn on a tablet whose own
     * clock is two seconds out does not arrive on the wall already half faded.
     */
    setClockOffset(2000, { step: true });
    ok('the age is measured on the link clock', Math.abs(strokeAge(stroke) - 6) < 0.001, `${strokeAge(stroke)}`);
  } finally {
    Date.now = realNow;
    resetClockOffset();
    resetDrawings();
  }
}

console.log(`\n${failures ? `${failures} failed` : 'All passed'}`);
process.exit(failures ? 1 : 0);
