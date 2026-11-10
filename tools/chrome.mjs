/**
 * Headless Chrome over the DevTools protocol, with nothing but Node: launch,
 * evaluate, wait for a condition, press keys, take screenshots, collect page
 * errors. Shared by the browser test and anything else that needs a real page.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CHROME =
  process.env.CHROME ??
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => existsSync(p));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ width = 1280, height = 800 } = {}) {
  const profile = await mkdtemp(join(tmpdir(), 'blockcraft-chrome-'));
  const flags = [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', `--window-size=${width},${height}`,
    // WebGL without a GPU, the same on every machine.
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required',
  ];
  if (process.platform === 'linux') flags.push('--no-sandbox');
  const chrome = spawn(CHROME, [...flags, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    chrome.stderr.on('data', (d) => {
      buf += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) resolve(m[1]);
    });
    chrome.on('exit', () => reject(new Error(`Chrome exited:\n${buf}`)));
  });
  const port = new URL(wsUrl).port;
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const waiting = new Map();
  const errors = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      errors.push(msg.params.entry.text);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      waiting.set(n, (msg) => (msg.error ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(`${expression}\n${r.exceptionDetails.exception?.description ?? 'evaluation failed'}`);
    return r.result.value;
  };
  async function until(expression, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try {
        if (await evaluate(expression)) return true;
      } catch (error) {
        if (!/Inspected target navigated|Cannot find context|Execution context was destroyed/.test(error.message)) throw error;
      }
      await sleep(100);
    }
    return false;
  }
  const KEYS = { KeyW: 87, KeyE: 69, KeyF: 70, Space: 32, Escape: 27, Digit3: 51 };
  const key = async (code, type) => {
    const key = code.startsWith('Key') ? code.slice(3).toLowerCase() : code.startsWith('Digit') ? code.slice(5) : code === 'Space' ? ' ' : code;
    await send('Input.dispatchKeyEvent', { type, code, key, windowsVirtualKeyCode: KEYS[code] ?? 0 });
  };
  const press = async (code) => {
    await key(code, 'keyDown');
    await sleep(30);
    await key(code, 'keyUp');
  };
  const hold = async (code, ms) => {
    await key(code, 'keyDown');
    await sleep(ms);
    await key(code, 'keyUp');
  };
  const screenshot = async (file) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(file, Buffer.from(data, 'base64'));
  };
  const navigate = async (url) => {
    await send('Page.navigate', { url });
  };
  const close = async () => {
    ws.close();
    chrome.kill();
    await new Promise((r) => (chrome.exitCode !== null ? r() : chrome.once('exit', r)));
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };
  return { send, evaluate, until, press, hold, screenshot, navigate, close, errors };
}
