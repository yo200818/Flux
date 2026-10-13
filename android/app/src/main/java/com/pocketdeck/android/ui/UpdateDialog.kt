package com.pocketdeck.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.pocketdeck.android.update.PocketDeckRelease
import com.pocketdeck.android.update.UpdateState

@Composable
internal fun UpdateDialog(
    state: UpdateState,
    canInstallPackages: Boolean,
    onCheck: () -> Unit,
    onDownload: (PocketDeckRelease) -> Unit,
    onCancelDownload: () -> Unit,
    onInstall: () -> Unit,
    onGrantInstallPermission: () -> Unit,
    onDismiss: () -> Unit,
) {
    val release = when (state) {
        is UpdateState.Available -> state.release
        is UpdateState.Downloading -> state.release
        is UpdateState.Verifying -> state.release
        is UpdateState.Cancelled -> state.release
        is UpdateState.Error -> state.release
        is UpdateState.ReadyToInstall -> state.update.release
        is UpdateState.InstallPermissionRequired -> state.update.release
        else -> null
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Flux updates") },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 360.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                when (state) {
                    UpdateState.Checking -> {
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            CircularProgressIndicator()
                            Text("Checking GitHub for a stable release…")
                        }
                    }
                    is UpdateState.UpToDate ->
                        Text("Flux ${state.installedVersion} is up to date.")
                    is UpdateState.Available ->
                        Text("Version ${state.release.versionName} is available.")
                    is UpdateState.Downloading -> {
                        Text("Downloading version ${state.release.versionName}…")
                        val progress = if (state.totalBytes > 0L) {
                            state.bytesDownloaded.toFloat() / state.totalBytes.toFloat()
                        } else {
                            0f
                        }
                        LinearProgressIndicator(
                            progress = { progress.coerceIn(0f, 1f) },
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Text(
                            if (state.totalBytes > 0L) {
                                "${formatBytes(state.bytesDownloaded)} of ${formatBytes(state.totalBytes)}"
                            } else {
                                "${formatBytes(state.bytesDownloaded)} downloaded"
                            },
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    is UpdateState.Verifying -> {
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            CircularProgressIndicator()
                            Text("Verifying APK checksum, package, and signing certificate…")
                        }
                    }
                    is UpdateState.ReadyToInstall ->
                        Text("Version ${state.update.release.versionName} is verified and ready to install.")
                    is UpdateState.InstallPermissionRequired ->
                        Text(state.message, color = MaterialTheme.colorScheme.error)
                    is UpdateState.InstallationLaunched ->
                        Text(
                            "Android's installer was opened for version ${state.versionName}. " +
                                "Flux will confirm the result when you return.",
                        )
                    is UpdateState.Installed ->
                        Text("Flux ${state.versionName} is installed.")
                    is UpdateState.Cancelled ->
                        Text("The update was cancelled.")
                    is UpdateState.Error ->
                        Text(state.message, color = MaterialTheme.colorScheme.error)
                }
                release?.let {
                    Text(
                        "Release notes",
                        style = MaterialTheme.typography.titleSmall,
                    )
                    Text(
                        it.releaseNotes.ifBlank { "No release notes were provided." },
                        style = MaterialTheme.typography.bodySmall,
                        maxLines = 12,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                if (state is UpdateState.ReadyToInstall && !canInstallPackages) {
                    Text(
                        "Android requires permission for Flux to install apps from outside the Play Store. " +
                            "Allow it in the system settings screen that opens next; Flux will not enable it for you.",
                        color = DeckPalette.muted,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        },
        confirmButton = {
            when (state) {
                UpdateState.Checking,
                is UpdateState.Downloading,
                is UpdateState.Verifying,
                is UpdateState.InstallationLaunched -> Unit
                is UpdateState.Available ->
                    Button(onClick = { onDownload(state.release) }) { Text("Download") }
                is UpdateState.ReadyToInstall ->
                    Button(
                        onClick = if (canInstallPackages) onInstall else onGrantInstallPermission,
                    ) {
                        Text(if (canInstallPackages) "Install update" else "Allow install")
                    }
                is UpdateState.InstallPermissionRequired ->
                    Button(onClick = onGrantInstallPermission) { Text("Open install settings") }
                is UpdateState.Installed -> TextButton(onClick = onDismiss) { Text("Done") }
                is UpdateState.Cancelled -> {
                    if (state.verifiedUpdate != null) {
                        Button(onClick = onInstall) { Text("Install again") }
                    } else if (state.release != null) {
                        Button(onClick = { onDownload(state.release) }) { Text("Download again") }
                    } else {
                        TextButton(onClick = onCheck) { Text("Check again") }
                    }
                }
                is UpdateState.Error -> {
                    if (state.release != null) {
                        Button(onClick = { onDownload(state.release) }) { Text("Retry download") }
                    } else {
                        TextButton(onClick = onCheck) { Text("Check again") }
                    }
                }
                is UpdateState.UpToDate -> TextButton(onClick = onCheck) { Text("Check again") }
            }
        },
        dismissButton = {
            Row {
                if (state is UpdateState.Downloading) {
                    TextButton(onClick = onCancelDownload) { Text("Cancel download") }
                }
                TextButton(onClick = onDismiss) {
                    Text(if (state is UpdateState.InstallationLaunched) "Done" else "Close")
                }
            }
        },
    )
}

private fun formatBytes(bytes: Long): String =
    if (bytes < 1024) {
        "$bytes B"
    } else {
        val kibibytes = bytes / 1024.0
        if (kibibytes < 1024) {
            "%.1f KiB".format(kibibytes)
        } else {
            "%.1f MiB".format(kibibytes / 1024.0)
        }
    }
