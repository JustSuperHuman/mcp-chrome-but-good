/**
 * @fileoverview RunQueue interface definition
 * @description Defines the Run queue management interface
 */

import type { JsonObject, UnixMillis } from '../../domain/json';
import type { FlowId, NodeId, RunId } from '../../domain/ids';
import type { TriggerFireContext } from '../../domain/triggers';

/**
 * RunQueue config
 */
export interface RunQueueConfig {
  /** Maximum number of parallel Runs */
  maxParallelRuns: number;
  /** Lease TTL (ms) */
  leaseTtlMs: number;
  /** Heartbeat interval (ms) */
  heartbeatIntervalMs: number;
}

/**
 * Default queue config
 */
export const DEFAULT_QUEUE_CONFIG: RunQueueConfig = {
  maxParallelRuns: 3,
  leaseTtlMs: 15_000,
  heartbeatIntervalMs: 5_000,
};

/**
 * Queue item status
 */
export type QueueItemStatus = 'queued' | 'running' | 'paused';

/**
 * Lease info
 */
export interface Lease {
  /** Owner ID */
  ownerId: string;
  /** Expiry time */
  expiresAt: UnixMillis;
}

/**
 * RunQueue queue item
 */
export interface RunQueueItem {
  /** Run ID */
  id: RunId;
  /** Flow ID */
  flowId: FlowId;
  /** Status */
  status: QueueItemStatus;
  /** Creation time */
  createdAt: UnixMillis;
  /** Update time */
  updatedAt: UnixMillis;
  /** Priority (higher number = higher priority) */
  priority: number;
  /** Current attempt number */
  attempt: number;
  /** Maximum number of attempts */
  maxAttempts: number;
  /** Tab ID */
  tabId?: number;
  /** Run arguments */
  args?: JsonObject;
  /** Trigger context */
  trigger?: TriggerFireContext;
  /** Lease info */
  lease?: Lease;
  /** Debug configuration */
  debug?: { breakpoints?: NodeId[]; pauseOnStart?: boolean };
}

/**
 * Enqueue request (without the auto-generated fields)
 * - priority defaults to 0
 * - maxAttempts defaults to 1
 */
export type EnqueueInput = Omit<
  RunQueueItem,
  'status' | 'createdAt' | 'updatedAt' | 'attempt' | 'lease' | 'priority' | 'maxAttempts'
> & {
  id: RunId;
  /** Priority (higher number = higher priority, default 0) */
  priority?: number;
  /** Maximum number of attempts (default 1) */
  maxAttempts?: number;
};

/**
 * RunQueue interface
 * @description Manages queueing and scheduling of Runs
 */
export interface RunQueue {
  /**
   * Enqueue
   * @param input Enqueue request
   * @returns The queue item
   */
  enqueue(input: EnqueueInput): Promise<RunQueueItem>;

  /**
   * Claim the next runnable Run
   * @param ownerId Claimer ID
   * @param now Current time
   * @returns The queue item, or null
   */
  claimNext(ownerId: string, now: UnixMillis): Promise<RunQueueItem | null>;

  /**
   * Heartbeat lease renewal
   * @param ownerId Claimer ID
   * @param now Current time
   */
  heartbeat(ownerId: string, now: UnixMillis): Promise<void>;

  /**
   * Reclaim expired leases
   * @description Reclaims running/paused items with lease.expiresAt < now back to queued
   * @param now Current time
   * @returns IDs of the reclaimed Runs
   */
  reclaimExpiredLeases(now: UnixMillis): Promise<RunId[]>;

  /**
   * Recover orphaned leases (called after an SW restart)
   * @description
   * - Reclaims orphaned running items to queued (status -> queued, lease cleared)
   * - Adopts orphaned paused items (keeps status=paused, lease ownerId updated to the new ownerId)
   * @param ownerId The new ownerId (current Service Worker instance)
   * @param now Current time
   * @returns The affected runIds (with the previous ownerId, for auditing)
   */
  recoverOrphanLeases(
    ownerId: string,
    now: UnixMillis,
  ): Promise<{
    requeuedRunning: Array<{ runId: RunId; prevOwnerId?: string }>;
    adoptedPaused: Array<{ runId: RunId; prevOwnerId?: string }>;
  }>;

  /**
   * Mark as running
   */
  markRunning(runId: RunId, ownerId: string, now: UnixMillis): Promise<void>;

  /**
   * Mark as paused
   */
  markPaused(runId: RunId, ownerId: string, now: UnixMillis): Promise<void>;

  /**
   * Mark as done (removes it from the queue)
   */
  markDone(runId: RunId, now: UnixMillis): Promise<void>;

  /**
   * Cancel a Run
   */
  cancel(runId: RunId, now: UnixMillis, reason?: string): Promise<void>;

  /**
   * Get a queue item
   */
  get(runId: RunId): Promise<RunQueueItem | null>;

  /**
   * List queue items
   */
  list(status?: QueueItemStatus): Promise<RunQueueItem[]>;
}

/**
 * Create a NotImplemented RunQueue
 * @description Phase 0 placeholder implementation
 */
export function createNotImplementedQueue(): RunQueue {
  const notImplemented = () => {
    throw new Error('RunQueue not implemented');
  };

  return {
    enqueue: async () => notImplemented(),
    claimNext: async () => notImplemented(),
    heartbeat: async () => notImplemented(),
    reclaimExpiredLeases: async () => notImplemented(),
    recoverOrphanLeases: async () => notImplemented(),
    markRunning: async () => notImplemented(),
    markPaused: async () => notImplemented(),
    markDone: async () => notImplemented(),
    cancel: async () => notImplemented(),
    get: async () => notImplemented(),
    list: async () => notImplemented(),
  };
}
