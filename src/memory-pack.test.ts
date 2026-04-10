import { beforeEach, describe, it, expect } from 'vitest';

import { _initTestDatabase, createMemory } from './db.js';
import { buildMemoryPack, buildMemoryPackForGroup } from './memory-pack.js';
import { MemoryRecord } from './types.js';

function mem(
  partial: Partial<MemoryRecord> & Pick<MemoryRecord, 'id' | 'content'>,
): MemoryRecord {
  return {
    id: partial.id,
    group_folder: partial.group_folder || 'web_main',
    layer: partial.layer || 'canonical',
    memory_type: partial.memory_type || 'fact',
    status: partial.status || 'active',
    content: partial.content,
    source: partial.source || 'test',
    created_at: partial.created_at || Date.now().toString(),
    updated_at: partial.updated_at || Date.now().toString(),
  };
}

describe('buildMemoryPack', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('returns empty string when no usable memories', () => {
    expect(buildMemoryPack([], 'foo')).toBe('');
    expect(
      buildMemoryPack(
        [mem({ id: 'm1', content: 'x', status: 'deprecated' })],
        'foo',
      ),
    ).toBe('');
  });

  it('includes memory pack wrapper and excludes non-active memories', () => {
    const pack = buildMemoryPack(
      [
        mem({ id: 'm1', content: 'active one', layer: 'canonical' }),
        mem({ id: 'm2', content: 'deprecated one', status: 'deprecated' }),
        mem({ id: 'm3', content: 'conflicted one', status: 'conflicted' }),
      ],
      'active',
    );
    expect(pack).toContain('[MEMORY PACK]');
    expect(pack).toContain('active one');
    expect(pack).not.toContain('deprecated one');
    expect(pack).not.toContain('conflicted one');
    expect(pack).toContain('[/MEMORY PACK]');
  });

  it('prioritizes relevant memories by prompt terms', () => {
    createMemory({
      group_folder: 'web_main',
      layer: 'canonical',
      memory_type: 'fact',
      content: 'release strategy for payment service',
    });
    createMemory({
      group_folder: 'web_main',
      layer: 'canonical',
      memory_type: 'fact',
      content: 'unrelated gardening notes',
    });
    const pack = buildMemoryPackForGroup(
      'web_main',
      'Please help with payment release',
    );
    expect(pack).toContain('release strategy for payment service');
    expect(pack).not.toContain('unrelated gardening notes');
  });

  it('keeps important canonical fallback memories even without lexical match', () => {
    createMemory({
      group_folder: 'web_main',
      layer: 'canonical',
      memory_type: 'rule',
      content: 'Always confirm before destructive actions',
    });
    createMemory({
      group_folder: 'web_main',
      layer: 'episodic',
      memory_type: 'summary',
      content: 'Reviewed deployment logs last Thursday',
    });
    const pack = buildMemoryPackForGroup(
      'web_main',
      'Help me summarize the roadmap',
    );
    expect(pack).toContain('Always confirm before destructive actions');
    expect(pack).not.toContain('Reviewed deployment logs last Thursday');
  });

  it('matches small synonym expansions for pack retrieval', () => {
    createMemory({
      group_folder: 'web_main',
      layer: 'canonical',
      memory_type: 'fact',
      content: 'Service payment uses deploy checklist before rollout',
    });
    createMemory({
      group_folder: 'web_main',
      layer: 'canonical',
      memory_type: 'fact',
      content: 'Gardening notes for spring tomatoes',
    });
    const pack = buildMemoryPackForGroup(
      'web_main',
      'Help me prepare the payment release',
    );
    expect(pack).toContain('Service payment uses deploy checklist before rollout');
    expect(pack).not.toContain('Gardening notes for spring tomatoes');
  });

  it('uses Chinese n-gram fallback when full Chinese phrase does not lexically match', () => {
    createMemory({
      group_folder: 'web_main',
      layer: 'canonical',
      memory_type: 'rule',
      content: '支付服务上线前先检查回滚预案',
    });
    createMemory({
      group_folder: 'web_main',
      layer: 'canonical',
      memory_type: 'fact',
      content: '园艺手册记录了番茄浇水频率',
    });
    const pack = buildMemoryPackForGroup(
      'web_main',
      '请帮我整理支付服务上线计划',
    );
    expect(pack).toContain('支付服务上线前先检查回滚预案');
    expect(pack).not.toContain('园艺手册记录了番茄浇水频率');
  });

  it('respects layer quotas and still keeps canonical entries', () => {
    const longWorking = 'w'.repeat(1200);
    const longCanonical = 'c'.repeat(300);
    const pack = buildMemoryPack(
      [
        mem({
          id: 'w1',
          layer: 'working',
          memory_type: 'summary',
          content: longWorking,
        }),
        mem({
          id: 'w2',
          layer: 'working',
          memory_type: 'summary',
          content: longWorking,
        }),
        mem({
          id: 'c1',
          layer: 'canonical',
          memory_type: 'rule',
          content: longCanonical,
        }),
      ],
      'c',
    );
    // working quota is 800 chars, so giant working entries should be skipped
    expect(pack).not.toContain(longWorking);
    // canonical entry should still be preserved
    expect(pack).toContain(longCanonical);
  });
});
