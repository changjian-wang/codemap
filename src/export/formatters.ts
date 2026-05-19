import * as YAML from 'yaml';
import type { CodeMapGraph } from '../shared/types';
import type { MockupData } from '../webview/graph-adapter';

/**
 * Pure formatters for the export targets.
 *
 *   - YAML : full graph, human-readable + machine-parsable, lossless
 *   - HTML : standalone interactive snapshot built from the mockup template
 *
 * Markdown + Mermaid were dropped in favor of HTML: a self-contained HTML
 * file reproduces the right-panel UI offline, so consumers get the same
 * cytoscape graph + outline + cards + search experience without VS Code.
 * Anyone who needs structured data can read the YAML.
 */

export type ExportFormat = 'yaml' | 'html';

export interface ExportSpec {
  format: ExportFormat;
  /** Suggested file extension, no leading dot. */
  extension: string;
  /** Display label for the QuickPick. */
  label: string;
  /** Short description for the QuickPick. */
  description: string;
}

export const EXPORT_SPECS: Record<ExportFormat, ExportSpec> = {
  html: {
    format: 'html',
    extension: 'html',
    label: 'HTML (interactive snapshot)',
    description: 'Self-contained page — open in any browser to inspect the graph offline',
  },
  yaml: {
    format: 'yaml',
    extension: 'yaml',
    label: 'YAML (structured data)',
    description: 'Lossless dump of the graph for scripts / LLM re-consumption',
  },
};

// ---------- YAML ----------

export function formatYaml(graph: CodeMapGraph): string {
  // Block-style YAML with sane defaults. lineWidth=0 disables auto-wrap so
  // multi-line intent/risk strings stay readable instead of getting hard-
  // wrapped in odd places.
  return YAML.stringify(graph, {
    lineWidth: 0,
    blockQuote: 'literal',
  });
}

// ---------- HTML (standalone snapshot) ----------

/**
 * Inject the supplied MockupData into the mockup template so it boots up
 * offline. Strips features that need the VS Code bridge (re-analyze / reset
 * progress / chat input / file-jump etc.) so the page doesn't appear broken
 * when the user clicks them outside the extension.
 *
 * The mockup itself defensively no-ops on missing `window.codemap.postMessage`,
 * so a "minimum viable" injection of just `__CODEMAP_DATA__` would technically
 * work — we still hide the dead buttons so a recipient who opens the file in
 * Chrome doesn't get confused by buttons that flash but do nothing.
 */
export function formatStandaloneHtml(
  mockupTemplate: string,
  mockupData: MockupData,
): string {
  const payload = JSON.stringify(mockupData).replace(/</g, '\\u003c');

  const repoName = mockupData.meta?.repoName ?? 'workspace';
  const scope = mockupData.meta?.scope ?? '';
  const title = scope
    ? `CodeMap — ${repoName} · ${scope}`
    : `CodeMap — ${repoName}`;

  const bootstrap = `
    <script>
      window.__CODEMAP_DATA__ = JSON.parse(${JSON.stringify(payload)});
      window.codemap = window.codemap || {};
      window.__CODEMAP_STANDALONE__ = true;
    </script>
    <style>
      body.codemap-standalone #analyzeBtn,
      body.codemap-standalone #resetBtn,
      body.codemap-standalone #exportBtn,
      body.codemap-standalone .chat-input-row,
      body.codemap-standalone .quick-chip-row {
        display: none !important;
      }
      body.codemap-standalone .repo-pill { cursor: default !important; }
      body.codemap-standalone .file-jump { cursor: default !important; text-decoration: none !important; }
    </style>
    <script>
      window.addEventListener('DOMContentLoaded', function () {
        document.body.classList.add('codemap-standalone');
        var data = window.__CODEMAP_DATA__;
        var bcLabels = data && data.meta && data.meta.bcLabels;
        if (bcLabels) {
          ['host', 'capture', 'recall', 'shared'].forEach(function (slot) {
            var label = bcLabels[slot];
            if (!label) return;
            var chip = document.querySelector('.chip.bc-chip[data-bc="' + slot + '"]');
            if (chip) {
              var marker = chip.querySelector('.bc-marker');
              chip.textContent = '';
              if (marker) chip.appendChild(marker);
              chip.appendChild(document.createTextNode(label));
            }
            var outlineEl = document.getElementById('outline' + slot.charAt(0).toUpperCase() + slot.slice(1));
            if (outlineEl) {
              var group = outlineEl.previousElementSibling;
              if (group && group.classList && group.classList.contains('bc-group')) {
                var dot = group.querySelector('.bc-dot');
                group.textContent = '';
                if (dot) group.appendChild(dot);
                group.appendChild(document.createTextNode(label));
              }
            }
          });
        }
        var footer = document.createElement('div');
        footer.style.cssText = 'position:fixed;left:8px;bottom:6px;font:11px Consolas,monospace;color:rgba(255,255,255,0.35);pointer-events:none;z-index:9999;';
        footer.textContent = 'CodeMap offline snapshot — ${escapeHtmlAttr(title)}';
        document.body.appendChild(footer);
      });
    </script>
  `;

  let out = mockupTemplate;
  if (out.includes('</head>')) {
    out = out.replace('</head>', `${bootstrap}</head>`);
  } else {
    out = `${bootstrap}\n${out}`;
  }
  if (/<title>[^<]*<\/title>/i.test(out)) {
    out = out.replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtmlAttr(title)}</title>`);
  }
  return out;
}

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
