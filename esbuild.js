// esbuild.js — extension host bundle (CJS, node). The WebView panel loads
// the static mockup HTML directly (panel.ts reads docs/mockups/lumen-backend-v3.html);
// there is no React WebView build to bundle.
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
