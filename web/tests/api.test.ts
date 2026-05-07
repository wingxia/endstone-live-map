import { describe, expect, it } from "vitest";

import { tileUrl } from "../src/api";

describe("api helpers", () => {
  it("builds bmp tile urls for the selected world and dimension", () => {
    expect(tileUrl("world", "Overworld")).toBe("/tiles/world/Overworld/{z}/{x}/{y}.bmp");
  });
});
