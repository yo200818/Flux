plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

val releaseSigningEnvironment = mapOf(
    "POCKETDECK_RELEASE_STORE_FILE" to System.getenv("POCKETDECK_RELEASE_STORE_FILE"),
    "POCKETDECK_RELEASE_STORE_PASSWORD" to System.getenv("POCKETDECK_RELEASE_STORE_PASSWORD"),
    "POCKETDECK_RELEASE_KEY_ALIAS" to System.getenv("POCKETDECK_RELEASE_KEY_ALIAS"),
    "POCKETDECK_RELEASE_KEY_PASSWORD" to System.getenv("POCKETDECK_RELEASE_KEY_PASSWORD"),
)
val releaseSigningMissingVariables = releaseSigningEnvironment
    .filterValues { it.isNullOrBlank() }
    .keys
val releaseSigningConfigured = releaseSigningMissingVariables.isEmpty()
val expectedReleaseAlias = "pocketdeck-release"
val expectedReleaseKeystore = System.getenv("USERPROFILE")
    ?.let { file("$it/.android/pocketdeck-release.jks").canonicalFile }

gradle.taskGraph.whenReady {
    val releaseArtifactRequested = allTasks.any { task ->
        task.name.matches(Regex("(assemble|bundle|package|install).*Release"))
    }
    if (releaseArtifactRequested) {
        if (!releaseSigningConfigured) {
            throw GradleException(
                "Release signing is not configured. Set the required " +
                    releaseSigningMissingVariables.joinToString(", ") +
                    " environment variable(s); no debug signing fallback is allowed.",
            )
        }
        if (releaseSigningEnvironment["POCKETDECK_RELEASE_KEY_ALIAS"] != expectedReleaseAlias) {
            throw GradleException(
                "Release signing requires the existing '$expectedReleaseAlias' key alias.",
            )
        }
        val keystore = file(releaseSigningEnvironment.getValue("POCKETDECK_RELEASE_STORE_FILE")!!)
            .canonicalFile
        if (expectedReleaseKeystore == null || keystore != expectedReleaseKeystore) {
            throw GradleException(
                "Release signing must use the existing per-user .android/pocketdeck-release.jks keystore.",
            )
        }
        if (!keystore.isFile) {
            throw GradleException(
                "The configured PocketDeck release keystore file is not available.",
            )
        }
    }
}

android {
    namespace = "com.pocketdeck.android"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.pocketdeck.android"
        minSdk = 23
        targetSdk = 36
        versionCode = 2
        versionName = "0.1.1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (releaseSigningConfigured) {
            create("release") {
                storeFile = file(releaseSigningEnvironment.getValue("POCKETDECK_RELEASE_STORE_FILE")!!)
                storePassword = releaseSigningEnvironment.getValue("POCKETDECK_RELEASE_STORE_PASSWORD")
                keyAlias = releaseSigningEnvironment.getValue("POCKETDECK_RELEASE_KEY_ALIAS")
                keyPassword = releaseSigningEnvironment.getValue("POCKETDECK_RELEASE_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        getByName("release") {
            if (releaseSigningConfigured) {
                signingConfig = signingConfigs.getByName("release")
            } else {
                signingConfig = null
            }
        }
    }

    buildFeatures {
        compose = true
    }

    sourceSets["main"].assets.srcDir("../../shared/schemas")

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

dependencies {
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.core)
    implementation(libs.androidx.compose.animation)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material.icons.extended)
    implementation(libs.gson)
    implementation(libs.okhttp)
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")

    debugImplementation(libs.androidx.compose.ui.tooling)

    testImplementation(libs.junit)
    testImplementation(libs.gson)

    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
}
