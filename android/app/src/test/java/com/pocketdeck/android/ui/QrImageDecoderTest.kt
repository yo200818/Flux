package com.pocketdeck.android.ui

import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class QrImageDecoderTest {
    @Test
    fun decodesVersionedWindowsQrPixelsFromAnImage() {
        val payload =
            """{"type":"pocketdeck.connection","version":2,"server_id":"6b7bb8da-a30a-45bd-9b89-4a42a191a7c4","wifi_addresses":["192.168.1.12"],"port":8443,"certificate_sha256":"${"A1".repeat(32)}","certificate_expires_at":1800000000}"""
        val matrix = QRCodeWriter().encode(payload, BarcodeFormat.QR_CODE, 512, 512)
        val pixels = IntArray(matrix.width * matrix.height)
        for (y in 0 until matrix.height) {
            for (x in 0 until matrix.width) {
                pixels[y * matrix.width + x] =
                    if (matrix[x, y]) 0xFF000000.toInt() else 0xFFFFFFFF.toInt()
            }
        }

        assertEquals(payload, decodeQrPixels(matrix.width, matrix.height, pixels))
    }

    @Test
    fun detectionGateSuppressesDuplicateResultsUntilTheNextScan() {
        val gate = QrDetectionGate()

        assertTrue(gate.claim())
        assertFalse(gate.claim())
        gate.reset()
        assertTrue(gate.claim())
    }

    @Test
    fun largeGalleryImagesAreDownsampledToAnEfficientBound() {
        assertEquals(2, calculateQrImageSampleSize(4_000, 3_000))
        assertEquals(1, calculateQrImageSampleSize(1_920, 1_080))
        assertEquals(8, calculateQrImageSampleSize(16_384, 12_288))
    }
}
