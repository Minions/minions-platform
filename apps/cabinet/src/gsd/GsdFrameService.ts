import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'crypto';
import type { PlanItemRecordView, GsdFrame, GsdFrameType, GsdItemRole } from '@minions/mcp-types';

// ── Auth ──────────────────────────────────────────────────────────────────────

let _envClient: Anthropic | null = null;

function getClient(authToken?: string): Anthropic {
  if (authToken) return new Anthropic({ authToken });
  if (!_envClient) _envClient = new Anthropic();
  return _envClient;
}

// ── In-memory cache ───────────────────────────────────────────────────────────
// Frames are cached by a hash of the plan items' key fields.
// Cache invalidates automatically when plan data changes.

interface CacheEntry {
  frames: GsdFrame[];
  hash: string;
}

let _cache: CacheEntry | null = null;

function hashPlan(items: Record<string, PlanItemRecordView>, rootIds: string[]): string {
  const sorted = Object.values(items)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(it =>
      `${it.id}:${String(it.approved)}:${it.started ? 1 : 0}:${it.demoLink ? 1 : 0}:${it.questions?.length ?? 0}:${it.onPath ? 1 : 0}`
    )
    .join('|');
  const key = rootIds.slice().sort().join(',') + '§' + sorted;
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

// ── Prompt ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Jarvis, the AI butler for a product owner (PO). Your job is to curate GSD ("Get Stuff Done") frames — focused work bundles that match how the PO wants to spend their time right now.

## Frame Types

**unblock** — The team is waiting on the PO. Create this frame when there are items blocked by open questions or demos awaiting review. This is always the most urgent type.

**refine** — Ideas already in the plan that are still rough (unapproved or tentatively-approved). The PO needs to elaborate requirements, define acceptance criteria, break them into stories, or make product decisions so minions can act on them.

**pathfind** — Approved, ready items that need the PO to sequence, prioritize, or clarify the path forward. The work is defined — help the PO decide what to tackle in what order.

**risk-scan** — Surfaces items where the PRODUCT OWNER faces risk in their own domain: unclear or conflicting requirements, uncertainty about what the customer actually needs, requirements that seem very hard or expensive to implement (suggesting a simpler alternative should be found), scope that keeps expanding, or items where the PO has made assumptions that haven't been validated. Do NOT include implementation risk, architecture risk, or technical complexity — those are the minions' problem, not the PO's.

**capture** — An open creative prompt for the PO to add new ideas. Use this only when the plan has obvious gaps or when there are product areas with no items. This frame may have zero items from the plan — it is an invitation to create.

## Rules
- Return an EMPTY frames array if there is genuinely nothing for the PO to do right now (e.g., all work is approved and in-progress with no questions — the minions just need to execute). An empty result is valid and correct.
- Only create a frame if there is real, concrete work for the PO to do in that mode right now.
- Each frame should have 3–6 items (except capture, which can have 0–2 context items).
- Roles: "anchor" = the key item to start with (exactly 1 per frame), "chain" = follow-up items directly related to the anchor, "context" = background items.
- Not everything needs to be in a frame — only the most actionable items.
- Priority: 1 = most urgent within its frame type. Use priority to distinguish multiple frames of the same type.

## Jarvis Voice
- First person, short, explains the WHY of the grouping.
- 1–2 sentences. Examples: "I pulled these together because the auth decision unlocks three waiting engineers." / "These are all rough — they need your definition before anyone can move."

## Output Format
Use the return_frames tool. Return an empty frames array when there is no PO work to do.`;

// ── Data ──────────────────────────────────────────────────────────────────────

interface ItemSummary {
  id: string;
  title: string;
  status: string;
  openQuestions: number;
  hasDemo: boolean;
  childCount: number;
  isLeaf: boolean;
  isRoot: boolean;
  parentTitle?: string;
}

function deriveStatus(item: PlanItemRecordView): string {
  if (item.questions && item.questions.length > 0) return 'blocked';
  if (item.demoLink) return 'demo-ready';
  if (item.started) return 'wip';
  if (item.onPath) return 'on-path';
  if (item.approved === false) return 'unapproved';
  if (item.approved === 'tentative') return 'tentative';
  return 'ready';
}

function buildItemSummaries(
  items: Record<string, PlanItemRecordView>,
  rootIds: string[],
): ItemSummary[] {
  return Object.values(items).map(item => ({
    id: item.id,
    title: item.title,
    status: deriveStatus(item),
    openQuestions: item.questions?.length ?? 0,
    hasDemo: !!item.demoLink,
    childCount: item.children?.length ?? 0,
    isLeaf: (item.children?.length ?? 0) === 0,
    isRoot: rootIds.includes(item.id),
    parentTitle: item.parent ? items[item.parent]?.title : undefined,
  }));
}

// ── Tool schema ───────────────────────────────────────────────────────────────

const FRAME_TOOL_SCHEMA = {
  name: 'return_frames',
  description: 'Return the computed GSD frames. Pass an empty array when there is no PO work to do.',
  input_schema: {
    type: 'object' as const,
    properties: {
      frames: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            type: { type: 'string', enum: ['unblock', 'refine', 'pathfind', 'risk-scan', 'capture'] },
            title: { type: 'string' },
            rationale: { type: 'string' },
            saving: { type: 'string' },
            priority: { type: 'number' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  itemId: { type: 'string' },
                  role: { type: 'string', enum: ['anchor', 'chain', 'context'] },
                },
                required: ['itemId', 'role'],
              },
            },
          },
          required: ['id', 'type', 'title', 'rationale', 'saving', 'priority', 'items'],
        },
      },
    },
    required: ['frames'],
  },
};

interface FrameToolInput {
  frames: Array<{
    id: string;
    type: string;
    title: string;
    rationale: string;
    saving: string;
    priority: number;
    items: Array<{ itemId: string; role: string }>;
  }>;
}

const VALID_FRAME_TYPES = new Set<string>(['unblock', 'refine', 'pathfind', 'risk-scan', 'capture']);
const VALID_ROLES = new Set<string>(['anchor', 'chain', 'context']);

// ── Main export ───────────────────────────────────────────────────────────────

export async function computeGsdFrames(
  items: Record<string, PlanItemRecordView>,
  rootIds: string[],
  claudeAuthToken?: string,
): Promise<GsdFrame[]> {
  if (Object.keys(items).length === 0) return [];

  const hash = hashPlan(items, rootIds);
  if (_cache && _cache.hash === hash) return _cache.frames;

  const summaries = buildItemSummaries(items, rootIds);

  const response = await getClient(claudeAuthToken).messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools: [FRAME_TOOL_SCHEMA],
    tool_choice: { type: 'any' },
    messages: [
      {
        role: 'user',
        content: `Here are the current plan items (${summaries.length} total):\n\n${JSON.stringify(summaries, null, 2)}\n\nAnalyze these and return the appropriate GSD frames. Return an empty array if there is nothing for the PO to do right now.`,
      },
    ],
  });

  const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  if (!toolUse) {
    _cache = { frames: [], hash };
    return [];
  }

  const input = toolUse.input as FrameToolInput;
  const rawFrames = input.frames ?? [];

  const frames = rawFrames
    .filter(f => VALID_FRAME_TYPES.has(f.type))
    .map(f => ({
      id: f.id,
      type: f.type as GsdFrameType,
      title: f.title,
      rationale: f.rationale,
      saving: f.saving,
      priority: f.priority,
      items: f.items
        .filter(it => it.itemId in items)
        .map(it => ({
          itemId: it.itemId,
          role: (VALID_ROLES.has(it.role) ? it.role : 'context') as GsdItemRole,
        })),
    }));

  _cache = { frames, hash };
  return frames;
}
