# Synthetic Message Format Design

## Purpose

This document defines how Workbench contents (FileKnowledge and ProjectFact) are converted into synthetic MinionMessage history for injection into minions. This enables multiple agents to share contextual knowledge without re-executing discovery work.

## Overview

When a minion is spawned with a Workbench, the conductor converts the workbench contents into a MinionMessage array that appears as if the minion had previously executed gadgets to discover this information. This "synthetic history" is prepended to the minion's message stream, making it believe it has already:

1. Read files via the Read gadget
2. Received facts about the project

The synthetic format must be:
- **Believable**: Looks like actual gadget interactions
- **Complete**: Preserves all essential information
- **Ordered**: Chronologically consistent
- **Filtered**: Respects Costume.injectFacts preferences

## FileKnowledge → Synthetic Messages

### Format

Each FileKnowledge entry becomes a **pair** of messages:

1. **Tool Use Message** (synthetic Read gadget call):
```typescript
{
  type: 'tool_use',
  id: `synthetic-read-${index}`,
  name: 'Read',
  input: {
    file_path: fileKnowledge.path
  },
  timestamp: fileKnowledge.lastRead,
  metadata: {
    synthetic: true,
    category: fileKnowledge.category
  }
}
```

2. **Tool Result Message** (synthetic Read gadget result):
```typescript
{
  type: 'tool_result',
  tool_use_id: `synthetic-read-${index}`,
  content: fileKnowledge.content,
  is_error: false,
  timestamp: fileKnowledge.lastRead + 1, // 1ms after tool_use for ordering
  metadata: {
    synthetic: true,
    category: fileKnowledge.category
  }
}
```

### Design Decisions

**Why tool_use/tool_result pairs?**
- Mimics actual gadget execution flow
- Provides context about HOW the file was obtained (via Read gadget)
- Maintains the request→response pattern minions expect

**Why use FileKnowledge.lastRead for timestamp?**
- Preserves chronological ordering of when files were discovered
- Makes synthetic history believable (older files read first)
- Enables sorting multiple files by discovery time

**Why include category in metadata?**
- Enables future filtering if needed
- Provides observability about file classification
- Doesn't affect current filtering (all files always injected)

**Why increment timestamp by 1ms for tool_result?**
- Ensures tool_result always comes after tool_use in chronological order
- Minimal increment prevents overlap with other messages
- Maintains believable timing

### Filtering Behavior

**All files are always injected**, regardless of:
- FileKnowledge.category
- Costume.injectFacts

Files provide essential context that all agents need. Only ProjectFacts are filtered by injectFacts.

## ProjectFact → Synthetic Messages

### Format

Facts matching the Costume.injectFacts categories are converted to **text messages**, grouped by category:

```typescript
{
  type: 'text',
  content: `Project Facts (${category}):\n- ${fact1}\n- ${fact2}\n...`,
  timestamp: earliestFactTimestamp,
  metadata: {
    synthetic: true,
    factCategory: category,
    factCount: facts.length,
    discoveredBy: [uniqueDiscoverers]
  }
}
```

### Design Decisions

**Why text messages instead of tool_result?**
- Facts are informational, not the result of explicit gadget calls
- Avoids inventing a "getFacts" gadget that doesn't exist
- Cleaner representation for declarative knowledge
- Text messages can be grouped naturally by category

**Why group by category?**
- Provides logical organization (all build facts together, all structure facts together)
- Reduces message count compared to one message per fact
- Makes synthetic history more readable
- Mimics how a human would summarize facts

**Why include discoveredBy in metadata?**
- Preserves attribution (who discovered these facts)
- Enables observability about fact sources
- Supports future provenance tracking

**What timestamp to use?**
- Use the earliest timestamp among the facts being grouped
- This ensures fact messages appear chronologically correct relative to file reads
- For now, we use a fixed timestamp at grouping time (all facts get current timestamp)
- **Future enhancement**: Track fact discovery timestamps for true chronological ordering

### Filtering Behavior

Only facts whose **category matches** one of the categories in **Costume.injectFacts** are included.

**Example**:
```typescript
// Costume has:
injectFacts: ['build', 'structure']

// Workbench has facts:
{ category: 'build', fact: 'Build command: pnpm build' }      // INCLUDED
{ category: 'structure', fact: 'Monorepo using nx' }         // INCLUDED
{ category: 'deployment', fact: 'Deploy to AWS' }            // EXCLUDED
{ category: 'test', fact: 'Uses vitest' }                    // EXCLUDED
```

**Edge Cases**:
- If `injectFacts` is `undefined` or `[]`: **No facts are injected**
- If no facts match any category in `injectFacts`: **No fact messages generated**
- If multiple facts have same category: **Grouped into single message**

## Message Ordering

Synthetic messages must be ordered chronologically to maintain believability.

### Ordering Strategy

1. **Collect all synthetic messages** (file pairs + fact groups)
2. **Sort by timestamp** (ascending, oldest first)
3. **Prepend to minion's message stream** before any live messages

### Timestamp Sequence

Given:
- File A: lastRead = 1000
- File B: lastRead = 2000
- Facts: timestamp = 3000

Result:
```
[1000] tool_use:   Read file A
[1001] tool_result: Content of file A
[2000] tool_use:   Read file B
[2001] tool_result: Content of file B
[3000] text:       Project Facts (build): ...
[3000] text:       Project Facts (structure): ...
--- END OF SYNTHETIC HISTORY ---
[4000] user:       [First real message]
```

### Stable Ordering

When timestamps are equal (e.g., multiple fact categories at same timestamp):
- Maintain stable sort order (insertion order preserved)
- File pairs always stay together (tool_use immediately before tool_result)

## Implementation Function Signature

```typescript
/**
 * Convert Workbench contents to synthetic MinionMessage history
 *
 * @param workbench - The workbench containing files and facts
 * @param injectFacts - Categories of facts to inject (from Costume.injectFacts)
 * @returns Chronologically ordered array of synthetic messages
 */
function workbenchToSyntheticHistory(
  workbench: IWorkbench,
  injectFacts?: string[]
): MinionMessage[]
```

**Location**: `libs/conductor/src/domain/WorkbenchInjection.ts`

## Future Extensibility

### Operation History

The current design focuses on **current state** (files and facts). Future enhancements may include **operation history**:

**Potential additions**:
- Write gadget calls (files that were created/modified)
- Other gadget calls (bash commands, searches, etc.)
- Minion text responses (what agents "said" during discovery)

**Extensibility considerations**:
- Metadata field allows tagging synthetic vs. real messages
- Chronological ordering supports interleaving different message types
- Format is general enough to represent any MinionMessage type

**How to add operation history**:
1. Extend Workbench to track operations (not just final state)
2. Convert operations to appropriate MinionMessage types
3. Merge with file/fact messages and sort chronologically
4. Maintain filtering rules (what gets injected vs. omitted)

### Size Management

Current design does **not** limit synthetic history size. Future enhancements may add:

**Size awareness**:
- Count tokens/characters in synthetic history
- Warn when approaching model context limits
- Provide summarization or selective injection

**Compression strategies**:
- Summarize large files instead of full content
- Sample facts instead of injecting all
- Prioritize recent files over old files

These are **out of scope** for initial implementation but the message format supports them.

## Examples

### Example 1: Single File, Single Fact

**Workbench**:
```typescript
files: [
  { path: 'src/index.ts', content: 'export const x = 1;', lastRead: 1000, category: 'source' }
]
facts: [
  { category: 'build', fact: 'Build command: pnpm build', discoveredBy: 'analyst' }
]
```

**Costume**:
```typescript
injectFacts: ['build']
```

**Synthetic History**:
```typescript
[
  {
    type: 'tool_use',
    id: 'synthetic-read-0',
    name: 'Read',
    input: { file_path: 'src/index.ts' },
    timestamp: 1000,
    metadata: { synthetic: true, category: 'source' }
  },
  {
    type: 'tool_result',
    tool_use_id: 'synthetic-read-0',
    content: 'export const x = 1;',
    timestamp: 1001,
    metadata: { synthetic: true, category: 'source' }
  },
  {
    type: 'text',
    content: 'Project Facts (build):\n- Build command: pnpm build',
    timestamp: 1001,
    metadata: { synthetic: true, factCategory: 'build', factCount: 1, discoveredBy: ['analyst'] }
  }
]
```

### Example 2: Fact Filtering

**Workbench**:
```typescript
facts: [
  { category: 'build', fact: 'Build: pnpm build', discoveredBy: 'analyst' },
  { category: 'test', fact: 'Test: pnpm test', discoveredBy: 'analyst' },
  { category: 'structure', fact: 'Monorepo: nx', discoveredBy: 'analyst' }
]
```

**Developer Costume**:
```typescript
injectFacts: ['build', 'structure']
```

**Critic Costume**:
```typescript
injectFacts: ['structure']
```

**Developer sees**:
```typescript
[
  { type: 'text', content: 'Project Facts (build):\n- Build: pnpm build', ... },
  { type: 'text', content: 'Project Facts (structure):\n- Monorepo: nx', ... }
]
```

**Critic sees**:
```typescript
[
  { type: 'text', content: 'Project Facts (structure):\n- Monorepo: nx', ... }
]
```

### Example 3: No Facts Match

**Workbench**:
```typescript
facts: [
  { category: 'deployment', fact: 'Deploy to AWS', discoveredBy: 'ops' }
]
```

**Costume**:
```typescript
injectFacts: ['build']
```

**Synthetic History**:
```typescript
[] // Empty - no facts match
```

### Example 4: Empty injectFacts

**Workbench**:
```typescript
files: [
  { path: 'README.md', content: '# Project', lastRead: 1000, category: 'docs' }
]
facts: [
  { category: 'build', fact: 'Build: pnpm build', discoveredBy: 'analyst' }
]
```

**Costume**:
```typescript
injectFacts: [] // or undefined
```

**Synthetic History**:
```typescript
[
  {
    type: 'tool_use',
    id: 'synthetic-read-0',
    name: 'Read',
    input: { file_path: 'README.md' },
    timestamp: 1000,
    metadata: { synthetic: true, category: 'docs' }
  },
  {
    type: 'tool_result',
    tool_use_id: 'synthetic-read-0',
    content: '# Project',
    timestamp: 1001,
    metadata: { synthetic: true, category: 'docs' }
  }
]
// Files included, no facts because injectFacts is empty
```

## Summary

This design provides a clear, consistent format for representing Workbench contents as synthetic MinionMessage history:

- **Files**: Always injected as tool_use/tool_result pairs (mimics Read gadget)
- **Facts**: Filtered by Costume.injectFacts, grouped by category as text messages
- **Ordering**: Chronological by timestamp (oldest first)
- **Metadata**: Tagged as synthetic, preserves categories and attribution
- **Extensible**: Supports future operation history and size management

The format is believable, complete, and enables multiple agents to share context efficiently.
