package com.pocketdeck.android.protocol

import com.google.gson.JsonObject
import java.util.UUID

/** Transport-independent v2 envelope model; serialization/negotiation are future work. */
data class ProtocolEnvelope(
    val protocolVersion: Int,
    val messageId: UUID,
    val type: String,
    val payload: JsonObject,
    val inReplyTo: UUID? = null,
)

sealed interface HostSessionState {
    data object Disconnected : HostSessionState
    data object Connecting : HostSessionState
    data object Authenticating : HostSessionState
    data object Negotiating : HostSessionState
    data object Synchronizing : HostSessionState
    data object Ready : HostSessionState
    data class Failed(val message: String) : HostSessionState
}
