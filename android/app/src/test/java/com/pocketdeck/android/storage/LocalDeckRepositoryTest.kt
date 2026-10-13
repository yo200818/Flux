package com.pocketdeck.android.storage

import com.pocketdeck.android.config.ClasspathConfigurationSchemaSource
import com.pocketdeck.android.config.ConfigurationValidationException
import com.pocketdeck.android.config.DeviceDeckSelection
import com.pocketdeck.android.config.PocketDeckConfigurationCodec
import com.pocketdeck.android.migration.MigrationNamespaceSource
import com.pocketdeck.android.TestResources
import com.google.gson.JsonParser
import java.io.IOException
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class LocalDeckRepositoryTest {
    private val codec = PocketDeckConfigurationCodec(ClasspathConfigurationSchemaSource())
    private val namespace = MigrationNamespaceSource {
        UUID.fromString("8aa8ce90-35fa-4ab2-9c49-5d4732cb3267")
    }

    @Test
    fun importsAndRestoresTheLastAcceptedSnapshot() {
        val storage = MemoryTextSnapshotStorage()
        val repository = LocalDeckRepository(storage, namespace, codec)
        val imported = repository.importConfiguration(TestResources.read("examples/config.v2.json"))
        val reloaded = LocalDeckRepository(storage, namespace, codec).restore()

        assertNotNull(reloaded)
        assertEquals(imported.configuration.document, reloaded!!.configuration.document)
        assertEquals(imported.selection, reloaded.selection)
    }

    @Test
    fun synchronizedLogoReferencesAreTypedAndPersistedAcrossRestore() {
        val source = JsonParser.parseString(
            TestResources.read("examples/config.v2.json"),
        ).asJsonObject
        val logoId = "logo_" + "a".repeat(32)
        source.getAsJsonArray("profiles")[0].asJsonObject.addProperty("logo_asset_id", logoId)
        source.getAsJsonArray("profiles")[0].asJsonObject
            .getAsJsonArray("pages")[0].asJsonObject
            .getAsJsonArray("buttons")[0].asJsonObject
            .addProperty("logo_asset_id", logoId)
        source.getAsJsonArray("actions")[0].asJsonObject.addProperty("logo_asset_id", logoId)
        val alternateLogoId = "logo_" + "b".repeat(32)
        val alternateProfile = source.getAsJsonArray("profiles")[0].asJsonObject.deepCopy().apply {
            addProperty("id", "alternate")
            addProperty("name", "Alternate")
            addProperty("logo_asset_id", alternateLogoId)
            getAsJsonArray("pages").forEachIndexed { pageIndex, element ->
                element.asJsonObject.apply {
                    addProperty("id", "alternate-page-$pageIndex")
                    getAsJsonArray("buttons").forEachIndexed { buttonIndex, button ->
                        button.asJsonObject.addProperty(
                            "id",
                            "alternate-button-$pageIndex-$buttonIndex",
                        )
                    }
                }
            }
        }
        source.getAsJsonArray("profiles").add(alternateProfile)

        val storage = MemoryTextSnapshotStorage()
        val repository = LocalDeckRepository(storage, namespace, codec)
        val imported = repository.importConfiguration(source.toString())
        val switched = repository.updateSelection(
            imported,
            DeviceDeckSelection("alternate", "alternate-page-0"),
        )
        val restored = LocalDeckRepository(storage, namespace, codec).restore()!!

        assertEquals(logoId, imported.configuration.profiles.first().logoAssetId)
        assertEquals(logoId, imported.configuration.profiles.first().pages.first().buttons.first().logoAssetId)
        assertEquals(logoId, imported.configuration.actions.first().logoAssetId)
        assertEquals("alternate", switched.selection.profileId)
        assertEquals("alternate", restored.selection.profileId)
        assertEquals(
            alternateLogoId,
            restored.configuration.profiles.first { it.id == restored.selection.profileId }.logoAssetId,
        )
        assertEquals(
            logoId,
            restored.configuration.profiles.first().pages.first().buttons.first().logoAssetId,
        )
        assertEquals(logoId, restored.configuration.actions.first().logoAssetId)
    }

    @Test
    fun invalidImportLeavesPreviousSnapshotByteForByteUnchanged() {
        val storage = MemoryTextSnapshotStorage()
        val repository = LocalDeckRepository(storage, namespace, codec)
        repository.importConfiguration(TestResources.read("examples/config.v2.json"))
        val savedBytes = storage.contents

        val error = assertThrows(ConfigurationValidationException::class.java) {
            repository.importConfiguration("{\"schema_version\":2,\"credential\":\"no\"}")
        }

        assertNotNull(error.message)
        assertEquals(savedBytes, storage.contents)

        assertThrows(ConfigurationValidationException::class.java) {
            repository.importConfiguration("{\"schema_version\":2,\"schema_version\":2}")
        }
        assertEquals(savedBytes, storage.contents)
    }

    @Test
    fun writeFailureRetainsPreviousSnapshotAndSelection() {
        val storage = MemoryTextSnapshotStorage()
        val repository = LocalDeckRepository(storage, namespace, codec)
        val initial = repository.importConfiguration(twoPageConfiguration())
        val savedBytes = storage.contents
        storage.failWrites = true

        assertThrows(IOException::class.java) {
            repository.updateSelection(
                initial,
                DeviceDeckSelection("default", "second-page"),
            )
        }

        assertEquals(savedBytes, storage.contents)
        assertEquals(initial.selection, LocalDeckRepository(storage, namespace, codec).restore()?.selection)

        val changedConfig = JsonParser.parseString(twoPageConfiguration()).asJsonObject
        changedConfig.getAsJsonObject("deck").addProperty("name", "Changed")
        assertThrows(IOException::class.java) {
            repository.importConfiguration(changedConfig.toString())
        }
        assertEquals(savedBytes, storage.contents)
    }

    @Test
    fun invalidLegacyMigrationDoesNotReplaceExistingSnapshot() {
        val storage = MemoryTextSnapshotStorage()
        val repository = LocalDeckRepository(storage, namespace, codec)
        repository.importConfiguration(TestResources.read("examples/config.v2.json"))
        val savedBytes = storage.contents
        val invalidLegacy = TestResources.read("examples/config.v1.json").replace(
            "\"schema_version\": 1",
            "\"schema_version\": 1, \"credential\": \"bad\"",
        )

        assertThrows(ConfigurationValidationException::class.java) {
            repository.importConfiguration(invalidLegacy)
        }

        assertEquals(savedBytes, storage.contents)
    }

    @Test
    fun deviceLocalSelectionIsPersistedWithoutEditingConfiguration() {
        val storage = MemoryTextSnapshotStorage()
        val repository = LocalDeckRepository(storage, namespace, codec)
        val imported = repository.importConfiguration(twoPageConfiguration())
        val configBefore = imported.configuration.document.deepCopy()

        val updated = repository.updateSelection(
            imported,
            DeviceDeckSelection(profileId = "default", pageId = "second-page"),
        )

        assertEquals(configBefore, updated.configuration.document)
        assertEquals(updated.selection, LocalDeckRepository(storage, namespace, codec).restore()?.selection)
        assertNull(updated.configuration.document.get("selected_page"))
    }

    private fun twoPageConfiguration(): String {
        val root = JsonParser.parseString(TestResources.read("examples/config.v2.json")).asJsonObject
        val page = root.getAsJsonArray("profiles")[0].asJsonObject.getAsJsonArray("pages")[0]
            .asJsonObject.deepCopy().apply {
                addProperty("id", "second-page")
                addProperty("name", "Second page")
                add("buttons", com.google.gson.JsonArray())
            }
        root.getAsJsonArray("profiles")[0].asJsonObject.getAsJsonArray("pages").add(page)
        return root.toString()
    }

    private class MemoryTextSnapshotStorage(
        var contents: String? = null,
        var failWrites: Boolean = false,
    ) : TextSnapshotStorage {
        override fun read(): String? = contents

        override fun writeAtomically(contents: String) {
            if (failWrites) throw IOException("injected persistence failure")
            this.contents = contents
        }
    }
}
