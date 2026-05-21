import type { EntryKind } from '../../shared/types';

/**
 * Detection guidance for one language/runtime family (.NET, Python, Node, …).
 *
 * Each language module owns its own per-kind triggers — when we add Go or
 * Ruby, we drop a new file in `rules/` and register it with the composer,
 * without touching the universal hardening rules or the prompt text.
 *
 * The `kinds` map is intentionally partial: a language can opt out of a
 * kind that doesn't apply (e.g. no `worker` story for a frontend-only
 * language) by omitting the key.
 *
 * Triggers are plain markdown text; the composer wraps them with the kind
 * heading. Keep each trigger as one sentence ending with a period — the
 * composer will append `entry_meta`-fill instructions in the parent prompt
 * via the universal sections, so individual language entries should focus
 * on *what to look for*, not *what to emit*.
 */
export interface LanguageRuleSet {
  /** Stable identifier — never shown to the LLM, used in tests. */
  family: string;
  /** Section header shown to the LLM, e.g. `.NET / C#`. */
  displayName: string;
  /** Detection triggers per entry kind. Missing keys mean "skip this kind". */
  kinds: Partial<Record<EntryKind, string>>;
}

/**
 * Canonical order entry kinds appear in the composed prompt. Keeping a
 * single order shared across the composer + the `/entries` responder
 * keeps the rendered guidance deterministic for snapshot tests.
 */
export const ENTRY_KIND_ORDER: readonly EntryKind[] = [
  'http_endpoint',
  'cli_main',
  'worker',
  'sample',
  'public_api',
];
