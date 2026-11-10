/**
 * Plays the built page in headless Chrome: the title screen, walking, breaking
 * and placing, TNT, flying, the inventory, saving and loading after a reload.
 * WebGL runs on SwiftShader, so it works without a GPU.
 *
 * Needs `npm run build` first and a local Chrome (or CHROME=/path/to/chrome).
 * `--shots DIR` also saves screenshots into DIR.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checker, root } from '../tools/load.mjs';
import { CHROME, launch, sleep } from '../tools/chrome.mjs';

if (!CHROME) {
  console.log('No Chrome found — set CHROME=/path/to/chrome. Skipping the browser test.');
  process.exit(0);
}
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? process.argv[shotsAt + 1] : null;
if (SHOTS) await mkdir(SHOTS, { recursive: true });
const { check, done } = checker();
const page = await launch();
const { evaluate, until, press, hold, errors } = page;
const shot = async (name) => SHOTS && page.screenshot(join(SHOTS, `${name}.png`));
const state = () => evaluate('blockcraft.state');
const B = { AIR: 0, STONE: 3, GLOWSTONE: 18, TNT: 19 };

try {
  await page.navigate(pathToFileURL(join(root, 'build', 'blockcraft.html')).href);
  check('the page has the game', await until('typeof blockcraft === "object"'), true);
  check('the title screen shows', await evaluate(`!document.getElementById('menu').hidden`), true);
  check('the spawn area loads', await until('blockcraft.state.ready', 60000), true);
  check('chunks are drawn', (await state()).drawn.chunks > 20, true);
  check('the hotbar has nine blocks', await evaluate(`document.querySelectorAll('#hotbar .slot').length`), 9);
  await sleep(1500);
  await shot('1-title');

  // A fixed world from here on, so the checks below are repeatable.
  await evaluate('blockcraft.newWorld(20261014)');
  await evaluate('blockcraft.play()');
  check('play hides the title', await evaluate(`document.getElementById('menu').hidden`), true);
  check('a known seed loads', await until('blockcraft.state.ready', 60000), true);
  let s = await state();
  check('the player stands on the ground', await until('blockcraft.state.onGround', 5000), true);
  await evaluate('blockcraft.look(0.6, -0.25); blockcraft.setTime(0.12)');
  await sleep(1200);
  await shot('2-day');

  // Walking.
  s = await state();
  await hold('KeyW', 700);
  const moved = await state();
  check('W walks', Math.hypot(moved.x - s.x, moved.z - s.z) > 1, true);

  // Breaking the block underfoot, standing in the middle of it.
  s = await state();
  await evaluate(`blockcraft.teleport(${Math.floor(s.x) + 0.5}, ${s.y}, ${Math.floor(s.z) + 0.5})`);
  await evaluate('blockcraft.look(0, -1.5)');
  await sleep(100);
  s = await state();
  check('looking down targets the ground', s.target !== null, true);
  const below = s.target;
  await evaluate('blockcraft.breakTarget()');
  check('left click breaks it', await evaluate(`blockcraft.get(${below.x}, ${below.y}, ${below.z})`), B.AIR);
  check('the player falls into the hole', await until(`blockcraft.state.y < ${s.y - 0.5}`, 3000), true);

  // Placing a block into a wall in front.
  await evaluate('blockcraft.fly(true)');
  await evaluate(`blockcraft.teleport(${Math.floor(s.x) + 0.5}, blockcraft.top(${Math.floor(s.x)}, ${Math.floor(s.z)}) + 3, ${Math.floor(s.z) + 0.5})`);
  await evaluate('blockcraft.look(0, -0.9)');
  await sleep(200);
  await press('Digit3');
  check('3 selects the third slot', (await state()).slot, 2);
  s = await state();
  if (s.target) {
    const before = (await state()).edits;
    await evaluate('blockcraft.useTarget()');
    check('right click places a block', (await state()).edits, before + 1);
  } else check('something to place against', s.target, 'a block');

  // TNT: lit, flashing, then a crater.
  await evaluate('blockcraft.fly(true)');
  s = await state();
  const tx = Math.floor(s.x) + 6;
  const tz = Math.floor(s.z);
  const ty = await evaluate(`blockcraft.top(${tx}, ${tz})`);
  await evaluate(`blockcraft.set(${tx}, ${ty + 1}, ${tz}, ${B.TNT})`);
  // Within reach: 3 blocks back, 4 up, looking down at it.
  await evaluate(`blockcraft.teleport(${tx + 0.5}, ${ty + 4}, ${tz + 3.5}); blockcraft.look(0, -0.94)`);
  await sleep(300);
  s = await state();
  check('the TNT is targeted', s.target && s.target.id, B.TNT);
  await evaluate('blockcraft.useTarget()');
  check('right click lights it', (await state()).primed, 1);
  await evaluate(`blockcraft.teleport(${tx + 0.5}, ${ty + 9}, ${tz + 12.5}); blockcraft.look(0, -0.55)`);
  await sleep(1500);
  await shot('3-tnt-lit');
  check('it explodes', await until('blockcraft.state.primed === 0', 6000), true);
  check('it leaves a crater', await evaluate(`blockcraft.get(${tx}, ${ty}, ${tz})`), B.AIR);
  await sleep(120);
  await shot('4-explosion');

  // Night, with a glowstone lighting the ground.
  await evaluate(`blockcraft.set(${tx + 3}, blockcraft.top(${tx + 3}, ${tz}) + 1, ${tz}, ${B.GLOWSTONE})`);
  await evaluate('blockcraft.setTime(0.78)');
  await sleep(1500);
  await shot('5-night');

  // Flying high, looking at the horizon.
  await evaluate(`blockcraft.teleport(${tx}, 110, ${tz}); blockcraft.look(2.2, -0.3); blockcraft.setTime(0.485)`);
  await sleep(4000);
  await shot('6-sunset');

  // The inventory.
  await press('KeyE');
  check('E opens the inventory', await until(`!document.getElementById('inventory').hidden`, 2000), true);
  check('it lists the blocks', (await evaluate(`document.querySelectorAll('#grid .item').length`)) >= 30, true);
  await evaluate(`document.querySelectorAll('#grid .item')[5].click()`);
  await shot('7-inventory');
  await press('KeyE');
  check('E closes it', await until(`document.getElementById('inventory').hidden`, 2000), true);

  // Saving and loading.
  s = await state();
  await evaluate('blockcraft.save()');
  await page.navigate(pathToFileURL(join(root, 'build', 'blockcraft.html')).href);
  check('the page comes back', await until('typeof blockcraft === "object" && blockcraft.state.ready', 60000), true);
  const after = await state();
  check('the same world', after.seed, 20261014);
  check('the player where they were', Math.hypot(after.x - s.x, after.z - s.z) < 0.01, true);
  check('the crater is still there', await evaluate(`blockcraft.get(${tx}, ${ty}, ${tz})`), B.AIR);
  check('the title offers to continue', await evaluate(`document.getElementById('play').textContent`), 'Continue');
  check('no errors on the page', errors, []);
} finally {
  await page.close();
}
done('app');
