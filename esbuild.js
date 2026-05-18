// esbuild.js — dual build: extension host (CJS, node) + webview UI (IIFE, browser)
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

const webviewConfig = {
  entryPoints: ['src/webview/ui/index.tsx'],
  bundle: true,
  outfile: 'dist/webview.js',
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  sourcemap: true,
  logLevel: 'info',
};

async function run() {
  if (watch) {
    const ctxA = await esbuild.context(extensionConfig);
    const ctxB = await esbuild.context(webviewConfig);
    await Promise.all([ctxA.watch(), ctxB.watch()]);
    console.log('[esbuild] watching…');
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(webviewConfig),
    ]);
    console.log('[esbuild] build complete');
  }
}

run().catch(err => { console.error(err); process.exit(1); });
