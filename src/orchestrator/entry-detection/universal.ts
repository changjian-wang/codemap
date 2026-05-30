// Phase 3.2 -- universal entry-tagging rules
// (verbatim port of legacy/src/llm/entry-detection/universal.ts).
//
// These exist as separate exports so the composer can render them once
// at the end of the per-language section, instead of repeating the same
// "don't tag *Service" / "synthesize Program for top-level statements"
// guidance under each language.

export const UNIVERSAL_NEGATIVES = `Never tag \`isEntry: true\` on any of these, regardless of language:

- \`*Service\`, \`*Repository\`, \`*Store\`, \`*Handler\` (internal handlers): they have an entry caller above them; tagging them clutters the panel.
- DTOs, records, entities, configs, options POCOs, value objects.
- \`*Builder\`, \`*Mapper\`, \`*Helper\`, \`*Resolver\`, \`*Extractor\`, \`*Adapter\` (one-shot helpers and converters).
- Test classes, test fixtures, anything under \`test/\` / \`tests/\` / \`*.Tests/\`.
- A \`*Runner\` / \`*Configuration\` / \`*Initializer\` whose only caller is the program entry -- it's bootstrap plumbing, not a user-facing entry. \`Program\` already owns that role; do not double-count.

When in doubt, set \`isEntry: false\` (or omit the field). False negatives are cheap (the class is still reachable through the Overview view); false positives clutter the Entries panel with non-callable noise.`;

export const PUBLIC_API_HARDENING = `**Public API hardening (overrides per-language \`public_api\` triggers)**

A class is \`public_api\` ONLY when ALL three of the following hold:

1. **Outside \`apps/\`** -- the file path does not contain a segment named \`apps\`. Classes inside \`apps/\` are app-internal regardless of how public their methods look; they belong to a deployable, not to an SDK surface.
2. **No same-workspace caller** -- no other class in this workspace calls into the class. If the only consumer is \`Program.cs\` or another app entry, it is startup plumbing, not a library surface.
3. **Stable consumer-facing surface** -- the class exposes \`public static\` extension methods, a factory, or a facade that an outside consumer (NuGet package user, pip install user, npm consumer) would call.

Concrete examples that are **NOT** \`public_api\` (you must tag these \`isEntry: false\`):

- \`apps/api/src/Lumen.Modules.Capture/CaptureModuleServiceCollectionExtensions.cs\` -- app-internal DI wiring, called by the host \`Program\`.
- \`apps/api/src/Lumen.Shared.Infrastructure/Persistence/MigrationRunner.cs\` -- bootstrap helper, single caller is \`Program\`.
- \`apps/api/src/Lumen.Shared.Infrastructure/Persistence/DapperConfiguration.cs\` -- startup-only configuration.
- Any \`apps/web/src/.../setupRoutes.ts\` -- app-internal routing setup, not a library export.`;

export const SYNTHESIZED_PROGRAM_RULE = `**Synthesized Program for top-level statements**

When a file is the program entry but has NO enclosing class -- C# \`Program.cs\` with top-level statements, Python \`__main__.py\` or a module ending in \`if __name__ == "__main__":\`, Go file with \`package main\` + \`func main()\` -- emit ONE synthesized type block with:

- \`id\`:
  * C#: \`"<ProjectFolder>.Program"\` -- derive ProjectFolder from the parent directory name (e.g. for \`apps/api/src/Lumen.Host/Program.cs\` use \`"Lumen.Host.Program"\`; for \`apps/api/src/Lumen.Eval/Program.cs\` use \`"Lumen.Eval.Program"\`). This avoids id collisions when a repo has multiple Program.cs.
  * Python: the package dotted name, e.g. \`"lumen.cli"\` for \`lumen/cli/__main__.py\`.
  * Go: \`"<dir>.main"\`, e.g. \`"cmd/server.main"\`.
- \`kind\`: \`"class"\`.
- \`range\`: \`{ "startLine": 1, "endLine": <last line of file> }\`.
- \`isEntry\`: \`true\`.
- \`entryKind\`:
  * \`"cli_main"\` when the file builds an HTTP host (\`WebApplication.CreateBuilder\`, \`Host.CreateDefaultBuilder\`) -- yes, ASP.NET Core hosts are cli_main here; the Entries panel groups them under "Hosts" via the route metadata you add.
  * \`"cli_main"\` for command-line entries.
- \`entryMeta\`: omit \`routes\` (the routes are wired by separate Endpoint classes, not by Program itself).
- \`confidence\`: \`0.85\`.
- \`risks\`: include \`{ "type": "low_confidence", "desc": "synthesized from top-level statements" }\` so downstream passes record it.

Only synthesize ONE Program block per file. If the file ALSO declares a real \`class Program\` (no top-level statements), use the real class and skip the synthesis.`;

export const ENTRY_META_FIELD_RULE = `**\`entryMeta\` field-to-kind mapping (strict)**

Each \`entryMeta\` field belongs to exactly one \`entryKind\`. Downstream passes drop fields that don't match -- but emitting them costs tokens and reads as confused output, so don't:

| Field         | Allowed only when \`entryKind\` is |
| ------------- | --------------------------------- |
| \`routes\`      | \`http_endpoint\`                   |
| \`commands\`    | \`cli_main\`                        |
| \`sampleName\`  | \`sample\`                          |
| \`publicApis\`  | \`public_api\`                      |

If the appropriate field is empty (e.g. a \`cli_main\` with no defined subcommands), omit \`entryMeta\` entirely instead of emitting an empty object.`;

export const WORKSPACE_HINTS_RULE = `**Using the workspace hints in the user message**

The user message may include four structured hints before the source block: \`Bounded context\`, \`Entry-point filename match\`, \`Inbound imports (workspace scan)\`, and \`Internal namespace roots\`. These come from a deterministic static scan, not heuristics -- trust them.

Hard rules when hints are present:

- **\`Inbound imports (workspace scan)\` is non-empty** -> the class is consumed by other files in the workspace, so it CANNOT be \`public_api\` (which requires zero in-workspace callers). It is an internal collaborator. If you would otherwise pick \`public_api\`, downgrade to \`isEntry: false\` OR pick a different kind that doesn't require workspace isolation (\`http_endpoint\`, \`cli_main\`, \`worker\`, \`sample\` are all compatible with being called from elsewhere).
- **\`Inbound imports (workspace scan): none\`** -> the class is NOT statically referenced by other skeleton files. This is a *necessary* condition for \`public_api\` (but not sufficient -- the Public API hardening rule still applies, including the \`apps/\` exclusion).
- **\`Entry-point filename match: yes\`** + the source has no top-level class declaration (only top-level statements / a \`main()\` function) -> you MUST synthesize a Program node per the Synthesized Program rule above. Do not skip the file.
- **No hints present** -> treat the call graph as unknown; fall back to the per-language triggers and the universal negatives.

The hints never override the universal negatives: a \`*Service\` / \`*Repository\` / \`*Helper\` is still not an entry point even if its filename matches a pattern.`;

export const INTERNAL_NAMESPACE_RULE = `**Using \`Internal namespace roots\`**

When the user message lists \`Internal namespace roots (workspace-defined, NOT external): A, B, C\`, every type whose fully-qualified name starts with one of those roots is part of THIS workspace, not an external SDK / package. Hard rules:

- **Never emit \`ext:<Root>.*\`** in cross-file references for any listed root. If you would have emitted \`ext:Lumen.Modules.Capture.AssemblyMarker\` and \`Lumen\` is listed, drop the \`ext:\` prefix and the namespace path -- emit just \`AssemblyMarker\` (downstream resolves it to the workspace node, or drops it if it doesn't exist). The same goes for nested cases: \`Lumen.Shared.Infrastructure.Persistence.MigrationRunner\` with \`Lumen\` listed -> \`MigrationRunner\`.
- **Cross-namespace references inside the workspace are still in scope** -- a class in \`Lumen.Modules.Capture\` that calls into \`Lumen.Shared.Infrastructure.Persistence\` is still calling workspace code; emit the bare type name, not \`ext:Lumen.*\`.
- **The rule is a strict prefix match.** \`ext:Lumens.Foo\` (with the trailing \`s\`) is NOT covered by \`Lumen\`; \`ext:Microsoft.Lumen.X\` is NOT covered by \`Lumen\` because \`Microsoft\` is the first segment. Only the leading segment counts.
- **No roots listed** (or no hint present at all) -> fall back to your normal \`ext:\` decisions for \`using\` / \`import\` based types.

This rule only changes the **prefix** used in cross-file references -- it does not change which types you list. If you would have omitted a type as too trivial (a BCL primitive, framework plumbing per the existing skip list), still omit it.`;
