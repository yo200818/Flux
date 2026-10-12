package com.pocketdeck.android.transport

import com.pocketdeck.android.protocol.ProtocolEnvelope
import com.pocketdeck.android.protocol.HostSessionState

/** Future transport boundary. No Wi-Fi, WSS, discovery, or USB implementation exists in this phase. */
interface DeckTransport {
    val state: HostSessionState

    suspend fun connect()
    suspend fun send(message: ProtocolEnvelope)
    suspend fun disconnect()
}
