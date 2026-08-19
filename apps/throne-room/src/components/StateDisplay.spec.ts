import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import StateDisplay from './StateDisplay.vue';

describe('StateDisplay', () => {
  describe('loading state', () => {
    it('shows default loading text when loading=true', () => {
      const wrapper = mount(StateDisplay, {
        props: { loading: true },
      });
      expect(wrapper.text()).toContain('Loading...');
      expect(wrapper.find('.loading').exists()).toBe(true);
    });

    it('shows custom loading text when provided', () => {
      const wrapper = mount(StateDisplay, {
        props: { loading: true, loadingText: 'Waking up the lair...' },
      });
      expect(wrapper.text()).toContain('Waking up the lair...');
    });

    it('uses loading slot when provided', () => {
      const wrapper = mount(StateDisplay, {
        props: { loading: true },
        slots: { loading: '<span class="custom-loading">Custom Loading</span>' },
      });
      expect(wrapper.find('.custom-loading').exists()).toBe(true);
      expect(wrapper.text()).toContain('Custom Loading');
    });
  });

  describe('error state', () => {
    it('shows error message when error is provided', () => {
      const wrapper = mount(StateDisplay, {
        props: { error: 'Something went wrong' },
      });
      expect(wrapper.text()).toContain('Something went wrong');
      expect(wrapper.find('.error').exists()).toBe(true);
    });

    it('uses error slot when provided', () => {
      const wrapper = mount(StateDisplay, {
        props: { error: 'Network error' },
        slots: { error: '<div class="custom-error">Error: {{ params.error }}</div>' },
      });
      expect(wrapper.find('.custom-error').exists()).toBe(true);
    });

    it('does not show error state when error is null', () => {
      const wrapper = mount(StateDisplay, {
        props: { error: null },
        slots: { default: '<div class="content">Main content</div>' },
      });
      expect(wrapper.find('.error').exists()).toBe(false);
      expect(wrapper.find('.content').exists()).toBe(true);
    });
  });

  describe('empty state', () => {
    it('shows default empty message when empty=true', () => {
      const wrapper = mount(StateDisplay, {
        props: { empty: true },
      });
      expect(wrapper.text()).toContain('No items');
      expect(wrapper.find('.empty').exists()).toBe(true);
    });

    it('shows custom empty text when provided', () => {
      const wrapper = mount(StateDisplay, {
        props: { empty: true, emptyText: 'Your lair is empty' },
      });
      expect(wrapper.text()).toContain('Your lair is empty');
    });

    it('uses empty slot when provided', () => {
      const wrapper = mount(StateDisplay, {
        props: { empty: true },
        slots: { empty: '<div class="custom-empty"><p>No data</p><p>Add some</p></div>' },
      });
      expect(wrapper.find('.custom-empty').exists()).toBe(true);
    });
  });

  describe('default state', () => {
    it('shows default slot content when not loading, no error, not empty', () => {
      const wrapper = mount(StateDisplay, {
        props: {},
        slots: { default: '<div class="main-content">Hello World</div>' },
      });
      expect(wrapper.find('.main-content').exists()).toBe(true);
      expect(wrapper.text()).toContain('Hello World');
    });
  });

  describe('state priority', () => {
    it('loading takes priority over error', () => {
      const wrapper = mount(StateDisplay, {
        props: { loading: true, error: 'Some error' },
      });
      expect(wrapper.find('.loading').exists()).toBe(true);
      expect(wrapper.find('.error').exists()).toBe(false);
    });

    it('error takes priority over empty', () => {
      const wrapper = mount(StateDisplay, {
        props: { error: 'Some error', empty: true },
      });
      expect(wrapper.find('.error').exists()).toBe(true);
      expect(wrapper.find('.empty').exists()).toBe(false);
    });

    it('loading takes priority over empty', () => {
      const wrapper = mount(StateDisplay, {
        props: { loading: true, empty: true },
      });
      expect(wrapper.find('.loading').exists()).toBe(true);
      expect(wrapper.find('.empty').exists()).toBe(false);
    });
  });
});
