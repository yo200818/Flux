package com.pocketdeck.android.storage

import android.graphics.BitmapFactory
import java.io.File
import java.io.FileOutputStream
import java.util.regex.Pattern

class LogoAssetCache(private val filesDirectory: File) {
    private val cacheDirectory = File(filesDirectory, "logo-assets")

    fun contains(assetId: String): Boolean {
        if (!isValidAssetId(assetId)) return false
        val file = assetFile(assetId)
        if (!file.isFile || file.length() !in 1..MAX_CACHE_ASSET_BYTES.toLong()) return false
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, bounds)
        return bounds.outMimeType == "image/webp" &&
            bounds.outWidth in 1..MAX_THUMBNAIL_EDGE &&
            bounds.outHeight in 1..MAX_THUMBNAIL_EDGE &&
            bounds.outWidth.toLong() * bounds.outHeight <= MAX_THUMBNAIL_PIXELS
    }

    fun write(assetId: String, contentType: String, bytes: ByteArray) {
        require(isValidAssetId(assetId)) { "Logo asset reference is invalid." }
        require(contentType.substringBefore(';').trim().equals("image/webp", ignoreCase = true)) {
            "Windows returned an unsupported logo image type."
        }
        require(bytes.isNotEmpty() && bytes.size <= MAX_CACHE_ASSET_BYTES) {
            "Windows returned a logo image over the size limit."
        }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        require(
            bounds.outMimeType == "image/webp" &&
                bounds.outWidth in 1..MAX_THUMBNAIL_EDGE &&
                bounds.outHeight in 1..MAX_THUMBNAIL_EDGE &&
                bounds.outWidth.toLong() * bounds.outHeight <= MAX_THUMBNAIL_PIXELS,
        ) { "Windows returned a malformed or oversized logo thumbnail." }

        check(cacheDirectory.exists() || cacheDirectory.mkdirs()) {
            "The private logo cache could not be created."
        }
        val destination = assetFile(assetId)
        val temporary = File(cacheDirectory, ".$assetId.tmp")
        try {
            FileOutputStream(temporary).use { stream ->
                stream.write(bytes)
                stream.fd.sync()
            }
            check(temporary.renameTo(destination)) {
                "The synchronized logo thumbnail could not be stored."
            }
        } finally {
            if (temporary.exists()) {
                check(temporary.delete()) {
                    "A temporary logo thumbnail could not be removed."
                }
            }
        }
    }

    fun imageFile(assetId: String): File? =
        if (contains(assetId)) assetFile(assetId) else null

    private fun assetFile(assetId: String): File = File(cacheDirectory, "$assetId.webp")

    private fun isValidAssetId(assetId: String): Boolean =
        ASSET_ID_PATTERN.matcher(assetId).matches()

    private companion object {
        const val MAX_CACHE_ASSET_BYTES = 512 * 1024
        const val MAX_THUMBNAIL_EDGE = 384
        const val MAX_THUMBNAIL_PIXELS = 384L * 384L
        val ASSET_ID_PATTERN: Pattern = Pattern.compile("logo_[a-f0-9]{32}")
    }
}
