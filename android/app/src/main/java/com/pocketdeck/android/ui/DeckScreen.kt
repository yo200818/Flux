package com.pocketdeck.android.ui

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
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Public
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.WifiOff
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
import androidx.compose.runtime.mutableStateOf
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.pocketdeck.android.actions.ActionCapability
import com.pocketdeck.android.actions.ActionCapabilityResolver
import com.pocketdeck.android.config.ActionModel
import com.pocketdeck.android.config.ButtonModel
import com.pocketdeck.android.config.DeviceDeckSelection
import com.pocketdeck.android.config.PageModel
import com.pocketdeck.android.config.PocketDeckConfiguration
import com.pocketdeck.android.navigation.DeckSelectionNavigator
import com.pocketdeck.android.storage.StoredDeck
import kotlinx.coroutines.delay

internal enum class ButtonExecutionState {
    Idle,
    Running,
    Succeeded,
    Failed,
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

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(DeckPalette.background)
            .padding(horizontal = 18.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().height(56.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Box {
                Row(
                    modifier = Modifier
                        .clip(RoundedCornerShape(10.dp))
                        .clickable(enabled = configuration?.profiles?.isNotEmpty() == true) {
                            profileMenuExpanded = true
                        }
                        .padding(horizontal = 10.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Surface(
                        modifier = Modifier.size(25.dp),
                        shape = RoundedCornerShape(7.dp),
                        color = DeckPalette.violet.copy(alpha = 0.18f),
                        border = BorderStroke(1.dp, DeckPalette.violet.copy(alpha = 0.55f)),
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            Text("P", color = DeckPalette.violet, fontWeight = FontWeight.Bold)
                        }
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(0.dp)) {
                        Text(
                            configuration?.deck?.name ?: "PocketDeck",
                            color = DeckPalette.foreground,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.titleSmall,
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
                    expanded = profileMenuExpanded,
                    onDismissRequest = { profileMenuExpanded = false },
                ) {
                    configuration?.profiles?.forEach { item ->
                        DropdownMenuItem(
                            text = { Text(item.name) },
                            onClick = {
                                profileMenuExpanded = false
                                onSelectProfile(item.id)
                            },
                        )
                    }
                }
            }

            Spacer(Modifier.width(4.dp))
            Box {
                Row(
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .clickable(enabled = profile?.pages?.isNotEmpty() == true) {
                            pageMenuExpanded = true
                        }
                        .padding(horizontal = 9.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(7.dp),
                ) {
                    Text(
                        page?.name ?: "Select page",
                        color = DeckPalette.foreground,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.labelLarge,
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
                    expanded = pageMenuExpanded,
                    onDismissRequest = { pageMenuExpanded = false },
                ) {
                    profile?.pages?.forEach { item ->
                        DropdownMenuItem(
                            text = { Text(item.name) },
                            onClick = {
                                pageMenuExpanded = false
                                onSelectPage(item.id)
                            },
                        )
                    }
                }
            }

            Spacer(Modifier.weight(1f))
            Row(
                modifier = Modifier
                    .clip(CircleShape)
                    .clickable(onClick = onOpenConnection)
                    .padding(horizontal = 10.dp, vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                Box(
                    Modifier
                        .size(7.dp)
                        .background(
                            if (connected) DeckPalette.emerald else DeckPalette.orange,
                            CircleShape,
                        ),
                )
                Text(
                    if (connected) "Windows connected" else "Windows offline",
                    color = if (connected) DeckPalette.emerald else DeckPalette.orange,
                    style = MaterialTheme.typography.labelSmall,
                )
                Icon(
                    if (connected) Icons.Default.Public else Icons.Default.WifiOff,
                    contentDescription = if (connected) "Windows connected" else "Windows offline",
                    tint = if (connected) DeckPalette.emerald else DeckPalette.orange,
                    modifier = Modifier.size(15.dp),
                )
            }
            IconButton(
                onClick = onOpenConnection,
                modifier = Modifier.size(38.dp),
            ) {
                Icon(
                    Icons.Default.Settings,
                    contentDescription = "Connection settings",
                    tint = DeckPalette.muted,
                )
            }
        }

        errorMessage?.let { message ->
            Text(
                message,
                color = DeckPalette.rose,
                style = MaterialTheme.typography.labelSmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp),
            )
        }

        Row(
            modifier = Modifier.fillMaxWidth().weight(1f),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
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
                    val columns = responsiveDeckColumns(maxWidth, maxHeight)
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
                                columns = columns,
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
            modifier = Modifier.fillMaxWidth().height(28.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val assignedCount = page?.buttons?.count { it.actionId != null } ?: 0
            Text(
                page?.let { "${it.buttons.size} BUTTONS  ·  $assignedCount ASSIGNED" } ?: "DECK NOT LOADED",
                color = DeckPalette.muted,
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
            )
            Spacer(Modifier.weight(1f))
            Text(
                if (connected) "SYNCED WITH WINDOWS" else "CACHED ON DEVICE",
                color = if (connected) DeckPalette.emerald.copy(alpha = 0.85f) else DeckPalette.muted,
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
            )
            Spacer(Modifier.width(13.dp))
            Row(
                modifier = Modifier
                    .clip(RoundedCornerShape(7.dp))
                    .clickable(onClick = onImport)
                    .padding(horizontal = 9.dp, vertical = 5.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                Icon(Icons.Default.Description, contentDescription = null, tint = DeckPalette.muted, modifier = Modifier.size(14.dp))
                Text("IMPORT", color = DeckPalette.muted, style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}

@Composable
private fun ButtonGrid(
    page: PageModel,
    configuration: PocketDeckConfiguration,
    columns: Int,
    connected: Boolean,
    executionStates: Map<String, ButtonExecutionState>,
    onPress: (ButtonModel, ActionModel?, ActionCapability) -> Unit,
    onExecutionStateChanged: (String, ButtonExecutionState) -> Unit,
) {
    LazyVerticalGrid(
        columns = GridCells.Fixed(columns),
        modifier = Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(4.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        items(page.buttons, key = { it.id }) { button ->
            val resolution = remember(configuration.actions, button, connected) {
                ActionCapabilityResolver.resolveButton(button, configuration.actions, connected)
            }
            val state = executionStates[button.id] ?: ButtonExecutionState.Idle
            LaunchedEffect(button.id, state) {
                if (state == ButtonExecutionState.Succeeded) {
                    delay(1400)
                    onExecutionStateChanged(button.id, ButtonExecutionState.Idle)
                }
            }
            DeckKeycap(
                button = button,
                capability = resolution.capability,
                executionState = state,
                onClick = { onPress(button, resolution.action, resolution.capability) },
            )
        }
    }
}

@Composable
private fun DeckKeycap(
    button: ButtonModel,
    capability: ActionCapability,
    executionState: ButtonExecutionState,
    onClick: () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val indication = LocalIndication.current
    val pressed by interaction.collectIsPressedAsState()
    val lift by animateDpAsState(if (pressed) 1.dp else 0.dp, tween(70), label = "key-lift")
    val scale by animateFloatAsState(if (pressed) 0.982f else 1f, tween(80), label = "key-scale")
    val accent = button.color?.let(::parseDeckColor) ?: DeckPalette.violet
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
    val shape = RoundedCornerShape(15.dp)
    val clickable = capability != ActionCapability.Disabled &&
        executionState != ButtonExecutionState.Running

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .aspectRatio(1.22f)
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
                translationY = lift.toPx()
            }
            .shadow(if (pressed) 2.dp else 8.dp, shape, clip = false)
            .clip(shape)
            .background(
                Brush.verticalGradient(
                    listOf(Color(0xFF202635), DeckPalette.keycap, Color(0xFF121722)),
                ),
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
            .padding(horizontal = 9.dp, vertical = 8.dp),
    ) {
        Canvas(Modifier.fillMaxSize()) {
            drawRoundRect(
                color = Color.White.copy(alpha = if (pressed) 0.035f else 0.075f),
                topLeft = Offset(1.dp.toPx(), 1.dp.toPx()),
                size = Size(size.width - 2.dp.toPx(), size.height * 0.34f),
                cornerRadius = CornerRadius(14.dp.toPx()),
            )
            if (pressed) {
                drawRoundRect(
                    color = Color.Black.copy(alpha = 0.22f),
                    topLeft = Offset(1.dp.toPx(), size.height * 0.13f),
                    size = Size(size.width - 2.dp.toPx(), size.height * 0.84f),
                    cornerRadius = CornerRadius(14.dp.toPx()),
                    style = Stroke(width = 1.dp.toPx()),
                )
            }
            drawRoundRect(
                color = accent.copy(alpha = if (capability == ActionCapability.Unassigned) 0.1f else 0.22f),
                topLeft = Offset(0f, size.height - 3.dp.toPx()),
                size = Size(size.width, 3.dp.toPx()),
                cornerRadius = CornerRadius(2.dp.toPx()),
            )
        }
        Row(
            modifier = Modifier.align(Alignment.TopStart).fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier
                    .size(6.dp)
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
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        }
        Column(
            modifier = Modifier.align(Alignment.Center).fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            iconFor(button.icon)?.let {
                Icon(it, contentDescription = null, tint = accent, modifier = Modifier.size(24.dp))
            }
            Text(
                button.label,
                color = if (capability == ActionCapability.Disabled) DeckPalette.muted else DeckPalette.foreground,
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center,
            )
        }
        Text(
            executionLabel(executionState, capability),
            modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth(),
            color = if (executionState == ButtonExecutionState.Idle) DeckPalette.muted else foregroundAccent,
            fontFamily = FontFamily.Monospace,
            style = MaterialTheme.typography.labelSmall,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
        )
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
        modifier = Modifier.size(42.dp),
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
                    else -> "Import a PocketDeck configuration"
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

internal fun responsiveDeckColumns(width: androidx.compose.ui.unit.Dp, height: androidx.compose.ui.unit.Dp): Int =
    when {
        width >= 700.dp && height >= 210.dp -> 5
        width >= 560.dp && height >= 180.dp -> 4
        width >= 420.dp -> 3
        else -> 2
    }

private fun executionLabel(
    state: ButtonExecutionState,
    capability: ActionCapability,
): String = when (state) {
    ButtonExecutionState.Running -> "EXECUTING"
    ButtonExecutionState.Succeeded -> "CONFIRMED"
    ButtonExecutionState.Failed -> "FAILED"
    ButtonExecutionState.Idle -> when (capability) {
        ActionCapability.Unassigned -> "UNASSIGNED"
        ActionCapability.Disabled -> "DISABLED"
        ActionCapability.AndroidLocalOpenUrl -> "ON DEVICE"
        ActionCapability.WindowsHostDisconnected,
        ActionCapability.ReadOnlyWindowsWidgetDisconnected -> "WINDOWS OFFLINE"
        ActionCapability.WindowsHostConnected -> "WINDOWS READY"
        is ActionCapability.Unsupported -> "UNAVAILABLE"
    }
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
    "settings" -> Icons.Default.Settings
    else -> null
}
