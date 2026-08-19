import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import { useQualityStream } from './useQualityStream';

vi.mock('../api/cabinet', () => ({
  getCabinetUrl: () => 'http://cabinet.test',
}));

/** Minimal fake `EventSource` — just enough surface for the composable: constructor URL capture, event handler assignment, and `close()`. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }
}

function TestHost() {
  return defineComponent({
    setup() {
      const { payload, connected } = useQualityStream();
      return () => h('div', `${connected.value}:${JSON.stringify(payload.value)}`);
    },
  });
}

describe('useQualityStream', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('connects to the cabinet quality stream URL on mount', () => {
    mount(TestHost());

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe('http://cabinet.test/api/quality/stream');
  });

  it('updates payload from incoming messages', async () => {
    const wrapper = mount(TestHost());
    const source = FakeEventSource.instances[0];

    const incoming = { disabled: false, wings: { 'wing-a': {} } };
    source.onmessage?.({ data: JSON.stringify(incoming) } as MessageEvent<string>);
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('wing-a');
  });

  it('tracks connected state from open/error events', async () => {
    const wrapper = mount(TestHost());
    const source = FakeEventSource.instances[0];

    source.onopen?.();
    await wrapper.vm.$nextTick();
    expect(wrapper.text().startsWith('true:')).toBe(true);

    source.onerror?.();
    await wrapper.vm.$nextTick();
    expect(wrapper.text().startsWith('false:')).toBe(true);
  });

  it('closes the EventSource on unmount', () => {
    const wrapper = mount(TestHost());
    const source = FakeEventSource.instances[0];

    wrapper.unmount();

    expect(source.closed).toBe(true);
  });
});
