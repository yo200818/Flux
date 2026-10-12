package com.pocketdeck.android.ui

import androidx.compose.runtime.AbstractApplier
import androidx.compose.runtime.Composition
import androidx.compose.runtime.MonotonicFrameClock
import androidx.compose.runtime.Recomposer
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionJobDisposalTest {
    @Test
    fun replacingConnectionJobDoesNotDisposeTheNewJob() = runBlocking {
        val previousJob = Job()
        val newJob = Job()
        val currentJob = mutableStateOf<Job?>(previousJob)
        val newJobCompositionApplied = CompletableDeferred<Unit>()
        val recomposer = Recomposer(coroutineContext + ImmediateFrameClock)
        val composition = Composition(TestApplier(), recomposer)
        val recompositionRunner = launch(ImmediateFrameClock) {
            recomposer.runRecomposeAndApplyChanges()
        }

        composition.setContent {
            CancelConnectionJobOnDispose { currentJob.value }
            SideEffect {
                if (currentJob.value === newJob) {
                    newJobCompositionApplied.complete(Unit)
                }
            }
        }
        currentJob.value = newJob
        withTimeout(5_000) { newJobCompositionApplied.await() }

        assertTrue(newJob.isActive)
        composition.dispose()
        assertFalse(newJob.isActive)

        recomposer.cancel()
        recompositionRunner.cancelAndJoin()
    }

    private object ImmediateFrameClock : MonotonicFrameClock {
        override suspend fun <R> withFrameNanos(onFrame: (Long) -> R): R =
            onFrame(System.nanoTime())
    }

    private class TestApplier : AbstractApplier<Any>(Any()) {
        override fun insertTopDown(index: Int, instance: Any) = Unit

        override fun insertBottomUp(index: Int, instance: Any) = Unit

        override fun remove(index: Int, count: Int) = Unit

        override fun move(from: Int, to: Int, count: Int) = Unit

        override fun onClear() = Unit
    }
}
