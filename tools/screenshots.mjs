/**
 * The pictures in the README, made from the app rather than for it.
 *
 * Every still in the documentation is one frame of the real demo house with a
 * real preset applied, rendered through the real world renderer and the real
 * bloom and grade — see tools/shot.html for how, and why it composites the way
 * it does. Nothing here is illustrative: if an effect breaks, the picture of it
 * breaks, which is the entire point of generating them rather than taking them.
 *
 * This is the one thing in the repository that needs anything installed, and it
 * is not part of the app: Playwright, for a headless Chromium with WebGL.
 *
 *   npx playwright install chromium      # once
 *   node tools/screenshots.mjs           # writes docs/assets/demos/*.jpg
 *   node tools/screenshots.mjs birthday  # just one
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs', 'assets', 'demos');

/**
 * What to photograph, and when.
 *
 * `t` is seconds into the show, and it is chosen per preset rather than shared,
 * because the thing each one is *about* arrives at a different moment: balloons
 * need time to climb the wall, a guy on a bonfire needs time to start burning,
 * and a meteor shower at four seconds is an empty sky. `clock` freezes the
 * browser's idea of the wall clock, for the two layers that read it.
 */
const SHOTS = [
  { preset: 'halloween', t: 14 },
  { preset: 'christmas', t: 16 },
  { preset: 'birthday', t: 11 },
  { preset: 'perseids', t: 9 },
  { preset: 'new-year', t: 10, clock: '2026-12-31T23:59:52' },
  { preset: 'bonfire-night', t: 22 },
  { preset: 'cyberpunk', t: 13 },
];

const W = 1600;
const H = 900;

async function main() {
  const only = process.argv.slice(2);
  const shots = only.length ? SHOTS.filter((s) => only.includes(s.preset)) : SHOTS;
  if (!shots.length) {
    console.error(`No such demo. Known: ${SHOTS.map((s) => s.preset).join(', ')}`);
    process.exit(1);
  }

  const { chromium } = await import('playwright').catch(() => {
    console.error('Playwright is not installed. `npm i -D playwright && npx playwright install chromium`');
    process.exit(1);
  });

  await mkdir(outDir, { recursive: true });
  const server = await serve();

  // SwiftShader rather than a real GPU: headless Chromium has no display, and
  // without this the bloom pass silently does nothing and every still comes out
  // flat. Slow, and it does not matter — this renders seven frames of seven
  // shows.
  //
  // Inside the try, so that the documented failure — Chromium not installed —
  // does not leave the helper server running after the process gives up.
  let browser = null;
  try {
    browser = await chromium.launch({
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });

    for (const shot of shots) {
      const page = await browser.newPage({ viewport: { width: W, height: H } });
      page.on('console', (msg) => {
        if (msg.type() === 'error') console.error(`  [page] ${msg.text()}`);
      });
      page.on('pageerror', (err) => console.error(`  [page] ${err.message}`));

      if (shot.clock) await page.clock.setFixedTime(new Date(shot.clock));

      const url = `${server.origin}/tools/shot.html?preset=${shot.preset}&t=${shot.t}&w=${W}&h=${H}`;
      // 'commit' rather than 'load': the module script runs the whole
      // simulation synchronously before the load event, and on a software
      // renderer that is a minute or two.
      await page.goto(url, { waitUntil: 'commit' });
      await page.waitForFunction(() => window.__shot, null, { timeout: 180000 });
      const result = await page.evaluate(() => window.__shot);

      const file = path.join(outDir, `${shot.preset}.jpg`);
      await writeFile(file, Buffer.from(result.jpeg.split(',')[1], 'base64'));
      console.log(`${shot.preset}: ${result.layers} layers, t=${result.seconds}s -> ${path.relative(root, file)}`);
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
