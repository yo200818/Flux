package com.pocketdeck.android.transport

import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.net.SocketTimeoutException
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.MultiFormatReader
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.qrcode.QRCodeWriter

class DeviceCredentialHandshakeTest {
    @Test
    fun pairingPinRequiresExactlySixAsciiDigits() {
        assertTrue(isValidPairingPin("000001"))
        assertTrue(!isValidPairingPin("12345"))
        assertTrue(!isValidPairingPin("1234567"))
        assertTrue(!isValidPairingPin("12a456"))
        assertTrue(!isValidPairingPin("１２３４５６"))
    }

    @Test
    fun scannedQrPinsServerIdentityAndCertificate() {
        val settings = parseWifiConnectionQr(
            """{"type":"pocketdeck.connection","version":1,"server_id":"6b7bb8da-a30a-45bd-9b89-4a42a191a7c4","addresses":["192.168.1.7"],"port":18443,"certificate_sha256":"${"A1".repeat(32)}"}""",
        )

        assertEquals("192.168.1.7", settings.host)
        assertEquals(18443, settings.port)
        assertEquals("a1".repeat(32), settings.certificateFingerprint)
        assertEquals("6b7bb8da-a30a-45bd-9b89-4a42a191a7c4", settings.serverId)
    }

    @Test
    fun parsesCurrentVersionedWindowsPayloadAndKeepsWifiEndpointDistinctFromUsb() {
        val settings = parseWifiConnectionQr(
            """{"type":"pocketdeck.connection","version":2,"server_id":"6b7bb8da-a30a-45bd-9b89-4a42a191a7c4","wifi_addresses":["127.0.0.1","192.168.1.12","::1"],"port":8443,"certificate_sha256":"${"AA".repeat(32)}","certificate_expires_at":1800000000}""",
            nowEpochSeconds = 1_700_000_000,
        )

        assertEquals("192.168.1.12", settings.host)
        assertEquals("192.168.1.12", settingsForTransport(settings, ConnectionTransport.WIFI).host)
        assertEquals("127.0.0.1", settingsForTransport(settings, ConnectionTransport.USB).host)
        assertEquals("aa".repeat(32), settings.certificateFingerprint)
    }

    @Test
    fun journeyAppsBarcodeDecoderReadsVersionedCompanionQrBarcode() {
        val windowsQrPayload =
            """{"type":"pocketdeck.connection","version":2,"server_id":"6b7bb8da-a30a-45bd-9b89-4a42a191a7c4","wifi_addresses":["192.168.1.12"],"port":8443,"certificate_sha256":"${"AA".repeat(32)}","certificate_expires_at":1800000000}"""
        val matrix = QRCodeWriter().encode(
            windowsQrPayload,
            BarcodeFormat.QR_CODE,
            384,
            384,
        )
        val pixels = IntArray(matrix.width * matrix.height)
        for (y in 0 until matrix.height) {
            for (x in 0 until matrix.width) {
                pixels[y * matrix.width + x] =
                    if (matrix[x, y]) 0xFF000000.toInt() else 0xFFFFFFFF.toInt()
            }
        }
        val decoded = MultiFormatReader().decode(
            BinaryBitmap(HybridBinarizer(RGBLuminanceSource(matrix.width, matrix.height, pixels))),
        )

        assertEquals(windowsQrPayload, decoded.text)
        assertEquals(
            "192.168.1.12",
            parseWifiConnectionQr(decoded.text, nowEpochSeconds = 1_700_000_000).host,
        )
    }

    @Test
    fun supportsTrustOnlyWindowsQrWithoutInventingAWifiEndpoint() {
        val settings = parseWifiConnectionQr(
            """{"type":"pocketdeck.connection","version":2,"server_id":"6b7bb8da-a30a-45bd-9b89-4a42a191a7c4","wifi_addresses":[],"port":8443,"certificate_sha256":"${"AA".repeat(32)}","certificate_expires_at":1800000000}""",
            nowEpochSeconds = 1_700_000_000,
        )

        assertEquals("", settingsForTransport(settings, ConnectionTransport.WIFI).host)
        assertEquals("127.0.0.1", settingsForTransport(settings, ConnectionTransport.USB).host)
    }

    @Test
    fun wifiEndpointSelectionAcceptsOnlyValidLanIpv4Addresses() {
        val settings = parseWifiConnectionQr(
            """{"type":"pocketdeck.connection","version":2,"server_id":"6b7bb8da-a30a-45bd-9b89-4a42a191a7c4","wifi_addresses":["::1","not-an-address","999.1.2.3","192.168.1.12"],"port":8443,"certificate_sha256":"${"AA".repeat(32)}","certificate_expires_at":1800000000}""",
            nowEpochSeconds = 1_700_000_000,
        )

        assertEquals("192.168.1.12", settings.host)
    }

    @Test
    fun rejectsExpiredOrUnsupportedWindowsQrPayloads() {
        val expiredQr =
            """{"type":"pocketdeck.connection","version":2,"server_id":"6b7bb8da-a30a-45bd-9b89-4a42a191a7c4","wifi_addresses":["192.168.1.12"],"port":8443,"certificate_sha256":"${"AA".repeat(32)}","certificate_expires_at":1700000000}"""
        assertThrows(IllegalArgumentException::class.java) {
            parseWifiConnectionQr(expiredQr, nowEpochSeconds = 1_700_000_001)
        }
        assertThrows(IllegalArgumentException::class.java) {
            parseWifiConnectionQr(expiredQr.replace("\"version\":2", "\"version\":3"))
        }
    }

    @Test
    fun wifiUsesScannedLanAddressWhileUsbUsesLoopbackWithoutChangingWifiSettings() {
        val settings = WifiConnectionSettings(
            host = "192.168.1.7",
            port = 8443,
            certificateFingerprint = "a1".repeat(32),
            serverId = "6b7bb8da-a30a-45bd-9b89-4a42a191a7c4",
        )

        assertEquals("192.168.1.7", settingsForTransport(settings, ConnectionTransport.WIFI).host)
        assertEquals("127.0.0.1", settingsForTransport(settings, ConnectionTransport.USB).host)
        assertEquals("192.168.1.7", settings.host)
    }

    @Test
    fun wifiRejectsAStaleUsbLoopbackEndpointWhileUsbMayUseIt() {
        assertThrows(IllegalArgumentException::class.java) {
            validateTransportEndpoint("127.0.0.1", ConnectionTransport.WIFI)
        }
        validateTransportEndpoint("127.0.0.1", ConnectionTransport.USB)
        validateTransportEndpoint("192.168.1.7", ConnectionTransport.WIFI)
    }

    @Test
    fun certificateTrustIsReusedOnlyForTheSameWindowsIdentityAndPin() {
        val trusted = WifiConnectionSettings(
            host = "192.168.1.7",
            port = 8443,
            certificateFingerprint = "a1".repeat(32),
            serverId = "6b7bb8da-a30a-45bd-9b89-4a42a191a7c4",
        )

        assertTrue(hasSameCertificateTrust(trusted, trusted.copy(host = "192.168.1.8")))
        assertTrue(!hasSameCertificateTrust(
            trusted,
            trusted.copy(certificateFingerprint = "b2".repeat(32)),
        ))
        assertTrue(!hasSameCertificateTrust(
            trusted,
            trusted.copy(serverId = "8b7bb8da-a30a-45bd-9b89-4a42a191a7c4"),
        ))
    }

    @Test
    fun usbDoesNotRequireWifiPinAndSavedCredentialsSkipPairingPin() {
        assertTrue(!pairingPinRequired(ConnectionTransport.USB, hasSavedCredential = false))
        assertTrue(!pairingPinRequired(ConnectionTransport.USB, hasSavedCredential = true))
        assertTrue(pairingPinRequired(ConnectionTransport.WIFI, hasSavedCredential = false))
        assertTrue(!pairingPinRequired(ConnectionTransport.WIFI, hasSavedCredential = true))
    }

    @Test
    fun transportReachabilityErrorsIncludeSpecificRecoveryGuidance() {
        val timeout = SocketTimeoutException("connect timed out")

        assertTrue(
            connectionFailureMessage(timeout, ConnectionTransport.WIFI)
                .contains("Private networks only"),
        )
        val usbMessage = connectionFailureMessage(timeout, ConnectionTransport.USB)
        assertTrue(usbMessage.contains("ADB reverse tunnel"))
        assertTrue(usbMessage.contains("connect timed out"))
    }

    @Test
    fun scannedQrRejectsInvalidCertificateFingerprint() {
        assertThrows(IllegalArgumentException::class.java) {
            parseWifiConnectionQr(
                """{"type":"pocketdeck.connection","version":1,"server_id":"6b7bb8da-a30a-45bd-9b89-4a42a191a7c4","addresses":["192.168.1.7"],"port":18443,"certificate_sha256":"not-a-fingerprint"}""",
            )
        }
    }

    @Test
    fun certificatePinComparisonRejectsMismatchedOrMalformedFingerprints() {
        val expected = "a1".repeat(32)

        assertTrue(certificateFingerprintMatches(expected, "A1:".repeat(31) + "A1"))
        assertTrue(!certificateFingerprintMatches(expected, "b2".repeat(32)))
        assertTrue(!certificateFingerprintMatches(expected, "not-a-fingerprint"))
    }

    @Test
    fun reconnectBackoffIsBoundedAndGrowsExponentially() {
        assertEquals(500L, reconnectDelayMillis(1, 0.0))
        assertEquals(1_250L, reconnectDelayMillis(2, 1.0))
        assertEquals(10_000L, reconnectDelayMillis(20, 1.0))
    }

    @Test
    fun authenticatedForbiddenHandshakeRequiresFreshPairing() {
        val failure = deviceCredentialHandshakeRejection(
            responseCode = 403,
            hasSavedCredential = true,
        )

        assertNotNull(failure)
        assertTrue(failure is DeviceAuthorizationRejectedException)
        assertTrue(failure?.message.orEmpty().contains("fresh pairing code"))
    }

    @Test
    fun otherHandshakeFailuresDoNotInvalidateSavedCredential() {
        assertNull(
            deviceCredentialHandshakeRejection(
                responseCode = 403,
                hasSavedCredential = false,
            ),
        )
        assertNull(
            deviceCredentialHandshakeRejection(
                responseCode = 401,
                hasSavedCredential = true,
            ),
        )
    }

}
