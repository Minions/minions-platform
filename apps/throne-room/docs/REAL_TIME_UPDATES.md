# Real-time Updates

## Current Implementation (MVP)

The throne room uses polling to keep the UI synchronized with backend state changes.

### Polling Configuration

- **MinionList**: Polls every 3 seconds for status changes
- **MinionConversation**: Polls every 2 seconds for new messages

### Implementation Details

Polling is implemented using the `usePolling` composable (`src/composables/usePolling.ts`):

```typescript
// In MinionList.vue
const { start, stop } = usePolling(loadMinions, 3000); // 3 seconds

// In MinionConversation.vue
const { start, stop } = usePolling(loadConversation, 2000); // 2 seconds
```

### Lifecycle Management

- **Auto-start**: Polling begins automatically when component mounts
- **Auto-stop**: Polling stops automatically when component unmounts
- **Manual control**: Components expose `stop()` method for parent control

### Why These Intervals?

- **MinionList (3 seconds)**: Status changes are less frequent, so a longer interval reduces server load while still providing responsive updates
- **MinionConversation (2 seconds)**: Messages flow more frequently during active work, requiring faster polling for better UX

### Benefits

- Simple implementation without additional server infrastructure
- Works with existing MCP tool endpoints
- Predictable resource usage
- Easy to test and debug

### Limitations

- Not truly real-time (2-3 second delay)
- Generates server requests even when no changes occur
- Scales poorly with many concurrent users
- Higher server load compared to push-based approaches

## Future Enhancement: Server-Sent Events (SSE)

### Why SSE?

Server-Sent Events provide true real-time updates by allowing the server to push changes to clients immediately when they occur.

### Benefits of SSE Migration

- **Instant updates**: No polling delay
- **Reduced load**: Server only sends data when changes occur
- **Better scaling**: More efficient with many concurrent users
- **Lower latency**: Sub-second update propagation

### Implementation Plan

See [TECHNICAL_DECISIONS.md](../../plan/ps_0008/TECHNICAL_DECISIONS.md#11-vue--mcp-client-pattern) for detailed SSE implementation guidance.

#### Server-Side Changes (Cabinet)

```typescript
// Add SSE endpoint
app.get('/sse/minions/:wingName', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Subscribe to minion events
  const subscription = minionManager.subscribe(req.params.wingName, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  // Cleanup on disconnect
  req.on('close', () => {
    subscription.unsubscribe();
  });
});
```

#### Client-Side Changes (Throne Room)

```typescript
// Replace polling with SSE subscription
export function useMinionsSSE(wingName: string) {
  const minions = ref<Minion[]>([]);

  onMounted(() => {
    const eventSource = new EventSource(`/sse/minions/${wingName}`);

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      // Update minions based on event type
      handleMinionEvent(data);
    };

    onUnmounted(() => {
      eventSource.close();
    });
  });

  return { minions };
}
```

### Migration Strategy

1. **Phase 1**: Implement SSE infrastructure in Cabinet
2. **Phase 2**: Add SSE composable alongside polling (feature flag)
3. **Phase 3**: Test SSE with real workloads
4. **Phase 4**: Switch default to SSE, keep polling as fallback
5. **Phase 5**: Remove polling code after SSE proven stable

### Compatibility Considerations

- **Fallback**: Detect SSE support and fall back to polling if unavailable
- **Reconnection**: Handle SSE disconnections with exponential backoff
- **Error handling**: Gracefully degrade to polling on SSE errors

## Optimization Notes

### Current Optimizations

- Polling auto-stops on component unmount (prevents memory leaks)
- Loading states prevent redundant requests during active loads
- Exposed stop methods allow parent components to pause polling

### Recommended Future Optimizations

#### Visibility API Integration

Pause polling when browser tab is hidden:

```typescript
export function usePolling(callback: Function, intervalMs: number) {
  // ... existing code ...

  function handleVisibilityChange() {
    if (document.hidden) {
      pause();
    } else {
      resume();
    }
  }

  document.addEventListener('visibilitychange', handleVisibilityChange);

  onUnmounted(() => {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  });
}
```

#### Exponential Backoff on Errors

Reduce polling frequency when errors occur:

```typescript
export function usePollingWithBackoff(callback: Function, baseInterval: number) {
  let currentInterval = baseInterval;
  let errorCount = 0;

  async function pollWithErrorHandling() {
    try {
      await callback();
      // Reset on success
      errorCount = 0;
      currentInterval = baseInterval;
    } catch (error) {
      errorCount++;
      // Exponential backoff: double interval up to 30 seconds
      currentInterval = Math.min(baseInterval * Math.pow(2, errorCount), 30000);
    }
  }

  // ... use currentInterval for setInterval ...
}
```

#### Smart Polling (Adaptive Intervals)

Adjust polling frequency based on activity level:

```typescript
export function useAdaptivePolling(callback: Function, minInterval: number, maxInterval: number) {
  let interval = minInterval;
  let lastChangeTime = Date.now();

  async function pollAndAdapt() {
    const oldState = getCurrentState();
    await callback();
    const newState = getCurrentState();

    if (hasChanged(oldState, newState)) {
      // Changes detected: poll frequently
      lastChangeTime = Date.now();
      interval = minInterval;
    } else if (Date.now() - lastChangeTime > 60000) {
      // No changes for 1 minute: slow down
      interval = Math.min(interval * 1.5, maxInterval);
    }
  }
}
```

## References

- [usePolling Composable](../src/composables/usePolling.ts)
- [MinionList Component](../src/components/MinionList.vue)
- [MinionConversation Component](../src/components/MinionConversation.vue)
- [Technical Decisions](../../plan/ps_0008/TECHNICAL_DECISIONS.md)
