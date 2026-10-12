package com.pocketdeck.android.storage

import android.content.Context
import android.util.AtomicFile
import com.pocketdeck.android.migration.MigrationNamespaceSource
import java.io.File
import java.io.IOException
import java.util.UUID

interface TextSnapshotStorage {
    @Throws(IOException::class)
    fun read(): String?

    @Throws(IOException::class)
    fun writeAtomically(contents: String)
}

class AndroidAtomicTextStorage(context: Context, fileName: String) : TextSnapshotStorage {
    private val atomicFile = AtomicFile(File(context.filesDir, fileName))

    override fun read(): String? {
        if (!atomicFile.baseFile.exists()) return null
        return atomicFile.openRead().use { input ->
            input.readBytes().toString(Charsets.UTF_8)
        }
    }

    override fun writeAtomically(contents: String) {
        val output = atomicFile.startWrite()
        try {
            output.write(contents.toByteArray(Charsets.UTF_8))
            output.flush()
            output.fd.sync()
            atomicFile.finishWrite(output)
        } catch (error: Exception) {
            atomicFile.failWrite(output)
            if (error is IOException) throw error
            throw IOException("Could not atomically save PocketDeck data.", error)
        }
    }
}

class AtomicMigrationNamespaceSource(
    private val storage: TextSnapshotStorage,
) : MigrationNamespaceSource {
    @Synchronized
    override fun getOrCreate(): UUID {
        val saved = storage.read()?.trim()
        if (saved != null) {
            return runCatching { UUID.fromString(saved) }
                .getOrElse { throw IOException("The local migration namespace is invalid.", it) }
        }
        val generated = UUID.randomUUID()
        storage.writeAtomically(generated.toString())
        return generated
    }
}
