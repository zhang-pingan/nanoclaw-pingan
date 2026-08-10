#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';

const major = Number(process.versions.node.split('.')[0]);
if (!Number.isInteger(major) || major < 20)
  throw new Error(`Node.js 20 or newer is required; found ${process.version}`);

const gitVersion = execFileSync('git', ['--version'], {
  encoding: 'utf8',
}).trim();
const match = /git version (\d+)\.(\d+)/u.exec(gitVersion);
if (
  !match ||
  Number(match[1]) < 2 ||
  (Number(match[1]) === 2 && Number(match[2]) < 34)
)
  throw new Error(
    `Git 2.34 or newer is required for SSH commit signatures; found ${gitVersion}`,
  );
const sshKeygen = spawnSync('ssh-keygen', ['-?'], { stdio: 'ignore' });
if (sshKeygen.error) throw sshKeygen.error;
process.stdout.write(
  `Runtime is ready: ${process.version}; ${gitVersion}; ssh-keygen available.\n`,
);
