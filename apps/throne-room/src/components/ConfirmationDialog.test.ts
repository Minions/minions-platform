import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ConfirmationDialog from './ConfirmationDialog.vue';

describe('ConfirmationDialog', () => {
  const defaultProps = {
    title: 'Confirm Action',
    confirmLabel: 'Confirm',
    confirmingLabel: 'Confirming...',
    processing: false
  };

  it('renders title', () => {
    const wrapper = mount(ConfirmationDialog, {
      props: { ...defaultProps, title: 'Delete Item' }
    });

    expect(wrapper.find('h3').text()).toBe('Delete Item');
  });

  it('renders slot content', () => {
    const wrapper = mount(ConfirmationDialog, {
      props: defaultProps,
      slots: {
        default: '<p>Are you sure you want to proceed?</p>'
      }
    });

    expect(wrapper.text()).toContain('Are you sure you want to proceed?');
  });

  it('shows confirm label when not processing', () => {
    const wrapper = mount(ConfirmationDialog, {
      props: { ...defaultProps, confirmLabel: 'Delete', processing: false }
    });

    const confirmBtn = wrapper.findAll('button')[1];
    expect(confirmBtn.text()).toBe('Delete');
  });

  it('shows confirming label when processing', () => {
    const wrapper = mount(ConfirmationDialog, {
      props: { ...defaultProps, confirmingLabel: 'Deleting...', processing: true }
    });

    const confirmBtn = wrapper.findAll('button')[1];
    expect(confirmBtn.text()).toBe('Deleting...');
  });

  it('emits cancel when cancel clicked', async () => {
    const wrapper = mount(ConfirmationDialog, {
      props: defaultProps
    });

    await wrapper.find('button').trigger('click'); // First button is cancel

    expect(wrapper.emitted('cancel')).toBeTruthy();
  });

  it('emits confirm when confirm clicked', async () => {
    const wrapper = mount(ConfirmationDialog, {
      props: defaultProps
    });

    const buttons = wrapper.findAll('button');
    await buttons[1].trigger('click'); // Second button is confirm

    expect(wrapper.emitted('confirm')).toBeTruthy();
  });

  it('disables buttons when processing', () => {
    const wrapper = mount(ConfirmationDialog, {
      props: { ...defaultProps, processing: true }
    });

    const buttons = wrapper.findAll('button');
    buttons.forEach(btn => {
      expect(btn.attributes('disabled')).toBeDefined();
    });
  });

  it('shows error message when provided', () => {
    const wrapper = mount(ConfirmationDialog, {
      props: { ...defaultProps, error: 'Something went wrong' }
    });

    expect(wrapper.text()).toContain('Something went wrong');
    expect(wrapper.find('.error').exists()).toBe(true);
  });

  it('does not show error when null', () => {
    const wrapper = mount(ConfirmationDialog, {
      props: { ...defaultProps, error: null }
    });

    expect(wrapper.find('.error').exists()).toBe(false);
  });

  it('applies destructive variant to confirm button when danger', () => {
    const wrapper = mount(ConfirmationDialog, {
      props: { ...defaultProps, variant: 'danger' }
    });

    const confirmBtn = wrapper.findAll('button')[1];
    expect(confirmBtn.classes()).toContain('bg-destructive');
  });

  it('applies danger color to title for danger variant', () => {
    const wrapper = mount(ConfirmationDialog, {
      props: { ...defaultProps, variant: 'danger' }
    });

    expect(wrapper.find('h3').classes()).toContain('danger');
  });
});
