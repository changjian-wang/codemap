/**
 * Source-comment extractor.
 *
 * Pulls the leading documentation comment for a class or method directly
 * from the source file — no LLM in the loop, so this is verbatim author
 * text. Three flavours are recognised:
 *
 *   - Python triple-quoted docstrings (`"""..."""` / `'''...'''`) sitting
 *     on the line after `def`/`class`.
 *   - C# `///` runs immediately above the declaration.
 *   - Block comments (`/** ... *\/`) immediately above the declaration —
 *     covers TS, JS, Java, Go-style JSDoc.
 *
 * Anything we cannot match cleanly returns `undefined`; the UI then falls
 * back to the LLM's `intent` summary.
 */

export type DocLang = 'py' | 'csharp' | 'jsdoc' | 'unknown';

export function detectLang(file: string): DocLang {
  const lower = file.toLowerCase();
  if (lower.endsWith('.py')) return 'py';
  if (lower.endsWith('.cs')) return 'csharp';
  if (
    lower.endsWith('.ts') ||
    lower.endsWith('.tsx') ||
    lower.endsWith('.mts') ||
    lower.endsWith('.cts') ||
    lower.endsWith('.js') ||
    lower.endsWith('.jsx') ||
    lower.endsWith('.mjs') ||
    lower.endsWith('.cjs') ||
    lower.endsWith('.java')
  ) {
    return 'jsdoc';
  }
  return 'unknown';
}

export interface ExtractInput {
  fileText: string;
  /** 1-based line where the class/method declaration starts. */
  startLine: number;
  lang: DocLang;
}

/**
 * Returns the doc comment text with comment markers stripped, or
 * `undefined` if nothing recognisable is attached. The result is a
 * plain string with `\n` separators — let the UI handle wrapping.
 */
export function extractDocComment({ fileText, startLine, lang }: ExtractInput): string | undefined {
  if (lang === 'unknown' || startLine < 1) return undefined;
  const lines = fileText.split(/\r?\n/);
  // 0-based index of the declaration line itself.
  const declIdx = Math.min(Math.max(startLine - 1, 0), lines.length - 1);

  if (lang === 'py') return extractPyDocstring(lines, declIdx);
  if (lang === 'csharp') return extractCsharpDoc(lines, declIdx);
  return extractJsDoc(lines, declIdx);
}

// ---------- Python ----------

function extractPyDocstring(lines: string[], declIdx: number): string | undefined {
  // Walk forward to the next non-blank line after the declaration. Skip
  // continuation lines of the signature itself by detecting whether the
  // declaration is "open" (ends with `(` or `,`) and the next lines look
  // like params.
  let i = declIdx + 1;
  // Tolerate multi-line `def f(\n  ...\n):` signatures by scanning until we
  // see a line ending in `:` — that's the body anchor for the docstring.
  let signatureDepth = 0;
  const headLine = lines[declIdx] ?? '';
  if (/[(,]\s*$/.test(headLine.trim()) && !headLine.trim().endsWith(':')) {
    signatureDepth = 1;
  }
  while (signatureDepth > 0 && i < lines.length) {
    const t = (lines[i] ?? '').trim();
    if (t.endsWith(':')) {
      signatureDepth = 0;
      i++;
      break;
    }
    i++;
  }
  // Skip blank lines / line comments between declaration and docstring.
  while (i < lines.length) {
    const t = (lines[i] ?? '').trim();
    if (t === '' || t.startsWith('#')) {
      i++;
      continue;
    }
    break;
  }
  if (i >= lines.length) return undefined;

  const first = lines[i] ?? '';
  const trimmed = first.trimStart();
  const quote = trimmed.startsWith('"""') ? '"""' : trimmed.startsWith("'''") ? "'''" : '';
  if (!quote) return undefined;

  // Single-line docstring: `"""foo"""`.
  const afterOpen = trimmed.slice(3);
  if (afterOpen.includes(quote)) {
    const body = afterOpen.slice(0, afterOpen.indexOf(quote)).trim();
    return body || undefined;
  }

  // Multi-line: collect until closing triple-quote.
  const parts: string[] = [];
  if (afterOpen.trim()) parts.push(afterOpen.trimEnd());
  for (let j = i + 1; j < lines.length; j++) {
    const ln = lines[j] ?? '';
    const idx = ln.indexOf(quote);
    if (idx >= 0) {
      const last = ln.slice(0, idx).trimEnd();
      if (last) parts.push(last);
      break;
    }
    parts.push(ln.trimEnd());
  }
  return dedent(parts).trim() || undefined;
}

// ---------- C# /// ----------

function extractCsharpDoc(lines: string[], declIdx: number): string | undefined {
  // Walk upward skipping attribute lines like `[Foo]`, blank lines, and
  // non-doc comments. Collect contiguous `///` lines and stop at the first
  // non-doc, non-attribute, non-blank line.
  const collected: string[] = [];
  for (let i = declIdx - 1; i >= 0; i--) {
    const raw = lines[i] ?? '';
    const t = raw.trim();
    if (t.startsWith('///')) {
      collected.push(t.replace(/^\/{3}\s?/, ''));
      continue;
    }
    if (t === '' || t.startsWith('[') || t.startsWith('//')) {
      // Plain `//` comments aren't doc comments but stop the doc block.
      if (t.startsWith('//') && !t.startsWith('///')) break;
      continue;
    }
    break;
  }
  if (collected.length === 0) return undefined;
  // We collected bottom-up; reverse and strip XML tags lightly.
  const text = collected.reverse().join('\n');
  return stripCsharpXml(text).trim() || undefined;
}

function stripCsharpXml(s: string): string {
  // Keep the content but drop the most noisy tags. We deliberately do not
  // do a real XML parse — partial / malformed doc comments are common and
  // we'd rather show the raw text than throw.
  return s
    .replace(/<\/?summary>\s*/gi, '')
    .replace(/<\/?remarks>\s*/gi, '')
    .replace(/<\/?para>\s*/gi, '\n')
    .replace(/<see\s+cref="([^"]+)"\s*\/?>/gi, '`$1`')
    .replace(/<paramref\s+name="([^"]+)"\s*\/?>/gi, '`$1`')
    .replace(/<typeparamref\s+name="([^"]+)"\s*\/?>/gi, '`$1`')
    .replace(/<param\s+name="([^"]+)"\s*>/gi, '`$1`: ')
    .replace(/<\/param>\s*/gi, '\n');
}

// ---------- JSDoc / TSDoc / Javadoc ----------

function extractJsDoc(lines: string[], declIdx: number): string | undefined {
  // Walk upward skipping blank and decorator lines. We accept either a
  // `/** ... */` block or a contiguous run of `//` comments (less common
  // but legitimate for short types).
  let i = declIdx - 1;
  while (i >= 0) {
    const t = (lines[i] ?? '').trim();
    if (t === '' || t.startsWith('@')) {
      i--;
      continue;
    }
    break;
  }
  if (i < 0) return undefined;
  const endLine = (lines[i] ?? '').trim();

  if (endLine.endsWith('*/')) {
    // Single-line `/** ... */`: don't scan further or we may swallow
    // unrelated code above (e.g. class declaration, prior comments).
    if (endLine.startsWith('/**')) {
      return cleanJsBlock(endLine);
    }
    // Multi-line block: walk up until we find the matching `/**`. Stop if
    // we hit a non-comment, non-blank line — we'd rather miss a doc than
    // capture random code.
    const collected: string[] = [endLine];
    for (let j = i - 1; j >= 0; j--) {
      const ln = (lines[j] ?? '').trim();
      if (ln.startsWith('/**')) {
        collected.push(ln);
        break;
      }
      // Inside a block comment, lines normally start with `*` or are
      // continuations. Anything that doesn't look like comment body is a
      // signal that we've left the doc block.
      if (!ln.startsWith('*') && ln !== '') return undefined;
      collected.push(ln);
    }
    return cleanJsBlock(collected.reverse().join('\n'));
  }

  if (endLine.startsWith('//')) {
    const collected: string[] = [endLine.replace(/^\/{2,}\s?/, '')];
    for (let j = i - 1; j >= 0; j--) {
      const ln = (lines[j] ?? '').trim();
      if (!ln.startsWith('//')) break;
      collected.push(ln.replace(/^\/{2,}\s?/, ''));
    }
    return collected.reverse().join('\n').trim() || undefined;
  }
  return undefined;
}

function cleanJsBlock(block: string): string | undefined {
  // Drop the surrounding `/** ... */` and leading `* ` per line.
  const inner = block
    .replace(/^\/\*\*\s*/, '')
    .replace(/\s*\*\/\s*$/, '')
    .split(/\r?\n/)
    .map(ln => ln.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .trim();
  return inner || undefined;
}

// ---------- Helpers ----------

function dedent(parts: string[]): string {
  const nonEmpty = parts.filter(p => p.trim() !== '');
  if (nonEmpty.length === 0) return '';
  const indents = nonEmpty.map(p => p.match(/^(\s*)/)?.[1]?.length ?? 0);
  const minIndent = Math.min(...indents);
  return parts.map(p => p.slice(minIndent)).join('\n');
}

// ---------- Batch helpers ----------

/**
 * Shape we mutate in {@link hydrateDocComments}. Importing the real
 * CodeNode here would create a layering dependency on shared/types; the
 * structural type below is the minimum surface we need.
 */
interface DocHydratable {
  range: { startLine: number };
  docComment?: string;
  methods: { line: number; docComment?: string }[];
}

/**
 * Mutates every node in-place, attaching `docComment` to the class and to
 * each method by scanning the file's source text. Called from two places:
 * the single-file analyzer (after calibration) and the orchestrator (after
 * a cache hit, since cached `AnalyzeResult`s pre-date this field).
 */
export function hydrateDocComments(
  nodes: DocHydratable[],
  file: string,
  fileText: string,
): void {
  const lang = detectLang(file);
  if (lang === 'unknown') return;
  for (const n of nodes) {
    const classDoc = extractDocComment({ fileText, startLine: n.range.startLine, lang });
    if (classDoc) n.docComment = classDoc;
    for (const m of n.methods) {
      if (m.line > 0) {
        const mDoc = extractDocComment({ fileText, startLine: m.line, lang });
        if (mDoc) m.docComment = mDoc;
      }
    }
  }
}

