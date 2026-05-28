// esbuild.js — extension host + webview scene bundles.
//  - dist/extension.js: CJS bundle for the extension host (Node).
//  - dist/webview/scene.js: ESM bundle for the webview, Pixi v8 + unsafe-eval
//    polyfill bundled in. Bundling is mandatory: VS Code webviews disallow
//    `new Function()` (strict CSP), so Pixi must run with its `unsafe-eval`
//    companion patched in. That patch overrides classes (`GlShaderSystem`,
//    `UboSystem`, …) on the SAME module instance the Application consumes,
//    so they must share one resolution. ESM-only output preserves Pixi's
//    extension registry per ADR-005 §7.1 (R1 finding).
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

const sceneConfig = {
  entryPoints: ['src/webview/scene/bootstrap.ts'],
  bundle: true,
  outfile: 'dist/webview/scene.js',
  platform: 'browser',
  target: 'es2022',
  format: 'esm',
  sourcemap: true,
  logLevel: 'info',
};

async function run() {
  if (watch) {
    const extCtx = await esbuild.context(extensionConfig);
    const sceneCtx = await esbuild.context(sceneConfig);
    await Promise.all([extCtx.watch(), sceneCtx.watch()]);
    console.log('[esbuild] watching…');
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(sceneConfig),
    ]);
    console.log('[esbuild] build complete');
  }
}

run().catch(err => { console.error(err); process.exit(1); });
