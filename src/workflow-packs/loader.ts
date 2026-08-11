import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  Ajv2020,
  type AnySchema,
  type ErrorObject,
  type ValidateFunction,
} from 'ajv/dist/2020.js';

import {
  buildDependencyClosure,
  bindCompilerSnapshot,
  buildWorkflowPackResourceSourceSchemas,
  calculateRegistryResourceContentHash,
  calculateRegistrySnapshotHash,
  compileWorkflow,
  compareAscii,
  G3_REGISTRY_DEPENDENCY_KIND,
  G3_REGISTRY_PERSISTENCE_FORMATS,
  registryResourceId,
  registryResourceKey,
  resourceDependencyRefs,
  validateClosedSource,
  WORKFLOW_COMPILER_VERSION,
  PACK_WORKFLOW_RESOURCE_KINDS,
  type G3RegistryPersistenceBatch,
  type G3RegistryResourceDependency,
  type G3RegistryResourceIdentity,
  type G3RegistryResourceRecord,
  type G3RegistryResourceType,
  type G3RegistrySnapshot,
  type PackWorkflowResourceKind,
  type WorkflowPackManifestDocument,
} from '../workflow-runtime/gateway/workflow-packs.js';
import {
  canonicalJson,
  domainSeparatedSha256,
} from '../workflow-runtime/contracts/hash.js';
import {
  assertJsonObject,
  strictParseJsonBytes,
} from '../workflow-runtime/contracts/strict-json.js';
import type {
  JsonObject,
  Sha256Hash,
  VersionedRef,
} from '../workflow-runtime/contracts/types.js';
import {
  parseWorkflowPackManifest,
  resolveWorkflowPackPath,
} from './manifest.js';
import {
  parseWorkflowPackExecutionPermissions,
  type WorkflowPackExecutionPermissions,
} from './permissions.js';

const RELEASE_HASH_DOMAIN = 'icarus:workflow-pack-release:1\n';
const FORBIDDEN_SOURCE_KEYS = new Set([
  'apiPrefix',
  'backgroundService',
  'background_service',
  'hostEntry',
  'migration',
  'migrations',
  'nav',
  'rendererEntry',
  'requiredAgents',
  'serviceEntry',
  'service_entry',
]);

const sourceAjv = new Ajv2020({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
});
const packResourceSourceSchemas = buildWorkflowPackResourceSourceSchemas();
const PACK_SOURCE_VALIDATORS = Object.fromEntries(
  PACK_WORKFLOW_RESOURCE_KINDS.map((kind) => [
    kind,
    sourceAjv.compile(packResourceSourceSchemas[kind] as AnySchema),
  ]),
) as Record<PackWorkflowResourceKind, ValidateFunction>;

function validationMessage(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map(
      (error) => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`,
    )
    .join('; ');
}

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isVersionedRef(value: unknown): value is VersionedRef {
  return (
    isPlainObject(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.version === 'string' &&
    value.version.length > 0
  );
}

function invalidCompilerContract(sourcePath: string, detail: string): never {
  throw new WorkflowPackLoadError(
    'source_invalid',
    `${sourcePath} violates its compiler resource contract: ${detail}`,
  );
}

function validateScopeInterfaceIdentity(
  sourcePath: string,
  content: JsonObject,
): void {
  const interfaceSnapshot: JsonObject = {
    ref: content.ref ?? null,
    inputs: content.inputs ?? null,
    exits: content.exits ?? null,
  };
  if (
    !isVersionedRef(content.ref) ||
    content.interface_hash !==
      domainSeparatedSha256(
        'icarus:workflow-scope-interface:1\n',
        interfaceSnapshot,
      )
  ) {
    invalidCompilerContract(sourcePath, 'scope interface identity is invalid');
  }
}

function assertNeverPackKind(kind: never): never {
  throw new Error(`Unsupported Workflow Pack resource kind: ${String(kind)}`);
}

function validateWorkflowPackSourceDocument(input: {
  readonly kind: PackWorkflowResourceKind;
  readonly sourcePath: string;
  readonly content: JsonObject;
}): void {
  const closed = PACK_SOURCE_VALIDATORS[input.kind];
  if (!closed(input.content)) {
    throw new WorkflowPackLoadError(
      'source_invalid',
      `${input.sourcePath} violates the authoritative closed ${input.kind} schema: ${validationMessage(closed.errors)}`,
    );
  }
  switch (input.kind) {
    case 'recipe':
    case 'routing_scope':
    case 'execution_policy':
    case 'definition':
    case 'command_policy':
    case 'context_contract':
    case 'graph_policy':
    case 'card_presentation':
      return;
    case 'scope_interface':
      validateScopeInterfaceIdentity(input.sourcePath, input.content);
      return;
    case 'schema': {
      const diagnostic = validateClosedSource('workflow_schema', input.content);
      if (diagnostic) {
        throw new WorkflowPackLoadError(
          'source_invalid',
          `${input.sourcePath} violates the compiler schema profile at ${diagnostic.instance_pointer}`,
        );
      }
      try {
        sourceAjv.compile(input.content as AnySchema);
      } catch (error) {
        throw new WorkflowPackLoadError(
          'source_invalid',
          `${input.sourcePath} is not a valid JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }
    case 'graph_template': {
      const diagnostic = validateClosedSource('graph_scope', input.content);
      if (diagnostic) {
        throw new WorkflowPackLoadError(
          'source_invalid',
          `${input.sourcePath} violates the Graph Scope compiler contract at ${diagnostic.instance_pointer}`,
        );
      }
      return;
    }
    default:
      return assertNeverPackKind(input.kind);
  }
}

const PACK_FILE_SCOPES = new Set([
  'agent',
  'workspace',
  'attachments',
  'desktop_captures',
  'ai_images',
]);

function dependencyAccessRefs(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      typeof (entry as JsonObject).ref !== 'string'
    ) {
      throw new WorkflowPackLoadError(
        'compile_invalid',
        `${label} contains an invalid dependency access`,
      );
    }
    return String((entry as JsonObject).ref);
  });
}

function mcpServerForMethod(ref: string): string {
  if (ref.startsWith('mcp__')) {
    const [, server, method] = ref.split('__');
    if (server && method) return server;
  }
  for (const separator of [':', '/']) {
    const index = ref.indexOf(separator);
    if (index > 0 && index < ref.length - 1) return ref.slice(0, index);
  }
  throw new WorkflowPackLoadError(
    'compile_invalid',
    `MCP method ${ref} must identify its server as server:method or server/method`,
  );
}

function assertCompiledPlanPermissions(input: {
  readonly plan: JsonObject;
  readonly permissions: WorkflowPackExecutionPermissions;
  readonly label: string;
}): void {
  const fileScopes = new Set(input.permissions.file_scopes);
  const mcpServers = new Set(input.permissions.mcp_servers);
  const visit = (value: unknown, pointer: string): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${pointer}/${index}`));
      return;
    }
    const object = value as JsonObject;
    for (const ref of dependencyAccessRefs(
      object.required_file_scopes,
      `${input.label}${pointer}/required_file_scopes`,
    )) {
      if (!fileScopes.has(ref)) {
        throw new WorkflowPackLoadError(
          'compile_invalid',
          `${input.label} requires undeclared file scope ${ref}`,
        );
      }
    }
    for (const ref of dependencyAccessRefs(
      object.required_mcp_methods,
      `${input.label}${pointer}/required_mcp_methods`,
    )) {
      const server = mcpServerForMethod(ref);
      if (!mcpServers.has(server)) {
        throw new WorkflowPackLoadError(
          'compile_invalid',
          `${input.label} requires undeclared MCP server ${server}`,
        );
      }
    }
    for (const [key, child] of Object.entries(object)) {
      visit(child, `${pointer}/${key}`);
    }
  };
  visit(input.plan, '');
}

function assertRecipePermissions(input: {
  readonly recipePath: string;
  readonly recipe: JsonObject;
  readonly compiledPlan: JsonObject;
  readonly permissions: WorkflowPackExecutionPermissions;
}): void {
  const declaredHostActions = new Set(input.permissions.host_actions);
  const requiredPermissions = input.recipe.required_permissions;
  if (requiredPermissions !== undefined) {
    if (
      !Array.isArray(requiredPermissions) ||
      requiredPermissions.some((permission) => typeof permission !== 'string')
    ) {
      throw new WorkflowPackLoadError(
        'compile_invalid',
        `${input.recipePath} required_permissions is invalid`,
      );
    }
    for (const permission of requiredPermissions as string[]) {
      if (!declaredHostActions.has(permission)) {
        throw new WorkflowPackLoadError(
          'compile_invalid',
          `${input.recipePath} requires undeclared Host action ${permission}`,
        );
      }
    }
  }
  assertCompiledPlanPermissions({
    plan: input.compiledPlan,
    permissions: input.permissions,
    label: input.recipePath,
  });
}

export interface WorkflowPackHostBindingAllowlist {
  readonly capabilities: ReadonlySet<string>;
  readonly executors: ReadonlySet<string>;
  readonly adapters: ReadonlySet<string>;
  readonly compilerSnapshot: JsonObject | null;
}

export interface LoadedWorkflowPack {
  readonly root: string;
  readonly manifestPath: string;
  readonly manifest: WorkflowPackManifestDocument;
  readonly registryBatch: G3RegistryPersistenceBatch;
  readonly releaseHash: Sha256Hash;
  readonly executionArtifact: G3RegistryResourceIdentity & {
    resource_type: 'pack_execution_artifact';
  };
  readonly recipes: G3RegistryResourceIdentity[];
  readonly executionSourceDirectories: Readonly<
    Partial<
      Record<'agents' | 'skills' | 'mcp' | 'scripts' | 'templates', string>
    >
  >;
  readonly executionResourceFiles: WorkflowPackExecutionResourceFiles;
  readonly executionPermissions: WorkflowPackExecutionPermissions;
}

export type WorkflowPackExecutionResourceKind =
  | 'agents'
  | 'skills'
  | 'mcp'
  | 'scripts'
  | 'templates';

export interface WorkflowPackExecutionResourceFile extends JsonObject {
  readonly path: string;
  readonly content_hash: Sha256Hash;
  readonly byte_length: number;
}

export type WorkflowPackExecutionResourceFiles = Readonly<
  Partial<
    Record<
      WorkflowPackExecutionResourceKind,
      WorkflowPackExecutionResourceFile[]
    >
  >
>;

export class WorkflowPackLoadError extends Error {
  constructor(
    readonly code:
      | 'source_invalid'
      | 'source_hash_mismatch'
      | 'source_path_invalid'
      | 'host_binding_forbidden'
      | 'execution_resource_invalid'
      | 'dependency_invalid'
      | 'compile_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowPackLoadError';
  }
}

function refKey(ref: VersionedRef): string {
  return `${ref.id}@${ref.version}`;
}

function rawSha256(bytes: Uint8Array): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function assertRegularFileInside(
  root: string,
  candidate: string,
  label: string,
): void {
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new WorkflowPackLoadError(
      'source_path_invalid',
      `${label} must be a regular file and cannot be a symlink`,
    );
  }
  const realRoot = fs.realpathSync(root);
  const realCandidate = fs.realpathSync(candidate);
  if (!realCandidate.startsWith(`${realRoot}${path.sep}`)) {
    throw new WorkflowPackLoadError(
      'source_path_invalid',
      `${label} resolves outside the Workflow Pack root`,
    );
  }
}

function assertDirectoryTreeContainsNoLinks(root: string, label: string): void {
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new WorkflowPackLoadError(
      'execution_resource_invalid',
      `${label} must be a directory and cannot be a symlink`,
    );
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new WorkflowPackLoadError(
        'execution_resource_invalid',
        `${label} cannot contain symlinks: ${entryPath}`,
      );
    }
    if (entry.isDirectory())
      assertDirectoryTreeContainsNoLinks(entryPath, label);
  }
}

function inventoryDirectory(root: string): WorkflowPackExecutionResourceFile[] {
  const files: WorkflowPackExecutionResourceFile[] = [];
  const visit = (directory: string): void => {
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareAscii(left.name, right.name));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new WorkflowPackLoadError(
          'execution_resource_invalid',
          `Workflow Pack execution resources must contain only regular files: ${entryPath}`,
        );
      }
      const bytes = fs.readFileSync(entryPath);
      files.push({
        path: path.relative(root, entryPath).split(path.sep).join('/'),
        content_hash: rawSha256(bytes),
        byte_length: bytes.byteLength,
      });
    }
  };
  visit(root);
  return files.sort((left, right) => compareAscii(left.path, right.path));
}

function validatePackMcpConfig(
  directory: string | undefined,
  permissions: WorkflowPackExecutionPermissions,
): void {
  const declared = [...permissions.mcp_servers].sort(compareAscii);
  if (!directory) {
    if (declared.length > 0) {
      throw new WorkflowPackLoadError(
        'execution_resource_invalid',
        'Workflow Pack declares MCP servers without execution_resources.mcp',
      );
    }
    return;
  }
  const configPath = path.join(directory, 'mcp.json');
  if (!fs.existsSync(configPath)) {
    throw new WorkflowPackLoadError(
      'execution_resource_invalid',
      'Workflow Pack MCP resources must contain mcp.json',
    );
  }
  assertRegularFileInside(
    directory,
    configPath,
    'execution_resources.mcp/mcp.json',
  );
  const config = strictParseJsonBytes(fs.readFileSync(configPath));
  assertJsonObject(config);
  if (
    Object.keys(config).length !== 1 ||
    !config.mcpServers ||
    typeof config.mcpServers !== 'object' ||
    Array.isArray(config.mcpServers)
  ) {
    throw new WorkflowPackLoadError(
      'execution_resource_invalid',
      'Workflow Pack MCP config must contain only mcpServers',
    );
  }
  const servers = config.mcpServers as JsonObject;
  const names = Object.keys(servers).sort(compareAscii);
  if (canonicalJson(names) !== canonicalJson(declared)) {
    throw new WorkflowPackLoadError(
      'execution_resource_invalid',
      'Workflow Pack MCP config does not match permissions.mcp_servers',
    );
  }
  for (const name of names) {
    const value = servers[name];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new WorkflowPackLoadError(
        'execution_resource_invalid',
        `Workflow Pack MCP server ${name} is invalid`,
      );
    }
    const server = value as JsonObject;
    if (
      Object.keys(server).some(
        (key) => !['command', 'args', 'env'].includes(key),
      ) ||
      typeof server.command !== 'string' ||
      !['node', 'python3', 'bash', 'sh'].includes(server.command) ||
      (server.args !== undefined &&
        (!Array.isArray(server.args) ||
          server.args.some(
            (argument) => typeof argument !== 'string' || argument.length === 0,
          ))) ||
      (server.env !== undefined &&
        (!server.env ||
          typeof server.env !== 'object' ||
          Array.isArray(server.env) ||
          Object.values(server.env).some((entry) => typeof entry !== 'string')))
    ) {
      throw new WorkflowPackLoadError(
        'execution_resource_invalid',
        `Workflow Pack MCP server ${name} is invalid`,
      );
    }
    for (const argument of Array.isArray(server.args) ? server.args : []) {
      if (
        path.posix.isAbsolute(String(argument)) &&
        !String(argument).startsWith(
          '/workspace/workflow-pack-resources/scripts/',
        ) &&
        !String(argument).startsWith('/workspace/workflow-pack-resources/mcp/')
      ) {
        throw new WorkflowPackLoadError(
          'execution_resource_invalid',
          `Workflow Pack MCP server ${name} escapes pinned resources`,
        );
      }
    }
  }
}

function assertExecutionResourceInventory(
  value: unknown,
): asserts value is WorkflowPackExecutionResourceFiles {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkflowPackLoadError(
      'execution_resource_invalid',
      'Workflow Pack execution resource inventory is invalid',
    );
  }
  const allowedKinds = new Set<WorkflowPackExecutionResourceKind>([
    'agents',
    'skills',
    'mcp',
    'scripts',
    'templates',
  ]);
  for (const [kind, entries] of Object.entries(value)) {
    if (
      !allowedKinds.has(kind as WorkflowPackExecutionResourceKind) ||
      !Array.isArray(entries)
    ) {
      throw new WorkflowPackLoadError(
        'execution_resource_invalid',
        'Workflow Pack execution resource inventory is invalid',
      );
    }
    for (const entry of entries) {
      const candidate = entry as Record<string, unknown>;
      if (
        !entry ||
        typeof entry !== 'object' ||
        Array.isArray(entry) ||
        typeof candidate.path !== 'string' ||
        candidate.path.length === 0 ||
        path.posix.isAbsolute(candidate.path) ||
        candidate.path
          .split('/')
          .some(
            (part: string) => part === '' || part === '.' || part === '..',
          ) ||
        typeof candidate.content_hash !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/.test(candidate.content_hash) ||
        !Number.isSafeInteger(candidate.byte_length) ||
        Number(candidate.byte_length) < 0
      ) {
        throw new WorkflowPackLoadError(
          'execution_resource_invalid',
          'Workflow Pack execution resource inventory entry is invalid',
        );
      }
    }
  }
}

export function verifyStagedWorkflowPackExecutionBundle(input: {
  readonly rootPath: string;
  readonly packId: string;
  readonly packVersion: string;
  readonly manifestHash: Sha256Hash;
  readonly executionArtifactResourceId: string;
  readonly executionArtifactHash: Sha256Hash;
  readonly executionResourceFiles: WorkflowPackExecutionResourceFiles;
  readonly permissions: WorkflowPackExecutionPermissions;
}): string {
  const root = fs.realpathSync(input.rootPath);
  const bundlePath = path.join(root, 'bundle.json');
  if (!fs.lstatSync(bundlePath).isFile()) {
    throw new WorkflowPackLoadError(
      'execution_resource_invalid',
      'Workflow Pack execution staging metadata is not a file',
    );
  }
  const bundle = strictParseJsonBytes(fs.readFileSync(bundlePath));
  assertJsonObject(bundle);
  assertExecutionResourceInventory(bundle.execution_resource_files);
  if (
    bundle.format !== 'icarus.workflow-pack-execution-staging/1' ||
    !bundle.pack_ref ||
    typeof bundle.pack_ref !== 'object' ||
    Array.isArray(bundle.pack_ref) ||
    bundle.pack_ref.id !== input.packId ||
    bundle.pack_ref.version !== input.packVersion ||
    bundle.manifest_hash !== input.manifestHash ||
    bundle.execution_artifact_resource_id !==
      input.executionArtifactResourceId ||
    bundle.execution_artifact_hash !== input.executionArtifactHash ||
    canonicalJson(bundle.execution_resource_files) !==
      canonicalJson(input.executionResourceFiles) ||
    canonicalJson(bundle.permissions) !== canonicalJson(input.permissions)
  ) {
    throw new WorkflowPackLoadError(
      'execution_resource_invalid',
      'Workflow Pack execution staging identity drifted',
    );
  }
  const expectedKinds = Object.keys(input.executionResourceFiles).sort(
    compareAscii,
  );
  const actualKinds = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.name !== 'bundle.json')
    .map((entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new WorkflowPackLoadError(
          'execution_resource_invalid',
          `Workflow Pack execution staging contains an unexpected entry: ${entry.name}`,
        );
      }
      return entry.name;
    })
    .sort(compareAscii);
  if (canonicalJson(actualKinds) !== canonicalJson(expectedKinds)) {
    throw new WorkflowPackLoadError(
      'execution_resource_invalid',
      'Workflow Pack execution staging directory set drifted',
    );
  }
  for (const kind of expectedKinds) {
    const expected =
      input.executionResourceFiles[kind as WorkflowPackExecutionResourceKind];
    const actual = inventoryDirectory(path.join(root, kind));
    if (canonicalJson(actual) !== canonicalJson(expected ?? [])) {
      throw new WorkflowPackLoadError(
        'execution_resource_invalid',
        `Workflow Pack execution staging content drifted: ${kind}`,
      );
    }
  }
  return root;
}

function assertNoHostLifecycle(value: unknown, sourcePath: string): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoHostLifecycle(item, sourcePath);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_SOURCE_KEYS.has(key)) {
      throw new WorkflowPackLoadError(
        'source_invalid',
        `${sourcePath} contains forbidden Host lifecycle key ${key}`,
      );
    }
    assertNoHostLifecycle(child, sourcePath);
  }
}

function versionedRef(value: unknown): VersionedRef | null {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof (value as { id?: unknown }).id !== 'string' ||
    typeof (value as { version?: unknown }).version !== 'string'
  ) {
    return null;
  }
  return value as VersionedRef;
}

function walkCapabilityRefs(value: unknown, output: VersionedRef[]): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walkCapabilityRefs(item, output);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'capability_ref') {
      const ref = versionedRef(child);
      if (ref) output.push(ref);
    } else if (key === 'allowed_capabilities' && Array.isArray(child)) {
      for (const item of child) {
        const ref = versionedRef(item);
        if (ref) output.push(ref);
      }
    }
    walkCapabilityRefs(child, output);
  }
}

function assertHostBindings(input: {
  kind: G3RegistryResourceType;
  content: JsonObject;
  packCapabilityRefs: ReadonlySet<string>;
  allowlist: WorkflowPackHostBindingAllowlist;
  sourcePath: string;
}): void {
  if (
    input.kind === 'executor_implementation' ||
    input.kind === 'outbox_adapter'
  ) {
    throw new WorkflowPackLoadError(
      'host_binding_forbidden',
      `${input.sourcePath} cannot publish Host implementations`,
    );
  }
  if (input.kind === 'capability') {
    const executor = versionedRef(input.content.executor_ref);
    if (!executor || !input.allowlist.executors.has(refKey(executor))) {
      throw new WorkflowPackLoadError(
        'host_binding_forbidden',
        `${input.sourcePath} references a non-allowlisted Core executor`,
      );
    }
    const outbox = input.content.outbox_effect;
    const adapter =
      outbox && typeof outbox === 'object' && !Array.isArray(outbox)
        ? versionedRef((outbox as JsonObject).adapter_ref)
        : null;
    if (adapter && !input.allowlist.adapters.has(refKey(adapter))) {
      throw new WorkflowPackLoadError(
        'host_binding_forbidden',
        `${input.sourcePath} references a non-allowlisted Core adapter`,
      );
    }
  }
  const capabilityRefs: VersionedRef[] = [];
  walkCapabilityRefs(input.content, capabilityRefs);
  for (const capabilityRef of capabilityRefs) {
    const key = refKey(capabilityRef);
    if (
      !input.packCapabilityRefs.has(key) &&
      !input.allowlist.capabilities.has(key)
    ) {
      throw new WorkflowPackLoadError(
        'host_binding_forbidden',
        `${input.sourcePath} references non-allowlisted Capability ${key}`,
      );
    }
  }
}

interface CompilerSnapshotResource extends JsonObject {
  readonly resource_type: G3RegistryResourceType;
  readonly ref: VersionedRef;
  readonly content_hash: Sha256Hash;
  readonly content: JsonObject;
}

interface WorkflowPackCompilationEvidence extends JsonObject {
  readonly recipe_ref: VersionedRef;
  readonly definition_ref: VersionedRef;
  readonly entry_point: string;
  readonly source_hash: Sha256Hash;
  readonly plan_hash: Sha256Hash;
  readonly compiler_snapshot_hash: Sha256Hash;
}

function snapshotResourceKey(resource: {
  readonly resource_type: string;
  readonly ref: VersionedRef;
}): string {
  return `${resource.resource_type}\0${refKey(resource.ref)}`;
}

function compilerSnapshotResources(
  snapshot: JsonObject,
): CompilerSnapshotResource[] {
  const registry = snapshot.registry_snapshot;
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    throw new WorkflowPackLoadError(
      'compile_invalid',
      'Core compiler Registry snapshot is unavailable',
    );
  }
  const resources = (registry as JsonObject).resources;
  if (!Array.isArray(resources)) {
    throw new WorkflowPackLoadError(
      'compile_invalid',
      'Core compiler Registry resources are unavailable',
    );
  }
  return resources.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new WorkflowPackLoadError(
        'compile_invalid',
        'Core compiler Registry resource is invalid',
      );
    }
    const resource = value as JsonObject;
    const ref = versionedRef(resource.ref);
    if (
      !ref ||
      typeof resource.resource_type !== 'string' ||
      typeof resource.content_hash !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(resource.content_hash) ||
      !resource.content ||
      typeof resource.content !== 'object' ||
      Array.isArray(resource.content)
    ) {
      throw new WorkflowPackLoadError(
        'compile_invalid',
        'Core compiler Registry resource identity is invalid',
      );
    }
    return resource as unknown as CompilerSnapshotResource;
  });
}

function exactPackRecordByRef(
  records: readonly G3RegistryResourceRecord[],
): Map<string, G3RegistryResourceRecord> {
  const byRef = new Map<string, G3RegistryResourceRecord>();
  for (const resource of records) {
    const key = refKey(resource.ref);
    if (byRef.has(key)) {
      throw new WorkflowPackLoadError(
        'dependency_invalid',
        `Workflow Pack resource ref is ambiguous across kinds: ${key}`,
      );
    }
    byRef.set(key, resource);
  }
  return byRef;
}

function compilerDependencyClosure(
  root: CompilerSnapshotResource,
  resourcesByRef: ReadonlyMap<string, CompilerSnapshotResource>,
): JsonObject {
  const members = new Map<string, CompilerSnapshotResource>();
  const pending = resourceDependencyRefs({
    ref: root.ref,
    resourceType: root.resource_type,
    contentHash: root.content_hash,
    publicationState: 'published',
    launchability: 'production',
    content: root.content,
  });
  while (pending.length > 0) {
    const dependency = pending.shift()!;
    const key = refKey(dependency);
    if (key === refKey(root.ref) || members.has(key)) continue;
    const target = resourcesByRef.get(key);
    if (!target) {
      throw new WorkflowPackLoadError(
        'dependency_invalid',
        `Capability ${refKey(root.ref)} dependency ${key} is not in the exact compiler snapshot`,
      );
    }
    members.set(key, target);
    pending.push(
      ...resourceDependencyRefs({
        ref: target.ref,
        resourceType: target.resource_type,
        contentHash: target.content_hash,
        publicationState: 'published',
        launchability: 'production',
        content: target.content,
      }),
    );
  }
  const sorted = [...members.values()]
    .sort((left, right) => compareAscii(refKey(left.ref), refKey(right.ref)))
    .map((resource) => ({
      resource_type: resource.resource_type,
      ref: resource.ref,
      content_hash: resource.content_hash,
    }));
  const payload: JsonObject = {
    format: 'icarus.workflow-registry-dependency-closure/1',
    root_resource_type: root.resource_type,
    root_ref: root.ref,
    members: sorted,
    member_count: sorted.length,
  };
  return {
    ...payload,
    closure_hash: domainSeparatedSha256(
      'icarus:workflow-registry-dependency-closure:1\n',
      payload,
    ),
  };
}

function replaceHash(
  value: JsonObject,
  hashKey: string,
  domain: string,
): JsonObject {
  const withoutHash = { ...value };
  delete withoutHash[hashKey];
  return {
    ...withoutHash,
    [hashKey]: domainSeparatedSha256(domain, withoutHash),
  };
}

function buildPackCompilerSnapshot(input: {
  readonly packRef: VersionedRef;
  readonly allowlist: WorkflowPackHostBindingAllowlist;
  readonly records: readonly G3RegistryResourceRecord[];
}): {
  readonly snapshot: JsonObject;
  readonly coreBindings: G3RegistryResourceIdentity[];
} {
  if (!input.allowlist.compilerSnapshot) {
    throw new WorkflowPackLoadError(
      'compile_invalid',
      'Core System Recipe compiler authority must be published before loading Workflow Packs',
    );
  }
  const snapshot = structuredClone(input.allowlist.compilerSnapshot);
  const coreResources = compilerSnapshotResources(snapshot);
  const packResources: CompilerSnapshotResource[] = input.records.map(
    (resource) => ({
      resource_type: resource.resource_type,
      ref: resource.ref,
      content_hash: resource.content_hash,
      content: resource.content,
      publication_state: 'published',
      launchability: 'production',
    }),
  );
  const compilerAuthority = `workflow-pack:${input.packRef.id}:compiler:${domainSeparatedSha256(
    'icarus:workflow-pack-compiler-authority:1\n',
    {
      core_snapshot_hash: snapshot.snapshot_hash ?? null,
      resources: packResources
        .map((resource) => ({
          resource_type: resource.resource_type,
          ref: resource.ref,
          content_hash: resource.content_hash,
        }))
        .sort((left, right) =>
          compareAscii(registryResourceKey(left), registryResourceKey(right)),
        ),
    },
  ).slice('sha256:'.length)}`;
  const allResources = [...coreResources, ...packResources];
  const resourcesByRef = new Map<string, CompilerSnapshotResource>();
  const resourcesByIdentity = new Set<string>();
  for (const resource of allResources) {
    const identity = snapshotResourceKey(resource);
    const ref = refKey(resource.ref);
    if (resourcesByIdentity.has(identity) || resourcesByRef.has(ref)) {
      throw new WorkflowPackLoadError(
        'dependency_invalid',
        `Workflow Pack compiler resource collides with an exact Core or Pack ref: ${ref}`,
      );
    }
    resourcesByIdentity.add(identity);
    resourcesByRef.set(ref, resource);
  }

  const registry = snapshot.registry_snapshot as JsonObject;
  const closures = Array.isArray(registry.dependency_closures)
    ? structuredClone(registry.dependency_closures)
    : [];
  for (const capability of packResources.filter(
    (resource) => resource.resource_type === 'capability',
  )) {
    const closure = compilerDependencyClosure(capability, resourcesByRef);
    if (capability.content.dependency_closure_hash !== closure.closure_hash) {
      throw new WorkflowPackLoadError(
        'compile_invalid',
        `Capability ${refKey(capability.ref)} dependency_closure_hash is not exact`,
      );
    }
    closures.push(closure);
  }
  const registryWithPack: JsonObject = {
    ...registry,
    snapshot_ref: `${compilerAuthority}:registry`,
    resources: allResources.sort((left, right) =>
      compareAscii(refKey(left.ref), refKey(right.ref)),
    ),
    resource_count: allResources.length,
    dependency_closures: closures.sort((left, right) =>
      compareAscii(
        `${String((left as JsonObject).root_resource_type)}:${refKey((left as JsonObject).root_ref as VersionedRef)}`,
        `${String((right as JsonObject).root_resource_type)}:${refKey((right as JsonObject).root_ref as VersionedRef)}`,
      ),
    ),
    dependency_closure_count: closures.length,
  };
  snapshot.registry_snapshot = replaceHash(
    registryWithPack,
    'snapshot_hash',
    'icarus:workflow-pack-compiler-registry-snapshot:1\n',
  );

  const interfaceSnapshot = snapshot.interface_snapshot;
  if (
    !interfaceSnapshot ||
    typeof interfaceSnapshot !== 'object' ||
    Array.isArray(interfaceSnapshot) ||
    !Array.isArray((interfaceSnapshot as JsonObject).interfaces)
  ) {
    throw new WorkflowPackLoadError(
      'compile_invalid',
      'Core compiler Interface snapshot is unavailable',
    );
  }
  const interfaces = structuredClone(
    (interfaceSnapshot as JsonObject).interfaces as JsonObject[],
  );
  for (const resource of packResources.filter(
    (candidate) => candidate.resource_type === 'scope_interface',
  )) {
    if (!versionedRef(resource.content.ref)) {
      throw new WorkflowPackLoadError(
        'compile_invalid',
        `Scope Interface ${refKey(resource.ref)} has no exact ref`,
      );
    }
    interfaces.push(resource.content);
  }
  snapshot.interface_snapshot = replaceHash(
    {
      ...(interfaceSnapshot as JsonObject),
      snapshot_ref: `${compilerAuthority}:interfaces`,
      interfaces: interfaces.sort((left, right) =>
        compareAscii(
          refKey(left.ref as VersionedRef),
          refKey(right.ref as VersionedRef),
        ),
      ),
      interface_count: interfaces.length,
    },
    'snapshot_hash',
    'icarus:workflow-pack-compiler-interface-snapshot:1\n',
  );

  const policySnapshot = snapshot.policy_snapshot;
  if (
    !policySnapshot ||
    typeof policySnapshot !== 'object' ||
    Array.isArray(policySnapshot) ||
    !policySnapshot.complete_policy ||
    typeof policySnapshot.complete_policy !== 'object' ||
    Array.isArray(policySnapshot.complete_policy)
  ) {
    throw new WorkflowPackLoadError(
      'compile_invalid',
      'Core compiler Policy snapshot is unavailable',
    );
  }
  const completePolicy = structuredClone(
    policySnapshot.complete_policy as JsonObject,
  );
  const childProfiles = Array.isArray(completePolicy.child_profiles)
    ? structuredClone(completePolicy.child_profiles)
    : [];
  for (const resource of packResources.filter(
    (candidate) => candidate.resource_type === 'graph_policy',
  )) {
    const policyRef = versionedRef(resource.content.ref);
    const request = resource.content.request;
    if (
      !policyRef ||
      !request ||
      typeof request !== 'object' ||
      Array.isArray(request)
    ) {
      throw new WorkflowPackLoadError(
        'compile_invalid',
        `Graph Policy ${refKey(resource.ref)} is invalid`,
      );
    }
    childProfiles.push({ ref: policyRef, request });
  }
  completePolicy.child_profiles = childProfiles;
  const normalizedPolicy = replaceHash(
    completePolicy,
    'policy_hash',
    'icarus:workflow-pack-compiler-policy-snapshot:1\n',
  );
  snapshot.policy_snapshot = {
    ...(policySnapshot as JsonObject),
    snapshot_ref: `${compilerAuthority}:policy`,
    complete_policy: normalizedPolicy,
  };
  snapshot.format = 'icarus.workflow-compiler-input-snapshot/2';
  snapshot.snapshot_id = compilerAuthority;
  snapshot.launchability = 'production';
  const normalizedSnapshot = replaceHash(
    snapshot,
    'snapshot_hash',
    'icarus:workflow-pack-compiler-snapshot:1\n',
  );
  return {
    snapshot: normalizedSnapshot,
    coreBindings: coreResources
      .map((resource) => ({
        resource_type: resource.resource_type,
        ref: resource.ref,
        content_hash: resource.content_hash,
      }))
      .sort((left, right) =>
        compareAscii(registryResourceKey(left), registryResourceKey(right)),
      ),
  };
}

function assertRecipeContractRef(input: {
  readonly recipePath: string;
  readonly recipe: JsonObject;
  readonly field: string;
  readonly expectedType: G3RegistryResourceType;
  readonly recordsByRef: ReadonlyMap<string, G3RegistryResourceRecord>;
}): G3RegistryResourceRecord {
  const ref = versionedRef(input.recipe[input.field]);
  const resource = ref ? input.recordsByRef.get(refKey(ref)) : undefined;
  if (!ref || !resource || resource.resource_type !== input.expectedType) {
    throw new WorkflowPackLoadError(
      'dependency_invalid',
      `${input.recipePath} ${input.field} must resolve an exact Pack-owned ${input.expectedType}`,
    );
  }
  return resource;
}

function assertClosedSourceReferences(input: {
  readonly sources: readonly {
    entry: WorkflowPackManifestDocument['workflow_resources'][number];
    content: JsonObject;
  }[];
  readonly packRecords: readonly G3RegistryResourceRecord[];
  readonly compilerSnapshot: JsonObject;
}): void {
  const available = new Map<string, string>();
  for (const resource of [
    ...compilerSnapshotResources(input.compilerSnapshot),
    ...input.packRecords.map((record) => ({
      resource_type: record.resource_type,
      ref: record.ref,
      content_hash: record.content_hash,
      content: record.content,
    })),
  ]) {
    const key = refKey(resource.ref);
    const previous = available.get(key);
    if (previous && previous !== resource.resource_type) {
      throw new WorkflowPackLoadError(
        'dependency_invalid',
        `Compiler resource ref ${key} is ambiguous across ${previous} and ${resource.resource_type}`,
      );
    }
    available.set(key, resource.resource_type);
  }
  for (const source of input.sources) {
    const refs = resourceDependencyRefs({
      ref: source.entry.ref,
      resourceType: source.entry.kind,
      contentHash: source.entry.expected_source_hash as Sha256Hash,
      publicationState: 'staged',
      launchability: 'production',
      content: source.content,
    });
    for (const ref of refs) {
      if (!available.has(refKey(ref))) {
        throw new WorkflowPackLoadError(
          'dependency_invalid',
          `${source.entry.source_path} references unavailable exact resource ${refKey(ref)}`,
        );
      }
    }
  }
}

function validateAndBindRecipes(input: {
  readonly loadedSources: Array<{
    entry: WorkflowPackManifestDocument['workflow_resources'][number];
    content: JsonObject;
  }>;
  readonly records: readonly G3RegistryResourceRecord[];
  readonly compilerSnapshot: JsonObject;
  readonly permissions: WorkflowPackExecutionPermissions;
}): WorkflowPackCompilationEvidence[] {
  const recordsByRef = exactPackRecordByRef(input.records);
  const evidence: WorkflowPackCompilationEvidence[] = [];
  for (const source of input.loadedSources.filter(
    ({ entry }) => entry.kind === 'recipe',
  )) {
    const definition = assertRecipeContractRef({
      recipePath: source.entry.source_path,
      recipe: source.content,
      field: 'workflow_definition_ref',
      expectedType: 'definition',
      recordsByRef,
    });
    const executionPolicy = assertRecipeContractRef({
      recipePath: source.entry.source_path,
      recipe: source.content,
      field: 'workflow_execution_policy_ref',
      expectedType: 'execution_policy',
      recordsByRef,
    });
    for (const [field, expectedType] of [
      ['workflow_command_policy_ref', 'command_policy'],
      ['input_schema_ref', 'schema'],
      ['context_contract_ref', 'context_contract'],
      ['routing_scope_ref', 'routing_scope'],
    ] as const) {
      assertRecipeContractRef({
        recipePath: source.entry.source_path,
        recipe: source.content,
        field,
        expectedType,
        recordsByRef,
      });
    }
    const entryPoint = source.content.entry_point;
    if (typeof entryPoint !== 'string' || entryPoint.length === 0) {
      throw new WorkflowPackLoadError(
        'compile_invalid',
        `${source.entry.source_path} has no exact entry_point`,
      );
    }
    const outcome = compileWorkflow({
      caseId: `workflow-pack:${refKey(source.entry.ref)}`,
      sourceKind: 'workflow_definition',
      rawSourceBytes: Buffer.from(canonicalJson(definition.content), 'utf8'),
      inputSnapshot: input.compilerSnapshot,
      entryPoint,
    });
    if (!outcome.ok) {
      throw new WorkflowPackLoadError(
        'compile_invalid',
        `${source.entry.source_path} Definition failed compile: ${canonicalJson(
          outcome.value.diagnostics.map((diagnostic) => ({
            code: diagnostic.code,
            phase: diagnostic.phase,
            pointer: diagnostic.pointer ?? null,
          })),
        )}`,
      );
    }
    assertRecipePermissions({
      recipePath: source.entry.source_path,
      recipe: source.content,
      compiledPlan: outcome.value.plan as unknown as JsonObject,
      permissions: input.permissions,
    });
    const precompiled = definition.content.precompiled_plan;
    if (
      precompiled !== undefined &&
      canonicalJson(precompiled) !== canonicalJson(outcome.value.plan)
    ) {
      throw new WorkflowPackLoadError(
        'compile_invalid',
        `${source.entry.source_path} reviewed Plan does not match the production compiler`,
      );
    }
    const pin = definition.content.compiled_plan_pin;
    if (
      pin &&
      typeof pin === 'object' &&
      !Array.isArray(pin) &&
      (pin.plan_hash !== outcome.value.plan.plan_hash ||
        pin.compiler_version !== WORKFLOW_COMPILER_VERSION)
    ) {
      throw new WorkflowPackLoadError(
        'compile_invalid',
        `${source.entry.source_path} compiled_plan_pin does not match the production compiler`,
      );
    }
    source.content = {
      ...source.content,
      compiler_input_snapshot: input.compilerSnapshot,
    };
    evidence.push({
      recipe_ref: source.entry.ref,
      definition_ref: definition.ref,
      entry_point: entryPoint,
      source_hash: outcome.value.sourceHash,
      plan_hash: outcome.value.plan.plan_hash as Sha256Hash,
      compiler_snapshot_hash: input.compilerSnapshot
        .snapshot_hash as Sha256Hash,
    });
  }
  return evidence;
}

function record(input: {
  resourceType: G3RegistryResourceType;
  ref: VersionedRef;
  packId: string;
  schemaRef: VersionedRef;
  schemaHash: Sha256Hash;
  content: JsonObject;
  dependencies?: G3RegistryResourceDependency[];
}): G3RegistryResourceRecord {
  const base = {
    format: G3_REGISTRY_PERSISTENCE_FORMATS.resource,
    resource_type: input.resourceType,
    ref: input.ref,
    owner: { kind: 'pack' as const, pack_id: input.packId },
    schema_ref: input.schemaRef,
    schema_hash: input.schemaHash,
    content: input.content,
    dependencies: input.dependencies ?? [],
  };
  return { ...base, content_hash: calculateRegistryResourceContentHash(base) };
}

export function loadWorkflowPack(input: {
  packRoot: string;
  allowlist: WorkflowPackHostBindingAllowlist;
  nowMs: number;
}): LoadedWorkflowPack {
  const root = path.resolve(input.packRoot);
  const manifestPath = path.join(root, 'pack.json');
  assertRegularFileInside(root, manifestPath, 'pack.json');
  const manifest = parseWorkflowPackManifest(fs.readFileSync(manifestPath));
  const permissions = parseWorkflowPackExecutionPermissions(
    manifest.permissions,
  );
  for (const fileScope of permissions.file_scopes) {
    if (!PACK_FILE_SCOPES.has(fileScope)) {
      throw new WorkflowPackLoadError(
        'source_invalid',
        `Workflow Pack file scope is unsupported: ${fileScope}`,
      );
    }
  }
  if (path.basename(root) !== manifest.pack_ref.id) {
    throw new WorkflowPackLoadError(
      'source_invalid',
      `Workflow Pack directory must match pack_ref.id ${manifest.pack_ref.id}`,
    );
  }
  if (manifest.workflow_resources.length === 0) {
    throw new WorkflowPackLoadError(
      'source_invalid',
      'Workflow Pack must declare at least one Workflow resource',
    );
  }
  if (!manifest.workflow_resources.some((entry) => entry.kind === 'recipe')) {
    throw new WorkflowPackLoadError(
      'source_invalid',
      'Workflow Pack must publish at least one selectable Recipe',
    );
  }
  if (manifest.dependencies.length > 0) {
    throw new WorkflowPackLoadError(
      'dependency_invalid',
      'Workflow Pack v1 does not support cross-Pack dependencies',
    );
  }
  const manifestResourceKeys = manifest.workflow_resources.map(
    (entry) => `${entry.kind}\0${refKey(entry.ref)}`,
  );
  if (new Set(manifestResourceKeys).size !== manifestResourceKeys.length) {
    throw new WorkflowPackLoadError(
      'dependency_invalid',
      'Workflow Pack manifest contains duplicate resource identities',
    );
  }

  const packCapabilityRefs = new Set<string>();
  const loadedSources = manifest.workflow_resources.map((entry) => {
    const sourcePath = resolveWorkflowPackPath(
      root,
      entry.source_path,
      `workflow_resources.${refKey(entry.ref)}.source_path`,
    );
    if (!fs.existsSync(sourcePath)) {
      throw new WorkflowPackLoadError(
        'source_path_invalid',
        `Workflow Pack source does not exist: ${sourcePath}`,
      );
    }
    assertRegularFileInside(root, sourcePath, entry.source_path);
    const bytes = fs.readFileSync(sourcePath);
    const observedHash = rawSha256(bytes);
    if (observedHash !== entry.expected_source_hash) {
      throw new WorkflowPackLoadError(
        'source_hash_mismatch',
        `${entry.source_path} hash mismatch: expected ${entry.expected_source_hash}, received ${observedHash}`,
      );
    }
    const content = strictParseJsonBytes(bytes);
    assertJsonObject(content);
    assertNoHostLifecycle(content, entry.source_path);
    validateWorkflowPackSourceDocument({
      kind: entry.kind,
      sourcePath: entry.source_path,
      content,
    });
    const contentRef = versionedRef(content.ref);
    if (
      contentRef &&
      (contentRef.id !== entry.ref.id ||
        contentRef.version !== entry.ref.version)
    ) {
      throw new WorkflowPackLoadError(
        'source_invalid',
        `${entry.source_path} ref does not match its manifest entry`,
      );
    }
    if (entry.kind === 'recipe') {
      if (
        content.owner_pack_id !== manifest.pack_ref.id ||
        content.catalog_visibility !== 'selectable' ||
        content.system_purposes !== undefined
      ) {
        throw new WorkflowPackLoadError(
          'source_invalid',
          `${entry.source_path} must be a selectable Pack-owned Recipe`,
        );
      }
    }
    assertHostBindings({
      kind: entry.kind,
      content,
      packCapabilityRefs,
      allowlist: input.allowlist,
      sourcePath: entry.source_path,
    });
    return { entry, content };
  });

  const executionSourceDirectories: Partial<
    Record<'agents' | 'skills' | 'mcp' | 'scripts' | 'templates', string>
  > = {};
  const executionResourceFiles: Partial<
    Record<
      WorkflowPackExecutionResourceKind,
      WorkflowPackExecutionResourceFile[]
    >
  > = {};
  for (const kind of [
    'agents',
    'skills',
    'mcp',
    'scripts',
    'templates',
  ] as const) {
    const relative = manifest.execution_resources[kind];
    if (typeof relative !== 'string') continue;
    const directory = resolveWorkflowPackPath(
      root,
      relative,
      `execution_resources.${kind}`,
    );
    if (!fs.existsSync(directory)) {
      throw new WorkflowPackLoadError(
        'execution_resource_invalid',
        `Workflow Pack execution resource does not exist: ${directory}`,
      );
    }
    assertDirectoryTreeContainsNoLinks(
      directory,
      `execution_resources.${kind}`,
    );
    executionSourceDirectories[kind] = directory;
    executionResourceFiles[kind] = inventoryDirectory(directory);
  }
  validatePackMcpConfig(executionSourceDirectories.mcp, permissions);

  const schemaRef = {
    id: `${manifest.pack_ref.id}.source-json-schema`,
    version: '1.0.0',
  };
  const schemaContent: JsonObject = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
  };
  const schemaBase = {
    format: G3_REGISTRY_PERSISTENCE_FORMATS.resource,
    resource_type: 'schema' as const,
    ref: schemaRef,
    owner: { kind: 'pack' as const, pack_id: manifest.pack_ref.id },
    schema_ref: schemaRef,
    schema_hash: '' as Sha256Hash,
    content: schemaContent,
    dependencies: [] as G3RegistryResourceDependency[],
  };
  const schema = {
    ...schemaBase,
    content_hash: calculateRegistryResourceContentHash(schemaBase),
  } as G3RegistryResourceRecord;
  schema.schema_hash = schema.content_hash;
  const schemaDependency: G3RegistryResourceDependency = {
    resource_type: 'schema',
    ref: schemaRef,
    content_hash: schema.content_hash,
    dependency_kind: G3_REGISTRY_DEPENDENCY_KIND,
  };
  const preliminaryRecords = loadedSources
    .filter(({ entry }) => entry.kind !== 'recipe')
    .map(({ entry, content }) =>
      record({
        resourceType: entry.kind,
        ref: entry.ref,
        packId: manifest.pack_ref.id,
        schemaRef,
        schemaHash: schema.content_hash,
        content,
        dependencies: [schemaDependency],
      }),
    );
  exactPackRecordByRef(preliminaryRecords);
  const compiler = buildPackCompilerSnapshot({
    packRef: manifest.pack_ref,
    allowlist: input.allowlist,
    records: preliminaryRecords,
  });
  try {
    bindCompilerSnapshot(compiler.snapshot);
  } catch (error) {
    throw new WorkflowPackLoadError(
      'compile_invalid',
      `Workflow Pack compiler snapshot is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertClosedSourceReferences({
    sources: loadedSources,
    packRecords: preliminaryRecords,
    compilerSnapshot: compiler.snapshot,
  });
  const compilationEvidence = validateAndBindRecipes({
    loadedSources,
    records: preliminaryRecords,
    compilerSnapshot: compiler.snapshot,
    permissions,
  });
  const sourceRecords = loadedSources.map(({ entry, content }) =>
    record({
      resourceType: entry.kind,
      ref: entry.ref,
      packId: manifest.pack_ref.id,
      schemaRef,
      schemaHash: schema.content_hash,
      content,
      dependencies: [schemaDependency],
    }),
  );
  const sourceRecordByRef = exactPackRecordByRef(sourceRecords);
  for (const resource of sourceRecords) {
    const dependencies = new Map<string, G3RegistryResourceDependency>([
      [registryResourceKey(schemaDependency), schemaDependency],
    ]);
    for (const ref of resourceDependencyRefs({
      ref: resource.ref,
      resourceType: resource.resource_type,
      contentHash: resource.content_hash,
      publicationState: 'staged',
      launchability: 'production',
      content: resource.content,
    })) {
      const target = sourceRecordByRef.get(refKey(ref));
      if (!target || target === resource) continue;
      const dependency: G3RegistryResourceDependency = {
        resource_type: target.resource_type,
        ref: target.ref,
        content_hash: target.content_hash,
        dependency_kind: G3_REGISTRY_DEPENDENCY_KIND,
      };
      dependencies.set(registryResourceKey(dependency), dependency);
    }
    resource.dependencies = [...dependencies.values()].sort((left, right) =>
      compareAscii(registryResourceKey(left), registryResourceKey(right)),
    );
  }
  const executionArtifactRef = {
    id: `${manifest.pack_ref.id}.execution-bundle`,
    version: manifest.pack_ref.version,
  };
  const artifactDependencies = [schema, ...sourceRecords]
    .map((resource) => ({
      resource_type: resource.resource_type,
      ref: resource.ref,
      content_hash: resource.content_hash,
      dependency_kind: G3_REGISTRY_DEPENDENCY_KIND,
    }))
    .sort((left, right) =>
      compareAscii(registryResourceKey(left), registryResourceKey(right)),
    );
  const executionArtifactContent: JsonObject = {
    format: 'icarus.workflow-pack-execution-bundle/1',
    pack_ref: manifest.pack_ref,
    manifest_hash: manifest.manifest_hash as Sha256Hash,
    permissions,
    resources: manifest.execution_resources,
    execution_resource_files: executionResourceFiles,
    core_compiler_bindings: compiler.coreBindings,
    compiler_validation: compilationEvidence,
    self_contained_registry_values: true,
    staged_execution_resources: true,
  };
  const executionArtifact = record({
    resourceType: 'pack_execution_artifact',
    ref: executionArtifactRef,
    packId: manifest.pack_ref.id,
    schemaRef,
    schemaHash: schema.content_hash,
    content: executionArtifactContent,
    dependencies: artifactDependencies,
  });
  const resources = [schema, ...sourceRecords, executionArtifact].sort(
    (left, right) =>
      compareAscii(registryResourceKey(left), registryResourceKey(right)),
  );
  const closure = buildDependencyClosure(
    resources,
    { resource_type: 'pack_execution_artifact', ref: executionArtifactRef },
    {
      id: `${manifest.pack_ref.id}.release-closure`,
      version: manifest.pack_ref.version,
    },
    { ...schemaRef, hash: schema.content_hash },
  );
  const snapshotWithoutHash = {
    format: G3_REGISTRY_PERSISTENCE_FORMATS.snapshot,
    ref: {
      id: `${manifest.pack_ref.id}.registry-snapshot`,
      version: manifest.pack_ref.version,
    },
    closure_ref: closure.ref,
    closure_hash: closure.closure_hash,
    compiler_version: WORKFLOW_COMPILER_VERSION,
  } satisfies Omit<G3RegistrySnapshot, 'snapshot_hash'>;
  const registryBatch: G3RegistryPersistenceBatch = {
    resources,
    closure,
    snapshot: {
      ...snapshotWithoutHash,
      snapshot_hash: calculateRegistrySnapshotHash(snapshotWithoutHash),
    },
    created_at_ms: input.nowMs,
  };
  const releaseHash = domainSeparatedSha256(RELEASE_HASH_DOMAIN, {
    pack_ref: manifest.pack_ref,
    manifest_hash: manifest.manifest_hash,
    registry_snapshot_ref: registryBatch.snapshot.ref,
    registry_snapshot_hash: registryBatch.snapshot.snapshot_hash,
    execution_artifact_ref: executionArtifact.ref,
    execution_artifact_hash: executionArtifact.content_hash,
  });
  return {
    root,
    manifestPath,
    manifest,
    registryBatch,
    releaseHash,
    executionArtifact: {
      resource_type: 'pack_execution_artifact',
      ref: executionArtifact.ref,
      content_hash: executionArtifact.content_hash,
    },
    recipes: sourceRecords
      .filter((resource) => resource.resource_type === 'recipe')
      .map((resource) => ({
        resource_type: resource.resource_type,
        ref: resource.ref,
        content_hash: resource.content_hash,
      })),
    executionSourceDirectories,
    executionResourceFiles,
    executionPermissions: permissions,
  };
}

export function stageWorkflowPackExecutionResources(input: {
  pack: LoadedWorkflowPack;
  stagingRoot: string;
}): string {
  const suffix = input.pack.manifest.manifest_hash.slice('sha256:'.length);
  const packStagingRoot = path.join(
    path.resolve(input.stagingRoot),
    input.pack.manifest.pack_ref.id,
  );
  const target = path.join(packStagingRoot, suffix);
  const executionArtifactResourceId = registryResourceId(
    input.pack.executionArtifact,
  );
  if (fs.existsSync(target)) {
    return verifyStagedWorkflowPackExecutionBundle({
      rootPath: target,
      packId: input.pack.manifest.pack_ref.id,
      packVersion: input.pack.manifest.pack_ref.version,
      manifestHash: input.pack.manifest.manifest_hash as Sha256Hash,
      executionArtifactResourceId,
      executionArtifactHash: input.pack.executionArtifact.content_hash,
      executionResourceFiles: input.pack.executionResourceFiles,
      permissions: input.pack.executionPermissions,
    });
  }
  fs.mkdirSync(packStagingRoot, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(packStagingRoot, '.staging-'));
  try {
    for (const [kind, source] of Object.entries(
      input.pack.executionSourceDirectories,
    )) {
      if (!source) continue;
      fs.cpSync(source, path.join(temporary, kind), {
        recursive: true,
        force: false,
        dereference: false,
      });
    }
    fs.writeFileSync(
      path.join(temporary, 'bundle.json'),
      `${JSON.stringify(
        {
          format: 'icarus.workflow-pack-execution-staging/1',
          pack_ref: input.pack.manifest.pack_ref,
          manifest_hash: input.pack.manifest.manifest_hash,
          execution_artifact_resource_id: executionArtifactResourceId,
          execution_artifact_hash: input.pack.executionArtifact.content_hash,
          execution_resource_files: input.pack.executionResourceFiles,
          permissions: input.pack.executionPermissions,
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return verifyStagedWorkflowPackExecutionBundle({
    rootPath: target,
    packId: input.pack.manifest.pack_ref.id,
    packVersion: input.pack.manifest.pack_ref.version,
    manifestHash: input.pack.manifest.manifest_hash as Sha256Hash,
    executionArtifactResourceId,
    executionArtifactHash: input.pack.executionArtifact.content_hash,
    executionResourceFiles: input.pack.executionResourceFiles,
    permissions: input.pack.executionPermissions,
  });
}
