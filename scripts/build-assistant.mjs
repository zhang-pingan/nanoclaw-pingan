// Build script for the standalone desktop personal assistant.
import * as esbuild from 'esbuild';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const assistantDir = path.join(rootDir, 'assistant');
const outDir = path.join(rootDir, 'dist-assistant');
const rendererDistDir = path.join(assistantDir, 'renderer', 'dist');

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
if (!existsSync(rendererDistDir)) mkdirSync(rendererDistDir, { recursive: true });

await esbuild.build({
  platform: 'node',
  bundle: true,
  sourcemap: true,
  external: ['electron'],
  entryPoints: [path.join(assistantDir, 'main.ts')],
  outfile: path.join(outDir, 'main.cjs'),
  format: 'cjs',
  target: 'node18',
});

await esbuild.build({
  platform: 'node',
  bundle: true,
  sourcemap: true,
  external: ['electron'],
  entryPoints: [path.join(assistantDir, 'preload.ts')],
  outfile: path.join(outDir, 'preload.cjs'),
  format: 'cjs',
  target: 'node18',
});

await esbuild.build({
  platform: 'browser',
  bundle: true,
  sourcemap: true,
  entryPoints: [path.join(assistantDir, 'renderer', 'app.ts')],
  outfile: path.join(rendererDistDir, 'app.js'),
  format: 'esm',
  target: 'es2022',
});

console.log('Assistant build complete -> dist-assistant/ + assistant/renderer/dist/');
