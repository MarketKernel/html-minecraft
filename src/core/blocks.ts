/**
 * Every block the world is made of. A block is a byte in a chunk; everything
 * the mesher, the physics and the UI need to know about it sits in flat lookup
 * tables indexed by that byte, so the hot loops never touch an object.
 */

/** Texture layers of the atlas, in order; textures.ts paints each one by name. */
export const TILES = [
  'grass_top', 'grass_side', 'dirt', 'stone', 'cobble', 'sand', 'water', 'log_side', 'log_top', 'leaves',
  'planks', 'glass', 'snow', 'snow_side', 'bedrock', 'coal_ore', 'gold_ore', 'diamond_ore', 'brick', 'glowstone',
  'tnt_top', 'tnt_side', 'tnt_bottom', 'cactus_top', 'cactus_side', 'flower_red', 'flower_yellow', 'tall_grass',
  'pumpkin_top', 'pumpkin_side', 'pumpkin_face', 'lava',
  'wool_white', 'wool_red', 'wool_orange', 'wool_yellow', 'wool_lime', 'wool_cyan', 'wool_blue', 'wool_purple',
  'wool_pink', 'wool_black',
] as const;
export type TileName = (typeof TILES)[number];

export const B = {
  AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, COBBLE: 4, SAND: 5, WATER: 6, LOG: 7, LEAVES: 8, PLANKS: 9, GLASS: 10,
  SNOW_GRASS: 11, SNOW: 12, BEDROCK: 13, COAL_ORE: 14, GOLD_ORE: 15, DIAMOND_ORE: 16, BRICK: 17, GLOWSTONE: 18,
  TNT: 19, CACTUS: 20, FLOWER_RED: 21, FLOWER_YELLOW: 22, TALL_GRASS: 23, PUMPKIN: 24, LAVA: 25,
  WOOL_WHITE: 26, WOOL_RED: 27, WOOL_ORANGE: 28, WOOL_YELLOW: 29, WOOL_LIME: 30, WOOL_CYAN: 31, WOOL_BLUE: 32,
  WOOL_PURPLE: 33, WOOL_PINK: 34, WOOL_BLACK: 35,
} as const;

/** How a block is drawn. */
export const SHAPE_NONE = 0;
export const SHAPE_CUBE = 1;
/** Two crossed quads: flowers and grass. */
export const SHAPE_CROSS = 2;
/** A cube with its top lowered when nothing of the same liquid is above. */
export const SHAPE_LIQUID = 3;

/** Vertex flags, read by the chunk shader. */
export const FLAG_WAVE = 1;
export const FLAG_SWAY = 2;
export const FLAG_EMISSIVE = 4;
export const FLAG_SCROLL = 8;

export type Material = 'grass' | 'stone' | 'wood' | 'sand' | 'glass' | 'cloth' | 'snow' | 'plant' | 'liquid';

export interface BlockDef {
  id: number;
  name: string;
  shape: number;
  /** Texture layer per face: +x, -x, +y, -y, +z, -z. */
  faces: number[];
  /** Hides the faces of its neighbours and blocks light. */
  opaque: boolean;
  /** Stops the player. */
  solid: boolean;
  /** Light level it gives off, 0–8. */
  emit: number;
  flags: number;
  material: Material;
  /** In the inventory. */
  placeable: boolean;
}

const T = (name: TileName) => TILES.indexOf(name);
const cube = (top: TileName, bottom: TileName = top, side: TileName = top) => [T(side), T(side), T(top), T(bottom), T(side), T(side)];

export const BLOCKS: BlockDef[] = [];

function def(id: number, name: string, faces: number[], material: Material, extra: Partial<BlockDef> = {}) {
  BLOCKS[id] = { id, name, shape: SHAPE_CUBE, faces, opaque: true, solid: true, emit: 0, flags: 0, material, placeable: true, ...extra };
}

def(B.AIR, 'Air', cube('stone'), 'stone', { shape: SHAPE_NONE, opaque: false, solid: false, placeable: false });
def(B.GRASS, 'Grass', cube('grass_top', 'dirt', 'grass_side'), 'grass');
def(B.DIRT, 'Dirt', cube('dirt'), 'grass');
def(B.STONE, 'Stone', cube('stone'), 'stone');
def(B.COBBLE, 'Cobblestone', cube('cobble'), 'stone');
def(B.SAND, 'Sand', cube('sand'), 'sand');
def(B.WATER, 'Water', cube('water'), 'liquid', { shape: SHAPE_LIQUID, opaque: false, solid: false, placeable: false, flags: FLAG_WAVE | FLAG_SCROLL });
def(B.LOG, 'Oak Log', cube('log_top', 'log_top', 'log_side'), 'wood');
def(B.LEAVES, 'Leaves', cube('leaves'), 'plant', { opaque: false, flags: FLAG_SWAY });
def(B.PLANKS, 'Planks', cube('planks'), 'wood');
def(B.GLASS, 'Glass', cube('glass'), 'glass', { opaque: false });
def(B.SNOW_GRASS, 'Snowy Grass', cube('snow', 'dirt', 'snow_side'), 'snow');
def(B.SNOW, 'Snow', cube('snow'), 'snow');
def(B.BEDROCK, 'Bedrock', cube('bedrock'), 'stone', { placeable: false });
def(B.COAL_ORE, 'Coal Ore', cube('coal_ore'), 'stone');
def(B.GOLD_ORE, 'Gold Ore', cube('gold_ore'), 'stone');
def(B.DIAMOND_ORE, 'Diamond Ore', cube('diamond_ore'), 'stone');
def(B.BRICK, 'Bricks', cube('brick'), 'stone');
def(B.GLOWSTONE, 'Glowstone', cube('glowstone'), 'glass', { emit: 8, flags: FLAG_EMISSIVE });
def(B.TNT, 'TNT', cube('tnt_top', 'tnt_bottom', 'tnt_side'), 'plant');
def(B.CACTUS, 'Cactus', cube('cactus_top', 'cactus_top', 'cactus_side'), 'plant');
def(B.FLOWER_RED, 'Poppy', cube('flower_red'), 'plant', { shape: SHAPE_CROSS, opaque: false, solid: false, flags: FLAG_SWAY });
def(B.FLOWER_YELLOW, 'Dandelion', cube('flower_yellow'), 'plant', { shape: SHAPE_CROSS, opaque: false, solid: false, flags: FLAG_SWAY });
def(B.TALL_GRASS, 'Tall Grass', cube('tall_grass'), 'plant', { shape: SHAPE_CROSS, opaque: false, solid: false, flags: FLAG_SWAY });
def(B.PUMPKIN, "Jack o'Lantern", cube('pumpkin_top', 'pumpkin_top', 'pumpkin_face'), 'wood', { emit: 8 });
def(B.LAVA, 'Lava', cube('lava'), 'liquid', { shape: SHAPE_LIQUID, opaque: false, solid: false, placeable: false, emit: 7, flags: FLAG_WAVE | FLAG_SCROLL | FLAG_EMISSIVE });
const WOOL: [number, string, TileName][] = [
  [B.WOOL_WHITE, 'White', 'wool_white'], [B.WOOL_RED, 'Red', 'wool_red'], [B.WOOL_ORANGE, 'Orange', 'wool_orange'],
  [B.WOOL_YELLOW, 'Yellow', 'wool_yellow'], [B.WOOL_LIME, 'Lime', 'wool_lime'], [B.WOOL_CYAN, 'Cyan', 'wool_cyan'],
  [B.WOOL_BLUE, 'Blue', 'wool_blue'], [B.WOOL_PURPLE, 'Purple', 'wool_purple'], [B.WOOL_PINK, 'Pink', 'wool_pink'],
  [B.WOOL_BLACK, 'Black', 'wool_black'],
];
for (const [id, color, tile] of WOOL) def(id, `${color} Wool`, cube(tile), 'cloth');

export const BLOCK_COUNT = BLOCKS.length;

// The flat tables the hot loops read.
export const SHAPE = new Uint8Array(256);
export const OPAQUE = new Uint8Array(256);
export const SOLID = new Uint8Array(256);
export const EMIT = new Uint8Array(256);
export const FLAGS = new Uint8Array(256);
/** Casts ambient occlusion on its neighbours: opaque blocks and leaves. */
export const OCCLUDES = new Uint8Array(256);
export const FACE_TILE = new Uint8Array(256 * 6);
for (const b of BLOCKS) {
  SHAPE[b.id] = b.shape;
  OPAQUE[b.id] = b.opaque ? 1 : 0;
  SOLID[b.id] = b.solid ? 1 : 0;
  EMIT[b.id] = b.emit;
  FLAGS[b.id] = b.flags;
  OCCLUDES[b.id] = b.opaque || b.id === B.LEAVES ? 1 : 0;
  b.faces.forEach((tile, f) => (FACE_TILE[b.id * 6 + f] = tile));
}

export const isLiquid = (id: number) => SHAPE[id] === SHAPE_LIQUID;
/** Placing a block may overwrite these. */
export const isReplaceable = (id: number) => id === B.AIR || SHAPE[id] === SHAPE_LIQUID || SHAPE[id] === SHAPE_CROSS;
/** What the crosshair can point at. */
export const isTargetable = (id: number) => id !== B.AIR && SHAPE[id] !== SHAPE_LIQUID;
