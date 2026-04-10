import { describe, it, expect } from 'vitest';

import { buildMemoryPack } from './memory-pack.js';
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
    const now = Date.now().toString();
    const pack = buildMemoryPack(
      [
        mem({
          id: 'm1',
          content: 'release strategy for payment service',
          updated_at: now,
        }),
        mem({
          id: 'm2',
          content: 'unrelated gardening notes',
          updated_at: now,
        }),
      ],
      'Please help with payment release',
    );
    expect(pack).toContain('release strategy for payment service');
    expect(pack).not.toContain('unrelated gardening notes');
  });

  it('keeps important canonical fallback memories even without lexical match', () => {
    const pack = buildMemoryPack(
      [
        mem({
          id: 'c1',
          layer: 'canonical',
          memory_type: 'rule',
          content: 'Always confirm before destructive actions',
        }),
        mem({
          id: 'e1',
          layer: 'episodic',
          memory_type: 'summary',
          content: 'Reviewed deployment logs last Thursday',
        }),
      ],
      'Help me summarize the roadmap',
    );
    expect(pack).toContain('Always confirm before destructive actions');
    expect(pack).not.toContain('Reviewed deployment logs last Thursday');
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
