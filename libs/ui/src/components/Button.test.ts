import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import Button from './Button.vue';

describe('Button', () => {
  it('renders slot content', () => {
    const wrapper = mount(Button, {
      slots: { default: 'Click me' },
    });
    expect(wrapper.text()).toBe('Click me');
  });

  it('applies default variant classes', () => {
    const wrapper = mount(Button, {
      slots: { default: 'Click me' },
    });
    expect(wrapper.classes()).toContain('bg-primary');
  });

  it('applies destructive variant classes', () => {
    const wrapper = mount(Button, {
      props: { variant: 'destructive' },
      slots: { default: 'Delete' },
    });
    expect(wrapper.classes()).toContain('bg-destructive');
  });

  it('applies outline variant classes', () => {
    const wrapper = mount(Button, {
      props: { variant: 'outline' },
      slots: { default: 'Cancel' },
    });
    expect(wrapper.classes()).toContain('border');
  });

  it('is disabled when disabled prop is true', () => {
    const wrapper = mount(Button, {
      props: { disabled: true },
      slots: { default: 'Click me' },
    });
    expect(wrapper.attributes('disabled')).toBeDefined();
  });

  it('applies additional class via class prop', () => {
    const wrapper = mount(Button, {
      props: { class: 'custom-class' },
      slots: { default: 'Click me' },
    });
    expect(wrapper.classes()).toContain('custom-class');
  });

  it('renders as a button element', () => {
    const wrapper = mount(Button, {
      slots: { default: 'Click me' },
    });
    expect(wrapper.element.tagName).toBe('BUTTON');
  });
});
