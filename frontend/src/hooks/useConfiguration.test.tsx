import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConfigurationRevisionConflictError,
  getConfiguration,
  updateConfiguration,
  type ConfigurationSnapshot,
} from "../api/configuration";
import type { BackendConnectionState } from "./useBackendHealth";
import { useConfiguration } from "./useConfiguration";

vi.mock("../api/configuration", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../api/configuration")>();
  return {
    ...actual,
    getConfiguration: vi.fn(),
    updateConfiguration: vi.fn(),
  };
});

const getConfigurationMock = vi.mocked(getConfiguration);
const updateConfigurationMock = vi.mocked(updateConfiguration);

const snapshot: ConfigurationSnapshot = {
  revision: 0,
  configuration: {
    schema_version: 1,
    commands: [],
    shortcuts: [],
    settings: { confirm_commands: false },
    profiles: [
      {
        id: "profile",
        name: "Default",
        pages: [
          {
            id: "page",
            name: "Main",
            grid: { columns: 1, rows: 1 },
            buttons: [],
          },
        ],
      },
    ],
    actions: [
      {
        id: "action",
        type: "open_url",
        enabled_for_execution: true,
        parameters: { url: "https://example.com/" },
      },
    ],
  },
};

describe("useConfiguration", () => {
  afterEach(() => {
    getConfigurationMock.mockReset();
    updateConfigurationMock.mockReset();
  });

  it("waits for the backend health check before requesting configuration", async () => {
    getConfigurationMock.mockResolvedValue(snapshot);
    const checking: BackendConnectionState = { status: "checking" };
    const initialProps: { connection: BackendConnectionState } = {
      connection: checking,
    };
    const { result, rerender } = renderHook(
      ({ connection }: { connection: BackendConnectionState }) =>
        useConfiguration(connection),
      { initialProps },
    );

    expect(result.current.state).toEqual({ status: "loading" });
    expect(getConfigurationMock).not.toHaveBeenCalled();

    rerender({ connection: { status: "connected" } });

    await waitFor(() => {
      expect(getConfigurationMock).toHaveBeenCalledOnce();
      expect(result.current.state).toEqual({
        status: "loaded",
        ...snapshot,
      });
    });
  });

  it("surfaces health failures and does not request configuration", () => {
    const disconnected: BackendConnectionState = {
      status: "disconnected",
      message: "Could not reach the PocketDeck backend.",
    };
    const { result } = renderHook(() => useConfiguration(disconnected));

    expect(result.current.state).toEqual({
      status: "error",
      message: disconnected.message,
    });
    expect(getConfigurationMock).not.toHaveBeenCalled();
  });

  it("retries configuration only after the backend is healthy", async () => {
    getConfigurationMock.mockResolvedValue(snapshot);
    const disconnected: BackendConnectionState = {
      status: "disconnected",
      message: "Backend unavailable.",
    };
    const initialProps: { connection: BackendConnectionState } = {
      connection: disconnected,
    };
    const { result, rerender } = renderHook(
      ({ connection }: { connection: BackendConnectionState }) =>
        useConfiguration(connection),
      { initialProps },
    );

    act(() => result.current.retry());
    expect(getConfigurationMock).not.toHaveBeenCalled();

    rerender({ connection: { status: "connected" } });
    await waitFor(() => expect(getConfigurationMock).toHaveBeenCalledOnce());
  });

  it("persists configuration using the current revision and updates loaded state", async () => {
    updateConfigurationMock.mockResolvedValue({
      revision: 1,
      configuration: snapshot.configuration,
    });
    getConfigurationMock.mockResolvedValue(snapshot);
    const { result } = renderHook(() =>
      useConfiguration({ status: "connected" }),
    );
    await waitFor(() => expect(result.current.state.status).toBe("loaded"));

    await act(async () => {
      await result.current.saveConfiguration(snapshot.configuration);
    });

    expect(updateConfigurationMock).toHaveBeenCalledWith(
      snapshot.configuration,
      0,
    );
    expect(result.current.state).toEqual({
      status: "loaded",
      revision: 1,
      configuration: snapshot.configuration,
    });
  });

  it("loads the latest revision after a conflict without losing save access", async () => {
    const latestSnapshot: ConfigurationSnapshot = {
      revision: 3,
      configuration: {
        ...snapshot.configuration,
        profiles: snapshot.configuration.profiles.map((profile) => ({
          ...profile,
          pages: profile.pages.map((page) => ({
            ...page,
            name: "Updated by another client",
          })),
        })),
      },
    };
    updateConfigurationMock.mockRejectedValueOnce(
      new ConfigurationRevisionConflictError(0, 3, latestSnapshot),
    );
    updateConfigurationMock.mockResolvedValueOnce({
      revision: 4,
      configuration: latestSnapshot.configuration,
    });
    getConfigurationMock.mockResolvedValue(snapshot);
    const { result } = renderHook(() =>
      useConfiguration({ status: "connected" }),
    );
    await waitFor(() => expect(result.current.state.status).toBe("loaded"));

    await act(async () => {
      await expect(
        result.current.saveConfiguration(snapshot.configuration),
      ).rejects.toBeInstanceOf(ConfigurationRevisionConflictError);
    });
    expect(result.current.state).toEqual({
      status: "loaded",
      ...latestSnapshot,
    });

    await act(async () => {
      await result.current.saveConfiguration(latestSnapshot.configuration);
    });
    expect(updateConfigurationMock).toHaveBeenNthCalledWith(
      2,
      latestSnapshot.configuration,
      3,
    );
    expect(result.current.state).toEqual({
      status: "loaded",
      revision: 4,
      configuration: latestSnapshot.configuration,
    });
  });
});
