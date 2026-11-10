/**
 * The PWA of build/pages/ in headless Chrome, served the way GitHub Pages
 * serves it, under a /<repo>/ prefix: the service worker takes control, Chrome
 * finds the game installable, it starts with the server gone, and a new deploy
 * waits for Update, which keeps the world.
 *
 * Needs `npm run build` first and a local Chrome (or CHROME=/path/to/chrome).
 */
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { checker, root } from '../tools/load.mjs';
import { CHROME, launch } from '../tools/chrome.mjs';

if (!CHROME) {
  console.log('No Chrome found — set CHROME=/path/to/chrome. Skipping the PWA test.');
  process.exit(0);
}
const PAGES = join(root, 'build', 'pages');
const PREFIX = '/html-minecraft/';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
let down = false;
// Set, the server hands out a service worker of this version: a new deploy, as the page sees it.
let nextVersion = null;
const server = createServer(async (req, res) => {
  if (down) return req.socket.destroy();
  const path = new URL(req.url, 'http://localhost').pathname;
  const name = path === PREFIX ? 'index.html' : path.startsWith(PREFIX) ? path.slice(PREFIX.length) : '';
  try {
    if (!/^[\w.-]+$/.test(name)) throw new Error('not here');
    let body = await readFile(join(PAGES, name));
    if (name === 'sw.js' && nextVersion) body = body.toString().replace(/const VERSION = '[^']*'/, `const VERSION = '${nextVersion}'`);
    res.setHeader('content-type', TYPES[extname(name)] ?? 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}${PREFIX}`;

const { check, done } = checker();
const page = await launch();
const { send, evaluate, until, errors } = page;
const reload = async () => {
  await evaluate('window.__beforeReload = true');
  await send('Page.reload');
  return until('!window.__beforeReload && typeof blockcraft === "object"', 30000);
};
const workerVersion = () =>
  evaluate(`new Promise((resolve) => { const c = new MessageChannel(); c.port1.onmessage = (e) => resolve(e.data); navigator.serviceWorker.controller.postMessage('version', [c.port2]); })`);
const updateButtons = `[...document.querySelectorAll('[data-update]')]`;

try {
  await page.navigate(url);
  check('the game loads', await until('typeof blockcraft === "object"', 30000), true);
  check('the service worker takes control', await until('navigator.serviceWorker.controller !== null'), true);
  check('the manifest parses', (await send('Page.getAppManifest')).errors, []);
  check('Chrome finds it installable', (await send('Page.getInstallabilityErrors')).installabilityErrors, []);
  const running = await evaluate(`document.getElementById('version').textContent.slice(1)`);
  check('the worker knows its version', await workerVersion(), running);
  check('no update offered at first', await evaluate(`${updateButtons}.every((b) => b.hidden)`), true);

  down = true;
  check('it starts with the server gone', await reload(), true);
  check('and generates the world offline', await until('blockcraft.state.ready', 60000), true);
  down = false;

  // A world to keep across the update.
  await evaluate('blockcraft.newWorld(4242)');
  check('a world to keep', await until('blockcraft.state.ready', 60000), true);
  await evaluate('blockcraft.play()');

  // A new deploy: the browser finds it on a reload, installs it beside the running one, and it waits.
  nextVersion = '9.9.9';
  await reload();
  check('a new version is offered', await until(`${updateButtons}.every((b) => !b.hidden && b.textContent === 'Update to v9.9.9')`, 20000), true);
  check('the old worker still serves', await workerVersion(), running);
  await evaluate(`window.__beforeReload = true; document.querySelector('[data-update]').click()`);
  check('Update reloads the page', await until('!window.__beforeReload && typeof blockcraft === "object"', 20000), true);
  check('the new worker serves', await workerVersion(), '9.9.9');
  check('the old cache is gone', (await evaluate('caches.keys()')).length, 1);
  check('the world is kept', await evaluate('blockcraft.state.seed'), 4242);

  // The page is the same bytes, only the worker changed: the version it ran before is set back to see the note.
  await evaluate(`localStorage.setItem('blockcraft.version', '0.0.1')`);
  await reload();
  check('"updated" is said once', await until(`document.getElementById('toast').textContent === ${JSON.stringify(`Updated to v${running}`)}`), true);
  check('and remembered', await evaluate(`localStorage.getItem('blockcraft.version')`), running);
  check('no errors on the page', errors, []);
} finally {
  await page.close();
  server.close();
}
done('pwa');
