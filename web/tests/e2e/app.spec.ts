import { expect, test } from "@playwright/test";

test("loads the map application shell", async ({ page }) => {
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
  await expect(page.getByLabel("地图状态")).toContainText("区块");
  await expect(page.getByRole("heading", { name: "在线玩家" })).toBeVisible();
});

test("does not request chunk data before a world import exists", async ({ page }) => {
  let chunkRequests = 0;

  await page.route("**/api/live", async (route) => route.abort());
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
  await expect(page.getByTestId("coordinate-hud")).toHaveCount(0);
  await page.waitForTimeout(1000);
  expect(chunkRequests).toBe(0);
});

test("requests live player chunks before a world import exists", async ({ page }) => {
  let chunkRequests = 0;

  await page.route("**/api/live", async (route) => route.abort());
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
