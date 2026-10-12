package com.pocketdeck.android.config

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.JsonPrimitive
import com.google.gson.Strictness
import com.google.gson.stream.JsonReader
import com.google.gson.stream.JsonToken
import java.io.StringReader

object StrictJsonParser {
    fun parse(text: String): JsonElement = JsonReader(StringReader(text)).use { reader ->
        reader.setStrictness(Strictness.STRICT)
        val value: JsonElement = readValue(reader)
        require(reader.peek() == JsonToken.END_DOCUMENT) { "Trailing content after JSON document." }
        value
    }

    private fun readValue(reader: JsonReader): JsonElement = when (reader.peek()) {
        JsonToken.BEGIN_OBJECT -> {
            val result: JsonObject = JsonObject()
            val names: MutableSet<String> = mutableSetOf()
            reader.beginObject()
            while (reader.hasNext()) {
                val name: String = reader.nextName()
                require(names.add(name)) { "Duplicate JSON property '$name'." }
                result.add(name, readValue(reader))
            }
            reader.endObject()
            result
        }
        JsonToken.BEGIN_ARRAY -> {
            val result: JsonArray = JsonArray()
            reader.beginArray()
            while (reader.hasNext()) result.add(readValue(reader))
            reader.endArray()
            result
        }
        JsonToken.STRING -> JsonPrimitive(reader.nextString())
        JsonToken.NUMBER -> JsonParser.parseString(reader.nextString()).asJsonPrimitive
        JsonToken.BOOLEAN -> JsonPrimitive(reader.nextBoolean())
        JsonToken.NULL -> {
            reader.nextNull()
            JsonNull.INSTANCE
        }
        else -> throw IllegalArgumentException("Expected a JSON value.")
    }
}
