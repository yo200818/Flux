package com.pocketdeck.android.navigation

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.pocketdeck.android.TestResources
import com.pocketdeck.android.config.PocketDeckConfiguration
import com.pocketdeck.android.config.DeviceDeckSelection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DeckSelectionNavigatorTest {
    @Test
    fun selectionRestoresByStableIdsAndFallsBackWhenIdsDisappear() {
        val configuration = multiPageConfiguration()

        assertEquals(
            DeviceDeckSelection("default", "second"),
            DeckSelectionNavigator.normalize(configuration, DeviceDeckSelection("default", "second")),
        )
        assertEquals(
            DeviceDeckSelection("default", "main"),
            DeckSelectionNavigator.normalize(configuration, DeviceDeckSelection("deleted", "stale")),
        )
    }

    @Test
    fun profileAndPageNavigationPreserveProfileOrderAndClampPageMovement() {
        val configuration = multiPageConfiguration()
        val secondProfile = DeckSelectionNavigator.selectProfile(configuration, "secondary")
        assertEquals(DeviceDeckSelection("secondary", "secondary-main"), secondProfile)
        assertEquals(
            DeviceDeckSelection("default", "second"),
            DeckSelectionNavigator.movePage(configuration, DeviceDeckSelection("default", "main"), 1),
        )
        assertEquals(
            DeviceDeckSelection("default", "second"),
            DeckSelectionNavigator.movePage(configuration, DeviceDeckSelection("default", "second"), 1),
        )
        assertNull(DeckSelectionNavigator.selectPage(configuration, DeviceDeckSelection("default", "main"), "missing"))
    }

    private fun multiPageConfiguration(): PocketDeckConfiguration {
        val document = JsonParser.parseString(
            TestResources.read("examples/config.v2.json"),
        ).asJsonObject
        val profiles = document.getAsJsonArray("profiles")
        val first = profiles[0].asJsonObject
        val secondPage = first.getAsJsonArray("pages")[0].asJsonObject.deepCopy().apply {
            addProperty("id", "second")
            addProperty("name", "Second")
            add("buttons", com.google.gson.JsonArray())
        }
        first.getAsJsonArray("pages").add(secondPage)
        val secondProfile = JsonObject().apply {
            addProperty("id", "secondary")
            addProperty("name", "Secondary")
            add("pages", com.google.gson.JsonArray().apply {
                add(JsonObject().apply {
                    addProperty("id", "secondary-main")
                    addProperty("name", "Secondary main")
                    add("grid", JsonObject().apply {
                        addProperty("columns", 1)
                        addProperty("rows", 1)
                    })
                    add("buttons", com.google.gson.JsonArray())
                })
            })
        }
        profiles.add(secondProfile)
        return PocketDeckConfiguration.fromValidatedDocument(document)
    }
}
