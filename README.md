# Blockcraft

A voxel sandbox in the spirit of Minecraft, in **one HTML file** (~70 KB). It needs no
network, no libraries, no images: the textures are painted by code, the sounds and music
are synthesised, and the world is generated from a seed.

**Play online:** <https://marketkernel.github.io/html-minecraft/> — it can be installed as an
app (the install button in the address bar, or "Add to Home Screen") and then works offline.

**Or download the file:** `blockcraft-vX.Y.Z.html` from
[Releases](https://github.com/MarketKernel/html-minecraft/releases) and open it in Chrome,
Edge, Firefox or Safari — straight from the disk is fine.

## What is in it

- An endless world from a seed: plains, forests, deserts, snowy lands, mountains, beaches
  and oceans; winding caves with lava at the bottom; coal, gold and diamond ore.
- Trees, flowers, tall grass, cacti and glowing jack o'lanterns.
- Smooth lighting: ambient occlusion, sky light that fades into caves, and block light from
  glowstone, lanterns and lava that spreads across chunk borders.
- A day and night cycle with a square sun and moon, stars, drifting blocky clouds and sunsets.
- Waving water you can swim in, swaying leaves and plants.
- TNT with chain reactions, flying debris and a camera shake.
- 32 blocks to build with, including ten colours of wool and glass.
- Walking, sprinting, jumping, flying; a hotbar and an inventory.
- Synthesised sounds for digging, steps, splashes and explosions, and gentle generated music.
- The world saves itself in the browser (only your changes are stored; the seed regrows the rest).

## Controls

| Key | Action |
| --- | --- |
| WASD | walk |
| Space | jump; twice quickly to fly |
| Shift | fly down |
| Ctrl or R | sprint |
| Left click | break |
| Right click | place; on TNT — light it |
| Middle click | pick the block you look at |
| 1–9, wheel | choose a block |
| E | all blocks |
| F | fly on/off |
| T (hold) | make time fly |
| M | music on/off |
| F3 | debug info |
| Esc | pause and settings (render distance, field of view, sound) |

## Build

```sh
npm install
npm run build      # build/blockcraft.html
npm run watch      # rebuild on every change
npm run check      # typecheck, unit tests, build, browser test
npm run shots      # the browser test, saving screenshots to shots/
npm run icons      # repaint assets/pwa/*.png from assets/icon.svg
```

The build makes two things from the same page:

- `build/blockcraft.html` — the single file;
- `build/pages/` — the PWA for GitHub Pages: the page plus a manifest, icons and a service
  worker that keeps it offline. A new deploy installs beside the running version and waits:
  the title screen and the pause menu offer "Update to vX", which saves the world first.

The browser tests (`tests/app.mjs`, `tests/pwa.mjs`) drive the real page in headless Chrome
over the DevTools protocol (no puppeteer); set `CHROME=/path/to/chrome` if it is not in the
usual place.

## Releases

The version lives in `package.json` only. A build of the commit tagged `v<version>` shows it
as is; any other build adds the commit (`0.1.0+1a2b3c4`).

```sh
npm version minor && git push --follow-tags
```

GitHub Actions:

- `test.yml` — every push: typecheck, unit tests, build, browser tests.
- `pages.yml` — every push to `main`: the same checks, then `build/pages/` to GitHub Pages
  (Settings → Pages → Source: GitHub Actions).
- `release.yml` — a `v*` tag: checks that it matches `package.json`, then attaches
  `blockcraft-<tag>.html` and `SHA256SUMS.txt` to the release.

## Layout

- `src/core/` — no DOM, tested in Node with the same code the page runs:
  - `blocks.ts` — every block and the flat lookup tables the hot loops read
  - `noise.ts` — seeded PRNG, hash and Perlin noise
  - `terrain.ts` — the world generator: height, biomes, caves, ore, plants, trees
  - `world.ts` — loaded chunks and the player's edits
  - `mesher.ts` — chunk to vertices: face culling, AO, sky and block light
  - `physics.ts` — the player's box against the blocks
  - `raycast.ts` — what the crosshair points at
  - `textures.ts` — every texture, painted pixel by pixel
  - `math.ts` — matrices and frustum culling
  - `save.ts` — saving and validated loading
- `src/app/` — the page: `template.html` (with its CSP), `styles.css`, `main.ts` (game loop,
  input, screens), `renderer.ts` (WebGL2 and shaders), `audio.ts`, `icons.ts`, `update.ts`
  (PWA updates; does nothing in the single file)
- `src/pwa/sw.js` — the PWA's service worker
- `assets/` — `icon.svg` and the PWA's PNG icons made from it
- `build.mjs` — esbuild bundles everything into the one file and checks nothing external is
  left; then the PWA beside it
- `tests/` — `world`, `mesher`, `physics` in Node; `app.mjs` and `pwa.mjs` in Chrome
- `tools/` — `load.mjs` (compiles src/ for Node), `chrome.mjs` (headless Chrome helper),
  `icons.mjs` (the PWA's icons)

## Security

The page's Content-Security-Policy forbids every network request (`default-src 'none'`,
`connect-src 'none'`). The build fails if any external script, stylesheet or image is left.
The PWA's copy adds only its own origin for the manifest, the icons and the service worker
(`manifest-src`, `img-src`, `worker-src 'self'`); `connect-src` stays `'none'`.

## Limitations

- Keyboard and mouse only for now; no touch controls.
- Chunks are generated and meshed on the main thread, in small slices per frame.
- Water and lava do not flow.

## License

MIT
