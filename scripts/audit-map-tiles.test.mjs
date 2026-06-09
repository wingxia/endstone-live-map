import assert from "node:assert/strict";
import { test } from "node:test";

import { mapTileCleanupKey, mapTileCleanupPrefix } from "./audit-map-tiles.mjs";

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
