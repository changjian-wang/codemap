/**
 * Universal entry-tagging rules that apply to every language.
 *
 * These exist as separate exports so the composer can render them once at
 * the end of the per-language section, instead of repeating the same
 * "don't tag *Service" / "synthesize Program for top-level statements"
 * guidance under each language. Two consequences:
 *
 *   1. Adding a new language is one new file in `rules/` — no copy-paste
 *      of universal rules, so they can't drift.
 *   2. When we want to tweak the public_api hardening (say, "also exclude
 *      `tools/` directories"), there is exactly one place to edit.
 */

/**
 * Markdown block: when to *never* tag `is_entry: true`, regardless of
 * language. Mirrors the negative DO-NOT list from v3.5 but adds the
 * "*Runner whose only caller is Program" rule that the lumen review
 * surfaced (MigrationRunner / DapperConfiguration were tagged public_api
 * because their only consumer was Program.cs — that's startup plumbing,
 * not user-facing surface).
 */
export const UNIVERSAL_NEGATIVES = `Never tag \`is_entry: true\` on any of these, regardless of language:

- \`*Service\`, \`*Repository\`, \`*Store\`, \`*Handler\` (internal handlers): they have an entry caller above them; tagging them clutters the panel.
- DTOs, records, entities, configs, options POCOs, value objects.
- \`*Builder\`, \`*Mapper\`, \`*Helper\`, \`*Resolver\`, \`*Extractor\`, \`*Adapter\` (one-shot helpers and converters).
- Test classes, test fixtures, anything under \`test/\` / \`tests/\` / \`*.Tests/\`.
- A \`*Runner\` / \`*Configuration\` / \`*Initializer\` whose only caller is the program entry — it's bootstrap plumbing, not a user-facing entry. \`Program\` already owns that role; do not double-count.

When in doubt, set \`is_entry: false\`. False negatives are cheap (the class is still reachable through the Overview view); false positives clutter the Entries panel with non-callable noise.`;

/**
 * Markdown block: tight constraints on `public_api`. The lumen review
 * exposed that without an explicit "outside apps/" rule, the LLM tagged
 * every `*ModuleServiceCollectionExtensions.cs` in `apps/api/src/...` as
 * public_api, because they are technically `public static` extension
 * methods. The hardening below pins down the three conditions that
 * actually distinguish a library surface from app-internal DI wiring.
 */
export const PUBLIC_API_HARDENING = `**Public API hardening (overrides per-language \`public_api\` triggers)**

A class is \`public_api\` ONLY when ALL three of the following hold:

1. **Outside \`apps/\`** — the file path does not contain a segment named \`apps\`. Classes inside \`apps/\` are app-internal regardless of how public their methods look; they belong to a deployable, not to an SDK surface.
2. **No same-workspace caller** — no other class in this workspace calls into the class. If the only consumer is \`Program.cs\` or another app entry, it is startup plumbing, not a library surface.
3. **Stable consumer-facing surface** — the class exposes \`public static\` extension methods, a factory, or a facade that an outside consumer (NuGet package user, pip install user, npm consumer) would call.

Concrete examples that are **NOT** \`public_api\` (you must tag these \`is_entry: false\`):

- \`apps/api/src/Lumen.Modules.Capture/CaptureModuleServiceCollectionExtensions.cs\` — app-internal DI wiring, called by the host \`Program\`.
- \`apps/api/src/Lumen.Shared.Infrastructure/Persistence/MigrationRunner.cs\` — bootstrap helper, single caller is \`Program\`.
- \`apps/api/src/Lumen.Shared.Infrastructure/Persistence/DapperConfiguration.cs\` — startup-only configuration.
- Any \`apps/web/src/.../setupRoutes.ts\` — app-internal routing setup, not a library export.`;

/**
 * Markdown block: how to synthesize a Program node when the file is a
 * program entry but has no enclosing class (C# top-level statements,
 * Python `__main__` blocks, Go `package main` with `func main`, etc.).
 *
 * Without this rule, the v3.5 spike missed both Program.cs files in the
 * lumen review — recall 67% — because they use top-level statements and
 * the LLM had no class to attach `is_entry` to.
 *
 * The synthesized node is intentionally low-confidence (0.85 + a
 * `low_confidence` risk) so the calibrator marks it `partial` and a
 * reader can spot that it was synthesized rather than a real class.
 * Verification will fail (no LSP symbol named \`<Folder>.Program\`) which
 * keeps it as a ghost node — that's accepted; the entry tag is the
 * goal, not the verification badge.
 */
export const SYNTHESIZED_PROGRAM_RULE = `**Synthesized Program for top-level statements**

When a file is the program entry but has NO enclosing class — C# \`Program.cs\` with top-level statements, Python \`__main__.py\` or a module ending in \`if __name__ == "__main__":\`, Go file with \`package main\` + \`func main()\` — emit ONE synthesized type block with:

- \`node_id\`:
  * C#: \`"<ProjectFolder>.Program"\` — derive ProjectFolder from the parent directory name (e.g. for \`apps/api/src/Lumen.Host/Program.cs\` use \`"Lumen.Host.Program"\`; for \`apps/api/src/Lumen.Eval/Program.cs\` use \`"Lumen.Eval.Program"\`). This avoids id collisions when a repo has multiple Program.cs.
  * Python: the package dotted name, e.g. \`"lumen.cli"\` for \`lumen/cli/__main__.py\`.
  * Go: \`"<dir>.main"\`, e.g. \`"cmd/server.main"\`.
- \`kind\`: \`"class"\`.
- \`range\`: \`{ "startLine": 1, "endLine": <last line of file> }\`.
- \`is_entry\`: \`true\`.
- \`entry_kind\`:
  * \`"cli_main"\` when the file builds an HTTP host (\`WebApplication.CreateBuilder\`, \`Host.CreateDefaultBuilder\`) — yes, ASP.NET Core hosts are cli_main here; the Entries panel groups them under "Hosts" via the route metadata you add.
  * \`"cli_main"\` for command-line entries.
- \`entry_meta\`: omit \`routes\` (the routes are wired by separate Endpoint classes, not by Program itself).
- \`confidence\`: \`0.85\`.
- \`risks\`: include \`{ "type": "low_confidence", "desc": "synthesized from top-level statements" }\` so the calibrator records it.

Only synthesize ONE Program block per file. If the file ALSO declares a real \`class Program\` (no top-level statements), use the real class and skip the synthesis.`;

/**
 * Markdown block: strict mapping of `entry_meta` fields to kinds. The
 * v3.5 spike showed `EvalHostBuilder` tagged as `cli_main` with
 * `sampleName: "EvalHostBuilder"` — the LLM filled `sampleName` on a
 * non-sample kind. The calibrator now strips invalid pairings, but
 * spelling the rule out keeps the LLM from generating them in the first
 * place (and saves tokens we'd otherwise waste on bogus meta).
 */
export const ENTRY_META_FIELD_RULE = `**\`entry_meta\` field-to-kind mapping (strict)**

Each \`entry_meta\` field belongs to exactly one \`entry_kind\`. The calibrator drops fields that don't match — but emitting them costs tokens and reads as confused output, so don't:

| Field         | Allowed only when \`entry_kind\` is |
| ------------- | ----------------------------------- |
| \`routes\`      | \`http_endpoint\`                     |
| \`commands\`    | \`cli_main\`                          |
| \`sampleName\`  | \`sample\`                            |
| \`publicApis\`  | \`public_api\`                        |

If the appropriate field is empty (e.g. a \`cli_main\` with no defined subcommands), omit \`entry_meta\` entirely instead of emitting an empty object.`;
/**
 * Markdown block: how to use the workspace-scanner hints that v3.7 inlines
 * into the user message (boundedContext / isEntryPoint / inboundImports).
 *
 * The scanner already knows who imports this file — when it does, the LLM
 * does NOT have to guess. The previous spike's biggest precision loss
 * came from public_api hallucinations on classes that were obviously
 * called from `Program.cs`; the LLM just couldn't see Program.cs.
 *
 * Three hard rules:
 *   1. Non-empty `inboundImports` → cannot be `public_api`. Full stop.
 *      It's an internal class consumed by other files in the workspace.
 *   2. `isEntryPoint: yes` + the file has no class declaration → MUST
 *      synthesize a Program node (per SYNTHESIZED_PROGRAM_RULE).
 *   3. `inboundImports` not provided → treat call graph as unknown; fall
 *      back to the per-language triggers + UNIVERSAL_NEGATIVES.
 */
export const WORKSPACE_HINTS_RULE = `**Using the workspace hints in the user message**

The user message may include three structured hints before the source block: \`Bounded context\`, \`Entry-point filename match\`, and \`Inbound imports (workspace scan)\`. These come from a deterministic static scan, not heuristics — trust them.

Hard rules when hints are present:

- **\`Inbound imports (workspace scan)\` is non-empty** → the class is consumed by other files in the workspace, so it CANNOT be \`public_api\` (which requires zero in-workspace callers). It is an internal collaborator. If you would otherwise pick \`public_api\`, downgrade to \`is_entry: false\` OR pick a different kind that doesn't require workspace isolation (\`http_endpoint\`, \`cli_main\`, \`worker\`, \`sample\` are all compatible with being called from elsewhere).
- **\`Inbound imports (workspace scan): none\`** → the class is NOT statically referenced by other skeleton files. This is a *necessary* condition for \`public_api\` (but not sufficient — the Public API hardening rule still applies, including the \`apps/\` exclusion).
- **\`Entry-point filename match: yes\`** + the source has no top-level class declaration (only top-level statements / a \`main()\` function) → you MUST synthesize a Program node per the Synthesized Program rule above. Do not skip the file.
- **No hints present** → treat the call graph as unknown; fall back to the per-language triggers and the universal negatives.

The hints never override the universal negatives: a \`*Service\` / \`*Repository\` / \`*Helper\` is still not an entry point even if its filename matches a pattern.`;