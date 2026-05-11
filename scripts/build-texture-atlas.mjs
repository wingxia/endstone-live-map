#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";

const COMMON_ALIASES = {
  grass: "minecraft:grass_block",
  grass_side: "minecraft:grass_block",
  grass_top: "minecraft:grass_block",
  dirt: "minecraft:dirt",
  stone: "minecraft:stone",
  stone_andesite: "minecraft:andesite",
  stone_andesite_smooth: "minecraft:polished_andesite",
  stone_diorite: "minecraft:diorite",
  stone_diorite_smooth: "minecraft:polished_diorite",
  stone_granite: "minecraft:granite",
  stone_granite_smooth: "minecraft:polished_granite",
  water: "minecraft:water",
  sand: "minecraft:sand",
  gravel: "minecraft:gravel",
  red_nether_brick: "minecraft:red_nether_bricks",
  nether_brick: "minecraft:nether_bricks",
  log_oak: "minecraft:oak_log",
  planks_oak: "minecraft:oak_planks",
  leaves_oak: "minecraft:oak_leaves",
  blue_ice: "minecraft:blue_ice",
  packed_ice: "minecraft:packed_ice",
};

const args = parseArgs(process.argv.slice(2));
if (!args.input || !args.output) {
  console.error("Usage: node scripts/build-texture-atlas.mjs --input <resource-pack-root> [--input <override-pack>] --output <dir> [--tile-size 16]");
  process.exit(2);
}

const tileSize = Number(args["tile-size"] || 16);
const resourceRoots = values(args.input).map((input) => path.resolve(input));
const outputDir = path.resolve(args.output);
const result = await collectEntries(resourceRoots, tileSize);

if (result.entries.length === 0) {
  throw new Error(`No block textures found under ${resourceRoots.join(", ")}`);
}

const columns = Math.ceil(Math.sqrt(result.entries.length));
const rows = Math.ceil(result.entries.length / columns);
const atlas = new PNG({ width: columns * tileSize, height: rows * tileSize });
const manifest = {
  version: 1,
  tileSize,
  atlas: "/textures/atlas.png",
  blocks: {},
};

for (let index = 0; index < result.entries.length; index += 1) {
  const entry = result.entries[index];
  const x = (index % columns) * tileSize;
  const y = Math.floor(index / columns) * tileSize;
  blitNearest(entry.png, atlas, x, y, tileSize);
  manifest.blocks[entry.id] = { x, y, w: tileSize, h: tileSize };
  for (const alias of entry.aliases) {
    manifest.blocks[alias] = { x, y, w: tileSize, h: tileSize };
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  inputs: resourceRoots,
  entries: result.entries.length,
  manifestBlocks: Object.keys(manifest.blocks).length,
  missing: result.missing,
  overrides: result.overrides,
};

await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(path.join(outputDir, "atlas.png"), PNG.sync.write(atlas));
await fs.writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Wrote ${result.entries.length} textures to ${outputDir}`);

async function collectEntries(roots, size) {
  const byId = new Map();
  const missing = [];
  const overrides = [];

  for (const root of roots) {
    const terrain = await readJsonIfExists(path.join(root, "textures", "terrain_texture.json"));
    const blockTextureAliases = await readBlockTextureAliases(root);
    if (!terrain?.texture_data) {
      missing.push({ root, id: "terrain_texture.json", reason: "not_found" });
      continue;
    }

    for (const [key, value] of Object.entries(terrain.texture_data)) {
      const texture = firstTexturePath(value?.textures);
      if (!texture) {
        missing.push({ root, id: key, reason: "no_texture_path" });
        continue;
      }
      const pngPath = await findPng(root, texture);
      if (!pngPath) {
        missing.push({ root, id: key, reason: "png_not_found", texture });
        continue;
      }
      try {
        const png = PNG.sync.read(await fs.readFile(pngPath));
        const id = namespaced(key);
        const aliases = new Set([key, id, ...aliasesForTextureKey(key), ...(blockTextureAliases.get(key) || [])]);
        if (COMMON_ALIASES[key]) {
          aliases.add(COMMON_ALIASES[key]);
        }
        const entry = { id, aliases: [...aliases].filter((alias) => alias !== id), png: resizeNearest(png, size), source: root };
        if (byId.has(id)) {
          overrides.push({ id, from: byId.get(id).source, to: root });
        }
        byId.set(id, entry);
      } catch (error) {
        missing.push({ root, id: key, reason: "png_decode_failed", texture, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  return { entries: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)), missing, overrides };
}

async function readBlockTextureAliases(root) {
  const aliases = new Map();
  const blocks = await readJsonLike(path.join(root, "blocks.json"));
  if (!blocks || typeof blocks !== "object") {
    return aliases;
  }
  for (const [blockId, value] of Object.entries(blocks)) {
    const textureNames = extractTextureNames(value);
    for (const textureName of textureNames) {
      if (!aliases.has(textureName)) {
        aliases.set(textureName, new Set());
      }
      aliases.get(textureName).add(namespaced(blockId));
    }
  }
  return new Map([...aliases.entries()].map(([key, set]) => [key, [...set]]));
}

function extractTextureNames(value) {
  const textures = value?.textures;
  if (typeof textures === "string") {
    return [textures];
  }
  if (Array.isArray(textures)) {
    return textures.filter((item) => typeof item === "string");
  }
  if (textures && typeof textures === "object") {
    return Object.values(textures).flatMap((entry) => {
      if (typeof entry === "string") {
        return [entry];
      }
      if (Array.isArray(entry)) {
        return entry.filter((item) => typeof item === "string");
      }
      return [];
    });
  }
  return [];
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(stripJsonCommentsAndTrailingCommas(await fs.readFile(file, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readJsonLike(file) {
  try {
    const text = await fs.readFile(file, "utf8");
    return JSON.parse(stripJsonCommentsAndTrailingCommas(text));
  } catch {
    return null;
  }
}

function stripJsonCommentsAndTrailingCommas(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/,\s*([}\]])/g, "$1");
}

async function findPng(root, texture) {
  const candidates = [`${texture}.png`, path.join("textures", `${texture}.png`), path.join("textures", "blocks", `${texture}.png`)];
  for (const candidate of candidates) {
    const pngPath = path.join(root, candidate);
    try {
      await fs.access(pngPath);
      return pngPath;
    } catch {
      // Try the next path shape.
    }
  }
  return "";
}

function firstTexturePath(value) {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return firstTexturePath(value[0]);
  }
  if (value && typeof value === "object") {
    return firstTexturePath(value.path || value.variations || value.textures);
  }
  return "";
}

function aliasesForTextureKey(key) {
  const aliases = new Set();
  aliases.add(key);
  aliases.add(namespaced(key));
  aliases.add(namespaced(key.replace(/_top$/, "")));
  aliases.add(namespaced(key.replace(/_side$/, "")));
  aliases.add(namespaced(key.replace(/^tile\./, "")));
  return [...aliases];
}

function namespaced(value) {
  const id = String(value);
  return id.includes(":") ? id : `minecraft:${id}`;
}

function resizeNearest(source, size) {
  if (source.width === size && source.height === size) {
    return source;
  }
  const output = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sourceX = Math.min(source.width - 1, Math.floor((x / size) * source.width));
      const sourceY = Math.min(source.height - 1, Math.floor((y / size) * source.height));
      copyPixel(source, output, sourceX, sourceY, x, y);
    }
  }
  return output;
}

function blitNearest(source, target, offsetX, offsetY, size) {
  const resized = resizeNearest(source, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      copyPixel(resized, target, x, y, offsetX + x, offsetY + y);
    }
  }
}

function copyPixel(source, target, sourceX, sourceY, targetX, targetY) {
  const sourceIndex = (sourceY * source.width + sourceX) * 4;
  const targetIndex = (targetY * target.width + targetX) * 4;
  target.data[targetIndex] = source.data[sourceIndex];
  target.data[targetIndex + 1] = source.data[sourceIndex + 1];
  target.data[targetIndex + 2] = source.data[sourceIndex + 2];
  target.data[targetIndex + 3] = source.data[sourceIndex + 3];
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      continue;
    }
    const key = value.slice(2);
    const next = values[index + 1];
    if (!parsed[key]) {
      parsed[key] = [];
    }
    parsed[key].push(next);
    index += 1;
  }
  return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, value.length === 1 ? value[0] : value]));
}

function values(value) {
  return Array.isArray(value) ? value : [value];
}
