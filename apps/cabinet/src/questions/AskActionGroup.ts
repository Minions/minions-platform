/**
 * AskActionGroup — MCP action group for the `ask` tool: a minion (or mission)
 * asks the overlord a structured question and optionally blocks on the answer.
 *
 * blocking/nonblocking/await are minion-side (henchery only — wingName comes
 * from the henchery URL, sessionId identifies the asking minion). list/answer
 * are overlord-side (throne only — the Throne Room UI polls open questions and
 * submits answers).
 */

import type { ActionGroupDef } from '@minions/mcp-types';
import type { AskContent, AskOption, AskControl } from '@minions/mcp-types';
import { getQuestionQueue, type Question } from './QuestionQueue.js';
import { resolveAskContent } from './compileVueAskContent.js';

interface AskActionContext {
  wingName?: string;
  sessionId?: string;
}

const sharedParams = {
  question: { type: 'string' as const, description: 'The question text to display' },
  content: {
    type: 'object' as const,
    description: 'Rich content displayed alongside the question',
    properties: {
      type: { type: 'string', enum: ['markdown', 'html', 'vue'] },
      content: { type: 'string' },
      components: { type: 'object' },
    },
    required: ['type', 'content'],
  },
  options: {
    type: 'array' as const,
    description: 'Options for the human to select ([] = free-form only)',
    items: {
      type: 'object' as const,
      properties: {
        value: { type: 'string' },
        label: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['value', 'label'],
    },
  },
  optionsMode: {
    type: 'string' as const,
    enum: ['exclusive', 'non-exclusive'],
    description: 'exclusive = radio buttons (auto-submit); non-exclusive = checkboxes. Defaults to exclusive.',
  },
  controls: {
    type: 'array' as const,
    description: 'Additional input controls like a notes textarea',
    items: {
      type: 'object' as const,
      properties: {
        name: { type: 'string' },
        type: { type: 'string', enum: ['textarea'] },
        label: { type: 'string' },
        hint: { type: 'string' },
        placeholder: { type: 'string' },
        rows: { type: 'number' },
      },
      required: ['name', 'type', 'label'],
    },
  },
};

async function postQuestion(ctx: AskActionContext, params: Record<string, unknown>): Promise<Question> {
  const queue = getQuestionQueue();
  return queue.add({
    minionId: ctx.sessionId ?? 'unknown',
    wingName: ctx.wingName as string,
    question: params['question'] as string,
    content: await resolveAskContent(params['content'] as AskContent),
    options: (params['options'] ?? []) as AskOption[],
    optionsMode: (params['optionsMode'] ?? 'exclusive') as 'exclusive' | 'non-exclusive',
    controls: params['controls'] as AskControl[] | undefined,
  });
}

const blockingAction = {
  description: 'post a question and suspend until the overlord answers it',
  help: `**ask blocking** — Post a question and wait for the overlord's answer.

Required: question, content
Optional: options ([] = free-form only), optionsMode (defaults to exclusive), controls
Returns: { answer }`,
  params: sharedParams,
  required: ['question', 'content'] as string[],
  async execute(ctx: AskActionContext, params: Record<string, unknown>) {
    const queue = getQuestionQueue();
    const q = await postQuestion(ctx, params);
    const answer = await queue.waitForAnswer(q.id);
    return { answer };
  },
};

const nonblockingAction = {
  description: 'post a question and return its questionId immediately',
  help: `**ask nonblocking** — Post a question without waiting; pair with a later \`await\`.

Required: question, content
Optional: options ([] = free-form only), optionsMode (defaults to exclusive), controls
Returns: { questionId }`,
  params: sharedParams,
  required: ['question', 'content'] as string[],
  async execute(ctx: AskActionContext, params: Record<string, unknown>) {
    const q = await postQuestion(ctx, params);
    return { questionId: q.id };
  },
};

const awaitAction = {
  description: 'wait for a previously posted (nonblocking) question to be answered',
  help: `**ask await** — Wait for a question posted via \`nonblocking\` to be answered.

Required: questionId
Returns: { answer }`,
  params: {
    questionId: { type: 'string' as const, description: 'Question ID returned by a previous nonblocking call' },
  },
  required: ['questionId'] as string[],
  async execute(_ctx: AskActionContext, params: Record<string, unknown>) {
    const queue = getQuestionQueue();
    const answer = await queue.waitForAnswer(params['questionId'] as string);
    return { answer };
  },
};

const listAction = {
  description: 'list open questions, optionally filtered to one wing',
  help: `**ask list** — List open questions.

Optional: wingName (filter to one wing)
Returns: { questions }`,
  params: {
    wingName: { type: 'string' as const, description: 'Optional wing name to filter questions' },
  },
  required: [] as string[],
  async execute(_ctx: AskActionContext, params: Record<string, unknown>) {
    const queue = getQuestionQueue();
    const wingName = params['wingName'] as string | undefined;
    const questions = wingName ? queue.getOpenByWing(wingName) : queue.getOpen();
    return { questions };
  },
};

const answerAction = {
  description: 'answer an open question',
  help: `**ask answer** — Submit the overlord's answer to an open question.

Required: questionId, answer
Returns: { success: true }`,
  params: {
    questionId: { type: 'string' as const, description: 'Question ID to answer' },
    answer: { type: 'string' as const, description: 'The answer text to submit' },
  },
  required: ['questionId', 'answer'] as string[],
  async execute(_ctx: AskActionContext, params: Record<string, unknown>) {
    const queue = getQuestionQueue();
    queue.answer(params['questionId'] as string, params['answer'] as string);
    return { success: true };
  },
};

export const askActionGroup: ActionGroupDef = {
  name: 'ask',
  description: 'Ask the overlord (human) a structured question, or manage the question queue.',
  workflow: 'blocking (or nonblocking → await) → overlord sees it via list → answer',
  coreActions: {
    blocking: blockingAction,
    nonblocking: nonblockingAction,
    list: listAction,
    answer: answerAction,
  },
  secondaryActions: {
    await: awaitAction,
  },
};
