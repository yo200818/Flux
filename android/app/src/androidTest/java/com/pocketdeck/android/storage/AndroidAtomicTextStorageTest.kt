package com.pocketdeck.android.storage

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import android.content.Context
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AndroidAtomicTextStorageTest {
    @Test
    fun snapshotSurvivesReopeningTheAtomicFileAdapter() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val fileName = "atomic-test-${UUID.randomUUID()}.json"
        val contents = "{\"storage_version\":1,\"configuration\":{},\"selection\":{}}"
        try {
            AndroidAtomicTextStorage(context, fileName).writeAtomically(contents)

            assertEquals(contents, AndroidAtomicTextStorage(context, fileName).read())
        } finally {
            context.deleteFile(fileName)
            context.deleteFile("$fileName.bak")
            context.deleteFile("$fileName.new")
        }
    }
}
