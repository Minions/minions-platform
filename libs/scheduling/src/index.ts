/**
 * Scheduling
 *
 * Framework-agnostic scheduling primitives: detached fire-and-forget work,
 * per-key serializing queues, and jittered periodic jobs. Not specific to
 * any one subsystem.
 */

export { runDetached, defaultOnError, type ErrorHandler } from './runDetached.js';
export { KeyedQueue } from './KeyedQueue.js';
export { schedulePeriodic, type SchedulePeriodicOptions, type PeriodicHandle } from './schedulePeriodic.js';
