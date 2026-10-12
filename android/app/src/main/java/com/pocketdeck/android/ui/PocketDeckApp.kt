package com.pocketdeck.android.ui

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import android.os.SystemClock
import android.util.Log
import com.google.gson.JsonParser
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.pocketdeck.android.actions.ActionCapability
import com.pocketdeck.android.actions.AndroidLocalActionRegistry
import com.pocketdeck.android.config.ActionModel
import com.pocketdeck.android.config.ButtonModel
import com.pocketdeck.android.config.DeviceDeckSelection
import com.pocketdeck.android.navigation.DeckSelectionNavigator
import com.pocketdeck.android.storage.LocalDeckRepository
import com.pocketdeck.android.storage.StoredDeck
import com.pocketdeck.android.transport.AndroidDeviceCredentialStore
import com.pocketdeck.android.transport.AndroidWifiTransport
import com.pocketdeck.android.transport.ConnectionTransport
import com.pocketdeck.android.transport.DeviceAuthorizationRejectedException
import com.pocketdeck.android.transport.WifiConnectionPreferences
import com.pocketdeck.android.transport.WifiConnectionSettings
import com.pocketdeck.android.transport.connectionFailureMessage
import com.pocketdeck.android.transport.hasSameCertificateTrust
import com.pocketdeck.android.transport.parseWifiConnectionQr
import com.pocketdeck.android.transport.settingsForTransport
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import androidx.compose.ui.text.style.TextOverflow
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

private const val WIFI_LOG_TAG = "PocketDeckWifi"

@Composable
internal fun CancelConnectionJobOnDispose(currentJob: () -> Job?) {
    val jobToCancel = currentJob()
    DisposableEffect(jobToCancel) {
        onDispose { jobToCancel?.cancel() }
    }
}

@Composable
fun PocketDeckTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = DeckPalette.violet,
            onPrimary = DeckPalette.foreground,
            secondary = DeckPalette.cyan,
            background = DeckPalette.background,
            onBackground = DeckPalette.foreground,
            surface = DeckPalette.surface,
            onSurface = DeckPalette.foreground,
            surfaceVariant = DeckPalette.keycap,
            onSurfaceVariant = DeckPalette.muted,
            error = DeckPalette.rose,
        ),
        content = content,
    )
}

@Composable
fun PocketDeckApp(
    repository: LocalDeckRepository,
    localActionRegistry: AndroidLocalActionRegistry,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbarHost = remember { SnackbarHostState() }
    var storedDeck by remember { mutableStateOf<StoredDeck?>(null) }
    var loading by remember { mutableStateOf(true) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var settingsOpen by remember { mutableStateOf(false) }
    val executionStates = remember { mutableStateOf<Map<String, ButtonExecutionState>>(emptyMap()) }
    val connectionPreferences = remember(context) { WifiConnectionPreferences(context) }
    val credentialStore = remember(context) { AndroidDeviceCredentialStore(context) }
    val wifiTransport = remember(repository) {
        AndroidWifiTransport(context, repository, connectionPreferences, credentialStore)
    }
    var wifiSettings by remember { mutableStateOf(connectionPreferences.load()) }
    var pairingCode by remember { mutableStateOf("") }
    var connectionTransport by remember { mutableStateOf(ConnectionTransport.WIFI) }
    var connectionStatus by remember { mutableStateOf("Windows offline") }
    var connectionJob by remember { mutableStateOf<Job?>(null) }
    var qrScannerStartedAt by remember { mutableLongStateOf(0L) }
    var qrImportStartedAt by remember { mutableLongStateOf(0L) }
    var qrProcessing by remember { mutableStateOf(false) }
    var qrProgress by remember { mutableStateOf("") }
    var pendingQrTrust by remember { mutableStateOf<WifiConnectionSettings?>(null) }
    val qrDetectionGate = remember { QrDetectionGate() }
    val isConnected = connectionStatus == "Connected"
    val qrScanOptions = remember {
        ScanOptions()
            .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            .setPrompt("Scan the QR code shown by PocketDeck on Windows")
            .setBeepEnabled(false)
            .setOrientationLocked(true)
            .setBarcodeImageEnabled(false)
    }
    suspend fun validateQrPayload(contents: String, source: String, startedAt: Long) {
        val validationStartedAt = SystemClock.elapsedRealtime()
        qrProgress = "QR detected. Validating Windows identity and certificate…"
        val scanned = runCatching {
            withContext(Dispatchers.IO) { parseWifiConnectionQr(contents) }
        }
        val validationElapsed = SystemClock.elapsedRealtime() - validationStartedAt
        scanned.onSuccess { settings ->
            val version = runCatching {
                JsonParser.parseString(contents).asJsonObject.get("version")?.asInt
            }.getOrNull()
            Log.i(
                WIFI_LOG_TAG,
                "PocketDeck QR validated source=$source version=$version " +
                    "wifi_endpoint=${if (settings.host.isBlank()) "missing" else "redacted LAN host"} " +
                    "usb_endpoint=127.0.0.1:${settings.port} certificate_fingerprint=redacted " +
                    "validation_elapsed_ms=$validationElapsed total_elapsed_ms=" +
                    "${SystemClock.elapsedRealtime() - startedAt}.",
            )
            errorMessage = null
            if (hasSameCertificateTrust(wifiSettings, settings)) {
                val saved = runCatching {
                    withContext(Dispatchers.IO) { connectionPreferences.save(settings) }
                }
                saved.onSuccess {
                    wifiSettings = settings
                    snackbarHost.showSnackbar("Previously trusted Windows certificate confirmed.")
                }.onFailure { failure ->
                    errorMessage = userMessage(failure)
                }
            } else {
                pendingQrTrust = settings
            }
        }.onFailure { failure ->
            Log.w(
                WIFI_LOG_TAG,
                "PocketDeck QR rejected source=$source validation_elapsed_ms=$validationElapsed " +
                    "reason=${failure.javaClass.simpleName}.",
            )
            errorMessage = userMessage(failure)
        }
    }
    fun processQrPayload(contents: String, source: String, startedAt: Long) {
        if (!qrDetectionGate.claim()) return
        qrProcessing = true
        scope.launch {
            try {
                validateQrPayload(contents, source, startedAt)
            } finally {
                qrProcessing = false
                qrProgress = ""
            }
        }
    }
    val qrScanner = rememberLauncherForActivityResult(ScanContract()) { result ->
        val contents = result.contents ?: return@rememberLauncherForActivityResult
        Log.i(
            WIFI_LOG_TAG,
            "QR recognized source=camera elapsed_ms=" +
                "${SystemClock.elapsedRealtime() - qrScannerStartedAt} " +
                "payload_bytes=${contents.toByteArray(Charsets.UTF_8).size}.",
        )
        processQrPayload(contents, "camera", qrScannerStartedAt)
    }
    val launchQrScanner = {
        qrDetectionGate.reset()
        pendingQrTrust = null
        qrScannerStartedAt = SystemClock.elapsedRealtime()
        qrScanner.launch(qrScanOptions)
    }
    val cameraPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            launchQrScanner()
        } else {
            errorMessage =
                "Camera permission is required to scan the Windows QR code. Allow camera access in Android Settings and try again."
        }
    }
    val qrImagePicker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia(),
    ) { uri: Uri? ->
        if (uri != null && qrDetectionGate.claim()) {
            qrProcessing = true
            qrProgress = "Decoding selected QR image…"
            qrImportStartedAt = SystemClock.elapsedRealtime()
            scope.launch {
                try {
                    val contents = withContext(Dispatchers.IO) {
                        decodeQrImage(context.contentResolver, uri)
                    }
                    Log.i(
                        WIFI_LOG_TAG,
                        "QR image decoded elapsed_ms=" +
                            "${SystemClock.elapsedRealtime() - qrImportStartedAt} " +
                            "payload_bytes=${contents.toByteArray(Charsets.UTF_8).size}.",
                    )
                    validateQrPayload(contents, "gallery", qrImportStartedAt)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (failure: Exception) {
                    Log.w(
                        WIFI_LOG_TAG,
                        "QR image rejected type=${failure.javaClass.simpleName}.",
                    )
                    errorMessage = userMessage(failure)
                } finally {
                    qrProcessing = false
                    qrProgress = ""
                }
            }
        }
    }
    val launchQrImagePicker = {
        qrDetectionGate.reset()
        pendingQrTrust = null
        errorMessage = null
        qrImagePicker.launch(
            androidx.activity.result.PickVisualMediaRequest(
                ActivityResultContracts.PickVisualMedia.ImageOnly,
            ),
        )
    }
    val trustPendingQr = {
        val settings = pendingQrTrust
        if (settings != null) {
            scope.launch {
                val saved = runCatching {
                    withContext(Dispatchers.IO) { connectionPreferences.save(settings) }
                }
                saved.onSuccess {
                    wifiSettings = settings
                    pendingQrTrust = null
                    errorMessage = null
                    scope.launch {
                        snackbarHost.showSnackbar("Windows certificate trust was saved securely.")
                    }
                }.onFailure { failure ->
                    errorMessage = userMessage(failure)
                }
            }
        }
    }

    CancelConnectionJobOnDispose { connectionJob }

    LaunchedEffect(repository) {
        val restored = runCatching {
            withContext(Dispatchers.IO) { repository.restore() }
        }
        restored.onSuccess { storedDeck = it }
            .onFailure { errorMessage = userMessage(it) }
        loading = false
    }

    val documentPicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenDocument(),
    ) { uri: Uri? ->
        if (uri != null) {
            scope.launch {
                loading = true
                errorMessage = null
                val imported = runCatching {
                    withContext(Dispatchers.IO) {
                        val stream = context.contentResolver.openInputStream(uri)
                            ?: error("The selected document could not be opened.")
                        val text = stream.use { it.readUtf8Bounded() }
                        repository.importConfiguration(text)
                    }
                }
                imported.onSuccess {
                    storedDeck = it
                    snackbarHost.showSnackbar("Configuration imported and saved on this device.")
                }.onFailure {
                    errorMessage = userMessage(it)
                    snackbarHost.showSnackbar("Import failed. The previous deck is unchanged.")
                }
                loading = false
            }
        }
    }

    val startConnection = {
        if (connectionJob?.isActive != true) {
            val settings = settingsForTransport(wifiSettings, connectionTransport)
            runCatching {
                if (connectionTransport == ConnectionTransport.WIFI) {
                    connectionPreferences.save(settings)
                }
            }
                .onFailure { errorMessage = userMessage(it) }
                .onSuccess {
                    errorMessage = null
                    if (connectionTransport == ConnectionTransport.WIFI) {
                        wifiSettings = settings
                    }
                    connectionJob = scope.launch {
                        var nextPairingCode: String? = pairingCode.takeIf { it.isNotBlank() }
                        var reconnectFailures = 0
                        while (isActive) {
                            try {
                                wifiTransport.connect(
                                    settings = settings,
                                    pairingCode = nextPairingCode,
                                    transport = connectionTransport,
                                    deviceName = android.os.Build.MODEL
                                        .filterNot { it.isISOControl() }
                                        .trim()
                                        .ifBlank { "Android device" }
                                        .take(48),
                                    onStatus = {
                                        Log.i(WIFI_LOG_TAG, "Connection status: $it.")
                                        if (it == "Connected") reconnectFailures = 0
                                        connectionStatus = it
                                    },
                                    onPaired = {
                                        nextPairingCode = null
                                        pairingCode = ""
                                    },
                                    onSnapshot = {
                                        storedDeck = withContext(Dispatchers.IO) {
                                            repository.restore()
                                        }
                                    },
                                )
                            } catch (timeout: TimeoutCancellationException) {
                                Log.w(WIFI_LOG_TAG, "Connection setup timed out.", timeout)
                                errorMessage = connectionFailureMessage(timeout, connectionTransport)
                                reconnectFailures += 1
                                val retryDelay = com.pocketdeck.android.transport
                                    .nextReconnectDelayMillis(reconnectFailures)
                                connectionStatus =
                                    "Windows offline — retrying in ${retryDelay / 1_000.0}s"
                                delay(retryDelay)
                            } catch (cancelled: CancellationException) {
                                throw cancelled
                            } catch (rejected: DeviceAuthorizationRejectedException) {
                                Log.w(
                                    WIFI_LOG_TAG,
                                    "Saved Windows authorization was rejected; pairing is required.",
                                )
                                errorMessage = rejected.message
                                connectionStatus =
                                    "Windows authorization rejected — re-pair required"
                                return@launch
                            } catch (failure: Exception) {
                                Log.e(
                                    WIFI_LOG_TAG,
                                    "Connection attempt failed type=${failure.javaClass.simpleName}: ${failure.message}",
                                )
                                errorMessage =
                                    connectionFailureMessage(failure, connectionTransport)
                                reconnectFailures += 1
                                val retryDelay = com.pocketdeck.android.transport
                                    .nextReconnectDelayMillis(reconnectFailures)
                                connectionStatus =
                                    "Windows offline — retrying in ${retryDelay / 1_000.0}s"
                                Log.i(
                                    WIFI_LOG_TAG,
                                    "Reconnect scheduled attempt=$reconnectFailures delay_ms=$retryDelay.",
                                )
                                delay(retryDelay)
                            }
                        }
                    }
                }
        }
    }

    Scaffold(
        containerColor = DeckPalette.background,
        snackbarHost = { SnackbarHost(snackbarHost) },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            DeckScreen(
                deck = storedDeck,
                loading = loading,
                connectionStatus = connectionStatus,
                errorMessage = errorMessage,
                executionStates = executionStates.value,
                onImport = {
                    documentPicker.launch(
                        arrayOf(
                            "application/json",
                            "text/plain",
                            "application/octet-stream",
                        ),
                    )
                },
                onOpenConnection = { settingsOpen = true },
                onSelectProfile = { profileId ->
                    storedDeck?.let { current ->
                        DeckSelectionNavigator.selectProfile(
                            current.configuration,
                            profileId,
                        )?.let { selection ->
                            saveSelection(repository, current, selection, scope) { updated, failure ->
                                if (updated != null) storedDeck = updated
                                if (failure != null) errorMessage = failure
                            }
                        }
                    }
                },
                onSelectPage = { pageId ->
                    storedDeck?.let { current ->
                        DeckSelectionNavigator.selectPage(
                            current.configuration,
                            current.selection,
                            pageId,
                        )?.let { selection ->
                            saveSelection(repository, current, selection, scope) { updated, failure ->
                                if (updated != null) storedDeck = updated
                                if (failure != null) errorMessage = failure
                            }
                        }
                    }
                },
                onPress = { button, action, capability ->
                    errorMessage = null
                    when (capability) {
                        ActionCapability.AndroidLocalOpenUrl -> {
                            setExecutionState(
                                executionStates,
                                button.id,
                                ButtonExecutionState.Running,
                            )
                            val result = action?.let {
                                localActionRegistry.openUrl(context, it)
                            }
                            if (result?.isSuccess == true) {
                                setExecutionState(
                                    executionStates,
                                    button.id,
                                    ButtonExecutionState.Succeeded,
                                )
                                scope.launch {
                                    snackbarHost.showSnackbar("Opened on this device.")
                                }
                            } else {
                                val failure = result?.exceptionOrNull()
                                setExecutionState(
                                    executionStates,
                                    button.id,
                                    ButtonExecutionState.Failed,
                                )
                                errorMessage = failure?.let(::userMessage)
                                    ?: "The Android-local action could not be found."
                            }
                        }
                        ActionCapability.WindowsHostDisconnected ->
                            errorMessage = "Windows offline. Connect to Windows to run this action."
                        ActionCapability.ReadOnlyWindowsWidgetDisconnected ->
                            errorMessage = "Windows offline. Connect to Windows to view this metric."
                        ActionCapability.WindowsHostConnected -> {
                            if (action == null) {
                                errorMessage = "The Windows-hosted action could not be found."
                            } else if (executionStates.value[button.id] != ButtonExecutionState.Running) {
                                setExecutionState(
                                    executionStates,
                                    button.id,
                                    ButtonExecutionState.Running,
                                )
                                scope.launch {
                                    runCatching {
                                        wifiTransport.executeAction(button, action)
                                    }.onSuccess { result ->
                                        setExecutionState(
                                            executionStates,
                                            button.id,
                                            ButtonExecutionState.Succeeded,
                                        )
                                        snackbarHost.showSnackbar(result)
                                    }.onFailure { failure ->
                                        setExecutionState(
                                            executionStates,
                                            button.id,
                                            ButtonExecutionState.Failed,
                                        )
                                        errorMessage = userMessage(failure)
                                    }
                                }
                            }
                        }
                        ActionCapability.Unassigned ->
                            errorMessage = "This button is not assigned to an action."
                        ActionCapability.Disabled ->
                            errorMessage = "This action is disabled."
                        is ActionCapability.Unsupported ->
                            errorMessage = capability.reason
                    }
                },
                onExecutionStateChanged = { id, state ->
                    setExecutionState(executionStates, id, state)
                },
            )
        }
    }

    if (settingsOpen) {
        ConnectionSettingsDialog(
            connectionStatus = connectionStatus,
            settings = wifiSettings,
            transport = connectionTransport,
            pairingCode = pairingCode,
            qrProcessing = qrProcessing,
            qrProgress = qrProgress,
            onScanQr = {
                errorMessage = null
                if (context.checkSelfPermission(Manifest.permission.CAMERA) ==
                    PackageManager.PERMISSION_GRANTED
                ) {
                    launchQrScanner()
                } else {
                    cameraPermission.launch(Manifest.permission.CAMERA)
                }
            },
            onUploadQrImage = launchQrImagePicker,
            errorMessage = errorMessage,
            connectionActive = connectionJob?.isActive == true,
            onPairingCodeChange = { pairingCode = it },
            onTransportChange = {
                if (connectionJob?.isActive == true) {
                    connectionJob?.cancel()
                    connectionJob = null
                    connectionStatus = "Windows offline"
                }
                connectionTransport = it
                errorMessage = null
                if (it == ConnectionTransport.USB) {
                    pairingCode = ""
                    connectionStatus = "Waiting for USB authorization"
                } else {
                    connectionStatus = "Windows offline"
                }
            },
            onConnect = startConnection,
            onDisconnect = {
                connectionJob?.cancel()
                connectionJob = null
                connectionStatus = "Windows offline"
            },
            onDismiss = { settingsOpen = false },
        )
        pendingQrTrust?.let { settings ->
            CertificateTrustConfirmation(
                settings = settings,
                onTrust = trustPendingQr,
                onCancel = {
                    pendingQrTrust = null
                    errorMessage = "Certificate trust was not changed. Scan or upload the current Windows QR code to try again."
                },
            )
        }
    }
}

@Composable
private fun CertificateTrustConfirmation(
    settings: WifiConnectionSettings,
    onTrust: () -> Unit,
    onCancel: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onCancel,
        title = { Text("Trust Windows certificate?") },
        text = {
            androidx.compose.foundation.layout.Column {
                Text(
                    "This QR code provides the TLS certificate pin for the Windows companion. " +
                        "Trust it only if this code is displayed by the Windows PC you intend to connect to.",
                )
                Text(
                    "Companion: ${settings.serverId}",
                    modifier = androidx.compose.ui.Modifier.padding(top = 8.dp),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    if (settings.host.isBlank()) {
                        "Wi-Fi endpoint unavailable. USB can still use this certificate after its ADB reverse tunnel is ready."
                    } else {
                        "Wi-Fi endpoint: ${settings.host}:${settings.port}. USB uses 127.0.0.1 only after ADB reverse is ready."
                    },
                    modifier = androidx.compose.ui.Modifier.padding(top = 4.dp),
                )
                Text(
                    "Trusting the certificate does not approve this Android device. Windows must still authorize the device; Wi-Fi pairing PINs are only used for Wi-Fi pairing.",
                    modifier = androidx.compose.ui.Modifier.padding(top = 8.dp),
                )
            }
        },
        confirmButton = {
            TextButton(onClick = onTrust) {
                Text("Trust certificate")
            }
        },
        dismissButton = {
            TextButton(onClick = onCancel) {
                Text("Cancel")
            }
        },
    )
}

private fun setExecutionState(
    state: androidx.compose.runtime.MutableState<Map<String, ButtonExecutionState>>,
    buttonId: String,
    value: ButtonExecutionState,
) {
    state.value = state.value + (buttonId to value)
}

private fun saveSelection(
    repository: LocalDeckRepository,
    current: StoredDeck,
    selection: DeviceDeckSelection,
    scope: kotlinx.coroutines.CoroutineScope,
    onComplete: (StoredDeck?, String?) -> Unit,
) {
    scope.launch {
        val result = runCatching {
            withContext(Dispatchers.IO) {
                repository.updateSelection(current, selection)
            }
        }
        result.onSuccess { onComplete(it, null) }
            .onFailure { onComplete(null, userMessage(it)) }
    }
}

private fun InputStream.readUtf8Bounded(): String {
    val output = java.io.ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    var total = 0
    while (true) {
        val count = read(buffer)
        if (count < 0) break
        total += count
        if (total > com.pocketdeck.android.config.MAX_CONFIGURATION_BYTES) {
            throw IllegalArgumentException("Configuration files must be 4 MiB or smaller.")
        }
        output.write(buffer, 0, count)
    }
    return Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(output.toByteArray()))
        .toString()
}

private fun userMessage(error: Throwable): String =
    error.message?.takeIf { it.isNotBlank() } ?: "The configuration could not be loaded."
