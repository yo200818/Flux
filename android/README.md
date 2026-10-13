# Flux Android

Native Kotlin/Jetpack Compose companion app. PocketDeck for Windows remains the configuration source of truth and executor for Windows-host actions. Flux supports authenticated Wi-Fi synchronization and USB transport, with local snapshot restoration while offline.

## Prerequisites

- Android Studio with JDK 17 (the bundled JBR is suitable).
- Android SDK Platform 37 and Build Tools 36.
- An API 23+ emulator image or physical device for runtime verification.
- Gradle 9.6.0 wrapper is included. Install the Android SDK Platform 37 and Build Tools 36 through Android Studio or SDK Manager.

In Android Studio, open this `android/` directory, install the requested SDK packages through SDK Manager, and sync the Gradle project. The app packages the existing `shared/schemas/v1` and `shared/schemas/v2` files directly; it does not maintain a second schema copy. Validation implements the schema keywords used by those files and rejects new unsupported keywords/formats rather than silently ignoring them.

V1 JSON import uses the documented lossless mapping: existing actions target Windows, IDs/order/assignments remain stable, and a UUIDv5 deck ID uses a locally persisted installation namespace because a standalone v1 file contains no Windows namespace. The authenticated Windows snapshot is authoritative when connected. Configuration files never contain or import device credentials. While disconnected, only explicit Android-local `open_url` actions can execute; Windows-host actions and telemetry are unavailable until the companion reconnects.

Terminal commands after Gradle is available:

```powershell
.\gradlew.bat :app:testDebugUnitTest
.\gradlew.bat :app:assembleDebug
.\gradlew.bat :app:connectedDebugAndroidTest
```

Configuration import uses Android's document picker and app-private atomic storage. Only explicitly declared Android-local `open_url` actions can launch locally; Windows-host actions require an authorized connection.

## Synchronized logos

Windows remains the source of truth for profile, button, and action logos. The Windows editor uploads the chosen image once and stores only an opaque `logo_asset_id` reference in the configuration; no Windows filesystem path or image bytes are placed in the synchronized configuration. Asset references use `logo_` followed by 32 lowercase hexadecimal characters.

Uploads accept PNG, JPEG, and WebP files from 1 byte through 5 MiB. The backend verifies that the declared media type matches the decoded image, rejects invalid images and images over 4096 pixels on either edge or 16 megapixels total, applies EXIF orientation, and converts the result to a WebP thumbnail no larger than 384 pixels per edge and 512 KiB. The authenticated asset endpoint is separate from configuration synchronization. Android downloads thumbnails over the existing pinned-certificate HTTPS connection and stores them in its private `files/logo-assets` cache; the Windows path is never used on Android.

Logo images are optional. If an asset is missing, malformed, or cannot be downloaded, synchronization continues and the UI uses its existing button/action icon or the Flux profile-icon fallback. Profile selection continues to select the corresponding profile logo and button configuration from the synchronized snapshot.

## Android updates and signed releases

Flux's **Check for updates** action queries the public stable-release endpoint for [`yo200818/Pocketdeck`](https://github.com/yo200818/Pocketdeck). The currently published stable release is `v0.1.0`. The updater accepts a release only when its metadata, version tag, APK package/version, SHA-256, and installed signing certificate all validate. The SHA-256 asset is a corruption check; the installed-signature comparison is the independent APK authenticity check.

Each stable GitHub Release must use a `vMAJOR.MINOR.PATCH` tag and include these assets:

- `pocketdeck-android.json`, with this exact schema:

  ```json
  {
    "schemaVersion": 1,
    "versionName": "0.1.1",
    "versionCode": 2,
    "apkAsset": "Flux-0.1.1.apk",
    "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
  }
  ```

  Replace the checksum placeholder with the SHA-256 digest of the final signed APK.

- `Flux-0.1.1.apk`, signed for `com.pocketdeck.android` with the same durable signing identity as every prior production update.

GitHub's release body supplies the displayed release notes. Increment `versionCode` for every APK update; it must be greater than the currently installed code. Use a stable semantic version that matches the `v`-prefixed release tag. Draft and prerelease releases are not offered.

### Release-signing prerequisite

PocketDeck uses the existing permanent Windows release keystore at `%USERPROFILE%\.android\pocketdeck-release.jks` and the existing alias `pocketdeck-release`. Do not generate or replace this key. Gradle reads its path and passwords only from the current process environment:

- `POCKETDECK_RELEASE_STORE_FILE`
- `POCKETDECK_RELEASE_STORE_PASSWORD`
- `POCKETDECK_RELEASE_KEY_ALIAS` (must be `pocketdeck-release`)
- `POCKETDECK_RELEASE_KEY_PASSWORD`

Missing or partial settings, an incorrect alias, or an unavailable keystore cause release artifact tasks to fail with a message that does not include credential values. The release variant has no debug-signing fallback. Debug builds do not require release credentials.

Set up the values for the current PowerShell session without typing passwords into command history or echoing them to the console:

```powershell
$env:POCKETDECK_RELEASE_STORE_FILE = Join-Path $env:USERPROFILE '.android\pocketdeck-release.jks'
$env:POCKETDECK_RELEASE_KEY_ALIAS = 'pocketdeck-release'

$secureStorePassword = Read-Host 'Keystore password' -AsSecureString
$storePasswordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureStorePassword)
try {
    $env:POCKETDECK_RELEASE_STORE_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($storePasswordPointer)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($storePasswordPointer)
    $secureStorePassword.Dispose()
}

$secureKeyPassword = Read-Host 'Key password' -AsSecureString
$keyPasswordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKeyPassword)
try {
    $env:POCKETDECK_RELEASE_KEY_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPasswordPointer)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPasswordPointer)
    $secureKeyPassword.Dispose()
}

.\gradlew.bat :app:assembleRelease
```

These environment values exist only in that PowerShell process and its child Gradle process. Close the terminal when finished to clear them from the session. Never put passwords on a Gradle command line, in a tracked file, or in a CI log.

To safely confirm that the existing keystore contains the expected alias without printing private key material, run this from PowerShell. `keytool` prompts for the keystore password without requiring it in the command:

```powershell
keytool -list -keystore "$env:USERPROFILE\.android\pocketdeck-release.jks" -alias pocketdeck-release
```

It should report that the alias exists and show only certificate/public-key details. This is a read-only operation; it does not modify the keystore.

Compute the checksum from the final signed APK, not an intermediate or unsigned file:

```powershell
(Get-FileHash .\app\build\outputs\apk\release\app-release.apk -Algorithm SHA256).Hash.ToLower()
```

Set that value as `sha256` in the metadata JSON and attach both files to a **published stable** GitHub Release. Do not publish debug APKs as updates.

### Safe upgrade testing

Unit tests cover metadata/version validation, no-update behavior, checksum rejection, package and signer rejection, and cancellation/error reporting. Before any public release, use a dedicated QA device and an isolated QA GitHub repository from a staging-only build; the production endpoint is intentionally fixed to `yo200818/Pocketdeck` and is not a runtime setting. Use an APK signed by the same release key and a higher `versionCode`, then confirm install cancellation, install permission denial/grant, successful installation, and preservation of PocketDeck data. Do not test by publishing a temporary stable release to the production repository. The public updater uses Android's DownloadManager for resumable, app-scoped downloads and does not request install permission until the user chooses **Install update**.
