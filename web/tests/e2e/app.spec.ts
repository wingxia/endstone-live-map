import { expect, test, type Page, type Route } from "@playwright/test";

const GREEN_TILE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAACvElEQVR4Ae3BAQGAMAACME4xozyaUTUI2859ny/ApAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZv35IwQ8yVSV2gAAAABJRU5ErkJggg==",
  "base64",
);

const AVATAR_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII=",
  "base64",
);

test("renders the operational map shell from local PNG tiles only", async ({ page }) => {
  const requests = await mockLiveMap(page, { players: false });

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Endstone Live Map" })).toBeVisible();
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect(page.getByLabel("地图状态")).toContainText("在线");
  await expect(page.getByLabel("地图状态")).toContainText("领地");
  await expect.poll(() => requests.tiles.some((url) => url.includes("/api/map-tiles/Bedrock_level/Overworld/z4/"))).toBe(true);
  await expect.poll(() => page.locator("img.chunk-image-tile").count()).toBeGreaterThan(0);
  expect(requests.legacy.length).toBe(0);
});

test("uses generated PNG tiles for every zoom level from z4 through z-1", async ({ page }) => {
  const requests = await mockLiveMap(page, { players: false });
  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect.poll(() => visibleTileSources(page).then((sources) => sources.some((url) => url.includes("/api/map-tiles/Bedrock_level/Overworld/z4/")))).toBe(true);
  for (const zoom of ["z3", "z2", "z1", "z0", "z-1"]) {
    await page.evaluate((zoomLabel) => {
      const zoomNumber = Number(String(zoomLabel).slice(1));
      const leafletMap = (window as unknown as { __endstoneLiveMapLeaflet?: { setZoom?: (zoom: number, options?: { animate?: boolean }) => void } }).__endstoneLiveMapLeaflet;
      leafletMap?.setZoom?.(zoomNumber, { animate: false });
    }, zoom);
    await expect.poll(() => visibleTileSources(page).then((sources) => sources.some((url) => url.includes(`/api/map-tiles/Bedrock_level/Overworld/${zoom}/`)))).toBe(true);
  }
  expect(requests.legacy.length).toBe(0);
});

test("shows player avatar markers, public land overlays, and coordinate copy", async ({ page }) => {
  const requests = await mockLiveMap(page);
  await page.goto("/");

  await expect(page.locator(".player-marker-avatar")).toBeVisible();
  await expect(page.locator(".player-marker-name", { hasText: "Wing" })).toBeVisible();
  await expect(page.getByRole("button", { name: /主城区/ })).toBeVisible();
  await expect.poll(() => requests.avatars.length).toBeGreaterThan(0);

  const rectangles = await page.locator("path.leaflet-interactive").count();
  expect(rectangles).toBeGreaterThan(0);

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
  await page.mouse.click(180, 180);
  await page.getByTestId("coordinate-copy").click();
  const copied = await page.evaluate(() => (window as unknown as { __copiedCoordinates: string[] }).__copiedCoordinates.at(-1));
  expect(copied).toMatch(/^-?\d+, \d+, -?\d+$/);
  expect(requests.legacy.length).toBe(0);
});

test("keeps mobile map HUDs compact and non-overlapping", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockLiveMap(page);
  await page.goto("/");

  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect(page.getByTestId("coordinate-copy")).toBeVisible();
  await expect(page.locator(".player-marker-frame")).toBeVisible();
  expect(await elementsOverlap(page, ".map-hud", ".coordinate-hud")).toBe(false);
  expect(await hudMapCoverage(page)).toBeLessThan(0.26);
});

async function mockLiveMap(page: Page, options: { players?: boolean } = {}) {
  const includePlayers = options.players !== false;
  const requests = { tiles: [] as string[], avatars: [] as string[], legacy: [] as string[] };
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/api/chunks") || url.includes("/api/textures") || url.includes("/textures/")) {
      requests.legacy.push(url);
    }
  });

  await page.route("**/api/live", async (route) => route.abort());
  await page.route("**/api/players", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        players: includePlayers
          ? [
          {
            id: "player-wing",
            name: "Wing",
            xuid: "xuid-1",
            world: "Bedrock level",
            dimension: "Overworld",
            x: 18,
            y: 72,
            z: -22,
            yaw: 120,
            pitch: 0,
            avatarHash: "abc123",
            avatarUrl: "/api/players/player-wing/avatar.png?_=abc123",
            updatedAt: 10,
          },
          ]
          : [],
      }),
    });
  });
  await page.route("**/api/players/**/avatar.png**", async (route) => {
    requests.avatars.push(route.request().url());
    await route.fulfill({ contentType: "image/png", body: AVATAR_PNG });
  });
  await page.route("**/api/lands?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        version: 1,
        world: "Bedrock level",
        dimension: "Overworld",
        updatedAt: 10,
        claims: [
          {
            id: "spawn",
            owner: "GieZi8670",
            name: "主城区",
            world: "Bedrock level",
            dimension: "Overworld",
            minX: -32,
            maxX: 48,
            minY: 60,
            maxY: 160,
            minZ: -64,
            maxZ: 32,
            teleport: { x: 8, y: 72, z: -16 },
            members: [],
            parent: "",
            children: [],
            nested: false,
            publicTeleport: true,
            updatedAt: 10,
          },
        ],
      }),
    });
  });
  await page.route("**/api/worlds", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        worlds: [
          {
            version: 2,
            world: "Bedrock level",
            dimension: "Overworld",
            status: "live",
            chunkCount: 81,
            importedAt: 1,
            updatedAt: 10,
            bounds: {
              minChunkX: -4,
              maxChunkX: 4,
              minChunkZ: -4,
              maxChunkZ: 4,
              minBlockX: -64,
              maxBlockX: 79,
              minBlockZ: -64,
              maxBlockZ: 79,
            },
            sampleChunks: [{ chunkX: 0, chunkZ: 0 }],
            topBlocks: {},
          },
        ],
      }),
    });
  });
  await page.route("**/api/map-tiles/**", async (route: Route) => {
    requests.tiles.push(route.request().url());
    await route.fulfill({ contentType: "image/png", body: GREEN_TILE_PNG });
  });
  await page.route("**/api/chunks?**", async (route) => {
    requests.legacy.push(route.request().url());
    await route.fulfill({ status: 410, body: "chunk json disabled" });
  });
  await page.route("**/api/textures/**", async (route) => {
    requests.legacy.push(route.request().url());
    await route.fulfill({ status: 410, body: "texture atlas disabled" });
  });
  return requests;
}

async function elementsOverlap(page: Page, leftSelector: string, rightSelector: string) {
  return page.evaluate(
    ([left, right]) => {
      const a = document.querySelector(left);
      const b = document.querySelector(right);
      if (!a || !b) return false;
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return !(ar.right <= br.left || ar.left >= br.right || ar.bottom <= br.top || ar.top >= br.bottom);
    },
    [leftSelector, rightSelector],
  );
}

async function visibleTileSources(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLImageElement>("img.chunk-image-tile")]
      .filter((image) => {
        const style = window.getComputedStyle(image);
        const rect = image.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      })
      .map((image) => image.src),
  );
}

async function hudMapCoverage(page: Page) {
  return page.evaluate(() => {
    const map = document.querySelector(".map-surface")?.getBoundingClientRect();
    if (!map) return 1;
    const huds = [...document.querySelectorAll(".map-hud, .coordinate-hud")].map((element) => element.getBoundingClientRect());
    const area = huds.reduce((sum, rect) => sum + rect.width * rect.height, 0);
    return area / (map.width * map.height);
  });
}
