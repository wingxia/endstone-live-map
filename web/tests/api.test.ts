import { describe, expect, it } from "vitest";

import { chunkUrl, textureAtlasUrl } from "../src/api";
import { fallbackTextureColor } from "../src/ui/chunkLayer";

describe("api helpers", () => {
  it("builds chunk query urls for the selected viewport", () => {
    expect(
      chunkUrl({
        world: "world",
        dimension: "Overworld",
        minChunkX: -1,
        maxChunkX: 1,
        minChunkZ: 0,
        maxChunkZ: 2,
      }),
    ).toBe("/api/chunks?world=world&dimension=Overworld&minChunkX=-1&maxChunkX=1&minChunkZ=0&maxChunkZ=2");
  });

  it("uses manifest atlas paths and deterministic fallback colors", () => {
    expect(textureAtlasUrl({ version: 1, tileSize: 16, atlas: "/textures/atlas.png", blocks: {} })).toBe("/textures/atlas.png");
    expect(fallbackTextureColor("minecraft:water")).toBe("#2563b8");
  });
});
