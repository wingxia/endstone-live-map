#!/usr/bin/env node
import { createHash, createHmac } from "node:crypto";

const CONFIRMATION = "delete-map-data-v2";
const DEFAULT_PREFIXES = [
  "map-tiles/v1/",
  "chunks/v1/",
  "chunk-regions/v1/",
  "block-updates/v1/",
  "map-tile-dirty/v1/",
  "map-tile-backfill-jobs/v1/",
  "map-tile-backfill-queue/v1/",
  "map-tile-backfill-errors/v1/",
  "textures/v1/",
  "meta/v1/",
];
const PROTECTED_PREFIXES = ["lands/v1/", "markers/v1/", "map-tiles/v2/"];

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printUsage();
  process.exit(0);
}

const bucket = requiredOption("bucket", options.bucket || process.env.LIVE_MAP_R2_BUCKET);
const accountId = options.accountId || process.env.CLOUDFLARE_ACCOUNT_ID || process.env.LIVE_MAP_R2_ACCOUNT_ID || "";
const cfApiToken = options.cfApiToken || process.env.CLOUDFLARE_API_TOKEN || "";
const endpoint = options.endpoint || process.env.LIVE_MAP_R2_ENDPOINT || "";
const accessKeyId = process.env.LIVE_MAP_R2_ACCESS_KEY_ID || "";
const secretAccessKey = process.env.LIVE_MAP_R2_SECRET_ACCESS_KEY || "";
const region = options.region || process.env.LIVE_MAP_R2_REGION || "auto";
const dryRun = options.confirm !== CONFIRMATION;
const prefixes = selectedPrefixes(options);
const mode = cfApiToken ? "cloudflare-api" : "s3";

if (mode === "cloudflare-api") {
  requiredOption("account id", accountId);
} else {
  requiredOption("endpoint", endpoint);
  requiredOption("access key", accessKeyId);
  requiredOption("secret key", secretAccessKey);
}

console.log(`R2 cleanup target bucket=${bucket} mode=${mode}${endpoint ? ` endpoint=${endpoint}` : ""}`);
console.log(`Mode: ${dryRun ? "dry-run" : "DELETE"}${dryRun ? ` (add --confirm ${CONFIRMATION} to delete)` : ""}`);
console.log(`Prefixes: ${prefixes.join(", ")}`);

let matched = 0;
let deleted = 0;
let omittedLogKeys = 0;
const deleteKeys = [];
for (const prefix of prefixes) {
  for await (const key of listKeys({ accountId, cfApiToken, endpoint, bucket, region, accessKeyId, secretAccessKey, prefix, mode, requestTimeoutMs: options.requestTimeoutMs })) {
    if (isProtectedKey(key)) {
      continue;
    }
    matched += 1;
    if (matched <= options.maxLogKeys) {
      console.log(`${dryRun ? "would delete" : "delete"} ${key}`);
    } else {
      omittedLogKeys += 1;
    }
    if (!dryRun) {
      deleteKeys.push(key);
    }
  }
}
if (!dryRun) {
  deleted = await deleteMany({
    accountId,
    cfApiToken,
    endpoint,
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    keys: deleteKeys,
    mode,
    concurrency: options.deleteConcurrency,
    sleepMs: options.sleepMs,
    progressEvery: options.progressEvery,
    retries: options.retries,
    requestTimeoutMs: options.requestTimeoutMs,
  });
}
if (omittedLogKeys > 0) {
  console.log(`omitted ${omittedLogKeys} matching key log line(s)`);
}
console.log(JSON.stringify({ ok: true, dryRun, matched, deleted, omittedLogKeys, prefixes }, null, 2));

function parseArgs(args) {
  const out = { prefixes: [], sleepMs: 0, maxLogKeys: 100, deleteConcurrency: 1, progressEvery: 250, retries: 4, requestTimeoutMs: 30000 };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--endpoint") out.endpoint = args[++index];
    else if (arg === "--bucket") out.bucket = args[++index];
    else if (arg === "--account-id") out.accountId = args[++index];
    else if (arg === "--cf-api-token") out.cfApiToken = args[++index];
    else if (arg === "--region") out.region = args[++index];
    else if (arg === "--prefix") out.prefixes.push(args[++index]);
    else if (arg === "--confirm") out.confirm = args[++index];
    else if (arg === "--sleep-ms") out.sleepMs = Math.max(0, Number(args[++index] || 0));
    else if (arg === "--max-log-keys") out.maxLogKeys = Math.max(0, Number(args[++index] || 0));
    else if (arg === "--delete-concurrency") out.deleteConcurrency = Math.max(1, Number(args[++index] || 1));
    else if (arg === "--progress-every") out.progressEvery = Math.max(0, Number(args[++index] || 0));
    else if (arg === "--retries") out.retries = Math.max(0, Number(args[++index] || 0));
    else if (arg === "--request-timeout-ms") out.requestTimeoutMs = Math.max(1000, Number(args[++index] || 30000));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function selectedPrefixes(options) {
  const prefixes = options.prefixes.length > 0 ? options.prefixes : [...DEFAULT_PREFIXES];
  for (const prefix of prefixes) {
    if (!DEFAULT_PREFIXES.includes(prefix)) {
      throw new Error(`Refusing cleanup prefix outside map-data scope: ${prefix}`);
    }
    if (PROTECTED_PREFIXES.some((protectedPrefix) => prefix.startsWith(protectedPrefix))) {
      throw new Error(`Refusing protected prefix: ${prefix}`);
    }
  }
  return prefixes;
}

async function* listKeys(input) {
  if (input.mode === "cloudflare-api") {
    yield* listKeysWithCloudflareApi(input);
    return;
  }
  yield* listKeysWithS3Api(input);
}

async function* listKeysWithCloudflareApi(input) {
  let cursor = "";
  do {
    const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${input.accountId}/r2/buckets/${input.bucket}/objects`);
    url.searchParams.set("prefix", input.prefix);
    url.searchParams.set("per_page", "1000");
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }
    const response = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${input.cfApiToken}` } }, input.requestTimeoutMs);
    const body = await response.json();
    if (!response.ok || !body.success) {
      throw new Error(`List failed for ${input.prefix}: HTTP ${response.status} ${JSON.stringify(body.errors || body)}`);
    }
    for (const object of body.result || []) {
      yield object.key;
    }
    cursor = body.result_info?.is_truncated ? body.result_info?.cursor || "" : "";
  } while (cursor);
}

async function* listKeysWithS3Api(input) {
  let continuationToken = "";
  do {
    const query = {
      "list-type": "2",
      "max-keys": "1000",
      prefix: input.prefix,
    };
    if (continuationToken) {
      query["continuation-token"] = continuationToken;
    }
    const response = await signedFetch({ ...input, method: "GET", key: "", query });
    if (!response.ok) {
      throw new Error(`List failed for ${input.prefix}: HTTP ${response.status} ${await response.text()}`);
    }
    const xml = await response.text();
    for (const key of [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((match) => decodeXml(match[1]))) {
      yield key;
    }
    const tokenMatch = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
    continuationToken = tokenMatch ? decodeXml(tokenMatch[1]) : "";
  } while (continuationToken);
}

async function deleteKey(input) {
  for (let attempt = 0; attempt <= input.retries; attempt += 1) {
    try {
      const response =
        input.mode === "cloudflare-api"
          ? await fetchWithTimeout(
              `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/r2/buckets/${input.bucket}/objects/${encodePath(input.key)}`,
              { method: "DELETE", headers: { Authorization: `Bearer ${input.cfApiToken}` } },
              input.requestTimeoutMs,
            )
          : await signedFetch({ ...input, method: "DELETE", query: {} });
      if (response.ok || response.status === 404) {
        return;
      }
      const body = await response.text();
      if (attempt < input.retries && (response.status === 429 || response.status >= 500)) {
        const retryAfter = Number(response.headers.get("retry-after") || 0);
        await sleep(retryAfter > 0 ? retryAfter * 1000 : Math.min(30000, 1000 * 2 ** attempt));
        continue;
      }
      throw new Error(`Delete failed for ${input.key}: HTTP ${response.status} ${body}`);
    } catch (error) {
      if (attempt < input.retries) {
        await sleep(Math.min(30000, 1000 * 2 ** attempt));
        continue;
      }
      throw error;
    }
  }
}

async function deleteMany(input) {
  let index = 0;
  let deleted = 0;
  const startedAt = Date.now();
  async function worker() {
    while (true) {
      const keyIndex = index;
      index += 1;
      if (keyIndex >= input.keys.length) {
        return;
      }
      await deleteKey({ ...input, key: input.keys[keyIndex] });
      deleted += 1;
      if (input.progressEvery > 0 && deleted % input.progressEvery === 0) {
        const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        console.log(`deleted ${deleted}/${input.keys.length} (${Math.round(deleted / seconds)}/s)`);
      }
      if (input.sleepMs > 0) {
        await sleep(input.sleepMs);
      }
    }
  }
  const workers = Array.from({ length: Math.min(input.concurrency, input.keys.length) }, () => worker());
  await Promise.all(workers);
  return deleted;
}

async function signedFetch(input) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex("");
  const host = hostFromEndpoint(input.endpoint);
  const canonicalUri = `/${encodePath(input.bucket)}${input.key ? `/${encodePath(input.key)}` : ""}`;
  const canonicalQuery = canonicalQueryString(input.query || {});
  const headers = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name]}\n`)
    .join("");
  const canonicalRequest = [input.method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, dateStamp), input.region), "s3"), "aws4_request");
  const signature = hmac(signingKey, stringToSign, "hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const url = `${input.endpoint.replace(/\/+$/, "")}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
  return fetchWithTimeout(url, {
    method: input.method,
    headers: {
      Authorization: authorization,
      Host: host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    },
  }, input.requestTimeoutMs || 30000);
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function canonicalQueryString(query) {
  return Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== "")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${awsEncode(key)}=${awsEncode(String(value))}`)
    .join("&");
}

function encodePath(value) {
  return String(value)
    .split("/")
    .map(awsEncode)
    .join("/");
}

function awsEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function hostFromEndpoint(endpoint) {
  return new URL(endpoint).host.toLowerCase();
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key, value, encoding) {
  return createHmac("sha256", key).update(value).digest(encoding);
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function isProtectedKey(key) {
  return PROTECTED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function requiredOption(name, value) {
  if (!value) {
    throw new Error(`Missing ${name}. See --help.`);
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printUsage() {
  console.log(`Usage:
  CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \\
  npm run cleanup:r2 -- --bucket <bucket>

  or

  LIVE_MAP_R2_ACCESS_KEY_ID=... LIVE_MAP_R2_SECRET_ACCESS_KEY=... \\
  npm run cleanup:r2 -- --endpoint https://<account>.r2.cloudflarestorage.com --bucket <bucket>

Options:
  --endpoint <url>      R2 S3 endpoint, or LIVE_MAP_R2_ENDPOINT
  --bucket <name>       R2 bucket, or LIVE_MAP_R2_BUCKET
  --account-id <id>     Cloudflare account id, or CLOUDFLARE_ACCOUNT_ID
  --cf-api-token <tok>  Cloudflare API token, or CLOUDFLARE_API_TOKEN
  --region <region>     Signing region, defaults to auto
  --prefix <prefix>     Cleanup one allowed prefix instead of defaults
  --confirm ${CONFIRMATION}
                       Required for destructive deletion; otherwise dry-run
  --sleep-ms <n>        Delay between DELETE requests
  --delete-concurrency <n>
                       Number of parallel DELETE workers; default 1
  --progress-every <n>  Print progress after every n deleted keys; default 250
  --retries <n>         Retries for 429/5xx DELETE failures; default 4
  --request-timeout-ms <n>
                       Per-request timeout; default 30000
  --max-log-keys <n>    Print only the first n matching keys; default 100

Default cleanup deletes old map/tile/chunk/texture/meta prefixes and preserves lands/v1/, markers/v1/, and map-tiles/v2/.`);
}
