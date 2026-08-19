import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ListHeader from './ListHeader.vue';

describe('ListHeader', () => {
  it('renders slot content as title', () => {
    const wrapper = mount(ListHeader, {
      slots: {
        default: 'Test Title'
      }
    });

    expect(wrapper.find('h3').text()).toBe('Test Title');
  });

  it('renders complex slot content', () => {
    const wrapper = mount(ListHeader, {
      slots: {
        default: 'Open Questions <span class="count">(5)</span>'
      }
    });

    expect(wrapper.find('h3').text()).toContain('Open Questions');
    expect(wrapper.find('h3').text()).toContain('(5)');
  });

  it('shows Refresh when not loading', () => {
    const wrapper = mount(ListHeader, {
      props: { loading: false },
      slots: { default: 'Title' }
    });

    expect(wrapper.find('.refresh-btn').text()).toBe('Refresh');
  });

  it('shows Loading... when loading', () => {
    const wrapper = mount(ListHeader, {
      props: { loading: true },
      slots: { default: 'Title' }
    });

    expect(wrapper.find('.refresh-btn').text()).toBe('Loading...');
  });

  it('disables button when loading', () => {
    const wrapper = mount(ListHeader, {
      props: { loading: true },
      slots: { default: 'Title' }
    });

    const button = wrapper.find('.refresh-btn');
    expect(button.attributes('disabled')).toBeDefined();
  });

  it('enables button when not loading', () => {
    const wrapper = mount(ListHeader, {
      props: { loading: false },
      slots: { default: 'Title' }
    });

    const button = wrapper.find('.refresh-btn');
    expect(button.attributes('disabled')).toBeUndefined();
  });

  it('emits refresh event when button clicked', async () => {
    const wrapper = mount(ListHeader, {
      props: { loading: false },
      slots: { default: 'Title' }
    });

    await wrapper.find('.refresh-btn').trigger('click');

    const refreshEvents = wrapper.emitted('refresh');
    expect(refreshEvents).toBeTruthy();
    expect(refreshEvents?.length).toBe(1);
  });

  it('does not emit refresh when button is disabled', async () => {
    const wrapper = mount(ListHeader, {
      props: { loading: true },
      slots: { default: 'Title' }
    });

    await wrapper.find('.refresh-btn').trigger('click');

    // Button is disabled, so native click should be prevented
    // The component still emits, but UI prevents the action
    // (disabled buttons don't typically trigger clicks in real browsers)
    expect(wrapper.emitted('refresh')).toBeFalsy();
  });

  it('defaults loading to false', () => {
    const wrapper = mount(ListHeader, {
      slots: { default: 'Title' }
    });

    expect(wrapper.find('.refresh-btn').text()).toBe('Refresh');
    expect(wrapper.find('.refresh-btn').attributes('disabled')).toBeUndefined();
  });
});
