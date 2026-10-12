package com.pocketdeck.android.transport

import android.content.Context
import android.content.ContextWrapper
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WifiConnectionPreferencesTest {
    @Test
    fun certificatePinPersistsEncryptedAndLegacyPinMigrates() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val preferenceName = "wifi-trust-test-${UUID.randomUUID()}"
        val isolatedContext = object : ContextWrapper(context) {
            override fun getSharedPreferences(name: String, mode: Int) =
                context.getSharedPreferences("$preferenceName-$name", mode)
        }
        val fingerprint = "a1".repeat(32)
        val settings = WifiConnectionSettings(
            host = "192.168.1.7",
            port = 8443,
            certificateFingerprint = fingerprint,
            serverId = "6b7bb8da-a30a-45bd-9b89-4a42a191a7c4",
        )
        val preferences = context.getSharedPreferences(
            "$preferenceName-wifi_connection",
            Context.MODE_PRIVATE,
        )
        try {
            WifiConnectionPreferences(isolatedContext).save(settings)
            val encrypted = preferences.getString("trusted_certificate", "").orEmpty()
            assertFalse(encrypted.contains(fingerprint))
            assertEquals(settings, WifiConnectionPreferences(isolatedContext).load())

            preferences.edit()
                .remove("trusted_certificate")
                .putString("fingerprint", fingerprint)
                .commit()
            assertEquals(fingerprint, WifiConnectionPreferences(isolatedContext).load().certificateFingerprint)
            assertFalse(preferences.contains("fingerprint"))
            assertFalse(
                preferences.getString("trusted_certificate", "").orEmpty().contains(fingerprint),
            )
        } finally {
            preferences.edit().clear().commit()
        }
    }
}
