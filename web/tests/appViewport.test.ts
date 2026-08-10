import { describe, expect, it } from "vitest";

import { applyAppViewportMetrics, measuredViewportHeight } from "../src/appViewport";

describe("mobile visual viewport sizing", () => {
  it("prefers the visible viewport over stale layout viewport height", () => {
    expect(measuredViewportHeight(932.4, 760)).toBe(932);
    expect(measuredViewportHeight(undefined, 760)).toBe(760);
  });

  it("updates the app and panel CSS metrics together", () => {
    const root = document.createElement("div");
    const height = applyAppViewportMetrics(
      {
        innerHeight: 760,
        visualViewport: { height: 932.4, offsetTop: 18.6 } as VisualViewport,
      },
      root,
    );

    expect(height).toBe(932);
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("932px");
    expect(root.style.getPropertyValue("--app-viewport-top")).toBe("19px");
    expect(root.style.getPropertyValue("--mobile-panel-max-height")).toBe("520px");
  });
});
