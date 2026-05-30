// Phase 3.2 -- entry-detection composer + registry sanity.

import { describe, expect, it } from 'vitest';
import {
  composeEntryGuidance,
  DOTNET_RULES,
  NODE_RULES,
  PYTHON_RULES,
  REGISTERED_LANGUAGES,
  ENTRY_GUIDANCE_SECTION,
} from '../../../src/orchestrator/entry-detection';
import { SYSTEM_PROMPT } from '../../../src/orchestrator/analyzer-prompt';

describe('composeEntryGuidance()', () => {
  it('throws when no languages are passed', () => {
    expect(() => composeEntryGuidance([])).toThrow(/at least one language/);
  });

  it('renders the section header + per-language headings + 6 universal rule blocks', () => {
    const md = composeEntryGuidance([DOTNET_RULES, PYTHON_RULES, NODE_RULES]);
    expect(md).toMatch(/### Entry-point tagging/);
    expect(md).toMatch(/##### \.NET \/ C#/);
    expect(md).toMatch(/##### Python/);
    expect(md).toMatch(/##### Node\.js \/ TypeScript/);
    // Universal rule markers (one phrase per block).
    expect(md).toMatch(/Never tag `isEntry: true`/);
    expect(md).toMatch(/Public API hardening/);
    expect(md).toMatch(/Synthesized Program/);
    expect(md).toMatch(/`entryMeta` field-to-kind mapping/);
    expect(md).toMatch(/workspace hints in the user message/i);
    expect(md).toMatch(/Internal namespace roots/);
  });

  it('renders languages in the order passed, kinds in ENTRY_KIND_ORDER', () => {
    const md = composeEntryGuidance([NODE_RULES, DOTNET_RULES]);
    const nodeIdx = md.indexOf('##### Node.js / TypeScript');
    const dotnetIdx = md.indexOf('##### .NET / C#');
    expect(nodeIdx).toBeGreaterThan(-1);
    expect(dotnetIdx).toBeGreaterThan(-1);
    expect(nodeIdx).toBeLessThan(dotnetIdx);
    // http_endpoint must come before cli_main inside the dotnet block.
    const dotnetSection = md.slice(dotnetIdx);
    expect(dotnetSection.indexOf('`http_endpoint`'))
      .toBeLessThan(dotnetSection.indexOf('`cli_main`'));
  });

  it('is deterministic for the same inputs', () => {
    const a = composeEntryGuidance([DOTNET_RULES, PYTHON_RULES, NODE_RULES]);
    const b = composeEntryGuidance([DOTNET_RULES, PYTHON_RULES, NODE_RULES]);
    expect(a).toBe(b);
  });
});

describe('REGISTERED_LANGUAGES / ENTRY_GUIDANCE_SECTION', () => {
  it('registers the three v4 baseline languages', () => {
    expect(REGISTERED_LANGUAGES.map((l) => l.family)).toEqual(['dotnet', 'python', 'node']);
  });

  it('is embedded verbatim into SYSTEM_PROMPT', () => {
    expect(SYSTEM_PROMPT).toContain(ENTRY_GUIDANCE_SECTION);
  });
});
