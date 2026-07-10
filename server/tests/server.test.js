import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { cleanSegment, createLiveMapServer } from "../src/index.js";

describe("local live map server", () => {
  let tmp;
  let server;
  let baseUrl;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "livemap-server-"));
    const created = createLiveMapServer({ dataDir: tmp, pluginToken: "secret", webDir: tmp });
    server = created.server;
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("normalizes path segments like the plugin", () => {
    expect(cleanSegment("Bedrock level")).toBe("Bedrock_level");
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

  it("indexes complete world bounds from existing z4 tile files", async () => {
    await fs.writeFile(
      path.join(tmp, "state.json"),
      JSON.stringify({
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
      }),
    );
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
  });

  it("serves mutable map tiles with revalidation and uncached placeholders", async () => {
    const tileFile = path.join(tmp, "tiles", "Bedrock_level", "Overworld", "z4", "0", "0.png");
    await fs.mkdir(path.dirname(tileFile), { recursive: true });
    await fs.writeFile(tileFile, Buffer.from([1, 2, 3]));

    const existing = await fetch(`${baseUrl}/api/local-map-tiles/Bedrock_level/Overworld/z4/0/0.png`);
    expect(existing.status).toBe(200);
    expect(existing.headers.get("content-type")).toContain("image/png");
    expect(existing.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(existing.headers.get("etag")).toBeTruthy();
    expect(Buffer.from(await existing.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));

    const revalidated = await fetch(`${baseUrl}/api/local-map-tiles/Bedrock_level/Overworld/z4/0/0.png`, {
      headers: { "If-None-Match": existing.headers.get("etag") },
    });
    expect(revalidated.status).toBe(304);

    const legacyPath = await fetch(`${baseUrl}/api/map-tiles/Bedrock_level/Overworld/z4/0/0.png`);
    expect(legacyPath.status).toBe(200);

    const missing = await fetch(`${baseUrl}/api/local-map-tiles/Bedrock_level/Overworld/z4/9/9.png`);
    expect(missing.status).toBe(200);
    expect(missing.headers.get("cache-control")).toBe("no-store");
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
});
