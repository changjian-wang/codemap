// Phase 3.2 -- entry-detection registry + composed prompt section
// (port of legacy/src/llm/entry-detection/index.ts).

import { DOTNET_RULES } from './rules/dotnet';
import { PYTHON_RULES } from './rules/python';
import { NODE_RULES } from './rules/node';
import { composeEntryGuidance } from './composer';
import type { LanguageRuleSet } from './types';

export { composeEntryGuidance } from './composer';
export { DOTNET_RULES } from './rules/dotnet';
export { PYTHON_RULES } from './rules/python';
export { NODE_RULES } from './rules/node';
export type { LanguageRuleSet } from './types';
export { ENTRY_KIND_ORDER } from './types';

/**
 * Languages compiled into the SYSTEM_PROMPT, in render order. Adding a
 * new family (Go, Ruby, ...): create `rules/<family>.ts`, then append it
 * here. No other file in the codebase needs to know about the new family.
 */
export const REGISTERED_LANGUAGES: readonly LanguageRuleSet[] = [
  DOTNET_RULES,
  PYTHON_RULES,
  NODE_RULES,
];

/** Convenience: the full entry-tagging section as it ships in the prompt. */
export const ENTRY_GUIDANCE_SECTION = composeEntryGuidance([...REGISTERED_LANGUAGES]);
