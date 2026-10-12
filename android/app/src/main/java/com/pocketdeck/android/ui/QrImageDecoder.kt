package com.pocketdeck.android.ui

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import com.google.zxing.BinaryBitmap
import com.google.zxing.ChecksumException
import com.google.zxing.FormatException
import com.google.zxing.NotFoundException
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader

internal fun decodeQrImage(contentResolver: ContentResolver, uri: Uri): String {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    val boundsInput = contentResolver.openInputStream(uri)
        ?: error("The selected image could not be opened.")
    boundsInput.use { BitmapFactory.decodeStream(it, null, bounds) }
    require(bounds.outWidth > 0 && bounds.outHeight > 0) {
        "The selected file is not a readable PNG, JPEG, or WebP image."
    }

    val sampleSize = calculateQrImageSampleSize(bounds.outWidth, bounds.outHeight)
    val options = BitmapFactory.Options().apply {
        inSampleSize = sampleSize
        inPreferredConfig = Bitmap.Config.RGB_565
    }
    val bitmap = contentResolver.openInputStream(uri)?.use {
        BitmapFactory.decodeStream(it, null, options)
    } ?: error("The selected image could not be decoded.")

    return try {
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        decodeQrPixels(bitmap.width, bitmap.height, pixels)
    } finally {
        bitmap.recycle()
    }
}

internal fun calculateQrImageSampleSize(width: Int, height: Int): Int {
    require(width > 0 && height > 0)
    var sampleSize = 1
    while (maxOf(width, height) / sampleSize > MAX_QR_IMAGE_DIMENSION) {
        sampleSize *= 2
    }
    return sampleSize
}

internal class QrDetectionGate {
    private var claimed = false

    @Synchronized
    fun claim(): Boolean {
        if (claimed) return false
        claimed = true
        return true
    }

    @Synchronized
    fun reset() {
        claimed = false
    }
}

internal fun decodeQrPixels(width: Int, height: Int, pixels: IntArray): String {
    require(width > 0 && height > 0 && pixels.size == width * height)
    val bitmap = BinaryBitmap(
        HybridBinarizer(RGBLuminanceSource(width, height, pixels)),
    )
    return try {
        QRCodeReader().decode(bitmap).text
    } catch (failure: NotFoundException) {
        throw IllegalArgumentException(
            "No QR code was found in the image. Try a clear, uncropped image and upload again.",
            failure,
        )
    } catch (failure: ChecksumException) {
        throw IllegalArgumentException(
            "The QR code in the image is damaged. Try a clearer image and upload again.",
            failure,
        )
    } catch (failure: FormatException) {
        throw IllegalArgumentException(
            "The QR code in the image is not readable. Try a clearer image and upload again.",
            failure,
        )
    }
}

private const val MAX_QR_IMAGE_DIMENSION = 2_048
