package com.pocketdeck.android.ui

import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Test

class DeckLayoutTest {
    @Test
    fun landscapeWidthUsesFiveColumnsWhenDeckCanvasFits() {
        assertEquals(5, responsiveDeckColumns(720.dp, 210.dp))
        assertEquals(4, responsiveDeckColumns(700.dp, 209.dp))
    }

    @Test
    fun narrowCanvasReducesColumnCountWithoutCreatingButtons() {
        assertEquals(4, responsiveDeckColumns(560.dp, 180.dp))
        assertEquals(3, responsiveDeckColumns(430.dp, 160.dp))
        assertEquals(2, responsiveDeckColumns(400.dp, 160.dp))
    }
}
