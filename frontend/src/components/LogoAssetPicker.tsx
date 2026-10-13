import { useEffect, useState, type ChangeEvent } from "react";
import { getLogoAsset, uploadLogoAsset } from "../api/configuration";

interface LogoAssetPickerProps {
  label: string;
  value?: string | null;
  onChange: (assetId: string | null) => void | Promise<void>;
}

export function LogoAssetPicker({
  label,
  value,
  onChange,
}: LogoAssetPickerProps) {
  const [preview, setPreview] = useState<{ assetId: string; url: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!value) return;
    const controller = new AbortController();
    let active = true;
    let objectUrl: string | null = null;
    void getLogoAsset(value, controller.signal)
      .then((blob) => {
        if (active) {
          objectUrl = URL.createObjectURL(blob);
          setPreview({ assetId: value, url: objectUrl });
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (active && !(cause instanceof Error && cause.name === "AbortError")) {
          setError(cause instanceof Error ? cause.message : "Logo preview failed.");
        }
      });
    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [value]);
  const previewUrl = preview && preview.assetId === value ? preview.url : null;

  const handleSelect = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const uploaded = await uploadLogoAsset(file);
      await onChange(uploaded.asset_id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Logo upload failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="logo-asset-picker">
      <span className="logo-asset-picker-label">{label}</span>
      {previewUrl ? (
        <img className="logo-asset-preview" src={previewUrl} alt={`${label} preview`} />
      ) : (
        <span className="logo-asset-preview logo-asset-placeholder" aria-label="No logo preview">
          No image
        </span>
      )}
      <div className="studio-list-actions">
        <label className="editor-button is-quiet logo-asset-select">
          {busy ? "Uploading…" : value ? "Replace image" : "Choose image"}
          <input
            accept="image/png,image/jpeg,image/webp"
            aria-label={`${label}: choose image`}
            disabled={busy}
            onChange={(event) => void handleSelect(event)}
            type="file"
          />
        </label>
        {value && (
          <button
            className="editor-button is-quiet is-danger"
            disabled={busy}
            onClick={() => {
              setError(null);
              void Promise.resolve(onChange(null)).catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : "Logo removal failed.");
              });
            }}
            type="button"
          >
            Remove image
          </button>
        )}
      </div>
      {error && <p className="button-editor-error" role="alert">{error}</p>}
      <small className="logo-asset-help">PNG, JPEG, or WebP · up to 5 MiB · 4096 px maximum edge</small>
    </div>
  );
}
