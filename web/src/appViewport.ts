export function measuredViewportHeight(visualViewportHeight: number | undefined, innerHeight: number): number {
  const height = Number.isFinite(visualViewportHeight) && Number(visualViewportHeight) > 0
    ? Number(visualViewportHeight)
    : innerHeight;
  return Math.max(1, Math.round(height));
}

export function applyAppViewportMetrics(
  targetWindow: Pick<Window, "innerHeight" | "visualViewport"> = window,
  root: HTMLElement = document.documentElement,
): number {
  const visualViewport = targetWindow.visualViewport;
  const height = measuredViewportHeight(visualViewport?.height, targetWindow.innerHeight);
  const offsetTop = Number.isFinite(visualViewport?.offsetTop)
    ? Math.max(0, Math.round(Number(visualViewport?.offsetTop)))
    : 0;
  root.style.setProperty("--app-viewport-height", `${height}px`);
  root.style.setProperty("--app-viewport-top", `${offsetTop}px`);
  root.style.setProperty("--mobile-panel-max-height", `${Math.min(Math.round(height * 0.58), 520)}px`);
  return height;
}

export function installAppViewportTracking(
  targetWindow: Window = window,
  targetDocument: Document = document,
): () => void {
  let frame = 0;
  const update = () => {
    frame = 0;
    applyAppViewportMetrics(targetWindow, targetDocument.documentElement);
  };
  const scheduleUpdate = () => {
    if (frame === 0) {
      frame = targetWindow.requestAnimationFrame(update);
    }
  };

  update();
  targetWindow.addEventListener("resize", scheduleUpdate, { passive: true });
  targetWindow.addEventListener("orientationchange", scheduleUpdate, { passive: true });
  targetWindow.visualViewport?.addEventListener("resize", scheduleUpdate, { passive: true });
  targetWindow.visualViewport?.addEventListener("scroll", scheduleUpdate, { passive: true });

  return () => {
    if (frame !== 0) {
      targetWindow.cancelAnimationFrame(frame);
    }
    targetWindow.removeEventListener("resize", scheduleUpdate);
    targetWindow.removeEventListener("orientationchange", scheduleUpdate);
    targetWindow.visualViewport?.removeEventListener("resize", scheduleUpdate);
    targetWindow.visualViewport?.removeEventListener("scroll", scheduleUpdate);
  };
}
