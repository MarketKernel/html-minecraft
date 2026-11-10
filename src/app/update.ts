/**
 * Updates of the installed game (the PWA of build/pages/). Its service worker
 * (src/pwa/sw.js) installs a new deploy beside the running one and waits; this
 * finds such a worker, asks it its version, and tells it to take over when the
 * player presses Update.
 *
 * The same code runs in the single file, where it does nothing: only the PWA's
 * page carries <meta name="service-worker">, put in by build.mjs.
 */

const script = document.querySelector<HTMLMetaElement>('meta[name="service-worker"]')?.content;
const updatesHere = !!script && 'serviceWorker' in navigator;

let registration: ServiceWorkerRegistration | null = null;
let applying = false;
let ready = false;
// The browser looks when the game is launched; a window left open for days hears of nothing new after that.
let lastCheck = Date.now();
const QUIET_CHECK_EVERY = 6 * 60 * 60 * 1000;
/** The version the game ran last time. */
const LAST_VERSION = 'blockcraft.version';

/**
 * Registers the worker after the page has loaded; onReady hears of a new
 * version waiting, with its number (null if the worker does not say).
 */
export function startUpdates(onReady: (version: string | null) => void): void {
  if (!updatesHere || !script) return;
  const found = async (worker: ServiceWorker): Promise<void> => {
    if (ready || !(await installed(worker))) return;
    ready = true;
    onReady(await versionOf(worker));
  };
  const start = async (): Promise<void> => {
    try {
      registration = await navigator.serviceWorker.register(script);
    } catch {
      return;
    }
    // A worker that finished installing in an earlier session is waiting already; the
    // browser's own check at launch may have started one before the page loaded.
    const early = registration.waiting ?? registration.installing;
    if (early && registration.active) void found(early);
    registration.addEventListener('updatefound', () => {
      const worker = registration?.installing;
      // The very first install is no update: there is no active worker yet.
      if (worker && registration?.active) void found(worker);
    });
  };
  if (document.readyState === 'complete') void start();
  else addEventListener('load', () => void start(), { once: true });
  // Another window of the game may let the new worker in: this one stays the old page, so the
  // update still shows as ready, and pressing it just reloads.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (applying) location.reload();
  });
  document.addEventListener('visibilitychange', quietCheck);
  addEventListener('online', quietCheck);
  window.setInterval(quietCheck, 60 * 60 * 1000);
}

/** Asks the server again now and then; updatefound tells of a new version. */
function quietCheck(): void {
  if (!registration || ready || !navigator.onLine) return;
  if (Date.now() - lastCheck < QUIET_CHECK_EVERY) return;
  lastCheck = Date.now();
  // A failure is tried again on the next tick or when the connection is back.
  registration.update().catch(() => (lastCheck = 0));
}

/** True once, on the first start of a version other than the one that ran before. */
export function justUpdated(): boolean {
  if (!updatesHere) return false;
  try {
    const before = localStorage.getItem(LAST_VERSION);
    localStorage.setItem(LAST_VERSION, __APP_VERSION__);
    return before !== null && before !== __APP_VERSION__;
  } catch {
    return false;
  }
}

/** Lets the waiting worker in and reloads the page. The caller saves the world first. */
export function applyUpdate(): void {
  const waiting = registration?.waiting;
  if (!waiting) {
    location.reload();
    return;
  }
  applying = true;
  waiting.postMessage('activate');
  // controllerchange reloads; should it not come, the reload still does, and the worker is let in once the window is closed.
  window.setTimeout(() => location.reload(), 5000);
}

/** Resolves when the worker has installed: true, or failed to: false. */
function installed(worker: ServiceWorker): Promise<boolean> {
  return new Promise((resolve) => {
    const settle = (): boolean => {
      if (worker.state === 'installing') return false;
      resolve(worker.state !== 'redundant');
      return true;
    };
    if (settle()) return;
    worker.addEventListener('statechange', function wait() {
      if (settle()) worker.removeEventListener('statechange', wait);
    });
  });
}

/** The waiting worker's version; null if it does not answer in time. */
function versionOf(worker: ServiceWorker): Promise<string | null> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = window.setTimeout(() => resolve(null), 2000);
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timer);
      resolve(typeof event.data === 'string' ? event.data : null);
    };
    worker.postMessage('version', [channel.port2]);
  });
}
