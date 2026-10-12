package com.pocketdeck.android.actions

import com.pocketdeck.android.config.ActionModel
import com.pocketdeck.android.config.ButtonModel

sealed interface ActionCapability {
    data object Unassigned : ActionCapability
    data object Disabled : ActionCapability
    data object AndroidLocalOpenUrl : ActionCapability
    data object WindowsHostDisconnected : ActionCapability
    data object WindowsHostConnected : ActionCapability
    data object ReadOnlyWindowsWidgetDisconnected : ActionCapability
    data class Unsupported(val reason: String) : ActionCapability
}

data class ButtonActionResolution(
    val action: ActionModel?,
    val capability: ActionCapability,
)

object ActionCapabilityResolver {
    fun resolveButton(
        button: ButtonModel,
        actions: List<ActionModel>,
        hostReady: Boolean = false,
    ): ButtonActionResolution {
        val actionId = button.actionId
            ?: return ButtonActionResolution(null, ActionCapability.Unassigned)
        val action = actions.firstOrNull { it.id == actionId }
            ?: return ButtonActionResolution(
                null,
                ActionCapability.Unsupported("The action assigned to this button could not be found."),
            )
        return ButtonActionResolution(action, resolve(action, hostReady))
    }

    fun resolve(action: ActionModel?, hostReady: Boolean = false): ActionCapability {
        if (action == null) return ActionCapability.Unassigned
        if (action.type == "system_monitor") {
            return ActionCapability.ReadOnlyWindowsWidgetDisconnected
        }
        if (!action.enabled) return ActionCapability.Disabled
        if (action.target == "android_local") {
            return if (action.type == "open_url") {
                ActionCapability.AndroidLocalOpenUrl
            } else {
                ActionCapability.Unsupported("This Android-local action is not supported.")
            }
        }
        if (action.target == "windows_host") {
            return if (hostReady) {
                ActionCapability.WindowsHostConnected
            } else {
                ActionCapability.WindowsHostDisconnected
            }
        }
        return ActionCapability.Unsupported("The action target is not supported.")
    }
}

interface WindowsHostActionDispatcher {
    suspend fun dispatch(action: ActionModel, buttonId: String): HostDispatchResult
}

sealed interface HostDispatchResult {
    data object Succeeded : HostDispatchResult
    data class Failed(val code: String, val message: String) : HostDispatchResult
    data class Unknown(val code: String, val message: String) : HostDispatchResult
}
