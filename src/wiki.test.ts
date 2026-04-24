import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { callAnthropicMessagesMock } = vi.hoisted(() => ({
  callAnthropicMessagesMock: vi.fn(),
}));

vi.mock('./agent-api.js', () => ({
  callAnthropicMessages: callAnthropicMessagesMock,
}));

import {
  _initTestDatabase,
  getWikiDraft,
  getWikiJob,
  getWikiMaterial,
  getWikiPage,
  listWikiClaimsByPage,
  listWikiRelationsForPage,
  searchWikiPages,
} from './db.js';
import { KNOWLEDGE_WIKI_DIR } from './config.js';
import {
  bulkDeleteWikiDrafts,
  clearWikiData,
  deleteWikiDraft,
  deleteWikiMaterial,
  deleteWikiPage,
  getWikiDraftDetail,
  getWikiPageDetail,
  importWikiMaterialFromText,
  publishWikiDraft,
  queueWikiDraftGenerationJob,
} from './wiki.js';

const createdPaths = new Set<string>();

function rememberPath(filePath: string | null | undefined): void {
  if (filePath) createdPaths.add(filePath);
}

function rememberMaterialArtifacts(material: {
  stored_path: string;
  extracted_text_path: string;
}): void {
  rememberPath(material.stored_path);
  rememberPath(material.extracted_text_path);
  rememberPath(path.join(path.dirname(material.stored_path), 'manifest.json'));
  createdPaths.add(path.dirname(material.stored_path));
}

function cleanupCreatedWikiArtifacts(): void {
  const sorted = Array.from(createdPaths).sort(
    (a, b) => b.length - a.length,
  );
  for (const target of sorted) {
    try {
      if (!fs.existsSync(target)) continue;
      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        fs.rmSync(target, { recursive: true, force: true });
      } else {
        fs.rmSync(target, { force: true });
      }
    } catch {
      // Best-effort cleanup for test artifacts only.
    }
  }
  createdPaths.clear();
}

async function waitForJobCompletion(jobId: string): Promise<{
  id: string;
  status: string;
  result_json: string | null;
  error_message: string | null;
}> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const job = getWikiJob(jobId);
    if (job && (job.status === 'completed' || job.status === 'failed')) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for wiki job ${jobId}`);
}

beforeEach(() => {
  _initTestDatabase();
  fs.mkdirSync(KNOWLEDGE_WIKI_DIR, { recursive: true });
  callAnthropicMessagesMock.mockReset();
});

afterEach(() => {
  cleanupCreatedWikiArtifacts();
  callAnthropicMessagesMock.mockReset();
});

describe('wiki', () => {
  it('imports material, generates a draft, publishes a page, and can search it', async () => {
    const testSlug = `vitest-wiki-page-${Date.now()}`;
    callAnthropicMessagesMock.mockImplementation(async (request: {
      messages?: Array<{ content?: string }>;
    }) => {
      const rawUserContent = String(request.messages?.[0]?.content || '{}');
      const payload = JSON.parse(rawUserContent);
      const materialId = payload.materials?.[0]?.id;
      if (!materialId) {
        throw new Error('missing material id in compile request');
      }

      return {
        model: 'test-model',
        raw: {},
        text: JSON.stringify({
          page: {
            slug: testSlug,
            title: 'Vitest Wiki Page',
            page_kind: 'project',
            summary: '验证全局 wiki 的主链路',
            content_markdown:
              '# Vitest Wiki Page\n\nNanoClaw wiki 采用全局知识模型。',
          },
          claims: [
            {
              claim_type: 'decision',
              statement: 'NanoClaw wiki 采用全局知识模型。',
              canonical_form: 'nanoclaw wiki 采用全局知识模型',
              confidence: 0.92,
              evidence: [
                {
                  material_id: materialId,
                  excerpt_text: '知识库统一为全局 wiki，由用户主动提供资料。',
                  locator: 'section:decision',
                },
              ],
            },
          ],
          relations: [],
        }),
      };
    });

    const material = importWikiMaterialFromText({
      title: 'Wiki 设计说明',
      text: '知识库统一为全局 wiki，由用户主动提供资料。',
    });
    rememberMaterialArtifacts(material);

    const job = queueWikiDraftGenerationJob({
      materialIds: [material.id],
      title: 'Vitest Wiki Page',
      pageKind: 'project',
      instruction: '生成一页简洁的设计说明',
    });

    const completedJob = await waitForJobCompletion(job.id);
    expect(completedJob.status).toBe('completed');
    expect(completedJob.error_message).toBeNull();

    const result = JSON.parse(String(completedJob.result_json || '{}'));
    const draftId = String(result.draft_id || '');
    expect(draftId).toBeTruthy();

    const draftDetail = getWikiDraftDetail(draftId);
    expect(draftDetail?.draft.target_slug).toBe(testSlug);
    expect(draftDetail?.compiled.claims).toHaveLength(1);
    expect(draftDetail?.publish_preview.mode).toBe('create');
    expect(draftDetail?.publish_preview.claims.added).toHaveLength(1);
    expect(draftDetail?.publish_preview.content_diff.added_count).toBe(2);
    expect(draftDetail?.publish_preview.content_diff.removed_count).toBe(0);
    expect(draftDetail?.publish_preview.content_diff.updated_count).toBe(0);
    rememberPath(draftDetail?.draft.file_path);

    const publishResult = publishWikiDraft(draftId);
    rememberPath(publishResult.page.file_path);

    expect(publishResult.page.slug).toBe(testSlug);
    expect(publishResult.claims).toHaveLength(1);
    expect(publishResult.materials.map((item) => item.id)).toContain(material.id);
    expect(
      publishResult.claims[0]?.canonical_form,
    ).toBe('nanoclaw wiki 采用全局知识模型');

    const pageDetail = getWikiPageDetail(testSlug);
    expect(pageDetail?.claims).toHaveLength(1);
    expect(pageDetail?.claims[0]?.evidence).toHaveLength(1);
    expect(pageDetail?.claims[0]?.evidence[0]?.material_id).toBe(material.id);

    const searchResults = searchWikiPages('NanoClaw', 5);
    expect(searchResults.some((item) => item.slug === testSlug)).toBe(true);
  });

  it('reuses canonical claims on repeated publish and deprecates removed claims', async () => {
    const testSlug = `wiki-repeat-${Date.now()}`;
    const material = importWikiMaterialFromText({
      title: '重复编纂资料',
      text: '同一 page 多次发布时，相同 canonical claim 不应重复创建。',
    });
    rememberMaterialArtifacts(material);

    callAnthropicMessagesMock
      .mockResolvedValueOnce({
        model: 'test-model',
        raw: {},
        text: JSON.stringify({
          page: {
            slug: testSlug,
            title: 'Repeat Publish Page',
            page_kind: 'decision',
            summary: '第一次发布',
            content_markdown: '# Repeat Publish Page\n\n第一次发布内容。',
          },
          claims: [
            {
              claim_type: 'decision',
              statement: '相同 canonical claim 不应重复创建。',
              canonical_form: '相同 canonical claim 不应重复创建',
              confidence: 0.9,
              evidence: [
                {
                  material_id: material.id,
                  excerpt_text: '相同 canonical claim 不应重复创建。',
                },
              ],
            },
            {
              claim_type: 'rule',
              statement: '被移除的旧 claim 应转为 deprecated。',
              canonical_form: '被移除的旧 claim 应转为 deprecated',
              confidence: 0.88,
              evidence: [
                {
                  material_id: material.id,
                  excerpt_text: '被移除的旧 claim 应转为 deprecated。',
                },
              ],
            },
          ],
          relations: [],
        }),
      })
      .mockResolvedValueOnce({
        model: 'test-model',
        raw: {},
        text: JSON.stringify({
          page: {
            slug: testSlug,
            title: 'Repeat Publish Page',
            page_kind: 'decision',
            summary: '第二次发布',
            content_markdown: '# Repeat Publish Page\n\n第二次发布内容。',
          },
          claims: [
            {
              claim_type: 'decision',
              statement: '相同 canonical claim 不应重复创建，更新后的表述。',
              canonical_form: '相同 canonical claim 不应重复创建',
              confidence: 0.95,
              evidence: [
                {
                  material_id: material.id,
                  excerpt_text: '相同 canonical claim 不应重复创建。',
                },
              ],
            },
            {
              claim_type: 'fact',
              statement: '新增 claim 会进入 active 集合。',
              canonical_form: '新增 claim 会进入 active 集合',
              confidence: 0.86,
              evidence: [
                {
                  material_id: material.id,
                  excerpt_text: '新增 claim 会进入 active 集合。',
                },
              ],
            },
          ],
          relations: [],
        }),
      });

    const firstJob = queueWikiDraftGenerationJob({
      materialIds: [material.id],
      targetSlug: testSlug,
      title: 'Repeat Publish Page',
      pageKind: 'decision',
    });
    const firstJobDone = await waitForJobCompletion(firstJob.id);
    const firstDraftId = JSON.parse(String(firstJobDone.result_json || '{}')).draft_id;
    const firstDraftDetail = getWikiDraftDetail(String(firstDraftId));
    rememberPath(firstDraftDetail?.draft.file_path);

    const firstPublish = publishWikiDraft(String(firstDraftId));
    rememberPath(firstPublish.page.file_path);
    const firstActiveClaims = listWikiClaimsByPage(testSlug);
    expect(firstActiveClaims).toHaveLength(2);
    const reusedClaimBefore = firstActiveClaims.find(
      (claim) => claim.canonical_form === '相同 canonical claim 不应重复创建',
    );
    expect(reusedClaimBefore?.id).toBeTruthy();

    const secondJob = queueWikiDraftGenerationJob({
      materialIds: [material.id],
      targetSlug: testSlug,
      title: 'Repeat Publish Page',
      pageKind: 'decision',
    });
    const secondJobDone = await waitForJobCompletion(secondJob.id);
    const secondDraftId = JSON.parse(String(secondJobDone.result_json || '{}')).draft_id;
    const secondDraftDetail = getWikiDraftDetail(String(secondDraftId));
    rememberPath(secondDraftDetail?.draft.file_path);
    expect(secondDraftDetail?.publish_preview.mode).toBe('update');
    expect(secondDraftDetail?.publish_preview.claims.added).toHaveLength(1);
    expect(secondDraftDetail?.publish_preview.claims.updated).toHaveLength(1);
    expect(secondDraftDetail?.publish_preview.claims.removed).toHaveLength(1);
    expect(secondDraftDetail?.publish_preview.materials.unchanged_material_ids).toEqual([
      material.id,
    ]);
    expect(secondDraftDetail?.publish_preview.content_diff.added_count).toBe(0);
    expect(secondDraftDetail?.publish_preview.content_diff.removed_count).toBe(0);
    expect(secondDraftDetail?.publish_preview.content_diff.updated_count).toBe(1);
    expect(secondDraftDetail?.publish_preview.content_diff.unchanged_count).toBe(1);
    expect(
      secondDraftDetail?.publish_preview.content_diff.blocks.find(
        (block) => block.kind === 'updated',
      )?.previous_text,
    ).toBe('第一次发布内容。');
    expect(
      secondDraftDetail?.publish_preview.content_diff.blocks.find(
        (block) => block.kind === 'updated',
      )?.text,
    ).toBe('第二次发布内容。');

    const secondPublish = publishWikiDraft(String(secondDraftId));
    expect(secondPublish.claims).toHaveLength(2);

    const allClaims = listWikiClaimsByPage(testSlug, {
      includeDeprecated: true,
    });
    expect(allClaims).toHaveLength(3);

    const reusedClaimAfter = allClaims.find(
      (claim) => claim.canonical_form === '相同 canonical claim 不应重复创建',
    );
    expect(reusedClaimAfter?.id).toBe(reusedClaimBefore?.id);
    expect(reusedClaimAfter?.status).toBe('active');
    expect(reusedClaimAfter?.statement).toContain('更新后的表述');

    const deprecatedClaim = allClaims.find(
      (claim) => claim.canonical_form === '被移除的旧 claim 应转为 deprecated',
    );
    expect(deprecatedClaim?.status).toBe('deprecated');

    const newClaim = allClaims.find(
      (claim) => claim.canonical_form === '新增 claim 会进入 active 集合',
    );
    expect(newClaim?.status).toBe('active');

    const pageDetail = getWikiPageDetail(testSlug);
    const activeReusedClaim = pageDetail?.claims.find(
      (claim) => claim.canonical_form === '相同 canonical claim 不应重复创建',
    );
    expect(activeReusedClaim?.evidence).toHaveLength(1);
  });

  it('fails draft generation when a claim has no valid material evidence', async () => {
    const material = importWikiMaterialFromText({
      title: '证据校验资料',
      text: '所有 claim 都必须绑定到当前所选 material 的有效证据。',
    });
    rememberMaterialArtifacts(material);

    callAnthropicMessagesMock.mockResolvedValueOnce({
      model: 'test-model',
      raw: {},
      text: JSON.stringify({
        page: {
          slug: `invalid-evidence-${Date.now()}`,
          title: 'Invalid Evidence Page',
          page_kind: 'decision',
          summary: '应当失败',
          content_markdown: '# Invalid Evidence Page',
        },
        claims: [
          {
            claim_type: 'fact',
            statement: '这条 claim 使用了不在当前 material 集内的证据。',
            canonical_form: '这条 claim 使用了不在当前 material 集内的证据',
            confidence: 0.6,
            evidence: [
              {
                material_id: 'unknown-material',
                excerpt_text: '无效证据',
              },
            ],
          },
        ],
        relations: [],
      }),
    });

    const job = queueWikiDraftGenerationJob({
      materialIds: [material.id],
      title: 'Invalid Evidence Page',
      pageKind: 'decision',
    });

    const completedJob = await waitForJobCompletion(job.id);
    expect(completedJob.status).toBe('failed');
    expect(completedJob.result_json).toBeNull();
    expect(String(completedJob.error_message || '')).toContain('Claim 缺少有效证据');
  });

  it('blocks deleting referenced materials and allows deleting drafts first', async () => {
    const material = importWikiMaterialFromText({
      title: '草稿引用资料',
      text: '只要草稿仍引用某份资料，就不应该允许直接删除资料。',
    });
    rememberMaterialArtifacts(material);

    callAnthropicMessagesMock.mockResolvedValueOnce({
      model: 'test-model',
      raw: {},
      text: JSON.stringify({
        page: {
          slug: `draft-only-${Date.now()}`,
          title: 'Draft Only Page',
          page_kind: 'decision',
          summary: '仅生成草稿，不发布',
          content_markdown: '# Draft Only Page\n\n用于验证删除依赖。',
        },
        claims: [
          {
            claim_type: 'rule',
            statement: '草稿引用的资料删除前必须先移除草稿。',
            canonical_form: '草稿引用的资料删除前必须先移除草稿',
            confidence: 0.82,
            evidence: [
              {
                material_id: material.id,
                excerpt_text: '草稿引用的资料删除前必须先移除草稿。',
              },
            ],
          },
        ],
        relations: [],
      }),
    });

    const job = queueWikiDraftGenerationJob({
      materialIds: [material.id],
      title: 'Draft Only Page',
      pageKind: 'decision',
    });
    const completedJob = await waitForJobCompletion(job.id);
    const draftId = JSON.parse(String(completedJob.result_json || '{}')).draft_id;
    const draftDetail = getWikiDraftDetail(String(draftId));
    rememberPath(draftDetail?.draft.file_path);

    expect(() => deleteWikiMaterial(material.id)).toThrow(/资料仍被引用/);

    const draftFilePath = String(draftDetail?.draft.file_path || '');
    const draftDeleteResult = deleteWikiDraft(String(draftId));
    expect(draftDeleteResult.draft_id).toBe(String(draftId));
    expect(getWikiDraft(String(draftId))).toBeUndefined();
    expect(fs.existsSync(draftFilePath)).toBe(false);

    const materialDir = path.dirname(material.stored_path);
    const materialDeleteResult = deleteWikiMaterial(material.id);
    expect(materialDeleteResult.material_id).toBe(material.id);
    expect(getWikiMaterial(material.id)).toBeUndefined();
    expect(fs.existsSync(materialDir)).toBe(false);
  });

  it('deletes a page and removes incoming relations from other pages', async () => {
    const primarySlug = `wiki-delete-primary-${Date.now()}`;
    const dependentSlug = `wiki-delete-dependent-${Date.now()}`;
    const material = importWikiMaterialFromText({
      title: '页面删除资料',
      text: '如果一个页面被删除，其他页面指向它的 relation 也需要被清理。',
    });
    rememberMaterialArtifacts(material);

    callAnthropicMessagesMock
      .mockResolvedValueOnce({
        model: 'test-model',
        raw: {},
        text: JSON.stringify({
          page: {
            slug: primarySlug,
            title: 'Primary Page',
            page_kind: 'concept',
            summary: '待删除页面',
            content_markdown: '# Primary Page\n\n这是待删除页面。',
          },
          claims: [
            {
              claim_type: 'fact',
              statement: 'Primary Page 会被后续测试删除。',
              canonical_form: 'primary page 会被后续测试删除',
              confidence: 0.8,
              evidence: [
                {
                  material_id: material.id,
                  excerpt_text: 'Primary Page 会被后续测试删除。',
                },
              ],
            },
          ],
          relations: [],
        }),
      })
      .mockResolvedValueOnce({
        model: 'test-model',
        raw: {},
        text: JSON.stringify({
          page: {
            slug: dependentSlug,
            title: 'Dependent Page',
            page_kind: 'project',
            summary: '引用待删除页面',
            content_markdown: '# Dependent Page\n\n这个页面会引用 Primary Page。',
          },
          claims: [
            {
              claim_type: 'fact',
              statement: 'Dependent Page 依赖 Primary Page。',
              canonical_form: 'dependent page 依赖 primary page',
              confidence: 0.78,
              evidence: [
                {
                  material_id: material.id,
                  excerpt_text: 'Dependent Page 依赖 Primary Page。',
                },
              ],
            },
          ],
          relations: [
            {
              to_slug: primarySlug,
              relation_type: 'depends_on',
              rationale: '删除 Primary Page 后，这条 relation 也应被清理。',
            },
          ],
        }),
      });

    const firstJob = queueWikiDraftGenerationJob({
      materialIds: [material.id],
      targetSlug: primarySlug,
      title: 'Primary Page',
      pageKind: 'concept',
    });
    const firstJobDone = await waitForJobCompletion(firstJob.id);
    const firstDraftId = JSON.parse(String(firstJobDone.result_json || '{}')).draft_id;
    const firstDraftDetail = getWikiDraftDetail(String(firstDraftId));
    rememberPath(firstDraftDetail?.draft.file_path);
    const firstPublish = publishWikiDraft(String(firstDraftId));
    rememberPath(firstPublish.page.file_path);

    const secondJob = queueWikiDraftGenerationJob({
      materialIds: [material.id],
      targetSlug: dependentSlug,
      title: 'Dependent Page',
      pageKind: 'project',
    });
    const secondJobDone = await waitForJobCompletion(secondJob.id);
    const secondDraftId = JSON.parse(String(secondJobDone.result_json || '{}')).draft_id;
    const secondDraftDetail = getWikiDraftDetail(String(secondDraftId));
    rememberPath(secondDraftDetail?.draft.file_path);
    const secondPublish = publishWikiDraft(String(secondDraftId));
    rememberPath(secondPublish.page.file_path);

    expect(listWikiRelationsForPage(dependentSlug)).toHaveLength(1);
    expect(getWikiPageDetail(primarySlug)?.incoming_relations).toHaveLength(1);

    const deleteResult = deleteWikiPage(primarySlug);
    expect(deleteResult.page_slug).toBe(primarySlug);
    expect(deleteResult.removed_claim_count).toBe(1);
    expect(deleteResult.removed_material_count).toBe(1);
    expect(deleteResult.removed_outgoing_relation_count).toBe(0);
    expect(deleteResult.removed_incoming_relation_count).toBe(1);

    expect(getWikiPage(primarySlug)).toBeUndefined();
    expect(getWikiPageDetail(primarySlug)).toBeNull();
    expect(listWikiClaimsByPage(primarySlug, { includeDeprecated: true })).toHaveLength(0);
    expect(listWikiRelationsForPage(dependentSlug)).toHaveLength(0);
    expect(searchWikiPages('Primary Page', 10).some((item) => item.slug === primarySlug)).toBe(false);
    expect(getWikiPage(dependentSlug)?.slug).toBe(dependentSlug);
  });

  it('bulk deletes only unpublished drafts', async () => {
    const publishedSlug = `wiki-bulk-published-${Date.now()}`;
    const draftOnlySlug = `wiki-bulk-draft-${Date.now()}`;
    const material = importWikiMaterialFromText({
      title: '批量删除草稿资料',
      text: '批量删除只应作用于未发布草稿，已发布草稿应被跳过。',
    });
    rememberMaterialArtifacts(material);

    callAnthropicMessagesMock
      .mockResolvedValueOnce({
        model: 'test-model',
        raw: {},
        text: JSON.stringify({
          page: {
            slug: publishedSlug,
            title: 'Published Draft Page',
            page_kind: 'decision',
            summary: '稍后发布',
            content_markdown: '# Published Draft Page\n\n这个草稿会被发布。',
          },
          claims: [
            {
              claim_type: 'decision',
              statement: '已发布草稿不应被批量删除。',
              canonical_form: '已发布草稿不应被批量删除',
              confidence: 0.84,
              evidence: [
                {
                  material_id: material.id,
                  excerpt_text: '已发布草稿不应被批量删除。',
                },
              ],
            },
          ],
          relations: [],
        }),
      })
      .mockResolvedValueOnce({
        model: 'test-model',
        raw: {},
        text: JSON.stringify({
          page: {
            slug: draftOnlySlug,
            title: 'Draft Only Page',
            page_kind: 'procedure',
            summary: '保持未发布',
            content_markdown: '# Draft Only Page\n\n这个草稿保持未发布。',
          },
          claims: [
            {
              claim_type: 'procedure_step',
              statement: '未发布草稿可以被批量删除。',
              canonical_form: '未发布草稿可以被批量删除',
              confidence: 0.8,
              evidence: [
                {
                  material_id: material.id,
                  excerpt_text: '未发布草稿可以被批量删除。',
                },
              ],
            },
          ],
          relations: [],
        }),
      });

    const publishedJob = queueWikiDraftGenerationJob({
      materialIds: [material.id],
      targetSlug: publishedSlug,
      title: 'Published Draft Page',
      pageKind: 'decision',
    });
    const publishedJobDone = await waitForJobCompletion(publishedJob.id);
    const publishedDraftId = JSON.parse(
      String(publishedJobDone.result_json || '{}'),
    ).draft_id;
    const publishedDraftDetail = getWikiDraftDetail(String(publishedDraftId));
    rememberPath(publishedDraftDetail?.draft.file_path);
    const publishedPage = publishWikiDraft(String(publishedDraftId));
    rememberPath(publishedPage.page.file_path);

    const draftOnlyJob = queueWikiDraftGenerationJob({
      materialIds: [material.id],
      targetSlug: draftOnlySlug,
      title: 'Draft Only Page',
      pageKind: 'procedure',
    });
    const draftOnlyJobDone = await waitForJobCompletion(draftOnlyJob.id);
    const draftOnlyDraftId = JSON.parse(
      String(draftOnlyJobDone.result_json || '{}'),
    ).draft_id;
    const draftOnlyDetail = getWikiDraftDetail(String(draftOnlyDraftId));
    const draftOnlyPath = String(draftOnlyDetail?.draft.file_path || '');
    rememberPath(draftOnlyPath);

    const result = bulkDeleteWikiDrafts([
      String(publishedDraftId),
      String(draftOnlyDraftId),
      'missing-draft-id',
    ]);

    expect(result.deleted_ids).toEqual([String(draftOnlyDraftId)]);
    expect(result.skipped_published_ids).toEqual([String(publishedDraftId)]);
    expect(result.missing_ids).toEqual(['missing-draft-id']);
    expect(getWikiDraft(String(draftOnlyDraftId))).toBeUndefined();
    expect(fs.existsSync(draftOnlyPath)).toBe(false);
    expect(getWikiDraft(String(publishedDraftId))?.status).toBe('published');
    expect(getWikiPage(publishedSlug)?.slug).toBe(publishedSlug);
  });

  it('clears the whole LLM wiki and removes stored artifacts', async () => {
    const testSlug = `wiki-clear-${Date.now()}`;
    const material = importWikiMaterialFromText({
      title: '清空 Wiki 资料',
      text: '这份资料用于验证一键清空 LLM Wiki。',
    });
    rememberMaterialArtifacts(material);

    callAnthropicMessagesMock.mockResolvedValueOnce({
      model: 'test-model',
      raw: {},
      text: JSON.stringify({
        page: {
          slug: testSlug,
          title: 'Clear Wiki Page',
          page_kind: 'project',
          summary: '用于验证清空',
          content_markdown: '# Clear Wiki Page\n\n清空前会先发布这页。',
        },
        claims: [
          {
            claim_type: 'fact',
            statement: '一键清空会移除页面、草稿、资料和任务记录。',
            canonical_form: '一键清空会移除页面草稿资料和任务记录',
            confidence: 0.88,
            evidence: [
              {
                material_id: material.id,
                excerpt_text: '一键清空会移除页面、草稿、资料和任务记录。',
              },
            ],
          },
        ],
        relations: [],
      }),
    });

    const job = queueWikiDraftGenerationJob({
      materialIds: [material.id],
      targetSlug: testSlug,
      title: 'Clear Wiki Page',
      pageKind: 'project',
    });
    const completedJob = await waitForJobCompletion(job.id);
    const draftId = JSON.parse(String(completedJob.result_json || '{}')).draft_id;
    const draftDetail = getWikiDraftDetail(String(draftId));
    const draftFilePath = String(draftDetail?.draft.file_path || '');
    rememberPath(draftFilePath);

    const publishResult = publishWikiDraft(String(draftId));
    const pageFilePath = publishResult.page.file_path;
    rememberPath(pageFilePath);

    const materialDir = path.dirname(material.stored_path);
    expect(getWikiMaterial(material.id)?.id).toBe(material.id);
    expect(getWikiDraft(String(draftId))?.id).toBe(String(draftId));
    expect(getWikiPage(testSlug)?.slug).toBe(testSlug);
    expect(listWikiClaimsByPage(testSlug)).toHaveLength(1);
    expect(getWikiJob(job.id)?.id).toBe(job.id);
    expect(fs.existsSync(materialDir)).toBe(true);
    expect(fs.existsSync(draftFilePath)).toBe(true);
    expect(fs.existsSync(pageFilePath)).toBe(true);

    const summary = clearWikiData();

    expect(summary.material_count).toBe(1);
    expect(summary.draft_count).toBe(1);
    expect(summary.page_count).toBe(1);
    expect(summary.claim_count).toBe(1);
    expect(summary.evidence_count).toBe(1);
    expect(summary.relation_count).toBe(0);
    expect(summary.job_count).toBe(1);
    expect(getWikiMaterial(material.id)).toBeUndefined();
    expect(getWikiDraft(String(draftId))).toBeUndefined();
    expect(getWikiPage(testSlug)).toBeUndefined();
    expect(getWikiJob(job.id)).toBeUndefined();
    expect(listWikiClaimsByPage(testSlug, { includeDeprecated: true })).toHaveLength(0);
    expect(listWikiRelationsForPage(testSlug)).toHaveLength(0);
    expect(fs.existsSync(materialDir)).toBe(false);
    expect(fs.existsSync(draftFilePath)).toBe(false);
    expect(fs.existsSync(pageFilePath)).toBe(false);
  });
});
