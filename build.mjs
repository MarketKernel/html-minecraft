/**
 * Bundles src/ into ONE self-contained build/blockcraft.html: styles, the
 * compiled TypeScript and the icon are all inlined, so the result opens from a
 * file:// URL with no network access and no sibling files.
 *
 * Beside it goes build/pages/: the same page as an installable PWA for GitHub
 * Pages — a manifest, icons and a service worker that keeps it offline.
 *
 * The version is package.json's and nowhere else; a build of anything but the
 * commit tagged v<version> carries the commit too (0.1.0+1a2b3c4).
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { watch as watchDir } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const at = (...parts) => join(root, ...parts);
const watching = process.argv.includes('--watch');
const outFile = at('build', 'blockcraft.html');

/** x.y.z from package.json, and the label the page shows: x.y.z or x.y.z+commit. */
async function readRelease() {
  const { version } = JSON.parse(await readFile(at('package.json'), 'utf8'));
  const git = (...args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  };
  const tagged = git('tag', '--points-at', 'HEAD').split('\n').includes(`v${version}`);
  const commit = tagged ? '' : git('rev-parse', '--short', 'HEAD');
  return { version, label: commit ? `${version}+${commit}` : version };
}

/** `</script` inside a string literal would close the inline tag early. */
const guard = (code) => code.replace(/<\/(script|style)/gi, '<\\/$1');

/**
 * `<!--` followed by `<script` before any `-->` puts the HTML parser into the
 * "double escaped" state, where `</script>` no longer ends the script.
 */
function assertScriptCloses(code) {
  const open = code.indexOf('<!--');
  if (open >= 0 && /<script/i.test(code.slice(open, code.indexOf('-->', open) >>> 0))) {
    throw new Error('The bundle has `<!--` followed by `<script`: the inline script would not close');
  }
}

/** The whole point of the build: nothing may be fetched at runtime. */
function assertSelfContained(html) {
  const offenders = [
    [/<script[^>]+\ssrc=/i, '<script src=…>'],
    [/<link[^>]+href=["'](?!data:)/i, '<link href=…>'],
    [/@import\s+(url\()?["']?(?!data:)/i, '@import'],
    [/url\(\s*["']?https?:/i, 'url(http…)'],
  ];
  for (const [pattern, name] of offenders) if (pattern.test(html)) throw new Error(`An external reference is left in the file: ${name}`);
  if (!html.includes('http-equiv="Content-Security-Policy"')) throw new Error('The Content-Security-Policy meta tag is missing');
}

/** Under assets/; each goes to build/pages/ under its own name. */
const PWA_ICONS = ['icon.svg', 'pwa/icon-192.png', 'pwa/icon-512.png', 'pwa/icon-maskable-512.png', 'pwa/apple-touch-icon.png'];

/**
 * The page's CSP forbids every fetch; the installed game needs its manifest,
 * its service worker and its icons, all from its own origin. connect-src stays
 * 'none', so the page itself still reaches nothing.
 */
function allowPwa(html) {
  const pattern = /(http-equiv="Content-Security-Policy" content=")([^"]*)/;
  if (!pattern.test(html)) throw new Error('The Content-Security-Policy meta tag is missing');
  return html.replace(pattern, (_, attr, policy) => {
    const directives = new Map(policy.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...sources]) => [name, sources]));
    if (!directives.has('img-src')) throw new Error('The Content-Security-Policy has no img-src');
    directives.get('img-src').push("'self'");
    directives.set('manifest-src', ["'self'"]);
    directives.set('worker-src', ["'self'"]);
    return attr + [...directives].map(([name, sources]) => [name, ...sources].join(' ')).join('; ');
  });
}

/**
 * build/pages/: the page plus what makes it installable. Every path is
 * relative, so it works under a project site's /<repo>/ prefix.
 */
async function buildPages(html, release) {
  const dir = at('build', 'pages');
  const head = [
    '<link rel="manifest" href="manifest.webmanifest">',
    '<link rel="apple-touch-icon" href="apple-touch-icon.png">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
    // The page registers the worker itself (update.ts): this is how it knows it is the PWA.
    '<meta name="service-worker" content="sw.js">',
  ].join('\n');
  const page = allowPwa(html).replace('</head>', () => `${head}\n</head>`);
  // A deploy between two releases changes the page, not the version: the hash tells them apart.
  const cache = `${release.version}-${createHash('sha256').update(page).digest('hex').slice(0, 12)}`;
  const manifest = {
    name: 'Blockcraft',
    short_name: 'Blockcraft',
    description: 'A voxel sandbox that works offline',
    id: './',
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: '#1b2a4a',
    theme_color: '#1b2a4a',
    icons: [
      { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
  const worker = (await readFile(at('src/pwa/sw.js'), 'utf8')).replaceAll('__CACHE__', cache).replaceAll('__VERSION__', release.label);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(join(dir, 'index.html'), page),
    writeFile(join(dir, 'sw.js'), worker),
    writeFile(join(dir, 'manifest.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`),
    // Without it Pages runs the files through Jekyll, which is only wasted time here.
    writeFile(join(dir, '.nojekyll'), ''),
    ...PWA_ICONS.map((path) => copyFile(at('assets', path), join(dir, basename(path)))),
  ]);
  return cache;
}

async function buildOnce() {
  const started = performance.now();
  const release = await readRelease();
  const result = await build({
    entryPoints: [at('src/app/main.ts')],
    bundle: true,
    format: 'iife',
    target: ['es2022'],
    platform: 'browser',
    minify: !watching,
    legalComments: 'none',
    charset: 'utf8',
    define: { __APP_VERSION__: JSON.stringify(release.label) },
    write: false,
  });
  const code = guard(result.outputFiles[0].text);
  assertScriptCloses(code);
  const css = guard(await readFile(at('src/app/styles.css'), 'utf8'));
  const icon = `data:image/svg+xml;base64,${(await readFile(at('assets/icon.svg'))).toString('base64')}`;
  const html = (await readFile(at('src/app/template.html'), 'utf8'))
    .replace('/*__STYLES__*/', () => css)
    .replaceAll('__ICON__', () => icon)
    .replace('/*__APP__*/', () => code);
  assertSelfContained(html);
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, html);
  const cache = await buildPages(html, release);
  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  console.log(`build/blockcraft.html  ${kb} KB  v${release.label}  (${(performance.now() - started).toFixed(0)} ms)`);
  console.log(`build/pages/           PWA for GitHub Pages (cache ${cache})`);
}

await buildOnce();
if (watching) {
  let timer;
  watchDir(at('src'), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => buildOnce().catch((e) => console.error(e.message)), 80);
  });
  console.log('Watching src/ …');
}
