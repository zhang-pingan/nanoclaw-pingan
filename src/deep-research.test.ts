import { describe, expect, it } from 'vitest';

import { renderDeepResearchMarkdown } from './deep-research.js';

describe('renderDeepResearchMarkdown', () => {
  it('keeps citations as footnote markers and moves source details to the appendix', () => {
    const markdown = renderDeepResearchMarkdown({
      report: {
        schema_version: 1,
        title: '教育榜产研报告',
        subtitle: '测试口径',
        status: 'final',
        language: 'zh',
        generated_at: '2026-06-26T00:00:00.000Z',
        research_question: '分析教育类 Top10',
        methodology: {
          scope: '公开网页',
          data_window: '2026-06',
          ranking_basis: '榜单排名',
        },
        summary: {
          headline: '教育榜由语言学习和校园工作流共同驱动。',
          bullets: [
            {
              text: '语言学习仍是最稳定的商业化赛道。',
              citations: ['SRC-001'],
            },
          ],
        },
        sections: [
          {
            title: '产研判断',
            blocks: [
              {
                type: 'paragraph',
                text: '产品机会集中在高频练习、个性化反馈和机构触达。',
                citations: ['SRC-001', 'SRC-002'],
              },
            ],
          },
        ],
        limitations: ['下载量不可从消费者页批量获得。'],
        source_ids: ['SRC-001', 'SRC-002'],
      },
      sources: [
        {
          id: 'SRC-001',
          title: 'App Store Education Chart',
          url: 'https://example.com/chart',
          publisher: 'Apple',
          retrieved_at: '2026-06-26T00:00:00.000Z',
        },
        {
          id: 'SRC-002',
          title: 'Market Report',
          url: 'https://example.com/market',
          publisher: 'Research',
        },
      ],
    });

    expect(markdown).toContain('## 执行摘要');
    expect(markdown).toContain('语言学习仍是最稳定的商业化赛道。 [1]');
    expect(markdown).toContain(
      '产品机会集中在高频练习、个性化反馈和机构触达。 [1][2]',
    );
    expect(markdown).not.toContain('引用：');
    expect(markdown).not.toContain('(SRC-001)');
    expect(markdown).toContain('## 资料来源');
    expect(markdown).toContain(
      '[1] SRC-001 · Apple · 2026-06-26T00:00:00.000Z · App Store Education Chart：https://example.com/chart',
    );
  });

  it('renders candidate_top10 as a report table', () => {
    const markdown = renderDeepResearchMarkdown({
      report: {
        title: 'GitHub 教育项目增长候选',
        status: 'draft',
        language: 'zh',
        generated_at: '2026-06-26T00:00:00.000Z',
        summary: {
          headline: '只能形成增长候选榜。',
          bullets: [],
        },
        candidate_top10: [
          {
            rank: 1,
            project: 'open-notebook',
            repo: 'lfnovo/open-notebook',
            segment: 'AI learning notebook',
            current_visible_stars: '33.4k',
            ranking_confidence: 'medium',
            why_included: '具备学习和自学习主题，并有近期 release 信号。',
            citations: ['SRC-001'],
          },
        ],
        sections: [],
        limitations: [],
        source_ids: ['SRC-001'],
      },
      sources: [
        {
          id: 'SRC-001',
          title: 'open-notebook repository',
          url: 'https://example.com/open-notebook',
        },
      ],
    });

    expect(markdown).toContain('## Top10/关键对象清单');
    expect(markdown).toContain(
      '| 排名 | 对象 | 赛道/类别 | 公开指标 | 置信度 | 判断依据 |',
    );
    expect(markdown).toContain(
      '| 1 | open-notebook / lfnovo/open-notebook | AI learning notebook | 33.4k | medium | 具备学习和自学习主题，并有近期 release 信号。 [1] |',
    );
  });
});
