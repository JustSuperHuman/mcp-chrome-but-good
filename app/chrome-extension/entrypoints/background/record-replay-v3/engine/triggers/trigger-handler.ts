/**
 * @fileoverview Trigger handler interface definition
 * @description Defines the common interface for all trigger kinds
 */

import type { TriggerSpec, TriggerKind } from '../../domain/triggers';

/**
 * Trigger handler interface
 * @description Every trigger kind must implement this interface
 */
export interface TriggerHandler<K extends TriggerKind = TriggerKind> {
  /** Trigger kind */
  readonly kind: K;

  /**
   * Install a trigger
   * @description Registers chrome API listeners, etc.
   * @param trigger Trigger spec
   */
  install(trigger: Extract<TriggerSpec, { kind: K }>): Promise<void>;

  /**
   * Uninstall a trigger
   * @description Removes chrome API listeners, etc.
   * @param triggerId Trigger ID
   */
  uninstall(triggerId: string): Promise<void>;

  /**
   * Uninstall all triggers
   * @description Cleans up all triggers of this kind
   */
  uninstallAll(): Promise<void>;

  /**
   * Get the IDs of installed triggers
   */
  getInstalledIds(): string[];
}

/**
 * Trigger fire callback
 * @description Callback that TriggerManager injects into each Handler
 */
export interface TriggerFireCallback {
  /**
   * Called when a trigger fires
   * @param triggerId Trigger ID
   * @param context Fire context
   */
  onFire(
    triggerId: string,
    context: {
      sourceTabId?: number;
      sourceUrl?: string;
    },
  ): Promise<void>;
}

/**
 * Trigger handler factory
 */
export type TriggerHandlerFactory<K extends TriggerKind> = (
  fireCallback: TriggerFireCallback,
) => TriggerHandler<K>;
