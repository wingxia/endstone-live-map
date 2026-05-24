const WOOD_FAMILY_COLORS = [
  ["dark_oak", "#5b3a24"],
  ["pale_oak", "#c8b987"],
  ["stripped_oak", "#a97a43"],
  ["oak", "#9f7442"],
  ["spruce", "#6f4c2d"],
  ["birch", "#cbb77a"],
  ["jungle", "#a66c3e"],
  ["acacia", "#a85d32"],
  ["mangrove", "#7b342f"],
  ["cherry", "#d8998f"],
  ["bamboo", "#c8aa55"],
  ["crimson", "#7f3b55"],
  ["warped", "#377b74"],
];

export function fallbackTextureColor(blockId, blockState = {}) {
  const id = String(blockId || "minecraft:air").toLowerCase();
  const name = stripBlockNamespace(id);
  if (isAirBlockName(name)) {
    return "#111820";
  }
  if (name.includes("water") || name.includes("bubble_column")) {
    return "#2563b8";
  }
  if (name.includes("cherry_leaves")) {
    return "#f2a5c9";
  }
  if (name.includes("azalea_leaves")) {
    return "#5f9f4a";
  }
  if (name.includes("grass_block")) {
    return "#5f9f3f";
  }
  if (name.includes("grass_path") || name.includes("dirt_path")) {
    return "#8f7644";
  }
  if (name.includes("podzol")) {
    return "#6f4a2e";
  }
  if (name.includes("farmland")) {
    return "#6f4b31";
  }
  if (name.includes("short_grass") || name.includes("tall_grass") || name.includes("fern") || name.includes("vine")) {
    return "#4f8f35";
  }
  if (name === "bamboo" || name.includes("bamboo_block")) {
    return "#7fa847";
  }
  if (name === "reeds" || name.includes("sugar_cane")) {
    return "#7fbf45";
  }
  if (name.includes("wheat")) {
    return "#c8aa42";
  }
  if (name.includes("carrots") || name.includes("potatoes")) {
    return "#6f9f3d";
  }
  if (name.includes("nether_wart")) {
    return "#8a2432";
  }
  if (name.includes("leaf_litter")) {
    return "#8f5f2d";
  }
  if (name.includes("bush") || name.includes("cactus")) {
    return "#4f8f35";
  }
  if (name.includes("glow_lichen")) {
    return "#78a88a";
  }
  if (isFlowerBlockName(name)) {
    return "#d9d16b";
  }
  if (name.includes("mushroom")) {
    return name.includes("red") ? "#b44738" : "#8a6a4a";
  }
  if (name.includes("leaves")) {
    return "#3f7f38";
  }
  if (name.includes("melon")) {
    return "#8fbf3d";
  }
  if (name.includes("pumpkin")) {
    return "#c47a2c";
  }
  if (name.includes("glass") || name.includes("pane")) {
    return "#9fc7d1";
  }
  if (name.includes("packed_ice") || name.includes("blue_ice")) {
    return "#80b8d6";
  }
  if (name.includes("ice")) {
    return "#9fc7d1";
  }
  const legacySlabColor = legacySlabMaterialColor(name, blockState);
  if (legacySlabColor) {
    return legacySlabColor;
  }
  const woodColor = woodMaterialColor(name);
  if (woodColor) {
    return woodColor;
  }
  if (name.includes("torch")) {
    return "#d49a42";
  }
  if (name.includes("lantern") || name.includes("candle") || name.includes("glow_frame")) {
    return "#d8b35a";
  }
  if (name.includes("end_rod")) {
    return "#e9e3c4";
  }
  if (name.includes("campfire")) {
    return "#8a5630";
  }
  if (name.includes("carpet")) {
    return woolColor(name.replace("carpet", "wool"));
  }
  if (name.includes("bed") || name.includes("banner")) {
    return woolColor(name.replace("bed", "wool").replace("banner", "wool"));
  }
  if (name.includes("gold_block")) {
    return "#d9b64a";
  }
  if (name.includes("iron_block")) {
    return "#c6c4b8";
  }
  if (name.includes("diamond_block")) {
    return "#6fc8c6";
  }
  if (name.includes("lapis_block")) {
    return "#315caa";
  }
  if (name.includes("amethyst")) {
    return "#9b78c8";
  }
  if (name.includes("prismarine")) {
    return "#5f9f96";
  }
  if (name.includes("glowstone") || name.includes("shroomlight")) {
    return "#d8a84a";
  }
  if (name.includes("sea_lantern")) {
    return "#b8d9cf";
  }
  if (name.includes("calcite")) {
    return "#d8d2c2";
  }
  if (name.includes("clay")) {
    return "#9aa0a8";
  }
  if (name.includes("beacon")) {
    return "#82c7d2";
  }
  if (name.includes("slime")) {
    return "#78b85b";
  }
  if (name.includes("honey")) {
    return "#d18f2f";
  }
  if (name.includes("cocoa")) {
    return "#7b4a2e";
  }
  if (name.includes("dried_ghast")) {
    return "#d6c7b3";
  }
  if (name.includes("mangrove_roots")) {
    return "#5f3a2f";
  }
  if (
    name.includes("chest") ||
    name.includes("barrel") ||
    name.includes("crafting_table") ||
    name.includes("bookshelf") ||
    name.includes("lectern") ||
    name === "frame" ||
    name.includes("item_frame")
  ) {
    return "#8a6138";
  }
  if (name.includes("smithing_table") || name.includes("loom") || name.includes("noteblock") || name.includes("note_block")) {
    return "#7b4f30";
  }
  if (
    name.includes("furnace") ||
    name.includes("piston") ||
    name.includes("dispenser") ||
    name.includes("dropper") ||
    name.includes("observer") ||
    name.includes("anvil") ||
    name.includes("hopper") ||
    name.includes("cauldron") ||
    name.includes("stonecutter") ||
    name.includes("lodestone") ||
    name.includes("piston_arm")
  ) {
    return "#777a78";
  }
  if (name.includes("comparator") || name.includes("repeater") || name.includes("redstone") || name.includes("trip_wire") || name.includes("tripwire")) {
    return "#8d5548";
  }
  if (name.includes("lever")) {
    return "#8b8174";
  }
  if (name.includes("cake")) {
    return "#f1dfcf";
  }
  if (name.includes("enchanting_table")) {
    return "#4f426f";
  }
  if (name.includes("dragon_head")) {
    return "#373047";
  }
  if (name.includes("obsidian")) {
    return "#46375f";
  }
  if (name.includes("emerald_block")) {
    return "#2fb56c";
  }
  if (name.includes("lightning_rod")) {
    return copperColor(name);
  }
  if (name.includes("copper")) {
    return copperColor(name);
  }
  if (name.includes("wool")) {
    return woolColor(name);
  }
  if (name.includes("shulker_box")) {
    return "#8b6fa8";
  }
  if (name.includes("chorus")) {
    return "#8f6aa0";
  }
  if (name.includes("coral")) {
    return coralColor(name);
  }
  if (name.includes("end_bricks")) {
    return "#d7cf92";
  }
  if (name.includes("end_stone")) {
    return "#d8cf8a";
  }
  if (name.includes("netherrack")) {
    return "#7a342f";
  }
  if (name.includes("soul_sand") || name.includes("soul_soil")) {
    return "#5a4738";
  }
  if (name.includes("red_nether_bricks")) {
    return "#6d2f2b";
  }
  if (name.includes("nether_bricks")) {
    return "#3a1f2b";
  }
  if (name.includes("deepslate_brick")) {
    return "#4a4e55";
  }
  if (name.includes("stone_brick")) {
    return "#7d8587";
  }
  if (name.includes("mud_brick")) {
    return "#8a5a47";
  }
  if (name.includes("brick")) {
    return "#a05a4a";
  }
  if (name.includes("quartz")) {
    return "#d8d1bf";
  }
  if (name.includes("purpur")) {
    return "#a978a8";
  }
  if (name.includes("red_sandstone")) {
    return "#b96f3b";
  }
  if (name.includes("sandstone")) {
    return "#cdbb78";
  }
  if (name.includes("terracotta")) {
    return terracottaColor(name);
  }
  if (name.includes("concrete")) {
    return concreteColor(name);
  }
  if (name.includes("tuff_brick")) {
    return "#6f746e";
  }
  if (name.includes("tuff")) {
    return "#73786f";
  }
  if (name.includes("dripstone")) {
    return "#8a6446";
  }
  if (name.includes("deepslate")) {
    return "#4b5358";
  }
  if (name.includes("blackstone") || name.includes("basalt")) {
    return "#3f3f42";
  }
  if (name.includes("cobblestone")) {
    return "#777a78";
  }
  if (name.includes("smooth_stone")) {
    return "#929596";
  }
  if (name.includes("granite")) {
    return "#9b6a55";
  }
  if (name.includes("diorite")) {
    return "#c5c3b9";
  }
  if (name.includes("andesite")) {
    return "#8f918a";
  }
  if (name.includes("stone")) {
    return "#858b8c";
  }
  if (name.includes("fence") || name.includes("trapdoor") || name.includes("door") || name.includes("rail") || name.includes("bars") || name.includes("chain")) {
    return "#8b8174";
  }
  if (name.includes("sand")) {
    return "#d7c47a";
  }
  if (name.includes("gravel")) {
    return "#7c7b76";
  }
  if (name.includes("ore")) {
    return oreColor(name);
  }
  if (name.includes("grass") || name.includes("leaves") || name.includes("moss")) {
    return "#4f8f3a";
  }
  if (name.includes("dirt") || name.includes("mud")) {
    return "#7a5236";
  }
  if (name.includes("log") || name.includes("wood") || name.includes("planks")) {
    return "#8a6138";
  }
  if (name.includes("snow")) {
    return "#dce9ec";
  }
  if (name.includes("lava")) {
    return "#e46b2a";
  }
  return "#737f86";
}

function stripBlockNamespace(id) {
  const parts = String(id || "").split(":");
  return parts[parts.length - 1] || "air";
}

function isAirBlockName(name) {
  return name === "air" || name === "cave_air" || name === "void_air";
}

function woodMaterialColor(name) {
  if (!isWoodMaterialName(name)) {
    return null;
  }
  const family = WOOD_FAMILY_COLORS.find(([token]) => name.includes(token));
  if (family) {
    return family[1];
  }
  return isGenericWoodMaterialName(name) ? "#8a6138" : null;
}

function legacySlabMaterialColor(name, state) {
  if (!name.includes("slab")) {
    return null;
  }
  const material = stateToken(state, [
    "wood_type",
    "minecraft:wood_type",
    "stone_slab_type",
    "minecraft:stone_slab_type",
    "stone_slab_type_2",
    "minecraft:stone_slab_type_2",
    "stone_slab_type_3",
    "minecraft:stone_slab_type_3",
    "stone_slab_type_4",
    "minecraft:stone_slab_type_4",
  ]);
  if (!material) {
    return null;
  }
  const woodFamily = WOOD_FAMILY_COLORS.find(([token]) => material.includes(token));
  if (woodFamily) {
    return woodFamily[1];
  }
  if (material.includes("quartz")) {
    return "#d8d1bf";
  }
  if (material.includes("red_sandstone")) {
    return "#b96f3b";
  }
  if (material.includes("sandstone")) {
    return "#cdbb78";
  }
  if (material.includes("end_stone") || material.includes("end_brick")) {
    return "#d7cf92";
  }
  if (material.includes("purpur")) {
    return "#a978a8";
  }
  if (material.includes("brick")) {
    return "#a05a4a";
  }
  if (material.includes("cobblestone")) {
    return "#777a78";
  }
  if (material.includes("smooth_stone") || material === "stone") {
    return "#929596";
  }
  return null;
}

function stateToken(state, keys) {
  if (!state || typeof state !== "object") {
    return "";
  }
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(state, key)) {
      return String(state[key]).toLowerCase();
    }
  }
  return "";
}

function isWoodMaterialName(name) {
  return (
    name.includes("planks") ||
    name.includes("log") ||
    name.includes("wood") ||
    name.includes("stem") ||
    name.includes("hyphae") ||
    name.includes("mosaic") ||
    name.includes("shelf") ||
    name.includes("scaffolding") ||
    name.includes("ladder") ||
    name.includes("sign") ||
    name.includes("slab") ||
    name.includes("stairs") ||
    name.includes("fence") ||
    name.includes("trapdoor") ||
    name.includes("door") ||
    name.includes("button") ||
    name.includes("pressure_plate") ||
    name.includes("bee_nest") ||
    name.includes("composter")
  );
}

function isGenericWoodMaterialName(name) {
  return (
    name.includes("planks") ||
    name.includes("log") ||
    name.includes("wood") ||
    name.includes("stem") ||
    name.includes("hyphae") ||
    name.includes("mosaic") ||
    name.includes("shelf") ||
    name.includes("scaffolding") ||
    name.includes("ladder") ||
    name.includes("sign") ||
    name.includes("bee_nest") ||
    name.includes("composter")
  );
}

function isFlowerBlockName(name) {
  return (
    name.includes("flower") ||
    name.includes("poppy") ||
    name.includes("dandelion") ||
    name.includes("tulip") ||
    name.includes("orchid") ||
    name.includes("allium") ||
    name.includes("azure_bluet") ||
    name.includes("oxeye_daisy") ||
    name.includes("peony") ||
    name.includes("lilac") ||
    name.includes("lily_of_the_valley") ||
    name.includes("petals")
  );
}

function coralColor(name) {
  if (name.includes("dead")) {
    return "#7d746b";
  }
  if (name.includes("tube")) {
    return "#3159b7";
  }
  if (name.includes("brain")) {
    return "#c65f9a";
  }
  if (name.includes("bubble")) {
    return "#8c55bd";
  }
  if (name.includes("fire")) {
    return "#c34838";
  }
  if (name.includes("horn")) {
    return "#d1b942";
  }
  return "#b65f73";
}

function copperColor(name) {
  if (name.includes("oxidized")) {
    return "#5b9a8f";
  }
  if (name.includes("weathered")) {
    return "#6f8f7d";
  }
  if (name.includes("exposed")) {
    return "#9b6d4d";
  }
  return "#b86f45";
}

function woolColor(name) {
  if (name.includes("black_wool")) {
    return "#25282a";
  }
  if (name.includes("light_gray_wool")) {
    return "#b0b4b4";
  }
  if (name.includes("gray_wool")) {
    return "#5a5f62";
  }
  if (name.includes("brown_wool")) {
    return "#70482d";
  }
  if (name.includes("red_wool")) {
    return "#9f3434";
  }
  if (name.includes("orange_wool")) {
    return "#d07a2c";
  }
  if (name.includes("yellow_wool")) {
    return "#d8bd38";
  }
  if (name.includes("green_wool")) {
    return "#4f7a35";
  }
  if (name.includes("lime_wool")) {
    return "#78aa3f";
  }
  if (name.includes("light_blue_wool")) {
    return "#63a6c8";
  }
  if (name.includes("blue_wool")) {
    return "#3f5797";
  }
  if (name.includes("cyan_wool")) {
    return "#338a91";
  }
  if (name.includes("purple_wool")) {
    return "#744ba0";
  }
  if (name.includes("magenta_wool")) {
    return "#b45aa8";
  }
  if (name.includes("pink_wool")) {
    return "#d98aa6";
  }
  return "#d8d8d0";
}

function oreColor(name) {
  if (name.includes("copper_ore")) {
    return "#9b765c";
  }
  if (name.includes("iron_ore")) {
    return "#b08a6a";
  }
  if (name.includes("coal_ore")) {
    return "#4f5354";
  }
  if (name.includes("gold_ore")) {
    return "#c6a24a";
  }
  if (name.includes("redstone_ore")) {
    return "#8f3b35";
  }
  if (name.includes("lapis_ore")) {
    return "#486aa0";
  }
  if (name.includes("diamond_ore")) {
    return "#6fb8b5";
  }
  if (name.includes("emerald_ore")) {
    return "#5fa66f";
  }
  return "#7c7f7e";
}

function terracottaColor(name) {
  if (name.includes("red_terracotta")) {
    return "#8f3f31";
  }
  if (name.includes("yellow_terracotta")) {
    return "#b58b34";
  }
  if (name.includes("green_terracotta")) {
    return "#4e6532";
  }
  if (name.includes("black_terracotta")) {
    return "#302421";
  }
  if (name.includes("white_terracotta")) {
    return "#d1b1a1";
  }
  if (name.includes("light_gray_terracotta")) {
    return "#876f66";
  }
  if (name.includes("gray_terracotta")) {
    return "#514a45";
  }
  if (name.includes("light_blue_terracotta")) {
    return "#6d7f9d";
  }
  if (name.includes("blue_terracotta")) {
    return "#4d5f86";
  }
  if (name.includes("brown_terracotta")) {
    return "#6b422b";
  }
  if (name.includes("orange_terracotta")) {
    return "#a45b2e";
  }
  if (name.includes("cyan_terracotta")) {
    return "#565c5c";
  }
  if (name.includes("purple_terracotta")) {
    return "#764656";
  }
  if (name.includes("magenta_terracotta")) {
    return "#96586f";
  }
  if (name.includes("pink_terracotta")) {
    return "#a35f5f";
  }
  if (name.includes("lime_terracotta")) {
    return "#677535";
  }
  return "#9b6a55";
}

function concreteColor(name) {
  if (name.includes("black_concrete")) {
    return "#1f2225";
  }
  if (name.includes("white_concrete")) {
    return "#d7dad8";
  }
  if (name.includes("light_gray_concrete")) {
    return "#a7abae";
  }
  if (name.includes("gray_concrete")) {
    return "#565b5f";
  }
  if (name.includes("red_concrete")) {
    return "#8f2f2d";
  }
  if (name.includes("orange_concrete")) {
    return "#d36b23";
  }
  if (name.includes("yellow_concrete")) {
    return "#e0b833";
  }
  if (name.includes("green_concrete")) {
    return "#4b6d2f";
  }
  if (name.includes("lime_concrete")) {
    return "#78a83f";
  }
  if (name.includes("light_blue_concrete")) {
    return "#4f9bc7";
  }
  if (name.includes("blue_concrete")) {
    return "#364f8f";
  }
  if (name.includes("cyan_concrete")) {
    return "#267f89";
  }
  if (name.includes("purple_concrete")) {
    return "#6c3f97";
  }
  if (name.includes("magenta_concrete")) {
    return "#a84f9c";
  }
  if (name.includes("pink_concrete")) {
    return "#d47a9c";
  }
  if (name.includes("brown_concrete")) {
    return "#70462c";
  }
  return "#737f86";
}
