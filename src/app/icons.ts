/**
 * Block icons for the hotbar and the inventory: three faces of the cube drawn
 * in isometric view on a canvas, from the same tiles the world uses.
 */
import { BLOCKS, SHAPE_CROSS } from '../core/blocks';
import { TILE } from '../core/textures';

const SIZE = 48;

export function blockIcons(tiles: Uint8Array): string[] {
  const tileCanvas = (layer: number) => {
    const c = document.createElement('canvas');
    c.width = c.height = TILE;
    const image = new ImageData(new Uint8ClampedArray(tiles.buffer, tiles.byteOffset + layer * TILE * TILE * 4, TILE * TILE * 4).slice(), TILE, TILE);
    c.getContext('2d')!.putImageData(image, 0, 0);
    return c;
  };
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  return BLOCKS.map((block) => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.imageSmoothingEnabled = false;
    if (block.id === 0) return '';
    const [, , top, , front, side] = block.faces as [number, number, number, number, number, number];
    if (block.shape === SHAPE_CROSS) {
      ctx.drawImage(tileCanvas(top), 4, 4, 40, 40);
      return canvas.toDataURL();
    }
    const k = 20 / TILE;
    // Each face: the tile mapped onto a parallelogram, then darkened a little.
    const face = (layer: number, a: number, b: number, c: number, d: number, e: number, f: number, shade: number) => {
      ctx.setTransform(a, b, c, d, e, f);
      ctx.drawImage(tileCanvas(layer), 0, 0);
      if (shade) {
        ctx.fillStyle = `rgba(0,0,0,${shade})`;
        ctx.fillRect(0, 0, TILE, TILE);
      }
    };
    face(top, k, -k / 2, k, k / 2, 4, 13, 0);
    face(front, k, k / 2, 0, 24 / TILE, 4, 13, 0.25);
    face(side, k, -k / 2, 0, 24 / TILE, 24, 23, 0.42);
    return canvas.toDataURL();
  });
}
