import { expect, test } from "@playwright/test";

test("loads the map application shell", async ({ page }) => {
  await page.route("**/api/markers", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        markers: [
          {
            id: "spawn",
            world: "world",
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
  await page.route("**/tiles/**", async (route) => {
    await route.fulfill({ status: 404, body: "tile not found" });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Endstone Live Map" })).toBeVisible();
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect(page.getByText("Spawn")).toBeVisible();
});
