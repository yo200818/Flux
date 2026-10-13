package com.pocketdeck.android.update

import android.app.DownloadManager
import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import androidx.core.content.FileProvider
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.math.BigInteger
import java.net.URI
import java.security.MessageDigest

internal const val POCKETDECK_PACKAGE = "com.pocketdeck.android"
private const val RELEASES_ENDPOINT =
    "https://api.github.com/repos/yo200818/Pocketdeck/releases/latest"
private const val RELEASE_METADATA_ASSET = "pocketdeck-android.json"
private const val MAX_APK_SIZE_BYTES = 512L * 1024L * 1024L
private const val DOWNLOAD_PREFERENCES = "pocketdeck-updates"
private const val PENDING_DOWNLOAD_KEY = "pending-download"
private const val READY_UPDATE_KEY = "ready-update"
private const val INSTALL_VERSION_CODE_KEY = "install-version-code"
private const val INSTALL_VERSION_NAME_KEY = "install-version-name"

data class PocketDeckRelease(
    val versionName: String,
    val versionCode: Int,
    val tagName: String,
    val releaseNotes: String,
    val apkAsset: String,
    val apkUrl: String,
    val sha256: String,
)

data class ReadyUpdate(
    val release: PocketDeckRelease,
    val apkPath: String,
)

sealed interface UpdateAvailability {
    data class UpToDate(val installedVersion: String) : UpdateAvailability
    data class Available(val release: PocketDeckRelease) : UpdateAvailability
}

private fun okhttp3.Response.readLimitedBody(limit: Int, emptyMessage: String): String {
    val responseBody = body ?: throw UpdateException(emptyMessage)
    if (responseBody.contentLength() > limit) {
        throw UpdateException("GitHub release metadata exceeded the allowed size.")
    }
    val output = ByteArrayOutputStream()
    responseBody.byteStream().use { input ->
        val buffer = ByteArray(8_192)
        var total = 0
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            total += count
            if (total > limit) {
                throw UpdateException("GitHub release metadata exceeded the allowed size.")
            }
            output.write(buffer, 0, count)
        }
    }
    if (output.size() == 0) throw UpdateException(emptyMessage)
    return output.toString(Charsets.UTF_8.name())
}

sealed interface UpdateState {
    data object Checking : UpdateState
    data class UpToDate(val installedVersion: String) : UpdateState
    data class Available(val release: PocketDeckRelease) : UpdateState
    data class Downloading(
        val release: PocketDeckRelease,
        val bytesDownloaded: Long,
        val totalBytes: Long,
    ) : UpdateState
    data class Verifying(val release: PocketDeckRelease) : UpdateState
    data class ReadyToInstall(val update: ReadyUpdate) : UpdateState
    data class InstallPermissionRequired(
        val update: ReadyUpdate,
        val message: String,
    ) : UpdateState
    data class InstallationLaunched(val versionName: String) : UpdateState
    data class Installed(val versionName: String) : UpdateState
    data class Cancelled(
        val release: PocketDeckRelease?,
        val verifiedUpdate: ReadyUpdate? = null,
    ) : UpdateState
    data class Error(
        val message: String,
        val release: PocketDeckRelease? = null,
    ) : UpdateState
}

class UpdateException(message: String, cause: Throwable? = null) : IOException(message, cause)

object ReleaseMetadataParser {
    fun parse(
        releaseJson: String,
        metadataJson: String,
        installedVersionName: String,
        installedVersionCode: Long,
    ): UpdateAvailability {
        val release = parseObject(releaseJson, "GitHub release")
        if (release.requiredBoolean("draft") || release.requiredBoolean("prerelease")) {
            throw UpdateException("The latest GitHub release is not a published stable release.")
        }
        val tagName = release.requiredString("tag_name")
        val releaseNotes = release.stringOrNull("body").orEmpty().take(12_000)
        val assets = release.getAsJsonArray("assets")
            ?: throw UpdateException("The GitHub release has no asset list.")
        val metadataAsset = assets.firstOrNull {
            it.isJsonObject && it.asJsonObject.stringOrNull("name") == RELEASE_METADATA_ASSET
        }?.asJsonObject ?: throw UpdateException(
            "This release is missing the required $RELEASE_METADATA_ASSET metadata asset.",
        )
        val metadataUrl = metadataAsset.requiredString("browser_download_url")
        validateReleaseAssetUrl(metadataUrl, tagName, RELEASE_METADATA_ASSET)

        val metadata = parseObject(metadataJson, "Android release metadata")
        if (metadata.requiredInt("schemaVersion") != 1) {
            throw UpdateException("The Android release metadata version is not supported.")
        }
        val versionName = metadata.requiredString("versionName")
        if (versionName.length > 64) {
            throw UpdateException("The Android release version metadata is invalid.")
        }
        val versionCode = metadata.requiredInt("versionCode")
        if (versionCode < 1 || !isStableVersion(versionName)) {
            throw UpdateException("The Android release version metadata is invalid.")
        }
        if (tagName != "v$versionName") {
            throw UpdateException("The GitHub release tag does not match its Android version.")
        }
        val versionOrder = compareStableVersions(versionName, installedVersionName)
        if (versionOrder < 0) {
            throw UpdateException("The latest release is older than the installed app.")
        }
        if (versionOrder > 0 && versionCode.toLong() <= installedVersionCode) {
            throw UpdateException("The release versionCode must be greater than the installed app.")
        }

        val apkAssetName = metadata.requiredString("apkAsset")
        if (!apkAssetName.matches(Regex("[A-Za-z0-9._-]+\\.apk"))) {
            throw UpdateException("The APK asset name in the release metadata is invalid.")
        }
        val apkAsset = assets.firstOrNull {
            it.isJsonObject && it.asJsonObject.stringOrNull("name") == apkAssetName
        }?.asJsonObject ?: throw UpdateException("The GitHub release is missing its APK asset.")
        val apkUrl = apkAsset.requiredString("browser_download_url")
        validateReleaseAssetUrl(apkUrl, tagName, apkAssetName)

        val checksum = metadata.requiredString("sha256").lowercase()
        if (!checksum.matches(Regex("[a-f0-9]{64}"))) {
            throw UpdateException("The release SHA-256 checksum is invalid.")
        }
        val releaseInfo = PocketDeckRelease(
            versionName = versionName,
            versionCode = versionCode,
            tagName = tagName,
            releaseNotes = releaseNotes,
            apkAsset = apkAssetName,
            apkUrl = apkUrl,
            sha256 = checksum,
        )
        return if (versionCode.toLong() > installedVersionCode) {
            UpdateAvailability.Available(releaseInfo)
        } else {
            UpdateAvailability.UpToDate(installedVersionName)
        }
    }

    fun compareStableVersions(left: String, right: String): Int {
        if (!isStableVersion(left) || !isStableVersion(right)) {
            throw UpdateException("A version is not in stable major.minor.patch format.")
        }
        val leftParts = left.split('.').map(::BigInteger)
        val rightParts = right.split('.').map(::BigInteger)
        for (index in 0..2) {
            val compared = leftParts[index].compareTo(rightParts[index])
            if (compared != 0) return compared
        }
        return 0
    }

    private fun isStableVersion(value: String): Boolean =
        value.matches(Regex("(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)"))

    internal fun validateReleaseAssetUrl(url: String, tag: String, name: String) {
        val uri = runCatching { URI(url) }.getOrNull()
            ?: throw UpdateException("A GitHub release asset URL is invalid.")
        val expectedSuffix = "$tag/$name"
        val path = uri.rawPath.orEmpty()
        if (uri.scheme != "https" ||
            uri.host != "github.com" ||
            uri.rawUserInfo != null ||
            uri.query != null ||
            uri.fragment != null ||
            !tag.matches(Regex("[A-Za-z0-9._-]+")) ||
            path != "/yo200818/Pocketdeck/releases/download/$expectedSuffix"
        ) {
            throw UpdateException("A GitHub release asset URL is invalid.")
        }
    }

    private fun parseObject(json: String, description: String): JsonObject =
        try {
            JsonParser.parseString(json).takeIf { it.isJsonObject }?.asJsonObject
                ?: throw UpdateException("$description is not a JSON object.")
        } catch (failure: UpdateException) {
            throw failure
        } catch (failure: Exception) {
            throw UpdateException("$description contains malformed JSON.", failure)
        }

    private fun JsonObject.requiredString(name: String): String =
        stringOrNull(name)?.takeIf(String::isNotBlank)
            ?: throw UpdateException("Release metadata is missing $name.")

    private fun JsonObject.stringOrNull(name: String): String? =
        get(name)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString

    private fun JsonObject.requiredInt(name: String): Int =
        try {
            get(name)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }
                ?.asBigDecimal?.intValueExact()
                ?: throw UpdateException("Release metadata is missing $name.")
        } catch (failure: Exception) {
            throw UpdateException("Release metadata field $name is invalid.", failure)
        }

    private fun JsonObject.requiredBoolean(name: String): Boolean =
        get(name)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isBoolean }?.asBoolean
            ?: throw UpdateException("GitHub release metadata is missing $name.")
}

object UpdateValidation {
    fun sha256Matches(file: File, expected: String): Boolean {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().buffered().use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
            .equals(expected, ignoreCase = true)
    }

    fun validatePackageName(actual: String?, expected: String = POCKETDECK_PACKAGE) {
        if (actual != expected) {
            throw UpdateException("The downloaded APK is not a Flux Android package.")
        }
    }

    fun validateSigningCertificates(
        installedCertificateDigests: Set<String>,
        apkCertificateDigests: Set<String>,
    ) {
        if (installedCertificateDigests.isEmpty() ||
            apkCertificateDigests.isEmpty() ||
            installedCertificateDigests != apkCertificateDigests
        ) {
            throw UpdateException(
                "The APK signing certificate does not match this installed Flux app.",
            )
        }
    }

    fun downloadFailure(reason: Int): String = when (reason) {
        DownloadManager.ERROR_CANNOT_RESUME ->
            "The update download could not resume. Try downloading it again."
        DownloadManager.ERROR_DEVICE_NOT_FOUND ->
            "Android could not find storage for the update download."
        DownloadManager.ERROR_FILE_ERROR ->
            "Android could not save the downloaded update."
        DownloadManager.ERROR_HTTP_DATA_ERROR,
        DownloadManager.ERROR_UNHANDLED_HTTP_CODE ->
            "The release server returned an invalid or unavailable download."
        DownloadManager.ERROR_INSUFFICIENT_SPACE ->
            "There is not enough storage space to download the update."
        DownloadManager.ERROR_TOO_MANY_REDIRECTS ->
            "The release download redirected too many times."
        else -> "The APK download failed (Android download error $reason)."
    }
}

class AndroidUpdateManager(
    private val context: Context,
    private val httpClient: OkHttpClient = OkHttpClient(),
) {
    private val preferences = context.getSharedPreferences(DOWNLOAD_PREFERENCES, Context.MODE_PRIVATE)
    private val gson = Gson()
    private val downloadManager =
        context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager

    suspend fun checkForUpdate(): UpdateAvailability = withContext(Dispatchers.IO) {
        val installed = installedPackageInfo()
        val request = Request.Builder()
            .url(RELEASES_ENDPOINT)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("User-Agent", "PocketDeck-Android")
            .build()
        val releaseJson = httpClient.newCall(request).execute().use { response ->
            when {
                response.code == 404 ->
                    throw UpdateException("No stable Flux release has been published yet.")
                !response.isSuccessful ->
                    throw UpdateException("GitHub could not provide release information (HTTP ${response.code}).")
                else -> response.readLimitedBody(
                    1_048_576,
                    "GitHub returned an empty release response.",
                )
            }
        }
        val releaseObject = runCatching { JsonParser.parseString(releaseJson).asJsonObject }
            .getOrElse { throw UpdateException("GitHub returned malformed release information.", it) }
        val tag = releaseObject.get("tag_name")?.asString
            ?: throw UpdateException("The GitHub release is missing its tag.")
        val assets = releaseObject.getAsJsonArray("assets")
            ?: throw UpdateException("The GitHub release has no asset list.")
        val metadataUrl = assets.firstOrNull {
            it.isJsonObject &&
                it.asJsonObject.get("name")?.takeIf { name -> name.isJsonPrimitive }?.asString ==
                RELEASE_METADATA_ASSET
        }?.asJsonObject?.get("browser_download_url")?.asString
            ?: throw UpdateException("The GitHub release is missing its Android metadata asset.")
        ReleaseMetadataParser.validateReleaseAssetUrl(
            metadataUrl,
            tag,
            RELEASE_METADATA_ASSET,
        )
        val metadataRequest = Request.Builder()
            .url(metadataUrl)
            .header("User-Agent", "PocketDeck-Android")
            .build()
        val metadataJson = httpClient.newCall(metadataRequest).execute().use { response ->
            if (!response.isSuccessful) {
                throw UpdateException("GitHub could not provide Android release metadata (HTTP ${response.code}).")
            }
            response.readLimitedBody(65_536, "GitHub returned empty Android release metadata.")
        }
        ReleaseMetadataParser.parse(
            releaseJson = releaseJson,
            metadataJson = metadataJson,
            installedVersionName = installed.versionName ?: "0.0.0",
            installedVersionCode = installed.versionCodeCompat(),
        )
    }

    fun startDownload(release: PocketDeckRelease): Long {
        cancelDownload()
        clearReadyUpdate()
        val destination = apkFile(release)
        if (destination.exists() && !destination.delete()) {
            throw UpdateException("Flux could not replace an earlier APK download.")
        }
        val request = DownloadManager.Request(Uri.parse(release.apkUrl))
            .setTitle("Flux ${release.versionName}")
            .setDescription("Downloading the Android update")
            .setMimeType("application/vnd.android.package-archive")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setAllowedOverRoaming(false)
            .setDestinationInExternalFilesDir(
                context,
                Environment.DIRECTORY_DOWNLOADS,
                "pocketdeck-updates/${release.apkAsset}",
            )
        val id = downloadManager.enqueue(request)
        preferences.edit()
            .putString(PENDING_DOWNLOAD_KEY, gson.toJson(DownloadRecord(id, release)))
            .remove(READY_UPDATE_KEY)
            .apply()
        return id
    }

    suspend fun downloadAndVerify(
        id: Long,
        release: PocketDeckRelease,
        onProgress: (Long, Long) -> Unit,
    ): ReadyUpdate {
        while (true) {
            val result = withContext(Dispatchers.IO) { queryDownload(id) }
            if (result.totalBytes > MAX_APK_SIZE_BYTES ||
                result.downloadedBytes > MAX_APK_SIZE_BYTES
            ) {
                cancelDownload()
                throw UpdateException("The release APK exceeds Android's 512 MiB safety limit.")
            }
            when (result.status) {
                DownloadManager.STATUS_PENDING,
                DownloadManager.STATUS_PAUSED,
                DownloadManager.STATUS_RUNNING -> {
                    onProgress(result.downloadedBytes, result.totalBytes)
                    delay(500)
                }
                DownloadManager.STATUS_SUCCESSFUL -> {
                    val file = apkFile(release)
                    onProgress(result.totalBytes, result.totalBytes)
                    try {
                        withContext(Dispatchers.IO) { verifyApk(file, release) }
                    } catch (failure: Exception) {
                        file.delete()
                        downloadManager.remove(id)
                        preferences.edit().remove(PENDING_DOWNLOAD_KEY).apply()
                        throw failure
                    }
                    val ready = ReadyUpdate(release, file.absolutePath)
                    preferences.edit()
                        .remove(PENDING_DOWNLOAD_KEY)
                        .putString(READY_UPDATE_KEY, gson.toJson(ready))
                        .apply()
                    return ready
                }
                DownloadManager.STATUS_FAILED -> {
                    val message = UpdateValidation.downloadFailure(result.reason)
                    apkFile(release).delete()
                    downloadManager.remove(id)
                    preferences.edit().remove(PENDING_DOWNLOAD_KEY).apply()
                    throw UpdateException(message)
                }
                else -> throw UpdateException("Android returned an unknown update download state.")
            }
        }
    }

    fun pendingDownload(): Pair<Long, PocketDeckRelease>? =
        runCatching {
            preferences.getString(PENDING_DOWNLOAD_KEY, null)?.let {
                gson.fromJson(it, DownloadRecord::class.java)?.let { record ->
                    record.id to record.release
                }
            }
        }.getOrNull()

    fun readyUpdate(): ReadyUpdate? =
        runCatching {
            preferences.getString(READY_UPDATE_KEY, null)?.let {
                gson.fromJson(it, ReadyUpdate::class.java)
            }?.takeIf { File(it.apkPath).isFile }
        }.getOrNull()

    fun cancelDownload() {
        val record = pendingDownload()
        if (record != null) {
            downloadManager.remove(record.first)
            apkFile(record.second).delete()
        }
        preferences.edit().remove(PENDING_DOWNLOAD_KEY).apply()
    }

    fun clearReadyUpdate() {
        readyUpdate()?.let { File(it.apkPath).delete() }
        preferences.edit().remove(READY_UPDATE_KEY).apply()
    }

    fun apkContentUri(update: ReadyUpdate): Uri =
        FileProvider.getUriForFile(
            context,
            "${context.packageName}.updates",
            File(update.apkPath),
        )

    fun isVersionInstalled(versionCode: Int): Boolean =
        runCatching { installedPackageInfo().versionCodeCompat() >= versionCode.toLong() }
            .getOrDefault(false)

    fun pendingInstallVersionCode(): Long =
        preferences.getLong(INSTALL_VERSION_CODE_KEY, -1L)

    fun pendingInstallVersionName(): String? =
        preferences.getString(INSTALL_VERSION_NAME_KEY, null)

    fun markInstallationLaunched(versionCode: Int, versionName: String) {
        preferences.edit()
            .putLong(INSTALL_VERSION_CODE_KEY, versionCode.toLong())
            .putString(INSTALL_VERSION_NAME_KEY, versionName)
            .apply()
    }

    fun clearPendingInstall() {
        preferences.edit()
            .remove(INSTALL_VERSION_CODE_KEY)
            .remove(INSTALL_VERSION_NAME_KEY)
            .apply()
    }

    private fun queryDownload(id: Long): DownloadStatus {
        val cursor = downloadManager.query(DownloadManager.Query().setFilterById(id))
            ?: throw UpdateException("Android could not inspect the update download.")
        cursor.use {
            if (!it.moveToFirst()) {
                throw UpdateException("The update download is no longer available. Try again.")
            }
            return DownloadStatus(
                status = it.getInt(it.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)),
                reason = it.getInt(it.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON)),
                downloadedBytes = it.getLong(
                    it.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR),
                ),
                totalBytes = it.getLong(
                    it.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES),
                ),
            )
        }
    }

    private fun verifyApk(file: File, release: PocketDeckRelease) {
        if (!file.isFile || file.length() == 0L) {
            throw UpdateException("The downloaded APK is empty or missing.")
        }
        if (!UpdateValidation.sha256Matches(file, release.sha256)) {
            file.delete()
            throw UpdateException("The APK checksum does not match the published release metadata.")
        }
        val signingFlag = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            @Suppress("DEPRECATION")
            PackageManager.GET_SIGNATURES
        }
        val archive = context.packageManager.getPackageArchiveInfo(file.absolutePath, signingFlag)
            ?: throw UpdateException("Android could not read the downloaded APK.")
        UpdateValidation.validatePackageName(archive.packageName, context.packageName)
        if (archive.versionName != release.versionName ||
            archive.versionCodeCompat() != release.versionCode.toLong()
        ) {
            throw UpdateException("The APK version does not match the published release metadata.")
        }
        val installedSigners = signerDigests(installedPackageInfo())
        val apkSigners = signerDigests(archive)
        UpdateValidation.validateSigningCertificates(installedSigners, apkSigners)
    }

    private fun signerDigests(info: PackageInfo): Set<String> {
        val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.signingInfo?.apkContentsSigners
        } else {
            @Suppress("DEPRECATION")
            info.signatures
        } ?: emptyArray()
        return signatures.map { signature ->
            MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())
                .joinToString("") { "%02x".format(it) }
        }.toSet()
    }

    private fun installedPackageInfo(): PackageInfo {
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            @Suppress("DEPRECATION")
            PackageManager.GET_SIGNATURES
        }
        return try {
            context.packageManager.getPackageInfo(context.packageName, flags)
        } catch (failure: PackageManager.NameNotFoundException) {
            throw UpdateException("Flux's installed package information is unavailable.", failure)
        }
    }

    private fun apkFile(release: PocketDeckRelease): File {
        val downloads = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
            ?: throw UpdateException("Android app storage is unavailable for the APK download.")
        val folder = File(downloads, "pocketdeck-updates")
        if (!folder.exists() && !folder.mkdirs()) {
            throw UpdateException("Flux could not create its private update storage.")
        }
        return File(folder, release.apkAsset)
    }

    private fun PackageInfo.versionCodeCompat(): Long {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            longVersionCode
        } else {
            @Suppress("DEPRECATION")
            versionCode.toLong()
        }
    }

    private data class DownloadRecord(val id: Long, val release: PocketDeckRelease)
    private data class DownloadStatus(
        val status: Int,
        val reason: Int,
        val downloadedBytes: Long,
        val totalBytes: Long,
    )
}
