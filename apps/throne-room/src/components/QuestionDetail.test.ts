import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import QuestionDetail from './QuestionDetail.vue';
import * as cabinet from '../api/cabinet';
import type { Question } from '../types/question';

vi.mock('../api/cabinet', () => ({
  callMCPThroneRaw: vi.fn(),
}));

describe('QuestionDetail', () => {
  const mockQuestion: Question = {
    id: 'q1',
    minionId: 'minion-1',
    wingName: 'test',
    question: 'What should I do next?',
    content: { type: 'markdown', content: 'I have completed task A and B. The user said to continue with the plan.' },
    options: [],
    optionsMode: 'exclusive',
    timestamp: Date.now(),
    status: 'open',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('displays question content', () => {
    const wrapper = mount(QuestionDetail, {
      props: { question: mockQuestion }
    });

    expect(wrapper.text()).toContain('What should I do next?');
  });

  it('displays minion ID and wing', () => {
    const wrapper = mount(QuestionDetail, {
      props: { question: mockQuestion }
    });

    expect(wrapper.text()).toContain('minion-1');
    expect(wrapper.text()).toContain('test');
  });

  it('shows conversation context', () => {
    const wrapper = mount(QuestionDetail, {
      props: { question: mockQuestion }
    });

    expect(wrapper.text()).toContain('completed task A and B');
  });

  it('has textarea for answer', () => {
    const wrapper = mount(QuestionDetail, {
      props: { question: mockQuestion }
    });

    expect(wrapper.find('textarea').exists()).toBe(true);
  });

  it('calls ask answer on submit', async () => {
    vi.spyOn(cabinet, 'callMCPThroneRaw').mockResolvedValue({ success: true });

    const wrapper = mount(QuestionDetail, {
      props: { question: mockQuestion }
    });

    await wrapper.find('textarea').setValue('Do task C next');
    await wrapper.find('form').trigger('submit.prevent');

    expect(cabinet.callMCPThroneRaw).toHaveBeenCalledWith('ask', {
      action: 'answer',
      questionId: 'q1',
      answer: JSON.stringify({ answer: 'Do task C next' })
    });
  });

  it('emits answered event on success', async () => {
    vi.spyOn(cabinet, 'callMCPThroneRaw').mockResolvedValue({ success: true });

    const wrapper = mount(QuestionDetail, {
      props: { question: mockQuestion }
    });

    await wrapper.find('textarea').setValue('Answer');
    await wrapper.find('form').trigger('submit.prevent');
    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    const answeredEvents = wrapper.emitted('answered');
    expect(answeredEvents).toBeTruthy();
    expect(answeredEvents?.[0]).toEqual(['q1']);
  });

  it('handles answer submission errors', async () => {
    vi.spyOn(cabinet, 'callMCPThroneRaw').mockRejectedValue(
      new Error('Failed to answer')
    );

    const wrapper = mount(QuestionDetail, {
      props: { question: mockQuestion }
    });

    await wrapper.find('textarea').setValue('Answer');
    await wrapper.find('form').trigger('submit.prevent');
    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(wrapper.text()).toContain('Failed to answer');
  });

  it('emits close when cancel clicked', async () => {
    const wrapper = mount(QuestionDetail, {
      props: { question: mockQuestion }
    });

    await wrapper.find('.cancel-btn').trigger('click');

    expect(wrapper.emitted('close')).toBeTruthy();
  });

  it('renders controls when question has controls', () => {
    const questionWithControls: Question = {
      ...mockQuestion,
      controls: [{ name: 'notes', type: 'textarea', label: 'Notes', hint: 'observations' }],
    };

    const wrapper = mount(QuestionDetail, {
      props: { question: questionWithControls }
    });

    expect(wrapper.find('.control-section').exists()).toBe(true);
    expect(wrapper.find('#control-notes').exists()).toBe(true);
    expect(wrapper.text()).toContain('Notes');
  });

  it('renders markdown context', () => {
    const wrapper = mount(QuestionDetail, {
      props: { question: mockQuestion }
    });

    expect(wrapper.find('.context-text').exists()).toBe(true);
    expect(wrapper.text()).toContain('completed task A and B');
  });

  it('renders markdown from content field', () => {
    const questionWithMarkdown: Question = {
      ...mockQuestion,
      content: { type: 'markdown', content: 'Some **markdown** context' },
    };

    const wrapper = mount(QuestionDetail, {
      props: { question: questionWithMarkdown }
    });

    expect(wrapper.find('.context-text').exists()).toBe(true);
    expect(wrapper.find('.context-text').html()).toContain('<strong>markdown</strong>');
  });

  it('shows no controls when question has no controls', () => {
    const wrapper = mount(QuestionDetail, {
      props: { question: mockQuestion }
    });

    expect(wrapper.find('.control-section').exists()).toBe(false);
  });

  it('includes control values in JSON answer', async () => {
    vi.spyOn(cabinet, 'callMCPThroneRaw').mockResolvedValue({ success: true });

    const questionWithControls: Question = {
      ...mockQuestion,
      controls: [{ name: 'notes', type: 'textarea', label: 'Notes', hint: 'observations' }],
    };

    const wrapper = mount(QuestionDetail, {
      props: { question: questionWithControls }
    });

    await wrapper.find('#answer').setValue('Looks good');
    await wrapper.find('#control-notes').setValue('Fix button alignment');
    await wrapper.find('form').trigger('submit.prevent');

    expect(cabinet.callMCPThroneRaw).toHaveBeenCalledWith('ask', {
      action: 'answer',
      questionId: 'q1',
      answer: JSON.stringify({
        answer: 'Looks good',
        notes: 'Fix button alignment'
      })
    });
  });

  it('omits empty control values from JSON answer', async () => {
    vi.spyOn(cabinet, 'callMCPThroneRaw').mockResolvedValue({ success: true });

    const questionWithControls: Question = {
      ...mockQuestion,
      controls: [{ name: 'notes', type: 'textarea', label: 'Notes', hint: 'observations' }],
    };

    const wrapper = mount(QuestionDetail, {
      props: { question: questionWithControls }
    });

    await wrapper.find('#answer').setValue('Looks good');
    await wrapper.find('form').trigger('submit.prevent');

    expect(cabinet.callMCPThroneRaw).toHaveBeenCalledWith('ask', {
      action: 'answer',
      questionId: 'q1',
      answer: JSON.stringify({ answer: 'Looks good' })
    });
  });

  it('renders multiple controls', () => {
    const questionWithControls: Question = {
      ...mockQuestion,
      controls: [
        { name: 'notes', type: 'textarea', label: 'Notes' },
        { name: 'feedback', type: 'textarea', label: 'Feedback', rows: 2 },
      ],
    };

    const wrapper = mount(QuestionDetail, {
      props: { question: questionWithControls }
    });

    expect(wrapper.findAll('.control-section')).toHaveLength(2);
    expect(wrapper.find('#control-notes').exists()).toBe(true);
    expect(wrapper.find('#control-feedback').exists()).toBe(true);
  });

  it('hides submit button in exclusive mode when options present and answer is empty', () => {
    const exclusiveWithOptions: Question = {
      ...mockQuestion,
      options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }],
      optionsMode: 'exclusive',
    };

    const wrapper = mount(QuestionDetail, {
      props: { question: exclusiveWithOptions }
    });

    expect(wrapper.find('.submit-btn').exists()).toBe(false);
  });

  it('shows submit button in exclusive mode when user types an answer', async () => {
    const exclusiveWithOptions: Question = {
      ...mockQuestion,
      options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }],
      optionsMode: 'exclusive',
    };

    const wrapper = mount(QuestionDetail, {
      props: { question: exclusiveWithOptions }
    });

    await wrapper.find('#answer').setValue('My custom answer');

    expect(wrapper.find('.submit-btn').exists()).toBe(true);
  });

  it('disables buttons while submitting', async () => {
    vi.spyOn(cabinet, 'callMCPThroneRaw').mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve({ success: true }), 100))
    );

    const wrapper = mount(QuestionDetail, {
      props: { question: mockQuestion }
    });

    await wrapper.find('textarea').setValue('Answer');
    await wrapper.find('form').trigger('submit.prevent');
    await wrapper.vm.$nextTick();

    // Check cancel and submit buttons specifically (not the close X button)
    const cancelBtn = wrapper.find('.cancel-btn');
    const submitBtn = wrapper.find('.submit-btn');
    expect(cancelBtn.attributes('disabled')).toBeDefined();
    expect(submitBtn.attributes('disabled')).toBeDefined();
  });
});
