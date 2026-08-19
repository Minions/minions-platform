import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import VariantSelectionUI from './VariantSelectionUI.vue';
import * as cabinet from '../api/cabinet';
import type { Question } from '../types/question';
import type { VariantsContent } from '@minions/mcp-types';

vi.mock('../api/cabinet', () => ({
  callMCPThroneRaw: vi.fn(),
}));

const variantsData: VariantsContent = {
  __type: 'variants',
  variants: [
    {
      id: 'v1',
      name: 'Minimal Design',
      description: 'Clean and simple',
      html: '<div>Hello from variant 1</div>',
      features: [
        { id: 'f1', name: 'Clean layout' },
        { id: 'f2', name: 'Minimal colors' },
      ],
    },
    {
      id: 'v2',
      name: 'Bold Design',
      html: '<div>Bold variant</div>',
      features: [
        { id: 'f3', name: 'Bold typography' },
        { id: 'f4', name: 'Strong colors' },
      ],
    },
  ],
};

const mockQuestion: Question = {
  id: 'q-variants',
  minionId: 'minion-1',
  wingName: 'test',
  question: 'Choose variant features',
  content: { type: 'variants', content: JSON.stringify(variantsData) },
  options: [],
  optionsMode: 'exclusive',
  timestamp: Date.now(),
  status: 'open',
};

describe('VariantSelectionUI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders all variant names', () => {
    const wrapper = mount(VariantSelectionUI, { props: { question: mockQuestion } });
    expect(wrapper.text()).toContain('Minimal Design');
    expect(wrapper.text()).toContain('Bold Design');
  });

  it('renders features for each variant', () => {
    const wrapper = mount(VariantSelectionUI, { props: { question: mockQuestion } });
    expect(wrapper.text()).toContain('Clean layout');
    expect(wrapper.text()).toContain('Minimal colors');
    expect(wrapper.text()).toContain('Bold typography');
    expect(wrapper.text()).toContain('Strong colors');
  });

  it('renders variant HTML content', () => {
    const wrapper = mount(VariantSelectionUI, { props: { question: mockQuestion } });
    expect(wrapper.html()).toContain('Hello from variant 1');
    expect(wrapper.html()).toContain('Bold variant');
  });

  it('has all features checked by default', () => {
    const wrapper = mount(VariantSelectionUI, { props: { question: mockQuestion } });
    const checkboxes = wrapper.findAll('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(4);
    for (const checkbox of checkboxes) {
      expect((checkbox.element as HTMLInputElement).checked).toBe(true);
    }
  });

  it('can uncheck a feature', async () => {
    const wrapper = mount(VariantSelectionUI, { props: { question: mockQuestion } });
    const checkboxes = wrapper.findAll('input[type="checkbox"]');
    await checkboxes[0].setValue(false);
    expect((checkboxes[0].element as HTMLInputElement).checked).toBe(false);
  });

  it('calls ask answer with selected features on proceed', async () => {
    vi.spyOn(cabinet, 'callMCPThroneRaw').mockResolvedValue({ success: true });
    const wrapper = mount(VariantSelectionUI, { props: { question: mockQuestion } });

    const checkboxes = wrapper.findAll('input[type="checkbox"]');
    await checkboxes[0].setValue(false);

    await wrapper.find('.proceed-btn').trigger('click');

    expect(cabinet.callMCPThroneRaw).toHaveBeenCalledWith('ask', {
      action: 'answer',
      questionId: 'q-variants',
      answer: JSON.stringify({
        selectedFeatures: [
          { variantId: 'v1', featureId: 'f2' },
          { variantId: 'v2', featureId: 'f3' },
          { variantId: 'v2', featureId: 'f4' },
        ],
      }),
    });
  });

  it('emits answered event after proceeding', async () => {
    vi.spyOn(cabinet, 'callMCPThroneRaw').mockResolvedValue({ success: true });
    const wrapper = mount(VariantSelectionUI, { props: { question: mockQuestion } });

    await wrapper.find('.proceed-btn').trigger('click');
    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    const answeredEvents = wrapper.emitted('answered');
    expect(answeredEvents).toBeTruthy();
    expect(answeredEvents?.[0]).toEqual(['q-variants']);
  });

  it('shows error message on failure', async () => {
    vi.spyOn(cabinet, 'callMCPThroneRaw').mockRejectedValue(new Error('Network error'));
    const wrapper = mount(VariantSelectionUI, { props: { question: mockQuestion } });

    await wrapper.find('.proceed-btn').trigger('click');
    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(wrapper.text()).toContain('Network error');
  });

  it('disables proceed button while submitting', async () => {
    vi.spyOn(cabinet, 'callMCPThroneRaw').mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve({ success: true }), 100))
    );
    const wrapper = mount(VariantSelectionUI, { props: { question: mockQuestion } });

    await wrapper.find('.proceed-btn').trigger('click');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.proceed-btn').attributes('disabled')).toBeDefined();
  });

  it('renders variant description when present', () => {
    const wrapper = mount(VariantSelectionUI, { props: { question: mockQuestion } });
    expect(wrapper.text()).toContain('Clean and simple');
  });

  it('shows question text', () => {
    const wrapper = mount(VariantSelectionUI, { props: { question: mockQuestion } });
    expect(wrapper.text()).toContain('Choose variant features');
  });
});
