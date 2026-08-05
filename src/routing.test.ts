import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, storeChatMetadata } from './db.js';
import { getAvailableAgents, _setRegisteredAgents } from './index.js';

beforeEach(() => {
  _initTestDatabase();
  _setRegisteredAgents({});
});

// --- getAvailableAgents ---

describe('getAvailableAgents', () => {
  it('returns only registered agents and ignores unregistered chats', () => {
    storeChatMetadata(
      'web:group1',
      '2024-01-01T00:00:01.000Z',
      'Agent 1',
      'web',
    );
    storeChatMetadata(
      'user:user',
      '2024-01-01T00:00:02.000Z',
      'User DM',
      'web',
    );
    storeChatMetadata(
      'web:group2',
      '2024-01-01T00:00:03.000Z',
      'Agent 2',
      'web',
    );

    _setRegisteredAgents({
      'web:group1': {
        name: 'Agent 1',
        folder: 'group1',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    const agents = getAvailableAgents();
    expect(agents).toHaveLength(1);
    expect(agents.map((g) => g.jid)).toContain('web:group1');
    expect(agents.map((g) => g.jid)).not.toContain('web:group2');
    expect(agents.map((g) => g.jid)).not.toContain('user:user');
  });

  it('marks every returned agent as registered', () => {
    storeChatMetadata(
      'web:reg',
      '2024-01-01T00:00:01.000Z',
      'Registered',
      'web',
    );
    storeChatMetadata(
      'web:unreg',
      '2024-01-01T00:00:02.000Z',
      'Unregistered',
      'web',
    );

    _setRegisteredAgents({
      'web:reg': {
        name: 'Registered',
        folder: 'registered',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    const agents = getAvailableAgents();
    const reg = agents.find((g) => g.jid === 'web:reg');
    const unreg = agents.find((g) => g.jid === 'web:unreg');

    expect(reg?.isRegistered).toBe(true);
    expect(unreg).toBeUndefined();
  });

  it('preserves registered agent order while enriching last activity', () => {
    storeChatMetadata('web:old', '2024-01-01T00:00:01.000Z', 'Old', 'web');
    storeChatMetadata('web:new', '2024-01-01T00:00:05.000Z', 'New', 'web');
    storeChatMetadata('web:mid', '2024-01-01T00:00:03.000Z', 'Mid', 'web');

    _setRegisteredAgents({
      'web:new': {
        name: 'New',
        folder: 'new',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      'web:mid': {
        name: 'Mid',
        folder: 'mid',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      'web:old': {
        name: 'Old',
        folder: 'old',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    const agents = getAvailableAgents();
    expect(agents[0].jid).toBe('web:new');
    expect(agents[1].jid).toBe('web:mid');
    expect(agents[2].jid).toBe('web:old');
    expect(agents[0].lastActivity).toBe('2024-01-01T00:00:05.000Z');
    expect(agents[1].lastActivity).toBe('2024-01-01T00:00:03.000Z');
    expect(agents[2].lastActivity).toBe('2024-01-01T00:00:01.000Z');
  });

  it('returns registered agents even without chat metadata', () => {
    // Unknown JID formats are not Agents unless they are registered.
    storeChatMetadata(
      'unknown-format-123',
      '2024-01-01T00:00:01.000Z',
      'Unknown',
    );
    // An unregistered chat with an unusual JID is also ignored.
    storeChatMetadata(
      'custom:abc',
      '2024-01-01T00:00:02.000Z',
      'Custom DM',
      'custom',
    );
    // A real agent for contrast
    storeChatMetadata('web:agent', '2024-01-01T00:00:03.000Z', 'Agent', 'web');

    _setRegisteredAgents({
      'web:agent': {
        name: 'Agent',
        folder: 'agent',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      'web:missing': {
        name: 'Missing',
        folder: 'missing',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    const agents = getAvailableAgents();
    expect(agents).toHaveLength(2);
    expect(agents[0].jid).toBe('web:agent');
    expect(agents[0].lastActivity).toBe('2024-01-01T00:00:03.000Z');
    expect(agents[1].jid).toBe('web:missing');
    expect(agents[1].lastActivity).toBe('');
  });

  it('returns empty array when no chats exist', () => {
    const agents = getAvailableAgents();
    expect(agents).toHaveLength(0);
  });
});
