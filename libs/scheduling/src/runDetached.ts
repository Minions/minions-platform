export type ErrorHandler = (error: unknown) => void;

export const defaultOnError: ErrorHandler = (error) => {
  console.error('[scheduling] runDetached: unhandled error', error);
};

/**
 * Runs `fn` after the current call stack unwinds, fully decoupled from the
 * caller's own return/throw. A rejection (or sync throw) from `fn` is
 * reported to `onError`, never surfaces as an unhandled rejection, and never
 * propagates back to the caller.
 */
export function runDetached(fn: () => void | Promise<void>, onError: ErrorHandler = defaultOnError): void {
  queueMicrotask(() => {
    try {
      Promise.resolve(fn()).catch(onError);
    } catch (error) {
      onError(error);
    }
  });
}
