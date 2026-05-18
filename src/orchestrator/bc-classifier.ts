/**
 * Bounded context classifier.
 *
 * Repo-level codemap groups class nodes into buckets so the UI can color them
 * by domain. We pick the bucket heuristically from the file path — we explicitly
 * do not use an LLM here (see v3 plan §5.5), because every classifier output is
 * either visible to the user (color group) or feeds eval (golden samples key on
 * boundedContext), and we want it deterministic and explainable.
 *
 * Rules (first match wins):
 *   1. .NET / C#:  Lumen.Modules.<Name>      → "<name>"  (e.g. capture, recall)
 *                  Lumen.Shared.*            → "shared"
 *                  Lumen.Host                → "host"
 *   2. Monorepo:   packages/<name>/...       → "<name>"
 *                  apps/<name>/...           → "<name>"
 *   3. Top-level:  src/<name>/...            → "<name>"
 *   4. Fallback:   anything else             → "shared"
 *
 * The result is lowercased, hyphens collapsed to underscores so it can be a
 * safe CSS class. Callers can opt to cap to ≤ N color groups by passing
 * `paletteCap`; anything beyond the cap collapses to "shared".
 */

export interface BcClassification {
  bucket: string;
  /** Which rule matched, for debugging / explainability. */
  rule: 'lumen_module' | 'lumen_shared' | 'lumen_host' | 'monorepo_package' | 'monorepo_app' | 'src_root' | 'fallback';
}

const LUMEN_MODULE_RE = /(?:^|[\/\\])Lumen\.Modules\.([A-Za-z0-9]+)(?:[\/\\.]|$)/;
const LUMEN_SHARED_RE = /(?:^|[\/\\])Lumen\.Shared\./;
const LUMEN_HOST_RE = /(?:^|[\/\\])Lumen\.Host(?:[\/\\.]|$)/;
const MONOREPO_PACKAGES_RE = /(?:^|[\/\\])packages[\/\\]([^\/\\]+)[\/\\]/;
const MONOREPO_APPS_RE = /(?:^|[\/\\])apps[\/\\]([^\/\\]+)[\/\\]/;
const SRC_ROOT_RE = /(?:^|[\/\\])src[\/\\]([^\/\\]+)[\/\\]/;

export function classify(file: string): BcClassification {
  const m1 = LUMEN_MODULE_RE.exec(file);
  if (m1) return { bucket: normalize(m1[1]!), rule: 'lumen_module' };

  if (LUMEN_HOST_RE.test(file)) return { bucket: 'host', rule: 'lumen_host' };
  if (LUMEN_SHARED_RE.test(file)) return { bucket: 'shared', rule: 'lumen_shared' };

  // Order matters: apps/... is more specific than src/<dir> because monorepo
  // checkouts often have src/ inside each app.
  const m2 = MONOREPO_PACKAGES_RE.exec(file);
  if (m2) return { bucket: normalize(m2[1]!), rule: 'monorepo_package' };

  const m3 = MONOREPO_APPS_RE.exec(file);
  if (m3) return { bucket: normalize(m3[1]!), rule: 'monorepo_app' };

  const m4 = SRC_ROOT_RE.exec(file);
  if (m4) return { bucket: normalize(m4[1]!), rule: 'src_root' };

  return { bucket: 'shared', rule: 'fallback' };
}

function normalize(raw: string): string {
  return raw.toLowerCase().replace(/-/g, '_').replace(/[^a-z0-9_]/g, '');
}

/**
 * Bucket a batch of files, then cap to at most {@link paletteCap} distinct
 * buckets. Buckets beyond the cap collapse into "shared". When two classes
 * disagree on the same bucket due to file casing or alias paths, the first
 * occurrence wins.
 */
export function bucketAll(
  files: string[],
  paletteCap = 4,
): { file: string; bucket: string }[] {
  const raw = files.map(f => ({ file: f, bucket: classify(f).bucket }));

  // Count occurrences, pick the top {paletteCap-1} buckets (we always reserve
  // a slot for "shared") and collapse the rest.
  const counts = new Map<string, number>();
  for (const r of raw) counts.set(r.bucket, (counts.get(r.bucket) ?? 0) + 1);

  const keep = new Set<string>(['shared']);
  for (const [b] of [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, paletteCap - 1)) {
    keep.add(b);
  }

  return raw.map(r => ({
    file: r.file,
    bucket: keep.has(r.bucket) ? r.bucket : 'shared',
  }));
}
