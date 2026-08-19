import EventEmitter from 'eventemitter3';
import type { MissionEvent, MissionEventData } from './MissionEvents';

/**
 * Handle for subscribing to mission events and awaiting completion
 *
 * The MissionHandle provides:
 * - Event subscription via on()/once()
 * - Completion awaiting via the completion promise
 * - Cancellation via cancel()
 */
export interface IMissionHandle {
  /** Unique identifier for this mission run */
  readonly id: string;

  /** Mission name being executed */
  readonly missionName: string;

  /** Whether the mission has been cancelled */
  readonly isCancelled: boolean;

  /**
   * Subscribe to a specific event type
   */
  on<T extends MissionEvent['type']>(
    event: T,
    listener: (data: MissionEventData<T>) => void
  ): this;

  /**
   * Subscribe to an event once
   */
  once<T extends MissionEvent['type']>(
    event: T,
    listener: (data: MissionEventData<T>) => void
  ): this;

  /**
   * Unsubscribe from an event
   */
  off<T extends MissionEvent['type']>(
    event: T,
    listener: (data: MissionEventData<T>) => void
  ): this;

  /**
   * Promise that resolves when mission completes or rejects on failure
   */
  readonly completion: Promise<void>;

  /**
   * Cancel the running mission
   */
  cancel(reason?: string): void;
}

/**
 * Default implementation of MissionHandle
 */
export class MissionHandle implements IMissionHandle {
  readonly id: string;
  readonly missionName: string;

  private readonly emitter = new EventEmitter();
  private readonly completionDeferred: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
  };
  private cancelled = false;
  private cancelReason?: string;

  constructor(id: string, missionName: string) {
    this.id = id;
    this.missionName = missionName;

    // Create deferred promise. The Promise executor runs synchronously, so
    // `state.resolve`/`state.reject` are always populated by the time it
    // returns — the `if (!...) throw` below documents that invariant
    // without a non-null assertion (Promise.withResolvers() would do this
    // natively, but isn't available under this repo's oldest configured
    // `lib` target — apps/cabinet's — since conductor's source is
    // type-checked directly against every consumer's own tsconfig).
    const state: { resolve?: () => void; reject?: (error: Error) => void } = {};
    const promise = new Promise<void>((res, rej) => {
      state.resolve = res;
      state.reject = rej;
    });
    if (!state.resolve || !state.reject) {
      throw new Error('Promise executor did not run synchronously');
    }
    this.completionDeferred = { promise, resolve: state.resolve, reject: state.reject };

    // Prevent unhandled rejection when nobody awaits completion
    // (callers who DO await will still receive the error)
    // oxlint-disable-next-line no-empty-function
    promise.catch(() => {});
  }

  on<T extends MissionEvent['type']>(
    event: T,
    listener: (data: MissionEventData<T>) => void
  ): this {
    this.emitter.on(event, listener);
    return this;
  }

  once<T extends MissionEvent['type']>(
    event: T,
    listener: (data: MissionEventData<T>) => void
  ): this {
    this.emitter.once(event, listener);
    return this;
  }

  off<T extends MissionEvent['type']>(
    event: T,
    listener: (data: MissionEventData<T>) => void
  ): this {
    this.emitter.off(event, listener);
    return this;
  }

  get completion(): Promise<void> {
    return this.completionDeferred.promise;
  }

  cancel(reason?: string): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.cancelReason = reason;

    this.emit({
      type: 'cancelled',
      reason,
      timestamp: Date.now(),
    });
  }

  /**
   * Emit an event (called by the runner)
   * @internal
   */
  emit(event: MissionEvent): void {
    // Emit both the specific event type and a generic 'event' for catch-all subscribers
    this.emitter.emit(event.type, event);
    this.emitter.emit('event', event);

    // Handle completion/failure
    if (event.type === 'completed') {
      this.completionDeferred.resolve();
    } else if (event.type === 'failed') {
      this.completionDeferred.reject(event.error);
    } else if (event.type === 'cancelled') {
      this.completionDeferred.reject(
        new Error(`Mission cancelled: ${this.cancelReason || 'no reason given'}`)
      );
    }
  }

  /**
   * Check if mission was cancelled
   * @internal
   */
  get isCancelled(): boolean {
    return this.cancelled;
  }
}
