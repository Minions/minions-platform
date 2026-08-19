import { ref, computed, nextTick } from 'vue';

function getCabinetUrl(): string {
  if (import.meta.env.VITE_CABINET_URL) {
    return import.meta.env.VITE_CABINET_URL as string;
  }
  if (typeof window !== 'undefined' && window.location.origin !== 'http://localhost:5173') {
    return window.location.origin;
  }
  return 'http://localhost:3000';
}

export function basename(p: string): string {
  return p.split('/').pop() ?? p;
}

export function dirname(p: string): string {
  const parts = p.split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
}

export function useFilePicker(wingName: () => string) {
  const isOpen = ref(false);
  const search = ref('');
  const allFiles = ref<string[]>([]);
  const loading = ref(false);
  const loadError = ref<string | null>(null);
  const activeIndex = ref(0);
  const searchInputRef = ref<HTMLInputElement | null>(null);
  const listRef = ref<HTMLUListElement | null>(null);

  const filteredFiles = computed(() => {
    if (!search.value.trim()) return allFiles.value;
    const q = search.value.toLowerCase();
    return allFiles.value.filter(f => f.toLowerCase().includes(q));
  });

  async function loadFiles() {
    loading.value = true;
    loadError.value = null;
    try {
      const url = `${getCabinetUrl()}/api/files/list?wingName=${encodeURIComponent(wingName())}`;
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Failed to load files: ${res.status}`);
      }
      const data = await res.json() as { files: string[] };
      allFiles.value = data.files;
    } catch (e) {
      loadError.value = e instanceof Error ? e.message : 'Failed to load files';
    } finally {
      loading.value = false;
    }
  }

  async function openPicker(preSearch?: string) {
    isOpen.value = true;
    search.value = preSearch ?? '';
    activeIndex.value = 0;
    await nextTick();
    searchInputRef.value?.focus();
    if (!allFiles.value.length && !loading.value) {
      await loadFiles();
    }
  }

  function closePicker() {
    isOpen.value = false;
  }

  function scrollActiveIntoView() {
    void nextTick(() => {
      const li = listRef.value?.children[activeIndex.value] as HTMLElement | undefined;
      li?.scrollIntoView({ block: 'nearest' });
    });
  }

  function handleKeydown(event: KeyboardEvent, onSelect: (file: string) => void) {
    const list = filteredFiles.value;
    if (!list.length) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeIndex.value = Math.min(activeIndex.value + 1, list.length - 1);
      scrollActiveIntoView();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeIndex.value = Math.max(activeIndex.value - 1, 0);
      scrollActiveIntoView();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (list[activeIndex.value]) {
        onSelect(list[activeIndex.value]);
      }
    } else if (event.key === 'Escape') {
      closePicker();
    } else {
      activeIndex.value = 0;
    }
  }

  /**
   * Try to resolve a dropped file's OS filename to a repo-relative path.
   * Returns the match if unique, or calls onMultiple/onNone for other cases.
   */
  async function resolveDroppedFile(
    fileName: string,
    onMatch: (path: string) => void,
    onMultiple: (preSearch: string) => void,
    onNone: (name: string) => void,
  ) {
    if (!allFiles.value.length) {
      await loadFiles();
    }
    const candidates = allFiles.value.filter(f => basename(f) === fileName);
    if (candidates.length === 1) {
      onMatch(candidates[0]);
    } else if (candidates.length > 1) {
      onMultiple(fileName);
    } else {
      onNone(fileName);
    }
  }

  return {
    isOpen,
    search,
    allFiles,
    filteredFiles,
    loading,
    loadError,
    activeIndex,
    searchInputRef,
    listRef,
    openPicker,
    closePicker,
    handleKeydown,
    resolveDroppedFile,
  };
}
