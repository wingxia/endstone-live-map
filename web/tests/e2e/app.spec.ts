import { expect, test, type Page } from "@playwright/test";

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
  await expect(page.getByRole("heading", { name: "在线玩家" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "领地标注" })).toBeVisible();
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
  await page.route("**/api/textures/manifest", async (route) => {
    await route.fulfill({ status: 404, body: "texture manifest not found" });
  });

  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect.poll(() => chunkQueries.some((query) => query.minChunkZ <= -1 && query.maxChunkZ >= -1)).toBe(true);
  await expect.poll(() => pageHasGrassPixels(page)).toBe(true);

  await page.getByRole("button", { name: "Zoom out" }).click();
  await expect.poll(() => pageHasGrassPixels(page)).toBe(true);
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect.poll(() => pageHasGrassPixels(page)).toBe(true);
  expect(chunkQueries.some((query) => query.minChunkX <= 0 && query.maxChunkX >= 0 && query.minChunkZ <= -1 && query.maxChunkZ >= -1)).toBe(true);
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

test("requests live player chunks before a world import exists", async ({ page }) => {
  let chunkRequests = 0;

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
  await page.route("**/api/textures/manifest", async (route) => {
    await route.fulfill({ status: 404, body: "texture manifest not found" });
  });

  await page.goto("/");
  await expect(page.getByText("Wing")).toBeVisible();
  await expect(page.getByTestId("map-empty-state")).toHaveCount(0);
  await expect.poll(() => chunkRequests).toBeGreaterThan(0);
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
            members: ["wingxia"],
            parent: "",
            children: ["猪人塔"],
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
  await expect(page.getByText("白色青蛙")).toBeVisible();
  await expect(page.getByLabel("地图状态")).toContainText("2");
  await expect.poll(() => page.locator(".leaflet-interactive").count()).toBeGreaterThanOrEqual(3);
});

async function pageHasGrassPixels(page: Page) {
  return page.evaluate(() => {
    const grass = [95, 159, 63];
    return [...document.querySelectorAll<HTMLCanvasElement>("canvas.chunk-tile")].some((canvas) => {
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return false;
      }
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let index = 0; index < data.length; index += 4) {
        if (data[index] === grass[0] && data[index + 1] === grass[1] && data[index + 2] === grass[2] && data[index + 3] === 255) {
          return true;
        }
      }
      return false;
    });
  });
}

async function firstChunkTileHasNoDarkHoles(page: Page) {
  return page.evaluate(() => {
    const dark = [23, 32, 42];
    const grass = [95, 159, 63];
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
            if (data[index] === grass[0] && data[index + 1] === grass[1] && data[index + 2] === grass[2]) {
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

async function firstChunkTileHasColor(page: Page, color: [number, number, number]) {
  return page.evaluate(([r, g, b]) => {
    for (const canvas of document.querySelectorAll<HTMLCanvasElement>("canvas.chunk-tile")) {
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        continue;
      }
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let index = 0; index < data.length; index += 4) {
        if (data[index] === r && data[index + 1] === g && data[index + 2] === b && data[index + 3] === 255) {
          return true;
        }
      }
    }
    return false;
  }, color);
}
