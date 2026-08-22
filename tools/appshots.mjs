/**
 * The picture of the *app*, made from the app.
 *
 * `tools/screenshots.mjs` photographs the show — one frame of each demo through
 * the real renderer. This photographs the thing you drive it with: the control
 * tab, and the traced facade inside it. Same principle and the same reason.
 * Both of these had drifted badly enough to be worth a note: they showed a
 * gabled cartoon house with five flat windows, which the demo has not been
 * since it became a hipped-roof 1930s semi with a bay and a side store, and a
 * preset bar with two buttons on it when there are eight. A hand-taken
 * screenshot is out of date the day after it is taken and nothing ever says so.
 *
 *   npx playwright install chromium      # once
 *   node tools/appshots.mjs              # writes docs/assets/screenshot.png
 *
 * One thing is hidden before the shutter: the frame-rate readout. It is a
 * per-machine diagnostic and this machine is a headless software renderer, so
 * it reads about 5 fps where a real one reads 60. Leaving it in would be
 * accurate about the capture and a lie about the app.
 */

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'docs', 'assets');

/**
 * Which demo to open, and how long to let it run.
 *
 * Halloween because it is the signature look and because it exercises the most
 * of the layer list. The wait is show time rather than taste: Brickwork has to
 * lay itself, Creeping Vine has to get round a window, and the candles have to
 * come up, or the editor shot is of a house with nothing on it.
 */
const PRESET = 'halloween';
const SETTLE_MS = 11000;

const SHOTS = {
  /** The whole control tab, as the README's "what it looks like to use". */
  app: {
    file: path.join(assets, 'screenshot.png'),
    viewport: { width: 1280, height: 764 },
    names: true,
    /**
     * A layer is selected before the shutter, because the inspector is a third
     * of the window and "Nothing selected" wastes all of it. Flowers is the
     * one to pick: a long parameter list, so the panel is visibly a panel, and
     * it is pointed at `#planter`, which is the tag most worth noticing.
     */
    select: 'Flowers',
    element: null,
  },
};

async function main() {
  const only = process.argv.slice(2);
  const wanted = only.length ? only : Object.keys(SHOTS);
  const unknown = wanted.filter((k) => !SHOTS[k]);
  if (unknown.length) {
    console.error(`No such shot: ${unknown.join(', ')}. Known: ${Object.keys(SHOTS).join(', ')}`);
    process.exit(1);
  }

  const { chromium } = await import('playwright').catch(() => {
    console.error('Playwright is not installed. `npm i -D playwright && npx playwright install chromium`');
    process.exit(1);
  });

  const server = await serve();
  let browser = null;
  try {
    // SwiftShader, for the same reason as tools/screenshots.mjs: headless
    // Chromium has no display, and without it the bloom pass silently does
    // nothing and the stage comes out flat.
    browser = await chromium.launch({
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });

    for (const key of wanted) {
      const shot = SHOTS[key];
      const page = await browser.newPage({ viewport: shot.viewport, deviceScaleFactor: 2 });
      page.on('pageerror', (err) => console.error(`  [page] ${err.message}`));
      page.on('console', (msg) => {
        if (msg.type() === 'error') console.error(`  [console] ${msg.text()}`);
      });

      await page.goto(`${server.origin}/?demo=${PRESET}`, { waitUntil: 'domcontentloaded' });

      // The demo is in once the layer list has filled and the empty-stage
      // notice has gone. Waiting on the network or the load event is not
      // enough: the demo builds itself after both.
      await page.waitForFunction(
        () => document.querySelectorAll('#layerList > *').length > 3
          && document.getElementById('stageEmpty')?.hidden === true,
        null,
        { timeout: 180000 }
      );

      // The checkbox lives on a panel that is not the one we want in shot, so
      // it is toggled by dispatching the change the app already listens for
      // rather than by clicking it — same code path, no detour through the UI.
      if (!shot.names) {
        await page.evaluate(() => {
          const box = document.getElementById('showShapeNames');
          if (box?.checked) {
            box.checked = false;
            box.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
      }
      await page.evaluate(() => {
        const fps = document.getElementById('stageFps');
        if (fps) fps.style.visibility = 'hidden';
      });

      if (shot.select) {
        await page.evaluate((name) => {
          const row = [...document.querySelectorAll('#layerList > *')]
            .find((el) => el.textContent.includes(name));
          row?.click();
        }, shot.select);
      }

      await page.waitForTimeout(SETTLE_MS);

      const target = shot.element ? await page.$(shot.element) : page;
      const options = shot.jpeg
        ? { type: 'jpeg', quality: Math.round(shot.jpeg * 100) }
        : { type: 'png' };
      const buffer = await target.screenshot(options);
      await writeFile(shot.file, buffer);
      console.log(`${key}: ${Math.round(buffer.length / 1024)} kB -> ${path.relative(root, shot.file)}`);
      await page.close();
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
