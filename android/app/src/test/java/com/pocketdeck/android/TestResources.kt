package com.pocketdeck.android

import java.io.File

internal object TestResources {
    fun read(path: String): String {
        TestResources::class.java.classLoader?.getResourceAsStream(path)?.use { stream ->
            return stream.bufferedReader().use { it.readText() }
        }
        val candidates = listOf(
            File("../../shared", path),
            File("../shared", path),
            File("shared", path),
        )
        val file = candidates.firstOrNull(File::isFile)
            ?: error("Could not locate shared fixture '$path' from ${File(".").absolutePath}")
        return file.readText(Charsets.UTF_8)
    }
}
