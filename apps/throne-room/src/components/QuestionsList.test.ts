import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import QuestionsList from './QuestionsList.vue';
import * as cabinet from '../api/cabinet';
import type { QuestionSummary } from '@minions/mcp-types';

vi.mock('../api/cabinet', () => ({
  callMCPThroneRaw: vi.fn(),
  cabinetEvents: {
    subscribe: vi.fn(() => vi.fn()),
    emit: vi.fn(),
  },
  questionEvents: {
    subscribe: vi.fn(() => vi.fn()),
  },
}));

// Helper to create valid QuestionSummary objects
function createQuestion(overrides: Partial<QuestionSummary> & { id: string }): QuestionSummary {
  return {
    minionId: 'minion-1',
    wingName: 'test',
    question: 'Question?',
    content: { type: 'markdown', content: 'test context' },
    options: [],
    optionsMode: 'exclusive',
    timestamp: Date.now(),
    status: 'open' as const,
    ...overrides,
  };
}

describe('QuestionsList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads questions on mount', async () => {
    const mockQuestions = [createQuestion({ id: 'q1', question: 'Question 1?' })];
    vi.spyOn(cabinet, 'callMCPThroneRaw').mockResolvedValue({ questions: mockQuestions });

    const wrapper = mount(QuestionsList);

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(cabinet.callMCPThroneRaw).toHaveBeenCalledWith('ask', { action: 'list' });
  });

  it('displays question count in header', async () => {
    const mockQuestions = [
      createQuestion({ id: 'q1', question: 'Q1?' }),
      createQuestion({ id: 'q2', minionId: 'minion-2', question: 'Q2?' })
    ];
    vi.spyOn(cabinet, 'callMCPThroneRaw').mockResolvedValue({ questions: mockQuestions });

    const wrapper = mount(QuestionsList);

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(wrapper.text()).toContain('Open Questions (2)');
  });

  it('shows empty state when no questions', async () => {
    vi.spyOn(cabinet, 'callMCPThroneRaw').mockResolvedValue({ questions: [] });

    const wrapper = mount(QuestionsList);

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(wrapper.text()).toContain('No open questions');
  });

  it('displays question content', async () => {
    const mockQuestions = [createQuestion({ id: 'q1', question: 'What should I do next?' })];
    vi.spyOn(cabinet, 'callMCPThroneRaw').mockResolvedValue({ questions: mockQuestions });

    const wrapper = mount(QuestionsList);

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(wrapper.text()).toContain('What should I do next?');
  });

  it('shows minion ID and wing', async () => {
    const mockQuestions = [
      createQuestion({ id: 'q1', minionId: 'minion-123', wingName: 'central-planning' })
    ];
    vi.spyOn(cabinet, 'callMCPThroneRaw').mockResolvedValue({ questions: mockQuestions });

    const wrapper = mount(QuestionsList);

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(wrapper.text()).toContain('minion-123');
    expect(wrapper.text()).toContain('central-planning');
  });

  it('emits select when question clicked', async () => {
    const mockQuestions = [createQuestion({ id: 'q1' })];
    vi.spyOn(cabinet, 'callMCPThroneRaw').mockResolvedValue({ questions: mockQuestions });

    const wrapper = mount(QuestionsList);

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    await wrapper.find('.question-card').trigger('click');

    const selectEvents = wrapper.emitted('select');
    expect(selectEvents).toBeTruthy();
    expect(selectEvents?.[0]).toEqual([mockQuestions[0]]);
  });

  it('filters by wing when prop provided', async () => {
    vi.spyOn(cabinet, 'callMCPThroneRaw').mockResolvedValue({ questions: [] });

    mount(QuestionsList, {
      props: { wingName: 'test-wing' }
    });

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(cabinet.callMCPThroneRaw).toHaveBeenCalledWith('ask', {
      action: 'list',
      wingName: 'test-wing'
    });
  });

  it('refreshes list when refresh called', async () => {
    const mcpSpy = vi.spyOn(cabinet, 'callMCPThroneRaw')
      .mockResolvedValueOnce({ questions: [] })
      .mockResolvedValueOnce({ questions: [createQuestion({ id: 'q1', question: 'Q?' })] });

    const wrapper = mount(QuestionsList);

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    await (wrapper.vm as unknown as { loadQuestions: () => Promise<void> }).loadQuestions();
    await wrapper.vm.$nextTick();

    expect(mcpSpy).toHaveBeenCalledTimes(2);
  });
});
