# PocketDeck Android

Native Kotlin/Jetpack Compose companion app. Windows remains the configuration source of truth and executor for Windows-host actions. This milestone imports a local snapshot; Wi-Fi/WSS, USB, and live sync are not implemented.

## Prerequisites

- Android Studio with JDK 17 (the bundled JBR is suitable).
- Android SDK Platform 37 and Build Tools 36.
- An API 23+ emulator image or physical device for runtime verification.
- Gradle 9.6.0 if building from a terminal. This workspace has no Gradle wrapper or Android toolchain installed; do not infer build success until a build is run in a configured environment.

In Android Studio, open this `android/` directory, install the requested SDK packages through SDK Manager, and sync the Gradle project. The app packages the existing `shared/schemas/v1` and `shared/schemas/v2` files directly; it does not maintain a second schema copy. Validation implements the schema keywords used by those files and rejects new unsupported keywords/formats rather than silently ignoring them.

V1 JSON import uses the documented lossless mapping: existing actions target Windows, IDs/order/assignments remain stable, and a UUIDv5 deck ID uses a locally persisted installation namespace because a standalone v1 file contains no Windows namespace. Once live sync exists, the authenticated Windows snapshot is authoritative. Configuration files never contain or import device credentials. While disconnected, only explicit Android-local `open_url` actions can execute; all Windows actions and telemetry are visibly unavailable.

Terminal commands after Gradle is available:

```powershell
gradle :app:testDebugUnitTest
gradle :app:assembleDebug
gradle :app:connectedDebugAndroidTest
```

Configuration import uses Android's document picker and app-private atomic storage. Only explicitly declared Android-local `open_url` actions can launch locally. Windows-host actions remain visibly unavailable until a separately reviewed authenticated transport is implemented.
