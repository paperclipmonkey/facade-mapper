/**
 * Every effect in the library, one frame each, for docs/gallery.md.
 *
 * The README has a picture of each starter look; nothing had a picture of each
 * *effect*, and eighty-odd names in a document is the dropdown problem the
 * Browse… dialog was built to solve. So: every built-in effect, on the demo
 * house, through the real renderer and the real bloom and grade, added onto
 * the facade in linear light — tools/review.html, the same path as the
 * README stills — and tiled into one contact sheet per category.
 *
 * Each effect is shown the way the library itself uses it. If a starter
 * preset has a layer of it, the tile is that layer: the same targets, the same
 * parameters, the same grade. Otherwise it gets its defaults, pointed at the
 * kind of shape it is for (`TARGETS` below), at a moment worth seeing
 * (`MOMENTS`). Effects that need something a still cannot have — a camera, a
 * video, a depth scan, a pencil — are left out rather than shown as black.
 *
 *   node tools/gallery.mjs              # every category
 *   node tools/gallery.mjs christmas    # just one
 *
 * Needs what tools/screenshots.mjs needs: Playwright and its Chromium.
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs', 'assets', 'effects');

const { PRESETS, DEMO_BURSTS } = await import('../js/control/presets.js');
const { listByCategory } = await import('../js/effects/registry.js');

/** Where an effect no preset uses is pointed, by what it is for. */
const TARGETS = {
  outline: ['window'], strobe: ['window'], static: ['window'], mask: ['window'],
  sweep: ['window'], ripple: ['window'], 'colour-cycle': ['window'], chase: ['window', 'door'],
  comet: ['roof', 'trim'], trace: ['window', 'door'], sparks: ['roof'],
  bounce: ['wall'], serpent: ['wall'], vine: ['wall'], ditsy: ['wall'], paisley: ['wall'],
  'scan-lines': ['wall'], bees: ['wall'], 'test-grid': ['wall'],
  shatter: ['window'], fire: ['window'], candle: ['window'], eyes: ['window'],
  silhouette: ['window'], ghost: ['window'], web: ['window'], pumpkin: ['window'],
  smoke: ['door'], portal: ['door'], 'confetti-cannon': ['door'], rocket: ['roof'],
  glyph: ['primary'],
};

/**
 * How far into its show each tile is taken, in seconds.
 *
 * One-shots are caught mid-burst; anything that grows or settles is given time
 * to; anything on a timer is caught while it is happening. Everything else
 * gets eight seconds, which is enough for nearly anything to have got going.
 */
const MOMENTS = {
  'bat-burst': 1.2, shockwave: 0.7, 'spark-burst': 0.8, rocket: 3.1, 'confetti-cannon': 1.6,
  vine: 40, frost: 20, snow: 20, bonfire: 22, 'catherine-wheel': 4, icicles: 12, trace: 3,
  shatter: 6, santa: 4, bats: 6, web: 10, flowers: 12, kelp: 10, shoal: 12, dolphins: 9,
  jellyfish: 12, bees: 10, cake: 6, balloons: 11, brickwork: 6, breach: 14, lightning: 0,
};

/** Parameters a still needs that a show does not: a timer brought round, and so on. */
const PARAMS = {
  santa: { interval: 30, crossing: 9 },
  shatter: { interval: 6 },
};

/** Needs a camera, a video, a depth scan or a pencil: nothing to photograph. */
const SKIP = new Set(['media', 'camera-feed', 'live-draw', 'relight']);

const W = 960;
const H = 540;

/** The first preset layer, or demo one-shot, that uses each effect. */
function presetLayers() {
  const found = new Map();
  for (const preset of PRESETS) {
    for (const layer of preset.build()) {
      if (found.has(layer.effect)) continue;
      found.set(layer.effect, {
        tags: layer.targetTags, params: layer.params, opacity: layer.opacity,
        blend: layer.blend, softness: layer.softness, stagger: layer.stagger,
        bindings: layer.bindings, grade: preset.grade,
      });
    }
  }
  for (const burst of DEMO_BURSTS) {
    if (!found.has(burst.effect)) found.set(burst.effect, { tags: burst.tags, params: burst.params, grade: 'haunted' });
  }
  return found;
}

function jobFor(effect, used) {
  const pre = used.get(effect.id);
  const layers = [];
  // Breach takes its bricks from the wall it is breaking, so it needs one.
  if (effect.id === 'breach') {
    const brick = used.get('brickwork');
    layers.push({ effect: 'brickwork', tags: brick.tags, params: brick.params });
  }
  layers.push({
    effect: effect.id,
    tags: pre ? pre.tags : (TARGETS[effect.id] || []),
    params: { ...(pre?.params || {}), ...(PARAMS[effect.id] || {}) },
    opacity: pre?.opacity ?? 1,
    blend: pre?.blend,
    softness: pre?.softness,
    stagger: pre?.stagger,
    bindings: pre?.bindings,
  });
  return {
    name: effect.id,
    label: effect.name,
    layers,
    grade: pre?.grade || 'neutral',
    t: MOMENTS[effect.id] ?? 8,
    w: W,
    h: H,
    fps: 12,
    format: 'jpeg',
  };
}

/**
 * Lightning is only worth a picture during a strike, so its moment is found
 * rather than chosen: the first return stroke the effect itself announces, a
 * hundredth of a second in, while it is at its brightest.
 */
async function lightningMoment(params) {
  const { getEffect } = await import('../js/effects/registry.js');
  const effect = getEffect('lightning');
  const cues = effect?.cues?.(params, 2, 120) || [];
  return cues.length ? cues[0].at + 0.012 : 8;
}

async function main() {
  const only = process.argv.slice(2);
  const used = presetLayers();
  const categories = [...listByCategory()]
    .map(([category, effects]) => [category, effects.filter((e) => !SKIP.has(e.id))])
    .filter(([category, effects]) => effects.length && (!only.length || only.includes(category)));
  if (!categories.length) {
    console.error(`No such category. Known: ${[...listByCategory()].map(([c]) => c).join(', ')}`);
    process.exit(1);
  }

  const { chromium } = await import('playwright').catch(() => {
    console.error('Playwright is not installed. `npm i -D playwright && npx playwright install chromium`');
    process.exit(1);
  });

  await mkdir(outDir, { recursive: true });
  const server = await serve();
  let browser = null;
  try {
    // SwiftShader for the bloom; the 2D canvases on the CPU, which is several
    // times faster for the same picture — see tools/screenshots.mjs.
    browser = await chromium.launch({
      args: [
        '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
        '--disable-accelerated-2d-canvas',
      ],
    });
    const pages = await Promise.all(Array.from({ length: 4 }, async () => {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      page.on('pageerror', (err) => console.error(`  [page] ${err.message}`));
      page.on('console', (msg) => {
        if (msg.type() === 'error') console.error(`  [console] ${msg.text()}`);
      });
      await page.goto(`${server.origin}/tools/review.html`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__ready, null, { timeout: 60000 });
      return page;
    }));

    for (const [category, effects] of categories) {
      const jobs = [];
      for (const effect of effects) {
        const job = jobFor(effect, used);
        if (effect.id === 'lightning') job.t = await lightningMoment(job.layers.at(-1).params);
        jobs.push(job);
      }
      // Four pages at once; each job is independent.
      const results = new Array(jobs.length);
      let next = 0;
      await Promise.all(pages.map(async (page) => {
        while (next < jobs.length) {
          const i = next++;
          results[i] = (await page.evaluate((job) => window.renderJob(job), jobs[i])).data;
        }
      }));
      const sheet = await pages[0].evaluate((args) => window.composeSheet(args), {
        images: results,
        labels: jobs.map((j) => j.label),
        cols: 3,
        cellW: 560,
      });
      const file = path.join(outDir, `${category}.jpg`);
      await writeFile(file, Buffer.from(sheet.split(',')[1], 'base64'));
      console.log(`${category}: ${jobs.length} effects -> ${path.relative(root, file)}`);
    }
  } finally {
    await browser?.close();
    server.stop();
  }
}

/** The app's own server, on a free port, quiet. */
function serve() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.mjs', '--port', '0'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let settled = false;
    child.stdout.on('data', (chunk) => {
      const match = /http:\/\/(?:localhost|127\.0\.0\.1):(\d+)/.exec(String(chunk));
      if (match && !settled) {
        settled = true;
        resolve({ origin: `http://127.0.0.1:${match[1]}`, stop: () => child.kill() });
      }
    });
    child.on('exit', (code) => {
      if (!settled) reject(new Error(`server exited with ${code}`));
    });
    setTimeout(() => {
      if (!settled) {
        child.kill();
        reject(new Error('server did not report a port'));
      }
    }, 10000);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
