import type { Sha256Hash, VersionedRef } from './types.js';

export interface G8ReleaseInventoryEntry {
  readonly path: string;
  readonly byte_length: number;
  readonly executable: boolean;
  readonly raw_sha256: Sha256Hash;
}

export interface G8CoreReleaseManifest {
  readonly format: 'icarus.core-release-manifest/1';
  readonly ref: VersionedRef;
  readonly release_scope: 'workflow_runtime_g8_certification';
  readonly build_kind: 'release';
  readonly platform: 'darwin';
  readonly arch: 'arm64';
  readonly run_protocol_majors: readonly [1];
  readonly executor_abi_majors: readonly [1];
  readonly database_schema_version: 11;
  readonly database_schema_hash: Sha256Hash;
  readonly managed_node_distribution_ref: VersionedRef;
  readonly managed_node_distribution_hash: Sha256Hash;
  readonly runtime_launcher_hash: Sha256Hash;
  readonly runtime_toolchain_hash: Sha256Hash;
  readonly core_entry_relative_path: 'dist/index.js';
  readonly core_entry_sha256: Sha256Hash;
  readonly certification_entry_relative_path: 'dist/workflow-runtime/certification/release-entry.js';
  readonly certification_entry_sha256: Sha256Hash;
  readonly core_build_hash: Sha256Hash;
  readonly inventory: readonly G8ReleaseInventoryEntry[];
  readonly inventory_hash: Sha256Hash;
  readonly release_artifact_hash: Sha256Hash;
}

export interface G8CertifiedReleaseBinding {
  readonly format: 'icarus.core-runtime-launch-binding/2';
  readonly binding_kind: 'certified_release';
  readonly core_release_relative_path: string;
  readonly release_manifest_relative_path: 'core-release-manifest.json';
  readonly release_manifest_sha256: Sha256Hash;
  readonly release_artifact_hash: Sha256Hash;
  readonly core_build_hash: Sha256Hash;
  readonly core_entry_relative_path: string;
  readonly core_entry_sha256: Sha256Hash;
  readonly certification_entry_relative_path: string;
  readonly certification_entry_sha256: Sha256Hash;
  readonly managed_node_manifest_hash: Sha256Hash;
  readonly binding_hash: Sha256Hash;
}
