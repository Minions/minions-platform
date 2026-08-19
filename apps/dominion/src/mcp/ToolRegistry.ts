export const DOMINION_TOOL_NAMES = [
  'lairs_list',
  'lairs_start',
  'lairs_stop',
  'lairs_status',
  'setup_create_lair',
  'setup_add_primary_archive',
  'setup_read_config',
  'setup_provision',
] as const;

export type DominionToolName = typeof DOMINION_TOOL_NAMES[number];
