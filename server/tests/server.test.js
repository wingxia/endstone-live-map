import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { cleanSegment, createLiveMapServer } from "../src/index.js";

describe("local live map server", () => {
  let tmp;
  let server;
  let serverState;
  let baseUrl;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "livemap-server-"));
    const created = createLiveMapServer({ dataDir: tmp, pluginToken: "secret", webDir: tmp });
    server = created.server;
    serverState = created.state;
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await closeServer(server);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("normalizes path segments like the plugin", () => {
    expect(cleanSegment("Bedrock level")).toBe("Bedrock_level");
  });

  it("keeps reverse-proxy origin connections open beyond the tunnel idle window", () => {
    expect(server.keepAliveTimeout).toBe(95_000);
    expect(server.headersTimeout).toBe(100_000);
    expect(server.requestTimeout).toBe(60_000);
  });

  it("completes the WebSocket close handshake and releases the client socket", async () => {
    const socket = new WebSocket(`${baseUrl.replace("http://", "ws://")}/api/live`);
    try {
      await withTimeout(new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", () => reject(new Error("WebSocket failed to open")), { once: true });
      }), 1_000);

      const closed = new Promise((resolve) => {
        socket.addEventListener("close", resolve, { once: true });
      });
      socket.close(1000, "done");
      const event = await withTimeout(closed, 1_000);
      expect(event.code).toBe(1000);
      expect(event.reason).toBe("done");
      expect(serverState.sockets.size).toBe(0);
    } finally {
      for (const client of serverState.sockets) {
        client.destroy();
      }
    }
  });

  it("serves the app shell uncached and immutable hashed assets with compressed conditional responses", async () => {
    const assetDir = path.join(tmp, "assets");
    await fs.mkdir(assetDir, { recursive: true });
    await fs.writeFile(path.join(tmp, "index.html"), "<!doctype html><main>map</main>");
    await fs.writeFile(path.join(assetDir, "app-deadbeef.js"), "export const ready = true;");
    const largeAsset = `export const payload = ${JSON.stringify("map-tile-".repeat(1_024))};`;
    await fs.writeFile(path.join(assetDir, "large-deadbeef.js"), largeAsset);

    const shell = await fetch(`${baseUrl}/`, { headers: { Connection: "close" } });
    expect(shell.status).toBe(200);
    expect(shell.headers.get("cache-control")).toBe("no-cache");
    expect(shell.headers.get("content-length")).toBe(String(Buffer.byteLength("<!doctype html><main>map</main>")));
    await shell.text();

    const asset = await fetch(`${baseUrl}/assets/app-deadbeef.js`, { headers: { Connection: "close" } });
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(asset.headers.get("content-length")).toBe(String(Buffer.byteLength("export const ready = true;")));
    await asset.text();

    const identity = await fetch(`${baseUrl}/assets/large-deadbeef.js`, {
      headers: { "Accept-Encoding": "identity", Connection: "close" },
    });
    expect(identity.headers.get("content-encoding")).toBeNull();
    expect(identity.headers.get("content-length")).toBe(String(Buffer.byteLength(largeAsset)));
    await expect(identity.text()).resolves.toBe(largeAsset);

    const compressed = await fetch(`${baseUrl}/assets/large-deadbeef.js`, {
      headers: { "Accept-Encoding": "br", Connection: "close" },
    });
    expect(compressed.headers.get("content-encoding")).toBe("br");
    expect(compressed.headers.get("vary")).toBe("Accept-Encoding");
    expect(Number(compressed.headers.get("content-length"))).toBeLessThan(Buffer.byteLength(largeAsset));
    const compressedEtag = compressed.headers.get("etag");
    expect(compressedEtag).toBeTruthy();
    await expect(compressed.text()).resolves.toBe(largeAsset);

    const notModified = await fetch(`${baseUrl}/assets/large-deadbeef.js`, {
      headers: { "Accept-Encoding": "br", "If-None-Match": compressedEtag, Connection: "close" },
    });
    expect(notModified.status).toBe(304);
  });

  it("embeds XSS-safe world metadata in the app shell to remove a blocking API round trip", async () => {
    const world = "</script><script>alert('map')</script>";
    await fs.writeFile(
      path.join(tmp, "index.html"),
      '<!doctype html><script id="endstone-live-map-bootstrap" type="application/json">__ENDSTONE_LIVE_MAP_BOOTSTRAP__</script>',
    );
    const update = await fetch(`${baseUrl}/api/plugin/tiles`, {
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "tiles_ready",
        updatedAt: 10,
        chunks: [{ world, dimension: "Overworld", chunkX: 0, chunkZ: 0, updatedAt: 10 }],
      }),
    });
    expect(update.status).toBe(200);

    const response = await fetch(`${baseUrl}/`, { headers: { "Accept-Encoding": "identity" } });
    const html = await response.text();
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(html).not.toContain("__ENDSTONE_LIVE_MAP_BOOTSTRAP__");
    expect(html).not.toContain(world);
    expect(html).toContain("\\u003c/script>");
    expect(JSON.parse(html.match(/type="application\/json">([^<]*)<\/script>/)?.[1] || "{}").worlds[0]).toMatchObject({
      world,
      dimension: "Overworld",
      chunkCount: 1,
    });
  });

  it("advertises the generated low-zoom tile floor", async () => {
    const response = await fetch(`${baseUrl}/api/config`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      tileSize: 256,
      minZoom: -8,
      nativeMinZoom: -8,
      maxZoom: 4,
    });
  });

  it("omits legacy world records that have no rendered chunks or bounds", async () => {
    await fs.writeFile(
      path.join(tmp, "state.json"),
      JSON.stringify({
        version: 2,
        worlds: {
          "Bedrock_level/Overworld": {
            world: "Bedrock level",
            dimension: "Overworld",
            importedAt: 1,
            updatedAt: 1,
            bounds: null,
            chunks: {},
          },
        },
      }),
    );
    const response = await fetch(`${baseUrl}/api/worlds`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ worlds: [] });
  });

  it("protects plugin endpoints with the configured token", async () => {
    const unauthorized = await fetch(`${baseUrl}/api/plugin/tiles`, { method: "POST", body: "{}" });
    expect(unauthorized.status).toBe(401);

    const response = await fetch(`${baseUrl}/api/plugin/tiles`, {
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "tiles_ready",
        updatedAt: 10,
        chunks: [{ world: "Bedrock level", dimension: "Overworld", chunkX: -1, chunkZ: 2, updatedAt: 10 }],
      }),
    });
    expect(response.status).toBe(200);

    const worlds = await (await fetch(`${baseUrl}/api/worlds`)).json();
    expect(worlds.worlds[0]).toMatchObject({
      world: "Bedrock level",
      dimension: "Overworld",
      chunkCount: 1,
    });
    expect(worlds.worlds[0].bounds).toMatchObject({ minChunkX: -1, maxChunkZ: 2 });
  });

  it("rejects oversized plugin payloads without exhausting server memory", async () => {
    serverState.maxJsonBodyBytes = 64;
    const response = await fetch(`${baseUrl}/api/plugin/live`, {
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ players: [{ id: "x".repeat(128) }] }),
    });
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "payload_too_large" });
    await expect((await fetch(`${baseUrl}/api/health`)).json()).resolves.toMatchObject({ ok: true });
  });

  it("indexes complete world bounds from existing z4 tile files", async () => {
    const legacyState = JSON.stringify({
      version: 2,
      worlds: {
        "Bedrock_level/Overworld": {
          world: "Bedrock level",
          dimension: "Overworld",
          importedAt: 5,
          updatedAt: 10,
          bounds: null,
          chunks: { "0,0": 10 },
        },
      },
    });
    await fs.writeFile(path.join(tmp, "state.json"), legacyState);
    for (const [dimension, chunkX, chunkZ] of [
      ["Overworld", 0, 0],
      ["Overworld", 64, -3],
      ["Nether", -2, 5],
      ["TheEnd", 7, 9],
    ]) {
      const tile = path.join(tmp, "tiles", "Bedrock_level", dimension, "z4", String(chunkX), `${chunkZ}.png`);
      await fs.mkdir(path.dirname(tile), { recursive: true });
      await fs.writeFile(tile, Buffer.from([1, 2, 3]));
    }

    const response = await fetch(`${baseUrl}/api/worlds`);
    expect(response.status).toBe(200);
    const { worlds } = await response.json();
    expect(worlds).toHaveLength(3);
    expect(worlds[0]).toMatchObject({
      world: "Bedrock level",
      dimension: "Overworld",
      chunkCount: 2,
      bounds: { minChunkX: 0, maxChunkX: 64, minChunkZ: -3, maxChunkZ: 0 },
    });
    expect(worlds[0].sampleChunks).toEqual(expect.arrayContaining([{ chunkX: 0, chunkZ: 0 }, { chunkX: 64, chunkZ: -3 }]));
    expect(worlds[1]).toMatchObject({ world: "Bedrock level", dimension: "Nether", chunkCount: 1 });
    expect(worlds[2]).toMatchObject({ world: "Bedrock level", dimension: "TheEnd", chunkCount: 1 });

    const persistedIndex = JSON.parse(await fs.readFile(path.join(tmp, "world-index-v1.json"), "utf8"));
    expect(persistedIndex.version).toBe(1);
    expect(persistedIndex.worlds).toHaveLength(3);
    expect(persistedIndex.worlds[0]).toMatchObject({
      world: "Bedrock level",
      dimension: "Overworld",
      chunkCount: 2,
      bounds: { minChunkX: 0, maxChunkX: 64, minChunkZ: -3, maxChunkZ: 0 },
    });
    expect(persistedIndex.worlds[0].sampleChunks).toEqual(
      expect.arrayContaining([{ chunkX: 0, chunkZ: 0 }, { chunkX: 64, chunkZ: -3 }]),
    );
    expect(persistedIndex.worlds[0]).not.toHaveProperty("chunks");
    expect(await fs.readFile(path.join(tmp, "state.json"), "utf8")).toBe(legacyState);

    await closeServer(server);
    await fs.rm(path.join(tmp, "tiles"), { recursive: true, force: true });
    const restarted = createLiveMapServer({ dataDir: tmp, pluginToken: "secret", webDir: tmp });
    server = restarted.server;
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    const restartedWorlds = await (await fetch(`${baseUrl}/api/worlds`)).json();
    expect(restartedWorlds.worlds).toEqual(worlds);
  });

  it("serializes compact index updates and keeps duplicate chunks stable across restart", async () => {
    const postChunks = (updatedAt, chunks) => fetch(`${baseUrl}/api/plugin/tiles`, {
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ type: "tiles_ready", updatedAt, chunks }),
    });
    const duplicate = { world: "Bedrock level", dimension: "Overworld", chunkX: 5, chunkZ: 8 };
    const responses = await Promise.all([
      postChunks(10, [{ ...duplicate, updatedAt: 10 }, { ...duplicate, updatedAt: 10 }]),
      postChunks(12, [{ ...duplicate, updatedAt: 12 }]),
      postChunks(11, [
        { world: "Bedrock level", dimension: "Overworld", chunkX: 5, chunkZ: 9, updatedAt: 11 },
      ]),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);

    const firstWorlds = await (await fetch(`${baseUrl}/api/worlds`)).json();
    expect(firstWorlds.worlds).toHaveLength(1);
    expect(firstWorlds.worlds[0]).toMatchObject({
      world: "Bedrock level",
      dimension: "Overworld",
      chunkCount: 2,
      updatedAt: 12,
      bounds: { minChunkX: 5, maxChunkX: 5, minChunkZ: 8, maxChunkZ: 9 },
    });
    expect(firstWorlds.worlds[0].sampleChunks).toEqual([
      { chunkX: 5, chunkZ: 8 },
      { chunkX: 5, chunkZ: 9 },
    ]);

    const persistedIndex = JSON.parse(await fs.readFile(path.join(tmp, "world-index-v1.json"), "utf8"));
    expect(persistedIndex.worlds[0]).toMatchObject({
      chunkCount: 2,
      chunkRows: [[5, 8, 9]],
    });
    await expect(fs.access(path.join(tmp, "state.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.readdir(tmp)).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    await closeServer(server);
    const restarted = createLiveMapServer({ dataDir: tmp, pluginToken: "secret", webDir: tmp });
    server = restarted.server;
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    const restartedWorlds = await (await fetch(`${baseUrl}/api/worlds`)).json();
    expect(restartedWorlds).toEqual(firstWorlds);
  });

  it("stores and returns lands by world and dimension", async () => {
    const claim = {
      id: "spawn",
      owner: "Wing",
      name: "主城",
      world: "Bedrock level",
      dimension: "Overworld",
      publicTeleport: true,
      updatedAt: 5,
    };
    const response = await fetch(`${baseUrl}/api/plugin/lands`, {
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ claims: [claim] }),
    });
    expect(response.status).toBe(200);

    const lands = await (await fetch(`${baseUrl}/api/lands?world=Bedrock+level&dimension=Overworld`)).json();
    expect(lands.claims).toEqual([claim]);

    const unchanged = await fetch(`${baseUrl}/api/plugin/lands`, {
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ claims: [{ ...claim, updatedAt: 999 }] }),
    });
    await expect(unchanged.json()).resolves.toMatchObject({ ok: true, claims: 1, worlds: 0 });
    const afterUnchanged = await (await fetch(`${baseUrl}/api/lands?world=Bedrock+level&dimension=Overworld`)).json();
    expect(afterUnchanged).toEqual(lands);

    const cleared = await fetch(`${baseUrl}/api/plugin/lands`, {
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ world: "Bedrock level", dimensions: ["Overworld"], claims: [] }),
    });
    await expect(cleared.json()).resolves.toMatchObject({ ok: true, claims: 0, worlds: 1 });
    const afterClear = await (await fetch(`${baseUrl}/api/lands?world=Bedrock+level&dimension=Overworld`)).json();
    expect(afterClear.claims).toEqual([]);
    expect(afterClear.updatedAt).toBeGreaterThan(lands.updatedAt);
  });

  it("serves mutable map tiles with revalidation and safely caches versioned placeholders", async () => {
    const tileFile = path.join(tmp, "tiles", "Bedrock_level", "Overworld", "z4", "0", "0.png");
    await fs.mkdir(path.dirname(tileFile), { recursive: true });
    await fs.writeFile(tileFile, Buffer.from([1, 2, 3]));

    const existing = await fetch(`${baseUrl}/api/local-map-tiles/Bedrock_level/Overworld/z4/0/0.png`);
    expect(existing.status).toBe(200);
    expect(existing.headers.get("content-type")).toContain("image/png");
    expect(existing.headers.get("cache-control")).toBe("public, no-cache");
    expect(existing.headers.get("cloudflare-cdn-cache-control")).toBe(
      "public, max-age=60, stale-while-revalidate=86400, stale-if-error=86400",
    );
    expect(existing.headers.get("content-length")).toBe("3");
    expect(existing.headers.get("etag")).toBeTruthy();
    expect(Buffer.from(await existing.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));

    const revalidated = await fetch(`${baseUrl}/api/local-map-tiles/Bedrock_level/Overworld/z4/0/0.png`, {
      headers: { "If-None-Match": existing.headers.get("etag") },
    });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("cloudflare-cdn-cache-control")).toBe(
      "public, max-age=60, stale-while-revalidate=86400, stale-if-error=86400",
    );

    const versioned = await fetch(`${baseUrl}/api/local-map-tiles/Bedrock_level/Overworld/z4/0/0.png?_=123`);
    expect(versioned.status).toBe(200);
    expect(versioned.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(versioned.headers.get("cloudflare-cdn-cache-control")).toBe("public, max-age=31536000, immutable");
    expect(versioned.headers.get("etag")).toBeTruthy();

    const legacyPath = await fetch(`${baseUrl}/api/map-tiles/Bedrock_level/Overworld/z4/0/0.png`);
    expect(legacyPath.status).toBe(200);

    const missing = await fetch(`${baseUrl}/api/local-map-tiles/Bedrock_level/Overworld/z4/9/9.png`);
    expect(missing.status).toBe(200);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(missing.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");

    const versionedMissing = await fetch(`${baseUrl}/api/local-map-tiles/Bedrock_level/Overworld/z4/9/9.png?_=123`);
    expect(versionedMissing.status).toBe(200);
    expect(versionedMissing.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(versionedMissing.headers.get("cloudflare-cdn-cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("serves versioned PNG tiles at every configured zoom from -8 through 4", async () => {
    for (let zoom = -8; zoom <= 4; zoom += 1) {
      const tileFile = path.join(tmp, "tiles", "Bedrock_level", "Overworld", `z${zoom}`, "0", "0.png");
      const tileBytes = Buffer.from([zoom + 8, 4 - zoom]);
      await fs.mkdir(path.dirname(tileFile), { recursive: true });
      await fs.writeFile(tileFile, tileBytes);

      const response = await fetch(
        `${baseUrl}/api/local-map-tiles/Bedrock_level/Overworld/z${zoom}/0/0.png?_=zoom-test`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(tileBytes);
    }
  });

  it("keeps versioned tiles in a bounded memory cache and briefly suppresses missing-tile probes", async () => {
    const tileFile = path.join(tmp, "tiles", "Bedrock_level", "Overworld", "z4", "2", "3.png");
    await fs.mkdir(path.dirname(tileFile), { recursive: true });
    await fs.writeFile(tileFile, Buffer.from([1, 2, 3]));

    const first = await fetch(`${baseUrl}/api/local-map-tiles/Bedrock_level/Overworld/z4/2/3.png?_=10`);
    expect(Buffer.from(await first.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));
    expect(serverState.tileCache.size).toBe(1);
    expect(serverState.tileCacheBytes).toBe(3);

    await fs.writeFile(tileFile, Buffer.from([4, 5, 6, 7]));
    const sameVersion = await fetch(`${baseUrl}/api/local-map-tiles/Bedrock_level/Overworld/z4/2/3.png?_=10`);
    expect(Buffer.from(await sameVersion.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));

    const nextVersion = await fetch(`${baseUrl}/api/local-map-tiles/Bedrock_level/Overworld/z4/2/3.png?_=11`);
    expect(Buffer.from(await nextVersion.arrayBuffer())).toEqual(Buffer.from([4, 5, 6, 7]));
    expect(serverState.tileCache.size).toBe(2);
    expect(serverState.tileCacheBytes).toBe(7);
    const health = await (await fetch(`${baseUrl}/api/health`)).json();
    expect(health.caches.tiles).toMatchObject({ entries: 2, bytes: 7, maxBytes: 64 * 1024 * 1024 });

    serverState.missingTileCacheMs = 20;
    const missingFile = path.join(tmp, "tiles", "Bedrock_level", "Overworld", "z4", "8", "9.png");
    const missingUrl = `${baseUrl}/api/local-map-tiles/Bedrock_level/Overworld/z4/8/9.png`;
    const missing = await fetch(missingUrl);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(serverState.missingTileCache.size).toBe(1);

    await fs.mkdir(path.dirname(missingFile), { recursive: true });
    await fs.writeFile(missingFile, Buffer.from([8, 9]));
    const dampened = await fetch(missingUrl);
    expect(Buffer.from(await dampened.arrayBuffer())).not.toEqual(Buffer.from([8, 9]));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const available = await fetch(missingUrl);
    expect(Buffer.from(await available.arrayBuffer())).toEqual(Buffer.from([8, 9]));
  });

  it("caches player avatars from plugin snapshots and serves lightweight player state", async () => {
    const avatarPngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII=";
    const bytes = Buffer.from(avatarPngBase64, "base64");
    const avatarHash = createHash("sha256").update(bytes).digest("hex");
    const response = await fetch(`${baseUrl}/api/plugin/live`, {
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({
        players: [
          {
            id: "uuid/unsafe",
            name: "Wing",
            xuid: "xuid-1",
            world: "Bedrock level",
            dimension: "Overworld",
            x: 12,
            y: 64,
            z: -8,
            yaw: 90,
            pitch: 0,
            avatarHash,
            avatarPngBase64,
            updatedAt: 10,
          },
        ],
      }),
    });
    expect(response.status).toBe(200);

    const players = await (await fetch(`${baseUrl}/api/players`)).json();
    expect(players.players[0]).toMatchObject({
      id: "uuid/unsafe",
      name: "Wing",
      xuid: "xuid-1",
      avatarHash,
      avatarUrl: `/api/players/${encodeURIComponent("uuid/unsafe")}/avatar.png?_=${avatarHash}`,
    });
    expect(players.players[0].avatarPngBase64).toBeUndefined();

    const avatar = await fetch(`${baseUrl}${players.players[0].avatarUrl}`);
    expect(avatar.status).toBe(200);
    expect(avatar.headers.get("content-type")).toContain("image/png");
    expect(Buffer.from(await avatar.arrayBuffer())).toEqual(bytes);
  });

  it("uses the Minecraft profile head for persona skins and caches it by skin key", async () => {
    const avatarPngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII=";
    const bytes = Buffer.from(avatarPngBase64, "base64");
    const avatarHash = createHash("sha256").update(bytes).digest("hex");
    const avatarProfileKey = "a".repeat(64);
    const requests = [];
    serverState.profileAvatarFetch = async (url, options) => {
      requests.push({ url, options });
      return new Response(bytes, {
        status: 200,
        headers: { "Content-Type": "image/png", "Content-Length": String(bytes.length) },
      });
    };
    const body = JSON.stringify({
      players: [{
        id: "persona-player",
        name: "Persona Player",
        xuid: "2535446414685408",
        world: "Bedrock level",
        dimension: "Overworld",
        avatarProfileKey,
      }],
    });

    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(`${baseUrl}/api/plugin/live`, {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body,
      });
      expect(response.status).toBe(200);
    }

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      "https://persona-secondary.franchise.minecraft-services.net/api/v1.0/profile/xuid/2535446414685408/image/head",
    );
    expect(requests[0].options.headers.Accept).toBe("image/png");
    const players = await (await fetch(`${baseUrl}/api/players`)).json();
    expect(players.players[0]).toMatchObject({
      id: "persona-player",
      avatarHash,
      avatarUrl: `/api/players/persona-player/avatar.png?_=${avatarHash}`,
    });
    expect(players.players[0].avatarProfileKey).toBeUndefined();
    const avatar = await fetch(`${baseUrl}${players.players[0].avatarUrl}`);
    expect(Buffer.from(await avatar.arrayBuffer())).toEqual(bytes);
  });

  it("expires a player snapshot when the plugin stops refreshing it", async () => {
    const created = createLiveMapServer({
      dataDir: tmp,
      pluginToken: "secret",
      webDir: tmp,
      playerStaleAfterMs: 1_000,
    });
    await new Promise((resolve) => created.server.listen(0, "127.0.0.1", resolve));
    const address = created.server.address();
    const staleBaseUrl = `http://127.0.0.1:${address.port}`;

    await fetch(`${staleBaseUrl}/api/plugin/live`, {
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ players: [{ id: "left", name: "Left Player" }] }),
    });
    expect((await (await fetch(`${staleBaseUrl}/api/players`)).json()).players).toHaveLength(1);

    created.state.playersReceivedAt -= 1_001;
    expect((await (await fetch(`${staleBaseUrl}/api/players`)).json()).players).toEqual([]);
    await closeServer(created.server);
  });
});

async function closeServer(server) {
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  await closed;
}

async function withTimeout(promise, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
