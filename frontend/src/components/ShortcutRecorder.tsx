import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  captureShortcut,
  formatShortcut,
  normalizeShortcut,
} from "../api/keyboardShortcut";

interface ShortcutRecorderProps {
  value: string;
  onChange: (value: string) => void;
}

interface NativeCaptureEvent {
  kind: "modifier" | "shortcut" | "unsupported";
  modifiers: string[];
  shortcut: string | null;
  key: string | null;
}

export function ShortcutRecorder({ value, onChange }: ShortcutRecorderProps) {
  const desktopCapture = isTauri();
  const captureRef = useRef<HTMLDivElement>(null);
  const [recording, setRecording] = useState(false);
  const [nativeReady, setNativeReady] = useState(false);
  const [captured, setCaptured] = useState<string | null>(null);
  const [heldModifiers, setHeldModifiers] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!recording || !desktopCapture) {
      return;
    }

    let disposed = false;
    let nativeStarted = false;
    let unlisten: (() => void) | undefined;

    const startPromise = (async () => {
      try {
        unlisten = await listen<NativeCaptureEvent>(
          "shortcut-capture-event",
          ({ payload }) => {
            if (disposed) {
              return;
            }
            if (payload.kind === "modifier") {
              setHeldModifiers(payload.modifiers);
              setMessage(
                payload.modifiers.length
                  ? "Modifier held. Press a supported key to complete the shortcut."
                  : "Press Ctrl, Alt, Shift, or Windows, then a supported key.",
              );
              return;
            }
            setHeldModifiers([]);
            if (payload.kind === "unsupported" || !payload.shortcut) {
              setMessage(
                payload.key === "PRINTSCREEN"
                  ? "Print Screen was intercepted, but is not a supported shortcut key."
                  : "That key is unsupported. It was intercepted and was not saved.",
              );
              return;
            }
            try {
              setCaptured(normalizeShortcut(payload.shortcut));
              setMessage(null);
            } catch (error) {
              setMessage(
                error instanceof Error
                  ? `${error.message} The key was intercepted and was not saved.`
                  : "That key combination is unsupported. It was intercepted and was not saved.",
              );
            }
          },
        );
        await invoke("start_shortcut_capture");
        nativeStarted = true;
        if (disposed) {
          await invoke("stop_shortcut_capture");
          nativeStarted = false;
          return;
        }
        setNativeReady(true);
      } catch (error) {
        if (!disposed) {
          setMessage(
            `Native shortcut capture could not start; no keys were suppressed. ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          setRecording(false);
        }
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
      void startPromise
        .catch(() => undefined)
        .then(async () => {
          if (nativeStarted) {
            await invoke("stop_shortcut_capture");
            nativeStarted = false;
          }
        })
        .catch((error: unknown) => {
          console.error("Could not stop native shortcut capture:", error);
          setMessage(
            "Native shortcut capture did not stop cleanly. Close PocketDeck to release the temporary hook.",
          );
        });
    };
  }, [desktopCapture, recording]);

  const startRecording = () => {
    setCaptured(null);
    setHeldModifiers([]);
    setMessage(null);
    setNativeReady(false);
    setRecording(true);
    captureRef.current?.focus();
  };

  const finishRecording = () => {
    setRecording(false);
    setNativeReady(false);
    setCaptured(null);
    setHeldModifiers([]);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!recording || desktopCapture) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const result = captureShortcut(event.nativeEvent);
    if (result.kind === "shortcut") {
      setCaptured(result.value);
      setMessage(null);
    } else if (result.kind === "modifier") {
      setMessage("Modifier held. Press a supported key to complete the shortcut.");
    } else {
      setMessage(result.message);
    }
  };

  const saveCaptured = () => {
    if (!captured) {
      return;
    }
    onChange(captured);
    setMessage(null);
    finishRecording();
  };

  const clearShortcut = () => {
    onChange("");
    setCaptured(null);
    setMessage(null);
    finishRecording();
  };

  const captureLabel = recording
    ? desktopCapture
      ? nativeReady
        ? "Recording shortcut…"
        : "Starting native shortcut capture…"
      : "Recording shortcut…"
    : value
      ? formatShortcut(value)
      : "Click Record, then press a combination";

  return (
    <div className="studio-capture-field">
      <span>Key combination</span>
      <div
        aria-label="Keyboard shortcut capture"
        aria-describedby="capture-help"
        aria-live="polite"
        className={`shortcut-capture${recording ? " is-capturing" : ""}`}
        ref={captureRef}
        onKeyDown={handleKeyDown}
        onClick={() => {
          if (!recording) {
            startRecording();
          }
        }}
        role="textbox"
        tabIndex={0}
      >
        {recording && captured ? formatShortcut(captured) : captureLabel}
      </div>
      <span id="capture-help">
        {desktopCapture
          ? "While recording, PocketDeck temporarily intercepts modifier keys and keys pressed with modifiers; ordinary unmodified keys pass through. Windows may still handle system shortcuts first. Fn is not recordable unless your keyboard exposes it as a Windows key event."
          : "Browser recording only captures keys delivered to this page and cannot suppress Windows shortcuts. Use the Windows app for capture-only recording. Fn is not recordable unless your keyboard exposes it as a Windows key event."}
      </span>
      {recording && heldModifiers.length > 0 && (
        <span aria-label="Held modifiers">
          Held: {formatShortcut(heldModifiers.join("+"))}
        </span>
      )}
      {captured && recording && (
        <span role="status">Captured: {formatShortcut(captured)}</span>
      )}
      {message && <span role="status">{message}</span>}
      <div className="studio-list-actions">
        {!recording ? (
          <button
            className="editor-button is-quiet"
            onClick={startRecording}
            type="button"
          >
            {value ? "Record again" : "Record shortcut"}
          </button>
        ) : (
          <>
            <button
              className="editor-button"
              disabled={!captured || (desktopCapture && !nativeReady)}
              onClick={saveCaptured}
              type="button"
            >
              Save shortcut
            </button>
            <button
              className="editor-button is-quiet"
              onClick={finishRecording}
              type="button"
            >
              Cancel recording
            </button>
            <button
              className="editor-button is-quiet"
              onClick={clearShortcut}
              type="button"
            >
              Clear shortcut
            </button>
          </>
        )}
        {!recording && value && (
          <button
            className="editor-button is-quiet"
            onClick={clearShortcut}
            type="button"
          >
            Clear shortcut
          </button>
        )}
      </div>
    </div>
  );
}
