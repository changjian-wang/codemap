// esbuild.js — extension host + webview scene bundles.
// Phase 1.1a: webview pipeline lights up.
//  - dist/extension.js: CJS bundle for the extension host (Node).
//  - dist/webview/scene.js: ESM bundle for the webview, `pixi.js` left external.
//  - dist/webview/vendor/pixi.min.mjs: vendor copy of the Pixi v8 ESM build,
//    referenced from the webview via an import map. Pixi must not be inlined
//    into scene.js — ADR-005 §7.1 (R1 finding): the ESM path is the only one
//    that keeps Pixi's internal extension registry intact under VS Code's CSP.
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

const sceneConfig = {
  entryPoints: ['src/webview/scene/bootstrap.ts'],
  bundle: true,
  outfile: 'dist/webview/scene.js',
  platform: 'browser',
  target: 'es2022',
  format: 'esm',
  external: ['pixi.js'],
  sourcemap: true,
  logLevel: 'info',
};

function copyPixiVendor() {
  const src = path.resolve('node_modules/pixi.js/dist/pixi.min.mjs');
  const dst = path.resolve('dist/webview/vendor/pixi.min.mjs');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  console.log('[esbuild] vendor: pixi.min.mjs -> dist/webview/vendor/');
}

async function run() {
  if (watch) {
    copyPixiVendor();
    const extCtx = await esbuild.context(extensionConfig);
    const sceneCtx = await esbuild.context(sceneConfig);
    await Promise.all([extCtx.watch(), sceneCtx.watch()]);
    console.log('[esbuild] watching…');
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(sceneConfig),
    ]);
    copyPixiVendor();
    console.log('[esbuild] build complete');
  }
}

run().catch(err => { console.error(err); process.exit(1); });
