import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendConnection } from "./BackendConnection";

describe("BackendConnection", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows the checking state", () => {
    render(
      <BackendConnection connection={{ status: "checking" }} retry={vi.fn()} />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking connection",
    );
    expect(
      screen.queryByRole("button", { name: "Retry connection" }),
    ).not.toBeInTheDocument();
  });

  it("shows connected state", () => {
    render(
      <BackendConnection connection={{ status: "connected" }} retry={vi.fn()} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Backend connected");
    expect(
      screen.queryByRole("button", { name: "Retry connection" }),
    ).not.toBeInTheDocument();
  });

  it("offers retry after failure", () => {
    const retry = vi.fn();
    render(
      <BackendConnection
        connection={{
          status: "disconnected",
          message: "Could not reach the PocketDeck backend.",
        }}
        retry={retry}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Backend disconnected",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
