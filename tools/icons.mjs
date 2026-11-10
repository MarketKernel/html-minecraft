/**
 * Paints the PWA's PNG icons in assets/pwa/ from assets/icon.svg, in headless
 * Chrome: draw the SVG on a canvas, read the canvas back. Run it by hand after
 * changing the icon (`node tools/icons.mjs`); the PNGs are committed, so the
 * build itself needs no Chrome.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from './load.mjs';
import { CHROME, launch } from './chrome.mjs';

if (!CHROME) {
  console.error('No Chrome found — set CHROME=/path/to/chrome.');
  process.exit(1);
}

// The page's own dark blue, as in its theme-color.
const BACKGROUND = '#1b2a4a';
/**
 * size, how much of it the icon takes, and the background. A maskable icon is
 * cut to a circle or a squircle, so its picture keeps inside the middle 80%;
 * iOS puts black under a transparent apple-touch-icon.
 */
const ICONS = [
  { file: 'icon-192.png', size: 192, scale: 1, background: null },
  { file: 'icon-512.png', size: 512, scale: 1, background: null },
  { file: 'icon-maskable-512.png', size: 512, scale: 0.62, background: BACKGROUND },
  { file: 'apple-touch-icon.png', size: 180, scale: 0.78, background: BACKGROUND },
];

const svg = `data:image/svg+xml;base64,${(await readFile(join(root, 'assets', 'icon.svg'))).toString('base64')}`;
const out = join(root, 'assets', 'pwa');
await mkdir(out, { recursive: true });
const page = await launch({ width: 600, height: 600 });
try {
  for (const { file, size, scale, background } of ICONS) {
    const data = await page.evaluate(`(async () => {
      const img = new Image();
      img.src = ${JSON.stringify(svg)};
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = ${size};
      const g = canvas.getContext('2d');
      if (${JSON.stringify(background)}) {
        g.fillStyle = ${JSON.stringify(background)};
        g.fillRect(0, 0, ${size}, ${size});
      }
      const side = ${size * scale};
      g.drawImage(img, (${size} - side) / 2, (${size} - side) / 2, side, side);
      return canvas.toDataURL('image/png').split(',')[1];
    })()`);
    await writeFile(join(out, file), Buffer.from(data, 'base64'));
    console.log(`assets/pwa/${file}  ${size}×${size}`);
  }
} finally {
  await page.close();
}
