const PLANT_EXACT_BLOCKS = new Set([
  "minecraft:azalea",
  "minecraft:bamboo",
  "minecraft:bamboo_sapling",
  "minecraft:big_dripleaf",
  "minecraft:brown_mushroom",
  "minecraft:cactus_flower",
  "minecraft:crimson_fungus",
  "minecraft:deadbush",
  "minecraft:flowering_azalea",
  "minecraft:kelp",
  "minecraft:red_mushroom",
  "minecraft:small_dripleaf_block",
  "minecraft:spore_blossom",
  "minecraft:sugar_cane",
  "minecraft:warped_fungus",
]);

const PLANT_TOKENS = [
  "allium",
  "azure_bluet",
  "beetroot",
  "blue_orchid",
  "carrots",
  "cave_vines",
  "cornflower",
  "dandelion",
  "fern",
  "flower",
  "crimson_roots",
  "hanging_roots",
  "kelp",
  "lilac",
  "lily_of_the_valley",
  "melon_stem",
  "nether_sprouts",
  "nether_wart",
  "oxeye_daisy",
  "peony",
  "petals",
  "pitcher_crop",
  "pitcher_plant",
  "poppy",
  "potatoes",
  "pumpkin_stem",
  "rose_bush",
  "sapling",
  "seagrass",
  "short_grass",
  "sprouts",
  "sunflower",
  "sweet_berry_bush",
  "tall_grass",
  "torchflower",
  "tulip",
  "twisting_vines",
  "vine",
  "warped_roots",
  "weeping_vines",
  "wheat",
  "wildflowers",
  "wither_rose",
];

const CUTOUT_SURFACE_TOKENS = [
  "banner",
  "button",
  "candle",
  "chain",
  "cobweb",
  "copper_grate",
  "door",
  "fence",
  "fence_gate",
  "grate",
  "bars",
  "iron_bars",
  "ladder",
  "lantern",
  "lever",
  "pane",
  "pressure_plate",
  "rail",
  "redstone_torch",
  "redstone_wire",
  "scaffolding",
  "sign",
  "torch",
  "trapdoor",
  "tripwire",
  "web",
];

export function isPlantBlock(blockId: string) {
  const id = normalizeBlockId(blockId);
  if (id === "minecraft:grass_block" || id.endsWith("_mushroom_block") || id.endsWith("_wart_block") || id.endsWith("_leaves")) {
    return false;
  }
  return PLANT_EXACT_BLOCKS.has(id) || PLANT_TOKENS.some((token) => id.includes(token));
}

export function isMapDecorationBlock(blockId: string) {
  const id = normalizeBlockId(blockId);
  return isPlantBlock(id) || CUTOUT_SURFACE_TOKENS.some((token) => id.includes(token));
}

export function isLikelyTransparentTextureBlock(blockId: string) {
  const id = normalizeBlockId(blockId);
  return isMapDecorationBlock(id) || id.includes("leaves") || id.includes("water") || id.includes("ice");
}

function normalizeBlockId(value: string) {
  const id = String(value || "minecraft:air").toLowerCase();
  return id.includes(":") ? id : `minecraft:${id}`;
}
