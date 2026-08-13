import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PlayerList } from "../src/ui/PlayerList";
import { LandList } from "../src/ui/LandList";
import { coordinateCopyText, mergeMapBounds } from "../src/ui/MapCanvas";
import { selectBirthplace, selectWorldMeta } from "../src/ui/App";
import type { LandClaim, WorldMeta } from "../src/api";

describe("App world selection", () => {
  it("falls back to the newest world in the selected dimension", () => {
    const worlds = [
      createWorld({ world: "ExchangeTestWorld", updatedAt: 10 }),
      createWorld({ world: "ExchangeTest", updatedAt: 20 }),
      createWorld({ world: "NetherWorld", dimension: "Nether", updatedAt: 30 }),
    ];

    expect(selectWorldMeta(worlds, "Overworld", "Bedrock level")?.world).toBe("ExchangeTest");
  });

  it("uses an explicit spawn land as the birthplace before the main-city fallback", () => {
    expect(
      selectBirthplace([
        createLand({ id: "main", name: "主城区", teleport: { x: -352, y: 70, z: -479 } }),
        createLand({ id: "spawn", name: "出生地", teleport: { x: 8, y: 72, z: -16 } }),
      ]),
    ).toEqual({ x: 8, z: -16 });
  });

  it("uses the existing main-city teleport as the birthplace fallback", () => {
    expect(selectBirthplace([createLand()])).toEqual({ x: -352, z: -479 });
  });
});

describe("MapCanvas coordinate helpers", () => {
  it("formats copied coordinates as bare x, y, z values", () => {
    expect(coordinateCopyText({ x: 44, height: 65, z: 80 })).toBe("44, 65, 80");
  });

  it("marks y as relative before block height is loaded", () => {
    expect(coordinateCopyText({ x: -12, height: Number.NaN, z: 35 })).toBe("-12, ~, 35");
  });

  it("expands map bounds with live player bounds", () => {
    expect(
      mergeMapBounds(
        { minChunkX: 0, maxChunkX: 1, minChunkZ: 0, maxChunkZ: 1, minBlockX: 0, maxBlockX: 31, minBlockZ: 0, maxBlockZ: 31 },
        { minChunkX: -4, maxChunkX: -3, minChunkZ: 5, maxChunkZ: 6, minBlockX: -64, maxBlockX: -33, minBlockZ: 80, maxBlockZ: 111 },
      ),
    ).toEqual({
      minChunkX: -4,
      maxChunkX: 1,
      minChunkZ: 0,
      maxChunkZ: 6,
      minBlockX: -64,
      maxBlockX: 31,
      minBlockZ: 0,
      maxBlockZ: 111,
    });
  });
});

describe("PlayerList", () => {
  it("shows online player coordinates", () => {
    const { container } = render(
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
            avatarHash: "abc123",
            avatarUrl: "/api/players/1/avatar.png?_=abc123",
            updatedAt: 1,
          },
        ]}
      />,
    );

    expect(screen.getByText("Wing")).toBeInTheDocument();
    expect(screen.getByText("12, 64, -9")).toBeInTheDocument();
    expect(container.querySelector(".avatar img")).toHaveAttribute("src", "/api/players/1/avatar.png?_=abc123");
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

  it("highlights tracked players without showing a status label", () => {
    const { container } = render(
      <PlayerList
        players={[
          {
            id: "1",
            name: "Wing",
            world: "world",
            dimension: "Overworld",
            x: 12,
            y: 64,
            z: -9,
            yaw: 0,
            pitch: 0,
            updatedAt: 1,
          },
        ]}
        trackedPlayerIds={new Set(["1"])}
      />,
    );

    expect(screen.getByRole("button", { name: "取消追踪玩家 Wing" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("追踪中")).not.toBeInTheDocument();
    expect(container.querySelector(".is-tracked")).toBeInTheDocument();
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

function createWorld(overrides: Partial<WorldMeta> = {}): WorldMeta {
  return {
    version: 2,
    world: "Bedrock level",
    dimension: "Overworld",
    status: "live",
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
    topBlocks: {},
    ...overrides,
  };
}
