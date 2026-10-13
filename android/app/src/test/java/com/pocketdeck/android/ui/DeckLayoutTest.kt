package com.pocketdeck.android.ui

import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DeckLayoutTest {
    @Test
    fun portraitLayoutsFitCommonButtonCountsWithoutPagination() {
        val expectedLayouts = listOf(
            Triple(1, 1, 1),
            Triple(2, 2, 1),
            Triple(6, 3, 2),
            Triple(7, 3, 3),
            Triple(10, 3, 4),
            Triple(15, 3, 5),
        )

        expectedLayouts.forEach { (count, columns, rows) ->
            val layout = responsiveDeckLayout(300.dp, 600.dp, count)
            assertEquals("$count buttons: columns", columns, layout.columns)
            assertEquals("$count buttons: rows", rows, layout.rows)
            assertTrue("$count buttons fit without pagination", layout.capacity >= count)
            assertEquals("$count buttons: pagination", false, layout.hasGroupControls)
        }
    }

    @Test
    fun landscapeLayoutsFitNormalDeckAndPaginateOversizedDecks() {
        val expectedLayouts = listOf(
            Triple(1, 1, 1),
            Triple(2, 2, 1),
            Triple(6, 3, 2),
            Triple(7, 4, 2),
            Triple(10, 5, 2),
        )
        expectedLayouts.forEach { (count, columns, rows) ->
            val layout = responsiveDeckLayout(720.dp, 240.dp, count)
            assertEquals("$count buttons: columns", columns, layout.columns)
            assertEquals("$count buttons: rows", rows, layout.rows)
            assertTrue("$count buttons fit without pagination", layout.capacity >= count)
            assertEquals("$count buttons: pagination", false, layout.hasGroupControls)
        }

        val fifteenButtonLayout = responsiveDeckLayout(720.dp, 240.dp, 15)
        assertEquals(5, fifteenButtonLayout.columns)
        assertEquals(2, fifteenButtonLayout.rows)
        assertEquals(10, fifteenButtonLayout.capacity)
        assertEquals(true, fifteenButtonLayout.hasGroupControls)
    }

    @Test
    fun constrainedCanvasUsesTouchFriendlyColumnsAndKeepsOneRow() {
        val layout = responsiveDeckLayout(220.dp, 70.dp, 6)
        assertEquals(2, layout.columns)
        assertEquals(1, layout.rows)
        assertEquals(2, layout.capacity)
        assertEquals(true, layout.hasGroupControls)
    }

    @Test
    fun compactStandardLargePortraitAndLandscapeCellsStayUniformAndProportional() {
        val screens = listOf(
            Triple(320.dp, 480.dp, 6),
            Triple(412.dp, 915.dp, 12),
            Triple(800.dp, 1280.dp, 20),
            Triple(720.dp, 240.dp, 10),
            Triple(1280.dp, 800.dp, 25),
        )
        screens.forEach { (width, height, count) ->
            val layout = responsiveDeckLayout(width, height, count)
            val size = responsiveDeckCardSize(
                width = width,
                height = height,
                columns = layout.columns,
                rows = layout.rows,
                hasGroupControls = layout.hasGroupControls,
            )
            val ratio = size.width / size.height
            assertTrue("positive card width at $width x $height", size.width > 0.dp)
            assertTrue("positive card height at $width x $height", size.height > 0.dp)
            assertTrue("card ratio at $width x $height", ratio in 0.72f..1.25f)
            assertTrue("all buttons fit a page at $width x $height", layout.capacity >= 1)
        }
    }

    @Test
    fun connectionPresentationUsesOneAuthoritativeStatus() {
        assertEquals(
            ConnectionDisplayState.Connected,
            connectionDisplayState("Connected", connected = true),
        )
        assertEquals(
            ConnectionDisplayState.Reconnecting,
            connectionDisplayState("Windows offline — retrying in 4s", connected = false),
        )
        assertEquals(
            ConnectionDisplayState.Connecting,
            connectionDisplayState("Loading Windows configuration", connected = false),
        )
        assertEquals(
            ConnectionDisplayState.Disconnected,
            connectionDisplayState("Windows offline", connected = false),
        )
        assertEquals(
            ConnectionDisplayState.NeedsAttention,
            connectionDisplayState("Connection needs attention", connected = false),
        )
    }
}
