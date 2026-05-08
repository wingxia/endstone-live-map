#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";

const COMMON_ALIASES = {
  grass: "minecraft:grass_block",
  grass_side: "minecraft:grass_block",
  dirt: "minecraft:dirt",
  stone: "minecraft:stone",
  water: "minecraft:water",
  sand: "minecraft:sand",
  gravel: "minecraft:gravel",
  log_oak: "minecraft:oak_log",
  planks_oak: "minecraft:oak_planks",
  leaves_oak: "minecraft:oak_leaves",
};

const args = parseArgs(process.argv.slice(2));
if (!args.input || !args.output) {
  console.error("Usage: node scripts/build-texture-atlas.mjs --input <resource-pack-root> --output <dir> [--tile-size 16]");
  process.exit(2);
}

const tileSize = Number(args["tile-size"] || 16);
const resourceRoot = path.resolve(args.input);
const outputDir = path.resolve(args.output);
const terrainPath = path.join(resourceRoot, "textures", "terrain_texture.json");
const terrain = JSON.parse(await fs.readFile(terrainPath, "utf8"));
const entries = await collectEntries(resourceRoot, terrain.texture_data || {}, tileSize);

if (entries.length === 0) {
  throw new Error(`No block textures found under ${resourceRoot}`);
}

const columns = Math.ceil(Math.sqrt(entries.length));
const rows = Math.ceil(entries.length / columns);
const atlas = new PNG({ width: columns * tileSize, height: rows * tileSize });
const manifest = {
  version: 1,
  tileSize,
  atlas: "/textures/atlas.png",
  blocks: {},
};

for (let index = 0; index < entries.length; index += 1) {
  const entry = entries[index];
  const x = (index % columns) * tileSize;
  const y = Math.floor(index / columns) * tileSize;
  blitNearest(entry.png, atlas, x, y, tileSize);
  manifest.blocks[entry.id] = { x, y, w: tileSize, h: tileSize };
  for (const alias of entry.aliases) {
    manifest.blocks[alias] = { x, y, w: tileSize, h: tileSize };
  }
}

await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(path.join(outputDir, "atlas.png"), PNG.sync.write(atlas));
await fs.writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${entries.length} textures to ${outputDir}`);

async function collectEntries(root, textureData, size) {
  const entries = [];
  const seen = new Set();
  for (const [key, value] of Object.entries(textureData)) {
    const texture = firstTexturePath(value?.textures);
    if (!texture) {
      continue;
    }
    const pngPath = path.join(root, `${texture}.png`);
    try {
      const png = PNG.sync.read(await fs.readFile(pngPath));
      const id = key.includes(":") ? key : `minecraft:${key}`;
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      const aliases = new Set([key]);
      if (COMMON_ALIASES[key]) {
        aliases.add(COMMON_ALIASES[key]);
      }
      entries.push({ id, aliases: [...aliases].filter((alias) => alias !== id), png: resizeNearest(png, size) });
    } catch {
      // Resource packs often reference optional variant textures. Missing files use the frontend fallback.
    }
  }
  return entries;
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
    parsed[value.slice(2)] = values[index + 1];
    index += 1;
  }
  return parsed;
}
