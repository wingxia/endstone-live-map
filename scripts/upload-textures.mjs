#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const input = args.input ? path.resolve(args.input) : "";
const workerUrl = stripTrailingSlash(args["worker-url"] || process.env.WORKER_URL || "https://map.buhe.li");
const token = args.token || process.env.PLUGIN_TOKEN || "";

if (!input || !token) {
  console.error("Usage: node scripts/upload-textures.mjs --input <atlas-output-dir> --worker-url https://map.buhe.li --token <plugin token>");
  process.exit(2);
}

const [atlas, manifest, report] = await Promise.all([
  fs.readFile(path.join(input, "atlas.png")),
  readJson(path.join(input, "manifest.json")),
  readJson(path.join(input, "report.json")),
]);

const response = await fetch(`${workerUrl}/api/plugin/textures`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    atlas: atlas.toString("base64"),
    manifest,
    report,
  }),
});

if (!response.ok) {
  throw new Error(`Texture upload failed with ${response.status}: ${await response.text()}`);
}

console.log(JSON.stringify(await response.json(), null, 2));

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
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

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}
