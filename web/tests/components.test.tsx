import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PlayerList } from "../src/ui/PlayerList";
import { LandList } from "../src/ui/LandList";
import { coordinateCopyText } from "../src/ui/MapCanvas";
import type { LandClaim } from "../src/api";

describe("MapCanvas coordinate helpers", () => {
  it("formats copied coordinates as bare x, y, z values", () => {
    expect(coordinateCopyText({ x: 44, height: 65, z: 80 })).toBe("44, 65, 80");
  });

  it("falls back to y=0 before block height is loaded", () => {
    expect(coordinateCopyText({ x: -12, height: Number.NaN, z: 35 })).toBe("-12, 0, 35");
  });
});

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

  it("selects a player from the list", () => {
    let selected = "";
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
        onSelectPlayer={(player) => {
          selected = player.id;
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Wing/ }));

    expect(selected).toBe("1");
  });
});

describe("LandList", () => {
  it("shows every supplied land without a collapsed more row", () => {
    render(<LandList lands={Array.from({ length: 13 }, (_, index) => createLand({ id: String(index), name: `领地${index}` }))} />);

    expect(screen.getByText("领地0")).toBeInTheDocument();
    expect(screen.getByText("领地12")).toBeInTheDocument();
    expect(screen.queryByText(/还有/)).not.toBeInTheDocument();
  });

  it("selects a land from the list", () => {
    let selected = "";
    render(
      <LandList
        lands={[createLand({ id: "public", name: "主城区" })]}
        onSelectLand={(land) => {
          selected = land.id;
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /主城区/ }));

    expect(selected).toBe("public");
  });

  it("filters lands by name and owner", () => {
    render(
      <LandList
        lands={[
          createLand({ id: "spawn", name: "主城区", owner: "GieZi8670" }),
          createLand({ id: "farm", name: "农场", owner: "WingXia" }),
        ]}
      />,
    );

    fireEvent.change(screen.getByLabelText("搜索领地"), { target: { value: "wing" } });

    expect(screen.getByText("农场")).toBeInTheDocument();
    expect(screen.queryByText("主城区")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("搜索领地"), { target: { value: "主城" } });

    expect(screen.getByText("主城区")).toBeInTheDocument();
    expect(screen.queryByText("农场")).not.toBeInTheDocument();
  });

  it("shows a distinct empty state when land search has no matches", () => {
    render(<LandList lands={[createLand({ id: "spawn", name: "主城区", owner: "GieZi8670" })]} />);

    fireEvent.change(screen.getByLabelText("搜索领地"), { target: { value: "missing" } });

    expect(screen.getByText("没有匹配的公开传送领地")).toBeInTheDocument();
    expect(screen.queryByText("当前维度没有公开传送领地")).not.toBeInTheDocument();
  });
});

function createLand(overrides: Partial<LandClaim> = {}): LandClaim {
  return {
    id: "land",
    owner: "GieZi8670",
    name: "主城区",
    world: "Bedrock level",
    dimension: "Overworld",
    minX: -375,
    maxX: -227,
    minY: 70,
    maxY: 300,
    minZ: -580,
    maxZ: -473,
    teleport: { x: -352, y: 70, z: -479 },
    members: [],
    parent: "",
    children: [],
    nested: false,
    publicTeleport: true,
    updatedAt: 123,
    ...overrides,
  };
}
