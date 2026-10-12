package com.pocketdeck.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.background
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.RadioButton
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.pocketdeck.android.transport.WifiConnectionSettings
import com.pocketdeck.android.transport.ConnectionTransport
import com.pocketdeck.android.transport.isLoopbackHost
import com.pocketdeck.android.transport.settingsForTransport

@Composable
internal fun ConnectionSettingsDialog(
    connectionStatus: String,
    settings: WifiConnectionSettings,
    transport: ConnectionTransport,
    pairingCode: String,
    qrProcessing: Boolean,
    qrProgress: String,
    errorMessage: String?,
    connectionActive: Boolean,
    onPairingCodeChange: (String) -> Unit,
    onTransportChange: (ConnectionTransport) -> Unit,
    onScanQr: () -> Unit,
    onUploadQrImage: () -> Unit,
    onConnect: () -> Unit,
    onDisconnect: () -> Unit,
    onDismiss: () -> Unit,
) {
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(
            modifier = Modifier.fillMaxWidth(0.72f).heightIn(max = 520.dp),
            shape = MaterialTheme.shapes.extraLarge,
            color = DeckPalette.surface,
            border = androidx.compose.foundation.BorderStroke(1.dp, DeckPalette.outline),
        ) {
            Column(
                modifier = Modifier
                    .verticalScroll(rememberScrollState())
                    .padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    "Windows connection",
                    color = DeckPalette.foreground,
                    style = MaterialTheme.typography.titleLarge,
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    androidx.compose.foundation.layout.Box(
                        modifier = Modifier
                            .padding(top = 7.dp)
                            .size(8.dp)
                            .background(
                                if (connectionStatus == "Connected") DeckPalette.emerald else DeckPalette.orange,
                                androidx.compose.foundation.shape.CircleShape,
                            ),
                    )
                    Text(
                        connectionStatus,
                        color = if (connectionStatus == "Connected") DeckPalette.emerald else DeckPalette.orange,
                        style = MaterialTheme.typography.labelLarge,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (connectionActive && connectionStatus != "Connected") {
                        CircularProgressIndicator(
                            modifier = Modifier.size(15.dp),
                            strokeWidth = 2.dp,
                            color = DeckPalette.violet,
                        )
                    }
                }
                Text(
                    when {
                        settings.serverId.isBlank() ->
                            "Scan the QR code displayed by the Windows companion to verify its identity and TLS certificate."
                        transport == ConnectionTransport.USB ->
                            "Verified Windows TLS identity. USB endpoint: ${settingsForTransport(settings, transport).host}:${settings.port}"
                        settings.host.isBlank() || isLoopbackHost(settings.host) ->
                            "The saved QR has no Wi-Fi LAN endpoint. Connect Windows to a private Wi-Fi network and scan its current QR code."
                        else ->
                            "Verified Windows TLS identity. Wi-Fi endpoint: ${settings.host}:${settings.port}"
                    },
                    color = DeckPalette.muted,
                    style = MaterialTheme.typography.bodySmall,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Row {
                        RadioButton(
                            selected = transport == ConnectionTransport.WIFI,
                            onClick = { onTransportChange(ConnectionTransport.WIFI) },
                        )
                        TextButton(onClick = { onTransportChange(ConnectionTransport.WIFI) }) {
                            Text("Wi-Fi", color = DeckPalette.foreground)
                        }
                    }
                    Row {
                        RadioButton(
                            selected = transport == ConnectionTransport.USB,
                            onClick = { onTransportChange(ConnectionTransport.USB) },
                        )
                        TextButton(onClick = { onTransportChange(ConnectionTransport.USB) }) {
                            Text("USB (ADB)", color = DeckPalette.foreground)
                        }
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = onScanQr, enabled = !qrProcessing) {
                        Text("Scan QR", color = DeckPalette.cyan)
                    }
                    TextButton(onClick = onUploadQrImage, enabled = !qrProcessing) {
                        Text("Upload QR Image", color = DeckPalette.cyan)
                    }
                }
                if (qrProcessing) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp),
                            strokeWidth = 2.dp,
                            color = DeckPalette.cyan,
                        )
                        Text(
                            qrProgress,
                            color = DeckPalette.cyan,
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
                if (transport == ConnectionTransport.WIFI) {
                    OutlinedTextField(
                        value = pairingCode,
                        onValueChange = { onPairingCodeChange(it.filter(Char::isDigit).take(6)) },
                        label = { Text("Six-digit Wi-Fi pairing PIN") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                Text(
                    if (transport == ConnectionTransport.WIFI) {
                        "Scanning or uploading the QR establishes TLS certificate trust after your confirmation. Wi-Fi pairing uses a single-use PIN only when no valid device credential is saved; Windows must still approve this device."
                    } else {
                        "The QR establishes TLS certificate trust; USB is separate and uses ADB reverse tcp:${settings.port} tcp:${settings.port} to reach 127.0.0.1 only after Windows confirms the tunnel. Keep the Windows companion running and authorize USB debugging. No Wi-Fi PIN or manually typed fingerprint is used; Windows must still explicitly approve this device."
                    } + " Credentials are stored securely on this device.",
                    color = DeckPalette.muted,
                    style = MaterialTheme.typography.bodySmall,
                )
                if (!errorMessage.isNullOrBlank()) {
                    Text(
                        errorMessage,
                        color = DeckPalette.rose,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.End,
                ) {
                    TextButton(onClick = onDismiss) {
                        Text("Close", color = DeckPalette.muted)
                    }
                    TextButton(
                        onClick = onDisconnect,
                        enabled = connectionActive,
                    ) {
                        Text("Disconnect", color = DeckPalette.orange)
                    }
                    Button(
                        onClick = onConnect,
                        enabled = !connectionActive,
                        colors = ButtonDefaults.buttonColors(containerColor = DeckPalette.violet),
                    ) {
                        Text(if (connectionActive) "Connecting" else "Connect")
                    }
                }
            }
        }
    }
}
