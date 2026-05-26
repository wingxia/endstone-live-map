import { expect, test, type Page, type Route } from "@playwright/test";

type TestChunk = {
  world: string;
  dimension: string;
  chunkX: number;
  chunkZ: number;
  palette: string[];
  blocks: number[];
  heights: number[];
  updatedAt: number;
};

type TestWorld = {
  version: number;
  world: string;
  dimension: string;
  status: string;
  chunkCount: number;
  importedAt: number;
  updatedAt: number;
  bounds: {
    minChunkX: number;
    maxChunkX: number;
    minChunkZ: number;
    maxChunkZ: number;
    minBlockX: number;
    maxBlockX: number;
    minBlockZ: number;
    maxBlockZ: number;
  };
  sampleChunks?: Array<{ chunkX: number; chunkZ: number }>;
  topBlocks: Record<string, number>;
};

const GRASS_TILE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAACvElEQVR4Ae3BAQGAMAACME4xozyaUTUI2859ny/ApAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZv35IwQ8yVSV2gAAAABJRU5ErkJggg==",
  "base64",
);
const EMPTY_TILE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4AWMAAQAABQABNtCI3QAAAABJRU5ErkJggg==",
  "base64",
);

test("loads the map application shell", async ({ page }) => {
  await page.route("**/api/live", async (route) => route.abort());
  await page.route("**/api/lands?**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ version: 1, world: "Bedrock level", dimension: "Overworld", claims: [], updatedAt: 0 }) });
  });
  await page.route("**/api/worlds", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        worlds: [
          {
            version: 1,
            world: "Bedrock level",
            dimension: "Overworld",
            status: "complete",
            chunkCount: 1,
            importedAt: 1,
            updatedAt: 1,
            bounds: {
              minChunkX: 0,
              maxChunkX: 0,
              minChunkZ: 0,
              maxChunkZ: 0,
              minBlockX: 0,
              maxBlockX: 15,
              minBlockZ: 0,
              maxBlockZ: 15,
            },
            topBlocks: { "minecraft:grass_block": 200 },
          },
        ],
      }),
    });
  });
  await page.route("**/api/chunks?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        chunks: [
          {
            world: "Bedrock level",
            dimension: "Overworld",
            chunkX: 0,
            chunkZ: 0,
            palette: ["minecraft:grass_block", "minecraft:water"],
            blocks: Array.from({ length: 256 }, (_, index) => (index % 7 === 0 ? 1 : 0)),
            heights: Array.from({ length: 256 }, () => 64),
            updatedAt: 1,
          },
        ],
        missing: [],
      }),
    });
  });
  await page.route("**/api/textures/manifest", async (route) => {
    await route.fulfill({ status: 404, body: "texture manifest not found" });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Endstone Live Map" })).toBeVisible();
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect(page.getByTestId("coordinate-hud")).toContainText("X 0, Z 0");
  await expect(page.getByTestId("coordinate-hud")).toContainText("区块");
  await expect(page.getByTestId("coordinate-hud")).toContainText("方块");
  await expect(page.getByLabel("地图状态")).toContainText("区块");
  await expect(page.getByLabel("地图状态")).toContainText("在线");
  await expect(page.getByLabel("地图状态")).toContainText("领地");
  await expect(page.getByRole("heading", { name: "在线玩家" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "领地标注" })).toBeVisible();
});

test("copies locked map coordinates as x, y, z values", async ({ page }) => {
  await mockBasicMap(page, {
    chunk: {
      world: "Bedrock level",
      dimension: "Overworld",
      chunkX: 0,
      chunkZ: 0,
      palette: ["minecraft:grass_block"],
      blocks: Array.from({ length: 256 }, () => 0),
      heights: Array.from({ length: 256 }, () => 65),
      updatedAt: 1,
    },
  });
  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await page.evaluate(() => {
    const values: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          values.push(text);
        },
      },
    });
    (window as unknown as { __copiedCoordinates: string[] }).__copiedCoordinates = values;
  });

  await page.mouse.click(150, 150);
  await page.getByTestId("coordinate-copy").click();

  const copied = await page.evaluate(() => (window as unknown as { __copiedCoordinates: string[] }).__copiedCoordinates.at(-1));
  expect(copied).toMatch(/^-?\d+, \d+, -?\d+$/);
  expect(copied).not.toContain("X");
  expect(copied).not.toContain("Y");
  expect(copied).not.toContain("Z");
  await expect(page.getByTestId("coordinate-copy")).toHaveAccessibleName(/已复制/);
});

test("keeps mobile portrait map controls compact and non-overlapping", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockBasicMap(page);
  await page.goto("/");

  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect(page.getByTestId("coordinate-copy")).toBeVisible();
  await expect(page.getByRole("tab", { name: /Overworld/ })).toBeVisible();
  const overlap = await elementsOverlap(page, ".map-hud", ".coordinate-hud");
  expect(overlap).toBe(false);
  const mapCoverage = await hudMapCoverage(page);
  expect(mapCoverage).toBeLessThan(0.26);
});

test("keeps mobile landscape hud clear of the main map view", async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await mockBasicMap(page);
  await page.goto("/");

  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect(page.getByTestId("coordinate-copy")).toBeVisible();
  await expect(page.getByRole("tab", { name: /Overworld/ })).toBeVisible();
  const overlap = await elementsOverlap(page, ".map-hud", ".coordinate-hud");
  expect(overlap).toBe(false);
  const mapCoverage = await hudMapCoverage(page);
  expect(mapCoverage).toBeLessThan(0.3);
});

test("does not request chunk data before a world import exists", async ({ page }) => {
  let chunkRequests = 0;

  await page.route("**/api/live", async (route) => route.abort());
  await page.route("**/api/lands?**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ version: 1, world: "Bedrock level", dimension: "Overworld", claims: [], updatedAt: 0 }) });
  });
  await page.route("**/api/worlds", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ worlds: [] }) });
  });
  await page.route("**/api/chunks?**", async (route) => {
    chunkRequests += 1;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ chunks: [], missing: [] }) });
  });
  await page.route("**/api/map-tiles/**", async (route) => {
    await route.fulfill({ status: 404, body: "tile not found" });
  });
  await page.route("**/api/textures/manifest", async (route) => {
    await route.fulfill({ status: 404, body: "texture manifest not found" });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Endstone Live Map" })).toBeVisible();
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect(page.getByTestId("map-empty-state")).toHaveCount(0);
  await expect(page.getByTestId("coordinate-hud")).toContainText("X 0, Z 0");
  await expect(page.getByTestId("coordinate-hud")).toContainText("未加载");
  await page.waitForTimeout(1000);
  expect(chunkRequests).toBe(0);
});

test("keeps negative-z chunks rendered across zoom changes", async ({ page }) => {
  const chunkQueries: Array<{ minChunkX: number; maxChunkX: number; minChunkZ: number; maxChunkZ: number }> = [];
  const targetChunk = {
    world: "Bedrock level",
    dimension: "Overworld",
    chunkX: 0,
    chunkZ: -1,
    palette: ["minecraft:grass_block"],
    blocks: Array.from({ length: 256 }, () => 0),
    heights: Array.from({ length: 256 }, () => 72),
    updatedAt: 1,
  };

  await page.route("**/api/live", async (route) => route.abort());
  await page.route("**/api/lands?**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ version: 1, world: "Bedrock level", dimension: "Overworld", claims: [], updatedAt: 0 }) });
  });
  await page.route("**/api/worlds", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        worlds: [
          {
            version: 1,
            world: "Bedrock level",
            dimension: "Overworld",
            status: "complete",
            chunkCount: 1,
            importedAt: 1,
            updatedAt: 1,
            bounds: {
              minChunkX: 0,
              maxChunkX: 0,
              minChunkZ: -1,
              maxChunkZ: -1,
              minBlockX: 0,
              maxBlockX: 15,
              minBlockZ: -16,
              maxBlockZ: -1,
            },
            topBlocks: { "minecraft:grass_block": 256 },
          },
        ],
      }),
    });
  });
  await page.route("**/api/chunks?**", async (route) => {
    const url = new URL(route.request().url());
    const query = {
      minChunkX: Number(url.searchParams.get("minChunkX")),
      maxChunkX: Number(url.searchParams.get("maxChunkX")),
      minChunkZ: Number(url.searchParams.get("minChunkZ")),
      maxChunkZ: Number(url.searchParams.get("maxChunkZ")),
    };
    chunkQueries.push(query);
    const includesTarget =
      query.minChunkX <= targetChunk.chunkX &&
      query.maxChunkX >= targetChunk.chunkX &&
      query.minChunkZ <= targetChunk.chunkZ &&
      query.maxChunkZ >= targetChunk.chunkZ;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ chunks: includesTarget ? [targetChunk] : [], missing: [] }),
    });
  });
  await page.route("**/api/map-tiles/**", async (route) => {
    await route.fulfill({ contentType: "image/png", body: GRASS_TILE_PNG });
  });
  await page.route("**/api/textures/manifest", async (route) => {
    await route.fulfill({ status: 404, body: "texture manifest not found" });
  });

  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect.poll(() => chunkQueries.some((query) => query.minChunkZ <= -1 && query.maxChunkZ >= -1)).toBe(true);
  await expect.poll(() => pageHasGrassPixels(page)).toBe(true);

  await page.getByRole("button", { name: "Zoom out" }).click();
  await expect.poll(() => pageHasGrassImageTile(page)).toBe(true);
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect.poll(() => pageHasGrassPixels(page)).toBe(true);
  expect(chunkQueries.some((query) => query.minChunkX <= 0 && query.maxChunkX >= 0 && query.minChunkZ <= -1 && query.maxChunkZ >= -1)).toBe(true);
});

test("keeps loaded chunks cached when panning away and back", async ({ page }) => {
  const chunkRequests = new Map<string, number>();
  const chunks = [
    {
      world: "Bedrock level",
      dimension: "Overworld",
      chunkX: 0,
      chunkZ: 0,
      palette: ["minecraft:grass_block"],
      blocks: Array.from({ length: 256 }, () => 0),
      heights: Array.from({ length: 256 }, () => 64),
      updatedAt: 1,
    },
    {
      world: "Bedrock level",
      dimension: "Overworld",
      chunkX: 3,
      chunkZ: 0,
      palette: ["minecraft:sand"],
      blocks: Array.from({ length: 256 }, () => 0),
      heights: Array.from({ length: 256 }, () => 64),
      updatedAt: 1,
    },
  ];

  await page.route("**/api/live", async (route) => route.abort());
  await page.route("**/api/lands?**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ version: 1, world: "Bedrock level", dimension: "Overworld", claims: [], updatedAt: 0 }) });
  });
  await page.route("**/api/worlds", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        worlds: [
          {
            version: 1,
            world: "Bedrock level",
            dimension: "Overworld",
            status: "complete",
            chunkCount: 2,
            importedAt: 1,
            updatedAt: 1,
            bounds: {
              minChunkX: 0,
              maxChunkX: 3,
              minChunkZ: 0,
              maxChunkZ: 0,
              minBlockX: 0,
              maxBlockX: 63,
              minBlockZ: 0,
              maxBlockZ: 15,
            },
            topBlocks: { "minecraft:grass_block": 256, "minecraft:sand": 256 },
          },
        ],
      }),
    });
  });
  await page.route("**/api/chunks?**", async (route) => {
    const url = new URL(route.request().url());
    const query = {
      minChunkX: Number(url.searchParams.get("minChunkX")),
      maxChunkX: Number(url.searchParams.get("maxChunkX")),
      minChunkZ: Number(url.searchParams.get("minChunkZ")),
      maxChunkZ: Number(url.searchParams.get("maxChunkZ")),
    };
    for (let chunkZ = query.minChunkZ; chunkZ <= query.maxChunkZ; chunkZ += 1) {
      for (let chunkX = query.minChunkX; chunkX <= query.maxChunkX; chunkX += 1) {
        const key = `${chunkX},${chunkZ}`;
        chunkRequests.set(key, (chunkRequests.get(key) || 0) + 1);
      }
    }
    const responseChunks = chunks.filter(
      (chunk) =>
        chunk.chunkX >= query.minChunkX &&
        chunk.chunkX <= query.maxChunkX &&
        chunk.chunkZ >= query.minChunkZ &&
        chunk.chunkZ <= query.maxChunkZ,
    );
    const missing: Array<{ chunkX: number; chunkZ: number }> = [];
    for (let chunkZ = query.minChunkZ; chunkZ <= query.maxChunkZ; chunkZ += 1) {
      for (let chunkX = query.minChunkX; chunkX <= query.maxChunkX; chunkX += 1) {
        if (!responseChunks.some((chunk) => chunk.chunkX === chunkX && chunk.chunkZ === chunkZ)) {
          missing.push({ chunkX, chunkZ });
        }
      }
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ chunks: responseChunks, missing }) });
  });
  await page.route("**/api/textures/manifest", async (route) => {
    await route.fulfill({ status: 404, body: "texture manifest not found" });
  });

  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect.poll(() => chunkRequests.get("0,0") || 0).toBe(1);
  await expect.poll(() => pageHasGrassPixels(page)).toBe(true);

  await dragMap(page, 700, 300, 60, 300);
  await expect.poll(() => chunkRequests.get("3,0") || 0).toBeGreaterThan(0);
  await dragMap(page, 60, 300, 700, 300);
  await expect.poll(() => pageHasGrassPixels(page)).toBe(true);
  await page.waitForTimeout(500);
  expect(chunkRequests.get("0,0") || 0).toBe(1);
});

test("renders visible chunks progressively before slow neighboring chunk requests finish", async ({ page }) => {
  let slowRequestCount = 0;
  const grassChunk = {
    world: "Bedrock level",
    dimension: "Overworld",
    chunkX: 8,
    chunkZ: 8,
    palette: ["minecraft:grass_block"],
    blocks: Array.from({ length: 256 }, () => 0),
    heights: Array.from({ length: 256 }, () => 64),
    updatedAt: 1,
  };

  await page.route("**/api/live", async (route) => route.abort());
  await page.route("**/api/lands?**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ version: 1, world: "Bedrock level", dimension: "Overworld", claims: [], updatedAt: 0 }) });
  });
  await page.route("**/api/worlds", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        worlds: [
          {
            version: 1,
            world: "Bedrock level",
            dimension: "Overworld",
            status: "complete",
            chunkCount: 257,
            importedAt: 1,
            updatedAt: 1,
            bounds: {
              minChunkX: 0,
              maxChunkX: 16,
              minChunkZ: 0,
              maxChunkZ: 16,
              minBlockX: 0,
              maxBlockX: 271,
              minBlockZ: 0,
              maxBlockZ: 271,
            },
            topBlocks: { "minecraft:grass_block": 256 },
          },
        ],
      }),
    });
  });
  await page.route("**/api/chunks?**", async (route) => {
    const url = new URL(route.request().url());
    const minChunkX = Number(url.searchParams.get("minChunkX"));
    const maxChunkX = Number(url.searchParams.get("maxChunkX"));
    const minChunkZ = Number(url.searchParams.get("minChunkZ"));
    const maxChunkZ = Number(url.searchParams.get("maxChunkZ"));
    const includesGrass = minChunkX <= grassChunk.chunkX && maxChunkX >= grassChunk.chunkX && minChunkZ <= grassChunk.chunkZ && maxChunkZ >= grassChunk.chunkZ;
    const isNeighboringRequest =
      !includesGrass &&
      minChunkX >= grassChunk.chunkX - 4 &&
      maxChunkX <= grassChunk.chunkX + 4 &&
      minChunkZ >= grassChunk.chunkZ - 4 &&
      maxChunkZ <= grassChunk.chunkZ + 4;
    if (isNeighboringRequest) {
      slowRequestCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
    const chunks = includesGrass ? [grassChunk] : [];
    const missing: Array<{ chunkX: number; chunkZ: number }> = [];
    for (let chunkZ = minChunkZ; chunkZ <= maxChunkZ; chunkZ += 1) {
      for (let chunkX = minChunkX; chunkX <= maxChunkX; chunkX += 1) {
        if (!chunks.some((chunk) => chunk.chunkX === chunkX && chunk.chunkZ === chunkZ)) {
          missing.push({ chunkX, chunkZ });
        }
      }
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ chunks, missing }) });
  });
  await page.route("**/api/textures/manifest", async (route) => {
    await route.fulfill({ status: 404, body: "texture manifest not found" });
  });

  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect.poll(() => slowRequestCount).toBeGreaterThan(0);
  await expect.poll(() => pageHasGrassPixels(page), { timeout: 2_000 }).toBe(true);
});

test("coalesces mobile zoomed-out chunk loading and keeps dragging responsive", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const chunkQueries: Array<{ minChunkX: number; maxChunkX: number; minChunkZ: number; maxChunkZ: number }> = [];
  const imageTileRequests: string[] = [];
  const grassChunk = {
    world: "Bedrock level",
    dimension: "Overworld",
    chunkX: 0,
    chunkZ: 0,
    palette: ["minecraft:grass_block"],
    blocks: Array.from({ length: 256 }, () => 0),
    heights: Array.from({ length: 256 }, () => 64),
    updatedAt: 1,
  };

  await mockBasicMap(page, {
    world: {
      version: 1,
      world: "Bedrock level",
      dimension: "Overworld",
      status: "complete",
      chunkCount: 289,
      importedAt: 1,
      updatedAt: 1,
      bounds: {
        minChunkX: -64,
        maxChunkX: 64,
        minChunkZ: -64,
        maxChunkZ: 64,
        minBlockX: -1024,
        maxBlockX: 1039,
        minBlockZ: -1024,
        maxBlockZ: 1039,
      },
      sampleChunks: [{ chunkX: 0, chunkZ: 0 }],
      topBlocks: { "minecraft:grass_block": 256 },
    },
    chunkRoute: async (route) => {
      const url = new URL(route.request().url());
      const query = {
        minChunkX: Number(url.searchParams.get("minChunkX")),
        maxChunkX: Number(url.searchParams.get("maxChunkX")),
        minChunkZ: Number(url.searchParams.get("minChunkZ")),
        maxChunkZ: Number(url.searchParams.get("maxChunkZ")),
      };
      chunkQueries.push(query);
      const includesGrass =
        query.minChunkX <= grassChunk.chunkX &&
        query.maxChunkX >= grassChunk.chunkX &&
        query.minChunkZ <= grassChunk.chunkZ &&
        query.maxChunkZ >= grassChunk.chunkZ;
      const missing: Array<{ chunkX: number; chunkZ: number }> = [];
      for (let chunkZ = query.minChunkZ; chunkZ <= query.maxChunkZ; chunkZ += 1) {
        for (let chunkX = query.minChunkX; chunkX <= query.maxChunkX; chunkX += 1) {
          if (!(includesGrass && chunkX === grassChunk.chunkX && chunkZ === grassChunk.chunkZ)) {
            missing.push({ chunkX, chunkZ });
          }
        }
      }
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ chunks: includesGrass ? [grassChunk] : [], missing }) });
    },
  });
  await page.route("**/api/map-tiles/**", async (route) => {
    imageTileRequests.push(route.request().url());
    await route.fulfill({ contentType: "image/png", body: GRASS_TILE_PNG });
  });

  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect.poll(() => pageHasGrassPixels(page)).toBe(true);
  const chunkRequestsBeforeZoomOut = chunkQueries.length;

  for (let index = 0; index < 4; index += 1) {
    await page.getByRole("button", { name: "Zoom out" }).click();
  }
  await page.waitForTimeout(250);
  expect(chunkQueries.length).toBe(chunkRequestsBeforeZoomOut);
  expect(imageTileRequests.some((url) => url.includes("/api/map-tiles/Bedrock_level/Overworld/z"))).toBe(true);
  await expect.poll(() => pageHasGrassImageTile(page)).toBe(true);

  const before = await mapPaneTransform(page);
  await dragMap(page, 260, 220, 90, 220);
  await expect.poll(() => mapPaneTransform(page)).not.toBe(before);
  await expect.poll(() => pageHasGrassImageTile(page)).toBe(true);
});

test("zooms out to the extra z-1 image tile level", async ({ page }) => {
  const imageTileRequests: string[] = [];
  await mockBasicMap(page, {
    world: {
      version: 1,
      world: "Bedrock level",
      dimension: "Overworld",
      status: "complete",
      chunkCount: 4096,
      importedAt: 1,
      updatedAt: 1,
      bounds: {
        minChunkX: -64,
        maxChunkX: 64,
        minChunkZ: -64,
        maxChunkZ: 64,
        minBlockX: -1024,
        maxBlockX: 1039,
        minBlockZ: -1024,
        maxBlockZ: 1039,
      },
      sampleChunks: [{ chunkX: 0, chunkZ: 0 }],
      topBlocks: { "minecraft:grass_block": 256 },
    },
  });
  await page.route("**/api/map-tiles/**", async (route) => {
    imageTileRequests.push(route.request().url());
    await route.fulfill({ contentType: "image/png", body: GRASS_TILE_PNG });
  });

  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();

  for (let index = 0; index < 5; index += 1) {
    await expect(page.getByRole("button", { name: "Zoom out" })).toBeEnabled();
    await page.getByRole("button", { name: "Zoom out" }).click();
    await page.waitForTimeout(250);
  }

  await expect.poll(() => imageTileRequests.some((url) => url.includes("/api/map-tiles/Bedrock_level/Overworld/z-1/"))).toBe(true);
  await expect.poll(() => pageHasGrassImageTile(page)).toBe(true);
});

test("uses low zoom image tiles and keeps max zoom chunk JSON rendering", async ({ page }) => {
  const chunkRequests: string[] = [];
  const imageTileRequests: string[] = [];
  await mockBasicMap(page, {
    chunkRoute: async (route) => {
      chunkRequests.push(route.request().url());
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          chunks: [
            {
              world: "Bedrock level",
              dimension: "Overworld",
              chunkX: 0,
              chunkZ: 0,
              palette: ["minecraft:grass_block"],
              blocks: Array.from({ length: 256 }, () => 0),
              heights: Array.from({ length: 256 }, () => 64),
              updatedAt: 1,
            },
          ],
          missing: [],
        }),
      });
    },
  });
  await page.route("**/api/map-tiles/**", async (route) => {
    imageTileRequests.push(route.request().url());
    await route.fulfill({ contentType: "image/png", body: GRASS_TILE_PNG });
  });

  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect.poll(() => chunkRequests.length).toBeGreaterThan(0);
  await expect.poll(() => pageHasGrassPixels(page)).toBe(true);
  const maxZoomChunkRequests = chunkRequests.length;

  await page.getByRole("button", { name: "Zoom out" }).click();
  await expect.poll(() => imageTileRequests.some((url) => url.includes("/api/map-tiles/Bedrock_level/Overworld/z3/"))).toBe(true);
  await page.waitForTimeout(250);
  expect(chunkRequests.length).toBe(maxZoomChunkRequests);
  await expect.poll(() => pageHasGrassImageTile(page)).toBe(true);

  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect.poll(() => pageHasGrassPixels(page)).toBe(true);
});

test("treats one pixel placeholder low zoom tiles as missing", async ({ page }) => {
  await mockBasicMap(page, {
    world: {
      version: 1,
      world: "Bedrock level",
      dimension: "Overworld",
      status: "complete",
      chunkCount: 256,
      importedAt: 1,
      updatedAt: 1,
      bounds: {
        minChunkX: -8,
        maxChunkX: 8,
        minChunkZ: -8,
        maxChunkZ: 8,
        minBlockX: -128,
        maxBlockX: 143,
        minBlockZ: -128,
        maxBlockZ: 143,
      },
      topBlocks: { "minecraft:grass_block": 256 },
    },
  });
  await page.route("**/api/map-tiles/**", async (route) => {
    await route.fulfill({ contentType: "image/png", body: EMPTY_TILE_PNG });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Zoom out" }).click();
  await expect.poll(() => page.locator("img.chunk-image-tile-missing").count()).toBeGreaterThan(0);
  await expect.poll(() => pageHasVisiblePlaceholderImageTile(page)).toBe(false);
});

test("keeps first load scoped to the initial viewport instead of fitting every imported chunk", async ({ page }) => {
  const requestedKnownChunks = new Set<string>();
  const requestedOutsideBounds = new Set<string>();
  const grassChunk = {
    world: "Bedrock level",
    dimension: "Overworld",
    chunkX: -23,
    chunkZ: -21,
    palette: ["minecraft:grass_block"],
    blocks: Array.from({ length: 256 }, () => 0),
    heights: Array.from({ length: 256 }, () => 64),
    updatedAt: 1,
  };

  await page.route("**/api/live", async (route) => route.abort());
  await page.route("**/api/lands?**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ version: 1, world: "Bedrock level", dimension: "Overworld", claims: [], updatedAt: 0 }) });
  });
  await page.route("**/api/worlds", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        worlds: [
          {
            version: 1,
            world: "Bedrock level",
            dimension: "Overworld",
            status: "complete",
            chunkCount: 99,
            importedAt: 1,
            updatedAt: 1,
            bounds: {
              minChunkX: -42,
              maxChunkX: 0,
              minChunkZ: -38,
              maxChunkZ: 0,
              minBlockX: -672,
              maxBlockX: 15,
              minBlockZ: -608,
              maxBlockZ: 15,
            },
            sampleChunks: [{ chunkX: -23, chunkZ: -21 }],
            topBlocks: { "minecraft:grass_block": 256 },
          },
        ],
      }),
    });
  });
  await page.route("**/api/chunks?**", async (route) => {
    const url = new URL(route.request().url());
    const minChunkX = Number(url.searchParams.get("minChunkX"));
    const maxChunkX = Number(url.searchParams.get("maxChunkX"));
    const minChunkZ = Number(url.searchParams.get("minChunkZ"));
    const maxChunkZ = Number(url.searchParams.get("maxChunkZ"));
    for (let chunkZ = minChunkZ; chunkZ <= maxChunkZ; chunkZ += 1) {
      for (let chunkX = minChunkX; chunkX <= maxChunkX; chunkX += 1) {
        if (chunkX >= -42 && chunkX <= 0 && chunkZ >= -38 && chunkZ <= 0) {
          requestedKnownChunks.add(`${chunkX},${chunkZ}`);
        } else {
          requestedOutsideBounds.add(`${chunkX},${chunkZ}`);
        }
      }
    }
    const includesGrass = minChunkX <= grassChunk.chunkX && maxChunkX >= grassChunk.chunkX && minChunkZ <= grassChunk.chunkZ && maxChunkZ >= grassChunk.chunkZ;
    const chunks = includesGrass ? [grassChunk] : [];
    const missing: Array<{ chunkX: number; chunkZ: number }> = [];
    for (let chunkZ = minChunkZ; chunkZ <= maxChunkZ; chunkZ += 1) {
      for (let chunkX = minChunkX; chunkX <= maxChunkX; chunkX += 1) {
        if (!chunks.some((chunk) => chunk.chunkX === chunkX && chunk.chunkZ === chunkZ)) {
          missing.push({ chunkX, chunkZ });
        }
      }
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ chunks, missing }) });
  });
  await page.route("**/api/textures/manifest", async (route) => {
    await route.fulfill({ status: 404, body: "texture manifest not found" });
  });

  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect.poll(() => pageHasGrassPixels(page)).toBe(true);
  await expect.poll(() => pageHasVisibleGrassTile(page)).toBe(true);
  await page.waitForTimeout(500);
  expect(requestedKnownChunks.has("-42,-38")).toBe(false);
  expect(requestedKnownChunks.has("0,0")).toBe(false);
  expect(requestedKnownChunks.has("-23,-21")).toBe(true);
  expect(requestedOutsideBounds.size).toBe(0);
  expect(requestedKnownChunks.size).toBeLessThan(90);
});

test("renders fallback map colors before the texture atlas finishes loading", async ({ page }) => {
  const grassChunk = {
    world: "Bedrock level",
    dimension: "Overworld",
    chunkX: 0,
    chunkZ: 0,
    palette: ["minecraft:grass_block"],
    blocks: Array.from({ length: 256 }, () => 0),
    heights: Array.from({ length: 256 }, () => 64),
    updatedAt: 1,
  };

  await page.route("**/api/live", async (route) => route.abort());
  await page.route("**/api/lands?**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ version: 1, world: "Bedrock level", dimension: "Overworld", claims: [], updatedAt: 0 }) });
  });
  await page.route("**/api/worlds", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        worlds: [
          {
            version: 1,
            world: "Bedrock level",
            dimension: "Overworld",
            status: "complete",
            chunkCount: 1,
            importedAt: 1,
            updatedAt: 1,
            bounds: {
              minChunkX: 0,
              maxChunkX: 0,
              minChunkZ: 0,
              maxChunkZ: 0,
              minBlockX: 0,
              maxBlockX: 15,
              minBlockZ: 0,
              maxBlockZ: 15,
            },
            topBlocks: { "minecraft:grass_block": 256 },
          },
        ],
      }),
    });
  });
  await page.route("**/api/chunks?**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ chunks: [grassChunk], missing: [] }) });
  });
  await page.route("**/api/textures/manifest", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    await route.fulfill({ status: 404, body: "texture manifest delayed" });
  });

  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect.poll(() => pageHasGrassPixels(page), { timeout: 2_000 }).toBe(true);
});

test("adds height shading to max zoom canvas rendering", async ({ page }) => {
  const shadedChunk = {
    world: "Bedrock level",
    dimension: "Overworld",
    chunkX: 0,
    chunkZ: 0,
    palette: ["minecraft:grass_block"],
    blocks: Array.from({ length: 256 }, () => 0),
    heights: Array.from({ length: 256 }, (_, index) => {
      const z = Math.floor(index / 16);
      if (z < 4) return 48;
      if (z > 11) return 155;
      return 64;
    }),
    updatedAt: 1,
  };

  await mockBasicMap(page, {
    chunk: shadedChunk,
    world: {
      version: 1,
      world: "Bedrock level",
      dimension: "Overworld",
      status: "complete",
      chunkCount: 1,
      importedAt: 1,
      updatedAt: 1,
      bounds: {
        minChunkX: 0,
        maxChunkX: 0,
        minChunkZ: 0,
        maxChunkZ: 0,
        minBlockX: 0,
        maxBlockX: 15,
        minBlockZ: 0,
        maxBlockZ: 15,
      },
      sampleChunks: [{ chunkX: 0, chunkZ: 0 }],
      topBlocks: { "minecraft:grass_block": 256 },
    },
  });

  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect.poll(() => pageHasHeightShading(page)).toBe(true);
});

test("renders plant and cutout overlays without dark tile holes", async ({ page }) => {
  const targetChunk = {
    world: "Bedrock level",
    dimension: "Overworld",
    chunkX: 0,
    chunkZ: 0,
    palette: [
      "minecraft:grass_block",
      "minecraft:air",
      "minecraft:poppy",
      "minecraft:glass_pane",
      "minecraft:lantern",
      "minecraft:tube_coral_fan",
      "minecraft:sea_pickle",
      "minecraft:bush",
      "minecraft:leaf_litter",
      "minecraft:horn_coral",
    ],
    blocks: Array.from({ length: 256 }, () => 0),
    heights: Array.from({ length: 256 }, () => 64),
    overlayBlocks: Array.from({ length: 256 }, (_, index) => {
      if (index === 0) {
        return 2;
      }
      if (index === 1) {
        return 3;
      }
      if (index === 2) {
        return 4;
      }
      if (index === 3) {
        return 5;
      }
      if (index === 4) {
        return 6;
      }
      if (index === 5) {
        return 7;
      }
      if (index === 6) {
        return 8;
      }
      if (index === 7) {
        return 9;
      }
      return 1;
    }),
    overlayHeights: Array.from({ length: 256 }, (_, index) => (index >= 0 && index <= 7 ? 65 : -64)),
    updatedAt: 1,
  };

  await page.route("**/api/live", async (route) => route.abort());
  await page.route("**/api/lands?**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ version: 1, world: "Bedrock level", dimension: "Overworld", claims: [], updatedAt: 0 }) });
  });
  await page.route("**/api/worlds", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        worlds: [
          {
            version: 1,
            world: "Bedrock level",
            dimension: "Overworld",
            status: "complete",
            chunkCount: 1,
            importedAt: 1,
            updatedAt: 1,
            bounds: {
              minChunkX: 0,
              maxChunkX: 0,
              minChunkZ: 0,
              maxChunkZ: 0,
              minBlockX: 0,
              maxBlockX: 15,
              minBlockZ: 0,
              maxBlockZ: 15,
            },
            topBlocks: { "minecraft:grass_block": 256 },
          },
        ],
      }),
    });
  });
  await page.route("**/api/chunks?**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ chunks: [targetChunk], missing: [] }) });
  });
  await page.route("**/api/textures/manifest", async (route) => {
    await route.fulfill({ status: 404, body: "texture manifest not found" });
  });

  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect.poll(() => pageHasGrassPixels(page)).toBe(true);
  await expect.poll(() => firstChunkTileHasNoDarkHoles(page)).toBe(true);
});

test("renders cherry leaves from the atlas and flat overlays over the base block", async ({ page }) => {
  const atlasPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAADAAAAAQCAYAAABQrvyxAAACQUlEQVR4AcXBIY4ehhmE4Xf/GPcoPoHvMcSkfELmBPUFPjQ4UiUXDCwqKKpkUmDQvUFAQGhhpGoTWEUKSGxpn+fpv3/794tvNMI3GuEbjfCNRvhGI3yjEb7RCN948me+xF///K8nvsDDNxrhG43wjUb4RiN8oxG+0QjfaIRvNOK1PRrhG43wjUb4RiN8oxG+0QjfaIRvNMI3Xtsb32iEbzTCNxrhG43wjUb4RiN8oxG+0Yhvf/rM1/Dp/dsXfod3H5+f+MWbRvhGI3yjEb7RCN9ohG80wjca4RuN8I0n81W8+/j8xB/w8I1G+EYjfKMRvtEI32iEbzTCNxrhG4342j69f/vCb/j0/u0Lv/JohG80wjca4RuN8I1G+EYjfKMRvtEI33htD99ohG80wjca4RuN8I1G+EYjfKMRvtGI1/ZohG80wjca4RuN8I1G+EYjfKMRvtEI33htD99ohG80wjca4RuN8I1G+EYjfKMRvtGI1/ZohG80wjca4RuN8I1G+EYjfKMRvtEI33ht3/zw/Z/+0gjfaIRvNMI3GuEbjfCNRvhGI3yjEf/43z/5Ev/5+/cf+D/fPf/4gd/w3fOPH/iVN43wjUb4RiN8oxG+0QjfaIRvNMI3GuEbT+ar+PT+7Qu/w7uPz0/84o1vNMI3GuEbjfCNRvhGI3yjEb7RCN9oxLc/feZrePfx+Yk/4NEI32iEbzTCNxrhG43wjUb4RiN8oxG+8doevtEI32iEbzTCNxrhG43wjUb4RiN8oxGv7Wc7VaYyEqiKFQAAAABJRU5ErkJggg==",
    "base64",
  );
  const targetChunk = {
    world: "Bedrock level",
    dimension: "Overworld",
    chunkX: 0,
    chunkZ: 0,
    palette: ["minecraft:cherry_leaves", "minecraft:grass_block", "minecraft:leaf_litter", "minecraft:air"],
    blocks: Array.from({ length: 256 }, (_, index) => (index === 0 ? 0 : 1)),
    heights: Array.from({ length: 256 }, () => 64),
    overlayBlocks: Array.from({ length: 256 }, (_, index) => (index === 1 ? 2 : 3)),
    overlayHeights: Array.from({ length: 256 }, (_, index) => (index === 1 ? 65 : -64)),
    updatedAt: 1,
  };

  await page.route("**/api/live", async (route) => route.abort());
  await page.route("**/api/lands?**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ version: 1, world: "Bedrock level", dimension: "Overworld", claims: [], updatedAt: 0 }) });
  });
  await page.route("**/api/worlds", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        worlds: [
          {
            version: 1,
            world: "Bedrock level",
            dimension: "Overworld",
            status: "complete",
            chunkCount: 1,
            importedAt: 1,
            updatedAt: 1,
            bounds: {
              minChunkX: 0,
              maxChunkX: 0,
              minChunkZ: 0,
              maxChunkZ: 0,
              minBlockX: 0,
              maxBlockX: 15,
              minBlockZ: 0,
              maxBlockZ: 15,
            },
            topBlocks: { "minecraft:cherry_leaves": 1, "minecraft:grass_block": 255 },
          },
        ],
      }),
    });
  });
  await page.route("**/api/chunks?**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ chunks: [targetChunk], missing: [] }) });
  });
  await page.route("**/api/textures/manifest", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        version: 1,
        tileSize: 16,
        atlas: "/textures/atlas.png",
        blocks: {
          "minecraft:cherry_leaves": { x: 0, y: 0, w: 16, h: 16 },
          cherry_leaves: { x: 0, y: 0, w: 16, h: 16 },
          "minecraft:grass_block": { x: 16, y: 0, w: 16, h: 16 },
          grass_block: { x: 16, y: 0, w: 16, h: 16 },
          "minecraft:leaf_litter": { x: 32, y: 0, w: 16, h: 16 },
          leaf_litter: { x: 32, y: 0, w: 16, h: 16 },
        },
      }),
    });
  });
  await page.route("**/textures/atlas.png", async (route) => {
    await route.fulfill({ contentType: "image/png", body: atlasPng });
  });

  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect.poll(() => firstChunkTileHasColor(page, [94, 51, 114])).toBe(true);
  await expect.poll(() => firstChunkTileHasColor(page, [95, 159, 63])).toBe(true);
  await expect.poll(() => firstChunkTileHasColor(page, [196, 92, 46])).toBe(true);
});

test("renders transparent leaf atlas pixels over a solid fallback underlay", async ({ page }) => {
  const atlasPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAQCAYAAAB3AH1ZAAAAUUlEQVR4AcXBQRGAIABFwccfE1iABHTwYAvymcgEJsEC3HB8u6X2NlhwnDsrgizIgizINiae6y5M1N4GHwuyIAuyIAuyjYna2+AnQRZkQRZkLx8MCAYYGug7AAAAAElFTkSuQmCC",
    "base64",
  );
  const targetChunk = {
    world: "Bedrock level",
    dimension: "Overworld",
    chunkX: 0,
    chunkZ: 0,
    palette: ["minecraft:acacia_leaves", "minecraft:grass_block"],
    blocks: Array.from({ length: 256 }, (_, index) => (index === 0 ? 0 : 1)),
    heights: Array.from({ length: 256 }, () => 64),
    updatedAt: 1,
  };

  await page.route("**/api/live", async (route) => route.abort());
  await page.route("**/api/lands?**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ version: 1, world: "Bedrock level", dimension: "Overworld", claims: [], updatedAt: 0 }) });
  });
  await page.route("**/api/worlds", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        worlds: [
          {
            version: 1,
            world: "Bedrock level",
            dimension: "Overworld",
            status: "complete",
            chunkCount: 1,
            importedAt: 1,
            updatedAt: 1,
            bounds: {
              minChunkX: 0,
              maxChunkX: 0,
              minChunkZ: 0,
              maxChunkZ: 0,
              minBlockX: 0,
              maxBlockX: 15,
              minBlockZ: 0,
              maxBlockZ: 15,
            },
            topBlocks: { "minecraft:acacia_leaves": 1, "minecraft:grass_block": 255 },
          },
        ],
      }),
    });
  });
  await page.route("**/api/chunks?**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ chunks: [targetChunk], missing: [] }) });
  });
  await page.route("**/api/textures/manifest", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        version: 1,
        tileSize: 16,
        atlas: "/textures/acacia-atlas.png",
        blocks: {
          "minecraft:acacia_leaves": { x: 0, y: 0, w: 16, h: 16 },
          acacia_leaves: { x: 0, y: 0, w: 16, h: 16 },
          "minecraft:grass_block": { x: 16, y: 0, w: 16, h: 16 },
          grass_block: { x: 16, y: 0, w: 16, h: 16 },
        },
      }),
    });
  });
  await page.route("**/textures/acacia-atlas.png", async (route) => {
    await route.fulfill({ contentType: "image/png", body: atlasPng });
  });

  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect.poll(() => firstChunkTileHasColor(page, [31, 91, 45])).toBe(true);
  await expect.poll(() => firstChunkTileHasColor(page, [63, 127, 56])).toBe(true);
  await expect.poll(() => leafBlockHasSolidFallbackUnderlay(page)).toBe(true);
});

test("renders stateful partial blocks without dark base holes", async ({ page }) => {
  const targetChunk = {
    world: "Bedrock level",
    dimension: "Overworld",
    chunkX: 0,
    chunkZ: 0,
    palette: ["minecraft:grass_block", "minecraft:cake", "minecraft:oak_trapdoor", "minecraft:end_rod"],
    blocks: Array.from({ length: 256 }, () => 0),
    heights: Array.from({ length: 256 }, () => 64),
    overlayBlocks: Array.from({ length: 256 }, (_, index) => {
      if (index === 0) return 1;
      if (index === 1) return 2;
      if (index === 2) return 3;
      return 0;
    }),
    overlayHeights: Array.from({ length: 256 }, (_, index) => (index <= 2 ? 65 : -64)),
    overlayStates: Array.from({ length: 256 }, (_, index) => {
      if (index === 0) return { bite_counter: 4 };
      if (index === 1) return { direction: 1, open_bit: true };
      if (index === 2) return { facing_direction: 0 };
      return {};
    }),
    updatedAt: 1,
  };

  await page.route("**/api/live", async (route) => route.abort());
  await page.route("**/api/lands?**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ version: 1, world: "Bedrock level", dimension: "Overworld", claims: [], updatedAt: 0 }) });
  });
  await page.route("**/api/worlds", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        worlds: [
          {
            version: 1,
            world: "Bedrock level",
            dimension: "Overworld",
            status: "complete",
            chunkCount: 1,
            importedAt: 1,
            updatedAt: 1,
            bounds: {
              minChunkX: 0,
              maxChunkX: 0,
              minChunkZ: 0,
              maxChunkZ: 0,
              minBlockX: 0,
              maxBlockX: 15,
              minBlockZ: 0,
              maxBlockZ: 15,
            },
            topBlocks: { "minecraft:grass_block": 253, "minecraft:cake": 1, "minecraft:oak_trapdoor": 1, "minecraft:end_rod": 1 },
          },
        ],
      }),
    });
  });
  await page.route("**/api/chunks?**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ chunks: [targetChunk], missing: [] }) });
  });
  await page.route("**/api/textures/manifest", async (route) => {
    await route.fulfill({ status: 404, body: "texture manifest not found" });
  });

  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect.poll(() => firstChunkTileHasColor(page, [95, 159, 63])).toBe(true);
  await expect.poll(() => firstChunkTileHasColor(page, [244, 231, 215])).toBe(true);
  await expect.poll(() => firstChunkTileHasColor(page, [139, 129, 116])).toBe(true);
  await expect.poll(() => firstChunkTileHasColor(page, [233, 227, 196])).toBe(true);
  await expect.poll(() => firstChunkTileHasNoDarkHoles(page)).toBe(true);
});

test("does not request chunk data before a world import exists when only live players are known", async ({ page }) => {
  let chunkRequests = 0;
  let imageTileRequests = 0;

  await page.route("**/api/live", async (route) => route.abort());
  await page.route("**/api/lands?**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ version: 1, world: "Bedrock level", dimension: "Overworld", claims: [], updatedAt: 0 }) });
  });
  await page.addInitScript(() => {
    class MockWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = MockWebSocket.OPEN;
      url: string;

      constructor(url: string) {
        super();
        this.url = url;
        setTimeout(() => {
          this.dispatchEvent(new Event("open"));
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                type: "player_snapshot",
                players: [
                  {
                    id: "wing",
                    name: "Wing",
                    world: "Bedrock level",
                    dimension: "Overworld",
                    x: 0,
                    y: 64,
                    z: 0,
                    yaw: 0,
                    pitch: 0,
                    updatedAt: 1,
                  },
                ],
              }),
            }),
          );
        }, 50);
      }

      close() {
        this.readyState = MockWebSocket.CLOSED;
        this.dispatchEvent(new Event("close"));
      }

      send() {}
    }

    Object.assign(MockWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });
  await page.route("**/api/worlds", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ worlds: [] }) });
  });
  await page.route("**/api/chunks?**", async (route) => {
    chunkRequests += 1;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ chunks: [], missing: [] }) });
  });
  await page.route("**/api/map-tiles/**", async (route) => {
    imageTileRequests += 1;
    await route.fulfill({ status: 404, body: "tile not found" });
  });
  await page.route("**/api/textures/manifest", async (route) => {
    await route.fulfill({ status: 404, body: "texture manifest not found" });
  });

  await page.goto("/");
  await expect(page.getByText("Wing")).toBeVisible();
  await expect(page.getByTestId("map-empty-state")).toHaveCount(0);
  await page.waitForTimeout(1000);
  expect(chunkRequests).toBe(0);
  expect(imageTileRequests).toBeGreaterThan(0);
});

test("does not reset user zoom on live player refresh", async ({ page }) => {
  await page.route("**/api/live", async (route) => route.abort());
  await page.route("**/api/lands?**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ version: 1, world: "Bedrock level", dimension: "Overworld", claims: [], updatedAt: 0 }) });
  });
  await page.addInitScript(() => {
    class MockWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = MockWebSocket.OPEN;
      url: string;

      constructor(url: string) {
        super();
        this.url = url;
        setTimeout(() => {
          this.dispatchEvent(new Event("open"));
          const sendSnapshot = (x: number) => {
            this.dispatchEvent(
              new MessageEvent("message", {
                data: JSON.stringify({
                  type: "player_snapshot",
                  players: [
                    {
                      id: "wing",
                      name: "Wing",
                      world: "Bedrock level",
                      dimension: "Overworld",
                      x,
                      y: 64,
                      z: 0,
                      yaw: 0,
                      pitch: 0,
                      updatedAt: Date.now(),
                    },
                  ],
                }),
              }),
            );
          };
          (window as unknown as { __sendLiveSnapshot?: (x: number) => void }).__sendLiveSnapshot = sendSnapshot;
          sendSnapshot(0);
        }, 50);
      }

      close() {
        this.readyState = MockWebSocket.CLOSED;
        this.dispatchEvent(new Event("close"));
      }

      send() {}
    }

    Object.assign(MockWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });
  await page.route("**/api/worlds", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ worlds: [] }) });
  });
  await page.route("**/api/chunks?**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ chunks: [], missing: [] }) });
  });
  await page.route("**/api/textures/manifest", async (route) => {
    await route.fulfill({ status: 404, body: "texture manifest not found" });
  });

  await page.goto("/");
  await expect(page.getByText("Wing")).toBeVisible();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.getByRole("button", { name: "Zoom out" })).toBeEnabled();
  await page.evaluate(() => (window as unknown as { __sendLiveSnapshot?: (x: number) => void }).__sendLiveSnapshot?.(32));
  await page.waitForTimeout(300);
  await expect(page.getByRole("button", { name: "Zoom out" })).toBeEnabled();
});

test("renders land claims, point claims, and teleport markers", async ({ page }) => {
  await page.route("**/api/live", async (route) => route.abort());
  await page.route("**/api/worlds", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        worlds: [
          {
            version: 1,
            world: "Bedrock level",
            dimension: "Overworld",
            status: "complete",
            chunkCount: 1,
            importedAt: 1,
            updatedAt: 1,
            bounds: {
              minChunkX: -24,
              maxChunkX: -14,
              minChunkZ: -38,
              maxChunkZ: -28,
              minBlockX: -384,
              maxBlockX: -209,
              minBlockZ: -608,
              maxBlockZ: -449,
            },
            topBlocks: { "minecraft:grass_block": 256 },
          },
        ],
      }),
    });
  });
  await page.route("**/api/chunks?**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ chunks: [], missing: [] }) });
  });
  await page.route("**/api/textures/manifest", async (route) => {
    await route.fulfill({ status: 404, body: "texture manifest not found" });
  });
  const publicClaims = Array.from({ length: 13 }, (_, index) => ({
    id: `GieZi8670:公开${index}:Overworld`,
    owner: "GieZi8670",
    name: `公开${index}`,
    world: "Bedrock_level",
    dimension: "Overworld",
    minX: -375 + index,
    maxX: -227 + index,
    minY: 70,
    maxY: 300,
    minZ: -580 + index,
    maxZ: -473 + index,
    teleport: { x: -352 + index, y: 70, z: -479 + index },
    publicTeleport: true,
    members: ["wingxia"],
    parent: "",
    children: [],
    nested: false,
    updatedAt: 123,
  }));

  await page.route("**/api/lands?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        version: 1,
        world: "Bedrock_level",
        dimension: "Overworld",
        updatedAt: 123,
        claims: [
          {
            id: "GieZi8670:主城区:Overworld",
            owner: "GieZi8670",
            name: "主城区",
            world: "Bedrock_level",
            dimension: "Overworld",
            minX: -375,
            maxX: -227,
            minY: 70,
            maxY: 300,
            minZ: -580,
            maxZ: -473,
            teleport: { x: -352, y: 70, z: -479 },
            publicTeleport: true,
            members: ["wingxia"],
            parent: "",
            children: ["猪人塔"],
            nested: false,
            updatedAt: 123,
          },
          {
            id: "GieZi8670:私有领地:Overworld",
            owner: "GieZi8670",
            name: "私有领地",
            world: "Bedrock_level",
            dimension: "Overworld",
            minX: -300,
            maxX: -290,
            minY: 63,
            maxY: 70,
            minZ: -500,
            maxZ: -490,
            teleport: { x: -295, y: 63, z: -495 },
            publicTeleport: false,
            members: [],
            parent: "",
            children: [],
            nested: false,
            updatedAt: 123,
          },
          {
            id: "GieZi8670:白色青蛙:Overworld",
            owner: "GieZi8670",
            name: "白色青蛙",
            world: "Bedrock_level",
            dimension: "Overworld",
            minX: -330,
            maxX: -330,
            minY: 63,
            maxY: 63,
            minZ: -540,
            maxZ: -540,
            teleport: { x: -330, y: 63, z: -540 },
            publicTeleport: true,
            members: [],
            parent: "",
            children: [],
            nested: false,
            updatedAt: 123,
          },
          ...publicClaims,
        ],
      }),
    });
  });

  await page.goto("/");
  await expect(page.getByText("主城区")).toBeVisible();
  await expect(page.getByText("白色青蛙")).toBeVisible();
  await expect(page.getByText("公开12")).toBeVisible();
  await expect(page.getByText("私有领地")).toHaveCount(0);
  await expect(page.getByText(/还有/)).toHaveCount(0);
  await expect(page.getByLabel("地图状态")).toContainText("15");
  await expect.poll(() => page.locator(".leaflet-interactive").count()).toBeGreaterThanOrEqual(17);
});

test("centers the map on clicked players and public land teleports", async ({ page }) => {
  const chunkQueries: Array<{ minChunkX: number; maxChunkX: number; minChunkZ: number; maxChunkZ: number }> = [];
  const imageTileRequests: string[] = [];

  await page.addInitScript(() => {
    class MockWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = MockWebSocket.OPEN;
      url: string;

      constructor(url: string) {
        super();
        this.url = url;
        setTimeout(() => {
          this.dispatchEvent(new Event("open"));
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                type: "player_snapshot",
                players: [
                  {
                    id: "wing",
                    name: "Wing",
                    world: "Bedrock level",
                    dimension: "Overworld",
                    x: 512,
                    y: 64,
                    z: -256,
                    yaw: 0,
                    pitch: 0,
                    updatedAt: 1,
                  },
                ],
              }),
            }),
          );
        }, 50);
      }

      close() {
        this.readyState = MockWebSocket.CLOSED;
        this.dispatchEvent(new Event("close"));
      }

      send() {}
    }

    Object.assign(MockWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });
  await page.route("**/api/worlds", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        worlds: [
          {
            version: 1,
            world: "Bedrock level",
            dimension: "Overworld",
            status: "complete",
            chunkCount: 256,
            importedAt: 1,
            updatedAt: 1,
            bounds: {
              minChunkX: -80,
              maxChunkX: 80,
              minChunkZ: -80,
              maxChunkZ: 80,
              minBlockX: -1280,
              maxBlockX: 1295,
              minBlockZ: -1280,
              maxBlockZ: 1295,
            },
            topBlocks: { "minecraft:grass_block": 256 },
          },
        ],
      }),
    });
  });
  await page.route("**/api/chunks?**", async (route) => {
    const url = new URL(route.request().url());
    chunkQueries.push({
      minChunkX: Number(url.searchParams.get("minChunkX")),
      maxChunkX: Number(url.searchParams.get("maxChunkX")),
      minChunkZ: Number(url.searchParams.get("minChunkZ")),
      maxChunkZ: Number(url.searchParams.get("maxChunkZ")),
    });
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ chunks: [], missing: [] }) });
  });
  await page.route("**/api/map-tiles/**", async (route) => {
    imageTileRequests.push(route.request().url());
    await route.fulfill({ status: 404, body: "tile not found" });
  });
  await page.route("**/api/textures/manifest", async (route) => {
    await route.fulfill({ status: 404, body: "texture manifest not found" });
  });
  await page.route("**/api/lands?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        version: 1,
        world: "Bedrock_level",
        dimension: "Overworld",
        updatedAt: 123,
        claims: [
          {
            id: "GieZi8670:主城区:Overworld",
            owner: "GieZi8670",
            name: "主城区",
            world: "Bedrock_level",
            dimension: "Overworld",
            minX: -375,
            maxX: -227,
            minY: 70,
            maxY: 300,
            minZ: -580,
            maxZ: -473,
            teleport: { x: -352, y: 70, z: -479 },
            publicTeleport: true,
            members: ["wingxia"],
            parent: "",
            children: [],
            nested: false,
            updatedAt: 123,
          },
        ],
      }),
    });
  });

  await page.goto("/");
  await expect(page.getByText("Wing")).toBeVisible();
  await expect(page.getByText("主城区")).toBeVisible();

  await page.getByRole("button", { name: /Wing/ }).click();
  await expect.poll(() => chunkQueries.some((query) => queryIncludesChunk(query, 32, -16)) || mapTileRequestsIncludeChunk(imageTileRequests, 32, -16)).toBe(true);

  await page.getByRole("button", { name: /主城区/ }).click();
  await expect.poll(() => chunkQueries.some((query) => queryIncludesChunk(query, -22, -30)) || mapTileRequestsIncludeChunk(imageTileRequests, -22, -30)).toBe(true);
});

test("filters land list search and keeps filtered land focus working", async ({ page }) => {
  const chunkQueries: Array<{ minChunkX: number; maxChunkX: number; minChunkZ: number; maxChunkZ: number }> = [];
  const imageTileRequests: string[] = [];
  await page.route("**/api/live", async (route) => route.abort());
  await page.route("**/api/worlds", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        worlds: [
          {
            version: 1,
            world: "Bedrock level",
            dimension: "Overworld",
            status: "complete",
            chunkCount: 256,
            importedAt: 1,
            updatedAt: 1,
            bounds: {
              minChunkX: -80,
              maxChunkX: 80,
              minChunkZ: -80,
              maxChunkZ: 80,
              minBlockX: -1280,
              maxBlockX: 1295,
              minBlockZ: -1280,
              maxBlockZ: 1295,
            },
            topBlocks: { "minecraft:grass_block": 256 },
          },
        ],
      }),
    });
  });
  await page.route("**/api/chunks?**", async (route) => {
    const url = new URL(route.request().url());
    chunkQueries.push({
      minChunkX: Number(url.searchParams.get("minChunkX")),
      maxChunkX: Number(url.searchParams.get("maxChunkX")),
      minChunkZ: Number(url.searchParams.get("minChunkZ")),
      maxChunkZ: Number(url.searchParams.get("maxChunkZ")),
    });
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ chunks: [], missing: [] }) });
  });
  await page.route("**/api/map-tiles/**", async (route) => {
    imageTileRequests.push(route.request().url());
    await route.fulfill({ status: 404, body: "tile not found" });
  });
  await page.route("**/api/textures/manifest", async (route) => {
    await route.fulfill({ status: 404, body: "texture manifest not found" });
  });
  await page.route("**/api/lands?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        version: 1,
        world: "Bedrock_level",
        dimension: "Overworld",
        updatedAt: 123,
        claims: [
          {
            id: "spawn",
            owner: "GieZi8670",
            name: "主城区",
            world: "Bedrock_level",
            dimension: "Overworld",
            minX: -375,
            maxX: -227,
            minY: 70,
            maxY: 300,
            minZ: -580,
            maxZ: -473,
            teleport: { x: -352, y: 70, z: -479 },
            publicTeleport: true,
            members: [],
            parent: "",
            children: [],
            nested: false,
            updatedAt: 123,
          },
          {
            id: "farm",
            owner: "WingXia",
            name: "农场",
            world: "Bedrock_level",
            dimension: "Overworld",
            minX: 16,
            maxX: 31,
            minY: 70,
            maxY: 300,
            minZ: -32,
            maxZ: -17,
            teleport: { x: 24, y: 70, z: -24 },
            publicTeleport: true,
            members: [],
            parent: "",
            children: [],
            nested: false,
            updatedAt: 123,
          },
        ],
      }),
    });
  });

  await page.goto("/");
  await expect(page.getByText("主城区")).toBeVisible();
  await expect(page.getByText("农场")).toBeVisible();

  await page.getByLabel("搜索领地").fill("wing");
  await expect(page.getByText("农场")).toBeVisible();
  await expect(page.getByText("主城区")).toHaveCount(0);

  await page.getByRole("button", { name: /农场/ }).click();
  await expect.poll(() => chunkQueries.some((query) => queryIncludesChunk(query, 1, -2)) || mapTileRequestsIncludeChunk(imageTileRequests, 1, -2)).toBe(true);

  await page.getByLabel("搜索领地").fill("zzz");
  await expect(page.getByText("没有匹配的公开传送领地")).toBeVisible();
});

async function pageHasGrassPixels(page: Page) {
  return page.evaluate(() => {
    const grass: [number, number, number] = [95, 159, 63];
    const closeColor = (r: number, g: number, b: number, target: [number, number, number], tolerance: number) =>
      Math.abs(r - target[0]) <= tolerance && Math.abs(g - target[1]) <= tolerance && Math.abs(b - target[2]) <= tolerance;
    return [...document.querySelectorAll<HTMLCanvasElement>("canvas.chunk-tile")].some((canvas) => {
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return false;
      }
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let index = 0; index < data.length; index += 4) {
        if (data[index + 3] === 255 && closeColor(data[index], data[index + 1], data[index + 2], grass, 48)) {
          return true;
        }
      }
      return false;
    });
  });
}

async function pageHasGrassImageTile(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLImageElement>("img.chunk-image-tile")].some((image) => {
      const style = window.getComputedStyle(image);
      const rect = image.getBoundingClientRect();
      return (
        image.complete &&
        image.naturalWidth > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        Number(style.opacity) > 0 &&
        rect.right > 0 &&
        rect.bottom > 0 &&
        rect.left < window.innerWidth &&
        rect.top < window.innerHeight
      );
    }),
  );
}

async function pageHasVisiblePlaceholderImageTile(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLImageElement>("img.chunk-image-tile")].some((image) => {
      const style = window.getComputedStyle(image);
      const rect = image.getBoundingClientRect();
      return (
        image.complete &&
        image.naturalWidth < 256 &&
        image.naturalHeight < 256 &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        Number(style.opacity) > 0 &&
        rect.right > 0 &&
        rect.bottom > 0 &&
        rect.left < window.innerWidth &&
        rect.top < window.innerHeight
      );
    }),
  );
}

async function pageHasHeightShading(page: Page) {
  return page.evaluate(() => {
    const brightness = (index: number, data: Uint8ClampedArray) => data[index] + data[index + 1] + data[index + 2];
    for (const canvas of document.querySelectorAll<HTMLCanvasElement>("canvas.chunk-tile")) {
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        continue;
      }
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let minBrightness = Infinity;
      let maxBrightness = -Infinity;
      for (let index = 0; index < data.length; index += 4) {
        if (data[index + 3] !== 255 || data[index + 1] < data[index] || data[index + 1] < data[index + 2]) {
          continue;
        }
        const value = brightness(index, data);
        minBrightness = Math.min(minBrightness, value);
        maxBrightness = Math.max(maxBrightness, value);
      }
      if (maxBrightness - minBrightness > 35) {
        return true;
      }
    }
    return false;
  });
}

async function mockBasicMap(
  page: Page,
  options: {
    world?: TestWorld;
    chunk?: TestChunk;
    chunkRoute?: (route: Route) => Promise<void>;
  } = {},
) {
  const chunk =
    options.chunk ||
    ({
      world: "Bedrock level",
      dimension: "Overworld",
      chunkX: 0,
      chunkZ: 0,
      palette: ["minecraft:grass_block"],
      blocks: Array.from({ length: 256 }, () => 0),
      heights: Array.from({ length: 256 }, () => 64),
      updatedAt: 1,
    } satisfies TestChunk);
  const world =
    options.world ||
    ({
      version: 1,
      world: "Bedrock level",
      dimension: "Overworld",
      status: "complete",
      chunkCount: 1,
      importedAt: 1,
      updatedAt: 1,
      bounds: {
        minChunkX: chunk.chunkX,
        maxChunkX: chunk.chunkX,
        minChunkZ: chunk.chunkZ,
        maxChunkZ: chunk.chunkZ,
        minBlockX: chunk.chunkX * 16,
        maxBlockX: chunk.chunkX * 16 + 15,
        minBlockZ: chunk.chunkZ * 16,
        maxBlockZ: chunk.chunkZ * 16 + 15,
      },
      sampleChunks: [{ chunkX: chunk.chunkX, chunkZ: chunk.chunkZ }],
      topBlocks: { "minecraft:grass_block": 256 },
    } satisfies TestWorld);

  await page.route("**/api/live", async (route) => route.abort());
  await page.route("**/api/lands?**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ version: 1, world: "Bedrock level", dimension: "Overworld", claims: [], updatedAt: 0 }) });
  });
  await page.route("**/api/worlds", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ worlds: [world] }) });
  });
  await page.route("**/api/chunks?**", async (route) => {
    if (options.chunkRoute) {
      await options.chunkRoute(route);
      return;
    }
    const url = new URL(route.request().url());
    const query = {
      minChunkX: Number(url.searchParams.get("minChunkX")),
      maxChunkX: Number(url.searchParams.get("maxChunkX")),
      minChunkZ: Number(url.searchParams.get("minChunkZ")),
      maxChunkZ: Number(url.searchParams.get("maxChunkZ")),
    };
    const includesChunk = queryIncludesChunk(query, chunk.chunkX, chunk.chunkZ);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ chunks: includesChunk ? [chunk] : [], missing: [] }) });
  });
  await page.route("**/api/textures/manifest", async (route) => {
    await route.fulfill({ status: 404, body: "texture manifest not found" });
  });
}

async function elementsOverlap(page: Page, firstSelector: string, secondSelector: string) {
  return page.evaluate(
    ([first, second]) => {
      const firstEl = document.querySelector(first);
      const secondEl = document.querySelector(second);
      if (!firstEl || !secondEl) {
        return false;
      }
      const a = firstEl.getBoundingClientRect();
      const b = secondEl.getBoundingClientRect();
      return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    },
    [firstSelector, secondSelector],
  );
}

async function hudMapCoverage(page: Page) {
  return page.evaluate(() => {
    const map = document.querySelector(".map-surface")?.getBoundingClientRect();
    const huds = [...document.querySelectorAll(".map-hud, .coordinate-hud")].map((el) => el.getBoundingClientRect());
    if (!map) {
      return 1;
    }
    const hudArea = huds.reduce((sum, rect) => sum + rect.width * rect.height, 0);
    return hudArea / (map.width * map.height);
  });
}

async function mapPaneTransform(page: Page) {
  return page.evaluate(() => window.getComputedStyle(document.querySelector(".leaflet-map-pane") as Element).transform);
}

async function pageHasVisibleGrassTile(page: Page) {
  return page.evaluate(() => {
    const grass: [number, number, number] = [95, 159, 63];
    const closeColor = (r: number, g: number, b: number, target: [number, number, number], tolerance: number) =>
      Math.abs(r - target[0]) <= tolerance && Math.abs(g - target[1]) <= tolerance && Math.abs(b - target[2]) <= tolerance;
    return [...document.querySelectorAll<HTMLCanvasElement>("canvas.chunk-tile")].some((canvas) => {
      const style = window.getComputedStyle(canvas);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) {
        return false;
      }
      const rect = canvas.getBoundingClientRect();
      if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth || rect.top >= window.innerHeight) {
        return false;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return false;
      }
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let index = 0; index < data.length; index += 4) {
        if (data[index + 3] === 255 && closeColor(data[index], data[index + 1], data[index + 2], grass, 48)) {
          return true;
        }
      }
      return false;
    });
  });
}

async function dragMap(page: Page, fromX: number, fromY: number, toX: number, toY: number) {
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  await page.mouse.move(toX, toY, { steps: 12 });
  await page.mouse.up();
}

function queryIncludesChunk(
  query: { minChunkX: number; maxChunkX: number; minChunkZ: number; maxChunkZ: number },
  chunkX: number,
  chunkZ: number,
) {
  return query.minChunkX <= chunkX && query.maxChunkX >= chunkX && query.minChunkZ <= chunkZ && query.maxChunkZ >= chunkZ;
}

function mapTileRequestsIncludeChunk(urls: string[], chunkX: number, chunkZ: number) {
  return urls.some((value) => {
    const match = /\/api\/map-tiles\/[^/]+\/[^/]+\/z(-?\d+)\/(-?\d+)\/(-?\d+)\.png/.exec(value);
    if (!match) {
      return false;
    }
    const zoom = Number(match[1]);
    const tileX = Number(match[2]);
    const tileZ = Number(match[3]);
    const chunksPerTile = 2 ** (4 - zoom);
    return chunkX >= tileX * chunksPerTile && chunkX <= tileX * chunksPerTile + chunksPerTile - 1 && chunkZ >= tileZ * chunksPerTile && chunkZ <= tileZ * chunksPerTile + chunksPerTile - 1;
  });
}

async function firstChunkTileHasNoDarkHoles(page: Page) {
  return page.evaluate(() => {
    const dark = [23, 32, 42];
    const grass: [number, number, number] = [95, 159, 63];
    const closeColor = (r: number, g: number, b: number, target: [number, number, number], tolerance: number) =>
      Math.abs(r - target[0]) <= tolerance && Math.abs(g - target[1]) <= tolerance && Math.abs(b - target[2]) <= tolerance;
    for (const canvas of document.querySelectorAll<HTMLCanvasElement>("canvas.chunk-tile")) {
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        continue;
      }
      for (let y = 0; y <= canvas.height - 16; y += 16) {
        for (let x = 0; x <= canvas.width - 16; x += 16) {
          const data = ctx.getImageData(x, y, 16, 16).data;
          let darkPixels = 0;
          let grassPixels = 0;
          for (let index = 0; index < data.length; index += 4) {
            if (data[index + 3] !== 255) {
              darkPixels += 1;
              continue;
            }
            if (data[index] === dark[0] && data[index + 1] === dark[1] && data[index + 2] === dark[2]) {
              darkPixels += 1;
            }
            if (closeColor(data[index], data[index + 1], data[index + 2], grass, 48)) {
              grassPixels += 1;
            }
          }
          if (grassPixels > 180 && darkPixels === 0) {
            return true;
          }
        }
      }
    }
    return false;
  });
}

async function leafBlockHasSolidFallbackUnderlay(page: Page) {
  return page.evaluate(() => {
    const dark = [23, 32, 42];
    const atlas: [number, number, number] = [31, 91, 45];
    const fallback: [number, number, number] = [63, 127, 56];
    const closeColor = (r: number, g: number, b: number, target: [number, number, number], tolerance: number) =>
      Math.abs(r - target[0]) <= tolerance && Math.abs(g - target[1]) <= tolerance && Math.abs(b - target[2]) <= tolerance;
    for (const canvas of document.querySelectorAll<HTMLCanvasElement>("canvas.chunk-tile")) {
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        continue;
      }
      for (let y = 0; y <= canvas.height - 16; y += 16) {
        for (let x = 0; x <= canvas.width - 16; x += 16) {
          const data = ctx.getImageData(x, y, 16, 16).data;
          let atlasPixels = 0;
          let fallbackPixels = 0;
          let darkOrTransparentPixels = 0;
          for (let index = 0; index < data.length; index += 4) {
            if (data[index + 3] !== 255) {
              darkOrTransparentPixels += 1;
              continue;
            }
            if (data[index] === dark[0] && data[index + 1] === dark[1] && data[index + 2] === dark[2]) {
              darkOrTransparentPixels += 1;
            }
            if (closeColor(data[index], data[index + 1], data[index + 2], atlas, 48)) {
              atlasPixels += 1;
            }
            if (closeColor(data[index], data[index + 1], data[index + 2], fallback, 48)) {
              fallbackPixels += 1;
            }
          }
          if (atlasPixels > 0 && fallbackPixels > 0) {
            return darkOrTransparentPixels === 0;
          }
        }
      }
    }
    return false;
  });
}

async function firstChunkTileHasColor(page: Page, color: [number, number, number]) {
  return page.evaluate(([r, g, b]) => {
    const closeColor = (red: number, green: number, blue: number, target: [number, number, number], tolerance: number) =>
      Math.abs(red - target[0]) <= tolerance && Math.abs(green - target[1]) <= tolerance && Math.abs(blue - target[2]) <= tolerance;
    for (const canvas of document.querySelectorAll<HTMLCanvasElement>("canvas.chunk-tile")) {
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        continue;
      }
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let index = 0; index < data.length; index += 4) {
        if (data[index + 3] === 255 && closeColor(data[index], data[index + 1], data[index + 2], [r, g, b], 48)) {
          return true;
        }
      }
    }
    return false;
  }, color);
}
