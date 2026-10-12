package com.pocketdeck.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.pocketdeck.android.actions.AndroidLocalActionRegistry
import com.pocketdeck.android.config.AssetConfigurationSchemaSource
import com.pocketdeck.android.config.PocketDeckConfigurationCodec
import com.pocketdeck.android.storage.AndroidAtomicTextStorage
import com.pocketdeck.android.storage.AtomicMigrationNamespaceSource
import com.pocketdeck.android.storage.LocalDeckRepository
import com.pocketdeck.android.ui.PocketDeckApp
import com.pocketdeck.android.ui.PocketDeckTheme

class MainActivity : ComponentActivity() {
    private lateinit var repository: LocalDeckRepository
    private val localActionRegistry = AndroidLocalActionRegistry()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val codec = PocketDeckConfigurationCodec(AssetConfigurationSchemaSource(assets))
        repository = LocalDeckRepository(
            snapshotStorage = AndroidAtomicTextStorage(this, "deck-snapshot.json"),
            namespaceSource = AtomicMigrationNamespaceSource(
                AndroidAtomicTextStorage(this, "migration-namespace.txt"),
            ),
            codec = codec,
        )
        setContent {
            PocketDeckTheme {
                PocketDeckApp(
                    repository = repository,
                    localActionRegistry = localActionRegistry,
                )
            }
        }
    }
}
