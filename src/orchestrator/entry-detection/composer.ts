// Phase 3.2 -- composes the Entry-point tagging section of SYSTEM_PROMPT
// (port of legacy/src/llm/entry-detection/composer.ts, rewritten to use
// camelCase field names matching v2 types).

import type { LanguageRuleSet } from './types';
import { ENTRY_KIND_ORDER } from './types';
import {
  UNIVERSAL_NEGATIVES,
  PUBLIC_API_HARDENING,
  SYNTHESIZED_PROGRAM_RULE,
  ENTRY_META_FIELD_RULE,
  WORKSPACE_HINTS_RULE,
  INTERNAL_NAMESPACE_RULE,
} from './universal';

const ENTRY_KIND_LABEL: Record<(typeof ENTRY_KIND_ORDER)[number], string> = {
  http_endpoint: '`http_endpoint`',
  cli_main: '`cli_main`',
  worker: '`worker`',
  sample: '`sample`',
  public_api: '`public_api`',
};

/**
 * Build the `### Entry-point tagging` section of SYSTEM_PROMPT from a
 * list of per-language rule sets + the six universal rule blocks.
 *
 * Output is stable for snapshot tests: rule sets render in the order
 * they're passed in, kinds within a language render in
 * {@link ENTRY_KIND_ORDER}, and the universal blocks always come last in
 * a fixed order. This keeps the system-prompt SHA stable so callers can
 * fingerprint it without flake.
 */
export function composeEntryGuidance(languages: LanguageRuleSet[]): string {
  if (languages.length === 0) {
    throw new Error('composeEntryGuidance: at least one language rule set required');
  }

  const sections: string[] = [];

  sections.push(`### Entry-point tagging (\`isEntry\` / \`entryKind\` / \`entryMeta\`)

A class is an **entry-point** when the reader would pick it as the start of a call chain rather than discover it by following an inbound edge. The Entries panel uses these tags to list user-callable starting points; tagging does NOT change the graph topology. Default to \`isEntry: false\` (or omit the field).

Set \`isEntry: true\` only when one of the per-language triggers below matches AND none of the universal negative rules applies. When you set \`isEntry: true\`, also set \`entryKind\` (one of \`http_endpoint\` / \`cli_main\` / \`worker\` / \`sample\` / \`public_api\`) and optionally \`entryMeta\` with the appropriate field per the mapping table.`);

  sections.push('#### Detection by language\n');
  for (const lang of languages) {
    const lines: string[] = [`##### ${lang.displayName}`, ''];
    for (const kind of ENTRY_KIND_ORDER) {
      const trigger = lang.kinds[kind];
      if (!trigger) continue;
      lines.push(`- **${ENTRY_KIND_LABEL[kind]}** -- ${trigger}`);
    }
    sections.push(lines.join('\n'));
  }

  sections.push('#### Universal rules (override per-language triggers when in conflict)\n');
  sections.push(UNIVERSAL_NEGATIVES);
  sections.push(PUBLIC_API_HARDENING);
  sections.push(SYNTHESIZED_PROGRAM_RULE);
  sections.push(ENTRY_META_FIELD_RULE);
  sections.push(WORKSPACE_HINTS_RULE);
  sections.push(INTERNAL_NAMESPACE_RULE);

  return sections.join('\n\n');
}
