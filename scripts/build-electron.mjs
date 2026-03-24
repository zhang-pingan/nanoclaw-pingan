// Build script for Electron app (bundles TypeScript via esbuild)
import * as esbuild from 'esbuild';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'dist-electron');
const electronDir = path.join(rootDir, 'electron');
const rendererDir = path.join(electronDir, 'renderer');
const rendererOutDir = path.join(rendererDir);

// Ensure output directories exist
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

// 1. Bundle Electron main process (.cjs to avoid "type": "module" in package.json)
await esbuild.build({
  platform: 'node',
  bundle: true,
  sourcemap: true,
  external: ['electron'],
  entryPoints: [path.join(electronDir, 'main.ts')],
  outfile: path.join(outDir, 'main.cjs'),
  format: 'cjs',
  target: 'node18',
});

// 2. Bundle Electron preload script (CJS, Node.js)
await esbuild.build({
  platform: 'node',
  bundle: true,
  sourcemap: true,
  external: ['electron'],
  entryPoints: [path.join(electronDir, 'preload.ts')],
  outfile: path.join(outDir, 'preload.js'),
  format: 'cjs',
  target: 'node18',
});

// 3. Bundle renderer app (ESM, browser)
// Output to electron/renderer/dist/app.js so it doesn't overwrite source
const rendererDistDir = path.join(rendererDir, 'dist');
if (!existsSync(rendererDistDir)) mkdirSync(rendererDistDir, { recursive: true });
await esbuild.build({
  platform: 'browser',
  bundle: true,
  sourcemap: true,
  loader: { '.js': 'ts' },
  entryPoints: [path.join(rendererDir, 'app.js')],
  outfile: path.join(rendererDistDir, 'app.js'),
  format: 'esm',
  target: 'es2022',
});

console.log('Electron build complete → dist-electron/ + electron/renderer/dist/');
