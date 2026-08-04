import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import prettier from 'prettier';

const repositoryRoot = fs.realpathSync(path.resolve(import.meta.dirname, '..'));
const baselinePath = path.join(
  repositoryRoot,
  'scripts/format-debt-baseline-v1.json',
);

function fail(message) {
  throw new Error(`format_baseline_invalid: ${message}`);
}

function rawSha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function walkTypescript(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isSymbolicLink())
      fail(`source symlink is forbidden: ${absolute}`);
    if (entry.isDirectory()) files.push(...walkTypescript(absolute));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(absolute);
  }
  return files.sort();
}

const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
if (
  baseline.format !== 'icarus.prettier-debt-baseline/1' ||
  baseline.accepted_commit !== '56a78b6dcede075c60d7e5b2049158824050410c' ||
  baseline.prettier_version !== prettier.version ||
  !baseline.members ||
  typeof baseline.members !== 'object' ||
  Array.isArray(baseline.members)
) {
  fail('baseline header or Prettier identity drifted');
}

for (const [relative, hash] of Object.entries(baseline.members)) {
  if (
    !/^src\/[A-Za-z0-9_@./-]+\.ts$/.test(relative) ||
    relative.includes('/../') ||
    !/^sha256:[0-9a-f]{64}$/.test(hash)
  ) {
    fail(`invalid baseline member: ${relative}`);
  }
}

const failures = [];
let formattedCount = 0;
let unchangedDebtCount = 0;
let resolvedDebtCount = 0;
const seen = new Set();
for (const file of walkTypescript(path.join(repositoryRoot, 'src'))) {
  const relative = path
    .relative(repositoryRoot, file)
    .split(path.sep)
    .join('/');
  seen.add(relative);
  const bytes = fs.readFileSync(file);
  const config = (await prettier.resolveConfig(file)) ?? {};
  const formatted = await prettier.check(bytes.toString('utf8'), {
    ...config,
    filepath: file,
  });
  const baselineHash = baseline.members[relative];
  if (formatted) {
    formattedCount += 1;
    if (baselineHash) resolvedDebtCount += 1;
  } else if (baselineHash && rawSha256(bytes) === baselineHash) {
    unchangedDebtCount += 1;
  } else {
    failures.push(relative);
  }
}
for (const relative of Object.keys(baseline.members)) {
  if (!seen.has(relative)) resolvedDebtCount += 1;
}

if (failures.length > 0)
  fail(`new or changed formatting debt: ${failures.join(', ')}`);

process.stdout.write(
  `${JSON.stringify(
    {
      format_check: 'ok',
      prettier_version: prettier.version,
      checked_typescript_file_count: formattedCount + unchangedDebtCount,
      formatted_file_count: formattedCount,
      accepted_baseline_member_count: Object.keys(baseline.members).length,
      unchanged_baseline_debt_count: unchangedDebtCount,
      resolved_baseline_debt_count: resolvedDebtCount,
      new_or_changed_debt_count: failures.length,
    },
    null,
    2,
  )}\n`,
);
