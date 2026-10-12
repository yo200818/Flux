import type {
  ActionConfiguration,
  CustomCommandConfiguration,
  PocketDeckConfiguration,
  SavedShortcutConfiguration,
} from "./configuration";

export function createConfigurationId(
  prefix: string,
  configuration: PocketDeckConfiguration,
): string {
  const existing = new Set<string>([
    ...configuration.actions.map((action) => action.id),
    ...configuration.commands.map((command) => command.id),
    ...configuration.shortcuts.map((shortcut) => shortcut.id),
    ...configuration.profiles.flatMap((profile) => [
      profile.id,
      ...profile.pages.flatMap((page) => [
        page.id,
        ...page.buttons.map((button) => button.id),
      ]),
    ]),
  ]);
  let id: string;
  do {
    id = `${prefix}-${crypto.randomUUID()}`;
  } while (existing.has(id));
  return id;
}

export function commandActionId(
  commandId: string,
  configuration: PocketDeckConfiguration,
): string | undefined {
  return configuration.actions.find(
    (action) =>
      action.type === "run_command" &&
      action.parameters.command_id === commandId,
  )?.id;
}

export function shortcutActionId(
  shortcutId: string,
  configuration: PocketDeckConfiguration,
): string | undefined {
  return configuration.actions.find(
    (action) =>
      action.type === "keyboard_shortcut" &&
      "shortcut_id" in action.parameters &&
      action.parameters.shortcut_id === shortcutId,
  )?.id;
}

export function withSavedCommand(
  configuration: PocketDeckConfiguration,
  command: CustomCommandConfiguration,
): PocketDeckConfiguration {
  const existingCommand = configuration.commands.some(
    (item) => item.id === command.id,
  );
  const existingActionId = existingCommand
    ? commandActionId(command.id, configuration)
    : undefined;
  let actions: ActionConfiguration[];
  if (existingActionId) {
    actions = configuration.actions.map((action) =>
      action.id === existingActionId && action.type === "run_command"
        ? {
            ...action,
            enabled_for_execution: command.enabled,
            parameters: { command_id: command.id },
          }
        : action,
    );
  } else {
    actions = [
      ...configuration.actions,
      {
        id: createConfigurationId("run", configuration),
        type: "run_command",
        enabled_for_execution: command.enabled,
        parameters: { command_id: command.id },
      },
    ];
  }
  return {
    ...configuration,
    actions,
    commands: existingCommand
      ? configuration.commands.map((item) =>
          item.id === command.id ? command : item,
        )
      : [...configuration.commands, command],
  };
}

export function withSavedShortcut(
  configuration: PocketDeckConfiguration,
  shortcut: SavedShortcutConfiguration,
): PocketDeckConfiguration {
  const existingShortcut = configuration.shortcuts.some(
    (item) => item.id === shortcut.id,
  );
  const existingActionId = existingShortcut
    ? shortcutActionId(shortcut.id, configuration)
    : undefined;
  let actions: ActionConfiguration[];
  if (existingActionId) {
    actions = configuration.actions.map((action) =>
      action.id === existingActionId && action.type === "keyboard_shortcut"
        ? { ...action, enabled_for_execution: true }
        : action,
    );
  } else {
    actions = [
      ...configuration.actions,
      {
        id: createConfigurationId("shortcut-action", configuration),
        type: "keyboard_shortcut",
        enabled_for_execution: true,
        parameters: { shortcut_id: shortcut.id },
      },
    ];
  }
  return {
    ...configuration,
    actions,
    shortcuts: existingShortcut
      ? configuration.shortcuts.map((item) =>
          item.id === shortcut.id ? shortcut : item,
        )
      : [...configuration.shortcuts, shortcut],
  };
}
