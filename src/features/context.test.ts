import { describe, expect, it } from 'vitest';

describe('feature context services', () => {
  it('publishes feature events and clears subscriptions by feature', async () => {
    const context = await import('./context.js');
    const received: unknown[] = [];
    context
      .createEventRegistry('example-feature')
      .subscribe('workflow.updated', (event) => received.push(event));

    context.publishFeatureEvent('workflow.updated', { id: 'wf-1' });
    context.clearFeatureEventSubscriptions('example-feature');
    context.publishFeatureEvent('workflow.updated', { id: 'wf-2' });

    expect(received).toEqual([{ id: 'wf-1' }]);
  });

  it('records feature audit events in the database', async () => {
    const db = await import('../db.js');
    db._initTestDatabase();
    const context = await import('./context.js');

    context.createAuditService('example-feature').record({
      action: 'example.run',
      status: 'success',
      payloadHash: 'hash-1',
      metadata: { value: 1 },
    });

    const row = db
      .getDatabase()
      .prepare(
        'SELECT feature_id, action, status, metadata_json FROM feature_audit_events WHERE feature_id = ?',
      )
      .get('example-feature') as
      | {
          feature_id: string;
          action: string;
          status: string;
          metadata_json: string;
        }
      | undefined;
    expect(row).toMatchObject({
      feature_id: 'example-feature',
      action: 'example.run',
      status: 'success',
    });
    expect(JSON.parse(row?.metadata_json || '{}')).toMatchObject({
      value: 1,
      payloadHash: 'hash-1',
    });
  });
});
