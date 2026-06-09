import assert from "node:assert/strict";
import { test } from "node:test";

import { mapTileCleanupKey, mapTileCleanupPrefix, staleExactMapTileCleanupKeys } from "./audit-map-tiles.mjs";

test("map tile cleanup prefix is scoped to one world and dimension", () => {
  assert.equal(mapTileCleanupPrefix("Bedrock level", "Nether"), "map-tiles/v1/Bedrock_level/Nether/");
  assert.notEqual(mapTileCleanupPrefix("Bedrock level", "Nether"), "map-tiles/v1/");
});

test("map tile cleanup key targets a single image tile", () => {
  assert.equal(
    mapTileCleanupKey({ world: "Bedrock level", dimension: "Nether", zoom: -1, tileX: 4, tileZ: -2 }),
    "map-tiles/v1/Bedrock_level/Nether/z-1/4/-2.png",
  );
});

test("stale cleanup keeps expected rebuild tiles", () => {
  const expected = new Set([
    "map-tiles/v1/Bedrock_level/Nether/z4/0/0.png",
    "map-tiles/v1/Bedrock_level/Nether/z4/1/0.png",
  ]);
  assert.deepEqual(
    staleExactMapTileCleanupKeys(
      [
        "map-tiles/v1/Bedrock_level/Nether/z4/0/0.png",
        "map-tiles/v1/Bedrock_level/Nether/z4/1/0.png",
        "map-tiles/v1/Bedrock_level/Nether/z4/2/0.png",
        "map-tiles/v1/Bedrock_level/Overworld/z4/0/0.png",
      ],
      expected,
      { world: "Bedrock level", dimension: "Nether", zoom: 4, chunkRange: null },
    ),
    ["map-tiles/v1/Bedrock_level/Nether/z4/2/0.png"],
  );
});

test("stale cleanup is scoped to the requested chunk range", () => {
  const expected = new Set(["map-tiles/v1/Bedrock_level/Nether/z4/10/0.png"]);
  assert.deepEqual(
    staleExactMapTileCleanupKeys(
      [
        "map-tiles/v1/Bedrock_level/Nether/z4/10/0.png",
        "map-tiles/v1/Bedrock_level/Nether/z4/11/0.png",
        "map-tiles/v1/Bedrock_level/Nether/z4/12/0.png",
        "map-tiles/v1/Bedrock_level/Nether/z3/5/0.png",
      ],
      expected,
      {
        world: "Bedrock level",
        dimension: "Nether",
        zoom: 4,
        chunkRange: { minChunkX: 10, maxChunkX: 11, minChunkZ: 0, maxChunkZ: 0 },
      },
    ),
    ["map-tiles/v1/Bedrock_level/Nether/z4/11/0.png"],
  );
});
