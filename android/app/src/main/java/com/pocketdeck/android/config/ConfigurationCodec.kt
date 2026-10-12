package com.pocketdeck.android.config

import android.content.res.AssetManager
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.InputStreamReader
import java.io.File
import java.net.URI

const val MAX_CONFIGURATION_BYTES = 4 * 1024 * 1024

fun interface ConfigurationSchemaSource {
    fun read(version: Int): JsonObject
}

class AssetConfigurationSchemaSource(private val assets: AssetManager) : ConfigurationSchemaSource {
    override fun read(version: Int): JsonObject = assets.open("v$version/config.schema.json").use { input ->
        JsonParser.parseReader(InputStreamReader(input, Charsets.UTF_8)).asJsonObject
    }
}

class ClasspathConfigurationSchemaSource(
    private val loader: ClassLoader = Thread.currentThread().contextClassLoader,
) : ConfigurationSchemaSource {
    override fun read(version: Int): JsonObject {
        val name = "v$version/config.schema.json"
        val resource = loader?.getResourceAsStream(name)
        if (resource != null) {
            return resource.use { JsonParser.parseReader(InputStreamReader(it, Charsets.UTF_8)).asJsonObject }
        }
        val candidates = listOf(
            File("../../shared/schemas", name),
            File("../shared/schemas", name),
            File("shared/schemas", name),
        )
        val schemaFile = candidates.firstOrNull(File::isFile)
            ?: throw IllegalStateException("Shared v$version configuration schema is missing: $name")
        return JsonParser.parseString(schemaFile.readText(Charsets.UTF_8)).asJsonObject
    }
}

class ConfigurationValidationException(
    val problems: List<String>,
) : IllegalArgumentException(problems.joinToString("\n"))

/** Validates the JSON Schema keyword subset used by PocketDeck's shared 2020-12 schemas. */
class PocketDeckSchemaValidator {
    fun validate(instance: JsonElement, schema: JsonObject): List<String> {
        val schemaIssues = unsupportedSchemaFeatures(schema)
        if (schemaIssues.isNotEmpty()) return schemaIssues
        return validateNode(instance, schema, schema, "$", 0)
    }

    fun validateDefinition(
        instance: JsonElement,
        schema: JsonObject,
        definitionName: String,
        path: String,
    ): List<String> = validateNode(
        instance,
        schema.getAsJsonObject("\$defs").getAsJsonObject(definitionName),
        schema,
        path,
        0,
    )

    private fun validateNode(
        instance: JsonElement,
        schema: JsonObject,
        root: JsonObject,
        path: String,
        depth: Int,
    ): List<String> {
        if (depth > MAX_SCHEMA_DEPTH) return listOf("$path: schema nesting is too deep")
        val problems = mutableListOf<String>()

        schema.get("\$ref")?.asString?.let { ref ->
            val target = resolveLocalReference(root, ref)
            problems += validateNode(instance, target, root, path, depth + 1)
        }

        schema.get("type")?.let { typeSchema ->
            val acceptedTypes = if (typeSchema.isJsonArray) {
                typeSchema.asJsonArray.map { it.asString }
            } else {
                listOf(typeSchema.asString)
            }
            if (acceptedTypes.none { matchesType(instance, it) }) {
                return problems + "$path: expected ${acceptedTypes.joinToString(" or ")}"
            }
        }

        schema.get("const")?.let { expected ->
            if (instance != expected) problems += "$path: value does not match const"
        }
        schema.getAsJsonArray("enum")?.let { values ->
            if (values.none { it == instance }) problems += "$path: value is not in enum"
        }

        when {
            instance.isJsonObject -> {
                val value = instance.asJsonObject
                schema.getAsJsonArray("required")?.forEach { required ->
                    if (!value.has(required.asString)) {
                        problems += "$path.${required.asString}: required property is missing"
                    }
                }
                val propertySchemas = schema.getAsJsonObject("properties")
                propertySchemas?.entrySet()?.forEach { (name, childSchema) ->
                    if (value.has(name)) {
                        problems += validateNode(
                            value.get(name), childSchema.asJsonObject, root, "$path.$name", depth + 1,
                        )
                    }
                }
                schema.get("additionalProperties")?.let { additional ->
                    for ((name, child) in value.entrySet()) {
                        if (propertySchemas?.has(name) == true) continue
                        when {
                            additional.isJsonPrimitive && additional.asBoolean.not() ->
                                problems += "$path.$name: additional property is not allowed"
                            additional.isJsonObject -> problems += validateNode(
                                child, additional.asJsonObject, root, "$path.$name", depth + 1,
                            )
                        }
                    }
                }
                checkSize(value.size(), schema, "minProperties", "maxProperties", path, problems)
            }
            instance.isJsonArray -> {
                val value = instance.asJsonArray
                checkSize(value.size(), schema, "minItems", "maxItems", path, problems)
                schema.getAsJsonObject("items")?.let { itemSchema ->
                    value.forEachIndexed { index, child ->
                        problems += validateNode(child, itemSchema, root, "$path[$index]", depth + 1)
                    }
                }
                if (schema.get("uniqueItems")?.asBoolean == true) {
                    for (index in 0 until value.size()) {
                        if ((0 until index).any { previous -> value[index] == value[previous] }) {
                            problems += "$path[$index]: array items must be unique"
                            break
                        }
                    }
                }
            }
            instance.isJsonPrimitive && instance.asJsonPrimitive.isString -> {
                val value = instance.asString
                val length = value.codePointCount(0, value.length)
                checkSize(length, schema, "minLength", "maxLength", path, problems)
                schema.get("pattern")?.asString?.let { pattern ->
                    val matches = runCatching { Regex(pattern).containsMatchIn(value) }.getOrDefault(false)
                    if (!matches) problems += "$path: value does not match pattern"
                }
                if (schema.get("format")?.asString == "uri" && !isHttpUrl(value)) {
                    problems += "$path: expected an HTTP or HTTPS URL"
                }
            }
            instance.isJsonPrimitive && instance.asJsonPrimitive.isNumber -> {
                val number = runCatching { instance.asBigDecimal }.getOrNull()
                if (number != null) {
                    val isInteger = number.stripTrailingZeros().scale() <= 0
                    if (schema.get("type")?.let { type ->
                            if (type.isJsonArray) type.asJsonArray.any { it.asString == "integer" }
                            else type.asString == "integer"
                        } == true && !isInteger
                    ) problems += "$path: expected an integer"
                    schema.get("minimum")?.asBigDecimal?.let {
                        if (number < it) problems += "$path: value is below minimum"
                    }
                    schema.get("maximum")?.asBigDecimal?.let {
                        if (number > it) problems += "$path: value is above maximum"
                    }
                }
            }
        }

        schema.getAsJsonArray("allOf")?.forEach { branch ->
            problems += validateNode(instance, branch.asJsonObject, root, path, depth + 1)
        }
        schema.getAsJsonArray("anyOf")?.let { branches ->
            if (branches.none { validateNode(instance, it.asJsonObject, root, path, depth + 1).isEmpty() }) {
                problems += "$path: no anyOf branch matched"
            }
        }
        schema.getAsJsonArray("oneOf")?.let { branches ->
            val matches = branches.count {
                validateNode(instance, it.asJsonObject, root, path, depth + 1).isEmpty()
            }
            if (matches != 1) problems += "$path: expected exactly one oneOf branch, matched $matches"
        }
        schema.getAsJsonObject("not")?.let { forbidden ->
            if (validateNode(instance, forbidden, root, path, depth + 1).isEmpty()) {
                problems += "$path: forbidden schema matched"
            }
        }
        schema.getAsJsonObject("if")?.let { condition ->
            val branch = if (validateNode(instance, condition, root, path, depth + 1).isEmpty()) {
                schema.getAsJsonObject("then")
            } else {
                schema.getAsJsonObject("else")
            }
            if (branch != null) problems += validateNode(instance, branch, root, path, depth + 1)
        }
        return problems
    }

    private fun checkSize(
        size: Int,
        schema: JsonObject,
        minimum: String,
        maximum: String,
        path: String,
        problems: MutableList<String>,
    ) {
        schema.get(minimum)?.asInt?.let { if (size < it) problems += "$path: size is below $minimum" }
        schema.get(maximum)?.asInt?.let { if (size > it) problems += "$path: size is above $maximum" }
    }

    private fun matchesType(value: JsonElement, type: String): Boolean = when (type) {
        "object" -> value.isJsonObject
        "array" -> value.isJsonArray
        "string" -> value.isJsonPrimitive && value.asJsonPrimitive.isString
        "boolean" -> value.isJsonPrimitive && value.asJsonPrimitive.isBoolean
        "integer" -> value.isJsonPrimitive && value.asJsonPrimitive.isNumber &&
            runCatching { value.asBigDecimal.stripTrailingZeros().scale() <= 0 }.getOrDefault(false)
        "number" -> value.isJsonPrimitive && value.asJsonPrimitive.isNumber
        "null" -> value is JsonNull
        else -> false
    }

    private fun resolveLocalReference(root: JsonObject, ref: String): JsonObject {
        require(ref.startsWith("#/\$defs/")) { "Unsupported external schema reference: $ref" }
        var current: JsonElement = root
        for (rawToken in ref.removePrefix("#/").split('/')) {
            val token = rawToken.replace("~1", "/").replace("~0", "~")
            current = when {
                current.isJsonObject -> current.asJsonObject.get(token)
                current.isJsonArray -> current.asJsonArray[token.toInt()]
                else -> null
            } ?: throw IllegalArgumentException("Unresolved schema reference: $ref")
        }
        return current.asJsonObject
    }

    private fun unsupportedSchemaFeatures(root: JsonObject): List<String> {
        val issues = mutableListOf<String>()
        fun visit(node: JsonObject, path: String) {
            for (keyword in node.keySet()) {
                if (keyword !in SUPPORTED_KEYWORDS) {
                    issues += "$path: schema keyword '$keyword' is not supported by this API-23 validator"
                }
            }
            val format = node.get("format")?.asString
            if (format != null && format !in SUPPORTED_FORMATS) {
                issues += "$path: schema format '$format' is not supported by this API-23 validator"
            }
            node.getAsJsonObject("properties")?.entrySet()?.forEach { (name, child) ->
                if (child.isJsonObject) visit(child.asJsonObject, "$path.properties.$name")
            }
            node.getAsJsonObject("\$defs")?.entrySet()?.forEach { (name, child) ->
                if (child.isJsonObject) visit(child.asJsonObject, "$path.\$defs.$name")
            }
            for (keyword in listOf("items", "additionalProperties", "not", "if", "then", "else")) {
                node.get(keyword)?.takeIf { it.isJsonObject }?.asJsonObject?.let {
                    visit(it, "$path.$keyword")
                }
            }
            for (keyword in listOf("allOf", "anyOf", "oneOf")) {
                node.getAsJsonArray(keyword)?.forEachIndexed { index, child ->
                    if (child.isJsonObject) visit(child.asJsonObject, "$path.$keyword[$index]")
                }
            }
        }
        visit(root, "schema")
        return issues
    }

    private fun isHttpUrl(value: String): Boolean = runCatching {
        val uri = URI(value)
        uri.isAbsolute && uri.host != null && uri.scheme.lowercase() in setOf("http", "https")
    }.getOrDefault(false)

    private companion object {
        const val MAX_SCHEMA_DEPTH = 128
        val SUPPORTED_FORMATS = setOf("uri")
        val SUPPORTED_KEYWORDS = setOf(
            "\$schema", "\$id", "\$comment", "\$defs", "\$ref",
            "title", "description", "default", "type", "const", "enum",
            "required", "properties", "additionalProperties", "items",
            "allOf", "anyOf", "oneOf", "not", "if", "then", "else",
            "format", "pattern", "minLength", "maxLength", "minItems",
            "maxItems", "uniqueItems", "minimum", "maximum", "minProperties",
            "maxProperties",
        )
    }
}

class PocketDeckConfigurationCodec(
    private val schemaSource: ConfigurationSchemaSource,
    private val schemaValidator: PocketDeckSchemaValidator = PocketDeckSchemaValidator(),
) {
    fun validateV1(document: JsonElement): JsonObject {
        val root = requireObject(document)
        val schema = schemaSource.read(1)
        val schemaCandidate = root.deepCopy()
        // The v1 Pydantic model accepts null icons although the legacy schema says string.
        allowLegacyNullIconsForSchemaValidation(schemaCandidate)
        val failures = schemaValidator.validate(schemaCandidate, schema)
        if (failures.isNotEmpty()) throw ConfigurationValidationException(failures.take(MAX_REPORTED_ISSUES))
        validateSemantics(root, version = 1, schema = schema)
        return root
    }

    fun validateV2(document: JsonElement): PocketDeckConfiguration {
        val root = requireObject(document)
        val schema = schemaSource.read(2)
        val failures = schemaValidator.validate(root, schema)
        if (failures.isNotEmpty()) throw ConfigurationValidationException(failures.take(MAX_REPORTED_ISSUES))
        validateSemantics(root, version = 2, schema = schema)
        return PocketDeckConfiguration.fromValidatedDocument(root)
    }

    private fun requireObject(document: JsonElement): JsonObject {
        if (!document.isJsonObject) {
            throw ConfigurationValidationException(listOf("$: configuration root must be an object"))
        }
        return document.asJsonObject
    }

    private fun validateSemantics(root: JsonObject, version: Int, schema: JsonObject) {
        val problems = mutableListOf<String>()
        val ids = linkedSetOf<String>()
        fun addId(id: String, path: String) {
            if (!ids.add(id)) problems += "$path: duplicate ID '$id'"
        }
        if (version == 2) addId(root.getAsJsonObject("deck").get("id").asString, "deck.id")
        val actions = root.getAsJsonArray("actions").associateBy { it.asJsonObject.get("id").asString }
        val commands = root.getAsJsonArrayOrEmpty("commands").associateBy { it.asJsonObject.get("id").asString }
        val shortcuts = root.getAsJsonArrayOrEmpty("shortcuts").associateBy { it.asJsonObject.get("id").asString }

        root.getAsJsonArray("profiles").forEachIndexed { profileIndex, profileElement ->
            val profile = profileElement.asJsonObject
            addId(profile.get("id").asString, "profiles[$profileIndex].id")
            profile.getAsJsonArray("pages").forEachIndexed { pageIndex, pageElement ->
                val page = pageElement.asJsonObject
                val pagePath = "profiles[$profileIndex].pages[$pageIndex]"
                addId(page.get("id").asString, "$pagePath.id")
                val grid = page.getAsJsonObject("grid")
                val capacity = grid.get("columns").asInt * grid.get("rows").asInt
                val buttons = page.getAsJsonArray("buttons")
                if (buttons.size() > capacity) problems += "$pagePath.buttons: exceeds grid capacity"
                buttons.forEachIndexed { buttonIndex, buttonElement ->
                    val button = buttonElement.asJsonObject
                    addId(button.get("id").asString, "$pagePath.buttons[$buttonIndex].id")
                    val actionId = button.get("action_id")
                    if (actionId !is JsonNull && actionId.asString !in actions) {
                        problems += "$pagePath.buttons[$buttonIndex].action_id: action does not exist"
                    }
                }
            }
        }
        root.getAsJsonArray("actions").forEachIndexed { index, actionElement ->
            val action = actionElement.asJsonObject
            val path = "actions[$index]"
            addId(action.get("id").asString, "$path.id")
            val type = action.get("type").asString
            if (version == 1 && type == "system_monitor" && action.get("enabled_for_execution")?.asBoolean == true) {
                problems += "$path.enabled_for_execution: system_monitor must be read-only"
            }
            if (version == 2) {
                val target = action.get("target").asString
                if (type != "open_url" && target != "windows_host") {
                    problems += "$path.target: $type must target windows_host"
                }
                if (type == "system_monitor" && action.get("enabled_for_execution").asBoolean) {
                    problems += "$path.enabled_for_execution: system_monitor must be read-only"
                }
            }
            val parameters = action.getAsJsonObject("parameters")
            when (type) {
                "run_command" -> if (parameters.get("command_id").asString !in commands) {
                    problems += "$path.parameters.command_id: command does not exist"
                }
                "keyboard_shortcut" -> parameters.get("shortcut_id")?.let { ref ->
                    if (ref.asString !in shortcuts) problems += "$path.parameters.shortcut_id: shortcut does not exist"
                }
            }
        }
        root.getAsJsonArrayOrEmpty("shortcuts").forEachIndexed { index, shortcut ->
            addId(shortcut.asJsonObject.get("id").asString, "shortcuts[$index].id")
        }
        root.getAsJsonArrayOrEmpty("commands").forEachIndexed { commandIndex, commandElement ->
            val command = commandElement.asJsonObject
            val path = "commands[$commandIndex]"
            addId(command.get("id").asString, "$path.id")
            command.getAsJsonArray("steps").forEachIndexed { stepIndex, stepElement ->
                val step = stepElement.asJsonObject
                val type = step.get("type").asString
                val params = step.getAsJsonObject("parameters")
                if (type == "system_monitor" || type == "run_command") {
                    problems += "$path.steps[$stepIndex].type: unsupported executable command step"
                }
                val parameterDefinition = when (type) {
                    "open_url" -> "openUrlParameters"
                    "keyboard_shortcut" -> "keyboardShortcutParameters"
                    "wait" -> "waitParameters"
                    else -> null
                }
                if (parameterDefinition != null) {
                    problems += schemaValidator.validateDefinition(
                        params,
                        schema,
                        parameterDefinition,
                        "$path.steps[$stepIndex].parameters",
                    )
                }
                if (type == "keyboard_shortcut") {
                    params.get("shortcut_id")?.let { ref ->
                        if (ref.asString !in shortcuts) {
                            problems += "$path.steps[$stepIndex].parameters.shortcut_id: shortcut does not exist"
                        }
                    }
                }
            }
        }
        if (problems.isNotEmpty()) throw ConfigurationValidationException(problems.take(MAX_REPORTED_ISSUES))
    }

    private fun allowLegacyNullIconsForSchemaValidation(candidate: JsonObject) {
        candidate.getAsJsonArray("profiles").forEach { profileElement ->
            profileElement.asJsonObject.getAsJsonArray("pages").forEach { pageElement ->
                pageElement.asJsonObject.getAsJsonArray("buttons").forEach { buttonElement ->
                    val button = buttonElement.asJsonObject
                    if (button.get("icon") is JsonNull) button.remove("icon")
                }
            }
        }
    }

    private fun JsonObject.getAsJsonArrayOrEmpty(name: String): JsonArray =
        get(name)?.asJsonArray ?: JsonArray()

    private companion object {
        const val MAX_REPORTED_ISSUES = 64
    }
}
