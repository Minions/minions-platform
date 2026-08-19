import { describe, it, expect, vi } from 'vitest';
import { runDetached } from './runDetached.js';

describe('runDetached', () => {
  it('does not run fn synchronously', () => {
    const fn = vi.fn();
    runDetached(fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it('runs fn after the current call stack unwinds', async () => {
    const order: string[] = [];
    runDetached(() => {
      order.push('detached');
    });
    order.push('sync-caller');
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['sync-caller', 'detached']);
  });

  it('does not propagate a rejection to the caller', () => {
    expect(() => runDetached(() => Promise.reject(new Error('boom')), vi.fn())).not.toThrow();
  });

  it('does not propagate a synchronous throw to the caller', () => {
    expect(() =>
      runDetached(() => {
        throw new Error('boom');
      }, vi.fn())
    ).not.toThrow();
  });

  it('reports an async rejection to onError', async () => {
    const onError = vi.fn();
    runDetached(() => Promise.reject(new Error('boom')), onError);
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it('reports a synchronous throw to onError', async () => {
    const onError = vi.fn();
    runDetached(() => {
      throw new Error('sync boom');
    }, onError);
    await Promise.resolve();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('defaults to logging via console.error when onError is omitted', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    runDetached(() => Promise.reject(new Error('boom')));
    await Promise.resolve();
    await Promise.resolve();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('never produces an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    runDetached(() => Promise.reject(new Error('boom')), vi.fn());
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
