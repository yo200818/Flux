package com.pocketdeck.android.navigation

import com.pocketdeck.android.config.DeviceDeckSelection
import com.pocketdeck.android.config.PocketDeckConfiguration

object DeckSelectionNavigator {
    fun normalize(
        configuration: PocketDeckConfiguration,
        saved: DeviceDeckSelection?,
    ): DeviceDeckSelection {
        val profile = configuration.profiles.firstOrNull { it.id == saved?.profileId }
            ?: configuration.profiles.firstOrNull()
            ?: return DeviceDeckSelection(null, null)
        val page = profile.pages.firstOrNull { it.id == saved?.pageId }
            ?: profile.pages.firstOrNull()
        return DeviceDeckSelection(profile.id, page?.id)
    }

    fun selectProfile(
        configuration: PocketDeckConfiguration,
        profileId: String,
    ): DeviceDeckSelection? {
        val profile = configuration.profiles.firstOrNull { it.id == profileId } ?: return null
        return DeviceDeckSelection(profile.id, profile.pages.firstOrNull()?.id)
    }

    fun selectPage(
        configuration: PocketDeckConfiguration,
        selection: DeviceDeckSelection,
        pageId: String,
    ): DeviceDeckSelection? {
        val profile = configuration.profiles.firstOrNull { it.id == selection.profileId } ?: return null
        if (profile.pages.none { it.id == pageId }) return null
        return selection.copy(pageId = pageId)
    }

    fun movePage(
        configuration: PocketDeckConfiguration,
        selection: DeviceDeckSelection,
        direction: Int,
    ): DeviceDeckSelection? {
        require(direction == -1 || direction == 1)
        val profile = configuration.profiles.firstOrNull { it.id == selection.profileId } ?: return null
        if (profile.pages.isEmpty()) return selection.copy(pageId = null)
        val index = profile.pages.indexOfFirst { it.id == selection.pageId }
            .takeIf { it >= 0 } ?: 0
        val nextIndex = (index + direction).coerceIn(0, profile.pages.lastIndex)
        return selection.copy(pageId = profile.pages[nextIndex].id)
    }
}
