import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import prettier from 'prettier';

const repositoryRoot = fs.realpathSync(path.resolve(import.meta.dirname, '..'));
const baselinePath = path.join(
  repositoryRoot,
  'scripts/format-debt-baseline-v1.json',
);
const packageJsonPath = path.join(repositoryRoot, 'package.json');
const packageLockPath = path.join(repositoryRoot, 'package-lock.json');
const formatterProfileDomain = 'icarus:prettier-effective-profile:1\n';
const formatterAuthorityDomain = 'icarus:prettier-debt-formatter-authority:1\n';

function fail(message) {
  throw new Error(`format_baseline_invalid: ${message}`);
}

function rawSha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  const rendered = JSON.stringify(value);
  if (rendered === undefined) fail('formatter authority is not JSON data');
  return rendered;
}

function domainSeparatedSha256(domain, value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(domain, 'ascii')
    .update(canonicalJson(value), 'utf8')
    .digest('hex')}`;
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} is not an object`);
  return value;
}

function assertExactKeys(value, keys, label) {
  const actual = Object.keys(assertObject(value, label)).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    fail(`${label} has an unexpected shape`);
}

function relativePath(absolute) {
  return path.relative(repositoryRoot, absolute).split(path.sep).join('/');
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function assertRepositoryFile(candidate, label) {
  const absolute = path.resolve(candidate);
  if (!isInside(repositoryRoot, absolute)) fail(`${label} escapes repository`);
  if (!fs.existsSync(absolute)) fail(`${label} is missing`);
  let cursor = repositoryRoot;
  for (const component of path
    .relative(repositoryRoot, absolute)
    .split(path.sep)) {
    if (!component) continue;
    cursor = path.join(cursor, component);
    if (fs.lstatSync(cursor).isSymbolicLink())
      fail(`${label} traverses a symbolic link: ${relativePath(cursor)}`);
  }
  const canonical = fs.realpathSync(absolute);
  if (!isInside(repositoryRoot, canonical))
    fail(`${label} resolves outside repository`);
  if (!fs.statSync(canonical).isFile()) fail(`${label} is not a regular file`);
  return canonical;
}

function walkTypescript(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isSymbolicLink())
      fail(`source symlink is forbidden: ${relativePath(absolute)}`);
    if (entry.isDirectory()) files.push(...walkTypescript(absolute));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(absolute);
  }
  return files.sort();
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${label} is not JSON: ${error.message}`);
  }
}

const baselineText = fs.readFileSync(baselinePath, 'utf8');
const baseline = readJson(baselinePath, 'format debt baseline');
assertExactKeys(
  baseline,
  ['format', 'accepted_commit', 'formatter_authority', 'members'],
  'format debt baseline',
);
if (
  baseline.format !== 'icarus.prettier-debt-baseline/1' ||
  baseline.accepted_commit !== '56a78b6dcede075c60d7e5b2049158824050410c'
) {
  fail('baseline identity drifted');
}

const authority = assertObject(
  baseline.formatter_authority,
  'formatter authority',
);
assertExactKeys(
  authority,
  [
    'package_name',
    'package_specifier',
    'version',
    'lock_integrity',
    'parser_package',
    'config_inputs',
    'plugin_packages',
    'source_inferred_parser',
    'source_effective_config',
    'source_profile_hash',
    'baseline_inferred_parser',
    'baseline_effective_config',
    'baseline_profile_hash',
    'authority_hash',
  ],
  'formatter authority',
);
if (
  authority.package_name !== 'prettier' ||
  authority.parser_package !== 'prettier' ||
  authority.version !== prettier.version ||
  authority.source_inferred_parser !== 'typescript' ||
  authority.baseline_inferred_parser !== 'json' ||
  !Array.isArray(authority.plugin_packages) ||
  authority.plugin_packages.length !== 0 ||
  !Array.isArray(authority.config_inputs) ||
  authority.config_inputs.length !== 1
) {
  fail('formatter authority header drifted');
}

const packageJson = readJson(packageJsonPath, 'package.json');
const packageLock = readJson(packageLockPath, 'package-lock.json');
const prettierLock = assertObject(
  packageLock.packages?.['node_modules/prettier'],
  'Prettier lock entry',
);
if (
  packageJson.devDependencies?.prettier !== authority.package_specifier ||
  prettierLock.version !== authority.version ||
  prettierLock.integrity !== authority.lock_integrity
) {
  fail('Prettier package or lock authority drifted');
}

const configInput = authority.config_inputs[0];
assertExactKeys(configInput, ['path', 'raw_sha256'], 'formatter config input');
if (
  typeof configInput.path !== 'string' ||
  !/^sha256:[0-9a-f]{64}$/.test(configInput.raw_sha256)
) {
  fail('formatter config input identity is invalid');
}
const configPath = assertRepositoryFile(
  path.join(repositoryRoot, configInput.path),
  'formatter config input',
);
if (rawSha256(fs.readFileSync(configPath)) !== configInput.raw_sha256)
  fail('formatter config input bytes drifted');

const formatterBase = {
  package_name: authority.package_name,
  package_specifier: authority.package_specifier,
  version: authority.version,
  lock_integrity: authority.lock_integrity,
  parser_package: authority.parser_package,
  config_inputs: authority.config_inputs,
  plugin_packages: authority.plugin_packages,
};

function expectedProfile(parser, effectiveConfig) {
  return {
    ...formatterBase,
    inferred_parser: parser,
    effective_config: effectiveConfig,
  };
}

const sourceProfile = expectedProfile(
  authority.source_inferred_parser,
  authority.source_effective_config,
);
const baselineProfile = expectedProfile(
  authority.baseline_inferred_parser,
  authority.baseline_effective_config,
);
if (
  domainSeparatedSha256(formatterProfileDomain, sourceProfile) !==
    authority.source_profile_hash ||
  domainSeparatedSha256(formatterProfileDomain, baselineProfile) !==
    authority.baseline_profile_hash
) {
  fail('formatter profile identity drifted');
}
const authorityPayload = { ...authority };
delete authorityPayload.authority_hash;
if (
  domainSeparatedSha256(formatterAuthorityDomain, authorityPayload) !==
  authority.authority_hash
) {
  fail('formatter aggregate authority drifted');
}

function editorConfigInputs(file) {
  const inputs = [];
  let directory = path.dirname(file);
  while (isInside(repositoryRoot, directory)) {
    const candidate = path.join(directory, '.editorconfig');
    if (fs.existsSync(candidate))
      inputs.push(
        relativePath(assertRepositoryFile(candidate, '.editorconfig')),
      );
    if (directory === repositoryRoot) break;
    directory = path.dirname(directory);
  }
  return inputs.sort();
}

async function verifyProfile(
  file,
  expectedParser,
  expectedConfig,
  expectedHash,
) {
  const resolvedConfig = await prettier.resolveConfigFile(file);
  if (!resolvedConfig)
    fail(`Prettier config is missing for ${relativePath(file)}`);
  const canonicalConfig = assertRepositoryFile(
    resolvedConfig,
    `Prettier config for ${relativePath(file)}`,
  );
  if (canonicalConfig !== configPath)
    fail(`Prettier config resolution drifted for ${relativePath(file)}`);
  if (editorConfigInputs(file).length !== 0)
    fail(`unbound EditorConfig input for ${relativePath(file)}`);

  const config =
    (await prettier.resolveConfig(file, { editorconfig: true })) ?? {};
  const plugins = config.plugins ?? [];
  if (!Array.isArray(plugins) || plugins.length !== 0)
    fail(`unbound Prettier plugin input for ${relativePath(file)}`);
  const effectiveConfig = { ...config };
  delete effectiveConfig.plugins;
  if (canonicalJson(effectiveConfig) !== canonicalJson(expectedConfig))
    fail(`effective Prettier config drifted for ${relativePath(file)}`);

  const fileInfo = await prettier.getFileInfo(file);
  if (fileInfo.ignored || fileInfo.inferredParser !== expectedParser)
    fail(`Prettier parser/ignore authority drifted for ${relativePath(file)}`);
  const profile = expectedProfile(fileInfo.inferredParser, effectiveConfig);
  if (domainSeparatedSha256(formatterProfileDomain, profile) !== expectedHash)
    fail(`Prettier profile drifted for ${relativePath(file)}`);
  return effectiveConfig;
}

const baselineConfig = await verifyProfile(
  baselinePath,
  authority.baseline_inferred_parser,
  authority.baseline_effective_config,
  authority.baseline_profile_hash,
);
if (
  !(await prettier.check(baselineText, {
    ...baselineConfig,
    filepath: baselinePath,
  }))
) {
  fail('format debt baseline artifact is not formatted');
}

const members = assertObject(baseline.members, 'baseline members');
for (const [relative, hash] of Object.entries(members)) {
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
  const relative = relativePath(file);
  seen.add(relative);
  const config = await verifyProfile(
    file,
    authority.source_inferred_parser,
    authority.source_effective_config,
    authority.source_profile_hash,
  );
  const bytes = fs.readFileSync(file);
  const formatted = await prettier.check(bytes.toString('utf8'), {
    ...config,
    filepath: file,
  });
  const baselineHash = members[relative];
  if (formatted) {
    formattedCount += 1;
    if (baselineHash) resolvedDebtCount += 1;
  } else if (baselineHash && rawSha256(bytes) === baselineHash) {
    unchangedDebtCount += 1;
  } else {
    failures.push(relative);
  }
}
const missingOrRenamedMembers = Object.keys(members).filter(
  (relative) => !seen.has(relative),
);
if (missingOrRenamedMembers.length > 0)
  fail(
    `missing or renamed formatting debt: ${missingOrRenamedMembers.join(', ')}`,
  );
if (failures.length > 0)
  fail(`new or changed formatting debt: ${failures.join(', ')}`);

process.stdout.write(
  `${JSON.stringify(
    {
      format_check: 'ok',
      formatter_authority_hash: authority.authority_hash,
      prettier_version: prettier.version,
      prettier_config_input_count: authority.config_inputs.length,
      prettier_plugin_package_count: authority.plugin_packages.length,
      source_parser: authority.source_inferred_parser,
      baseline_parser: authority.baseline_inferred_parser,
      baseline_artifact_formatted: true,
      checked_typescript_file_count: formattedCount + unchangedDebtCount,
      formatted_file_count: formattedCount,
      accepted_baseline_member_count: Object.keys(members).length,
      unchanged_baseline_debt_count: unchangedDebtCount,
      resolved_baseline_debt_count: resolvedDebtCount,
      missing_or_renamed_debt_count: missingOrRenamedMembers.length,
      new_or_changed_debt_count: failures.length,
    },
    null,
    2,
  )}\n`,
);
