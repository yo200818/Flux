package com.pocketdeck.android.update

import android.app.DownloadManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.security.MessageDigest

class ReleaseMetadataParserTest {
    @Test
    fun semanticVersionComparisonUsesNumericComponents() {
        assertTrue(ReleaseMetadataParser.compareStableVersions("1.10.0", "1.9.9") > 0)
        assertTrue(ReleaseMetadataParser.compareStableVersions("2.0.0", "1.99.99") > 0)
        assertEquals(0, ReleaseMetadataParser.compareStableVersions("1.2.3", "1.2.3"))
        assertTrue(ReleaseMetadataParser.compareStableVersions("1.2.2", "1.2.3") < 0)
    }

    @Test
    fun newerStableReleaseWithLargerVersionCodeIsAvailable() {
        val result = parse(version = "1.10.0", versionCode = 10)

        assertTrue(result is UpdateAvailability.Available)
        assertEquals("1.10.0", (result as UpdateAvailability.Available).release.versionName)
        assertEquals("Bug fixes", result.release.releaseNotes)
    }

    @Test
    fun acceptsNextFluxReleaseTagAndAssetName() {
        val result = parse(version = "0.1.1", versionCode = 2)

        assertTrue(result is UpdateAvailability.Available)
        val release = (result as UpdateAvailability.Available).release
        assertEquals("v0.1.1", release.tagName)
        assertEquals("Flux-0.1.1.apk", release.apkAsset)
    }

    @Test
    fun matchingInstalledVersionAndCodeIsUpToDate() {
        val result = parse(version = "0.1.0", versionCode = 1, installedVersion = "0.1.0", installedCode = 1)

        assertEquals(UpdateAvailability.UpToDate("0.1.0"), result)
    }

    @Test
    fun rejectsNewVersionWithNonIncreasingVersionCode() {
        assertThrows(UpdateException::class.java) {
            parse(version = "1.0.0", versionCode = 1, installedVersion = "0.9.0", installedCode = 1)
        }
    }

    @Test
    fun rejectsDraftPrereleaseAndMismatchedReleaseMetadata() {
        assertThrows(UpdateException::class.java) {
            parse(version = "1.0.0", versionCode = 3, prerelease = true)
        }
        assertThrows(UpdateException::class.java) {
            parse(version = "1.0.0", versionCode = 3, tag = "v2.0.0")
        }
    }

    @Test
    fun rejectsReleaseAssetsOutsideTheConfiguredRepository() {
        val json = releaseJson(
            tag = "v1.0.0",
            apkUrl = "https://attacker.example/Flux-1.0.0.apk",
        )
        assertThrows(UpdateException::class.java) {
            ReleaseMetadataParser.parse(
                json,
                metadataJson("1.0.0", 3),
                installedVersionName = "0.1.0",
                installedVersionCode = 1,
            )
        }
    }

    @Test
    fun checksumVerificationRejectsChangedApkBytes() {
        val file = File.createTempFile("pocketdeck-update", ".apk")
        try {
            file.writeText("not the signed APK")
            assertFalse(UpdateValidation.sha256Matches(file, "0".repeat(64)))
            assertTrue(
                UpdateValidation.sha256Matches(
                    file,
                    sha256(file.readBytes()),
                ),
            )
        } finally {
            file.delete()
        }
    }

    @Test
    fun packageAndCertificateMustMatchTheInstalledApp() {
        assertThrows(UpdateException::class.java) {
            UpdateValidation.validatePackageName("com.attacker.app")
        }
        assertThrows(UpdateException::class.java) {
            UpdateValidation.validateSigningCertificates(setOf("installed-cert"), setOf("other-cert"))
        }
        UpdateValidation.validatePackageName(POCKETDECK_PACKAGE)
        UpdateValidation.validateSigningCertificates(setOf("same-cert"), setOf("same-cert"))
    }

    @Test
    fun failedDownloadHasActionableStateAndCancellationIsRepresentedSeparately() {
        val message = UpdateValidation.downloadFailure(DownloadManager.ERROR_INSUFFICIENT_SPACE)
        assertTrue(message.contains("not enough storage"))
        val cancelled: UpdateState = UpdateState.Cancelled(null)
        assertEquals(null, (cancelled as? UpdateState.Cancelled)?.release)
        val failed: UpdateState = UpdateState.Error("Network unavailable")
        assertEquals("Network unavailable", (failed as? UpdateState.Error)?.message)
    }

    private fun parse(
        version: String,
        versionCode: Int,
        installedVersion: String = "0.1.0",
        installedCode: Long = 1,
        prerelease: Boolean = false,
        tag: String = "v$version",
    ): UpdateAvailability =
        ReleaseMetadataParser.parse(
            releaseJson(tag, prerelease = prerelease),
            metadataJson(version, versionCode),
            installedVersion,
            installedCode,
        )

    private fun metadataJson(version: String, versionCode: Int): String =
        """
        {
          "schemaVersion": 1,
          "versionName": "$version",
          "versionCode": $versionCode,
          "apkAsset": "Flux-$version.apk",
          "sha256": "${"a".repeat(64)}"
        }
        """.trimIndent()

    private fun releaseJson(
        tag: String,
        apkUrl: String = "https://github.com/yo200818/Pocketdeck/releases/download/$tag/Flux-${tag.removePrefix("v")}.apk",
        prerelease: Boolean = false,
    ): String =
        """
        {
          "tag_name": "$tag",
          "draft": false,
          "prerelease": $prerelease,
          "body": "Bug fixes",
          "assets": [
            {
              "name": "pocketdeck-android.json",
              "browser_download_url": "https://github.com/yo200818/Pocketdeck/releases/download/$tag/pocketdeck-android.json"
            },
            {
              "name": "Flux-${tag.removePrefix("v")}.apk",
              "browser_download_url": "$apkUrl"
            }
          ]
        }
        """.trimIndent()

    private fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { "%02x".format(it) }
}
