import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import WelcomeScreen from './WelcomeScreen.vue';

describe('WelcomeScreen', () => {
  it('displays overlord greeting', () => {
    const wrapper = mount(WelcomeScreen);
    expect(wrapper.find('h1').text()).toContain('Welcome, Overlord');
  });

  it('shows lair structure explanation', () => {
    const wrapper = mount(WelcomeScreen);
    const text = wrapper.text();
    expect(text).toContain('Wings');
    expect(text).toContain('Minions');
    expect(text).toContain('Secretaries');
  });

  it('has dismiss/proceed button', () => {
    const wrapper = mount(WelcomeScreen);
    expect(wrapper.find('button.proceed').exists()).toBe(true);
  });

  it('emits dismiss event when proceed button is clicked', async () => {
    const wrapper = mount(WelcomeScreen);
    await wrapper.find('button.proceed').trigger('click');
    expect(wrapper.emitted('dismiss')).toBeTruthy();
  });

  it('displays throne room introduction', () => {
    const wrapper = mount(WelcomeScreen);
    expect(wrapper.text()).toContain('Throne Room');
  });

  it('displays lair structure with wings concept', () => {
    const wrapper = mount(WelcomeScreen);
    expect(wrapper.text()).toContain('Wings');
    expect(wrapper.text()).toContain('zones of specialized activity');
  });

  it('includes manuals, gadgets, and policies references', () => {
    const wrapper = mount(WelcomeScreen);
    const text = wrapper.text();
    expect(text).toContain('Manual');
    expect(text).toContain('Gadget');
    expect(text).toContain('Closet');
  });

  it('maintains characteristic tone', () => {
    const wrapper = mount(WelcomeScreen);
    const text = wrapper.text();
    // Check for tone-consistent phrases from welcome.md
    expect(text).toMatch(/functional chaos|swarm|demented|disposable/i);
  });

  it('has a closing call to action', () => {
    const wrapper = mount(WelcomeScreen);
    expect(wrapper.text()).toContain('go get some');
  });
});
