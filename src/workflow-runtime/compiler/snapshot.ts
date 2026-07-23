import { domainSeparatedSha256 } from '../contracts/hash.js';
import { assertJsonObject } from '../contracts/strict-json.js';
import type {
  JsonObject,
  JsonValue,
  Sha256Hash,
  VersionedRef,
} from '../contracts/types.js';
import { compareAscii } from './normalizer.js';

export interface SnapshotResource {
  ref: VersionedRef;
  resourceType: string;
  contentHash: Sha256Hash;
  publicationState: string | null;
  launchability: string | null;
  content: JsonObject;
}

export interface SnapshotDependencyClosureMember {
  resourceType: string;
  ref: VersionedRef;
  contentHash: Sha256Hash;
}

export interface SnapshotDependencyClosure {
  rootResourceType: string;
  rootRef: VersionedRef;
  members: SnapshotDependencyClosureMember[];
  memberCount: number;
  closureHash: Sha256Hash;
}

export interface BoundCompilerSnapshot {
  snapshotHash: Sha256Hash;
  compilerIdentity: JsonObject;
  resources: SnapshotResource[];
  resourceByKey: Map<string, SnapshotResource>;
  dependencyClosures: SnapshotDependencyClosure[];
  dependencyClosureByKey: Map<string, SnapshotDependencyClosure>;
  interfaces: JsonObject[];
  interfaceByKey: Map<string, JsonObject>;
  rootPolicy: JsonObject;
  rootPolicyHash: Sha256Hash;
  childProfiles: JsonObject[];
  safety: JsonObject;
  safetyHash: Sha256Hash;
}

export function refKey(ref: VersionedRef | JsonObject): string {
  return `${String(ref.id)}@${String(ref.version)}`;
}

function asHash(value: JsonValue, label: string): Sha256Hash {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`Compiler snapshot ${label} is not a SHA-256 identity`);
  }
  return value as Sha256Hash;
}

function asObjectArray(value: JsonValue, label: string): JsonObject[] {
  if (!Array.isArray(value)) {
    throw new Error(`Compiler snapshot ${label} must be an array`);
  }
  return value.map((entry) => {
    assertJsonObject(entry);
    return entry;
  });
}

function dependencyClosureKey(resourceType: string, ref: VersionedRef): string {
  return `${resourceType}:${refKey(ref)}`;
}

export function resourceDependencyRefs(
  resource: SnapshotResource,
): VersionedRef[] {
  const dependencies = new Map<string, VersionedRef>();
  const rootKey = refKey(resource.ref);
  const visit = (value: JsonValue): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value.id === 'string' && typeof value.version === 'string') {
      const dependency = value as VersionedRef;
      const key = refKey(dependency);
      if (key !== rootKey) dependencies.set(key, dependency);
      return;
    }
    Object.values(value).forEach(visit);
  };
  visit(resource.content);
  return [...dependencies.values()].sort((left, right) =>
    compareAscii(refKey(left), refKey(right)),
  );
}

export function bindCompilerSnapshot(
  snapshot: JsonObject,
): BoundCompilerSnapshot {
  assertJsonObject(snapshot.compiler_identity);
  assertJsonObject(snapshot.registry_snapshot);
  assertJsonObject(snapshot.interface_snapshot);
  assertJsonObject(snapshot.policy_snapshot);
  assertJsonObject(snapshot.safety_snapshot);
  const registryResources = asObjectArray(
    snapshot.registry_snapshot.resources,
    'registry resources',
  );
  const resources = registryResources.map((entry): SnapshotResource => {
    assertJsonObject(entry.ref);
    assertJsonObject(entry.content);
    return {
      ref: entry.ref as VersionedRef,
      resourceType: String(entry.resource_type),
      contentHash: asHash(entry.content_hash, 'resource content_hash'),
      publicationState:
        typeof entry.publication_state === 'string'
          ? entry.publication_state
          : null,
      launchability:
        typeof entry.launchability === 'string' ? entry.launchability : null,
      content: entry.content,
    };
  });
  const dependencyClosures = asObjectArray(
    snapshot.registry_snapshot.dependency_closures ?? [],
    'registry dependency closures',
  ).map((entry): SnapshotDependencyClosure => {
    assertJsonObject(entry.root_ref);
    const members = asObjectArray(
      entry.members,
      'registry dependency closure members',
    ).map((member): SnapshotDependencyClosureMember => {
      assertJsonObject(member.ref);
      return {
        resourceType: String(member.resource_type),
        ref: member.ref as VersionedRef,
        contentHash: asHash(
          member.content_hash,
          'dependency member content_hash',
        ),
      };
    });
    return {
      rootResourceType: String(entry.root_resource_type),
      rootRef: entry.root_ref as VersionedRef,
      members,
      memberCount: Number(entry.member_count),
      closureHash: asHash(entry.closure_hash, 'dependency closure_hash'),
    };
  });
  const interfaces = asObjectArray(
    snapshot.interface_snapshot.interfaces,
    'interfaces',
  );
  const completePolicy = snapshot.policy_snapshot.complete_policy;
  assertJsonObject(completePolicy);
  assertJsonObject(completePolicy.root_policy);
  const safetySnapshot = snapshot.safety_snapshot;
  assertJsonObject(safetySnapshot.ceilings);
  const resourceByKey = new Map(
    resources.map((resource) => [refKey(resource.ref), resource]),
  );
  const dependencyClosureByKey = new Map(
    dependencyClosures.map((closure) => [
      dependencyClosureKey(closure.rootResourceType, closure.rootRef),
      closure,
    ]),
  );
  const interfaceByKey = new Map<string, JsonObject>();
  for (const entry of interfaces) {
    assertJsonObject(entry.ref);
    interfaceByKey.set(refKey(entry.ref), entry);
  }
  return {
    snapshotHash: asHash(snapshot.snapshot_hash, 'snapshot_hash'),
    compilerIdentity: snapshot.compiler_identity,
    resources,
    resourceByKey,
    dependencyClosures,
    dependencyClosureByKey,
    interfaces,
    interfaceByKey,
    rootPolicy: completePolicy.root_policy,
    rootPolicyHash: asHash(completePolicy.policy_hash, 'policy_hash'),
    childProfiles: asObjectArray(
      completePolicy.child_profiles,
      'child policy profiles',
    ),
    safety: safetySnapshot.ceilings,
    safetyHash: asHash(
      safetySnapshot.source_artifact_hash,
      'safety source_artifact_hash',
    ),
  };
}

export function catalogHash(
  snapshot: BoundCompilerSnapshot,
  resourceType: string,
): Sha256Hash {
  return domainSeparatedSha256('icarus:workflow-registry-catalog:1\n', {
    resource_type: resourceType,
    resources: snapshot.resources
      .filter((resource) => resource.resourceType === resourceType)
      .map((resource) => ({
        ref: resource.ref,
        content_hash: resource.contentHash,
      }))
      .sort((left, right) => compareAscii(refKey(left.ref), refKey(right.ref))),
  });
}

export function interfacePlanSnapshot(entry: JsonObject): JsonObject {
  assertJsonObject(entry.ref);
  assertJsonObject(entry.inputs);
  assertJsonObject(entry.exits);
  return { ref: entry.ref, inputs: entry.inputs, exits: entry.exits };
}

export function interfaceIdentity(entry: JsonObject): Sha256Hash {
  return asHash(entry.interface_hash, 'interface_hash');
}

export function childPolicy(
  snapshot: BoundCompilerSnapshot,
  profileRef: JsonObject,
): { profile: JsonObject; request: JsonObject; hash: Sha256Hash } | null {
  const profile = snapshot.childProfiles.find((candidate) => {
    assertJsonObject(candidate.ref);
    return refKey(candidate.ref) === refKey(profileRef);
  });
  if (!profile) return null;
  assertJsonObject(profile.ref);
  assertJsonObject(profile.request);
  return {
    profile: profile.ref,
    request: profile.request,
    hash: domainSeparatedSha256(
      'icarus:workflow-effective-child-policy:1\n',
      profile.request,
    ),
  };
}
