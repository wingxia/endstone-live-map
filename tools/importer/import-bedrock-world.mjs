#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import {
  buildChunkSnapshot,
  chunkKey,
  DEFAULT_WORLD,
  mergeWorldMeta,
  normalizeDimension,
  summarizeSnapshots,
} from "./chunkSnapshot.js";

const SUBCHUNK_TYPE = "SubChunkPrefix";
const DEFAULT_BATCH_SIZE = 384;
const MAX_POST_ATTEMPTS = 20;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  });
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.db) {
    console.error("Usage: node tools/importer/import-bedrock-world.mjs --db <snapshot level db dir> --worker-url https://map.buhe.li --token <plugin token> [--dry-run]");
    process.exit(2);
  }

  const options = {
    dbPath: path.resolve(args.db),
    world: args.world || DEFAULT_WORLD,
    workerUrl: stripTrailingSlash(args["worker-url"] || "https://map.buhe.li"),
    token: args.token || process.env.PLUGIN_TOKEN || "",
    dryRun: Boolean(args["dry-run"]),
    limit: optionalNumber(args.limit),
    batchSize: Math.min(DEFAULT_BATCH_SIZE, optionalNumber(args["batch-size"]) || DEFAULT_BATCH_SIZE),
    rps: optionalNumber(args.rps) || 1,
    dimension: args.dimension || "",
    minChunkX: optionalMaybeNumber(args["min-chunk-x"]),
    maxChunkX: optionalMaybeNumber(args["max-chunk-x"]),
    minChunkZ: optionalMaybeNumber(args["min-chunk-z"]),
    maxChunkZ: optionalMaybeNumber(args["max-chunk-z"]),
    resumeFile: args["resume-file"] ? path.resolve(args["resume-file"]) : "",
    storage: args.storage === "chunk" ? "chunk" : "region",
    includeLiquids: args["include-liquids"] !== "false",
  };

  if (!options.dryRun && !options.token) {
    throw new Error("PLUGIN_TOKEN is required unless --dry-run is set");
  }
  validateBounds(options);

  const { LevelDB } = await import("@8crafter/leveldb-zlib");
  const levelUtils = await import("mcbe-leveldb");
  const db = new LevelDB(options.dbPath, { createIfMissing: false });
  await db.open();
  try {
    const resume = options.resumeFile ? await readResume(options.resumeFile) : { uploaded: [] };
    const uploaded = new Set(resume.uploaded || []);
    const metas = new Map();
    let batch = [];
    let processed = 0;
    let uploadedCount = 0;
    let skipped = 0;
    const startedAt = Date.now();

    for await (const group of iterateSubchunkGroups(db, levelUtils, options)) {
      if (options.limit && processed >= options.limit) {
        break;
      }
      processed += 1;
      const snapshot = buildChunkSnapshot({
        world: options.world,
        dimension: group.dimension,
        chunkX: group.chunkX,
        chunkZ: group.chunkZ,
        subchunks: group.subchunks,
        updatedAt: startedAt,
        includeLiquids: options.includeLiquids,
      });
      const key = chunkKey(snapshot);
      const dimension = normalizeDimension(group.dimension);
      const meta = summarizeSnapshots([snapshot], { world: options.world, dimension, importedAt: startedAt, status: options.dryRun ? "dry_run" : "complete" });
      metas.set(dimension, mergeWorldMeta(metas.get(dimension), meta));

      if (uploaded.has(key)) {
        skipped += 1;
        continue;
      }
      batch.push(snapshot);
      if (batch.length >= options.batchSize) {
        uploadedCount += await flushBatch(batch, options, uploaded);
        await writeResume(options.resumeFile, uploaded);
        batch = [];
      }
    }

    if (batch.length > 0) {
      uploadedCount += await flushBatch(batch, options, uploaded);
      await writeResume(options.resumeFile, uploaded);
    }

    for (const [dimension, meta] of metas) {
      if (options.dryRun) {
        continue;
      }
      await postJson(`${options.workerUrl}/api/plugin/world-meta`, meta, options.token);
      console.log(`Uploaded world meta for ${dimension}: ${meta.chunkCount} chunks`);
    }

    const summary = {
      dryRun: options.dryRun,
      dbPath: options.dbPath,
      world: options.world,
      dimensions: Object.fromEntries([...metas.entries()]),
      processed,
      uploaded: uploadedCount,
      skipped,
      estimatedChunkObjects: processed,
      estimatedJsonBytes: [...metas.values()].reduce((sum, meta) => sum + meta.chunkCount * 2300, 0),
    };
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  } finally {
    await db.close();
  }
}

export async function readSubchunkGroups(db, levelUtils, options = {}) {
  const groups = new Map();
  for await (const group of iterateSubchunkGroups(db, levelUtils, options)) {
    groups.set(`${group.dimension}/${group.chunkX}/${group.chunkZ}`, group);
  }
  return groups;
}

export async function* iterateSubchunkGroups(db, levelUtils, options = {}) {
  const { getContentTypeFromDBKey, getChunkKeyIndices, entryContentTypeToFormatMap } = levelUtils;
  const iterator = db.getIterator({ keys: true, values: true, keyAsBuffer: true, valueAsBuffer: true });
  let currentKey = "";
  let currentGroup = null;
  let skippedSubchunks = 0;
  try {
    let next;
    while ((next = await iterator.next())) {
      const entry = coerceIteratorEntry(next, getContentTypeFromDBKey, getChunkKeyIndices);
      if (!entry) {
        continue;
      }
      const { rawKey, rawValue } = entry;
      const indices = getChunkKeyIndices(rawKey);
      const dimension = normalizeDimension(indices.dimension);
      if (options.dimension && dimension !== options.dimension) {
        continue;
      }
      if (!isChunkInBounds(indices.x, indices.z, options)) {
        continue;
      }
      let parsed;
      try {
        parsed = await entryContentTypeToFormatMap.SubChunkPrefix.parse(rawValue);
      } catch (error) {
        skippedSubchunks += 1;
        if (skippedSubchunks <= 10) {
          console.warn(`Skipping unparsable subchunk ${dimension}/${indices.x}/${indices.z}: ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }
      const subchunkIndex = "subChunkIndex" in indices ? indices.subChunkIndex : parsed.value.subChunkIndex?.value ?? 0;
      const key = `${dimension}/${indices.x}/${indices.z}`;
      if (currentKey && key !== currentKey) {
        yield currentGroup;
        currentKey = "";
        currentGroup = null;
      }
      if (!currentGroup) {
        currentKey = key;
        currentGroup = { dimension, chunkX: indices.x, chunkZ: indices.z, subchunks: [] };
      }
      const layers = parsed.value.layers?.value?.value || [];
      currentGroup.subchunks.push({ y: subchunkIndex, layers });
    }
    if (skippedSubchunks > 10) {
      console.warn(`Skipped ${skippedSubchunks} unparsable subchunks total.`);
    }
    if (currentGroup) {
      yield currentGroup;
    }
  } finally {
    await iterator.end?.();
  }
}

async function flushBatch(batch, options, uploaded) {
  if (options.dryRun) {
    for (const snapshot of batch) {
      uploaded.add(chunkKey(snapshot));
    }
    return 0;
  }
  const response = await postJson(`${options.workerUrl}/api/plugin/chunks/batch`, { chunks: batch, broadcast: false, storage: options.storage }, options.token);
  for (const snapshot of batch) {
    uploaded.add(chunkKey(snapshot));
  }
  await delay(Math.ceil(1000 / Math.max(0.1, options.rps)));
  console.log(`Uploaded ${batch.length} chunks (${response.keys?.length || 0} R2 objects)`);
  return batch.length;
}

async function postJson(url, payload, token) {
  for (let attempt = 1; attempt <= MAX_POST_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      if (attempt === MAX_POST_ATTEMPTS) {
        throw error;
      }
      console.warn(`POST ${url} failed on attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}; retrying`);
      await delay(backoffMs(attempt));
      continue;
    }

    if (response.ok) {
      return response.json();
    }

    const text = await response.text();
    if (attempt === MAX_POST_ATTEMPTS || response.status < 500) {
      throw new Error(`POST ${url} failed with ${response.status}: ${text}`);
    }
    console.warn(`POST ${url} failed with ${response.status} on attempt ${attempt}: ${text.slice(0, 200)}; retrying`);
    await delay(backoffMs(attempt));
  }
  throw new Error(`POST ${url} failed after ${MAX_POST_ATTEMPTS} attempts`);
}

async function readResume(file) {
  if (!file) {
    return { uploaded: [] };
  }
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { uploaded: [] };
    }
    throw error;
  }
}

async function writeResume(file, uploaded) {
  if (!file) {
    return;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ uploaded: [...uploaded].sort(), updatedAt: Date.now() }, null, 2)}\n`);
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
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function optionalNumber(value) {
  if (value === undefined || value === true || value === "") {
    return 0;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`Invalid number: ${value}`);
  }
  return Math.trunc(number);
}

function optionalMaybeNumber(value) {
  if (value === undefined || value === true || value === "") {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Invalid number: ${value}`);
  }
  return Math.trunc(number);
}

function validateBounds(options) {
  for (const [minField, maxField] of [
    ["minChunkX", "maxChunkX"],
    ["minChunkZ", "maxChunkZ"],
  ]) {
    if (options[minField] !== undefined && options[maxField] !== undefined && options[maxField] < options[minField]) {
      throw new Error(`${maxField} must be greater than or equal to ${minField}`);
    }
  }
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function isChunkInBounds(chunkX, chunkZ, options) {
  if (options.minChunkX !== undefined && chunkX < options.minChunkX) {
    return false;
  }
  if (options.maxChunkX !== undefined && chunkX > options.maxChunkX) {
    return false;
  }
  if (options.minChunkZ !== undefined && chunkZ < options.minChunkZ) {
    return false;
  }
  if (options.maxChunkZ !== undefined && chunkZ > options.maxChunkZ) {
    return false;
  }
  return true;
}

function coerceIteratorEntry(next, getContentTypeFromDBKey, getChunkKeyIndices) {
  if (!Array.isArray(next) || next.length < 2) {
    return null;
  }
  const [first, second] = next;
  if (isValidSubchunkKey(second, getContentTypeFromDBKey, getChunkKeyIndices)) {
    return { rawKey: second, rawValue: first };
  }
  if (isValidSubchunkKey(first, getContentTypeFromDBKey, getChunkKeyIndices)) {
    return { rawKey: first, rawValue: second };
  }
  return null;
}

function isValidSubchunkKey(value, getContentTypeFromDBKey, getChunkKeyIndices) {
  if (!Buffer.isBuffer(value)) {
    return false;
  }
  try {
    if (getContentTypeFromDBKey(value) !== SUBCHUNK_TYPE) {
      return false;
    }
    const indices = getChunkKeyIndices(value);
    return Number.isFinite(Number(indices.x)) && Number.isFinite(Number(indices.z));
  } catch {
    return false;
  }
}

function backoffMs(attempt) {
  return Math.min(120_000, 1000 * 2 ** (attempt - 1));
}
