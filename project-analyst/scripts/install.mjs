#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const targetIndex = process.argv.indexOf('--target');
const targetValue = targetIndex >= 0 ? process.argv[targetIndex + 1] : null;
if (!targetValue)
  throw new Error(
    'usage: node scripts/install.mjs --target <project-analyst-directory>',
  );
const target = path.resolve(targetValue);
if (existsSync(target))
  throw new Error(`Refusing to overwrite existing target: ${target}`);
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!statSync(source).isDirectory())
  throw new Error('Skill source is unavailable');
mkdirSync(path.dirname(target), { recursive: true });
cpSync(source, target, { recursive: true, errorOnExist: true });
process.stdout.write(
  `Installed the complete project-analyst Skill at ${target}\n`,
);
