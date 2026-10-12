package com.pocketdeck.android.storage

import com.google.gson.GsonBuilder
import com.google.gson.JsonObject
import com.pocketdeck.android.config.ConfigurationValidationException
import com.pocketdeck.android.config.DeviceDeckSelection
import com.pocketdeck.android.config.MAX_CONFIGURATION_BYTES
import com.pocketdeck.android.config.PocketDeckConfiguration
import com.pocketdeck.android.config.PocketDeckConfigurationCodec
import com.pocketdeck.android.config.StrictJsonParser
import com.pocketdeck.android.migration.MigrationNamespaceSource
import com.pocketdeck.android.migration.V1ToV2Migrator
import com.pocketdeck.android.navigation.DeckSelectionNavigator

class LocalDeckRepository(
    private val snapshotStorage: TextSnapshotStorage,
    private val namespaceSource: MigrationNamespaceSource,
    private val codec: PocketDeckConfigurationCodec,
) {
    private val gson = GsonBuilder().disableHtmlEscaping().create()

    fun restore(): StoredDeck? {
        val text = snapshotStorage.read() ?: return null
        return decodeStoredState(text)
    }

    fun importConfiguration(jsonText: String): StoredDeck {
        val byteCount = jsonText.toByteArray(Charsets.UTF_8).size
        if (byteCount > MAX_CONFIGURATION_BYTES) {
            throw ConfigurationValidationException(
                listOf("$: configuration exceeds the 4 MiB import limit"),
            )
        }
        val input = runCatching { StrictJsonParser.parse(jsonText) }
            .getOrElse { throw ConfigurationValidationException(listOf("$: invalid JSON: ${it.message}")) }
        if (!input.isJsonObject) {
            throw ConfigurationValidationException(listOf("$: configuration root must be an object"))
        }
        val source = input.asJsonObject
        val version = source.get("schema_version")
        if (version == null || !version.isJsonPrimitive || !version.asJsonPrimitive.isNumber) {
            throw ConfigurationValidationException(listOf("schema_version: a supported integer version is required"))
        }
        val versionNumber = runCatching { version.asBigDecimal }.getOrNull()
        if (versionNumber == null || versionNumber.stripTrailingZeros().scale() > 0) {
            throw ConfigurationValidationException(listOf("schema_version: expected integer 1 or 2"))
        }
        val schemaVersion = runCatching { versionNumber.intValueExact() }.getOrNull()
            ?: throw ConfigurationValidationException(listOf("schema_version: expected integer 1 or 2"))
        if (schemaVersion !in setOf(1, 2)) {
            throw ConfigurationValidationException(
                listOf("schema_version: unsupported PocketDeck configuration version $schemaVersion"),
            )
        }
        val configuration = when (schemaVersion) {
            1 -> V1ToV2Migrator(codec, namespaceSource.getOrCreate()).migrate(source)
            2 -> codec.validateV2(source).document
            else -> error("schema version was checked above")
        }
        val validated = codec.validateV2(configuration)
        val previousSelection = readPreviousSelectionOrNull()
        val selection = DeckSelectionNavigator.normalize(validated, previousSelection)
        val next = StoredDeck(validated, selection)
        snapshotStorage.writeAtomically(encodeStoredState(next))
        return next
    }

    fun updateSelection(
        current: StoredDeck,
        selection: DeviceDeckSelection,
    ): StoredDeck {
        val normalized = DeckSelectionNavigator.normalize(current.configuration, selection)
        val updated = current.copy(selection = normalized)
        snapshotStorage.writeAtomically(encodeStoredState(updated))
        return updated
    }

    private fun readPreviousSelectionOrNull(): DeviceDeckSelection? = runCatching {
        val saved = snapshotStorage.read() ?: return null
        decodeStoredState(saved).selection
    }.getOrNull()

    private fun encodeStoredState(state: StoredDeck): String {
        val envelope = JsonObject().apply {
            addProperty("storage_version", STORAGE_VERSION)
            add("configuration", state.configuration.document.deepCopy())
            add(
                "selection",
                JsonObject().apply {
                    state.selection.profileId?.let { addProperty("profile_id", it) }
                    state.selection.pageId?.let { addProperty("page_id", it) }
                },
            )
        }
        return gson.toJson(envelope)
    }

    private fun decodeStoredState(text: String): StoredDeck {
        val envelope = runCatching { StrictJsonParser.parse(text) }
            .getOrElse { throw ConfigurationValidationException(listOf("Saved deck snapshot is invalid JSON.")) }
        if (!envelope.isJsonObject) {
            throw ConfigurationValidationException(listOf("Saved deck snapshot is not an object."))
        }
        val root = envelope.asJsonObject
        if (root.keySet() != setOf("storage_version", "configuration", "selection")) {
            throw ConfigurationValidationException(listOf("Saved deck snapshot has unsupported fields."))
        }
        if (root.get("storage_version")?.asInt != STORAGE_VERSION) {
            throw ConfigurationValidationException(listOf("Saved deck snapshot version is unsupported."))
        }
        val configuration = codec.validateV2(root.get("configuration"))
        val selectionElement = root.get("selection")
        if (selectionElement == null || !selectionElement.isJsonObject) {
            throw ConfigurationValidationException(listOf("Saved deck selection is malformed."))
        }
        val selectionObject = selectionElement.asJsonObject
        if (selectionObject.keySet().any { it !in setOf("profile_id", "page_id") }) {
            throw ConfigurationValidationException(listOf("Saved deck selection has unsupported fields."))
        }
        val selection = DeviceDeckSelection(
            profileId = selectionObject.get("profile_id")?.takeUnless { it.isJsonNull }?.asString,
            pageId = selectionObject.get("page_id")?.takeUnless { it.isJsonNull }?.asString,
        )
        return StoredDeck(configuration, DeckSelectionNavigator.normalize(configuration, selection))
    }

    private companion object {
        const val STORAGE_VERSION = 1
    }
}

data class StoredDeck(
    val configuration: PocketDeckConfiguration,
    val selection: DeviceDeckSelection,
)
