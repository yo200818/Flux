package com.pocketdeck.android.config

import com.google.gson.JsonArray
import com.google.gson.JsonNull
import com.google.gson.JsonObject

/** Typed navigation/action view over the validated, preserved v2 JSON document. */
data class PocketDeckConfiguration(
    val document: JsonObject,
    val deck: DeckModel,
    val profiles: List<ProfileModel>,
    val actions: List<ActionModel>,
    val commands: List<CommandModel>,
    val shortcuts: List<ShortcutModel>,
    val confirmCommands: Boolean,
) {
    companion object {
        fun fromValidatedDocument(document: JsonObject): PocketDeckConfiguration {
            val deckJson = document.getAsJsonObject("deck")
            val profiles = document.getAsJsonArray("profiles").map { profileElement ->
                val profile = profileElement.asJsonObject
                ProfileModel(
                    id = profile.get("id").asString,
                    name = profile.get("name").asString,
                    logoAssetId = profile.stringOrNull("logo_asset_id"),
                    pages = profile.getAsJsonArray("pages").map { pageElement ->
                        val page = pageElement.asJsonObject
                        val grid = page.getAsJsonObject("grid")
                        PageModel(
                            id = page.get("id").asString,
                            name = page.get("name").asString,
                            columns = grid.get("columns").asInt,
                            rows = grid.get("rows").asInt,
                            buttons = page.getAsJsonArray("buttons").map { buttonElement ->
                                val button = buttonElement.asJsonObject
                                ButtonModel(
                                    id = button.get("id").asString,
                                    label = button.get("label").asString,
                                    icon = button.stringOrNull("icon"),
                                    color = button.stringOrNull("color"),
                                    logoAssetId = button.stringOrNull("logo_asset_id"),
                                    actionId = button.stringOrNull("action_id"),
                                )
                            },
                        )
                    },
                )
            }
            val actions = document.getAsJsonArray("actions").map { element ->
                val action = element.asJsonObject
                ActionModel(
                    id = action.get("id").asString,
                    target = action.get("target").asString,
                    type = action.get("type").asString,
                    enabled = action.get("enabled_for_execution").asBoolean,
                    parameters = action.getAsJsonObject("parameters").deepCopy(),
                    logoAssetId = action.stringOrNull("logo_asset_id"),
                )
            }
            val commands = document.getAsJsonArrayOrEmpty("commands").map { element ->
                val command = element.asJsonObject
                CommandModel(
                    id = command.get("id").asString,
                    name = command.get("name").asString,
                    enabled = command.get("enabled")?.asBoolean ?: true,
                    steps = command.getAsJsonArray("steps").map { stepElement ->
                        val step = stepElement.asJsonObject
                        CommandStepModel(
                            type = step.get("type").asString,
                            parameters = step.getAsJsonObject("parameters").deepCopy(),
                        )
                    },
                )
            }
            val shortcuts = document.getAsJsonArrayOrEmpty("shortcuts").map { element ->
                val shortcut = element.asJsonObject
                ShortcutModel(
                    id = shortcut.get("id").asString,
                    name = shortcut.get("name").asString,
                    shortcut = shortcut.get("shortcut").asString,
                )
            }
            return PocketDeckConfiguration(
                document = document.deepCopy(),
                deck = DeckModel(
                    id = deckJson.get("id").asString,
                    name = deckJson.get("name").asString,
                ),
                profiles = profiles,
                actions = actions,
                commands = commands,
                shortcuts = shortcuts,
                confirmCommands = document.getAsJsonObject("settings")
                    ?.get("confirm_commands")?.asBoolean ?: false,
            )
        }
    }
}

data class DeckModel(val id: String, val name: String)

data class ProfileModel(
    val id: String,
    val name: String,
    val pages: List<PageModel>,
    val logoAssetId: String? = null,
)

data class PageModel(
    val id: String,
    val name: String,
    val columns: Int,
    val rows: Int,
    val buttons: List<ButtonModel>,
)

data class ButtonModel(
    val id: String,
    val label: String,
    val icon: String?,
    val color: String?,
    val actionId: String?,
    val logoAssetId: String? = null,
)

data class ActionModel(
    val id: String,
    val target: String,
    val type: String,
    val enabled: Boolean,
    val parameters: JsonObject,
    val logoAssetId: String? = null,
)

data class CommandModel(
    val id: String,
    val name: String,
    val enabled: Boolean,
    val steps: List<CommandStepModel>,
)

data class CommandStepModel(val type: String, val parameters: JsonObject)
data class ShortcutModel(val id: String, val name: String, val shortcut: String)

data class DeviceDeckSelection(val profileId: String?, val pageId: String?)

private fun JsonObject.stringOrNull(name: String): String? {
    val element = get(name) ?: return null
    return if (element is JsonNull) null else element.asString
}

private fun JsonObject.getAsJsonArrayOrEmpty(name: String): JsonArray =
    get(name)?.asJsonArray ?: JsonArray()
