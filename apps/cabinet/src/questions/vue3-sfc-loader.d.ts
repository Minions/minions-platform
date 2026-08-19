declare module 'vue3-sfc-loader' {
  import type { DefineComponent } from 'vue';
  export function loadModule(
    path: string,
    options: Record<string, unknown>
  ): Promise<DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>>;
}
