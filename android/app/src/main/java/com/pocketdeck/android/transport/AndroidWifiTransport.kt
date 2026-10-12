package com.pocketdeck.android.transport

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import android.os.SystemClock
import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.pocketdeck.android.config.ActionModel
import com.pocketdeck.android.config.ButtonModel
import com.pocketdeck.android.storage.LocalDeckRepository
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.UUID
import java.util.concurrent.ThreadLocalRandom
import java.util.concurrent.TimeUnit
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import java.net.ConnectException
import java.net.InetSocketAddress
import java.net.NoRouteToHostException
import java.net.Socket
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

internal val protocolGson = GsonBuilder().serializeNulls().create()

data class WifiConnectionSettings(
    val host: String = "",
    val port: Int = 8443,
    val certificateFingerprint: String = "",
    val serverId: String = "",
)

enum class ConnectionTransport {
    WIFI,
    USB,
}

internal fun settingsForTransport(
    settings: WifiConnectionSettings,
    transport: ConnectionTransport,
): WifiConnectionSettings =
    if (transport == ConnectionTransport.USB) {
        settings.copy(host = "127.0.0.1")
    } else {
        settings
    }

internal fun isLoopbackHost(host: String): Boolean {
    val normalized = host.removePrefix("[").removeSuffix("]").lowercase()
    return normalized == "localhost" ||
        normalized == "::1" ||
        normalized.startsWith("127.")
}

private fun isIpv4Address(host: String): Boolean {
    val parts = host.split('.')
    return parts.size == 4 && parts.all { part ->
        part.isNotEmpty() &&
            part.all(Char::isDigit) &&
            part.toIntOrNull()?.let { it in 0..255 } == true
    }
}

internal fun validateTransportEndpoint(host: String, transport: ConnectionTransport) {
    val normalized = host.trim().removePrefix("[").removeSuffix("]")
    require(normalized.isNotBlank() &&
        normalized.none { it.isWhitespace() || it == '/' || it == '\\' || it == '@' }
    ) {
        "Scan the Windows QR again while the companion is connected to a private Wi-Fi network."
    }
    require(transport == ConnectionTransport.USB || !isLoopbackHost(normalized)) {
        "The saved Windows address is a USB loopback endpoint, not a Wi-Fi address. Scan the Windows QR code again while Windows is connected to a private Wi-Fi network."
    }
}

internal fun connectionFailureMessage(
    failure: Throwable,
    transport: ConnectionTransport,
): String {
    val message = failure.message?.takeIf { it.isNotBlank() }
        ?: "The Windows connection failed."
    val cannotReachHost = generateSequence(failure) { it.cause }.any {
        it is ConnectException ||
            it is NoRouteToHostException ||
            it is SocketException ||
            it is SocketTimeoutException ||
            it is UnknownHostException
    }
    return if (transport == ConnectionTransport.WIFI && cannotReachHost) {
        "$message Check that both devices are on the same private network and allow " +
            "pocketdeck-backend.exe through Windows Defender Firewall on Private " +
            "networks only; do not allow Public networks."
    } else if (transport == ConnectionTransport.USB && cannotReachHost) {
        "The ADB reverse tunnel is not ready. Keep PocketDeck running on Windows, " +
            "connect the phone with USB debugging authorized, and retry. Details: $message"
    } else {
        message
    }
}

internal fun parseWifiConnectionQr(
    contents: String,
    nowEpochSeconds: Long = System.currentTimeMillis() / 1_000L,
): WifiConnectionSettings {
    val root = try {
        JsonParser.parseString(contents)
    } catch (failure: RuntimeException) {
        throw IllegalArgumentException("This QR code does not contain valid PocketDeck data.", failure)
    }
    require(root.isJsonObject) { "This QR code does not contain PocketDeck connection data." }
    val qr = root.asJsonObject
    require(qr.get("type")?.asString == "pocketdeck.connection") {
        "This QR code is not a PocketDeck connection code."
    }
    val version = qr.get("version")?.asInt
        ?: error("The PocketDeck QR code has no supported format version.")
    require(version == 1 || version == 2) {
        "This PocketDeck QR code uses an unsupported format. Update PocketDeck on Windows and scan again."
    }
    val addresses = if (version == 1) {
        qr.getAsJsonArray("addresses")
            ?: error("The Windows QR code has no host addresses.")
    } else {
        qr.getAsJsonArray("wifi_addresses")
            ?: error("The Windows QR code has no Wi-Fi endpoint list.")
    }
    val wifiHosts = addresses.map {
        require(it.isJsonPrimitive && it.asJsonPrimitive.isString) {
            "The Windows QR code contains an invalid Wi-Fi address."
        }
        it.asString.trim().also { host ->
            require(host.isNotBlank() &&
                host.none { character ->
                    character.isWhitespace() || character in "/\\@?#"
                }
            ) { "The Windows QR code contains an invalid Wi-Fi address." }
        }
    }
    val host = wifiHosts.firstOrNull { isIpv4Address(it) && !isLoopbackHost(it) }.orEmpty()
    val port = qr.get("port")?.asInt
        ?: error("The Windows QR code has no valid port.")
    require(port in 1..65535) { "The Windows QR code has no valid port." }
    val fingerprint = qr.get("certificate_sha256")?.asString.orEmpty()
        .replace(":", "")
        .replace(" ", "")
        .lowercase()
    require(fingerprint.matches(Regex("(?i)[0-9a-f]{64}"))) {
        "The Windows QR code has no valid TLS certificate fingerprint."
    }
    val serverId = qr.get("server_id")?.asString.orEmpty()
    try {
        UUID.fromString(serverId)
    } catch (failure: IllegalArgumentException) {
        throw IllegalArgumentException("The Windows QR code has an invalid companion identity.", failure)
    }
    if (version == 2) {
        val expiresAt = qr.get("certificate_expires_at")?.asLong
            ?: error("The Windows QR code is missing its certificate expiry.")
        require(expiresAt > nowEpochSeconds) {
            "The Windows QR code contains an expired TLS certificate. Restart PocketDeck on Windows and scan its current QR code."
        }
    }
    return WifiConnectionSettings(
        host = host,
        port = port,
        certificateFingerprint = fingerprint,
        serverId = serverId,
    )
}

internal fun reconnectDelayMillis(failures: Int, jitterFraction: Double): Long {
    require(failures > 0)
    require(jitterFraction in 0.0..1.0)
    val exponent = (failures - 1).coerceAtMost(4)
    val base = 500L * (1L shl exponent)
    return base + (base * 0.25 * jitterFraction).toLong()
}

internal fun nextReconnectDelayMillis(failures: Int): Long =
    reconnectDelayMillis(failures, ThreadLocalRandom.current().nextDouble())

internal fun isValidPairingPin(value: String): Boolean =
    value.matches(Regex("[0-9]{6}"))

internal fun pairingPinRequired(
    transport: ConnectionTransport,
    hasSavedCredential: Boolean,
): Boolean = transport == ConnectionTransport.WIFI && !hasSavedCredential

internal fun hasSameCertificateTrust(
    existing: WifiConnectionSettings,
    candidate: WifiConnectionSettings,
): Boolean =
    existing.serverId.isNotBlank() &&
        existing.serverId == candidate.serverId &&
        existing.certificateFingerprint.isNotBlank() &&
        existing.certificateFingerprint == candidate.certificateFingerprint

internal fun configurationSyncPayload(
    lastAccepted: Pair<String, Long>?,
): JsonObject = JsonObject().apply {
    val revision = lastAccepted?.let { (epoch, value) ->
        JsonObject().apply {
            addProperty("config_epoch", epoch)
            addProperty("revision", value)
        }
    }
    add("last_accepted", revision ?: JsonNull.INSTANCE)
    addProperty("force_snapshot", lastAccepted == null)
}

class WifiConnectionPreferences(context: Context) {
    private val preferences = context.getSharedPreferences("wifi_connection", Context.MODE_PRIVATE)
    private val trustCipher = AndroidKeystoreCipher("pocketdeck.tls-certificate-trust")

    fun load(): WifiConnectionSettings = WifiConnectionSettings(
        host = preferences.getString("host", "").orEmpty(),
        port = preferences.getInt("port", 8443),
        certificateFingerprint = loadCertificateFingerprint(),
        serverId = preferences.getString("server_id", "").orEmpty(),
    )

    fun save(settings: WifiConnectionSettings) {
        val fingerprint = normalizeCertificateFingerprint(settings.certificateFingerprint)
        require(fingerprint.isBlank() || fingerprint.matches(Regex("[0-9a-f]{64}"))) {
            "The Windows TLS certificate trust is invalid. Scan or upload the current Windows QR code again."
        }
        val editor = preferences.edit()
            .putString("host", settings.host)
            .putInt("port", settings.port)
            .putString("server_id", settings.serverId)
            .remove("fingerprint")
        if (fingerprint.isBlank()) {
            editor.remove("trusted_certificate")
        } else {
            editor.putString("trusted_certificate", trustCipher.encrypt(fingerprint))
        }
        check(editor.commit()) { "Wi-Fi connection settings could not be saved." }
    }

    fun lastAccepted(): Pair<String, Long>? {
        val epoch = preferences.getString("config_epoch", null) ?: return null
        val revision = preferences.getLong("config_revision", -1L)
        if (revision < 0) return null
        return epoch to revision
    }

    fun saveAccepted(epoch: String, revision: Long) {
        check(preferences.edit()
            .putString("config_epoch", epoch)
            .putLong("config_revision", revision)
            .commit()) { "The synchronized configuration revision could not be saved." }
    }

    private fun loadCertificateFingerprint(): String {
        preferences.getString("trusted_certificate", null)?.let { encoded ->
            return normalizeCertificateFingerprint(trustCipher.decrypt(encoded))
        }
        val legacy = preferences.getString("fingerprint", null) ?: return ""
        val fingerprint = normalizeCertificateFingerprint(legacy)
        if (!fingerprint.matches(Regex("[0-9a-f]{64}"))) {
            check(preferences.edit().remove("fingerprint").commit()) {
                "Invalid legacy certificate trust could not be removed."
            }
            return ""
        }
        check(
            preferences.edit()
                .putString("trusted_certificate", trustCipher.encrypt(fingerprint))
                .remove("fingerprint")
                .commit(),
        ) { "Windows TLS certificate trust could not be secured." }
        return fingerprint
    }
}

class AndroidDeviceCredentialStore(context: Context) {
    private val preferences = context.getSharedPreferences("paired_device", Context.MODE_PRIVATE)
    private val cipher = AndroidKeystoreCipher("pocketdeck.device-credential")

    fun clear() {
        check(preferences.edit().remove("credential").commit()) {
            "The rejected Windows device credential could not be removed."
        }
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (keyStore.containsAlias("pocketdeck.device-credential")) {
            keyStore.deleteEntry("pocketdeck.device-credential")
        }
    }

    fun read(): Pair<String, String>? {
        val encoded = preferences.getString("credential", null) ?: return null
        val decoded = cipher.decrypt(encoded)
        val separator = decoded.indexOf('\n')
        if (separator <= 0 || separator == decoded.lastIndex) {
            throw IllegalStateException("The saved device credential is malformed.")
        }
        return decoded.substring(0, separator) to decoded.substring(separator + 1)
    }

    fun save(deviceId: String, credential: String) {
        require(deviceId.isNotBlank() && credential.length >= 32) {
            "The paired device credential is invalid."
        }
        check(preferences.edit()
            .putString("credential", cipher.encrypt("$deviceId\n$credential"))
            .commit()) { "The paired device credential could not be stored." }
    }
}

private class AndroidKeystoreCipher(private val keyAlias: String) {
    fun encrypt(value: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, encryptionKey())
        val sealed = cipher.iv + cipher.doFinal(value.toByteArray(StandardCharsets.UTF_8))
        return Base64.encodeToString(sealed, Base64.NO_WRAP)
    }

    fun decrypt(encoded: String): String {
        val sealed = try {
            Base64.decode(encoded, Base64.NO_WRAP)
        } catch (error: IllegalArgumentException) {
            throw IllegalStateException("Protected PocketDeck data is malformed.", error)
        }
        if (sealed.size <= GCM_NONCE_BYTES) {
            throw IllegalStateException("Protected PocketDeck data is incomplete.")
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            encryptionKey(),
            GCMParameterSpec(GCM_TAG_BITS, sealed.copyOfRange(0, GCM_NONCE_BYTES)),
        )
        return String(
            cipher.doFinal(sealed.copyOfRange(GCM_NONCE_BYTES, sealed.size)),
            StandardCharsets.UTF_8,
        )
    }

    private fun encryptionKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(keyAlias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            "AndroidKeyStore",
        )
        generator.init(
            KeyGenParameterSpec.Builder(
                keyAlias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val GCM_NONCE_BYTES = 12
        const val GCM_TAG_BITS = 128
    }
}

private fun normalizeCertificateFingerprint(fingerprint: String): String =
    fingerprint.replace(":", "").replace(" ", "").lowercase()

class AndroidWifiTransport(
    context: Context,
    private val repository: LocalDeckRepository,
    private val preferences: WifiConnectionPreferences,
    private val credentials: AndroidDeviceCredentialStore,
) {
    private val applicationContext = context.applicationContext
    private val gson = Gson()
    @Volatile private var activeSocket: WebSocket? = null
    @Volatile private var synchronizedEpoch: String? = null
    @Volatile private var synchronizedRevision: Long? = null
    private val actionResults = ConcurrentHashMap<String, CompletableDeferred<Envelope>>()

    suspend fun executeAction(button: ButtonModel, action: ActionModel): String {
        val socket = activeSocket ?: error("Windows offline. Connect before running this action.")
        val epoch = synchronizedEpoch ?: error("Windows configuration has not synchronized yet.")
        val revision = synchronizedRevision ?: error("Windows configuration has not synchronized yet.")
        val stored = withContext(kotlinx.coroutines.Dispatchers.IO) {
            repository.restore()
        } ?: error("No synchronized Windows configuration is cached.")
        val canonicalAction = stored.configuration.document
            .getAsJsonArray("actions")
            .firstOrNull { it.isJsonObject && it.asJsonObject.get("id")?.asString == action.id }
            ?.asJsonObject
            ?: error("The assigned action is not available in the synchronized configuration.")
        require(canonicalAction.get("target")?.asString == "windows_host") {
            "This action is not hosted by Windows."
        }
        require(canonicalAction.get("enabled")?.asBoolean != false) {
            "This action is disabled in the Windows configuration."
        }
        val messageId = UUID.randomUUID().toString()
        val response = CompletableDeferred<Envelope>()
        actionResults[messageId] = response
        try {
            send(
                socket,
                messageId,
                "action.execute",
                jsonObject(
                    "button_id" to button.id,
                    "config_epoch" to epoch,
                    "config_revision" to revision,
                    "action" to canonicalAction,
                ),
            )
            val result = withTimeout(ACTION_TIMEOUT_MS) { response.await() }
            val outcome = result.payload.get("outcome")?.asString
                ?: error("Windows returned an invalid action result.")
            val message = result.payload.get("message")?.asString.orEmpty()
            if (outcome != "succeeded") {
                val code = result.payload.get("code")?.asString ?: "action_failed"
                error("$code: ${message.ifBlank { "Windows could not run this action." }}")
            }
            return message
        } finally {
            actionResults.remove(messageId)
        }
    }

    suspend fun connect(
        settings: WifiConnectionSettings,
        pairingCode: String?,
        transport: ConnectionTransport = ConnectionTransport.WIFI,
        deviceName: String,
        onStatus: (String) -> Unit,
        onPaired: () -> Unit,
        onSnapshot: suspend () -> Unit,
    ) {
        validateSettings(settings, transport)
        if (transport == ConnectionTransport.USB) {
            awaitUsbTunnelReady(settings.port, onStatus)
        }
        var savedCredential = credentials.read()
        if (savedCredential == null) {
            val code = pairingCode?.trim().orEmpty()
            require(!pairingPinRequired(transport, hasSavedCredential = false) ||
                isValidPairingPin(code)
            ) {
                "Enter the active six-digit Windows Wi-Fi pairing PIN before connecting."
            }
            savedCredential = pair(settings, code, transport, deviceName, onStatus)
            onPaired()
        }
        try {
            runAuthenticatedSession(
                settings,
                savedCredential,
                transport,
                onStatus,
                onSnapshot,
            )
        } catch (rejected: DeviceAuthorizationRejectedException) {
            credentials.clear()
            throw rejected
        }
    }

    private suspend fun pair(
        settings: WifiConnectionSettings,
        pairingCode: String,
        transport: ConnectionTransport,
        deviceName: String,
        onStatus: (String) -> Unit,
    ): Pair<String, String> {
        val attemptId = UUID.randomUUID().toString()
        Log.i(TAG, "Pairing attempt started id=$attemptId codeLength=${pairingCode.length}.")
        onStatus(if (transport == ConnectionTransport.USB) {
            "Establishing USB tunnel"
        } else {
            "Connecting securely"
        })
        val tlsStartedAt = SystemClock.elapsedRealtime()
        val (socket, messages, client) = open(settings, null)
        try {
            awaitOpen(messages)
            Log.i(
                TAG,
                "TLS handshake and pairing WebSocket ready attempt_id=$attemptId " +
                    "elapsed_ms=${SystemClock.elapsedRealtime() - tlsStartedAt}.",
            )
            onStatus("Connecting securely")
            val claimId = UUID.randomUUID().toString()
            send(
                socket,
                claimId,
                "pairing.claim",
                jsonObject(
                    "pairing_code" to pairingCode,
                    "transport" to transport.name.lowercase(),
                    "device_name" to deviceName.trim().take(48),
                    "client_type" to "android",
                    "supported_protocol_versions" to listOf(2),
                    "supported_configuration_versions" to listOf(2),
                ),
            )
            Log.i(TAG, "Pairing claim queued attempt_id=$attemptId message_id=$claimId.")
            val pending = withTimeout(SESSION_SETUP_TIMEOUT_MS) {
                expectType(messages, "pairing.pending")
            }
            val requestId = pending.payload.get("request_id")?.asString
                ?: error("Windows returned a malformed pairing request.")
            val deviceId = pending.payload.get("device_id")?.asString
                ?: error("Windows returned a malformed paired-device identity.")
            onStatus("Waiting for Windows approval")
            Log.i(TAG, "Pairing request pending attempt_id=$attemptId request_id=$requestId.")
            while (currentCoroutineContext().isActive) {
                val message = withTimeoutOrNull(PAIRING_POLL_INTERVAL_MS) {
                    receive(messages)
                }
                if (message == null) {
                    val statusId = UUID.randomUUID().toString()
                    send(
                        socket,
                        statusId,
                        "pairing.status",
                        jsonObject("request_id" to requestId),
                        inReplyTo = statusId,
                    )
                    continue
                }
                if (message.type == "protocol.error") throw protocolFailure(message)
                if (message.type == "pairing.status.result") {
                    val status = message.payload.get("status")?.asString
                    if (status == "rejected" || status == "expired") {
                        error("Windows pairing was $status. Create a new pairing code.")
                    }
                }
                if (message.type != "pairing.approved") continue
                if (message.payload.get("request_id")?.asString != requestId ||
                    message.payload.get("device_id")?.asString != deviceId
                ) {
                    error("Windows returned a pairing approval for a different device.")
                }
                val credential = message.payload.get("credential")?.asString
                    ?: error("Windows approval did not include a device credential.")
                credentials.save(deviceId, credential)
                Log.i(TAG, "Pairing approved and credential stored attempt_id=$attemptId.")
                return deviceId to credential
            }
            error("Pairing was cancelled.")
        } finally {
            socket.close(1000, "Pairing complete")
            client.dispatcher.executorService.shutdown()
        }
    }

    private suspend fun awaitUsbTunnelReady(port: Int, onStatus: (String) -> Unit) {
        onStatus("Establishing USB tunnel")
        val startedAt = SystemClock.elapsedRealtime()
        var lastFailure: Exception? = null
        while (SystemClock.elapsedRealtime() - startedAt < USB_TUNNEL_READY_TIMEOUT_MS) {
            try {
                withContext(kotlinx.coroutines.Dispatchers.IO) {
                    Socket().use { socket ->
                        socket.connect(
                            InetSocketAddress("127.0.0.1", port),
                            USB_TUNNEL_PROBE_TIMEOUT_MS,
                        )
                    }
                }
                Log.i(
                    TAG,
                    "USB reverse endpoint is reachable on 127.0.0.1:$port " +
                        "elapsed_ms=${SystemClock.elapsedRealtime() - startedAt}.",
                )
                return
            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                lastFailure = failure
                delay(USB_TUNNEL_RETRY_INTERVAL_MS)
            }
        }
        Log.w(
            TAG,
            "USB reverse endpoint did not become reachable on 127.0.0.1:$port " +
                "elapsed_ms=${SystemClock.elapsedRealtime() - startedAt}; " +
                "cause=${lastFailure?.javaClass?.simpleName}.",
        )
        throw ConnectException(
            "Windows has not established ADB reverse tcp:$port tcp:$port. " +
                "Check that PocketDeck is running and USB debugging is authorized.",
        ).apply {
            lastFailure?.let(::initCause)
        }
    }

    private suspend fun runAuthenticatedSession(
        settings: WifiConnectionSettings,
        identity: Pair<String, String>,
        transport: ConnectionTransport,
        onStatus: (String) -> Unit,
        onSnapshot: suspend () -> Unit,
    ) {
        val (deviceId, credential) = identity
        onStatus(if (transport == ConnectionTransport.USB) {
            "Establishing USB tunnel"
        } else {
            "Connecting securely"
        })
        val tlsStartedAt = SystemClock.elapsedRealtime()
        val (socket, messages, client) = open(settings, credential)
        try {
            withTimeout(SESSION_SETUP_TIMEOUT_MS) {
                awaitOpen(messages)
                Log.i(
                    TAG,
                    "TLS handshake completed transport=${transport.name.lowercase()} " +
                        "elapsed_ms=${SystemClock.elapsedRealtime() - tlsStartedAt}.",
                )
                onStatus("Authenticating")
                val authenticationStartedAt = SystemClock.elapsedRealtime()
                val helloId = UUID.randomUUID().toString()
                send(
                    socket,
                    helloId,
                    "client.hello",
                    jsonObject(
                        "device_id" to deviceId,
                        "supported_protocol_versions" to listOf(2),
                        "supported_configuration_versions" to listOf(2),
                    ),
                )
                val welcome = expectType(messages, "server.welcome")
                Log.i(
                    TAG,
                    "Device authentication completed elapsed_ms=" +
                        "${SystemClock.elapsedRealtime() - authenticationStartedAt}.",
                )
                if (welcome.inReplyTo != helloId ||
                    welcome.payload.get("selected_protocol_version")?.asInt != 2 ||
                    welcome.payload.get("selected_configuration_version")?.asInt != 2
                ) {
                    error("Windows selected an unsupported PocketDeck protocol.")
                }
                val expectedServerId = settings.serverId
                if (expectedServerId.isNotBlank() &&
                    welcome.payload.get("server_id")?.asString != expectedServerId
                ) {
                    error("The connected Windows companion does not match the scanned QR code.")
                }
                val head = welcome.payload.getAsJsonObject("head")
                    ?: error("Windows returned an invalid configuration revision.")
                val known = preferences.lastAccepted()
                val syncId = UUID.randomUUID().toString()
                val snapshotStartedAt = SystemClock.elapsedRealtime()
                send(
                    socket,
                    syncId,
                    "config.sync",
                    configurationSyncPayload(known),
                )
                onStatus("Loading Windows configuration")
                val firstSnapshot = expectType(messages, "config.snapshot")
                if (firstSnapshot.inReplyTo != syncId) {
                    error("Windows returned a configuration snapshot for another request.")
                }
                acceptSnapshot(firstSnapshot, head, onSnapshot)
                Log.i(
                    TAG,
                    "Initial configuration snapshot delivered elapsed_ms=" +
                        "${SystemClock.elapsedRealtime() - snapshotStartedAt} " +
                        "revision=${firstSnapshot.payload.get("revision")?.asLong}.",
                )
            }
            onStatus("Connected")

            while (currentCoroutineContext().isActive) {
                val message = withTimeoutOrNull(PING_INTERVAL_MS) {
                    receive(messages)
                }
                if (message == null) {
                    val pingId = UUID.randomUUID().toString()
                    send(socket, pingId, "client.ping", JsonObject())
                    continue
                }
                if (message.type == "protocol.error") throw protocolFailure(message)
                if (message.type == "configuration.upload") {
                    val outcome = try {
                        require(message.inReplyTo == null &&
                            message.payload.keySet() ==
                            setOf("config_epoch", "revision", "configuration")
                        ) { "Windows sent an invalid configuration upload." }
                        acceptSnapshot(message, null, onSnapshot)
                        "succeeded" to "Configuration saved on this Android device."
                    } catch (cancelled: kotlinx.coroutines.CancellationException) {
                        throw cancelled
                    } catch (failure: Exception) {
                        "failed" to (failure.message
                            ?: "Android could not save the configuration.")
                    }
                    val resultId = UUID.randomUUID().toString()
                    send(
                        socket,
                        resultId,
                        "configuration.upload.result",
                        jsonObject(
                            "outcome" to outcome.first,
                            "message" to outcome.second.take(512),
                        ),
                        inReplyTo = message.messageId,
                    )
                    continue
                }
                if (message.type == "action.result") {
                    val replyId = message.inReplyTo
                    if (replyId != null) actionResults[replyId]?.complete(message)
                } else
                if (message.type == "config.snapshot") {
                    acceptSnapshot(message, null, onSnapshot)
                } else if (message.type != "server.pong") {
                    error("Windows sent an unsupported message: ${message.type}.")
                }
            }
        } finally {
            socket.close(1001, "Client session ended")
            client.dispatcher.executorService.shutdown()
            if (activeSocket === socket) {
                activeSocket = null
                synchronizedEpoch = null
                synchronizedRevision = null
            }
            actionResults.values.forEach {
                it.completeExceptionally(IllegalStateException("Windows connection was lost."))
            }
            actionResults.clear()
        }
    }

    private suspend fun acceptSnapshot(
        message: Envelope,
        welcomeHead: JsonObject?,
        onSnapshot: suspend () -> Unit,
    ) {
        val epoch = message.payload.get("config_epoch")?.asString
            ?: error("Windows configuration snapshot has no epoch.")
        val revision = message.payload.get("revision")?.asLong
            ?: error("Windows configuration snapshot has no revision.")
        require(revision >= 0) { "Windows configuration revision cannot be negative." }
        val configuration = message.payload.getAsJsonObject("configuration")
            ?: error("Windows configuration snapshot is malformed.")
        if (welcomeHead != null) {
            if (welcomeHead.get("config_epoch")?.asString != epoch) {
                error("Windows changed configuration epoch during synchronization.")
            }
            val headRevision = welcomeHead.get("revision")?.asLong
                ?: error("Windows configuration head is malformed.")
            if (revision < headRevision) {
                error("Windows sent a configuration snapshot older than its advertised revision.")
            }
        }
        val previous = preferences.lastAccepted()
        if (previous?.first == epoch && revision < previous.second) {
            error("Windows returned an older configuration revision. The local cache was kept.")
        }
        if (previous?.first != epoch || previous.second != revision) {
            withContext(kotlinx.coroutines.Dispatchers.IO) {
                repository.importConfiguration(configuration.toString())
                preferences.saveAccepted(epoch, revision)
            }
            onSnapshot()
        }
        synchronizedEpoch = epoch
        synchronizedRevision = revision
    }

    private fun open(
        settings: WifiConnectionSettings,
        credential: String?,
    ): Triple<WebSocket, Channel<Incoming>, OkHttpClient> {
        val channel = Channel<Incoming>(Channel.UNLIMITED)
        val trustManager = PinnedCertificateTrustManager(settings.certificateFingerprint)
        val sslContext = SSLContext.getInstance("TLS").apply {
            init(null, arrayOf(trustManager), SecureRandom())
        }
        val verifier = HostnameVerifier { _, session ->
            val certificate = session.peerCertificates.firstOrNull() as? X509Certificate
            certificate != null && trustManager.matches(certificate)
        }
        val client = OkHttpClient.Builder()
            .sslSocketFactory(sslContext.socketFactory, trustManager)
            .hostnameVerifier(verifier)
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build()
        val host = settings.host.removePrefix("[").removeSuffix("]")
        val urlHost = if (host.contains(':')) "[$host]" else host
        val request = Request.Builder()
            .url("wss://$urlHost:${settings.port}/ws/v2")
            .header("Sec-WebSocket-Protocol", "pocketdeck.v2")
            .apply {
                credential?.let { header("Authorization", "Bearer $it") }
            }
            .build()
        val socket = client.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    Log.i(
                        TAG,
                        "WebSocket opened response=${response.code} subprotocol=${response.header("Sec-WebSocket-Protocol")}.",
                    )
                    channel.trySend(Incoming.Opened)
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    val parsed = runCatching { parseEnvelope(text) }
                    parsed.onSuccess {
                        Log.i(TAG, "WebSocket message received type=${it.type} message_id=${it.messageId}.")
                        channel.trySend(Incoming.Message(it))
                    }.onFailure {
                        Log.e(
                            TAG,
                            "WebSocket message parsing failed type=${it.javaClass.simpleName}: ${it.message}",
                        )
                        channel.trySend(Incoming.Closed(it))
                    }
                }

                override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                    channel.trySend(Incoming.Closed(IllegalStateException(
                        "Windows sent a non-text protocol message.",
                    )))
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    Log.i(TAG, "WebSocket closed code=$code reason=${reason.take(120)}.")
                    channel.trySend(Incoming.Closed(IllegalStateException(
                        "Windows closed the connection ($code): $reason",
                    )))
                }

                override fun onFailure(
                    webSocket: WebSocket,
                    t: Throwable,
                    response: Response?,
                ) {
                    val credentialRejection = deviceCredentialHandshakeRejection(
                        response?.code,
                        credential != null,
                    )
                    Log.e(
                        TAG,
                        "WebSocket failed type=${t.javaClass.simpleName}: ${t.message}; " +
                            "httpCode=${response?.code} authenticated=${credential != null} " +
                            "credentialRejected=${credentialRejection != null}",
                    )
                    channel.trySend(Incoming.Closed(credentialRejection ?: t))
                }
            },
        )
        if (credential != null) activeSocket = socket
        return Triple(socket, channel, client)
    }

    private suspend fun awaitOpen(messages: Channel<Incoming>) {
        withTimeout(CONNECT_TIMEOUT_MS) {
            when (val incoming = messages.receive()) {
                Incoming.Opened -> Unit
                is Incoming.Closed -> {
                    if (incoming.cause is DeviceAuthorizationRejectedException) {
                        throw incoming.cause
                    }
                    throw IllegalStateException(
                        "Could not establish the pinned Windows connection: ${incoming.cause.message}",
                        incoming.cause,
                    )
                }
                is Incoming.Message -> error("Windows sent a message before the connection opened.")
            }
        }
    }

    private suspend fun expectType(messages: Channel<Incoming>, expected: String): Envelope {
        while (true) {
            val message = receive(messages)
            if (message.type == "protocol.error") throw protocolFailure(message)
            if (message.type == expected) return message
            if (message.type == "pairing.status.result") {
                val status = message.payload.get("status")?.asString
                if (status == "rejected" || status == "expired") {
                    error("Windows pairing was $status.")
                }
            }
        }
    }

    private suspend fun receive(messages: Channel<Incoming>): Envelope =
        when (val incoming = messages.receive()) {
            Incoming.Opened -> error("Unexpected duplicate WebSocket open event.")
            is Incoming.Closed -> throw IllegalStateException(
                incoming.cause.message ?: "Windows connection closed.",
                incoming.cause,
            )
            is Incoming.Message -> incoming.value
        }

    private fun send(
        socket: WebSocket,
        messageId: String,
        type: String,
        payload: JsonObject,
        inReplyTo: String? = null,
    ) {
        val envelope = JsonObject().apply {
            addProperty("protocol_version", 2)
            addProperty("message_id", messageId)
            addProperty("type", type)
            add("payload", payload)
            inReplyTo?.let { addProperty("in_reply_to", it) }
        }
        val encoded = protocolGson.toJson(envelope)
        Log.i(
            TAG,
            "WebSocket send type=$type message_id=$messageId bytes=${encoded.toByteArray(StandardCharsets.UTF_8).size}.",
        )
        check(socket.send(encoded)) {
            "The message could not be sent to Windows."
        }
    }

    private fun protocolFailure(message: Envelope): IllegalStateException {
        val code = message.payload.get("code")?.asString ?: "protocol_error"
        val detail = message.payload.get("message")?.asString ?: "Windows rejected the request."
        return IllegalStateException("$code: $detail")
    }

    private fun validateSettings(
        settings: WifiConnectionSettings,
        transport: ConnectionTransport,
    ) {
        validateTransportEndpoint(settings.host, transport)
        require(settings.port in 1..65535) { "Enter a valid Windows Wi-Fi port." }
        require(
            settings.certificateFingerprint
                .replace(":", "")
                .replace(" ", "")
                .matches(Regex("(?i)[0-9a-f]{64}")),
        ) {
            "Windows TLS certificate trust is missing or invalid. Scan or upload the current " +
                "Windows QR code to establish trust; do not enter a fingerprint manually."
        }
    }

    private fun parseEnvelope(text: String): Envelope {
        val root = JsonParser.parseString(text)
        require(root.isJsonObject) { "Windows sent an invalid protocol envelope." }
        val json = root.asJsonObject
        require(json.keySet().all { it in setOf(
            "protocol_version", "message_id", "in_reply_to", "type", "payload",
        ) }) { "Windows sent an envelope with unsupported fields." }
        require(json.get("protocol_version")?.asInt == 2) {
            "Windows selected an unsupported PocketDeck protocol."
        }
        val messageId = json.get("message_id")?.asString
            ?: error("Windows message is missing its ID.")
        UUID.fromString(messageId)
        val reply = json.get("in_reply_to")?.takeUnless { it.isJsonNull }?.asString
        reply?.let(UUID::fromString)
        val type = json.get("type")?.asString
            ?: error("Windows message is missing its type.")
        val payload = json.getAsJsonObject("payload")
            ?: error("Windows message payload is malformed.")
        return Envelope(messageId, reply, type, payload)
    }

    private fun jsonObject(vararg fields: Pair<String, Any?>): JsonObject =
        gson.toJsonTree(fields.toMap()).asJsonObject

    private data class Envelope(
        val messageId: String,
        val inReplyTo: String?,
        val type: String,
        val payload: JsonObject,
    )

    private sealed interface Incoming {
        data object Opened : Incoming
        data class Message(val value: Envelope) : Incoming
        data class Closed(val cause: Throwable) : Incoming
    }

    private companion object {
        const val TAG = "PocketDeckWifi"
        const val CONNECT_TIMEOUT_MS = 15_000L
        const val SESSION_SETUP_TIMEOUT_MS = 25_000L
        const val USB_TUNNEL_READY_TIMEOUT_MS = 8_000L
        const val USB_TUNNEL_PROBE_TIMEOUT_MS = 400
        const val USB_TUNNEL_RETRY_INTERVAL_MS = 300L
        const val PING_INTERVAL_MS = 10_000L
        const val PAIRING_POLL_INTERVAL_MS = 5_000L
        const val ACTION_TIMEOUT_MS = 30_000L
    }
}

internal class DeviceAuthorizationRejectedException : IllegalStateException(
    "Windows rejected the saved device authorization. It was removed from this device. " +
        "Create a fresh pairing code in Windows, enter it, connect, and approve this device.",
)

internal fun deviceCredentialHandshakeRejection(
    responseCode: Int?,
    hasSavedCredential: Boolean,
): DeviceAuthorizationRejectedException? =
    if (responseCode == 403 && hasSavedCredential) {
        DeviceAuthorizationRejectedException()
    } else {
        null
    }

private class PinnedCertificateTrustManager(fingerprint: String) : X509TrustManager {
    private val expected = fingerprint.replace(":", "").replace(" ", "").lowercase()

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        throw CertificateException("Client certificates are not accepted.")
    }

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        val certificate = chain?.firstOrNull()
            ?: throw CertificateException("Windows did not provide a TLS certificate.")
        certificate.checkValidity()
        if (certificate.basicConstraints >= 0 || !matches(certificate)) {
            throw CertificateException("Windows TLS certificate fingerprint does not match.")
        }
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()

    fun matches(certificate: X509Certificate): Boolean {
        val actual = MessageDigest.getInstance("SHA-256")
            .digest(certificate.encoded)
            .joinToString("") { "%02x".format(it) }
        return certificateFingerprintMatches(expected, actual)
    }
}

internal fun certificateFingerprintMatches(expected: String, actual: String): Boolean {
    val normalizedExpected = expected.replace(":", "").replace(" ", "").lowercase()
    val normalizedActual = actual.replace(":", "").replace(" ", "").lowercase()
    if (!normalizedExpected.matches(Regex("[0-9a-f]{64}")) ||
        !normalizedActual.matches(Regex("[0-9a-f]{64}"))
    ) {
        return false
    }
    return MessageDigest.isEqual(
        normalizedActual.toByteArray(StandardCharsets.US_ASCII),
        normalizedExpected.toByteArray(StandardCharsets.US_ASCII),
    )
}
