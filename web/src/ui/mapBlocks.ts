const PLANT_EXACT_BLOCKS = new Set([
  "minecraft:azalea",
  "minecraft:bamboo",
  "minecraft:bamboo_sapling",
  "minecraft:big_dripleaf",
  "minecraft:brown_mushroom",
  "minecraft:bush",
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
  "amethyst_cluster",
  "banner",
  "bell",
  "brewing_stand",
  "button",
  "cake",
  "campfire",
  "candle",
  "carpet",
  "chain",
  "cobweb",
  "comparator",
  "conduit",
  "copper_grate",
  "coral",
  "door",
  "end_rod",
  "fence",
  "fence_gate",
  "flower_pot",
  "grate",
  "bars",
  "head",
  "iron_bars",
  "ladder",
  "lantern",
  "leaf_litter",
  "lever",
  "pane",
  "pressure_plate",
  "rail",
  "repeater",
  "redstone_torch",
  "redstone_wire",
  "scaffolding",
  "sea_pickle",
  "sign",
  "skull",
  "snow_layer",
  "torch",
  "trapdoor",
  "tripwire",
  "tripwire_hook",
  "turtle_egg",
  "web",
];

const CUTOUT_SURFACE_EXACT_EXCLUSIONS = new Set(["minecraft:jack_o_lantern", "minecraft:sea_lantern"]);

const CUTOUT_SURFACE_SUFFIX_EXCLUSIONS = ["_coral_block"];

export function isPlantBlock(blockId: string) {
  const id = normalizeBlockId(blockId);
  if (id === "minecraft:grass_block" || id.endsWith("_mushroom_block") || id.endsWith("_wart_block") || id.endsWith("_leaves")) {
    return false;
  }
  return PLANT_EXACT_BLOCKS.has(id) || PLANT_TOKENS.some((token) => id.includes(token));
}

export function isMapDecorationBlock(blockId: string) {
  const id = normalizeBlockId(blockId);
  if (CUTOUT_SURFACE_EXACT_EXCLUSIONS.has(id) || CUTOUT_SURFACE_SUFFIX_EXCLUSIONS.some((suffix) => id.endsWith(suffix))) {
    return false;
  }
  return isPlantBlock(id) || CUTOUT_SURFACE_TOKENS.some((token) => id.includes(token));
}

export function isLikelyTransparentTextureBlock(blockId: string) {
  const id = normalizeBlockId(blockId);
  return (
    isMapDecorationBlock(id) ||
    id.includes("leaves") ||
    id.includes("water") ||
    id.includes("ice") ||
    id.includes("glass") ||
    id.includes("bubble_column") ||
    id.includes("copper_grate") ||
    id.includes("grate")
  );
}

function normalizeBlockId(value: string) {
  const id = String(value || "minecraft:air").toLowerCase();
  return id.includes(":") ? id : `minecraft:${id}`;
}
