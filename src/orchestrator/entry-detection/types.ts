// Phase 3.2 -- entry-detection language rule types
// (port of legacy/src/llm/entry-detection/types.ts).

import type { EntryKind } from '../../shared/types';

export interface LanguageRuleSet {
  family: string;
  displayName: string;
  kinds: Partial<Record<EntryKind, string>>;
}

export const ENTRY_KIND_ORDER: readonly EntryKind[] = [
  'http_endpoint',
  'cli_main',
  'worker',
  'sample',
  'public_api',
];
