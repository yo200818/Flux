package com.pocketdeck.android.ui

import android.graphics.BitmapFactory
import android.graphics.Color as AndroidColor
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Apps
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Keyboard
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Memory
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Public
import androidx.compose.material.icons.filled.Save
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material.icons.filled.WifiOff
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.painter.BitmapPainter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.Dp
import com.pocketdeck.android.R
import com.pocketdeck.android.actions.ActionCapability
import com.pocketdeck.android.actions.ActionCapabilityResolver
import com.pocketdeck.android.config.ActionModel
import com.pocketdeck.android.config.ButtonModel
import com.pocketdeck.android.config.DeviceDeckSelection
import com.pocketdeck.android.config.PageModel
import com.pocketdeck.android.config.PocketDeckConfiguration
import com.pocketdeck.android.navigation.DeckSelectionNavigator
import com.pocketdeck.android.storage.StoredDeck
import com.pocketdeck.android.storage.LogoAssetCache
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.delay

internal enum class ButtonExecutionState {
    Idle,
    Running,
    Succeeded,
    Failed,
}

internal enum class ConnectionDisplayState {
    Connected,
    Connecting,
    Reconnecting,
    Disconnected,
    NeedsAttention,
}

internal fun connectionDisplayState(
    status: String,
    connected: Boolean,
): ConnectionDisplayState {
    if (connected) return ConnectionDisplayState.Connected
    if (status.contains("attention", ignoreCase = true) ||
        status.contains("re-pair", ignoreCase = true) ||
        status.contains("rejected", ignoreCase = true)
    ) {
        return ConnectionDisplayState.NeedsAttention
    }
    if (status.contains("retry", ignoreCase = true)) {
        return ConnectionDisplayState.Reconnecting
    }
    if (listOf("connect", "authenticat", "loading", "waiting").any {
            status.contains(it, ignoreCase = true)
        }
    ) {
        return ConnectionDisplayState.Connecting
    }
    return ConnectionDisplayState.Disconnected
}

internal object DeckPalette {
    val background = Color(0xFF0B0E15)
    val surface = Color(0xFF11151F)
    val keycap = Color(0xFF161B27)
    val outline = Color(0xFF2A3140)
    val muted = Color(0xFF8B93A5)
    val violet = Color(0xFF8B5CF6)
    val orange = Color(0xFFF97316)
    val emerald = Color(0xFF10B981)
    val cyan = Color(0xFF06B6D4)
    val rose = Color(0xFFF43F5E)
    val foreground = Color(0xFFF3F4F8)
}

private val DeckGridGap = 8.dp
private val DeckMinimumCardWidth = 76.dp
private val DeckMinimumCardHeight = 84.dp
private val DeckMaximumCardWidth = 184.dp
private val DeckMaximumCardHeight = 200.dp
private const val DeckCardMaximumWidthToHeight = 1.25f
private const val DeckCardMinimumWidthToHeight = 0.72f
private val DeckGroupControlsHeight = 18.dp

internal data class DeckGridLayout(
    val columns: Int,
    val rows: Int,
    val capacity: Int,
    val hasGroupControls: Boolean,
)

internal data class DeckCardSize(val width: Dp, val height: Dp)

@Composable
private fun DeckHeader(
    configuration: PocketDeckConfiguration?,
    profile: com.pocketdeck.android.config.ProfileModel?,
    page: PageModel?,
    loading: Boolean,
    connectionStatus: String,
    connected: Boolean,
    compact: Boolean,
    profileMenuExpanded: Boolean,
    pageMenuExpanded: Boolean,
    onProfileMenuExpanded: (Boolean) -> Unit,
    onPageMenuExpanded: (Boolean) -> Unit,
    onSelectProfile: (String) -> Unit,
    onSelectPage: (String) -> Unit,
    onOpenConnection: () -> Unit,
) {
    if (compact) {
        Column(
            modifier = Modifier.fillMaxWidth().height(68.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth().height(36.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                ProfileSelector(
                    modifier = Modifier.weight(1f),
                    configuration = configuration,
                    profile = profile,
                    loading = loading,
                    expanded = profileMenuExpanded,
                    onExpandedChange = onProfileMenuExpanded,
                    onSelectProfile = onSelectProfile,
                    maxTextWidth = 110.dp,
                )
                ConnectionIndicator(
                    status = connectionStatus,
                    connected = connected,
                    onClick = onOpenConnection,
                )
                SettingsButton(onOpenConnection)
            }
            PageSelector(
                modifier = Modifier.fillMaxWidth().height(30.dp),
                profile = profile,
                page = page,
                compact = true,
                expanded = pageMenuExpanded,
                onExpandedChange = onPageMenuExpanded,
                onSelectPage = onSelectPage,
            )
        }
    } else {
        Row(
            modifier = Modifier.fillMaxWidth().height(46.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            ProfileSelector(
                configuration = configuration,
                profile = profile,
                loading = loading,
                expanded = profileMenuExpanded,
                onExpandedChange = onProfileMenuExpanded,
                onSelectProfile = onSelectProfile,
                maxTextWidth = 90.dp,
            )
            PageSelector(
                profile = profile,
                page = page,
                compact = false,
                expanded = pageMenuExpanded,
                onExpandedChange = onPageMenuExpanded,
                onSelectPage = onSelectPage,
            )
            Spacer(Modifier.weight(1f))
            ConnectionIndicator(
                status = connectionStatus,
                connected = connected,
                onClick = onOpenConnection,
            )
            SettingsButton(onOpenConnection)
        }
    }
}

@Composable
private fun ProfileSelector(
    modifier: Modifier = Modifier,
    configuration: PocketDeckConfiguration?,
    profile: com.pocketdeck.android.config.ProfileModel?,
    loading: Boolean,
    expanded: Boolean,
    onExpandedChange: (Boolean) -> Unit,
    onSelectProfile: (String) -> Unit,
    maxTextWidth: Dp,
) {
    Box(modifier) {
        Row(
            modifier = Modifier
                .clip(RoundedCornerShape(10.dp))
                .clickable(enabled = configuration?.profiles?.isNotEmpty() == true) {
                    onExpandedChange(true)
                }
                .padding(horizontal = 4.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Surface(
                modifier = Modifier.size(28.dp),
                shape = RoundedCornerShape(7.dp),
                color = DeckPalette.violet.copy(alpha = 0.18f),
                border = BorderStroke(1.dp, DeckPalette.violet.copy(alpha = 0.55f)),
            ) {
                Box(Modifier.fillMaxSize().padding(3.dp)) {
                    Image(
                        painter = painterResource(R.drawable.ic_flux_foreground),
                        contentDescription = null,
                        modifier = Modifier.fillMaxSize(),
                    )
                    LogoAssetImage(
                        assetId = profile?.logoAssetId,
                        contentDescription = "${profile?.name.orEmpty()} profile logo",
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            }
            Column(
                modifier = Modifier.widthIn(max = maxTextWidth),
                verticalArrangement = Arrangement.spacedBy(0.dp),
            ) {
                Text(
                    configuration?.deck?.name ?: "Flux",
                    color = DeckPalette.foreground,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    profile?.name ?: if (loading) "Loading cached deck" else "No deck loaded",
                    color = DeckPalette.muted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        }
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { onExpandedChange(false) },
        ) {
            configuration?.profiles?.forEach { item ->
                DropdownMenuItem(
                    text = { Text(item.name) },
                    onClick = {
                        onExpandedChange(false)
                        onSelectProfile(item.id)
                    },
                )
            }
        }
    }
}

@Composable
private fun PageSelector(
    modifier: Modifier = Modifier,
    profile: com.pocketdeck.android.config.ProfileModel?,
    page: PageModel?,
    compact: Boolean,
    expanded: Boolean,
    onExpandedChange: (Boolean) -> Unit,
    onSelectPage: (String) -> Unit,
) {
    Box(modifier) {
        Row(
            modifier = Modifier
                .clip(RoundedCornerShape(8.dp))
                .clickable(enabled = profile?.pages?.isNotEmpty() == true) {
                    onExpandedChange(true)
                }
                .padding(horizontal = 5.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            Text(
                page?.name ?: "Select page",
                modifier = Modifier.widthIn(max = if (compact) 240.dp else 58.dp),
                color = DeckPalette.foreground,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.labelMedium,
            )
            val pageIndex = profile?.pages?.indexOfFirst { it.id == page?.id } ?: -1
            Text(
                if (pageIndex >= 0) "${pageIndex + 1}/${profile?.pages?.size}" else "—",
                color = DeckPalette.muted,
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
            )
        }
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { onExpandedChange(false) },
        ) {
            profile?.pages?.forEach { item ->
                DropdownMenuItem(
                    text = { Text(item.name) },
                    onClick = {
                        onExpandedChange(false)
                        onSelectPage(item.id)
                    },
                )
            }
        }
    }
}

@Composable
private fun SettingsButton(onOpenConnection: () -> Unit) {
    IconButton(onClick = onOpenConnection, modifier = Modifier.size(36.dp)) {
        Icon(
            Icons.Default.Settings,
            contentDescription = "Connection settings",
            tint = DeckPalette.muted,
        )
    }
}

@Composable
internal fun DeckScreen(
    deck: StoredDeck?,
    loading: Boolean,
    connectionStatus: String,
    errorMessage: String?,
    executionStates: Map<String, ButtonExecutionState>,
    onImport: () -> Unit,
    onOpenConnection: () -> Unit,
    onSelectProfile: (String) -> Unit,
    onSelectPage: (String) -> Unit,
    onPress: (ButtonModel, ActionModel?, ActionCapability) -> Unit,
    onExecutionStateChanged: (String, ButtonExecutionState) -> Unit,
) {
    val configuration = deck?.configuration
    val profile = configuration?.profiles?.firstOrNull { it.id == deck.selection.profileId }
    val page = profile?.pages?.firstOrNull { it.id == deck.selection.pageId }
    val connected = connectionStatus == "Connected"
    var profileMenuExpanded by remember { mutableStateOf(false) }
    var pageMenuExpanded by remember { mutableStateOf(false) }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val compactHeader = maxWidth < 460.dp
        Column(
            modifier = Modifier
                .fillMaxSize()
                .background(DeckPalette.background)
                .padding(horizontal = 10.dp, vertical = 4.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            DeckHeader(
                configuration = configuration,
                profile = profile,
                page = page,
                loading = loading,
                connectionStatus = connectionStatus,
                connected = connected,
                compact = compactHeader,
                profileMenuExpanded = profileMenuExpanded,
                pageMenuExpanded = pageMenuExpanded,
                onProfileMenuExpanded = { profileMenuExpanded = it },
                onPageMenuExpanded = { pageMenuExpanded = it },
                onSelectProfile = onSelectProfile,
                onSelectPage = onSelectPage,
                onOpenConnection = onOpenConnection,
            )

        errorMessage?.let { message ->
            Text(
                message,
                color = DeckPalette.rose,
                style = MaterialTheme.typography.labelSmall,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .background(DeckPalette.rose.copy(alpha = 0.08f))
                    .padding(horizontal = 9.dp, vertical = 4.dp),
            )
        }

        Row(
            modifier = Modifier.fillMaxWidth().weight(1f),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            val selection = deck?.selection ?: DeviceDeckSelection(null, null)
            val canGoPrevious = profile != null &&
                profile.pages.indexOfFirst { it.id == selection.pageId } > 0
            val canGoNext = profile != null &&
                profile.pages.indexOfFirst { it.id == selection.pageId } in 0 until profile.pages.lastIndex
            PageArrow(
                image = Icons.AutoMirrored.Filled.ArrowBack,
                description = "Previous page",
                enabled = canGoPrevious,
                onClick = {
                    configuration?.let {
                        DeckSelectionNavigator.movePage(it, selection, -1)?.pageId?.let(onSelectPage)
                    }
                },
            )
            if (page == null) {
                EmptyDeckCanvas(
                    modifier = Modifier.weight(1f).fillMaxHeight(),
                    loading = loading,
                    hasDeck = deck != null,
                    onImport = onImport,
                )
            } else {
                BoxWithConstraints(Modifier.weight(1f).fillMaxHeight()) {
                    val transitionState = profile.id to page.id
                    androidx.compose.animation.AnimatedContent(
                        targetState = transitionState,
                        modifier = Modifier.fillMaxSize(),
                        transitionSpec = {
                            fadeIn(tween(160, easing = FastOutSlowInEasing)) +
                                scaleIn(initialScale = 0.985f, animationSpec = tween(160)) togetherWith
                                (fadeOut(tween(110)) + scaleOut(targetScale = 0.99f, animationSpec = tween(110)))
                        },
                        label = "deck-page-transition",
                    ) { target ->
                        val targetPage = configuration.profiles
                            .firstOrNull { it.id == target.first }
                            ?.pages?.firstOrNull { it.id == target.second }
                        if (targetPage == null || targetPage.buttons.isEmpty()) {
                            EmptyPageCanvas()
                        } else {
                            ButtonGrid(
                                page = targetPage,
                                configuration = configuration,
                                connected = connected,
                                executionStates = executionStates,
                                onPress = onPress,
                                onExecutionStateChanged = onExecutionStateChanged,
                            )
                        }
                    }
                }
            }
            PageArrow(
                image = Icons.AutoMirrored.Filled.ArrowForward,
                description = "Next page",
                enabled = canGoNext,
                onClick = {
                    configuration?.let {
                        DeckSelectionNavigator.movePage(it, selection, 1)?.pageId?.let(onSelectPage)
                    }
                },
            )
        }

        Row(
            modifier = Modifier.fillMaxWidth().height(25.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val assignedCount = page?.buttons?.count { it.actionId != null } ?: 0
            Text(
                page?.let { "${it.buttons.size} BUTTONS  ·  $assignedCount ASSIGNED" } ?: "DECK NOT LOADED",
                modifier = Modifier.weight(1f),
                color = DeckPalette.muted,
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.weight(1f))
            Text(
                if (connected) "SYNCED" else "CACHED",
                color = if (connected) DeckPalette.emerald.copy(alpha = 0.85f) else DeckPalette.muted,
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
            )
            Spacer(Modifier.width(4.dp))
            Row(
                modifier = Modifier
                    .clip(RoundedCornerShape(7.dp))
                    .clickable(onClick = onImport)
                    .padding(horizontal = 5.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                Icon(Icons.Default.Description, contentDescription = null, tint = DeckPalette.muted, modifier = Modifier.size(14.dp))
                Text("IMPORT", color = DeckPalette.muted, style = MaterialTheme.typography.labelSmall)
            }
            }
        }
    }

}

@Composable
private fun LogoAssetImage(
    assetId: String?,
    contentDescription: String?,
    modifier: Modifier,
) {
    val context = LocalContext.current
    val image = produceState<ImageBitmap?>(
        initialValue = null,
        key1 = assetId,
    ) {
        value = withContext(Dispatchers.IO) {
            assetId?.let { LogoAssetCache(context.filesDir).imageFile(it) }
                ?.let { BitmapFactory.decodeFile(it.absolutePath)?.asImageBitmap() }
        }
    }.value
    image?.let {
        Image(
            painter = BitmapPainter(it),
            contentDescription = contentDescription,
            contentScale = ContentScale.Fit,
            modifier = modifier,
        )
    }
}

@Composable
private fun ButtonGrid(
    page: PageModel,
    configuration: PocketDeckConfiguration,
    connected: Boolean,
    executionStates: Map<String, ButtonExecutionState>,
    onPress: (ButtonModel, ActionModel?, ActionCapability) -> Unit,
    onExecutionStateChanged: (String, ButtonExecutionState) -> Unit,
) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val layout = responsiveDeckLayout(maxWidth, maxHeight, page.buttons.size)
        val columns = layout.columns
        val capacity = layout.capacity
        val groupCount = (page.buttons.size + capacity - 1) / capacity
        var groupIndex by remember(page.id, page.buttons.size) { mutableIntStateOf(0) }
        val activeGroup = groupIndex.coerceIn(0, groupCount - 1)
        val firstItem = activeGroup * capacity
        val visibleButtons = page.buttons.drop(firstItem).take(capacity)
        val displayRows = visibleButtons.chunked(columns)
        val rowCount = layout.rows.coerceAtLeast(1)
        val cardSize = responsiveDeckCardSize(
            width = maxWidth,
            height = maxHeight,
            columns = columns,
            rows = rowCount,
            hasGroupControls = layout.hasGroupControls,
        )
        val cardWidth = cardSize.width
        val cardHeight = cardSize.height
        LaunchedEffect(activeGroup) {
            if (groupIndex != activeGroup) groupIndex = activeGroup
        }

        Column(
            modifier = Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(DeckGridGap),
        ) {
            if (layout.hasGroupControls) {
                Row(
                    modifier = Modifier.fillMaxWidth().height(DeckGroupControlsHeight),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.Center,
                ) {
                    IconButton(
                        onClick = { groupIndex = activeGroup - 1 },
                        enabled = activeGroup > 0,
                        modifier = Modifier.size(22.dp),
                    ) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "Previous button group",
                            tint = if (activeGroup > 0) DeckPalette.violet else DeckPalette.muted,
                            modifier = Modifier.size(14.dp),
                        )
                    }
                    Text(
                        "${firstItem + 1}–${firstItem + visibleButtons.size} OF ${page.buttons.size}",
                        color = DeckPalette.muted,
                        fontFamily = FontFamily.Monospace,
                        style = MaterialTheme.typography.labelSmall,
                    )
                    IconButton(
                        onClick = { groupIndex = activeGroup + 1 },
                        enabled = activeGroup < groupCount - 1,
                        modifier = Modifier.size(22.dp),
                    ) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowForward,
                            contentDescription = "Next button group",
                            tint = if (activeGroup < groupCount - 1) DeckPalette.violet else DeckPalette.muted,
                            modifier = Modifier.size(14.dp),
                        )
                    }
                }
            }
            Column(
                modifier = Modifier.weight(1f).fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(
                    DeckGridGap,
                    Alignment.CenterVertically,
                ),
            ) {
                displayRows.forEach { rowButtons ->
                    Row(
                        modifier = Modifier.fillMaxWidth().height(cardHeight),
                        horizontalArrangement = Arrangement.spacedBy(
                            DeckGridGap,
                            Alignment.CenterHorizontally,
                        ),
                    ) {
                        rowButtons.forEach { button ->
                            val resolution = remember(configuration.actions, button, connected) {
                                ActionCapabilityResolver.resolveButton(
                                    button,
                                    configuration.actions,
                                    connected,
                                )
                            }
                            val state = executionStates[button.id] ?: ButtonExecutionState.Idle
                            val metricName = remember(resolution.action) {
                                resolution.action?.takeIf { it.type == "system_monitor" }
                                    ?.let(::systemMetricName)
                            }
                            LaunchedEffect(button.id, state) {
                                if (state == ButtonExecutionState.Succeeded) {
                                    delay(1400)
                                    onExecutionStateChanged(button.id, ButtonExecutionState.Idle)
                                }
                            }
                            DeckKeycap(
                                button = button,
                                logoAssetId = button.logoAssetId ?: resolution.action?.logoAssetId,
                                capability = resolution.capability,
                                executionState = state,
                                metricName = metricName,
                                actionType = resolution.action?.type,
                                modifier = Modifier.width(cardWidth).fillMaxHeight(),
                                onClick = {
                                    if (metricName == null) {
                                        onPress(button, resolution.action, resolution.capability)
                                    }
                                },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DeckKeycap(
    button: ButtonModel,
    logoAssetId: String?,
    capability: ActionCapability,
    executionState: ButtonExecutionState,
    metricName: String?,
    actionType: String?,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val indication = LocalIndication.current
    val pressed by interaction.collectIsPressedAsState()
    val lift by animateDpAsState(if (pressed) 1.dp else 0.dp, tween(70), label = "key-lift")
    val scale by animateFloatAsState(if (pressed) 0.982f else 1f, tween(80), label = "key-scale")
    val isMetric = metricName != null
    val accent = button.color?.let(::parseDeckColor)
        ?: if (isMetric) DeckPalette.cyan else DeckPalette.violet
    val foregroundAccent = when (executionState) {
        ButtonExecutionState.Running -> DeckPalette.cyan
        ButtonExecutionState.Succeeded -> DeckPalette.emerald
        ButtonExecutionState.Failed -> DeckPalette.rose
        ButtonExecutionState.Idle -> capabilityColor(capability)
    }
    val runningAlpha = if (executionState == ButtonExecutionState.Running) {
        RunningLedPulse()
    } else {
        1f
    }
    val shape = RoundedCornerShape(9.dp)
    val clickable = !isMetric && capability != ActionCapability.Disabled &&
        executionState != ButtonExecutionState.Running

    Box(
        modifier = modifier
            .fillMaxWidth()
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
                translationY = lift.toPx()
            }
            .shadow(if (pressed) 1.dp else 3.dp, shape, clip = false)
            .clip(shape)
            .background(
                Brush.verticalGradient(
                    listOf(Color(0xFF1C2331), DeckPalette.keycap, Color(0xFF10141D)),
                ),
            )
            .border(
                1.dp,
                (if (isMetric) DeckPalette.cyan else accent).copy(alpha = 0.25f),
                shape,
            )
            .then(
                if (capability == ActionCapability.Unassigned) {
                    Modifier.dashedKeyBorder(shape)
                } else {
                    Modifier.background(Color.Transparent, shape)
                },
            )
            .clickable(
                interactionSource = interaction,
                indication = indication,
                enabled = clickable,
                onClick = onClick,
            )
            .padding(horizontal = 7.dp, vertical = 6.dp),
    ) {
        Canvas(Modifier.fillMaxSize()) {
            if (pressed) {
                drawRoundRect(
                    color = Color.Black.copy(alpha = 0.22f),
                    topLeft = Offset(1.dp.toPx(), size.height * 0.13f),
                    size = Size(size.width - 2.dp.toPx(), size.height * 0.84f),
                    cornerRadius = CornerRadius(12.dp.toPx()),
                    style = Stroke(width = 1.dp.toPx()),
                )
            }
        }
        Row(
            modifier = Modifier.align(Alignment.TopStart).fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier
                    .size(5.dp)
                    .background(
                        foregroundAccent.copy(alpha = if (executionState == ButtonExecutionState.Running) runningAlpha else 1f),
                        CircleShape,
                    ),
            )
            Spacer(Modifier.weight(1f))
            if (executionState != ButtonExecutionState.Idle) {
                Text(
                    when (executionState) {
                        ButtonExecutionState.Running -> "RUN"
                        ButtonExecutionState.Succeeded -> "OK"
                        ButtonExecutionState.Failed -> "ERR"
                        ButtonExecutionState.Idle -> ""
                    },
                    color = foregroundAccent,
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.labelSmall.copy(fontSize = 8.sp),
                )
            } else if (isMetric) {
                Text(
                    "READ ONLY",
                    color = DeckPalette.cyan,
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.labelSmall.copy(fontSize = 8.sp),
                )
            }
        }
        Column(
            modifier = Modifier.align(Alignment.Center).fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            val displayIcon = when {
                isMetric && metricName.startsWith("Memory") -> Icons.Default.Memory
                isMetric -> Icons.Default.Speed
                else -> iconFor(button.icon) ?: iconForAction(actionType)
            }
            Box(Modifier.size(34.dp), contentAlignment = Alignment.Center) {
                displayIcon?.let {
                    Icon(it, contentDescription = null, tint = accent, modifier = Modifier.size(19.dp))
                }
                LogoAssetImage(
                    assetId = logoAssetId,
                    contentDescription = null,
                    modifier = Modifier.fillMaxSize(),
                )
            }
            Text(
                button.label,
                color = if (capability == ActionCapability.Disabled) DeckPalette.muted else DeckPalette.foreground,
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.SemiBold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center,
            )
            if (isMetric) {
                Text(
                    metricName.orEmpty(),
                    color = DeckPalette.muted,
                    style = MaterialTheme.typography.labelSmall.copy(fontSize = 9.sp),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center,
                )
            }
        }
        if (isMetric) {
            Text(
                "NO LIVE DATA",
                modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth(),
                color = DeckPalette.orange,
                fontFamily = FontFamily.Monospace,
                style = MaterialTheme.typography.labelSmall.copy(fontSize = 8.sp),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center,
            )
        }
    }
}

private fun Modifier.dashedKeyBorder(shape: RoundedCornerShape): Modifier =
    this.background(color = Color.Transparent, shape = shape).drawKeyDashedBorder()

private fun Modifier.drawKeyDashedBorder(): Modifier = this.then(
    Modifier.drawBehind {
        val stroke = 1.dp.toPx()
        drawRoundRect(
            color = DeckPalette.muted.copy(alpha = 0.6f),
            topLeft = Offset(stroke / 2, stroke / 2),
            size = Size(size.width - stroke, size.height - stroke),
            cornerRadius = CornerRadius(14.dp.toPx()),
            style = Stroke(
                width = stroke,
                pathEffect = PathEffect.dashPathEffect(floatArrayOf(7.dp.toPx(), 5.dp.toPx())),
            ),
        )
    },
)

@Composable
private fun ConnectionIndicator(
    status: String,
    connected: Boolean,
    onClick: () -> Unit,
) {
    val state = connectionDisplayState(status, connected)
    val color = when (state) {
        ConnectionDisplayState.Connected -> DeckPalette.emerald
        ConnectionDisplayState.Connecting,
        ConnectionDisplayState.Reconnecting -> DeckPalette.orange
        ConnectionDisplayState.Disconnected,
        ConnectionDisplayState.NeedsAttention -> DeckPalette.rose
    }
    val label = when (state) {
        ConnectionDisplayState.Connected -> "Connected"
        ConnectionDisplayState.Connecting -> "Connecting"
        ConnectionDisplayState.Reconnecting -> "Retrying"
        ConnectionDisplayState.Disconnected -> "Windows offline"
        ConnectionDisplayState.NeedsAttention -> "Needs attention"
    }
    Row(
        modifier = Modifier
            .clip(CircleShape)
            .clickable(onClick = onClick)
            .padding(horizontal = 6.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Box(Modifier.size(6.dp).background(color, CircleShape))
        Text(
            label,
            color = color,
            style = MaterialTheme.typography.labelSmall,
            maxLines = 1,
        )
        Icon(
            if (connected) Icons.Default.Public else Icons.Default.WifiOff,
            contentDescription = "Windows $label",
            tint = color,
            modifier = Modifier.size(14.dp),
        )
    }
}

@Composable
private fun RunningLedPulse(): Float {
    val transition = rememberInfiniteTransition(label = "execution-pulse")
    val alpha by transition.animateFloat(
        initialValue = 0.55f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            tween(1300, easing = FastOutSlowInEasing),
            repeatMode = androidx.compose.animation.core.RepeatMode.Reverse,
        ),
        label = "execution-led-pulse",
    )
    return alpha
}

@Composable
private fun PageArrow(
    image: ImageVector,
    description: String,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Surface(
        modifier = Modifier.size(36.dp),
        shape = RoundedCornerShape(12.dp),
        color = if (enabled) DeckPalette.surface else DeckPalette.surface.copy(alpha = 0.45f),
        border = BorderStroke(1.dp, DeckPalette.outline),
        onClick = onClick,
        enabled = enabled,
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(
                image,
                contentDescription = description,
                tint = if (enabled) DeckPalette.foreground else DeckPalette.muted.copy(alpha = 0.35f),
                modifier = Modifier.size(19.dp),
            )
        }
    }
}

@Composable
private fun EmptyDeckCanvas(
    modifier: Modifier,
    loading: Boolean,
    hasDeck: Boolean,
    onImport: () -> Unit,
) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(16.dp),
        color = DeckPalette.surface,
        border = BorderStroke(1.dp, DeckPalette.outline),
    ) {
        Column(
            modifier = Modifier.fillMaxSize().clickable(onClick = onImport).padding(18.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Icon(
                if (hasDeck) Icons.Default.Language else Icons.Default.Description,
                contentDescription = null,
                tint = DeckPalette.violet,
                modifier = Modifier.size(28.dp),
            )
            Spacer(Modifier.height(8.dp))
            Text(
                when {
                    loading -> "Loading cached deck"
                    hasDeck -> "No page selected"
                    else -> "Import a Windows deck"
                },
                color = DeckPalette.foreground,
                style = MaterialTheme.typography.titleSmall,
            )
            if (!loading && !hasDeck) {
                Text(
                    "Your deck appears here after import.",
                    color = DeckPalette.muted,
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        }
    }
}

@Composable
private fun EmptyPageCanvas() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text("This page has no buttons.", color = DeckPalette.muted, style = MaterialTheme.typography.bodySmall)
    }
}

internal fun responsiveDeckLayout(
    width: androidx.compose.ui.unit.Dp,
    height: androidx.compose.ui.unit.Dp,
    buttonCount: Int,
): DeckGridLayout {
    val count = buttonCount.coerceAtLeast(1)
    val maxColumns = ((width + DeckGridGap) / (DeckMinimumCardWidth + DeckGridGap))
        .toInt()
        .coerceIn(1, 5)
    fun fitLayout(availableHeight: androidx.compose.ui.unit.Dp): DeckGridLayout {
        val rowsThatFit = ((availableHeight + DeckGridGap) /
            (DeckMinimumCardHeight + DeckGridGap))
            .toInt()
            .coerceAtLeast(1)
        val minimumColumns = ((count + rowsThatFit - 1) / rowsThatFit)
            .coerceIn(1, maxColumns)
        val columns = (minimumColumns..maxColumns).minWithOrNull(
            compareBy<Int> { (count + it - 1) / it }
                .thenBy { if (count % it == 0) 0 else it - count % it },
        ) ?: maxColumns
        val rows = ((count + columns - 1) / columns).coerceAtMost(rowsThatFit)
        return DeckGridLayout(
            columns = columns,
            rows = rows,
            capacity = columns * rows,
            hasGroupControls = false,
        )
    }

    val initial = fitLayout(height)
    if (count <= initial.capacity) return initial
    val paged = fitLayout(height - DeckGroupControlsHeight - DeckGridGap)
    return paged.copy(hasGroupControls = true)
}

internal fun responsiveDeckCardSize(
    width: Dp,
    height: Dp,
    columns: Int,
    rows: Int,
    hasGroupControls: Boolean,
): DeckCardSize {
    val columnCount = columns.coerceAtLeast(1)
    val rowCount = rows.coerceAtLeast(1)
    val gridHeight = (
        height - if (hasGroupControls) DeckGroupControlsHeight + DeckGridGap else 0.dp
        ).coerceAtLeast(1.dp)
    val availableHeight = (
        (gridHeight - DeckGridGap * (rowCount - 1)) / rowCount
        ).coerceAtLeast(1.dp).coerceAtMost(DeckMaximumCardHeight)
    val availableWidth = (
        (width - DeckGridGap * (columnCount - 1)) / columnCount
        ).coerceAtLeast(1.dp).coerceAtMost(DeckMaximumCardWidth)
    val cardWidth = availableWidth.coerceAtMost(
        availableHeight * DeckCardMaximumWidthToHeight,
    )
    val cardHeight = availableHeight.coerceAtMost(
        cardWidth / DeckCardMinimumWidthToHeight,
    )
    return DeckCardSize(
        width = cardWidth.coerceAtMost(cardHeight * DeckCardMaximumWidthToHeight),
        height = cardHeight,
    )
}

private fun systemMetricName(action: ActionModel): String =
    when (action.parameters.get("metric")?.takeUnless { it.isJsonNull }?.asString) {
        "cpu_utilization" -> "CPU utilization"
        "memory_usage" -> "Memory usage"
        "gpu_utilization" -> "GPU utilization"
        "gpu_temperature" -> "GPU temperature"
        "cpu_temperature" -> "CPU temperature"
        else -> "System metric"
    }

private fun capabilityColor(capability: ActionCapability): Color = when (capability) {
    ActionCapability.Unassigned -> DeckPalette.muted
    ActionCapability.Disabled -> DeckPalette.rose
    ActionCapability.AndroidLocalOpenUrl,
    ActionCapability.WindowsHostConnected -> DeckPalette.emerald
    ActionCapability.WindowsHostDisconnected,
    ActionCapability.ReadOnlyWindowsWidgetDisconnected -> DeckPalette.orange
    is ActionCapability.Unsupported -> DeckPalette.rose
}

private fun parseDeckColor(value: String): Color = runCatching {
    Color(AndroidColor.parseColor(value))
}.getOrElse { DeckPalette.violet }

private fun iconFor(name: String?): ImageVector? = when (name?.lowercase()) {
    "globe", "web", "public", "website" -> Icons.Default.Public
    "document", "file", "description" -> Icons.Default.Description
    "play", "run" -> Icons.Default.PlayArrow
    "music", "music_note" -> Icons.Default.MusicNote
    "copy", "content_copy" -> Icons.Default.ContentCopy
    "save", "floppy", "floppy_disk" -> Icons.Default.Save
    "mic", "microphone" -> Icons.Default.Mic
    "chat", "discord", "message" -> Icons.AutoMirrored.Filled.Chat
    "video", "camera", "webcam", "youtube" -> Icons.Default.Videocam
    "settings" -> Icons.Default.Settings
    else -> null
}

private fun iconForAction(type: String?): ImageVector? = when (type) {
    "open_url" -> Icons.Default.Public
    "application" -> Icons.Default.Apps
    "system_control" -> Icons.Default.Settings
    "keyboard_shortcut" -> Icons.Default.Keyboard
    "run_command" -> Icons.Default.Terminal
    else -> null
}
