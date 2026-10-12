package com.pocketdeck.android.ui

import android.graphics.Bitmap
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import android.content.Context
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class QrImageDecoderInstrumentedTest {
    @Test
    fun decodesWindowsVersionedQrFromGalleryPngUri() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val payload =
            """{"type":"pocketdeck.connection","version":2,"server_id":"6b7bb8da-a30a-45bd-9b89-4a42a191a7c4","wifi_addresses":["192.168.1.12"],"port":8443,"certificate_sha256":"${"A1".repeat(32)}","certificate_expires_at":1800000000}"""
        val matrix = QRCodeWriter().encode(payload, BarcodeFormat.QR_CODE, 512, 512)
        val bitmap = Bitmap.createBitmap(matrix.width, matrix.height, Bitmap.Config.ARGB_8888)
        for (y in 0 until matrix.height) {
            for (x in 0 until matrix.width) {
                bitmap.setPixel(
                    x,
                    y,
                    if (matrix[x, y]) android.graphics.Color.BLACK else android.graphics.Color.WHITE,
                )
            }
        }
        val image = File(context.cacheDir, "pocketdeck-qr-${System.nanoTime()}.png")
        try {
            image.outputStream().use { output ->
                check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output))
            }

            assertEquals(payload, decodeQrImage(context.contentResolver, Uri.fromFile(image)))
        } finally {
            bitmap.recycle()
            image.delete()
        }
    }
}
