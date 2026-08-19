import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import SecretaryStatus from './SecretaryStatus.vue';

describe('SecretaryStatus', () => {
  it('renders the component', () => {
    const wrapper = mount(SecretaryStatus);
    expect(wrapper.exists()).toBe(true);
  });

  it('displays "Code Execution Secretary" title', () => {
    const wrapper = mount(SecretaryStatus);
    expect(wrapper.text()).toContain('Code Execution Secretary');
  });

  it('displays inactive status by default', () => {
    const wrapper = mount(SecretaryStatus);
    expect(wrapper.text()).toContain('Status: Inactive');
  });

  it('shows inactive indicator when secretary is not active', () => {
    const wrapper = mount(SecretaryStatus, {
      props: {
        isActive: false
      }
    });
    expect(wrapper.text()).toContain('Inactive');
  });

  it('displays last activity timestamp when provided', () => {
    const timestamp = '2025-09-30T10:30:00Z';
    const wrapper = mount(SecretaryStatus, {
      props: {
        lastActivity: timestamp
      }
    });
    expect(wrapper.text()).toContain('Last Activity');
  });

  it('shows "Never" when no last activity timestamp is provided', () => {
    const wrapper = mount(SecretaryStatus, {
      props: {
        lastActivity: undefined
      }
    });
    expect(wrapper.text()).toContain('Never');
  });
});