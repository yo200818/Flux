package com.pocketdeck.android.transport

import org.junit.Assert.assertEquals
import org.junit.Test

class ConfigurationSyncPayloadTest {
    @Test
    fun firstSyncSendsExplicitNullRevisionAndRequestsSnapshot() {
        assertEquals(
            """{"last_accepted":null,"force_snapshot":true}""",
            protocolGson.toJson(configurationSyncPayload(null)),
        )
    }

    @Test
    fun subsequentSyncSendsAcceptedRevisionWithoutForcingSnapshot() {
        assertEquals(
            """{"last_accepted":{"config_epoch":"epoch-1","revision":7},"force_snapshot":false}""",
            protocolGson.toJson(configurationSyncPayload("epoch-1" to 7L)),
        )
    }
}
