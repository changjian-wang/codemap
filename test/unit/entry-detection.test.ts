import { describe, it, expect } from 'vitest';
import { composeEntryGuidance, ENTRY_KIND_ORDER } from '../../src/llm/entry-detection';
import { DOTNET_RULES } from '../../src/llm/entry-detection/rules/dotnet';
import { PYTHON_RULES } from '../../src/llm/entry-detection/rules/python';
import { NODE_RULES } from '../../src/llm/entry-detection/rules/node';
import type { LanguageRuleSet } from '../../src/llm/entry-detection/types';
import { SYSTEM_PROMPT, PROMPT_VERSION, buildUserMessage } from '../../src/llm/prompts';

describe('entry-detection composer', () => {
  it('throws when no language rule sets are supplied', () => {
    expect(() => composeEntryGuidance([])).toThrow(/at least one/);
  });

  it('renders one section per registered language in input order', () => {
    const out = composeEntryGuidance([DOTNET_RULES, PYTHON_RULES, NODE_RULES]);
    const dotnetAt = out.indexOf('##### .NET / C#');
    const pythonAt = out.indexOf('##### Python');
    const nodeAt = out.indexOf('##### Node.js / TypeScript');
    expect(dotnetAt).toBeGreaterThan(-1);
    expect(pythonAt).toBeGreaterThan(dotnetAt);
    expect(nodeAt).toBeGreaterThan(pythonAt);
  });

  it('omits a kind block when the language does not declare it', () => {
    const minimal: LanguageRuleSet = {
      family: 'frontend-only',
      displayName: 'Frontend-only test fixture',
      kinds: { http_endpoint: 'Trigger A.' },
    };
    const out = composeEntryGuidance([minimal]);
    expect(out).toContain('Trigger A.');
    // Other kinds shouldn't appear under this language's heading.
    const section = out.slice(out.indexOf('##### Frontend-only test fixture'));
    const nextHeading = section.indexOf('####', 1);
    const langScope = nextHeading > 0 ? section.slice(0, nextHeading) : section;
    expect(langScope).not.toContain('**`cli_main`**');
    expect(langScope).not.toContain('**`worker`**');
    expect(langScope).not.toContain('**`public_api`**');
  });

  it('renders kinds within a language in canonical order', () => {
    const out = composeEntryGuidance([DOTNET_RULES]);
    const order = ENTRY_KIND_ORDER.map(k => `**\`${k}\`**`).map(label => out.indexOf(label));
    const presentInOrder = order.filter(i => i >= 0);
    const sorted = [...presentInOrder].sort((a, b) => a - b);
    expect(presentInOrder).toEqual(sorted);
  });

  it('emits the four universal rule blocks after the language sections', () => {
    const out = composeEntryGuidance([DOTNET_RULES]);
    const langAt = out.indexOf('##### .NET / C#');
    expect(out.indexOf('Never tag `is_entry: true` on any of these')).toBeGreaterThan(langAt);
    expect(out.indexOf('**Public API hardening')).toBeGreaterThan(langAt);
    expect(out.indexOf('**Synthesized Program for top-level statements**')).toBeGreaterThan(langAt);
    expect(out.indexOf('**`entry_meta` field-to-kind mapping (strict)**')).toBeGreaterThan(langAt);
  });
});

describe('SYSTEM_PROMPT integration', () => {
  it('embeds the composed entry-guidance section', () => {
    expect(SYSTEM_PROMPT).toContain('### Entry-point tagging');
    expect(SYSTEM_PROMPT).toContain('##### .NET / C#');
    expect(SYSTEM_PROMPT).toContain('##### Python');
    expect(SYSTEM_PROMPT).toContain('##### Node.js / TypeScript');
  });

  it('includes the public_api hardening block (fixes v3.5 false positives)', () => {
    expect(SYSTEM_PROMPT).toContain('Outside `apps/`');
    expect(SYSTEM_PROMPT).toContain('CaptureModuleServiceCollectionExtensions');
    expect(SYSTEM_PROMPT).toContain('MigrationRunner');
  });

  it('includes the synthesized Program rule (fixes v3.5 Program.cs recall)', () => {
    expect(SYSTEM_PROMPT).toContain('Synthesized Program');
    expect(SYSTEM_PROMPT).toContain('Lumen.Host.Program');
    expect(SYSTEM_PROMPT).toContain('top-level statements');
  });

  it('declares PROMPT_VERSION v3.7', () => {
    expect(PROMPT_VERSION).toBe('v3.7');
  });

  it('includes the workspace-hints rule (fixes v3.6 cross-file blindness)', () => {
    expect(SYSTEM_PROMPT).toContain('Using the workspace hints in the user message');
    expect(SYSTEM_PROMPT).toContain('CANNOT be `public_api`');
    expect(SYSTEM_PROMPT).toContain('Inbound imports (workspace scan)');
  });
});

describe('language rule set invariants', () => {
  it.each([
    ['dotnet', DOTNET_RULES],
    ['python', PYTHON_RULES],
    ['node', NODE_RULES],
  ] as const)('%s declares at least http_endpoint and cli_main', (_name, set) => {
    expect(set.kinds.http_endpoint).toBeTruthy();
    expect(set.kinds.cli_main).toBeTruthy();
  });

  it('dotnet public_api guidance references the apps/ exclusion', () => {
    expect(DOTNET_RULES.kinds.public_api).toMatch(/apps\//);
  });

  it('all triggers are single-paragraph markdown (no headings or fences)', () => {
    const all = [DOTNET_RULES, PYTHON_RULES, NODE_RULES];
    for (const set of all) {
      for (const [_kind, text] of Object.entries(set.kinds)) {
        if (!text) continue;
        expect(text).not.toMatch(/^#{1,6}\s/m);
        expect(text).not.toContain('```');
      }
    }
  });
});

describe('buildUserMessage (v3.7 hints)', () => {
  const src = 'public class Foo {}';

  it('renders just the file + source block when no hints are passed', () => {
    const out = buildUserMessage('src/Foo.cs', src);
    expect(out).toBe(
      `File: src/Foo.cs\n\n\`\`\`\n${src}\n\`\`\``,
    );
  });

  it('emits bounded context line when supplied', () => {
    const out = buildUserMessage('src/Foo.cs', src, { boundedContext: 'capture' });
    expect(out).toContain('Bounded context: capture');
  });

  it('emits entry-point hint only when true', () => {
    const yes = buildUserMessage('src/Foo.cs', src, { isEntryPoint: true });
    const no = buildUserMessage('src/Foo.cs', src, { isEntryPoint: false });
    expect(yes).toContain('Entry-point filename match: yes');
    expect(no).not.toContain('Entry-point filename match');
  });

  it('emits "none" line when inboundImports is an empty array (scan ran, found nothing)', () => {
    const out = buildUserMessage('src/Foo.cs', src, { inboundImports: [] });
    expect(out).toContain('Inbound imports (workspace scan): none.');
  });

  it('lists callers when inboundImports is populated', () => {
    const callers = ['src/Bar.cs', 'src/Baz.cs', 'src/Qux.cs'];
    const out = buildUserMessage('src/Foo.cs', src, { inboundImports: callers });
    expect(out).toContain('Inbound imports (workspace scan, 3):');
    for (const c of callers) expect(out).toContain(`  - ${c}`);
  });

  it('truncates long inbound lists with a "... and N more" tail', () => {
    const callers = Array.from({ length: 35 }, (_, i) => `src/F${i}.cs`);
    const out = buildUserMessage('src/Foo.cs', src, { inboundImports: callers });
    expect(out).toContain('Inbound imports (workspace scan, 35):');
    expect(out).toContain('  - src/F0.cs');
    expect(out).toContain('  - src/F19.cs');
    expect(out).not.toContain('  - src/F20.cs');
    expect(out).toContain('  - ... and 15 more');
  });

  it('omits the inbound block entirely when undefined (no scan data)', () => {
    const out = buildUserMessage('src/Foo.cs', src, { boundedContext: 'capture' });
    expect(out).not.toContain('Inbound imports');
  });
});
