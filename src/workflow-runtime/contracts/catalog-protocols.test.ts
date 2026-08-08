import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  CATALOG_PROTOCOL_ARTIFACT_DESCRIPTORS,
  buildCatalogProtocolSemanticArtifacts,
} from './catalog-protocol-artifacts.js';
import {
  CATALOG_PROTOCOL_NEGATIVE_CASES,
  CATALOG_PROTOCOL_POSITIVE_CASES,
} from './catalog-protocol-fixtures.js';
import {
  CATALOG_PROTOCOL_CLOSED_UNIONS,
  RUNTIME_COMMAND_DENIAL_CODES,
  RUNTIME_FACT_KINDS,
  RUNTIME_PERMISSION_CODES,
  WORKFLOW_COMPILER_ERROR_CODES,
} from './catalog-protocol-types.js';
import {
  checkContractPackCatalogProtocols,
  generateContractPackCatalogProtocols,
} from './catalog-protocol-pack.js';
import {
  RUNTIME_COMMAND_PROTOCOL_ENTRIES,
  RUNTIME_STATE_MACHINES,
  RUN_TRANSACTION_PROTOCOL_ENTRIES,
  RUN_TRANSACTION_PROTOCOL_IDS,
} from './protocol-table-types.js';
import { parseContractArtifactEnvelope } from './artifact.js';
import { strictParseJsonBytes } from './strict-json.js';

const contractsRoot = import.meta.dirname;

function readArtifact(relativePath: string) {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(path.join(contractsRoot, relativePath)),
    ),
  );
}

describe('G0.4 catalog and protocol Contract Pack', () => {
  it('checks all artifacts without mutating their bytes', () => {
    const trackedPaths = [
      'contract-pack-foundation.json',
      'contract-pack-closed-schemas.json',
      'contract-pack-catalog-protocols.json',
      'catalogs/catalog-protocol-domain-separators.json',
      'conformance/catalog-protocols/positive-cases.json',
      'conformance/catalog-protocols/negative-cases.json',
      ...CATALOG_PROTOCOL_ARTIFACT_DESCRIPTORS.map(
        (descriptor) => descriptor.artifact_path,
      ),
    ];
    const generated = generateContractPackCatalogProtocols();
    expect(generateContractPackCatalogProtocols().hash).toBe(generated.hash);
    const before = new Map(
      trackedPaths.map((relativePath) => [
        relativePath,
        fs.readFileSync(path.join(contractsRoot, relativePath)),
      ]),
    );

    const manifest = checkContractPackCatalogProtocols();
    expect(manifest.payload.gate).toBe('G0.4');
    expect(manifest.payload.run_protocol_major).toBe(1);
    for (const [relativePath, bytes] of before) {
      expect(fs.readFileSync(path.join(contractsRoot, relativePath))).toEqual(
        bytes,
      );
    }
  });

  it('freezes complete Error, Fact/Event, Permission, Reason, and Denial catalogs', () => {
    expect(WORKFLOW_COMPILER_ERROR_CODES).toHaveLength(27);
    expect(RUNTIME_FACT_KINDS).toHaveLength(13);
    expect(RUNTIME_PERMISSION_CODES).toHaveLength(9);
    expect(CATALOG_PROTOCOL_CLOSED_UNIONS.command_reason_codes).toHaveLength(
      17,
    );
    expect(RUNTIME_COMMAND_DENIAL_CODES).toHaveLength(11);

    const byFormat = new Map(
      buildCatalogProtocolSemanticArtifacts().map(([, artifact]) => [
        artifact.format,
        artifact,
      ]),
    );
    const eventCatalog = byFormat.get(
      'icarus.workflow-runtime-event-catalog/1',
    )!;
    const entries = eventCatalog.payload.entries as Array<{
      event_type: string;
      event_class: string;
      fact_kind: string | null;
    }>;
    expect(entries).toHaveLength(43);
    expect(
      entries
        .filter((entry) => entry.event_class === 'fact_backed')
        .map((entry) => entry.event_type),
    ).toEqual(RUNTIME_FACT_KINDS);
    expect(
      entries
        .filter((entry) => entry.event_class === 'fact_backed')
        .every((entry) => entry.fact_kind === entry.event_type),
    ).toBe(true);
  });

  it('freezes forward-only state tables and blocker-derived operational recovery', () => {
    expect(RUNTIME_STATE_MACHINES).toHaveLength(22);
    const runLifecycle = RUNTIME_STATE_MACHINES.find(
      (machine) => machine.machine_id === 'run_lifecycle',
    )!;
    expect(runLifecycle.transitions).toContainEqual(
      expect.objectContaining({ from: 'closing', to: 'closed' }),
    );
    expect(runLifecycle.transitions).not.toContainEqual(
      expect.objectContaining({ from: 'closed' }),
    );

    const operational = RUNTIME_STATE_MACHINES.find(
      (machine) => machine.machine_id === 'run_operational_state',
    )!;
    expect(operational.transitions).toContainEqual(
      expect.objectContaining({
        from: 'quarantined',
        to: 'action_required',
        protocols: ['T6e'],
      }),
    );
    expect(operational.transitions).toContainEqual(
      expect.objectContaining({
        from: 'action_required',
        to: 'healthy',
        protocols: ['T6e'],
      }),
    );
  });

  it('maps every closed command to one typed target, permission, reason set, and guard', () => {
    expect(RUNTIME_COMMAND_PROTOCOL_ENTRIES).toHaveLength(13);
    expect(
      RUNTIME_COMMAND_PROTOCOL_ENTRIES.map((entry) => entry.command_type),
    ).toEqual(CATALOG_PROTOCOL_CLOSED_UNIONS.command_types);
    for (const entry of RUNTIME_COMMAND_PROTOCOL_ENTRIES) {
      expect(entry.allowed_reason_codes.length).toBeGreaterThan(0);
      expect(entry.denial_codes).toEqual(RUNTIME_COMMAND_DENIAL_CODES);
      expect(entry.state_guard).not.toBe('');
      expect(entry.policy_guard).not.toBe('');
    }
    expect(RUNTIME_COMMAND_PROTOCOL_ENTRIES.at(-1)).toMatchObject({
      command_type: 'confirm_administrative_abandon',
      target_kind: 'workflow',
      minimum_evidence_refs: 1,
      confirmation_ref_required: true,
      allowed_actor_kinds: ['human'],
    });
    expect(
      RUNTIME_COMMAND_PROTOCOL_ENTRIES.find(
        (entry) => entry.command_type === 'cancel_workflow',
      ),
    ).toMatchObject({
      system_grant: {
        reason_codes: ['deadline_enforced', 'safety_enforced'],
        predicate: 'due_target',
        authority_scope: 'cancel_workflow_only',
        idempotency_domain: 'system:deadline-watchdog',
        idempotency_key_template:
          'workflow-deadline:<workflow_id>:<deadline_at_ms>',
        invocation_audit: 'required',
      },
    });
    expect(
      RUNTIME_COMMAND_PROTOCOL_ENTRIES.find(
        (entry) => entry.command_type === 'cancel_run',
      )!.allowed_actor_kinds,
    ).not.toContain('system');
  });

  it('covers all T0-T8 variants including T6e with declarative atomic boundaries', () => {
    expect(RUN_TRANSACTION_PROTOCOL_ENTRIES).toHaveLength(18);
    expect(
      RUN_TRANSACTION_PROTOCOL_ENTRIES.map((entry) => entry.transaction_id),
    ).toEqual(RUN_TRANSACTION_PROTOCOL_IDS);
    expect(
      RUN_TRANSACTION_PROTOCOL_ENTRIES.every(
        (entry) => entry.transaction_mode === 'begin_immediate',
      ),
    ).toBe(true);
    expect(
      RUN_TRANSACTION_PROTOCOL_ENTRIES.find(
        (entry) => entry.transaction_id === 'T6d',
      ),
    ).toMatchObject({
      name: 'attempt_watchdog_and_retry_timers',
      atomic_writes: [
        'attempt_timeout_fence_and_fact',
        'cancel_reconcile_or_compensation_effects',
        'schedule_consumed_and_exact_next_attempt',
        'node_retry_wait_to_active',
      ],
    });
    expect(
      RUN_TRANSACTION_PROTOCOL_ENTRIES.find(
        (entry) => entry.transaction_id === 'T6e',
      ),
    ).toMatchObject({
      name: 'operational_remediation_and_integrity_restoration',
      external_work_boundary: 'before_transaction',
    });
    expect(
      RUN_TRANSACTION_PROTOCOL_ENTRIES.find(
        (entry) => entry.transaction_id === 'T8',
      )!.forbidden,
    ).toContain('partial_required_child_creation');
  });

  it('executes all positive and negative catalog/protocol fixtures', () => {
    expect(CATALOG_PROTOCOL_POSITIVE_CASES).toHaveLength(9);
    expect(CATALOG_PROTOCOL_NEGATIVE_CASES).toHaveLength(25);
    expect(() => checkContractPackCatalogProtocols()).not.toThrow();
  });
});
