/**
 * Subscribes to the cabinet's `/api/quality/stream` SSE endpoint for live
 * per-wing quality state — no polling, matching the "live update via push"
 * shape already used by `useMissionEvents` (there via an MCP notification
 * emitter; here via a plain `EventSource`, since this data isn't part of
 * the MCP protocol).
 */
import { ref, onMounted, onUnmounted, type Ref } from 'vue';
import { getCabinetUrl } from '../api/cabinet';
import type { QualityStreamPayload } from '../types/quality';

export function useQualityStream(): { payload: Ref<QualityStreamPayload>; connected: Ref<boolean> } {
  const payload = ref<QualityStreamPayload>({ disabled: false, wings: {} });
  const connected = ref(false);

  let source: EventSource | null = null;

  onMounted(() => {
    source = new EventSource(`${getCabinetUrl()}/api/quality/stream`);
    source.onopen = () => {
      connected.value = true;
    };
    source.onmessage = (event: MessageEvent<string>) => {
      payload.value = JSON.parse(event.data) as QualityStreamPayload;
    };
    source.onerror = () => {
      connected.value = false;
    };
  });

  onUnmounted(() => {
    source?.close();
    source = null;
  });

  return { payload, connected };
}
