import { describe, it, expect } from 'vitest';
import { EventBus } from './EventBus.js';
import { defineEvent } from './EventDeclaration.js';

describe('EventBus', () => {
  it('delivers an emitted event to a subscribed handler', async () => {
    const bus = new EventBus();
    const pinged = defineEvent<{ message: string }>('pinged');
    const received: string[] = [];

    bus.on(pinged, (event) => {
      received.push(event.message);
    });
    // on()'s PubSub subscription is set up on a forked fiber, not
    // synchronously with on() itself — give it a tick before emitting so
    // this test isn't racing the subscription against the publish.
    await new Promise((resolve) => setTimeout(resolve, 0));
    bus.emit(pinged, { message: 'hello' });

    // The handler itself also runs on a forked fiber, not synchronously with emit().
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toEqual(['hello']);
  });

  it('does not deliver events to a handler after it unsubscribes', async () => {
    const bus = new EventBus();
    const pinged = defineEvent<{ message: string }>('pinged');
    const received: string[] = [];

    const unsubscribe = bus.on(pinged, (event) => {
      received.push(event.message);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    unsubscribe();
    bus.emit(pinged, { message: 'should not arrive' });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toEqual([]);
  });
});
