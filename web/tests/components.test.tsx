import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PlayerList } from "../src/ui/PlayerList";

describe("PlayerList", () => {
  it("shows online player coordinates", () => {
    render(
      <PlayerList
        players={[
          {
            id: "1",
            name: "Wing",
            world: "world",
            dimension: "Overworld",
            x: 12.2,
            y: 64,
            z: -8.6,
            yaw: 0,
            pitch: 0,
            updatedAt: 1,
          },
        ]}
      />,
    );

    expect(screen.getByText("Wing")).toBeInTheDocument();
    expect(screen.getByText("12, 64, -9")).toBeInTheDocument();
  });
});
