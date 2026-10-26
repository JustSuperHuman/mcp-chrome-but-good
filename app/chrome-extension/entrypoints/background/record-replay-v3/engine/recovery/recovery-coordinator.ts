/**
 * @fileoverview Crash recovery coordinator (P3-06)
 * @description
 * An MV3 Service Worker can be terminated at any time. On SW startup this coordinator reconciles queue state with Run records
 * so interrupted Runs can resume.
 *
 * Recovery strategy:
 * - Orphaned running items: reclaimed to queued to wait for rescheduling (rerun from the start)
 * - Orphaned paused items: lease adopted, stay paused
 * - Queue leftovers of terminal Runs: cleaned up
 *
 * When to call:
 * - Must be called before scheduler.start()
 * - Usually called once on SW startup
 */

import type { UnixMillis } from '../../domain/json';
import type { RunId } from '../../domain/ids';
import { isTerminalStatus, type RunStatus } from '../../domain/events';
import type { StoragePort } from '../storage/storage-port';
import type { EventsBus } from '../transport/events-bus';

// ==================== Types ====================

/**
 * Recovery result
 */
export interface RecoveryResult {
  /** IDs of running Runs reclaimed to queued */
  requeuedRunning: RunId[];
  /** IDs of adopted paused Runs */
  adoptedPaused: RunId[];
  /** IDs of cleaned-up terminal Runs */
  cleanedTerminal: RunId[];
}

/**
 * Recovery coordinator dependencies
 */
export interface RecoveryCoordinatorDeps {
  /** Storage layer */
  storage: StoragePort;
  /** Event bus */
  events: EventsBus;
  /** ownerId of the current Service Worker */
  ownerId: string;
  /** Time source */
  now: () => UnixMillis;
  /** Logger */
  logger?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
}

// ==================== Main Function ====================

/**
 * Perform crash recovery
 * @description
 * Called on SW startup to reconcile queue state with Run records.
 *
 * Order:
 * 1. Pre-clean: check every queue item and clean up leftovers that are terminal or have no matching RunRecord
 * 2. Recover orphaned leases: reclaim running, adopt paused
 * 3. Sync RunRecord status: make sure RunRecords match the queue state
 * 4. Emit recovery events: emit run.recovered for requeued running items
 */
export async function recoverFromCrash(deps: RecoveryCoordinatorDeps): Promise<RecoveryResult> {
  const logger = deps.logger ?? console;

  if (!deps.ownerId) {
    throw new Error('ownerId is required');
  }

  const now = deps.now();

  // Rationale: recovery must "clean up first, then adopt/reclaim", otherwise a Run that already reached a terminal state could be requeued
  const cleanedTerminalSet = new Set<RunId>();

  // ==================== Step 1: Pre-clean ====================
  // Check every queue item and clean up leftovers that are terminal or have no matching RunRecord
  try {
    const items = await deps.storage.queue.list();
    for (const item of items) {
      const runId = item.id;
      const run = await deps.storage.runs.get(runId);

      // Defensive cleanup: a queue item with no RunRecord can't be executed
      if (!run) {
        try {
          await deps.storage.queue.markDone(runId, now);
          cleanedTerminalSet.add(runId);
          logger.debug(`[Recovery] Cleaned orphan queue item without RunRecord: ${runId}`);
        } catch (e) {
          logger.warn('[Recovery] markDone for missing RunRecord failed:', runId, e);
        }
        continue;
      }

      // Clean up terminal Runs (the SW may crash after the runner finishes but before scheduler markDone)
      if (isTerminalStatus(run.status)) {
        try {
          await deps.storage.queue.markDone(runId, now);
          cleanedTerminalSet.add(runId);
          logger.debug(`[Recovery] Cleaned terminal queue item: ${runId} (status=${run.status})`);
        } catch (e) {
          logger.warn('[Recovery] markDone for terminal run failed:', runId, e);
        }
      }
    }
  } catch (e) {
    logger.warn('[Recovery] Pre-clean failed:', e);
  }

  // ==================== Step 2: Recover orphaned leases ====================
  // Best-effort: a failure here should not block startup
  let requeuedRunning: Array<{ runId: RunId; prevOwnerId?: string }> = [];
  let adoptedPaused: Array<{ runId: RunId; prevOwnerId?: string }> = [];
  try {
    const result = await deps.storage.queue.recoverOrphanLeases(deps.ownerId, now);
    requeuedRunning = result.requeuedRunning;
    adoptedPaused = result.adoptedPaused;
  } catch (e) {
    logger.error('[Recovery] recoverOrphanLeases failed:', e);
    // Keep going, don't block startup
  }

  // ==================== Step 3: Sync RunRecord status ====================
  const requeuedRunningIds: RunId[] = [];
  for (const entry of requeuedRunning) {
    const runId = entry.runId;
    requeuedRunningIds.push(runId);

    // Skip items already cleaned up in Step 1
    if (cleanedTerminalSet.has(runId)) {
      continue;
    }

    try {
      const run = await deps.storage.runs.get(runId);
      if (!run) {
        // RunRecord missing, clean up the queue item (defensive)
        try {
          await deps.storage.queue.markDone(runId, now);
          cleanedTerminalSet.add(runId);
        } catch (markDoneErr) {
          logger.warn(
            '[Recovery] markDone for missing RunRecord in Step3 failed:',
            runId,
            markDoneErr,
          );
        }
        continue;
      }

      // Skip terminal Runs (they may have been updated by other logic during recovery)
      // and clean up their queue items so nothing is left behind
      if (isTerminalStatus(run.status)) {
        try {
          await deps.storage.queue.markDone(runId, now);
          cleanedTerminalSet.add(runId);
          logger.debug(
            `[Recovery] Cleaned terminal queue item in Step3: ${runId} (status=${run.status})`,
          );
        } catch (markDoneErr) {
          logger.warn('[Recovery] markDone for terminal run in Step3 failed:', runId, markDoneErr);
        }
        continue;
      }

      // Update the RunRecord status to queued
      await deps.storage.runs.patch(runId, { status: 'queued', updatedAt: now });

      // Emit the recovery event (best-effort, failure doesn't affect recovery)
      try {
        const fromStatus: 'running' | 'paused' = run.status === 'paused' ? 'paused' : 'running';
        await deps.events.append({
          runId,
          type: 'run.recovered',
          reason: 'sw_restart',
          fromStatus,
          toStatus: 'queued',
          prevOwnerId: entry.prevOwnerId,
          ts: now,
        });
        logger.info(`[Recovery] Requeued orphan running run: ${runId} (from=${fromStatus})`);
      } catch (eventErr) {
        logger.warn('[Recovery] Failed to emit run.recovered event:', runId, eventErr);
        // Keep going, doesn't affect recovery
      }
    } catch (e) {
      logger.warn('[Recovery] Reconcile requeued running failed:', runId, e);
    }
  }

  // ==================== Step 4: Sync RunRecords of adopted paused items ====================
  const adoptedPausedIds: RunId[] = [];
  for (const entry of adoptedPaused) {
    const runId = entry.runId;
    adoptedPausedIds.push(runId);

    // Skip items already cleaned up in Step 1
    if (cleanedTerminalSet.has(runId)) {
      continue;
    }

    try {
      const run = await deps.storage.runs.get(runId);
      if (!run) {
        // RunRecord missing, clean up the queue item (defensive)
        try {
          await deps.storage.queue.markDone(runId, now);
          cleanedTerminalSet.add(runId);
        } catch (markDoneErr) {
          logger.warn(
            '[Recovery] markDone for missing RunRecord in Step4 failed:',
            runId,
            markDoneErr,
          );
        }
        continue;
      }

      // Skip terminal Runs and clean up their queue items
      if (isTerminalStatus(run.status)) {
        try {
          await deps.storage.queue.markDone(runId, now);
          cleanedTerminalSet.add(runId);
          logger.debug(
            `[Recovery] Cleaned terminal queue item in Step4: ${runId} (status=${run.status})`,
          );
        } catch (markDoneErr) {
          logger.warn('[Recovery] markDone for terminal run in Step4 failed:', runId, markDoneErr);
        }
        continue;
      }

      // If the RunRecord status is not paused, sync it
      if (run.status !== 'paused') {
        await deps.storage.runs.patch(runId, { status: 'paused' as RunStatus, updatedAt: now });
      }

      logger.info(`[Recovery] Adopted orphan paused run: ${runId}`);
    } catch (e) {
      logger.warn('[Recovery] Reconcile adopted paused failed:', runId, e);
    }
  }

  const result: RecoveryResult = {
    requeuedRunning: requeuedRunningIds,
    adoptedPaused: adoptedPausedIds,
    cleanedTerminal: Array.from(cleanedTerminalSet),
  };

  logger.info('[Recovery] Complete:', {
    requeuedRunning: result.requeuedRunning.length,
    adoptedPaused: result.adoptedPaused.length,
    cleanedTerminal: result.cleanedTerminal.length,
  });

  return result;
}
