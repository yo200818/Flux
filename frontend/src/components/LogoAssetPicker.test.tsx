import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLogoAsset, uploadLogoAsset } from "../api/configuration";
import { LogoAssetPicker } from "./LogoAssetPicker";

vi.mock("../api/configuration", () => ({
  getLogoAsset: vi.fn(),
  uploadLogoAsset: vi.fn(),
}));

const mockedGetLogoAsset = vi.mocked(getLogoAsset);
const mockedUploadLogoAsset = vi.mocked(uploadLogoAsset);

describe("LogoAssetPicker", () => {
  beforeEach(() => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:logo-preview"),
      revokeObjectURL: vi.fn(),
    });
    mockedGetLogoAsset.mockResolvedValue(
      new Blob(["webp"], { type: "image/webp" }),
    );
    mockedUploadLogoAsset.mockResolvedValue({
      asset_id: `logo_${"d".repeat(32)}`,
      content_type: "image/webp",
      width: 64,
      height: 48,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("uploads a selected image, displays its preview, and supports replacement removal", async () => {
    const onChange = vi.fn();
    const file = new File(["source"], "logo.png", { type: "image/png" });
    const { rerender } = render(
      <LogoAssetPicker label="Button logo" onChange={onChange} />,
    );

    fireEvent.change(screen.getByLabelText("Button logo: choose image"), {
      target: { files: [file] },
    });

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(`logo_${"d".repeat(32)}`));
    expect(mockedUploadLogoAsset).toHaveBeenCalledWith(file);

    rerender(
      <LogoAssetPicker
        label="Button logo"
        onChange={onChange}
        value={`logo_${"d".repeat(32)}`}
      />,
    );
    expect(await screen.findByAltText("Button logo preview")).toHaveAttribute(
      "src",
      "blob:logo-preview",
    );
    expect(mockedGetLogoAsset).toHaveBeenCalledWith(
      `logo_${"d".repeat(32)}`,
      expect.any(AbortSignal),
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove image" }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(null));
  });
});
