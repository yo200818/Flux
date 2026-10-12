package com.pocketdeck.android.actions

import com.google.gson.JsonObject
import com.pocketdeck.android.config.ActionModel
import com.pocketdeck.android.config.ButtonModel
import org.junit.Assert.assertEquals
import org.junit.Test

class ActionCapabilityResolverTest {
    @Test
    fun resolvesAssignedButtonActionByStableId() {
        val action = action("android_local", "open_url")
        val button = button("test-action")

        val resolution = ActionCapabilityResolver.resolveButton(button, listOf(action))

        assertEquals(action, resolution.action)
        assertEquals(ActionCapability.AndroidLocalOpenUrl, resolution.capability)
    }

    @Test
    fun reportsMissingButtonAssignmentsAndDanglingActionIds() {
        val missingAssignment = ActionCapabilityResolver.resolveButton(
            button(actionId = null),
            emptyList(),
        )
        val missingAction = ActionCapabilityResolver.resolveButton(
            button("deleted-action"),
            emptyList(),
        )

        assertEquals(ActionCapability.Unassigned, missingAssignment.capability)
        assertEquals(
            ActionCapability.Unsupported("The action assigned to this button could not be found."),
            missingAction.capability,
        )
    }

    @Test
    fun onlyExplicitAndroidLocalOpenUrlCanExecuteLocally() {
        assertEquals(
            ActionCapability.AndroidLocalOpenUrl,
            ActionCapabilityResolver.resolve(action("android_local", "open_url")),
        )
        assertEquals(
            ActionCapability.WindowsHostDisconnected,
            ActionCapabilityResolver.resolve(action("windows_host", "open_url")),
        )
        assertEquals(
            ActionCapability.WindowsHostDisconnected,
            ActionCapabilityResolver.resolve(action("windows_host", "run_command")),
        )
    }

    @Test
    fun windowsControlsAndMonitoringNeverResolveToAndroidExecution() {
        assertEquals(
            ActionCapability.WindowsHostDisconnected,
            ActionCapabilityResolver.resolve(action("windows_host", "system_control")),
        )
        assertEquals(
            ActionCapability.ReadOnlyWindowsWidgetDisconnected,
            ActionCapabilityResolver.resolve(action("windows_host", "system_monitor", enabled = false)),
        )
        assertEquals(ActionCapability.Unassigned, ActionCapabilityResolver.resolve(null))
    }

    @Test
    fun unknownLocalActionsAndDisabledActionsFailClosed() {
        assertEquals(
            ActionCapability.Unsupported("This Android-local action is not supported."),
            ActionCapabilityResolver.resolve(action("android_local", "system_control")),
        )
        assertEquals(
            ActionCapability.Disabled,
            ActionCapabilityResolver.resolve(action("android_local", "open_url", enabled = false)),
        )
    }

    @Test
    fun unsupportedAndWindowsActionsResolveToVisibleOfflineCapabilities() {
        val unsupported = ActionCapabilityResolver.resolveButton(
            button("test-action"),
            listOf(action("android_local", "system_control")),
        )
        val windowsOffline = ActionCapabilityResolver.resolveButton(
            button("test-action"),
            listOf(action("windows_host", "open_url")),
        )

        assertEquals(
            ActionCapability.Unsupported("This Android-local action is not supported."),
            unsupported.capability,
        )
        assertEquals(ActionCapability.WindowsHostDisconnected, windowsOffline.capability)
        assertEquals(
            ActionCapability.WindowsHostConnected,
            ActionCapabilityResolver.resolveButton(
                button("test-action"),
                listOf(action("windows_host", "open_url")),
                hostReady = true,
            ).capability,
        )
    }

    private fun action(target: String, type: String, enabled: Boolean = true) = ActionModel(
        id = "test-action",
        target = target,
        type = type,
        enabled = enabled,
        parameters = JsonObject().apply { addProperty("url", "https://example.com/") },
    )

    private fun button(actionId: String?) = ButtonModel(
        id = "test-button",
        label = "Test",
        icon = null,
        color = null,
        actionId = actionId,
    )
}
