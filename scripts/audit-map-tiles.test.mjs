import assert from "node:assert/strict";
import { test } from "node:test";

import { mapTileCleanupPrefix } from "./audit-map-tiles.mjs";

test("map tile cleanup prefix is scoped to one world and dimension", () => {
  assert.equal(mapTileCleanupPrefix("Bedrock level", "Nether"), "map-tiles/v1/Bedrock_level/Nether/");
  assert.notEqual(mapTileCleanupPrefix("Bedrock level", "Nether"), "map-tiles/v1/");
});
