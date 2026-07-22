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
  await expect.poll(() => requests.tiles.some((url) => url.includes("/api/local-map-tiles/Bedrock_level/Overworld/z4/"))).toBe(true);
  await expect.poll(() => page.locator("img.chunk-image-tile").count()).toBeGreaterThan(0);
  expect(requests.legacy.length).toBe(0);
});

test("refreshes visible tiles and world metadata after live tile updates", async ({ page }) => {
  await installMockLiveSocket(page);
  const requests = await mockLiveMap(page, {
    players: false,
    expandWorldBoundsAfterFirstFetch: true,
    versionedTileDelayMs: 400,
  });

  await page.goto("/");

  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect.poll(() => visibleTileSources(page).then((sources) => sources.some((url) => url.includes("_=10")))).toBe(true);
  await page.evaluate(() => {
    const map = (window as unknown as {
      __endstoneLiveMapLeaflet?: { setView?: (center: [number, number], zoom: number, options?: { animate?: boolean }) => void };
    }).__endstoneLiveMapLeaflet;
    map?.setView?.([16, -16], 4, { animate: false });
  });
  await expect.poll(() => visibleTileSources(page).then((sources) => sources.some((url) => url.includes("/z4/0/0.png")))).toBe(true);
  const unchangedTile = await visibleTileSources(page).then((sources) =>
    sources.find((url) => url.includes("/z4/") && !url.includes("/z4/0/0.png")),
  );
  const changedTile = await visibleTileSources(page).then((sources) => sources.find((url) => url.includes("/z4/0/0.png")));
  expect(unchangedTile).toBeTruthy();
  expect(changedTile).toBeTruthy();
  const userView = await leafletView(page);

  await page.evaluate(() => {
    (window as unknown as { __liveMapSocketSend: (data: string) => void }).__liveMapSocketSend(
      JSON.stringify({
        type: "tiles_ready",
        updatedAt: 999,
        chunks: [],
        tiles: [
          {
            world: "Bedrock level",
            dimension: "Overworld",
            zoom: 4,
            tileX: 0,
            tileZ: 0,
            updatedAt: 999,
            hasPixels: true,
          },
        ],
      }),
    );
  });

  await page.waitForTimeout(100);
  await expect.poll(() => visibleTileSources(page).then((sources) => sources.includes(changedTile!))).toBe(true);
  expect(await leafletView(page)).toEqual(userView);
  await expect.poll(() => visibleTileSources(page).then((sources) => sources.some((url) => url.includes("_=999")))).toBe(true);
  await expect.poll(() => visibleTileSources(page).then((sources) => sources.includes(unchangedTile!))).toBe(true);
  await expect.poll(() => requests.worlds).toBeGreaterThan(1);
  expect(await leafletView(page)).toEqual(userView);
  expect(requests.legacy.length).toBe(0);
});

test("constrains navigation to explored bounds and restores the initial view", async ({ page }) => {
  await mockLiveMap(page, { players: false });
  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();

  await expect.poll(() => leafletView(page).then(({ zoom }) => zoom)).toBe(4);
  const initial = await leafletView(page);

  await page.evaluate(() => {
    const map = (window as unknown as {
      __endstoneLiveMapLeaflet?: { setView?: (center: [number, number], zoom: number, options?: { animate?: boolean }) => void };
    }).__endstoneLiveMapLeaflet;
    map?.setView?.([50_000, 50_000], 4, { animate: false });
  });
  await expect.poll(() => leafletView(page).then(({ lat, lng }) => Math.max(Math.abs(lat), Math.abs(lng)))).toBeLessThan(500);

  await page.evaluate(() => {
    const map = (window as unknown as {
      __endstoneLiveMapLeaflet?: { setView?: (center: [number, number], zoom: number, options?: { animate?: boolean }) => void };
    }).__endstoneLiveMapLeaflet;
    map?.setView?.([32, 32], 2, { animate: false });
  });
  await expect.poll(() => leafletView(page).then(({ zoom }) => zoom)).toBe(2);
  await page.getByRole("button", { name: "返回初始视角" }).click();
  await expect.poll(() => leafletView(page).then(({ zoom }) => zoom)).toBe(initial.zoom);
  await expect.poll(() => leafletView(page).then(({ lat }) => Math.abs(lat - initial.lat))).toBeLessThan(0.01);
  await expect.poll(() => leafletView(page).then(({ lng }) => Math.abs(lng - initial.lng))).toBeLessThan(0.01);
});

test("uses generated PNG tiles for every zoom level from z4 through z-8", async ({ page }) => {
  const requests = await mockLiveMap(page, { players: false });
  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect.poll(() => visibleTileSources(page).then((sources) => sources.some((url) => url.includes("/api/local-map-tiles/Bedrock_level/Overworld/z4/")))).toBe(true);
  for (const zoom of ["z3", "z2", "z1", "z0", "z-1", "z-2", "z-3", "z-4", "z-5", "z-6", "z-7", "z-8"]) {
    await page.evaluate((zoomLabel) => {
      const zoomNumber = Number(String(zoomLabel).slice(1));
      const leafletMap = (window as unknown as { __endstoneLiveMapLeaflet?: { setZoom?: (zoom: number, options?: { animate?: boolean }) => void } }).__endstoneLiveMapLeaflet;
      leafletMap?.setZoom?.(zoomNumber, { animate: false });
    }, zoom);
    await expect.poll(() => visibleTileSources(page).then((sources) => sources.some((url) => url.includes(`/api/local-map-tiles/Bedrock_level/Overworld/${zoom}/`)))).toBe(true);
  }
  expect(requests.legacy.length).toBe(0);
});

test("keeps map tiles visible while zooming out beyond the generated tile floor", async ({ page }) => {
  const requests = await mockLiveMap(page, { players: false });
  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect.poll(() => visibleTileSources(page).then((sources) => sources.some((url) => url.includes("/api/local-map-tiles/Bedrock_level/Overworld/z4/")))).toBe(true);

  await page.evaluate(() => {
    const leafletMap = (window as unknown as { __endstoneLiveMapLeaflet?: { setZoom?: (zoom: number, options?: { animate?: boolean }) => void } }).__endstoneLiveMapLeaflet;
    leafletMap?.setZoom?.(-8, { animate: false });
  });

  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __endstoneLiveMapLeaflet?: { getZoom?: () => number } }).__endstoneLiveMapLeaflet?.getZoom?.()),
    )
    .toBe(-8);
  await expect.poll(() => visibleTileSources(page).then((sources) => sources.some((url) => url.includes("/api/local-map-tiles/Bedrock_level/Overworld/z-8/")))).toBe(true);
  expect(requests.tiles.some((url) => /\/z-9\//.test(url))).toBe(false);
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

test("removes player markers when the plugin publishes an empty online snapshot", async ({ page }) => {
  await installMockLiveSocket(page);
  await mockLiveMap(page);
  await page.goto("/");

  await expect(page.locator(".player-marker-name", { hasText: "Wing" })).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __liveMapSocketSend: (data: string) => void }).__liveMapSocketSend(
      JSON.stringify({ type: "player_snapshot", players: [] }),
    );
  });

  await expect(page.locator(".player-marker-name", { hasText: "Wing" })).toHaveCount(0);
  await expect(page.getByText("当前维度没有在线玩家")).toBeVisible();
});

test("keeps mobile map HUDs compact and non-overlapping", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockLiveMap(page);
  await page.goto("/");

  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect(page.getByTestId("coordinate-copy")).toBeVisible();
  await expect(page.getByTestId("coordinate-hud")).not.toContainText("已渲染瓦片");
  expect(await page.locator(".coordinate-block").count()).toBe(0);
  await expect(page.locator(".player-marker-frame")).toBeVisible();
  expect(await elementsOverlap(page, ".map-hud", ".coordinate-hud")).toBe(false);
  const mapHud = await page.locator(".map-hud").boundingBox();
  const coordinateHud = await page.getByTestId("coordinate-hud").boundingBox();
  expect(mapHud).not.toBeNull();
  expect(coordinateHud).not.toBeNull();
  expect(mapHud!.width).toBeLessThanOrEqual(260);
  expect(mapHud!.height).toBeLessThanOrEqual(52);
  expect(coordinateHud!.width).toBeLessThanOrEqual(270);
  expect(coordinateHud!.height).toBeLessThanOrEqual(54);
  await expect(page.getByTestId("coordinate-hud")).not.toContainText("复制坐标");
  expect(await hudMapCoverage(page)).toBeLessThan(0.13);
});

async function mockLiveMap(
  page: Page,
  options: { players?: boolean; expandWorldBoundsAfterFirstFetch?: boolean; versionedTileDelayMs?: number } = {},
) {
  const includePlayers = options.players !== false;
  const requests = { tiles: [] as string[], avatars: [] as string[], legacy: [] as string[], worlds: 0 };
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
    requests.worlds += 1;
    const expanded = options.expandWorldBoundsAfterFirstFetch === true && requests.worlds > 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        worlds: [
          {
            version: 2,
            world: "Bedrock level",
            dimension: "Overworld",
            status: "live",
            chunkCount: 10971,
            importedAt: 1,
            updatedAt: expanded ? 999 : 10,
            bounds: {
              minChunkX: expanded ? -8 : -4,
              maxChunkX: expanded ? 8 : 4,
              minChunkZ: expanded ? -8 : -4,
              maxChunkZ: expanded ? 8 : 4,
              minBlockX: expanded ? -128 : -64,
              maxBlockX: expanded ? 143 : 79,
              minBlockZ: expanded ? -128 : -64,
              maxBlockZ: expanded ? 143 : 79,
            },
            sampleChunks: [{ chunkX: 0, chunkZ: 0 }],
            topBlocks: {},
          },
        ],
      }),
    });
  });
  await page.route("**/api/local-map-tiles/**", async (route: Route) => {
    requests.tiles.push(route.request().url());
    if (options.versionedTileDelayMs && route.request().url().includes("_=999")) {
      await new Promise((resolve) => setTimeout(resolve, options.versionedTileDelayMs));
    }
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

async function installMockLiveSocket(page: Page) {
  await page.addInitScript(() => {
    const sockets: Array<EventTarget & { close: () => void; send: () => void; __message: (data: string) => void; readyState: number }> = [];
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
        sockets.push(this);
        window.setTimeout(() => this.dispatchEvent(new Event("open")), 0);
      }

      send() {}

      close() {
        this.readyState = MockWebSocket.CLOSED;
        this.dispatchEvent(new Event("close"));
      }

      __message(data: string) {
        this.dispatchEvent(new MessageEvent("message", { data }));
      }
    }

    (window as unknown as { WebSocket: typeof WebSocket }).WebSocket = MockWebSocket as unknown as typeof WebSocket;
    (window as unknown as { __liveMapSocketSend: (data: string) => void }).__liveMapSocketSend = (data: string) => {
      for (const socket of sockets) {
        socket.__message(data);
      }
    };
  });
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

async function leafletView(page: Page) {
  return page.evaluate(() => {
    const map = (window as unknown as {
      __endstoneLiveMapLeaflet?: { getCenter?: () => { lat: number; lng: number }; getZoom?: () => number };
    }).__endstoneLiveMapLeaflet;
    const center = map?.getCenter?.() || { lat: Number.NaN, lng: Number.NaN };
    return { lat: center.lat, lng: center.lng, zoom: map?.getZoom?.() ?? Number.NaN };
  });
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
