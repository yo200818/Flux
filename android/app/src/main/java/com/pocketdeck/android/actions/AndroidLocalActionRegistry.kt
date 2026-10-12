package com.pocketdeck.android.actions

import android.content.Context
import android.content.Intent
import android.net.Uri
import com.pocketdeck.android.config.ActionModel

class AndroidLocalActionRegistry {
    fun openUrl(context: Context, action: ActionModel): Result<Unit> {
        if (action.target != "android_local" || action.type != "open_url") {
            return Result.failure(IllegalArgumentException("Only Android-local open_url is supported."))
        }
        if (!action.enabled) {
            return Result.failure(IllegalStateException("This action is disabled."))
        }
        val rawUrl = action.parameters.get("url")?.asString
            ?: return Result.failure(IllegalArgumentException("The URL action has no URL."))
        val uri = runCatching { Uri.parse(rawUrl) }.getOrNull()
            ?: return Result.failure(IllegalArgumentException("The URL is invalid."))
        if (uri.scheme !in setOf("http", "https") || uri.host.isNullOrBlank()) {
            return Result.failure(IllegalArgumentException("Only absolute HTTP(S) URLs can open locally."))
        }
        return runCatching {
            context.startActivity(Intent(Intent.ACTION_VIEW, uri))
        }
    }
}
