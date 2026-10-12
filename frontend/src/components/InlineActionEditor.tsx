import { useState, type KeyboardEvent } from "react";
import {
  commandActionId,
  createConfigurationId,
  shortcutActionId,
  withSavedCommand,
  withSavedShortcut,
} from "../api/configurationEdits";
import {
  type CommandStepConfiguration,
  type CustomCommandConfiguration,
  type PocketDeckConfiguration,
  type SavedShortcutConfiguration,
} from "../api/configuration";
import {
  formatShortcut,
  normalizeShortcut,
} from "../api/keyboardShortcut";
import { ShortcutRecorder } from "./ShortcutRecorder";

type StepDraft = {
  type: CommandStepConfiguration["type"];
  value: string;
  milliseconds: number;
};

export type InlineActionEditorRequest =
  | {
      type: "command";
      mode: "create" | "edit" | "duplicate";
      item?: CustomCommandConfiguration;
    }
  | {
      type: "shortcut";
      mode: "create" | "edit" | "duplicate";
      item?: SavedShortcutConfiguration;
    };

interface InlineActionEditorProps {
  request: InlineActionEditorRequest;
  configuration: PocketDeckConfiguration;
  saveConfiguration: (configuration: PocketDeckConfiguration) => Promise<void>;
  onSaved: (actionId: string) => void;
  onCancel: () => void;
}

function draftSteps(command?: CustomCommandConfiguration): StepDraft[] {
  return (
    command?.steps.map((step) => {
      if (step.type === "open_url") {
        return { type: step.type, value: step.parameters.url, milliseconds: 0 };
      }
      if (step.type === "wait") {
        return {
          type: step.type,
          value: "",
          milliseconds: step.parameters.milliseconds,
        };
      }
      return {
        type: step.type,
        value:
          "shortcut_id" in step.parameters
            ? `shortcut:${step.parameters.shortcut_id}`
            : step.parameters.shortcut,
        milliseconds: 0,
      };
    }) ?? [{ type: "wait", value: "", milliseconds: 100 }]
  );
}

export function InlineActionEditor({
  request,
  configuration,
  saveConfiguration,
  onSaved,
  onCancel,
}: InlineActionEditorProps) {
  const [name, setName] = useState(
    request.item
      ? `${request.item.name}${request.mode === "duplicate" ? " copy" : ""}`
      : "",
  );
  const [description, setDescription] = useState(
    request.type === "command" ? request.item?.description ?? "" : "",
  );
  const [category, setCategory] = useState(
    request.type === "command" ? request.item?.category ?? "General" : "",
  );
  const [enabled, setEnabled] = useState(
    request.type === "command" ? request.item?.enabled ?? true : true,
  );
  const [steps, setSteps] = useState(() =>
    draftSteps(request.type === "command" ? request.item : undefined),
  );
  const [shortcut, setShortcut] = useState(
    request.type === "shortcut" && request.mode !== "duplicate"
      ? request.item?.shortcut ?? ""
      : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" && (event.target as HTMLElement).tagName !== "TEXTAREA") {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const save = async () => {
    if (busy) {
      return;
    }
    const savedName = name.trim();
    if (!savedName || savedName.length > 64) {
      setError("Enter a name between 1 and 64 characters.");
      return;
    }

    let nextConfiguration: PocketDeckConfiguration;
    let actionId: string | undefined;
    if (request.type === "command") {
      const savedCategory = category.trim();
      if (!savedCategory || savedCategory.length > 32) {
        setError("Enter a command category between 1 and 32 characters.");
        return;
      }
      if (!steps.length || steps.length > 20) {
        setError("Commands need between 1 and 20 steps.");
        return;
      }
      const commandSteps: CommandStepConfiguration[] = [];
      for (const step of steps) {
        if (step.type === "open_url") {
          const url = step.value.trim();
          try {
            const parsed = new URL(url);
            if (
              !["http:", "https:"].includes(parsed.protocol) ||
              !parsed.hostname
            ) {
              throw new Error();
            }
          } catch {
            setError("Enter a valid HTTP or HTTPS URL for each URL step.");
            return;
          }
          commandSteps.push({
            type: "open_url",
            parameters: { url },
          });
        } else if (step.type === "wait") {
          if (
            !Number.isInteger(step.milliseconds) ||
            step.milliseconds < 0 ||
            step.milliseconds > 10000
          ) {
            setError("Wait steps must be between 0 and 10,000 milliseconds.");
            return;
          }
          commandSteps.push({
            type: "wait",
            parameters: { milliseconds: step.milliseconds },
          });
        } else if (step.value.startsWith("shortcut:")) {
          const shortcutId = step.value.slice("shortcut:".length);
          if (!configuration.shortcuts.some((item) => item.id === shortcutId)) {
            setError("Select an existing saved shortcut for this step.");
            return;
          }
          commandSteps.push({
            type: "keyboard_shortcut",
            parameters: { shortcut_id: shortcutId },
          });
        } else {
          try {
            commandSteps.push({
              type: "keyboard_shortcut",
              parameters: { shortcut: normalizeShortcut(step.value) },
            });
          } catch (reason) {
            setError(
              reason instanceof Error
                ? reason.message
                : "Enter a supported key combination.",
            );
            return;
          }
        }
      }

      const command: CustomCommandConfiguration = {
        id:
          request.mode === "edit" && request.item
            ? request.item.id
            : createConfigurationId("command", configuration),
        definition_version: 1,
        name: savedName,
        description: description.trim(),
        category: savedCategory,
        enabled,
        steps: commandSteps,
      };
      nextConfiguration = withSavedCommand(configuration, command);
      actionId = commandActionId(command.id, nextConfiguration);
    } else {
      let normalizedShortcut: string;
      try {
        normalizedShortcut = normalizeShortcut(shortcut);
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Record a supported key combination.",
        );
        return;
      }
      const savedShortcut: SavedShortcutConfiguration = {
        id:
          request.mode === "edit" && request.item
            ? request.item.id
            : createConfigurationId("shortcut", configuration),
        name: savedName,
        shortcut: normalizedShortcut,
      };
      nextConfiguration = withSavedShortcut(configuration, savedShortcut);
      actionId = shortcutActionId(savedShortcut.id, nextConfiguration);
    }

    if (!actionId) {
      setError("The saved item does not have a usable button action.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saveConfiguration(nextConfiguration);
      onSaved(actionId);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The item could not be saved. Your draft is preserved.",
      );
    } finally {
      setBusy(false);
    }
  };

  const title =
    request.type === "command"
      ? request.mode === "edit"
        ? "Edit command inline"
        : request.mode === "duplicate"
          ? "Duplicate command inline"
          : "Create command inline"
      : request.mode === "edit"
        ? "Edit shortcut inline"
        : request.mode === "duplicate"
          ? "Duplicate shortcut inline"
          : "Create shortcut inline";

  return (
    <div
      aria-label={title}
      className="studio-editor inline-action-editor"
      onKeyDown={handleKeyDown}
      role="group"
    >
      <div className="studio-editor-heading">
        <h4>{title}</h4>
        <button
          className="editor-button is-quiet"
          disabled={busy}
          onClick={onCancel}
          type="button"
        >
          Cancel
        </button>
      </div>
      <label>
        <span>Name</span>
        <input
          autoFocus
          maxLength={64}
          onChange={(event) => setName(event.target.value)}
          required
          value={name}
        />
      </label>
      {request.type === "command" ? (
        <>
          <div className="studio-form-grid">
            <label>
              <span>Category</span>
              <input
                maxLength={32}
                onChange={(event) => setCategory(event.target.value)}
                required
                value={category}
              />
            </label>
            <label className="studio-check">
              <input
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
                type="checkbox"
              />
              Enabled for execution
            </label>
          </div>
          <label>
            <span>Description</span>
            <textarea
              maxLength={256}
              onChange={(event) => setDescription(event.target.value)}
              value={description}
            />
          </label>
          <ol className="command-step-list">
            {steps.map((step, index) => (
              <li className="command-step" key={index}>
                <div className="command-step-heading">
                  <strong>Step {index + 1}</strong>
                  <button
                    aria-label={`Remove inline command step ${index + 1}`}
                    className="editor-button is-quiet is-danger"
                    disabled={steps.length === 1}
                    onClick={() =>
                      setSteps(steps.filter((_, itemIndex) => itemIndex !== index))
                    }
                    type="button"
                  >
                    Remove
                  </button>
                </div>
                <label>
                  <span>Action</span>
                  <select
                    aria-label={`Inline command step ${index + 1} action`}
                    onChange={(event) => {
                      const type = event.target.value as StepDraft["type"];
                      setSteps(
                        steps.map((item, itemIndex) =>
                          itemIndex === index
                            ? {
                                type,
                                value: "",
                                milliseconds: type === "wait" ? 100 : 0,
                              }
                            : item,
                        ),
                      );
                    }}
                    value={step.type}
                  >
                    <option value="open_url">Open a URL</option>
                    <option value="keyboard_shortcut">Keyboard shortcut</option>
                    <option value="wait">Wait</option>
                  </select>
                </label>
                {step.type === "open_url" && (
                  <label>
                    <span>HTTP or HTTPS URL</span>
                    <input
                      onChange={(event) =>
                        setSteps(
                          steps.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, value: event.target.value }
                              : item,
                          ),
                        )
                      }
                      placeholder="https://example.com"
                      type="url"
                      value={step.value}
                    />
                  </label>
                )}
                {step.type === "keyboard_shortcut" && (
                  <label>
                    <span>Saved shortcut</span>
                    <select
                      onChange={(event) =>
                        setSteps(
                          steps.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, value: event.target.value }
                              : item,
                          ),
                        )
                      }
                      value={step.value}
                    >
                      <option value="">Choose a saved shortcut</option>
                      {step.value && !step.value.startsWith("shortcut:") && (
                        <option value={step.value}>
                          Existing chord · {formatShortcut(step.value)}
                        </option>
                      )}
                      {configuration.shortcuts.map((item) => (
                        <option key={item.id} value={`shortcut:${item.id}`}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {step.type === "wait" && (
                  <label>
                    <span>Milliseconds (0–10,000)</span>
                    <input
                      max={10000}
                      min={0}
                      onChange={(event) =>
                        setSteps(
                          steps.map((item, itemIndex) =>
                            itemIndex === index
                              ? {
                                  ...item,
                                  milliseconds: Number(event.target.value),
                                }
                              : item,
                          ),
                        )
                      }
                      type="number"
                      value={step.milliseconds}
                    />
                  </label>
                )}
              </li>
            ))}
          </ol>
          <button
            className="editor-button is-quiet"
            disabled={steps.length >= 20}
            onClick={() =>
              setSteps([...steps, { type: "wait", value: "", milliseconds: 100 }])
            }
            type="button"
          >
            Add step
          </button>
        </>
      ) : (
        <ShortcutRecorder value={shortcut} onChange={setShortcut} />
      )}
      {error && <p className="button-editor-error" role="alert">{error}</p>}
      <button
        className="editor-button"
        disabled={busy}
        onClick={() => void save()}
        type="button"
      >
        {busy ? "Saving…" : "Save and assign"}
      </button>
    </div>
  );
}
