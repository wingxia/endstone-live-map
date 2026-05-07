import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MarkerForm } from "../src/ui/MarkerForm";
import { MarkerList } from "../src/ui/MarkerList";
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

describe("MarkerForm", () => {
  it("submits marker drafts", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<MarkerForm world="world" dimension="Overworld" onCreate={onCreate} />);

    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "Spawn" } });
    fireEvent.change(screen.getByLabelText("X"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Y"), { target: { value: "64" } });
    fireEvent.change(screen.getByLabelText("Z"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /添加标注/ }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ title: "Spawn", x: 1, y: 64, z: 2 }));
    });
  });
});

describe("MarkerList", () => {
  it("renders marker descriptions", () => {
    render(
      <MarkerList
        markers={[
          {
            id: "m1",
            world: "world",
            dimension: "Overworld",
            x: 0,
            y: 70,
            z: 0,
            title: "Base",
            description: "Storage",
            createdBy: "Wing",
            createdAt: 1,
            updatedAt: 1,
          },
        ]}
      />,
    );
    expect(screen.getByText("Base")).toBeInTheDocument();
    expect(screen.getByText("Storage")).toBeInTheDocument();
  });
});
