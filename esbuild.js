// esbuild.js — extension host bundle (CJS, node).
// Phase 0.1: the v0.0.x webview/cytoscape stack moved to legacy/ and is no
// longer wired. Vendor copy will be reintroduced in Phase 1.0 once the
// Pixi.js renderer ships. See docs/plan/v4-plan.md.
const esbuild = require('esbuild');
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

async function run() {
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
