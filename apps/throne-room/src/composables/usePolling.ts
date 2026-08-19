import { ref, onUnmounted, getCurrentInstance } from 'vue';

/**
 * Composable for polling a callback at a specified interval
 *
 * @param callback - Function to call at each interval
 * @param intervalMs - Polling interval in milliseconds
 * @returns Polling controls and state
 */
export function usePolling(
  callback: () => void | Promise<void>,
  intervalMs: number
) {
  const isPolling = ref(false);
  let intervalId: ReturnType<typeof setInterval> | null = null;

  function start() {
    if (isPolling.value) return;

    isPolling.value = true;

    // Call immediately
    callback();

    // Then poll at interval
    intervalId = setInterval(callback, intervalMs);
  }

  function stop() {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    isPolling.value = false;
  }

  function pause() {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    isPolling.value = false;
  }

  function resume() {
    if (isPolling.value || intervalId) return;

    isPolling.value = true;
    // Resume polling without calling callback immediately
    intervalId = setInterval(callback, intervalMs);
  }

  // Auto-cleanup on component unmount (only if in component context)
  if (getCurrentInstance()) {
    onUnmounted(() => {
      stop();
    });
  }

  return {
    isPolling,
    start,
    stop,
    pause,
    resume
  };
}
