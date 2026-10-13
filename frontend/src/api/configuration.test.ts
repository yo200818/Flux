import { afterEach, describe, expect, it, vi } from "vitest";
import { setApiCredential } from "./authorization";
import {
  getLogoAsset,
  getConfiguration,
  isPocketDeckConfiguration,
  uploadLogoAsset,
  updateConfiguration,
  type ConfigurationSnapshot,
} from "./configuration";

function requestHeaders(fetchMock: ReturnType<typeof vi.fn>, callIndex = 0) {
  const options = fetchMock.mock.calls[callIndex]?.[1] as RequestInit | undefined;
  return new Headers(options?.headers);
}

describe("getConfiguration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setApiCredential(null);
  });

  describe("isPocketDeckConfiguration", () => {
    const validConfiguration = {
      schema_version: 1,
      profiles: [
        {
          id: "profile-main",
          name: "Main",
          pages: [
            {
              id: "page-main",
              name: "Main",
              grid: { columns: 1, rows: 1 },
              buttons: [],
            },
          ],
        },
      ],
      actions: [
        {
          id: "open-example",
          type: "open_url",
          enabled_for_execution: true,
          parameters: { url: "https://example.com/" },
        },
      ],
      commands: [
        {
          id: "command-example",
          definition_version: 1,
          name: "Example",
          category: "General",
          enabled: true,
          steps: [{ type: "wait", parameters: { milliseconds: 100 } }],
        },
      ],
      shortcuts: [],
      settings: { confirm_commands: false },
    };

    it.each([
      [
        "rejects a command URL with a non-web protocol",
        {
          ...validConfiguration,
          commands: [
            {
              ...validConfiguration.commands[0],
              steps: [
                { type: "open_url", parameters: { url: "javascript:alert(1)" } },
              ],
            },
          ],
        },
      ],
      [
        "rejects extra persisted settings",
        {
          ...validConfiguration,
          settings: { confirm_commands: false, extra: true },
        },
      ],
      [
        "rejects null instead of omitted optional v1 fields",
        { ...validConfiguration, commands: null },
      ],
      [
        "rejects extra command-step parameters",
        {
          ...validConfiguration,
          commands: [
            {
              ...validConfiguration.commands[0],
              steps: [
                {
                  type: "wait",
                  parameters: { milliseconds: 100, unexpected: true },
                },
              ],
            },
          ],
        },
      ],
      [
        "rejects an invalid optional website name",
        {
          ...validConfiguration,
          actions: [
            {
              ...validConfiguration.actions[0],
              parameters: {
                url: "https://example.com/",
                name: "",
              },
            },
          ],
        },
      ],
      [
        "rejects a relative application executable path",
        {
          ...validConfiguration,
          actions: [
            {
              id: "application",
              type: "application",
              enabled_for_execution: true,
              parameters: { name: "Editor", path: "Editor.exe" },
            },
          ],
        },
      ],
      [
        "rejects a system control outside the fixed allowlist",
        {
          ...validConfiguration,
          actions: [
            {
              id: "system-control",
              type: "system_control",
              enabled_for_execution: true,
              parameters: { control: "power_off" },
            },
          ],
        },
      ],
      [
        "rejects executable system monitor configuration",
        {
          ...validConfiguration,
          actions: [
            {
              id: "cpu-monitor",
              type: "system_monitor",
              enabled_for_execution: true,
              parameters: { metric: "cpu_utilization" },
            },
          ],
        },
      ],
    ])("%s", (_caseName, configuration) => {
      expect(isPocketDeckConfiguration(configuration)).toBe(false);
    });

    it("accepts a named application action with a Windows path containing spaces", () => {
      expect(
        isPocketDeckConfiguration({
          ...validConfiguration,
          actions: [
            ...validConfiguration.actions,
            {
              id: "app-vscode",
              type: "application",
              enabled_for_execution: true,
              parameters: {
                name: "Visual Studio Code",
                path: "C:\\Program Files\\Microsoft VS Code\\Code.exe",
              },
            },
          ],
        }),
      ).toBe(true);
    });

    it("accepts a disabled read-only system monitor action", () => {
      expect(
        isPocketDeckConfiguration({
          ...validConfiguration,
          actions: [
            {
              id: "cpu-monitor",
              type: "system_monitor",
              enabled_for_execution: false,
              parameters: { metric: "cpu_utilization" },
            },
          ],
        }),
      ).toBe(true);
    });

    it("accepts stable logo references on profiles, buttons, and actions", () => {
      const logoAssetId = `logo_${"a".repeat(32)}`;
      expect(
        isPocketDeckConfiguration({
          ...validConfiguration,
          profiles: [
            {
              ...validConfiguration.profiles[0],
              logo_asset_id: logoAssetId,
              pages: [
                {
                  ...validConfiguration.profiles[0].pages[0],
                  buttons: [
                    {
                      id: "button-logo",
                      label: "Launch",
                      action_id: "open-example",
                      logo_asset_id: logoAssetId,
                    },
                  ],
                },
              ],
            },
          ],
          actions: [
            { ...validConfiguration.actions[0], logo_asset_id: logoAssetId },
          ],
        }),
      ).toBe(true);
      expect(
        isPocketDeckConfiguration({
          ...validConfiguration,
          profiles: [
            {
              ...validConfiguration.profiles[0],
              logo_asset_id: "logo_invalid",
            },
          ],
        }),
      ).toBe(false);
    });
  });

  it("requests the configuration endpoint and parses a versioned configuration", async () => {
    const configuration = {
      schema_version: 1,
      commands: [],
      shortcuts: [],
      settings: { confirm_commands: false },
      profiles: [
        {
          id: "default",
          name: "Default",
          pages: [
            {
              id: "main",
              name: "Main",
              grid: { columns: 1, rows: 1 },
              buttons: [
                { id: "site-button", label: "Website", action_id: "open-site" },
              ],
            },
          ],
        },
      ],
      actions: [
        {
          id: "open-site",
          type: "open_url",
          enabled_for_execution: true,
          parameters: { url: "https://example.com/" },
        },
      ],
    };
    const responseBody = { revision: 3, configuration };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(responseBody));
    vi.stubGlobal("fetch", fetchMock);
    setApiCredential("test-token");

    await expect(getConfiguration()).resolves.toEqual(responseBody);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/api/config",
      expect.objectContaining({ signal: undefined }),
    );
    expect(requestHeaders(fetchMock).get("Accept")).toBe("application/json");
    expect(requestHeaders(fetchMock).get("Authorization")).toBe(
      "Bearer test-token",
    );
  });

  it("uploads raw image bytes and fetches authenticated WebP thumbnails", async () => {
    const assetId = `logo_${"c".repeat(32)}`;
    const uploadResponse = Response.json({
      asset_id: assetId,
      content_type: "image/webp",
      width: 80,
      height: 48,
    }, { status: 201 });
    const previewResponse = new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "Content-Type": "image/webp" },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(uploadResponse)
      .mockResolvedValueOnce(previewResponse);
    vi.stubGlobal("fetch", fetchMock);
    setApiCredential("logo-test-token");
    const file = new File(["source"], "logo.png", { type: "image/png" });

    await expect(uploadLogoAsset(file)).resolves.toEqual({
      asset_id: assetId,
      content_type: "image/webp",
      width: 80,
      height: 48,
    });
    const downloaded = await getLogoAsset(assetId);
    expect(downloaded.type).toBe("image/webp");
    expect(downloaded.size).toBe(3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:8000/api/logo-assets",
      expect.objectContaining({
        method: "POST",
        body: file,
      }),
    );
    expect(requestHeaders(fetchMock).has("Authorization")).toBe(true);
    expect(requestHeaders(fetchMock, 1).has("Authorization")).toBe(true);
  });

  it("accepts valid v1 configuration payloads with saved commands and shortcuts", async () => {
    const configuration = {
      schema_version: 1 as const,
      profiles: [
        {
          id: "default",
          name: "Default",
          pages: [
            {
              id: "main",
              name: "Main",
              grid: { columns: 1, rows: 1 },
              buttons: [
                {
                  id: "launch-site",
                  label: "Website",
                  action_id: "run-command-action",
                },
              ],
            },
          ],
        },
      ],
      actions: [
        {
          id: "run-command-action",
          type: "run_command" as const,
          enabled_for_execution: true,
          parameters: { command_id: "welcome-command" },
        },
      ],
      commands: [
        {
          id: "welcome-command",
          definition_version: 1,
          name: "Welcome",
          category: "General",
          enabled: true,
          steps: [
            {
              type: "open_url",
              parameters: { url: "https://example.com/" },
            },
          ],
        },
      ],
      shortcuts: [
        {
          id: "shortcut-select-all",
          name: "Select all",
          shortcut: "CTRL+A",
        },
      ],
      settings: { confirm_commands: false },
    };
    const responseBody = { revision: 4, configuration };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(responseBody)));

    await expect(getConfiguration()).resolves.toEqual(responseBody);
  });

  it("rejects malformed profile objects that incorrectly include a profile definition version", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          revision: 1,
          configuration: {
            schema_version: 1,
            profiles: [
              {
                id: "default",
                definition_version: 1,
                name: "Default",
                pages: [
                  {
                    id: "main",
                    name: "Main",
                    grid: { columns: 1, rows: 1 },
                    buttons: [],
                  },
                ],
              },
            ],
            actions: [
              {
                id: "open-site",
                type: "open_url",
                enabled_for_execution: true,
                parameters: { url: "https://example.com/" },
              },
            ],
          },
        }),
      ),
    );

    await expect(getConfiguration()).rejects.toThrow(
      "Backend returned an unsupported configuration response.",
    );
  });

  it("rejects unsupported configuration responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          revision: 1,
          configuration: { schema_version: 2, profiles: [], actions: [] },
        }),
      ),
    );

    await expect(getConfiguration()).rejects.toThrow(
      "Backend returned an unsupported configuration response.",
    );
  });

  it("rejects configurations with dangling action references", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          revision: 1,
          configuration: {
            schema_version: 1,
            profiles: [
              {
                id: "default",
                name: "Default",
                pages: [
                  {
                    id: "main",
                    name: "Main",
                    grid: { columns: 1, rows: 1 },
                    buttons: [
                      {
                        id: "site-button",
                        label: "Website",
                        action_id: "missing",
                      },
                    ],
                  },
                ],
              },
            ],
            actions: [
              {
                id: "open-site",
                type: "open_url",
                enabled_for_execution: true,
                parameters: { url: "https://example.com/" },
              },
            ],
          },
        }),
      ),
    );

    await expect(getConfiguration()).rejects.toThrow(
      "Backend returned an unsupported configuration response.",
    );
  });

  it("reports a failed configuration request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );

    await expect(getConfiguration()).rejects.toThrow(
      "Configuration request failed (503).",
    );
  });

  it("saves a validated configuration using its expected revision", async () => {
    const configuration = {
      schema_version: 1 as const,
      commands: [],
      shortcuts: [],
      settings: { confirm_commands: false },
      profiles: [
        {
          id: "default",
          name: "Default",
          pages: [
            {
              id: "main",
              name: "Main",
              grid: { columns: 1, rows: 1 },
              buttons: [
                { id: "site-button", label: "Website", action_id: "open-site" },
              ],
            },
          ],
        },
      ],
      actions: [
        {
          id: "open-site",
          type: "open_url" as const,
          enabled_for_execution: true,
          parameters: { url: "https://example.com/" },
        },
      ],
    };
    const responseBody = { revision: 4, configuration };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(responseBody));
    vi.stubGlobal("fetch", fetchMock);
    setApiCredential("test-token");

    await expect(updateConfiguration(configuration, 3)).resolves.toEqual(
      responseBody,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/api/config?expected_revision=3",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify(configuration),
      }),
    );
    expect(requestHeaders(fetchMock).get("Accept")).toBe("application/json");
    expect(requestHeaders(fetchMock).get("Content-Type")).toBe(
      "application/json",
    );
    expect(requestHeaders(fetchMock).get("Authorization")).toBe(
      "Bearer test-token",
    );
  });

  it("loads the latest configuration and reports a revision conflict", async () => {
    const latestSnapshot: ConfigurationSnapshot = {
      revision: 8,
      configuration: {
        schema_version: 1,
        commands: [],
        shortcuts: [],
        settings: { confirm_commands: false },
        profiles: [
          {
            id: "default",
            name: "Default",
            pages: [
              {
                id: "main",
                name: "Main",
                grid: { columns: 1, rows: 1 },
                buttons: [],
              },
            ],
          },
        ],
        actions: [
          {
            id: "open-site",
            type: "open_url",
            enabled_for_execution: true,
            parameters: { url: "https://example.com/" },
          },
        ],
      },
    };
    const configuration = latestSnapshot.configuration;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "configuration_revision_conflict",
              message: "Stale revision.",
              current_revision: 8,
            },
          },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(Response.json(latestSnapshot));
    vi.stubGlobal("fetch", fetchMock);
    setApiCredential("test-token");

    await expect(updateConfiguration(configuration, 7)).rejects.toMatchObject({
      name: "ConfigurationRevisionConflictError",
      expectedRevision: 7,
      currentRevision: 8,
      latestSnapshot,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:8000/api/config?expected_revision=7",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:8000/api/config",
      expect.objectContaining({ signal: undefined }),
    );
    expect(requestHeaders(fetchMock, 1).get("Accept")).toBe("application/json");
    expect(requestHeaders(fetchMock, 1).get("Authorization")).toBe(
      "Bearer test-token",
    );
  });

  it("does not send an invalid configuration to the backend", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      updateConfiguration(
        {
          schema_version: 1,
          profiles: [],
          actions: [],
          commands: [],
          shortcuts: [],
          settings: { confirm_commands: false },
        },
        2,
      ),
    ).rejects.toThrow("The configuration is invalid and cannot be saved.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
