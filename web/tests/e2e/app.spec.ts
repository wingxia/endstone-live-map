import { expect, test, type Page, type Route } from "@playwright/test";

const GREEN_TILE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAACvElEQVR4Ae3BAQGAMAACME4xozyaUTUI2859ny/ApAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZjXArAaY1QCzGmBWA8xqgFkNMKsBZv35IwQ8yVSV2gAAAABJRU5ErkJggg==",
  "base64",
);

const AVATAR_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII=",
  "base64",
);
const MAP_CENTER_TOLERANCE = 0.05;

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

test("uses the newest available world when the configured default is absent", async ({ page }) => {
  const requests = await mockLiveMap(page, { players: false, world: "ExchangeTest" });

  await page.goto("/");

  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect(page.getByLabel("地图状态")).toContainText("10,971");
  await expect
    .poll(() => requests.tiles.some((url) => url.includes("/api/local-map-tiles/ExchangeTest/Overworld/z4/")))
    .toBe(true);
  await expect
    .poll(() => requests.lands.some((url) => url.includes("world=ExchangeTest")))
    .toBe(true);
});

test("updates tiles during map interaction with a bounded buffer", async ({ page }) => {
  const requests = await mockLiveMap(page, { players: false, tileDelayMs: 40 });
  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();

  await expect
    .poll(() =>
      page.evaluate(() => {
        const map = (window as unknown as {
          __endstoneLiveMapLeaflet?: {
            eachLayer?: (callback: (layer: { options?: Record<string, unknown> }) => void) => void;
          };
        }).__endstoneLiveMapLeaflet;
        const gridLayerOptions: Array<Record<string, unknown>> = [];
        map?.eachLayer?.((layer) => {
          if (layer.options?.className === "chunk-grid-layer") {
            gridLayerOptions.push(layer.options);
          }
        });
        const gridOptions = gridLayerOptions[0];
        return gridOptions
          ? {
              updateWhenIdle: gridOptions.updateWhenIdle,
              updateInterval: gridOptions.updateInterval,
              updateWhenZooming: gridOptions.updateWhenZooming,
              keepBuffer: gridOptions.keepBuffer,
            }
          : null;
      }),
    )
    .toEqual({
      updateWhenIdle: true,
      updateInterval: 250,
      updateWhenZooming: false,
      keepBuffer: 1,
    });

  await expect.poll(() => visibleZoomTilesReady(page, 4)).toBe(true);
  await page.waitForTimeout(300);
  const tileRequestsBeforeDrag = requests.tiles.length;
  const mapBounds = await page.getByTestId("map-canvas").boundingBox();
  expect(mapBounds).not.toBeNull();
  const startX = mapBounds!.x + mapBounds!.width / 2;
  const startY = mapBounds!.y + mapBounds!.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX - 140, startY + 60, { steps: 12 });
  await page.waitForTimeout(350);
  expect(requests.tiles).toHaveLength(tileRequestsBeforeDrag);
  await page.mouse.up();
});

test("refreshes visible tiles and world metadata after live tile updates", async ({ page }) => {
  await installMockLiveSocket(page);
  const requests = await mockLiveMap(page, { players: false });

  await page.goto("/");

  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect.poll(() => visibleTileSources(page).then((sources) => sources.length)).toBeGreaterThan(0);
  expect((await visibleTileSources(page)).every((url) => !url.includes("_="))).toBe(true);
  const unchangedTile = await visibleTileSources(page).then((sources) =>
    sources.find((url) => url.includes("/z4/") && !url.includes("/z4/0/0.png")),
  );
  expect(unchangedTile).toBeTruthy();

  await page.evaluate(() => {
    const send = (updatedAt: number) =>
      (window as unknown as { __liveMapSocketSend: (data: string) => void }).__liveMapSocketSend(
        JSON.stringify({
          type: "tiles_ready",
          updatedAt,
          worlds: [{
            version: 2,
            world: "Bedrock level",
            dimension: "Overworld",
            status: "live",
            chunkCount: 10_972,
            importedAt: 1,
            updatedAt,
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
          }],
          chunks: [],
          tiles: [
            {
              world: "Bedrock level",
              dimension: "Overworld",
              zoom: 4,
              tileX: 0,
              tileZ: 0,
              updatedAt,
              hasPixels: true,
            },
          ],
        }),
      );
    send(997);
    send(998);
    send(999);
  });

  await expect.poll(() => visibleTileSources(page).then((sources) => sources.some((url) => url.includes("_=999")))).toBe(true);
  await expect.poll(() => visibleTileSources(page).then((sources) => sources.includes(unchangedTile!))).toBe(true);
  await expect(page.getByLabel("地图状态")).toContainText("10,972");
  expect(requests.worlds).toBe(1);
  expect(requests.legacy.length).toBe(0);
});

test("waits for world metadata before requesting stable revalidating tile URLs", async ({ page }) => {
  const requests = await mockLiveMap(page, { holdWorlds: true });

  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect.poll(() => requests.worlds).toBe(1);

  expect(requests.tiles).toHaveLength(0);
  requests.releaseWorlds();
  await expect.poll(() => requests.tiles.length).toBeGreaterThan(0);
  expect(requests.tiles.every((url) => !url.includes("_="))).toBe(true);
});

test("uses opaque map overlays without backdrop-filter recomposition", async ({ page }) => {
  await mockLiveMap(page);
  await page.goto("/");

  await expect(page.locator(".player-marker-name")).toBeVisible();
  const overlayStyles = await page
    .locator(".map-hud, .coordinate-hud, .leaflet-control-zoom, .map-home-control, .player-marker-name")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        return {
          backdropFilter: style.backdropFilter,
          webkitBackdropFilter: (style as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter,
          backgroundColor: style.backgroundColor,
        };
      }),
    );

  expect(overlayStyles.length).toBeGreaterThan(0);
  expect(overlayStyles.every(({ backdropFilter }) => !backdropFilter || backdropFilter === "none")).toBe(true);
  expect(overlayStyles.every(({ webkitBackdropFilter }) => !webkitBackdropFilter || webkitBackdropFilter === "none")).toBe(true);
  expect(overlayStyles.every(({ backgroundColor }) => /rgba?\(/.test(backgroundColor))).toBe(true);
});

test("opens at the birthplace, constrains navigation, and returns home", async ({ page }) => {
  await mockLiveMap(page, {
    players: false,
    birthplace: { x: -352, y: 70, z: -479 },
  });
  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();

  await expect.poll(() => leafletView(page).then(({ zoom }) => zoom)).toBe(4);
  await expect.poll(() => leafletView(page).then(({ lat }) => Math.abs(lat - 479))).toBeLessThan(MAP_CENTER_TOLERANCE);
  await expect.poll(() => leafletView(page).then(({ lng }) => Math.abs(lng + 352))).toBeLessThan(MAP_CENTER_TOLERANCE);

  await page.evaluate(() => {
    const map = (window as unknown as {
      __endstoneLiveMapLeaflet?: { setView?: (center: [number, number], zoom: number, options?: { animate?: boolean }) => void };
    }).__endstoneLiveMapLeaflet;
    map?.setView?.([50_000, 50_000], 4, { animate: false });
  });
  await expect.poll(() => leafletView(page).then(({ lat, lng }) => Math.max(Math.abs(lat), Math.abs(lng)))).toBeLessThan(1_000);

  await page.evaluate(() => {
    const map = (window as unknown as {
      __endstoneLiveMapLeaflet?: { setView?: (center: [number, number], zoom: number, options?: { animate?: boolean }) => void };
    }).__endstoneLiveMapLeaflet;
    map?.setView?.([32, 32], 2, { animate: false });
  });
  await expect.poll(() => leafletView(page).then(({ zoom }) => zoom)).toBe(2);
  await page.getByRole("button", { name: "定位到出生地" }).click();
  await expect.poll(() => leafletView(page).then(({ zoom }) => zoom)).toBe(4);
  await expect.poll(() => leafletView(page).then(({ lat }) => Math.abs(lat - 479))).toBeLessThan(MAP_CENTER_TOLERANCE);
  await expect.poll(() => leafletView(page).then(({ lng }) => Math.abs(lng + 352))).toBeLessThan(MAP_CENTER_TOLERANCE);
});

test("uses generated PNG tiles for every zoom level from z4 through z-8", async ({ page }) => {
  const requests = await mockLiveMap(page, { players: false, tileDelayMs: 40 });
  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect.poll(() => visibleZoomTilesReady(page, 4), { timeout: 2_500 }).toBe(true);
  const settleTimes: number[] = [];
  for (const zoom of [3, 2, 1, 0, -1, -2, -3, -4, -5, -6, -7, -8]) {
    const startedAt = Date.now();
    await page.evaluate((zoomNumber) => {
      const leafletMap = (window as unknown as { __endstoneLiveMapLeaflet?: { setZoom?: (zoom: number, options?: { animate?: boolean }) => void } }).__endstoneLiveMapLeaflet;
      leafletMap?.setZoom?.(zoomNumber, { animate: false });
    }, zoom);
    await expect.poll(() => visibleZoomTilesReady(page, zoom), { timeout: 2_500 }).toBe(true);
    settleTimes.push(Date.now() - startedAt);
  }
  expect(Math.max(...settleTimes)).toBeLessThan(2_000);
  expect(requests.tiles.every((url) => !url.includes("_="))).toBe(true);
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
  expect(copied).toMatch(/^-?\d+, (?:\d+|~), -?\d+$/);
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

test("moves an unchanged player marker without rebuilding its DOM", async ({ page }) => {
  await installMockLiveSocket(page);
  await mockLiveMap(page);
  await page.goto("/");

  const marker = page.locator(".player-marker").first();
  await expect(marker).toBeVisible();
  const initialTransform = await marker.getAttribute("style");
  await marker.evaluate((element) => {
    element.setAttribute("data-marker-instance", "preserved");
  });

  await page.evaluate(() => {
    (window as unknown as { __liveMapSocketSend: (data: string) => void }).__liveMapSocketSend(
      JSON.stringify({
        type: "player_snapshot",
        players: [{
          id: "player-wing",
          name: "Wing",
          xuid: "xuid-1",
          world: "Bedrock level",
          dimension: "Overworld",
          x: 46,
          y: 72,
          z: -35,
          yaw: 120,
          pitch: 0,
          avatarHash: "abc123",
          avatarUrl: "/api/players/player-wing/avatar.png?_=abc123",
          updatedAt: 20,
        }],
      }),
    );
  });

  await expect.poll(() => marker.getAttribute("style")).not.toBe(initialTransform);
  await expect(marker).toHaveAttribute("data-marker-instance", "preserved");
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
  expect(await elementsOverlap(page, ".map-home-control", ".coordinate-hud")).toBe(false);
  const mapHud = await page.locator(".map-hud").boundingBox();
  const coordinateHud = await page.getByTestId("coordinate-hud").boundingBox();
  const mapHome = await page.getByTestId("map-home-control").boundingBox();
  const mapCanvas = await page.getByTestId("map-canvas").boundingBox();
  expect(mapHud).not.toBeNull();
  expect(coordinateHud).not.toBeNull();
  expect(mapHome).not.toBeNull();
  expect(mapCanvas).not.toBeNull();
  expect(mapHome!.x).toBeLessThan(mapCanvas!.x + mapCanvas!.width / 2);
  expect(mapHud!.width).toBeLessThanOrEqual(260);
  expect(mapHud!.height).toBeLessThanOrEqual(52);
  expect(coordinateHud!.width).toBeLessThanOrEqual(270);
  expect(coordinateHud!.height).toBeLessThanOrEqual(54);
  await expect(page.getByTestId("coordinate-hud")).not.toContainText("复制坐标");
  expect(await hudMapCoverage(page)).toBeLessThan(0.13);
});

test("keeps the map primary and makes mobile panels and locations easy to reach", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockLiveMap(page, { landCount: 14 });
  await page.goto("/");

  const mapCanvas = page.getByTestId("map-canvas");
  const navigation = page.getByTestId("mobile-navigation");
  await expect(mapCanvas).toBeVisible();
  await expect(navigation).toBeVisible();
  await expect(navigation.locator("button")).toHaveCount(3);
  await expect(navigation.getByText("地图", { exact: true })).toHaveCount(0);

  const mapBounds = await mapCanvas.boundingBox();
  const navigationBounds = await navigation.boundingBox();
  expect(mapBounds).not.toBeNull();
  expect(navigationBounds).not.toBeNull();
  expect(mapBounds!.height).toBeGreaterThanOrEqual(844 * 0.85);
  expect(mapBounds!.y + mapBounds!.height).toBeLessThanOrEqual(navigationBounds!.y + 1);
  expect(
    await navigation.locator("button").evaluateAll((buttons) =>
      buttons.every((button) => {
        const bounds = button.getBoundingClientRect();
        return bounds.width >= 44 && bounds.height >= 44;
      }),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => ({
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      verticalOverflow: document.documentElement.scrollHeight > window.innerHeight,
    })),
  ).toEqual({ horizontalOverflow: false, verticalOverflow: false });

  for (const height of [700, 844]) {
    await page.setViewportSize({ width: 390, height });
    await expect.poll(async () => {
      const bounds = await navigation.boundingBox();
      return bounds ? Math.abs(bounds.y + bounds.height - height) : Number.POSITIVE_INFINITY;
    }).toBeLessThanOrEqual(1);
  }

  await page.evaluate(() => {
    const map = (window as unknown as {
      __endstoneLiveMapLeaflet?: { setView?: (center: [number, number], zoom: number, options?: { animate?: boolean }) => void };
    }).__endstoneLiveMapLeaflet;
    map?.setView?.([32, 32], 4, { animate: false });
  });
  await page.getByRole("button", { name: "公开领地，14 个" }).click();
  await expect(page.getByTestId("mobile-panel")).toBeVisible();
  const landSearch = page.locator(".mobile-land-search");
  const landTitle = page.locator(".mobile-panel-copy strong");
  const landMeta = page.locator(".mobile-panel-copy span");
  await expect(landSearch).toBeVisible();
  await expect(page.locator(".mobile-land-panel-heading")).toHaveAttribute("data-land-search-position", "stacked");
  const stackedSearch = await landSearch.boundingBox();
  const stackedTitle = await landTitle.boundingBox();
  const stackedMeta = await landMeta.boundingBox();
  expect(stackedSearch).not.toBeNull();
  expect(stackedTitle).not.toBeNull();
  expect(stackedMeta).not.toBeNull();
  expect(stackedSearch!.y).toBeGreaterThan(stackedTitle!.y + stackedTitle!.height);
  expect(stackedSearch!.y).toBeGreaterThan(stackedMeta!.y + stackedMeta!.height);
  await page.getByTestId("mobile-panel").hover();
  await page.mouse.wheel(0, 420);
  await expect(page.locator(".mobile-land-panel-heading")).toHaveAttribute("data-land-search-position", "inline");
  const inlineSearch = await landSearch.boundingBox();
  const inlineTitle = await landTitle.boundingBox();
  expect(inlineSearch).not.toBeNull();
  expect(inlineTitle).not.toBeNull();
  expect(inlineSearch!.x).toBeGreaterThan(inlineTitle!.x + inlineTitle!.width);
  expect(Math.abs(inlineSearch!.y - inlineTitle!.y)).toBeLessThanOrEqual(12);
  await expect(page.getByRole("button", { name: "关闭信息面板" })).toBeVisible();
  await mapCanvas.click({ position: { x: 200, y: 150 } });
  await expect(page.getByTestId("mobile-panel")).toBeHidden();

  await page.getByRole("button", { name: "公开领地，14 个" }).click();
  await page.getByRole("button", { name: /主城区/ }).click();
  await expect(page.getByTestId("mobile-panel")).toBeHidden();
  await expect.poll(() => leafletView(page).then(({ lat }) => Math.abs(lat - 16))).toBeLessThan(MAP_CENTER_TOLERANCE);
  await expect.poll(() => leafletView(page).then(({ lng }) => Math.abs(lng - 8))).toBeLessThan(MAP_CENTER_TOLERANCE);

  await page.evaluate(() => {
    const map = (window as unknown as {
      __endstoneLiveMapLeaflet?: { setView?: (center: [number, number], zoom: number, options?: { animate?: boolean }) => void };
    }).__endstoneLiveMapLeaflet;
    map?.setView?.([0, 0], 4, { animate: false });
  });
  await page.getByRole("button", { name: "在线玩家，1 人" }).click();
  await page.getByRole("button", { name: /Wing/ }).click();
  await expect(page.getByTestId("mobile-panel")).toBeHidden();
  await expect.poll(() => leafletView(page).then(({ lat }) => Math.abs(lat - 22))).toBeLessThan(MAP_CENTER_TOLERANCE);
  await expect.poll(() => leafletView(page).then(({ lng }) => Math.abs(lng - 18))).toBeLessThan(MAP_CENTER_TOLERANCE);

  await page.getByRole("button", { name: "切换维度，当前主世界" }).click();
  await expect(page.getByRole("tab", { name: "下界（Nether）" })).toBeVisible();
  await page.getByRole("tab", { name: "下界（Nether）" }).click();
  await expect(page.getByTestId("mobile-panel")).toBeHidden();
  await expect(page.getByLabel("地图状态")).toContainText("下界");
});

async function mockLiveMap(
  page: Page,
  options: {
    players?: boolean;
    world?: string;
    holdWorlds?: boolean;
    tileDelayMs?: number;
    birthplace?: { x: number; y: number; z: number };
    landCount?: number;
  } = {},
) {
  const includePlayers = options.players !== false;
  const worldName = options.world ?? "Bedrock level";
  let releaseWorlds = () => {};
  const worldsGate = options.holdWorlds
    ? new Promise<void>((resolve) => {
        releaseWorlds = resolve;
      })
    : Promise.resolve();
  const requests = {
    tiles: [] as string[],
    avatars: [] as string[],
    lands: [] as string[],
    legacy: [] as string[],
    worlds: 0,
    releaseWorlds,
  };
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
            world: worldName,
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
    requests.lands.push(route.request().url());
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        version: 1,
        world: worldName,
        dimension: "Overworld",
        updatedAt: 10,
        claims: Array.from({ length: options.landCount ?? 1 }, (_, index) => (
          {
            id: index === 0 ? "spawn" : `public-${index}`,
            owner: "GieZi8670",
            name: index === 0 ? "主城区" : `公开领地${index}`,
            world: worldName,
            dimension: "Overworld",
            minX: -32 + index * 96,
            maxX: 48 + index * 96,
            minY: 60,
            maxY: 160,
            minZ: -64 + index * 96,
            maxZ: 32 + index * 96,
            teleport: index === 0 ? (options.birthplace ?? { x: 8, y: 72, z: -16 }) : { x: index * 96, y: 72, z: index * 96 },
            members: [],
            parent: "",
            children: [],
            nested: false,
            publicTeleport: true,
            updatedAt: 10,
          }
        )),
      }),
    });
  });
  await page.route("**/api/worlds", async (route) => {
    requests.worlds += 1;
    await worldsGate;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        worlds: [
          {
            version: 2,
            world: worldName,
            dimension: "Overworld",
            status: "live",
            chunkCount: 10971,
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
  await page.route("**/api/local-map-tiles/**", async (route: Route) => {
    requests.tiles.push(route.request().url());
    if (options.tileDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.tileDelayMs));
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

async function visibleZoomTilesReady(page: Page, zoom: number) {
  return page.evaluate((zoomLabel) => {
    const images = [...document.querySelectorAll<HTMLImageElement>("img.chunk-image-tile")].filter((image) => {
      const style = window.getComputedStyle(image);
      const rect = image.getBoundingClientRect();
      return (
        image.src.includes(`/z${zoomLabel}/`) &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    });
    return images.length > 0 && images.every((image) => image.complete && image.naturalWidth > 1);
  }, zoom);
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
