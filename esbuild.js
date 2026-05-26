// esbuild.js — extension host bundle (CJS, node). The WebView panel loads
// the static mockup HTML directly (panel.ts reads docs/mockups/codemap-view.html);
// there is no React WebView build to bundle.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const watch = process.argv.includes('--watch');

const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
};

// Vendor JS bundled into dist/vendor/ so the WebView can load them locally
// instead of unpkg.com (which fails in restricted-network environments and
// silently breaks the whole graph render with a "Script error.").
const VENDOR_FILES = [
  ['node_modules/cytoscape/dist/cytoscape.min.js',           'dist/vendor/cytoscape.min.js'],
  ['node_modules/dagre/dist/dagre.min.js',                    'dist/vendor/dagre.min.js'],
  ['node_modules/cytoscape-dagre/cytoscape-dagre.js',         'dist/vendor/cytoscape-dagre.js'],
  ['node_modules/elkjs/lib/elk.bundled.js',                   'dist/vendor/elk.bundled.js'],
];
function copyVendor() {
  fs.mkdirSync('dist/vendor', { recursive: true });
  for (const [src, dest] of VENDOR_FILES) {
    fs.copyFileSync(path.resolve(src), path.resolve(dest));
  }
  console.log('[esbuild] copied ' + VENDOR_FILES.length + ' vendor file(s) to dist/vendor');
}

async function run() {
  copyVendor();
  if (watch) {
    const ctx = await esbuild.context(extensionConfig);
    await ctx.watch();
    console.log('[esbuild] watching…');
  } else {
    await esbuild.build(extensionConfig);
    console.log('[esbuild] build complete');
  }
}

run().catch(err => { console.error(err); process.exit(1); });
