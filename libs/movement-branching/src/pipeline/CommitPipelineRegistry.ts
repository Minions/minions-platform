import type { Detector, HandlerRegistration, HookPoint, Recognizer } from './types.js';

/**
 * Open-ended registry of Detector/Recognizer registrations against hook
 * points. Anyone can add a handler by calling register() — the pipeline core
 * (runCommitPipeline) never needs to change to pick it up.
 */
export class PipelineRegistry {
  private readonly registrations: HandlerRegistration[] = [];

  register(registration: HandlerRegistration): void {
    this.registrations.push(registration);
  }

  registerDetector(
    detector: Detector,
    opts: { hookPoints: string[] | ((hp: HookPoint) => boolean); mandatory: boolean; appliesWhen?: (ctx: import('./types.js').PipelineContext) => boolean; priority?: number },
  ): void {
    this.register({ handler: detector, ...opts });
  }

  registerRecognizer(
    recognizer: Recognizer,
    opts: { hookPoints: string[] | ((hp: HookPoint) => boolean); mandatory: boolean; appliesWhen?: (ctx: import('./types.js').PipelineContext) => boolean; priority?: number },
  ): void {
    this.register({ handler: recognizer, ...opts });
  }

  private appliesToHookPoint(registration: HandlerRegistration, hookPoint: HookPoint): boolean {
    return typeof registration.hookPoints === 'function'
      ? registration.hookPoints(hookPoint)
      : registration.hookPoints.includes(hookPoint.id);
  }

  registrationsFor(hookPoint: HookPoint): HandlerRegistration[] {
    return this.registrations.filter((r) => this.appliesToHookPoint(r, hookPoint));
  }

  /** Returns a new registry seeded with this one's registrations plus more — never mutates the original. */
  extend(...more: HandlerRegistration[]): PipelineRegistry {
    const clone = new PipelineRegistry();
    for (const r of this.registrations) clone.register(r);
    for (const r of more) clone.register(r);
    return clone;
  }
}
