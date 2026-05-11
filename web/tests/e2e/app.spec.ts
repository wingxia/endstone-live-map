import { expect, test } from "@playwright/test";

test("loads the map application shell", async ({ page }) => {
  await page.route("**/api/markers", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        markers: [
          {
            id: "spawn",
            world: "Bedrock level",
            dimension: "Overworld",
            x: 0,
            y: 64,
            z: 0,
            title: "Spawn",
            description: "Main hub",
            createdBy: "Wing",
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    });
  });
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
  await expect(page.getByTestId("coordinate-hud")).toContainText("X 0, Z 0");
  await expect(page.getByTestId("coordinate-hud")).toContainText("区块");
  await expect(page.getByLabel("地图状态")).toContainText("区块");
  await expect(page.getByText("Spawn")).toBeVisible();
});

test("does not request chunk data before a world import exists", async ({ page }) => {
  let chunkRequests = 0;

  await page.route("**/api/markers", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ markers: [] }) });
  });
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
  await expect(page.getByTestId("map-empty-state")).toContainText("暂无已导入地图数据");
  await expect(page.getByTestId("coordinate-hud")).toContainText("未加载");
  await page.waitForTimeout(1000);
  expect(chunkRequests).toBe(0);
});
