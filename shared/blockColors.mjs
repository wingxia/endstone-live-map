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

export function fallbackTextureColor(blockId) {
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
  if (name.includes("short_grass") || name.includes("tall_grass") || name.includes("fern") || name.includes("vine")) {
    return "#4f8f35";
  }
  if (name.includes("flower") || name.includes("poppy") || name.includes("dandelion") || name.includes("tulip") || name.includes("orchid") || name.includes("allium")) {
    return "#d9d16b";
  }
  if (name.includes("leaves")) {
    return "#3f7f38";
  }
  if (name.includes("glass") || name.includes("pane") || name.includes("ice")) {
    return "#9fc7d1";
  }
  const woodColor = woodMaterialColor(name);
  if (woodColor) {
    return woodColor;
  }
  if (name.includes("chest") || name.includes("barrel") || name.includes("crafting_table") || name.includes("bookshelf") || name.includes("lectern")) {
    return "#8a6138";
  }
  if (name.includes("end_bricks")) {
    return "#d7cf92";
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
  return name.includes("planks") || name.includes("log") || name.includes("wood") || name.includes("stem") || name.includes("hyphae") ? "#8a6138" : null;
}

function isWoodMaterialName(name) {
  return (
    name.includes("planks") ||
    name.includes("log") ||
    name.includes("wood") ||
    name.includes("stem") ||
    name.includes("hyphae") ||
    name.includes("slab") ||
    name.includes("stairs") ||
    name.includes("fence") ||
    name.includes("trapdoor") ||
    name.includes("door") ||
    name.includes("sign") ||
    name.includes("button") ||
    name.includes("pressure_plate")
  );
}

function terracottaColor(name) {
  if (name.includes("blue_terracotta")) {
    return "#4d5f86";
  }
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
  if (name.includes("gray_terracotta")) {
    return "#514a45";
  }
  if (name.includes("light_gray_terracotta")) {
    return "#876f66";
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
  if (name.includes("gray_concrete")) {
    return "#565b5f";
  }
  if (name.includes("light_gray_concrete")) {
    return "#a7abae";
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
  if (name.includes("blue_concrete")) {
    return "#364f8f";
  }
  if (name.includes("light_blue_concrete")) {
    return "#4f9bc7";
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
