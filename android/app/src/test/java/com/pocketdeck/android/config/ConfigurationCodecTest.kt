package com.pocketdeck.android.config

import com.google.gson.JsonParser
import com.pocketdeck.android.TestResources
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

class ConfigurationCodecTest {
    private val codec = PocketDeckConfigurationCodec(ClasspathConfigurationSchemaSource())

    @Test
    fun acceptsSharedV2ExampleAndKeepsAllButtons() {
        val document = TestResources.read("examples/config.v2.json")
        val configuration = codec.validateV2(JsonParser.parseString(document))

        assertEquals("pocketdeck-main", configuration.deck.id)
        assertEquals("default", configuration.profiles.single().id)
        assertEquals(4, configuration.profiles.single().pages.single().buttons.size)
        assertEquals("prepare-copy-command", configuration.actions.last().parameters.get("command_id").asString)
    }

    @Test
    fun acceptsNullButtonAssignment() {
        val root = JsonParser.parseString(TestResources.read("examples/config.v2.json")).asJsonObject
        root.getAsJsonArray("profiles")[0].asJsonObject
            .getAsJsonArray("pages")[0].asJsonObject
            .getAsJsonArray("buttons")[0].asJsonObject
            .add("action_id", com.google.gson.JsonNull.INSTANCE)

        val decoded = codec.validateV2(root)

        assertNull(decoded.profiles.first().pages.first().buttons.first().actionId)
    }

    @Test
    fun rejectsUnknownFieldsAndDanglingActionAssignments() {
        val extra = JsonParser.parseString(TestResources.read("examples/config.v2.json")).asJsonObject
        extra.addProperty("device_credential", "must-not-be-imported")
        assertThrows(ConfigurationValidationException::class.java) { codec.validateV2(extra) }

        val dangling = JsonParser.parseString(TestResources.read("examples/config.v2.json")).asJsonObject
        dangling.getAsJsonArray("profiles")[0].asJsonObject
            .getAsJsonArray("pages")[0].asJsonObject
            .getAsJsonArray("buttons")[0].asJsonObject
            .addProperty("action_id", "missing-action")
        assertThrows(ConfigurationValidationException::class.java) { codec.validateV2(dangling) }
    }

    @Test
    fun rejectsWrongCommandStepParameterType() {
        val root = JsonParser.parseString(TestResources.read("examples/config.v2.json")).asJsonObject
        root.getAsJsonArray("commands")[0].asJsonObject
            .getAsJsonArray("steps")[0].asJsonObject
            .addProperty("type", "wait")

        assertThrows(ConfigurationValidationException::class.java) { codec.validateV2(root) }
    }

    @Test
    fun validatorFailsClosedWhenSharedSchemaAddsAnUnsupportedKeyword() {
        val schema = JsonParser.parseString(
            TestResources.read("schemas/v2/config.schema.json"),
        ).asJsonObject
        schema.add("unevaluatedProperties", com.google.gson.JsonObject())
        val document = JsonParser.parseString(TestResources.read("examples/config.v2.json"))

        val problems = PocketDeckSchemaValidator().validate(document, schema)

        assertTrue(problems.any { it.contains("unevaluatedProperties") })
    }
}
