package com.pocketdeck.android.migration

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.pocketdeck.android.TestResources
import com.pocketdeck.android.config.ClasspathConfigurationSchemaSource
import com.pocketdeck.android.config.ConfigurationValidationException
import com.pocketdeck.android.config.PocketDeckConfigurationCodec
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class V1ToV2MigratorTest {
    private val namespace = UUID.fromString("8aa8ce90-35fa-4ab2-9c49-5d4732cb3267")
    private val codec = PocketDeckConfigurationCodec(ClasspathConfigurationSchemaSource())
    private val migrator = V1ToV2Migrator(codec, namespace)

    @Test
    fun migratesCommandsShortcutsSettingsAndAllTargetsLosslessly() {
        val source = representativeV1()
        val original = source.deepCopy()

        val migrated = migrator.migrate(source)

        assertEquals(original, source)
        assertEquals("2", migrated.get("schema_version").asString)
        assertEquals(uuidV5(namespace, LEGACY_DECK_KEY).toString(), migrated.getAsJsonObject("deck").get("id").asString)
        assertEquals(listOf("open_url", "keyboard_shortcut", "wait"), migrated.getAsJsonArray("commands")[0]
            .asJsonObject.getAsJsonArray("steps").map { it.asJsonObject.get("type").asString })
        assertEquals("CTRL+SHIFT+R", migrated.getAsJsonArray("shortcuts")[0].asJsonObject.get("shortcut").asString)
        assertEquals("CTRL+ALT+T", migrated.getAsJsonArray("commands")[0].asJsonObject
            .getAsJsonArray("steps")[1].asJsonObject.getAsJsonObject("parameters").get("shortcut").asString)
        assertEquals(true, migrated.getAsJsonObject("settings").get("confirm_commands").asBoolean)
        assertEquals("run-setup-action", migrated.getAsJsonArray("profiles")[0].asJsonObject
            .getAsJsonArray("pages")[0].asJsonObject.getAsJsonArray("buttons")[3]
            .asJsonObject.get("action_id").asString)
        assertEquals("run-setup-action", migrated.getAsJsonArray("actions").last().asJsonObject.get("id").asString)
        assertEquals("windows_host", migrated.getAsJsonArray("actions").last().asJsonObject.get("target").asString)
        assertEquals("prepare-copy", migrated.getAsJsonArray("actions").last().asJsonObject
            .getAsJsonObject("parameters").get("command_id").asString)
        assertEquals("CTRL+SHIFT+R", migrated.getAsJsonArray("shortcuts")[0].asJsonObject.get("shortcut").asString)
        assertEquals("button-save", migrated.getAsJsonArray("profiles")[0].asJsonObject
            .getAsJsonArray("pages")[0].asJsonObject.getAsJsonArray("buttons")[2].asJsonObject.get("id").asString)
        assertEquals("action-save-shortcut", migrated.getAsJsonArray("profiles")[0].asJsonObject
            .getAsJsonArray("pages")[0].asJsonObject.getAsJsonArray("buttons")[2].asJsonObject.get("action_id").asString)
        assertEquals("windows_host", migrated.getAsJsonArray("actions")[0].asJsonObject.get("target").asString)
        assertEquals(4, migrated.getAsJsonArray("profiles")[0].asJsonObject.getAsJsonArray("pages")[0]
            .asJsonObject.getAsJsonArray("buttons").size())
    }

    @Test
    fun migrationIsDeterministicAndPreservesSourceOrdering() {
        val source = representativeV1()
        val first = migrator.migrate(source)
        val second = migrator.migrate(source)

        assertEquals(first, second)
        assertEquals(listOf("default"), first.getAsJsonArray("profiles").map { it.asJsonObject.get("id").asString })
        assertEquals(listOf("main"), first.getAsJsonArray("profiles")[0].asJsonObject.getAsJsonArray("pages")
            .map { it.asJsonObject.get("id").asString })
        assertEquals(listOf("open-pocketdeck-site", "button-copy", "button-save", "run-setup"),
            first.getAsJsonArray("profiles")[0].asJsonObject.getAsJsonArray("pages")[0].asJsonObject
                .getAsJsonArray("buttons").map { it.asJsonObject.get("id").asString })
    }

    @Test
    fun migrationPreservesButtonAssignmentsAndMapsLegacyActionsToWindowsHost() {
        val source = representativeV1()
        val originalAssignments = source.getAsJsonArray("profiles")[0].asJsonObject
            .getAsJsonArray("pages")[0].asJsonObject.getAsJsonArray("buttons")
            .map { it.asJsonObject.get("action_id") }

        val migrated = migrator.migrate(source)

        val migratedAssignments = migrated.getAsJsonArray("profiles")[0].asJsonObject
            .getAsJsonArray("pages")[0].asJsonObject.getAsJsonArray("buttons")
            .map { it.asJsonObject.get("action_id") }
        assertEquals(originalAssignments, migratedAssignments)
        migrated.getAsJsonArray("actions").forEach { action ->
            assertEquals("windows_host", action.asJsonObject.get("target").asString)
        }
    }

    @Test
    fun rejectsUnsupportedFieldsNestedCommandsAndReadOnlyMonitorSteps() {
        val unknownField = representativeV1().apply { addProperty("credential", "never-import") }
        assertThrows(ConfigurationValidationException::class.java) { migrator.migrate(unknownField) }

        val nested = representativeV1()
        nested.getAsJsonArray("commands")[0].asJsonObject.getAsJsonArray("steps")[0] = JsonObject().apply {
            addProperty("type", "run_command")
            add("parameters", JsonObject().apply { addProperty("command_id", "prepare-copy") })
        }
        assertThrows(ConfigurationValidationException::class.java) { migrator.migrate(nested) }

        val monitor = representativeV1()
        monitor.getAsJsonArray("commands")[0].asJsonObject.getAsJsonArray("steps")[0] = JsonObject().apply {
            addProperty("type", "system_monitor")
            add("parameters", JsonObject().apply { addProperty("metric", "cpu_utilization") })
        }
        assertThrows(ConfigurationValidationException::class.java) { migrator.migrate(monitor) }
    }

    @Test
    fun missingReferencedCommandAndInvalidNamespaceFailWithoutChangingSource() {
        val source = representativeV1()
        source.getAsJsonArray("commands").asList().clear()
        val original = source.deepCopy()
        assertThrows(ConfigurationValidationException::class.java) { migrator.migrate(source) }
        assertEquals(original, source)

        assertThrows(IllegalArgumentException::class.java) {
            V1ToV2Migrator(codec, namespace).migrate(representativeV1().apply {
                getAsJsonArray("actions").last().asJsonObject.getAsJsonObject("parameters")
                    .addProperty("command_id", "missing-command")
            })
        }
    }

    @Test
    fun preservesUnassignedActionAndNeverCreatesAnAndroidLocalLegacyTarget() {
        val source = representativeV1()
        source.getAsJsonArray("profiles")[0].asJsonObject.getAsJsonArray("pages")[0]
            .asJsonObject.getAsJsonArray("buttons")[0].asJsonObject.add("action_id", com.google.gson.JsonNull.INSTANCE)
        val migrated = migrator.migrate(source)

        assertEquals(com.google.gson.JsonNull.INSTANCE, migrated.getAsJsonArray("profiles")[0].asJsonObject
            .getAsJsonArray("pages")[0].asJsonObject.getAsJsonArray("buttons")[0].asJsonObject.get("action_id"))
        assertEquals(0, migrated.getAsJsonArray("actions").count {
            it.asJsonObject.get("target").asString == "android_local"
        })
        assertNotEquals("", migrated.getAsJsonObject("deck").get("id").asString)
    }

    private fun representativeV1(): JsonObject {
        val root = JsonParser.parseString(TestResources.read("examples/config.v1.json")).asJsonObject
        root.getAsJsonArray("actions")[1].asJsonObject.getAsJsonObject("parameters")
            .addProperty("shortcut", "shift+ctrl+r")
        root.getAsJsonArray("profiles")[0].asJsonObject.getAsJsonArray("pages")[0]
            .asJsonObject.getAsJsonArray("buttons").add(JsonObject().apply {
                addProperty("id", "run-setup")
                addProperty("label", "Run setup")
                addProperty("action_id", "run-setup-action")
            })
        root.getAsJsonArray("actions").add(JsonObject().apply {
            addProperty("id", "run-setup-action")
            addProperty("type", "run_command")
            addProperty("enabled_for_execution", true)
            add("parameters", JsonObject().apply { addProperty("command_id", "prepare-copy") })
        })
        root.add("shortcuts", JsonParser.parseString("""[
            {"id":"copy-custom","name":"Copy custom","shortcut":"ctrl+shift+r"}
        ]""").asJsonArray)
        root.add("commands", JsonParser.parseString("""[
            {
              "id":"prepare-copy",
              "name":"Prepare copy",
              "enabled":true,
              "steps":[
                {"type":"open_url","parameters":{"url":"https://example.com/"}},
                {"type":"keyboard_shortcut","parameters":{"shortcut":"alt+ctrl+t"}},
                {"type":"wait","parameters":{"milliseconds":125}}
              ]
            }
        ]""").asJsonArray)
        root.add("settings", JsonObject().apply { addProperty("confirm_commands", true) })
        return root
    }
}
