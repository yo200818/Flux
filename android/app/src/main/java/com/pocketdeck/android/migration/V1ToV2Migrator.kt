package com.pocketdeck.android.migration

import com.google.gson.JsonNull
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonPrimitive
import com.pocketdeck.android.config.PocketDeckConfigurationCodec
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.UUID

const val LEGACY_DECK_KEY = "pocketdeck/legacy-primary-deck"

fun interface MigrationNamespaceSource {
    fun getOrCreate(): UUID
}

class V1ToV2Migrator(
    private val codec: PocketDeckConfigurationCodec,
    private val namespace: UUID,
) {
    fun migrate(source: JsonObject): JsonObject {
        val v1ForValidation = source.deepCopy()
        canonicalizeV1Shortcuts(v1ForValidation)
        val validatedSource = codec.validateV1(v1ForValidation)
        val candidate = validatedSource.deepCopy()
        val actions = candidate.getAsJsonArray("actions")
        actions.forEach { element ->
            val action = element.asJsonObject
            if (!action.has("enabled_for_execution")) {
                action.addProperty("enabled_for_execution", false)
            }
            action.addProperty("target", "windows_host")
            if (action.get("type").asString == "keyboard_shortcut") {
                normalizeInlineShortcut(action.getAsJsonObject("parameters"))
            }
        }

        val commands = candidate.get("commands")?.asJsonArray ?: JsonArray()
        commands.forEach { element ->
            val command = element.asJsonObject
            if (!command.has("definition_version")) command.addProperty("definition_version", 1)
            if (!command.has("description")) command.addProperty("description", "")
            if (!command.has("category")) command.addProperty("category", "General")
            if (!command.has("enabled")) command.addProperty("enabled", true)
            command.getAsJsonArray("steps").forEach { stepElement ->
                val step = stepElement.asJsonObject
                if (step.get("type").asString == "keyboard_shortcut") {
                    normalizeInlineShortcut(step.getAsJsonObject("parameters"))
                }
            }
        }

        val shortcuts = candidate.get("shortcuts")?.asJsonArray ?: JsonArray()
        shortcuts.forEach { element ->
            val shortcut = element.asJsonObject
            shortcut.addProperty("shortcut", normalizeShortcut(shortcut.get("shortcut").asString))
        }

        if (!candidate.has("commands")) candidate.add("commands", commands)
        if (!candidate.has("shortcuts")) candidate.add("shortcuts", shortcuts)
        if (!candidate.has("settings")) {
            candidate.add("settings", JsonObject().apply { addProperty("confirm_commands", false) })
        }
        candidate.add("schema_version", JsonPrimitive(2))
        candidate.add(
            "deck",
            JsonObject().apply {
                addProperty("id", uuidV5(namespace, LEGACY_DECK_KEY).toString())
                addProperty("name", "PocketDeck")
            },
        )

        codec.validateV2(candidate)
        return candidate
    }

    private fun canonicalizeV1Shortcuts(configuration: JsonObject) {
        configuration.get("shortcuts")?.asJsonArray?.forEach { element ->
            val shortcut = element.asJsonObject
            shortcut.addProperty("shortcut", normalizeShortcut(shortcut.get("shortcut").asString))
        }
        configuration.getAsJsonArray("actions").forEach { element ->
            val action = element.asJsonObject
            if (action.get("type").asString == "keyboard_shortcut") {
                normalizeInlineShortcut(action.getAsJsonObject("parameters"))
            }
        }
        configuration.get("commands")?.asJsonArray?.forEach { element ->
            element.asJsonObject.getAsJsonArray("steps").forEach { stepElement ->
                val step = stepElement.asJsonObject
                if (step.get("type").asString == "keyboard_shortcut") {
                    normalizeInlineShortcut(step.getAsJsonObject("parameters"))
                }
            }
        }
    }

    private fun normalizeInlineShortcut(parameters: JsonObject) {
        parameters.get("shortcut")?.let { value ->
            if (value !is JsonNull) parameters.addProperty("shortcut", normalizeShortcut(value.asString))
        }
    }
}

fun normalizeShortcut(source: String): String {
    val builtin = source.trim().lowercase()
    if (builtin in BUILTIN_SHORTCUTS) return builtin

    val parts = source.split('+').map { it.trim().uppercase() }
    require(parts.size in 2..5 && parts.none { it.isEmpty() }) {
        "Shortcut must include one supported key and at least one modifier."
    }
    val modifiers = parts.dropLast(1).map { modifier ->
        MODIFIER_ALIASES[modifier]
            ?: throw IllegalArgumentException("Unsupported shortcut modifier '$modifier'.")
    }
    require(modifiers.distinct().size == modifiers.size) {
        "Duplicate shortcut modifiers are not supported."
    }
    val key = KEY_ALIASES[parts.last()] ?: parts.last()
    require(SUPPORTED_KEYS.matches(key)) { "Unsupported shortcut key '${parts.last()}'." }
    require(!("WIN" in modifiers && key in setOf("L", "R"))) {
        "Windows+${key} is reserved and cannot be migrated."
    }
    return (MODIFIER_ORDER.filter { it in modifiers } + key).joinToString("+")
}

fun uuidV5(namespace: UUID, name: String): UUID {
    val namespaceBytes = ByteBuffer.allocate(16)
        .putLong(namespace.mostSignificantBits)
        .putLong(namespace.leastSignificantBits)
        .array()
    val digest = MessageDigest.getInstance("SHA-1").digest(namespaceBytes + name.toByteArray(Charsets.UTF_8))
    digest[6] = ((digest[6].toInt() and 0x0f) or 0x50).toByte()
    digest[8] = ((digest[8].toInt() and 0x3f) or 0x80).toByte()
    val bytes = ByteBuffer.wrap(digest)
    return UUID(bytes.long, bytes.long)
}

private val BUILTIN_SHORTCUTS = setOf("copy", "paste", "cut", "undo", "redo", "save", "select_all", "switch_app")
private val MODIFIER_ORDER = listOf("CTRL", "ALT", "SHIFT", "WIN")
private val MODIFIER_ALIASES = mapOf(
    "CTRL" to "CTRL",
    "CONTROL" to "CTRL",
    "ALT" to "ALT",
    "SHIFT" to "SHIFT",
    "WIN" to "WIN",
    "WINDOWS" to "WIN",
)
private val KEY_ALIASES = mapOf(
    "ESCAPE" to "ESC",
    "ARROWUP" to "UP",
    "ARROWDOWN" to "DOWN",
    "ARROWLEFT" to "LEFT",
    "ARROWRIGHT" to "RIGHT",
    "PAGE_UP" to "PAGEUP",
    "PAGE_DOWN" to "PAGEDOWN",
    "BACKTICK" to "BACKQUOTE",
    "TILDE" to "BACKQUOTE",
    "EQUALS" to "EQUAL",
    "`" to "BACKQUOTE",
    "-" to "MINUS",
    "=" to "EQUAL",
    "[" to "BRACKETLEFT",
    "]" to "BRACKETRIGHT",
    "\\" to "BACKSLASH",
    ";" to "SEMICOLON",
    "'" to "QUOTE",
    "," to "COMMA",
    "." to "PERIOD",
    "/" to "SLASH",
)
private val SUPPORTED_KEYS = Regex(
    "(?:[A-Z0-9]|NUMPAD[0-9]|F(?:[1-9]|1[0-9]|2[0-4])|ENTER|NUMPADENTER|TAB|ESC|SPACE|BACKSPACE|DELETE|INSERT|HOME|END|PAGEUP|PAGEDOWN|UP|DOWN|LEFT|RIGHT|BACKQUOTE|MINUS|EQUAL|BRACKETLEFT|BRACKETRIGHT|BACKSLASH|SEMICOLON|QUOTE|COMMA|PERIOD|SLASH|NUMPADADD|NUMPADSUBTRACT|NUMPADMULTIPLY|NUMPADDIVIDE|NUMPADDECIMAL)",
)
