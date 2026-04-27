import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import YAML from 'yaml';
import { z } from 'zod';

import { callAnthropicMessages } from './agent-api.js';
import { DATA_DIR, KNOWLEDGE_WIKI_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { extractPdfText } from './pdf-text-extractor.js';
import {
  clearAllWikiRecords,
  countWikiClaimEvidenceByMaterial,
  createWikiDraft,
  createWikiJob,
  createWikiClaim,
  createWikiMaterial,
  deleteWikiDraftRecord,
  deleteWikiJobRecord,
  deleteWikiMaterialRecord,
  deleteWikiPageGraph,
  getWikiDraft,
  getWikiJob,
  getWikiMaterial,
  getWikiPage,
  listPendingWikiJobs,
  listWikiClaimEvidence,
  listWikiClaimsByPage,
  listWikiDrafts,
  listWikiJobs,
  listWikiMaterials,
  listWikiPageMaterials,
  listWikiPages,
  listWikiPagesReferencingMaterial,
  listWikiRelationsForPage,
  listWikiRelationsToPage,
  replaceWikiClaimEvidence,
  replaceWikiPageMaterials,
  replaceWikiRelationsForPage,
  updateWikiClaim,
  updateWikiDraft,
  updateWikiJob,
  upsertWikiPage,
} from './db.js';
import { logger } from './logger.js';
import {
  WikiClaimEvidenceRecord,
  WikiClaimRecord,
  WikiDraftRecord,
  WikiJobRecord,
  WikiMaterialRecord,
  WikiPageRecord,
  WikiRelationRecord,
} from './types.js';

const WIKI_MATERIALS_DIR = path.join(KNOWLEDGE_WIKI_DIR, 'materials');
const WIKI_DRAFTS_DIR = path.join(KNOWLEDGE_WIKI_DIR, 'drafts');
const WIKI_PAGES_DIR = path.join(KNOWLEDGE_WIKI_DIR, 'pages');
const WIKI_FAILED_DRAFT_RESPONSES_DIR = path.join(
  KNOWLEDGE_WIKI_DIR,
  'debug',
  'failed-draft-responses',
);
const WEB_UPLOADS_DIR = path.resolve(DATA_DIR, 'web-uploads');
const SUPPORTED_TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.yaml',
  '.yml',
  '.csv',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.html',
  '.xml',
  '.sql',
  '.py',
  '.go',
  '.java',
  '.rs',
  '.sh',
  '.log',
]);
const PDF_EXTENSIONS = new Set(['.pdf']);
const DEFAULT_MAX_MATERIAL_CHARS = 12000;
const DEFAULT_MAX_TOTAL_MATERIAL_CHARS = 30000;
const DEFAULT_WIKI_DRAFT_TIMEOUT_MS = 300000;

const compiledWikiDraftSchema = z.object({
  page: z.object({
    slug: z.string().min(1),
    title: z.string().min(1),
    page_kind: z.string().min(1),
    summary: z.string().optional().default(''),
    content_markdown: z.string().min(1),
  }),
  claims: z
    .array(
      z.object({
        claim_type: z.string().min(1),
        statement: z.string().min(1),
        canonical_form: z.string().optional().default(''),
        confidence: z.number().min(0).max(1).optional().nullable(),
        evidence: z
          .array(
            z.object({
              material_id: z.string().min(1),
              excerpt_text: z.string().min(1),
              locator: z.string().optional().nullable(),
            }),
          )
          .optional()
          .default([]),
      }),
    )
    .optional()
    .default([]),
  relations: z
    .array(
      z.object({
        to_slug: z.string().min(1),
        relation_type: z.string().min(1),
        rationale: z.string().optional().nullable(),
      }),
    )
    .optional()
    .default([]),
});

interface QueueDraftJobInput {
  materialIds: string[];
  targetSlug?: string;
  title?: string;
  pageKind?: string;
  instruction?: string;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
): number {
  return Math.max(
    minimum,
    Number.parseInt(value || String(fallback), 10) || fallback,
  );
}

function getWikiDraftTimeoutMs(): number {
  const env = readEnvFile(['NANOCLAW_WIKI_DRAFT_TIMEOUT_MS']);
  return parsePositiveInteger(
    env.NANOCLAW_WIKI_DRAFT_TIMEOUT_MS ||
      process.env.NANOCLAW_WIKI_DRAFT_TIMEOUT_MS,
    DEFAULT_WIKI_DRAFT_TIMEOUT_MS,
    1000,
  );
}

function getWikiMaterialCharLimits(): {
  maxMaterialChars: number;
  maxTotalMaterialChars: number;
} {
  const env = readEnvFile([
    'NANOCLAW_WIKI_MAX_MATERIAL_CHARS',
    'NANOCLAW_WIKI_MAX_TOTAL_MATERIAL_CHARS',
  ]);
  return {
    maxMaterialChars: parsePositiveInteger(
      env.NANOCLAW_WIKI_MAX_MATERIAL_CHARS ||
        process.env.NANOCLAW_WIKI_MAX_MATERIAL_CHARS,
      DEFAULT_MAX_MATERIAL_CHARS,
      1,
    ),
    maxTotalMaterialChars: parsePositiveInteger(
      env.NANOCLAW_WIKI_MAX_TOTAL_MATERIAL_CHARS ||
        process.env.NANOCLAW_WIKI_MAX_TOTAL_MATERIAL_CHARS,
      DEFAULT_MAX_TOTAL_MATERIAL_CHARS,
      1,
    ),
  };
}

interface CompiledWikiDraft {
  page: {
    slug: string;
    title: string;
    page_kind: string;
    summary: string;
    content_markdown: string;
  };
  claims: Array<{
    claim_type: string;
    statement: string;
    canonical_form: string;
    confidence: number | null;
    evidence: Array<{
      material_id: string;
      excerpt_text: string;
      locator?: string | null;
    }>;
  }>;
  relations: Array<{
    to_slug: string;
    relation_type: string;
    rationale?: string | null;
  }>;
}

interface WikiDraftPreviewClaimChange {
  canonical_form: string;
  claim_type: string;
  statement: string;
  confidence: number | null;
  previous_claim_type?: string | null;
  previous_statement?: string | null;
  previous_confidence?: number | null;
}

interface WikiDraftPreviewRelationChange {
  to_page_slug: string;
  relation_type: string;
  rationale: string | null;
  previous_rationale?: string | null;
}

interface WikiDraftPreviewContentBlock {
  kind: 'added' | 'removed' | 'updated' | 'unchanged';
  text: string;
  previous_text?: string | null;
}

interface WikiDraftPublishPreview {
  mode: 'create' | 'update';
  existing_page: WikiPageRecord | null;
  page_changes: {
    title: boolean;
    page_kind: boolean;
    summary: boolean;
    content_markdown: boolean;
    any: boolean;
  };
  materials: {
    added_material_ids: string[];
    removed_material_ids: string[];
    unchanged_material_ids: string[];
  };
  claims: {
    added: WikiDraftPreviewClaimChange[];
    updated: WikiDraftPreviewClaimChange[];
    removed: WikiDraftPreviewClaimChange[];
    unchanged: WikiDraftPreviewClaimChange[];
  };
  relations: {
    added: WikiDraftPreviewRelationChange[];
    removed: WikiDraftPreviewRelationChange[];
    unchanged: WikiDraftPreviewRelationChange[];
  };
  content_diff: {
    added_count: number;
    removed_count: number;
    updated_count: number;
    unchanged_count: number;
    blocks: WikiDraftPreviewContentBlock[];
  };
}

interface WikiDraftPublishPreviewSummary {
  mode: 'create' | 'update';
  claims_added: number;
  claims_updated: number;
  claims_removed: number;
  relations_added: number;
  relations_removed: number;
  content_added: number;
  content_updated: number;
  content_removed: number;
  materials_added: number;
  materials_removed: number;
}

interface WikiMaterialUsage {
  page_refs: Array<{
    slug: string;
    title: string;
  }>;
  draft_refs: Array<{
    id: string;
    title: string;
    target_slug: string;
    status: WikiDraftRecord['status'];
  }>;
  job_refs: Array<{
    id: string;
    job_type: WikiJobRecord['job_type'];
    status: WikiJobRecord['status'];
  }>;
  evidence_count: number;
  can_delete: boolean;
}

const pendingJobIds: string[] = [];
const activeWikiJobControllers = new Map<string, AbortController>();
const stoppingWikiJobIds = new Set<string>();
let wikiJobDrainRunning = false;

function nowIso(): string {
  return new Date().toISOString();
}

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function createAbortError(message: string): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function throwIfSignalAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError('Wiki job aborted');
  }
}

function parseJsonStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is string =>
            typeof item === 'string' && item.trim().length > 0,
        )
      : [];
  } catch {
    return [];
  }
}

function extractJsonObjectFromText(text: string): string {
  const noThink = text.replace(/<think>[\s\S]*?<\/think>/gi, ' ').trim();
  const noFence = noThink.replace(/```(?:json)?/gi, ' ').trim();
  const firstBrace = noFence.indexOf('{');
  const lastBrace = noFence.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return noFence.slice(firstBrace, lastBrace + 1);
  }
  return noFence;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

function slugify(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[\u2018\u2019']/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || `wiki-${Date.now()}`;
}

export function canonicalizeWikiClaim(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2018\u2019']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isProbablyTextBuffer(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 9) suspicious += 1;
  }
  return suspicious <= sample.length * 0.02;
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function removePathIfExists(targetPath: string | null | undefined): void {
  if (!targetPath) return;
  if (!fs.existsSync(targetPath)) return;
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function sanitizeFileToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
}

export function ensureWikiDirs(): void {
  ensureDir(KNOWLEDGE_WIKI_DIR);
  ensureDir(WIKI_MATERIALS_DIR);
  ensureDir(WIKI_DRAFTS_DIR);
  ensureDir(WIKI_PAGES_DIR);
}

function readMaterialTextFromFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (PDF_EXTENSIONS.has(ext)) {
    const extraction = extractPdfText(filePath);
    logger.info(
      { filePath, extractor: extraction.engine },
      'Extracted PDF text for wiki material import',
    );
    return extraction.text;
  }
  const buffer = fs.readFileSync(filePath);
  if (!SUPPORTED_TEXT_EXTENSIONS.has(ext) && !isProbablyTextBuffer(buffer)) {
    throw new Error(
      '当前仅支持导入文本类文件和可提取文本的 PDF；请先提供可解析的资料',
    );
  }
  const text = buffer.toString('utf-8').replace(/^\uFEFF/, '');
  const cleaned = text.trim();
  if (!cleaned) {
    throw new Error('资料内容为空，无法导入知识库');
  }
  return cleaned;
}

function writeMaterialManifest(
  materialDir: string,
  record: WikiMaterialRecord,
): void {
  fs.writeFileSync(
    path.join(materialDir, 'manifest.json'),
    JSON.stringify(record, null, 2) + '\n',
    'utf-8',
  );
}

export function readWikiMaterialExtractedText(
  material: WikiMaterialRecord,
): string {
  if (!fs.existsSync(material.extracted_text_path)) return '';
  return fs.readFileSync(material.extracted_text_path, 'utf-8');
}

export function importWikiMaterialFromText(input: {
  title: string;
  text: string;
  note?: string;
}): WikiMaterialRecord {
  ensureWikiDirs();
  const now = nowIso();
  const id = createId('wiki-mat');
  const materialDir = path.join(WIKI_MATERIALS_DIR, id);
  ensureDir(materialDir);

  const sourceText = input.text.trim();
  if (!sourceText) throw new Error('资料文本不能为空');

  const sourcePath = path.join(materialDir, 'source.txt');
  const extractedPath = path.join(materialDir, 'extracted.txt');
  fs.writeFileSync(sourcePath, sourceText + '\n', 'utf-8');
  fs.writeFileSync(extractedPath, sourceText + '\n', 'utf-8');

  const record: WikiMaterialRecord = {
    id,
    title: input.title.trim() || `资料 ${id}`,
    source_kind: 'text',
    note: input.note?.trim() || null,
    source_name: 'inline-text',
    source_path: null,
    stored_path: sourcePath,
    extracted_text_path: extractedPath,
    sha256: crypto.createHash('sha256').update(sourceText).digest('hex'),
    created_at: now,
    updated_at: now,
  };
  createWikiMaterial(record);
  writeMaterialManifest(materialDir, record);
  return record;
}

export function importWikiMaterialFromUpload(input: {
  title?: string;
  note?: string;
  hostPath: string;
}): WikiMaterialRecord {
  ensureWikiDirs();
  const resolvedHostPath = path.resolve(input.hostPath);
  if (!resolvedHostPath.startsWith(path.resolve(WEB_UPLOADS_DIR))) {
    throw new Error('仅支持从 Web 上传目录导入资料');
  }
  if (!fs.existsSync(resolvedHostPath)) {
    throw new Error('上传文件不存在');
  }

  const extractedText = readMaterialTextFromFile(resolvedHostPath);
  const now = nowIso();
  const id = createId('wiki-mat');
  const materialDir = path.join(WIKI_MATERIALS_DIR, id);
  ensureDir(materialDir);
  const ext = path.extname(resolvedHostPath) || '.txt';
  const sourcePath = path.join(materialDir, `source${ext}`);
  const extractedPath = path.join(materialDir, 'extracted.txt');
  fs.copyFileSync(resolvedHostPath, sourcePath);
  fs.writeFileSync(extractedPath, extractedText + '\n', 'utf-8');

  const record: WikiMaterialRecord = {
    id,
    title:
      input.title?.trim() ||
      path.basename(resolvedHostPath, path.extname(resolvedHostPath)),
    source_kind: 'upload',
    note: input.note?.trim() || null,
    source_name: path.basename(resolvedHostPath),
    source_path: resolvedHostPath,
    stored_path: sourcePath,
    extracted_text_path: extractedPath,
    sha256: crypto
      .createHash('sha256')
      .update(fs.readFileSync(sourcePath))
      .digest('hex'),
    created_at: now,
    updated_at: now,
  };
  createWikiMaterial(record);
  writeMaterialManifest(materialDir, record);
  return record;
}

function limitMaterialText(text: string, remaining: number): string {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized.length <= remaining) return normalized;
  return normalized.slice(0, Math.max(0, remaining - 1)).trimEnd();
}

function persistFailedWikiDraftRawResponse(input: {
  jobId?: string;
  draftInput: QueueDraftJobInput;
  responseText: string;
  err: unknown;
}): string | null {
  try {
    ensureDir(WIKI_FAILED_DRAFT_RESPONSES_DIR);
    const stamp = nowIso().replace(/[:.]/g, '-');
    const jobToken = sanitizeFileToken(input.jobId || createId('wiki-job'));
    const basePath = path.join(
      WIKI_FAILED_DRAFT_RESPONSES_DIR,
      `${stamp}-${jobToken}`,
    );
    const rawResponsePath = `${basePath}.txt`;
    const metadataPath = `${basePath}.json`;
    const errorMessage =
      input.err instanceof Error ? input.err.message : String(input.err);

    fs.writeFileSync(rawResponsePath, input.responseText, 'utf-8');
    fs.writeFileSync(
      metadataPath,
      JSON.stringify(
        {
          job_id: input.jobId || null,
          saved_at: nowIso(),
          error_name: input.err instanceof Error ? input.err.name : null,
          error_message: errorMessage,
          raw_response_path: rawResponsePath,
          raw_response_chars: input.responseText.length,
          material_ids: Array.isArray(input.draftInput.materialIds)
            ? input.draftInput.materialIds
            : [],
          target_slug: input.draftInput.targetSlug || '',
          title: input.draftInput.title || '',
          page_kind: input.draftInput.pageKind || '',
          instruction: input.draftInput.instruction || '',
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );

    return rawResponsePath;
  } catch (persistErr) {
    logger.error(
      { err: persistErr, jobId: input.jobId },
      'Failed to persist raw wiki draft response',
    );
    return null;
  }
}

function parseCompiledWikiDraft(text: string): CompiledWikiDraft {
  const parsed = compiledWikiDraftSchema.parse(
    JSON.parse(extractJsonObjectFromText(text)),
  );

  const pageSlug = slugify(parsed.page.slug || parsed.page.title);
  const dedupedClaims = new Map<string, CompiledWikiDraft['claims'][number]>();
  for (const claim of parsed.claims) {
    const canonical = canonicalizeWikiClaim(
      claim.canonical_form || claim.statement,
    );
    if (!canonical) continue;
    const existing = dedupedClaims.get(canonical);
    const mergedEvidence = [
      ...(existing?.evidence || []),
      ...claim.evidence,
    ].filter((item) => item.excerpt_text.trim().length > 0);
    const uniqueEvidence = Array.from(
      new Map(
        mergedEvidence.map((item) => [
          `${item.material_id}|${item.excerpt_text}|${item.locator || ''}`,
          item,
        ]),
      ).values(),
    );
    dedupedClaims.set(canonical, {
      claim_type: claim.claim_type.trim(),
      statement: normalizeWhitespace(
        claim.statement.length >= (existing?.statement.length || 0)
          ? claim.statement
          : existing?.statement || claim.statement,
      ),
      canonical_form: canonical,
      confidence:
        claim.confidence != null
          ? claim.confidence
          : (existing?.confidence ?? null),
      evidence: uniqueEvidence,
    });
  }

  const dedupedRelations = Array.from(
    new Map(
      parsed.relations
        .map((relation) => ({
          ...relation,
          to_slug: slugify(relation.to_slug),
          relation_type: relation.relation_type.trim(),
          rationale: relation.rationale?.trim() || null,
        }))
        .filter(
          (relation) =>
            relation.to_slug.length > 0 && relation.to_slug !== pageSlug,
        )
        .map((relation) => [
          `${relation.to_slug}|${relation.relation_type}`,
          relation,
        ]),
    ).values(),
  );

  return {
    page: {
      slug: pageSlug,
      title: parsed.page.title.trim(),
      page_kind: parsed.page.page_kind.trim(),
      summary: parsed.page.summary.trim(),
      content_markdown: parsed.page.content_markdown.trim(),
    },
    claims: Array.from(dedupedClaims.values()),
    relations: dedupedRelations,
  };
}

function buildDraftMarkdown(
  compiled: CompiledWikiDraft,
  materialIds: string[],
): string {
  const frontmatter = YAML.stringify({
    title: compiled.page.title,
    slug: compiled.page.slug,
    page_kind: compiled.page.page_kind,
    summary: compiled.page.summary,
    material_ids: materialIds,
    generated_at: nowIso(),
    status: 'draft',
  }).trim();

  return `---\n${frontmatter}\n---\n\n${compiled.page.content_markdown}\n`;
}

function validateCompiledDraftEvidence(
  compiled: CompiledWikiDraft,
  materialIds: string[],
): void {
  const allowedMaterialIds = new Set(materialIds.filter(Boolean));
  for (const claim of compiled.claims) {
    const validEvidence = claim.evidence.filter(
      (item) =>
        allowedMaterialIds.has(item.material_id) &&
        item.excerpt_text.trim().length > 0,
    );
    if (validEvidence.length === 0) {
      throw new Error(
        `Claim 缺少有效证据，无法写入 wiki: ${claim.statement.slice(0, 80)}`,
      );
    }
  }
}

function splitMarkdownBlocks(content: string): string[] {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  return normalized
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter(Boolean);
}

function buildMarkdownBlockDiff(
  previousContent: string,
  nextContent: string,
): WikiDraftPublishPreview['content_diff'] {
  const previousBlocks = splitMarkdownBlocks(previousContent);
  const nextBlocks = splitMarkdownBlocks(nextContent);
  const dp = Array.from({ length: previousBlocks.length + 1 }, () =>
    Array<number>(nextBlocks.length + 1).fill(0),
  );

  for (let i = previousBlocks.length - 1; i >= 0; i -= 1) {
    for (let j = nextBlocks.length - 1; j >= 0; j -= 1) {
      dp[i][j] =
        previousBlocks[i] === nextBlocks[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const blocks: WikiDraftPreviewContentBlock[] = [];
  let i = 0;
  let j = 0;
  while (i < previousBlocks.length && j < nextBlocks.length) {
    if (previousBlocks[i] === nextBlocks[j]) {
      blocks.push({
        kind: 'unchanged',
        text: nextBlocks[j],
      });
      i += 1;
      j += 1;
      continue;
    }
    if (dp[i + 1][j] >= dp[i][j + 1]) {
      blocks.push({
        kind: 'removed',
        text: previousBlocks[i],
      });
      i += 1;
      continue;
    }
    blocks.push({
      kind: 'added',
      text: nextBlocks[j],
    });
    j += 1;
  }

  while (i < previousBlocks.length) {
    blocks.push({
      kind: 'removed',
      text: previousBlocks[i],
    });
    i += 1;
  }
  while (j < nextBlocks.length) {
    blocks.push({
      kind: 'added',
      text: nextBlocks[j],
    });
    j += 1;
  }

  const mergedBlocks: WikiDraftPreviewContentBlock[] = [];
  for (const block of blocks) {
    const previous = mergedBlocks[mergedBlocks.length - 1];
    const isReplacePair =
      previous &&
      ((previous.kind === 'removed' && block.kind === 'added') ||
        (previous.kind === 'added' && block.kind === 'removed'));
    if (isReplacePair) {
      const removedBlock = previous.kind === 'removed' ? previous : block;
      const addedBlock = previous.kind === 'added' ? previous : block;
      mergedBlocks[mergedBlocks.length - 1] = {
        kind: 'updated',
        text: addedBlock.text,
        previous_text: removedBlock.text,
      };
      continue;
    }
    mergedBlocks.push(block);
  }

  return {
    added_count: mergedBlocks.filter((block) => block.kind === 'added').length,
    removed_count: mergedBlocks.filter((block) => block.kind === 'removed')
      .length,
    updated_count: mergedBlocks.filter((block) => block.kind === 'updated')
      .length,
    unchanged_count: mergedBlocks.filter((block) => block.kind === 'unchanged')
      .length,
    blocks: mergedBlocks,
  };
}

function relationPreviewKey(input: {
  to_page_slug: string;
  relation_type: string;
}): string {
  return `${input.to_page_slug}|${input.relation_type}`;
}

function buildWikiDraftPublishPreview(
  compiled: CompiledWikiDraft,
  materialIds: string[],
): WikiDraftPublishPreview {
  const existingPage = getWikiPage(compiled.page.slug) || null;
  const existingClaims = existingPage
    ? listWikiClaimsByPage(existingPage.slug)
    : [];
  const existingRelations = existingPage
    ? listWikiRelationsForPage(existingPage.slug)
    : [];
  const existingMaterialIds = existingPage
    ? listWikiPageMaterials(existingPage.slug).map((item) => item.id)
    : [];

  const nextMaterialIds = [...new Set(materialIds.filter(Boolean))];
  const existingMaterialIdSet = new Set(existingMaterialIds);
  const nextMaterialIdSet = new Set(nextMaterialIds);

  const previewClaims: WikiDraftPublishPreview['claims'] = {
    added: [],
    updated: [],
    removed: [],
    unchanged: [],
  };
  const existingClaimByCanonical = new Map(
    existingClaims.map((claim) => [claim.canonical_form, claim] as const),
  );

  for (const claim of compiled.claims) {
    const existingClaim = existingClaimByCanonical.get(claim.canonical_form);
    const basePreview: WikiDraftPreviewClaimChange = {
      canonical_form: claim.canonical_form,
      claim_type: claim.claim_type,
      statement: claim.statement,
      confidence: claim.confidence,
      previous_claim_type: existingClaim?.claim_type ?? null,
      previous_statement: existingClaim?.statement ?? null,
      previous_confidence: existingClaim?.confidence ?? null,
    };

    if (!existingClaim) {
      previewClaims.added.push(basePreview);
      continue;
    }

    const changed =
      existingClaim.claim_type !== claim.claim_type ||
      existingClaim.statement !== claim.statement ||
      (existingClaim.confidence ?? null) !== (claim.confidence ?? null);
    if (changed) {
      previewClaims.updated.push(basePreview);
    } else {
      previewClaims.unchanged.push(basePreview);
    }
  }

  const draftCanonicalForms = new Set(
    compiled.claims.map((claim) => claim.canonical_form),
  );
  for (const existingClaim of existingClaims) {
    if (draftCanonicalForms.has(existingClaim.canonical_form)) continue;
    previewClaims.removed.push({
      canonical_form: existingClaim.canonical_form,
      claim_type: existingClaim.claim_type,
      statement: existingClaim.statement,
      confidence: existingClaim.confidence,
      previous_claim_type: existingClaim.claim_type,
      previous_statement: existingClaim.statement,
      previous_confidence: existingClaim.confidence,
    });
  }

  const previewRelations: WikiDraftPublishPreview['relations'] = {
    added: [],
    removed: [],
    unchanged: [],
  };
  const compiledRelations = compiled.relations.map((relation) => ({
    to_page_slug: relation.to_slug,
    relation_type: relation.relation_type,
    rationale: relation.rationale ?? null,
  }));
  const existingRelationByKey = new Map(
    existingRelations.map(
      (relation) => [relationPreviewKey(relation), relation] as const,
    ),
  );
  for (const relation of compiledRelations) {
    const existingRelation = existingRelationByKey.get(
      relationPreviewKey(relation),
    );
    const relationPreview: WikiDraftPreviewRelationChange = {
      to_page_slug: relation.to_page_slug,
      relation_type: relation.relation_type,
      rationale: relation.rationale,
      previous_rationale: existingRelation?.rationale ?? null,
    };
    if (!existingRelation) {
      previewRelations.added.push(relationPreview);
      continue;
    }
    const changedRationale =
      (existingRelation.rationale ?? null) !== (relation.rationale ?? null);
    if (changedRationale) {
      previewRelations.added.push(relationPreview);
      previewRelations.removed.push({
        to_page_slug: existingRelation.to_page_slug,
        relation_type: existingRelation.relation_type,
        rationale: existingRelation.rationale ?? null,
        previous_rationale: existingRelation.rationale ?? null,
      });
    } else {
      previewRelations.unchanged.push(relationPreview);
    }
  }

  const compiledRelationKeys = new Set(
    compiledRelations.map((relation) => relationPreviewKey(relation)),
  );
  for (const existingRelation of existingRelations) {
    if (compiledRelationKeys.has(relationPreviewKey(existingRelation)))
      continue;
    previewRelations.removed.push({
      to_page_slug: existingRelation.to_page_slug,
      relation_type: existingRelation.relation_type,
      rationale: existingRelation.rationale ?? null,
      previous_rationale: existingRelation.rationale ?? null,
    });
  }

  const pageChanges = existingPage
    ? {
        title: existingPage.title !== compiled.page.title,
        page_kind: existingPage.page_kind !== compiled.page.page_kind,
        summary: (existingPage.summary || '') !== compiled.page.summary,
        content_markdown:
          existingPage.content_markdown.trim() !==
          compiled.page.content_markdown.trim(),
        any: false,
      }
    : {
        title: true,
        page_kind: true,
        summary: compiled.page.summary.trim().length > 0,
        content_markdown: true,
        any: true,
      };
  pageChanges.any =
    pageChanges.title ||
    pageChanges.page_kind ||
    pageChanges.summary ||
    pageChanges.content_markdown;
  const contentDiff = buildMarkdownBlockDiff(
    existingPage?.content_markdown || '',
    compiled.page.content_markdown,
  );

  return {
    mode: existingPage ? 'update' : 'create',
    existing_page: existingPage,
    page_changes: pageChanges,
    materials: {
      added_material_ids: nextMaterialIds.filter(
        (materialId) => !existingMaterialIdSet.has(materialId),
      ),
      removed_material_ids: existingMaterialIds.filter(
        (materialId) => !nextMaterialIdSet.has(materialId),
      ),
      unchanged_material_ids: nextMaterialIds.filter((materialId) =>
        existingMaterialIdSet.has(materialId),
      ),
    },
    claims: previewClaims,
    relations: previewRelations,
    content_diff: contentDiff,
  };
}

function summarizeWikiDraftPublishPreview(
  preview: WikiDraftPublishPreview,
): WikiDraftPublishPreviewSummary {
  return {
    mode: preview.mode,
    claims_added: preview.claims.added.length,
    claims_updated: preview.claims.updated.length,
    claims_removed: preview.claims.removed.length,
    relations_added: preview.relations.added.length,
    relations_removed: preview.relations.removed.length,
    content_added: preview.content_diff.added_count,
    content_updated: preview.content_diff.updated_count,
    content_removed: preview.content_diff.removed_count,
    materials_added: preview.materials.added_material_ids.length,
    materials_removed: preview.materials.removed_material_ids.length,
  };
}

function getWikiMaterialUsage(materialId: string): WikiMaterialUsage {
  const pageRefs = listWikiPagesReferencingMaterial(materialId).map((page) => ({
    slug: page.slug,
    title: page.title,
  }));
  const draftRefs = listWikiDrafts(1000000)
    .filter(
      (draft) =>
        draft.status !== 'published' &&
        parseJsonStringArray(draft.material_ids_json).includes(materialId),
    )
    .map((draft) => ({
      id: draft.id,
      title: draft.title,
      target_slug: draft.target_slug,
      status: draft.status,
    }));
  const jobRefs = listPendingWikiJobs()
    .filter((job) => {
      try {
        const payload = JSON.parse(job.payload_json) as {
          materialIds?: string[];
        };
        return (
          Array.isArray(payload.materialIds) &&
          payload.materialIds.includes(materialId)
        );
      } catch {
        return false;
      }
    })
    .map((job) => ({
      id: job.id,
      job_type: job.job_type,
      status: job.status,
    }));
  return {
    page_refs: pageRefs,
    draft_refs: draftRefs,
    job_refs: jobRefs,
    evidence_count: countWikiClaimEvidenceByMaterial(materialId),
    can_delete:
      pageRefs.length === 0 && draftRefs.length === 0 && jobRefs.length === 0,
  };
}

function buildCompileSystemPrompt(): string {
  return [
    'You are a wiki drafting engine for a personal knowledge base.',
    'Use only the provided materials and existing page context.',
    'Do not invent facts or fill gaps from general knowledge.',
    'Return JSON only. No markdown fences. No prose outside JSON.',
    'A Page is a readable topic page.',
    'A Claim is an atomic statement owned by exactly one page.',
    'Claims are the structured provenance layer for the page.',
    'Every important factual statement, rule, table meaning, dependency, decision, or procedure in page.content_markdown should be represented by one or more claims.',
    'Keep each claim atomic: one claim should express one fact, rule, dependency, decision, or procedure step.',
    'Avoid redundant claims: if two claims say the same thing, keep one canonical claim.',
    'Each claim must include at least one evidence item grounded in a provided material_id.',
    'Evidence excerpt_text must be an exact or near-exact excerpt from the provided materials; prefer the shortest excerpt that proves the claim.',
    'Do not create title-only or document-name-only claims.',
    'Do not output a long page with only a few claims.',
    'For source-like documents, extract claims from headings, bullet points, table rows, and explicit rules.',
    'For project pages, cover module responsibilities, core business rules, key tables and ownership, downstream dependencies, branch or environment rules, and known implementation caveats when present.',
    'Even when the user instruction asks to preserve source wording or avoid summarization, still extract structured claims for important facts and rules.',
    'Claims omitted from the output are treated as removed from the page snapshot.',
    'Prefer concise, readable Chinese for summaries and content when possible.',
    'Output schema:',
    '{"page":{"slug":"...","title":"...","page_kind":"project|concept|decision|procedure|person|glossary","summary":"...","content_markdown":"..."},"claims":[{"claim_type":"fact|definition|rule|decision|procedure_step|preference","statement":"...","canonical_form":"...","confidence":0.0,"evidence":[{"material_id":"...","excerpt_text":"...","locator":"..."}]}],"relations":[{"to_slug":"...","relation_type":"related_to|depends_on|defines|part_of|conflicts_with|supersedes|example_of","rationale":"..."}]}',
  ].join(' ');
}

function buildCompileUserPrompt(input: QueueDraftJobInput): string {
  const materials = input.materialIds
    .map((materialId) => getWikiMaterial(materialId))
    .filter((item): item is WikiMaterialRecord => item !== undefined)
    .map((material) => ({
      id: material.id,
      title: material.title,
      note: material.note,
      source_name: material.source_name,
      text: readWikiMaterialExtractedText(material),
    }));
  if (materials.length === 0) {
    throw new Error('未找到可用于编纂的资料');
  }

  const { maxMaterialChars, maxTotalMaterialChars } =
    getWikiMaterialCharLimits();
  let remaining = maxTotalMaterialChars;
  const compactMaterials = materials.map((material) => {
    const next = limitMaterialText(
      material.text,
      Math.min(remaining, maxMaterialChars),
    );
    remaining = Math.max(0, remaining - next.length);
    return {
      id: material.id,
      title: material.title,
      note: material.note,
      source_name: material.source_name,
      text: next,
    };
  });

  const existingPage =
    input.targetSlug && getWikiPage(slugify(input.targetSlug))
      ? {
          page: getWikiPage(slugify(input.targetSlug)),
          claims: listWikiClaimsByPage(slugify(input.targetSlug)),
        }
      : null;

  return JSON.stringify(
    {
      task: 'draft_wiki_page',
      target_slug: input.targetSlug || '',
      requested_title: input.title || '',
      requested_page_kind: input.pageKind || '',
      instruction: input.instruction || '',
      constraints: {
        evidence_only_from_materials: true,
        dedupe_claims: true,
        claim_coverage_required: true,
        evidence_excerpt_must_be_from_materials: true,
        avoid_title_only_claims: true,
        material_count: compactMaterials.length,
      },
      existing_page: existingPage
        ? {
            slug: existingPage.page?.slug,
            title: existingPage.page?.title,
            page_kind: existingPage.page?.page_kind,
            summary: existingPage.page?.summary,
            content_markdown: existingPage.page?.content_markdown,
            active_claims: existingPage.claims.map((claim) => ({
              claim_type: claim.claim_type,
              canonical_form: claim.canonical_form,
              statement: claim.statement,
              confidence: claim.confidence,
            })),
          }
        : null,
      materials: compactMaterials,
    },
    null,
    2,
  );
}

async function generateWikiDraftFromMaterials(
  input: QueueDraftJobInput,
  options: {
    jobId?: string;
    signal?: AbortSignal;
  } = {},
): Promise<WikiDraftRecord> {
  if (!Array.isArray(input.materialIds) || input.materialIds.length === 0) {
    throw new Error('至少需要选择一份资料');
  }
  throwIfSignalAborted(options.signal);
  const requestPayload = {
    system: buildCompileSystemPrompt(),
    messages: [
      {
        role: 'user' as const,
        content: buildCompileUserPrompt(input),
      },
    ],
    temperature: 0.1,
    max_tokens: 12000,
  };
  const response = await callAnthropicMessages(
    requestPayload,
    undefined,
    getWikiDraftTimeoutMs(),
    { signal: options.signal },
  );
  throwIfSignalAborted(options.signal);
  let compiled: CompiledWikiDraft;
  try {
    compiled = parseCompiledWikiDraft(response.text);
    throwIfSignalAborted(options.signal);
    validateCompiledDraftEvidence(compiled, input.materialIds);
  } catch (err) {
    throwIfSignalAborted(options.signal);
    const rawResponsePath = persistFailedWikiDraftRawResponse({
      jobId: options.jobId,
      draftInput: input,
      responseText: response.text,
      err,
    });
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      rawResponsePath
        ? `${message}; 原始响应已保存: ${rawResponsePath}`
        : message,
    );
  }
  throwIfSignalAborted(options.signal);

  const now = nowIso();
  const draftId = createId('wiki-draft');
  const draftFilePath = path.join(WIKI_DRAFTS_DIR, `${draftId}.md`);
  const markdown = buildDraftMarkdown(compiled, input.materialIds);
  fs.writeFileSync(draftFilePath, markdown, 'utf-8');

  const draft: WikiDraftRecord = {
    id: draftId,
    target_slug: compiled.page.slug,
    title: compiled.page.title,
    page_kind: compiled.page.page_kind,
    status: 'draft',
    instruction: input.instruction?.trim() || null,
    content_markdown: markdown,
    summary: compiled.page.summary || null,
    payload_json: JSON.stringify(compiled),
    material_ids_json: JSON.stringify(input.materialIds),
    file_path: draftFilePath,
    created_at: now,
    updated_at: now,
    published_at: null,
  };
  createWikiDraft(draft);
  return draft;
}

async function processWikiJob(job: WikiJobRecord): Promise<void> {
  const startedAt = nowIso();
  const controller = new AbortController();
  activeWikiJobControllers.set(job.id, controller);
  updateWikiJob(job.id, {
    status: 'running',
    started_at: startedAt,
    updated_at: startedAt,
    error_message: null,
  });

  try {
    if (job.job_type !== 'draft_generate') {
      throw new Error(`Unsupported wiki job type: ${job.job_type}`);
    }

    const payload = JSON.parse(job.payload_json) as QueueDraftJobInput;
    const draft = await generateWikiDraftFromMaterials(payload, {
      jobId: job.id,
      signal: controller.signal,
    });
    updateWikiJob(job.id, {
      status: 'completed',
      result_json: JSON.stringify({
        draft_id: draft.id,
        target_slug: draft.target_slug,
        title: draft.title,
      }),
      finished_at: nowIso(),
    });
  } catch (err) {
    if (controller.signal.aborted || stoppingWikiJobIds.has(job.id)) {
      updateWikiJob(job.id, {
        status: 'failed',
        error_message: '任务已手动停止',
        finished_at: nowIso(),
      });
      return;
    }
    logger.error({ err, jobId: job.id }, 'Wiki job failed');
    updateWikiJob(job.id, {
      status: 'failed',
      error_message: err instanceof Error ? err.message : String(err),
      finished_at: nowIso(),
    });
  } finally {
    activeWikiJobControllers.delete(job.id);
    stoppingWikiJobIds.delete(job.id);
  }
}

async function drainWikiJobQueue(): Promise<void> {
  if (wikiJobDrainRunning) return;
  wikiJobDrainRunning = true;
  try {
    while (pendingJobIds.length > 0) {
      const jobId = pendingJobIds.shift();
      if (!jobId) continue;
      const job = getWikiJob(jobId);
      if (!job || job.status !== 'pending') continue;
      await processWikiJob(job);
    }
  } finally {
    wikiJobDrainRunning = false;
  }
}

function enqueueWikiJob(jobId: string): void {
  if (!pendingJobIds.includes(jobId)) pendingJobIds.push(jobId);
  setTimeout(() => {
    void drainWikiJobQueue();
  }, 0);
}

export function resumePendingWikiJobs(): void {
  for (const job of listPendingWikiJobs()) {
    if (job.status === 'running') {
      updateWikiJob(job.id, {
        status: 'failed',
        error_message: 'Job interrupted by process restart',
        finished_at: nowIso(),
      });
      continue;
    }
    enqueueWikiJob(job.id);
  }
}

export function queueWikiDraftGenerationJob(
  input: QueueDraftJobInput,
): WikiJobRecord {
  ensureWikiDirs();
  const now = nowIso();
  const job: WikiJobRecord = {
    id: createId('wiki-job'),
    job_type: 'draft_generate',
    status: 'pending',
    payload_json: JSON.stringify({
      materialIds: [...new Set(input.materialIds.filter(Boolean))],
      targetSlug: input.targetSlug?.trim() || '',
      title: input.title?.trim() || '',
      pageKind: input.pageKind?.trim() || '',
      instruction: input.instruction?.trim() || '',
    }),
    result_json: null,
    error_message: null,
    created_at: now,
    updated_at: now,
    started_at: null,
    finished_at: null,
  };
  createWikiJob(job);
  enqueueWikiJob(job.id);
  return job;
}

export function stopWikiJob(jobId: string): {
  job_id: string;
  status: 'stopping';
} {
  const job = getWikiJob(jobId);
  if (!job) throw new Error('Job not found');
  if (job.status !== 'running') {
    throw new Error('仅支持停止运行中的后台任务');
  }
  if (!stoppingWikiJobIds.has(jobId)) {
    stoppingWikiJobIds.add(jobId);
    updateWikiJob(jobId, {
      error_message: '停止中...',
      updated_at: nowIso(),
    });
    activeWikiJobControllers
      .get(jobId)
      ?.abort(createAbortError('Wiki job stopped by user'));
  }
  return {
    job_id: jobId,
    status: 'stopping',
  };
}

export function deleteFinishedWikiJobs(): {
  deleted_count: number;
  deleted_ids: string[];
} {
  const deletedIds = listWikiJobs(1000000)
    .filter((job) => job.status === 'completed' || job.status === 'failed')
    .map((job) => job.id);
  deletedIds.forEach((jobId) => {
    deleteWikiJobRecord(jobId);
  });
  return {
    deleted_count: deletedIds.length,
    deleted_ids: deletedIds,
  };
}

function buildPublishedPageMarkdown(
  page: WikiPageRecord,
  materials: WikiMaterialRecord[],
): string {
  const frontmatter = YAML.stringify({
    title: page.title,
    slug: page.slug,
    page_kind: page.page_kind,
    summary: page.summary,
    source_material_ids: materials.map((item) => item.id),
    updated_at: page.updated_at,
    status: page.status,
  }).trim();
  return `---\n${frontmatter}\n---\n\n${page.content_markdown.trim()}\n`;
}

export function publishWikiDraft(draftId: string): {
  page: WikiPageRecord;
  claims: WikiClaimRecord[];
  materials: WikiMaterialRecord[];
  relations: WikiRelationRecord[];
} {
  ensureWikiDirs();
  const draft = getWikiDraft(draftId);
  if (!draft) throw new Error('Draft not found');
  const compiled = parseCompiledWikiDraft(draft.payload_json);
  const materialIds = JSON.parse(draft.material_ids_json) as string[];
  const now = nowIso();
  const pageFilePath = path.join(WIKI_PAGES_DIR, `${compiled.page.slug}.md`);
  const existingPage = getWikiPage(compiled.page.slug);
  const page: WikiPageRecord = {
    slug: compiled.page.slug,
    title: compiled.page.title,
    page_kind: compiled.page.page_kind,
    status: 'published',
    summary: compiled.page.summary || null,
    content_markdown: compiled.page.content_markdown.trim(),
    file_path: pageFilePath,
    created_at: existingPage?.created_at || now,
    updated_at: now,
  };
  upsertWikiPage(page);
  replaceWikiPageMaterials(page.slug, materialIds);

  const allExistingClaims = listWikiClaimsByPage(page.slug, {
    includeDeprecated: true,
  });
  const reusableByCanonical = new Map<string, WikiClaimRecord>();
  for (const claim of allExistingClaims) {
    if (!reusableByCanonical.has(claim.canonical_form)) {
      reusableByCanonical.set(claim.canonical_form, claim);
    }
  }

  const activeClaimIds = new Set(
    allExistingClaims
      .filter((claim) => claim.status === 'active')
      .map((claim) => claim.id),
  );
  const touchedClaimIds = new Set<string>();
  validateCompiledDraftEvidence(compiled, materialIds);

  for (const claim of compiled.claims) {
    const materialEvidence = claim.evidence.filter((item) =>
      materialIds.includes(item.material_id),
    );
    const reusable = reusableByCanonical.get(claim.canonical_form);
    const claimId = reusable?.id || createId('wiki-claim');
    if (reusable) {
      updateWikiClaim(claimId, {
        owner_page_slug: page.slug,
        claim_type: claim.claim_type,
        canonical_form: claim.canonical_form,
        statement: claim.statement,
        status: 'active',
        confidence: claim.confidence,
        updated_at: now,
      });
    } else {
      createWikiClaim({
        id: claimId,
        owner_page_slug: page.slug,
        claim_type: claim.claim_type,
        canonical_form: claim.canonical_form,
        statement: claim.statement,
        status: 'active',
        confidence: claim.confidence,
        created_at: now,
        updated_at: now,
      });
    }
    replaceWikiClaimEvidence(claimId, materialEvidence);
    touchedClaimIds.add(claimId);
  }

  for (const claimId of activeClaimIds) {
    if (!touchedClaimIds.has(claimId)) {
      updateWikiClaim(claimId, {
        status: 'deprecated',
        updated_at: now,
      });
    }
  }

  replaceWikiRelationsForPage(
    page.slug,
    compiled.relations.map((relation) => ({
      to_page_slug: relation.to_slug,
      relation_type: relation.relation_type,
      rationale: relation.rationale ?? null,
    })),
  );
  const materials = listWikiPageMaterials(page.slug);
  fs.writeFileSync(
    page.file_path,
    buildPublishedPageMarkdown(page, materials),
    'utf-8',
  );
  updateWikiDraft(draftId, {
    status: 'published',
    published_at: now,
    updated_at: now,
  });

  return {
    page: getWikiPage(page.slug)!,
    claims: listWikiClaimsByPage(page.slug),
    materials,
    relations: listWikiRelationsForPage(page.slug),
  };
}

export function getWikiDraftDetail(draftId: string): {
  draft: WikiDraftRecord;
  compiled: CompiledWikiDraft;
  materials: WikiMaterialRecord[];
  publish_preview: WikiDraftPublishPreview;
  publish_preview_summary: WikiDraftPublishPreviewSummary;
} | null {
  const draft = getWikiDraft(draftId);
  if (!draft) return null;
  const materialIds = JSON.parse(draft.material_ids_json) as string[];
  const compiled = parseCompiledWikiDraft(draft.payload_json);
  const publishPreview = buildWikiDraftPublishPreview(compiled, materialIds);
  return {
    draft,
    compiled,
    materials: materialIds
      .map((materialId) => getWikiMaterial(materialId))
      .filter((item): item is WikiMaterialRecord => item !== undefined),
    publish_preview: publishPreview,
    publish_preview_summary: summarizeWikiDraftPublishPreview(publishPreview),
  };
}

export function getWikiMaterialDetail(materialId: string): {
  material: WikiMaterialRecord;
  extracted_text: string;
  usage: WikiMaterialUsage;
} | null {
  const material = getWikiMaterial(materialId);
  if (!material) return null;
  return {
    material,
    extracted_text: readWikiMaterialExtractedText(material),
    usage: getWikiMaterialUsage(materialId),
  };
}

export function listWikiMaterialSummaries(limit: number = 200): Array<
  WikiMaterialRecord & {
    extracted_length: number;
    preview: string;
    usage_summary: {
      page_ref_count: number;
      draft_ref_count: number;
      job_ref_count: number;
      evidence_count: number;
      can_delete: boolean;
    };
  }
> {
  return listWikiMaterials(limit).map((material) => {
    const extractedText = readWikiMaterialExtractedText(material);
    const usage = getWikiMaterialUsage(material.id);
    return {
      ...material,
      extracted_length: extractedText.length,
      preview: extractedText.slice(0, 280),
      usage_summary: {
        page_ref_count: usage.page_refs.length,
        draft_ref_count: usage.draft_refs.length,
        job_ref_count: usage.job_refs.length,
        evidence_count: usage.evidence_count,
        can_delete: usage.can_delete,
      },
    };
  });
}

export function getWikiPageDetail(pageSlug: string): {
  page: WikiPageRecord;
  claims: Array<WikiClaimRecord & { evidence: WikiClaimEvidenceRecord[] }>;
  materials: WikiMaterialRecord[];
  relations: WikiRelationRecord[];
  incoming_relations: Array<
    WikiRelationRecord & {
      from_page_title: string | null;
    }
  >;
} | null {
  const page = getWikiPage(pageSlug);
  if (!page) return null;
  const claims = listWikiClaimsByPage(pageSlug).map((claim) => ({
    ...claim,
    evidence: listWikiClaimEvidence(claim.id),
  }));
  return {
    page,
    claims,
    materials: listWikiPageMaterials(pageSlug),
    relations: listWikiRelationsForPage(pageSlug),
    incoming_relations: listWikiRelationsToPage(pageSlug).map((relation) => ({
      ...relation,
      from_page_title: getWikiPage(relation.from_page_slug)?.title || null,
    })),
  };
}

export function listWikiPageSummaries(limit: number = 200): Array<
  WikiPageRecord & {
    incoming_relation_count: number;
  }
> {
  return listWikiPages(limit).map((page) => ({
    ...page,
    incoming_relation_count: listWikiRelationsToPage(page.slug).length,
  }));
}

export function deleteWikiDraft(draftId: string): {
  draft_id: string;
} {
  const draft = getWikiDraft(draftId);
  if (!draft) throw new Error('Draft not found');
  deleteWikiDraftRecord(draftId);
  removePathIfExists(draft.file_path);
  return { draft_id: draftId };
}

export function bulkDeleteWikiDrafts(draftIds: string[]): {
  deleted_ids: string[];
  skipped_published_ids: string[];
  missing_ids: string[];
} {
  const deletedIds: string[] = [];
  const skippedPublishedIds: string[] = [];
  const missingIds: string[] = [];
  const uniqueIds = [
    ...new Set(draftIds.map((id) => id.trim()).filter(Boolean)),
  ];

  for (const draftId of uniqueIds) {
    const draft = getWikiDraft(draftId);
    if (!draft) {
      missingIds.push(draftId);
      continue;
    }
    if (draft.status === 'published') {
      skippedPublishedIds.push(draftId);
      continue;
    }
    deleteWikiDraftRecord(draftId);
    removePathIfExists(draft.file_path);
    deletedIds.push(draftId);
  }

  return {
    deleted_ids: deletedIds,
    skipped_published_ids: skippedPublishedIds,
    missing_ids: missingIds,
  };
}

export function deleteWikiMaterial(materialId: string): {
  material_id: string;
} {
  const material = getWikiMaterial(materialId);
  if (!material) throw new Error('Material not found');
  const usage = getWikiMaterialUsage(materialId);
  if (!usage.can_delete) {
    const reasons = [
      usage.page_refs.length > 0 ? `${usage.page_refs.length} 个页面` : '',
      usage.draft_refs.length > 0 ? `${usage.draft_refs.length} 个草稿` : '',
      usage.job_refs.length > 0 ? `${usage.job_refs.length} 个任务` : '',
    ].filter(Boolean);
    throw new Error(`资料仍被引用，无法删除：${reasons.join('、')}`);
  }
  deleteWikiMaterialRecord(materialId);
  removePathIfExists(path.dirname(material.stored_path));
  return { material_id: materialId };
}

export function deleteWikiPage(pageSlug: string): {
  page_slug: string;
  removed_claim_count: number;
  removed_material_count: number;
  removed_outgoing_relation_count: number;
  removed_incoming_relation_count: number;
} {
  const page = getWikiPage(pageSlug);
  if (!page) throw new Error('Page not found');
  const removedClaimCount = listWikiClaimsByPage(pageSlug, {
    includeDeprecated: true,
  }).length;
  const removedMaterialCount = listWikiPageMaterials(pageSlug).length;
  const removedOutgoingRelationCount =
    listWikiRelationsForPage(pageSlug).length;
  const removedIncomingRelationCount = listWikiRelationsToPage(pageSlug).length;
  deleteWikiPageGraph(pageSlug);
  removePathIfExists(page.file_path);
  return {
    page_slug: pageSlug,
    removed_claim_count: removedClaimCount,
    removed_material_count: removedMaterialCount,
    removed_outgoing_relation_count: removedOutgoingRelationCount,
    removed_incoming_relation_count: removedIncomingRelationCount,
  };
}

export function clearWikiData(): {
  material_count: number;
  draft_count: number;
  page_count: number;
  claim_count: number;
  evidence_count: number;
  relation_count: number;
  job_count: number;
} {
  if (
    wikiJobDrainRunning ||
    listPendingWikiJobs().some((job) => job.status === 'running')
  ) {
    throw new Error(
      '当前有正在运行的知识库后台任务，请等待任务完成后再清除 LLM Wiki',
    );
  }

  pendingJobIds.length = 0;
  const summary = clearAllWikiRecords();
  removePathIfExists(WIKI_MATERIALS_DIR);
  removePathIfExists(WIKI_DRAFTS_DIR);
  removePathIfExists(WIKI_PAGES_DIR);
  ensureWikiDirs();
  return summary;
}
