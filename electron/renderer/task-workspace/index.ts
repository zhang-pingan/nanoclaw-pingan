import {
  TaskWorkspaceApiClient,
  TaskWorkspaceApiError,
  shouldRefreshTemporaryInteraction,
  type Fetcher,
} from './api-client.js';
import {
  isCurrentTemporaryRevision,
  normalizeInteraction,
  renderInteractionCard,
  replanInteraction,
  resolveTemporaryConfirmation,
} from './interactions/index.js';
import {
  compactId,
  escapeAttribute,
  escapeHtml,
  formatTime,
  isRecord,
  readableLabel,
  renderArtifact,
  renderMarkdown,
  stringifyJson,
} from './rendering.js';
import {
  renderExecutionOptions,
  renderInspectorPanel,
} from './runtime-inspector/index.js';
import {
  chooseExecution,
  createTaskWorkspaceState,
  currentRun,
  currentWorkflow,
  mergeTimelineEntries,
  timelineCursor,
  visibleSessions,
  workflowIdentity,
  type RecipeCatalogItem,
  type TaskSession,
  type TaskWorkspaceState,
  type TimelineEntry,
} from './state.js';
import {
  isTaskWorkspaceSessionLink,
  runtimeCenterRunLink,
  type RuntimeCenterRunLink,
  type TaskWorkspaceSessionLink,
} from './navigation.js';
import { canonicalize } from 'json-canonicalize';

export interface TaskWorkspaceHost {
  navButton: HTMLButtonElement;
  screen: HTMLElement;
  root: HTMLElement;
}

export interface MountTaskWorkspaceOptions {
  root: HTMLElement;
  apiFetch: Fetcher;
  showToast?: (message: string, duration?: number) => void;
  initialSessionId?: string;
  onSessionSelected?: (link: TaskWorkspaceSessionLink) => void;
  openRuntimeCenter?: (link: RuntimeCenterRunLink) => void;
  pollMs?: number;
}

interface TaskWorkspaceDelta {
  type: 'task_workspace_timeline_delta';
  session_id: string;
  after_session_seq: number;
  entries: TimelineEntry[];
  next_session_seq: number;
  source_state: 'ready' | 'catching_up' | 'degraded';
}

let mountedRenderer: TaskWorkspaceRenderer | null = null;
let queuedSessionLink: TaskWorkspaceSessionLink | null = null;

export function createTaskWorkspaceHost(options: {
  navigation: HTMLElement;
  screenParent: HTMLElement;
  navInsertBefore?: Element | null;
  screenInsertBefore?: Element | null;
}): TaskWorkspaceHost {
  let navButton = options.navigation.querySelector<HTMLButtonElement>(
    '[data-nav-key="task-workspace"]',
  );
  if (!navButton) {
    navButton = document.createElement('button');
    navButton.type = 'button';
    navButton.className = 'primary-nav-item';
    navButton.dataset.navKey = 'task-workspace';
    navButton.innerHTML =
      '<span class="primary-nav-dot"></span><span class="primary-nav-label">Tasks</span>';
    options.navigation.insertBefore(navButton, options.navInsertBefore ?? null);
  }
  let screen = options.screenParent.querySelector<HTMLElement>(
    '#task-workspace-screen',
  );
  if (!screen) {
    screen = document.createElement('section');
    screen.id = 'task-workspace-screen';
    const root = document.createElement('main');
    root.id = 'task-workspace-root';
    root.className = 'tw-root';
    screen.appendChild(root);
    options.screenParent.insertBefore(
      screen,
      options.screenInsertBefore ?? null,
    );
  }
  const root = screen.querySelector<HTMLElement>('#task-workspace-root');
  if (!root) throw new Error('Task Workspace root is unavailable');
  return { navButton, screen, root };
}

export function mountTaskWorkspace(
  options: MountTaskWorkspaceOptions,
): () => void {
  if (mountedRenderer) mountedRenderer.unmount();
  const initialSessionId =
    queuedSessionLink?.session_id ?? options.initialSessionId;
  queuedSessionLink = null;
  mountedRenderer = new TaskWorkspaceRenderer({
    ...options,
    initialSessionId,
  });
  mountedRenderer.mount();
  return () => unmountTaskWorkspace();
}

export function unmountTaskWorkspace(): void {
  mountedRenderer?.unmount();
  mountedRenderer = null;
}

export function handleTaskWorkspaceWebSocketMessage(message: unknown): boolean {
  if (!isRecord(message) || message.type !== 'task_workspace_timeline_delta') {
    return false;
  }
  mountedRenderer?.receiveDelta(message as unknown as TaskWorkspaceDelta);
  return true;
}

export function notifyTaskWorkspaceWebSocketReconnect(): void {
  mountedRenderer?.recoverAfterReconnect();
}

export function navigateTaskWorkspace(link: unknown): boolean {
  if (!isTaskWorkspaceSessionLink(link)) return false;
  if (mountedRenderer) mountedRenderer.navigateToSession(link.session_id);
  else queuedSessionLink = link;
  return true;
}

function idempotencyKey(prefix: string): string {
  const suffix =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${suffix}`;
}

function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

export async function calculateInteractionPayloadHash(
  value: unknown,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    `icarus:task-workspace:interaction-payload:1\n${canonicalJson(value)}`,
  );
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

function messageBody(payload: Record<string, unknown>): string {
  const body = payload.body;
  return typeof body === 'string' ? body : stringifyJson(body);
}

function eventSummary(payload: Record<string, unknown>): string {
  const nested = isRecord(payload.payload) ? payload.payload : null;
  return String(
    nested?.summary ??
      nested?.message ??
      payload.summary ??
      payload.message ??
      payload.event_type ??
      'Runtime updated',
  );
}

function isArtifactEntry(entry: TimelineEntry): boolean {
  return (
    entry.kind === 'artifact_published' ||
    String(entry.payload_json.event_type ?? '')
      .toLocaleLowerCase()
      .includes('artifact')
  );
}

function renderTimelineEntry(
  entry: TimelineEntry,
  interactionPayload: Record<string, unknown> | null = null,
): string {
  const payload = entry.payload_json;
  if (entry.kind === 'human_message' || entry.kind === 'coordinator_message') {
    const human = entry.kind === 'human_message';
    return `
      <article class="tw-message ${human ? 'is-human' : 'is-coordinator'}" data-entry-id="${escapeAttribute(entry.entry_id)}">
        <header><strong>${human ? 'You' : 'Coordinator'}</strong><time>${escapeHtml(formatTime(entry.occurred_at_ms))}</time></header>
        <div class="tw-markdown">${renderMarkdown(messageBody(payload))}</div>
        ${payload.query_id ? `<span class="tw-query-ref" title="${escapeAttribute(payload.query_id)}">Trace ${escapeHtml(compactId(payload.query_id))}</span>` : ''}
      </article>`;
  }
  if (
    entry.kind === 'pending_interaction' ||
    payload.interaction_kind === 'temporary_confirmation'
  ) {
    return `<div class="tw-timeline-interaction" data-entry-id="${escapeAttribute(entry.entry_id)}">${renderInteractionCard(interactionPayload ?? payload, 'timeline')}</div>`;
  }
  if (isArtifactEntry(entry)) {
    return `<div class="tw-timeline-artifact" data-entry-id="${escapeAttribute(entry.entry_id)}">${renderArtifact(payload)}</div>`;
  }
  const eventType = String(payload.event_type ?? entry.kind);
  const terminal = entry.kind === 'workflow_completed';
  return `
    <article class="tw-runtime-event ${terminal ? 'is-terminal' : ''}" data-entry-id="${escapeAttribute(entry.entry_id)}">
      <span class="tw-runtime-dot"></span>
      <div><header><strong>${escapeHtml(readableLabel(eventType))}</strong><time>${escapeHtml(formatTime(entry.occurred_at_ms))}</time></header><p>${escapeHtml(eventSummary(payload))}</p></div>
      <span class="tw-runtime-source">${escapeHtml(compactId(payload.run_id ?? entry.source_id))}</span>
    </article>`;
}

class TaskWorkspaceRenderer {
  private readonly state: TaskWorkspaceState = createTaskWorkspaceState();
  private readonly api: TaskWorkspaceApiClient;
  private readonly pollMs: number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private openSequence = 0;
  private catchingUp = false;
  private detailTimer: ReturnType<typeof setTimeout> | null = null;
  private catalogExpiresAt = 0;

  constructor(private readonly options: MountTaskWorkspaceOptions) {
    this.api = new TaskWorkspaceApiClient(options.apiFetch);
    this.pollMs = options.pollMs ?? 12_000;
  }

  mount(): void {
    this.disposed = false;
    this.options.root.innerHTML = this.shell();
    this.options.root.addEventListener('click', this.onClick);
    this.options.root.addEventListener('input', this.onInput);
    this.options.root.addEventListener('change', this.onChange);
    this.options.root.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    void this.bootstrap();
    this.pollTimer = setInterval(() => {
      if (!document.hidden) void this.poll();
    }, this.pollMs);
  }

  unmount(): void {
    this.disposed = true;
    this.openSequence += 1;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.detailTimer) clearTimeout(this.detailTimer);
    this.pollTimer = null;
    this.detailTimer = null;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.options.root.removeEventListener('click', this.onClick);
    this.options.root.removeEventListener('input', this.onInput);
    this.options.root.removeEventListener('change', this.onChange);
    this.options.root.removeEventListener('keydown', this.onKeyDown);
    this.options.root.innerHTML = '';
  }

  receiveDelta(delta: TaskWorkspaceDelta): void {
    if (this.disposed) return;
    if (delta.session_id !== this.state.activeSession?.session_id) {
      void this.refreshSessions();
      return;
    }
    if (delta.after_session_seq > this.state.timelineCursor) {
      void this.catchUpTimeline();
      return;
    }
    this.applyDelta(delta);
    this.scheduleRuntimeDetail();
  }

  recoverAfterReconnect(): void {
    if (this.disposed) return;
    void this.poll();
  }

  navigateToSession(sessionId: string): void {
    if (this.disposed || !sessionId.trim()) return;
    void this.openSession(sessionId.trim());
  }

  private shell(): string {
    return `
      <div class="tw-shell">
        <aside class="tw-sessions" aria-label="Task Sessions">
          <header class="tw-pane-header"><h1>Tasks</h1><button type="button" class="tw-icon-btn" data-tw-action="new-session" title="New task" aria-label="New task"><span aria-hidden="true">+</span></button></header>
          <div class="tw-session-tools">
            <input type="search" data-role="session-search" placeholder="Search tasks" aria-label="Search tasks">
            <div class="tw-segments" role="tablist" aria-label="Task state">
              ${(['active', 'waiting', 'completed', 'archived'] as const).map((filter) => `<button type="button" role="tab" data-tw-action="session-filter" data-filter="${filter}" class="${filter === 'active' ? 'is-active' : ''}">${escapeHtml(readableLabel(filter))}</button>`).join('')}
            </div>
          </div>
          <div class="tw-session-list" data-role="session-list"></div>
        </aside>
        <main class="tw-conversation">
          <header class="tw-conversation-header" data-role="session-header"></header>
          <div class="tw-timeline" data-role="timeline" aria-live="polite"></div>
          <footer class="tw-composer-dock">
            <div class="tw-composer">
              <textarea data-role="composer-input" rows="2" placeholder="Message or describe a task" aria-label="Task message"></textarea>
              <div class="tw-composer-footer">
                <div class="tw-composer-context">
                  <label class="tw-selector"><span>Workflow</span><select data-role="recipe-selector" aria-label="Workflow recipe"></select></label>
                  <span class="tw-cursor-state" data-role="cursor-state"></span>
                </div>
                <span class="tw-error" data-role="error" aria-live="assertive"></span>
                <div class="tw-composer-actions"><button type="button" class="tw-btn tw-btn-quiet" data-tw-action="send" disabled>Send</button><button type="button" class="tw-btn tw-btn-primary" data-tw-action="run" disabled>Run</button></div>
              </div>
            </div>
          </footer>
        </main>
        <aside class="tw-inspector" aria-label="Runtime Inspector">
          <header class="tw-inspector-header"><h2>Runtime</h2><button type="button" class="tw-icon-btn tw-inspector-close" data-tw-action="toggle-inspector" data-inspector-control="close" title="Close Runtime" aria-label="Close Runtime"><span aria-hidden="true">&times;</span></button></header>
          <label class="tw-execution-selector"><span>Workflow run</span><select data-role="execution-selector" aria-label="Linked Workflow and Run"></select></label>
          <nav class="tw-inspector-tabs" aria-label="Inspector panels">
            ${(['overview', 'dag', 'artifacts', 'pending', 'trace'] as const).map((panel) => `<button type="button" data-tw-action="inspector-tab" data-panel="${panel}" class="${panel === 'overview' ? 'is-active' : ''}">${panel === 'dag' ? 'DAG' : escapeHtml(readableLabel(panel))}</button>`).join('')}
          </nav>
          <div class="tw-inspector-content" data-role="inspector-content"></div>
        </aside>
        <dialog class="tw-new-task-dialog" data-role="new-session-dialog" aria-labelledby="tw-new-task-title">
          <div class="tw-new-task-form">
            <header><h2 id="tw-new-task-title">New task</h2><button type="button" class="tw-icon-btn" data-tw-action="cancel-new-session" title="Close" aria-label="Close"><span aria-hidden="true">&times;</span></button></header>
            <label><span>Title</span><input type="text" data-role="new-session-title" maxlength="240" autocomplete="off" placeholder="Task title"></label>
            <div class="tw-new-task-actions"><button type="button" class="tw-btn tw-btn-quiet" data-tw-action="cancel-new-session">Cancel</button><button type="button" class="tw-btn tw-btn-primary" data-tw-action="confirm-new-session" disabled>Create</button></div>
          </div>
        </dialog>
      </div>`;
  }

  private async bootstrap(): Promise<void> {
    this.setBusy(true);
    try {
      const [sessions, recipes] = await Promise.all([
        this.api.listSessions(),
        this.api.listRecipes(),
      ]);
      if (this.disposed) return;
      this.state.sessions = sessions.sessions;
      this.state.recipes = recipes.items;
      this.catalogExpiresAt = recipes.expires_at_ms;
      this.renderSessionList();
      const requestedSession = this.options.initialSessionId
        ? this.state.sessions.find(
            (session) =>
              session.session_id === this.options.initialSessionId?.trim(),
          )
        : null;
      const initial =
        requestedSession ??
        visibleSessions(
          this.state.sessions,
          this.state.sessionFilter,
          this.state.sessionSearch,
        )[0] ??
        this.state.sessions[0] ??
        null;
      if (initial) await this.openSession(initial.session_id);
      else this.renderAll();
    } catch (error) {
      this.report(error);
      this.renderAll();
    } finally {
      this.setBusy(false);
    }
  }

  private async poll(): Promise<void> {
    await Promise.allSettled([
      this.refreshSessions(),
      this.refreshRecipes(),
      this.catchUpTimeline(),
      this.refreshRuntimeDetail(),
      this.refreshReplans(),
    ]);
  }

  private async refreshRecipes(force = false): Promise<void> {
    if (!force && Date.now() < this.catalogExpiresAt - 30_000) return;
    const catalog = await this.api.listRecipes();
    if (this.disposed) return;
    this.state.recipes = catalog.items;
    this.catalogExpiresAt = catalog.expires_at_ms;
    this.renderComposer();
  }

  private async refreshSessions(): Promise<void> {
    const response = await this.api.listSessions();
    if (this.disposed) return;
    this.state.sessions = response.sessions;
    const current = this.state.activeSession;
    if (current) {
      this.state.activeSession =
        response.sessions.find(
          (session) => session.session_id === current.session_id,
        ) ?? current;
    }
    this.renderSessionList();
    this.renderSessionHeader();
    this.renderComposer();
  }

  private async openSession(sessionId: string): Promise<void> {
    const sequence = ++this.openSequence;
    const listed = this.state.sessions.find(
      (session) => session.session_id === sessionId,
    );
    if (listed) this.state.activeSession = listed;
    this.state.timeline = [];
    this.state.timelineCursor = 0;
    this.state.runtimeDetail = null;
    this.state.executionLinks = [];
    this.state.localInteractions = [];
    this.state.replans = [];
    this.renderAll();
    this.setBusy(true);
    try {
      const [detail, timeline, runtime, replans] = await Promise.all([
        this.api.getSession(sessionId),
        this.api.timeline(sessionId, 0),
        this.api.runtimeDetail(sessionId),
        this.api.listReplans(sessionId),
      ]);
      if (this.disposed || sequence !== this.openSequence) return;
      this.state.activeSession = detail.session;
      this.state.executionLinks = detail.execution_links;
      this.state.timeline = mergeTimelineEntries([], timeline.entries);
      this.state.timelineCursor = Math.max(
        timeline.next_session_seq,
        timelineCursor(timeline.entries),
      );
      this.state.timelineSourceState = timeline.source_state;
      this.state.runtimeDetail = runtime;
      this.state.replans = replans.replans;
      const selected = chooseExecution(runtime);
      this.state.selectedWorkflowId = selected.workflowId;
      this.state.selectedRunId = selected.runId;
      this.upsertSession(detail.session);
      this.renderAll(true);
      this.options.onSessionSelected?.({
        format: 'icarus.task-workspace-link/1',
        target: 'session',
        session_id: detail.session.session_id,
      });
    } catch (error) {
      if (sequence === this.openSequence) this.report(error);
    } finally {
      if (sequence === this.openSequence) this.setBusy(false);
    }
  }

  private async catchUpTimeline(): Promise<void> {
    const session = this.state.activeSession;
    if (!session || this.catchingUp || this.disposed) return;
    this.catchingUp = true;
    try {
      const delta = await this.api.timeline(
        session.session_id,
        this.state.timelineCursor,
      );
      if (
        !this.disposed &&
        this.state.activeSession?.session_id === session.session_id
      ) {
        this.applyDelta(delta);
      }
    } catch (error) {
      this.state.timelineSourceState = 'degraded';
      this.renderCursorState();
      throw error;
    } finally {
      this.catchingUp = false;
    }
  }

  private applyDelta(delta: TaskWorkspaceDelta): void {
    const timeline = this.element('[data-role="timeline"]');
    const nearBottom =
      !timeline ||
      timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80;
    this.state.timeline = mergeTimelineEntries(
      this.state.timeline,
      delta.entries,
    );
    this.state.timelineCursor = Math.max(
      this.state.timelineCursor,
      delta.next_session_seq,
      timelineCursor(delta.entries),
    );
    this.state.timelineSourceState = delta.source_state;
    this.renderTimeline(nearBottom);
    this.renderCursorState();
    this.renderInspector();
  }

  private scheduleRuntimeDetail(): void {
    if (this.detailTimer) clearTimeout(this.detailTimer);
    this.detailTimer = setTimeout(() => {
      this.detailTimer = null;
      void this.refreshRuntimeDetail();
    }, 250);
  }

  private async refreshRuntimeDetail(): Promise<void> {
    const sessionId = this.state.activeSession?.session_id;
    if (!sessionId || this.disposed) return;
    const detail = await this.api.runtimeDetail(sessionId);
    if (this.disposed || sessionId !== this.state.activeSession?.session_id) {
      return;
    }
    this.state.runtimeDetail = detail;
    const selected = chooseExecution(
      detail,
      this.state.selectedWorkflowId,
      this.state.selectedRunId,
    );
    this.state.selectedWorkflowId = selected.workflowId;
    this.state.selectedRunId = selected.runId;
    this.renderInspector();
  }

  private async refreshReplans(): Promise<void> {
    const sessionId = this.state.activeSession?.session_id;
    if (!sessionId || this.disposed) return;
    const response = await this.api.listReplans(sessionId);
    if (this.disposed || sessionId !== this.state.activeSession?.session_id) {
      return;
    }
    this.state.replans = response.replans;
    this.renderInspector();
  }

  private renderAll(scrollTimeline = false): void {
    this.renderSessionList();
    this.renderSessionHeader();
    this.renderComposer();
    this.renderTimeline(scrollTimeline);
    this.renderCursorState();
    this.renderInspector();
    this.renderError();
  }

  private renderSessionList(): void {
    const list = this.element('[data-role="session-list"]');
    if (!list) return;
    const sessions = visibleSessions(
      this.state.sessions,
      this.state.sessionFilter,
      this.state.sessionSearch,
    );
    list.innerHTML = sessions.length
      ? sessions
          .map((session) => {
            const active =
              session.session_id === this.state.activeSession?.session_id;
            const attention =
              session.attention_state === 'none'
                ? ''
                : `<span class="tw-attention is-${escapeAttribute(session.attention_state)}">${escapeHtml(readableLabel(session.attention_state))}</span>`;
            return `
              <button type="button" class="tw-session-item ${active ? 'is-active' : ''}" data-tw-action="select-session" data-session-id="${escapeAttribute(session.session_id)}"${active ? ' aria-current="page"' : ''}>
                <span class="tw-session-title">${escapeHtml(session.title)}</span>
                <span class="tw-session-meta">${attention}<time>${escapeHtml(formatTime(session.updated_at_ms))}</time></span>
              </button>`;
          })
          .join('')
      : `<div class="tw-empty tw-empty-compact">No ${escapeHtml(readableLabel(this.state.sessionFilter).toLocaleLowerCase())} tasks</div>`;
    this.options.root
      .querySelectorAll('[data-tw-action="session-filter"]')
      .forEach((button) => {
        const active =
          (button as HTMLElement).dataset.filter === this.state.sessionFilter;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
      });
  }

  private renderSessionHeader(): void {
    const header = this.element('[data-role="session-header"]');
    if (!header) return;
    const session = this.state.activeSession;
    if (!session) {
      header.innerHTML = `
        <div class="tw-session-heading"><h2>No task selected</h2></div>
        <div class="tw-header-actions"><button type="button" class="tw-runtime-toggle" data-tw-action="toggle-inspector" aria-expanded="false"><span class="tw-runtime-toggle-dot" aria-hidden="true"></span>Runtime</button></div>`;
      return;
    }
    const controls =
      session.status === 'open'
        ? `<button type="button" class="tw-btn tw-btn-quiet" data-tw-action="session-status" data-status-action="complete">Complete</button><button type="button" class="tw-btn tw-btn-quiet" data-tw-action="session-status" data-status-action="archive">Archive</button>`
        : session.status === 'archived'
          ? `<button type="button" class="tw-btn tw-btn-quiet" data-tw-action="session-status" data-status-action="reopen">Reopen</button>`
          : `<button type="button" class="tw-btn tw-btn-quiet" data-tw-action="session-status" data-status-action="reopen">Reopen</button><button type="button" class="tw-btn tw-btn-quiet" data-tw-action="session-status" data-status-action="archive">Archive</button>`;
    header.innerHTML = `
      <div class="tw-session-heading"><h2 title="${escapeAttribute(session.title)}">${escapeHtml(session.title)}</h2><span class="tw-status is-${escapeAttribute(session.status)}">${escapeHtml(session.status)}</span></div>
      <div class="tw-header-actions">${controls}<button type="button" class="tw-runtime-toggle" data-tw-action="toggle-inspector" aria-expanded="false"><span class="tw-runtime-toggle-dot" aria-hidden="true"></span>Runtime</button></div>`;
  }

  private selectedRecipe(): RecipeCatalogItem | null {
    const selection = this.state.activeSession?.current_run_selection;
    if (!selection || selection.kind !== 'published_recipe') return null;
    return (
      this.state.recipes.find(
        (recipe) =>
          recipe.recipe_ref.id === selection.recipe_ref.id &&
          recipe.recipe_hash === selection.recipe_hash,
      ) ?? null
    );
  }

  private renderComposer(): void {
    const selector = this.element<HTMLSelectElement>(
      '[data-role="recipe-selector"]',
    );
    if (!selector) return;
    const session = this.state.activeSession;
    const selected = this.selectedRecipe();
    selector.innerHTML = `
      <option value="temporary"${session?.current_run_selection.kind === 'temporary_workflow' ? ' selected' : ''}>Temporary Workflow</option>
      ${this.state.recipes
        .map(
          (recipe) =>
            `<option value="${escapeAttribute(recipe.selection_token)}"${selected?.selection_token === recipe.selection_token ? ' selected' : ''}>${escapeHtml(`${readableLabel(recipe.recipe_kind)} / ${recipe.display_name}`)}</option>`,
        )
        .join('')}`;
    selector.disabled =
      !session || session.status !== 'open' || this.state.busy;
    const input = this.element<HTMLTextAreaElement>(
      '[data-role="composer-input"]',
    );
    if (input) {
      input.disabled = !session || session.status !== 'open' || this.state.busy;
      input.placeholder = session
        ? 'Message or describe a task'
        : 'Select a task';
    }
    this.element('.tw-composer')?.classList.toggle(
      'is-disabled',
      !session || session.status !== 'open',
    );
    this.element('.tw-composer-dock')?.classList.toggle('is-hidden', !session);
    this.syncComposerButtons();
  }

  private renderTimeline(scrollToBottom = false): void {
    const timeline = this.element('[data-role="timeline"]');
    if (!timeline) return;
    if (!this.state.activeSession) {
      timeline.innerHTML =
        '<div class="tw-empty tw-empty-conversation"><strong>No task selected</strong><button type="button" class="tw-btn tw-btn-primary" data-tw-action="new-session">New task</button></div>';
      return;
    }
    timeline.innerHTML = this.state.timeline.length
      ? this.state.timeline
          .map((entry) =>
            renderTimelineEntry(entry, this.resolvedInteraction(entry)),
          )
          .join('')
      : '<div class="tw-empty tw-empty-conversation"><strong>Ready</strong></div>';
    if (scrollToBottom) timeline.scrollTop = timeline.scrollHeight;
  }

  private resolvedInteraction(
    entry: TimelineEntry,
  ): Record<string, unknown> | null {
    if (
      entry.kind !== 'pending_interaction' &&
      entry.payload_json.interaction_kind !== 'temporary_confirmation'
    ) {
      return null;
    }
    const source = normalizeInteraction(entry.payload_json);
    if (source.kind === 'temporary_confirmation' && source.launchIntentId) {
      return resolveTemporaryConfirmation(entry, this.state.timeline);
    }
    if (source.kind === 'runtime_command_confirmation' && source.id) {
      const result = [...this.state.timeline]
        .sort((left, right) => right.session_seq - left.session_seq)
        .find(
          (candidate) =>
            candidate.kind === 'command_result' &&
            candidate.payload_json.proposal_id === source.id,
        );
      if (result) {
        const status = String(result.payload_json.status ?? 'failed');
        return {
          ...entry.payload_json,
          status: status === 'applied' ? 'accepted' : 'denied',
          canonical_result: result.payload_json.receipt ?? {
            command_status: status,
          },
        };
      }
    }
    if (!source.id) return entry.payload_json;
    const latest = [...this.state.timeline]
      .filter(
        (candidate) =>
          candidate.session_seq >= entry.session_seq &&
          candidate.kind === 'pending_interaction' &&
          normalizeInteraction(candidate.payload_json).id === source.id,
      )
      .sort((left, right) => right.session_seq - left.session_seq)[0];
    if (!latest) return entry.payload_json;
    const resolved = normalizeInteraction(latest.payload_json);
    if (resolved.status === 'pending') return entry.payload_json;
    return {
      ...entry.payload_json,
      status: resolved.status,
      canonical_result:
        resolved.result ?? latest.payload_json.payload ?? latest.payload_json,
    };
  }

  private renderCursorState(): void {
    const target = this.element('[data-role="cursor-state"]');
    if (!target) return;
    target.className = `tw-cursor-state is-${this.state.timelineSourceState}`;
    target.textContent =
      this.state.timelineSourceState === 'ready'
        ? `Live / ${this.state.timelineCursor}`
        : this.state.timelineSourceState === 'catching_up'
          ? 'Catching up'
          : 'Timeline degraded';
  }

  private renderInspector(): void {
    const shell = this.element('.tw-shell');
    const content = this.element('[data-role="inspector-content"]');
    const selector = this.element<HTMLSelectElement>(
      '[data-role="execution-selector"]',
    );
    shell?.classList.toggle(
      'is-inspector-collapsed',
      this.state.inspectorCollapsed,
    );
    this.options.root
      .querySelectorAll<HTMLButtonElement>(
        '[data-tw-action="toggle-inspector"]',
      )
      .forEach((button) => {
        const closeControl = button.dataset.inspectorControl === 'close';
        const expanded = !this.state.inspectorCollapsed;
        button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        button.classList.toggle('is-active', expanded && !closeControl);
        button.classList.toggle(
          'has-runtime',
          Boolean(this.state.selectedRunId),
        );
        if (closeControl) return;
        button.title = expanded ? 'Close Runtime' : 'Open Runtime';
        button.setAttribute('aria-label', button.title);
      });
    if (selector) {
      selector.innerHTML =
        renderExecutionOptions(this.state) ||
        '<option value="">No linked Run</option>';
      selector.disabled = !this.state.selectedRunId;
    }
    this.options.root
      .querySelectorAll('[data-tw-action="inspector-tab"]')
      .forEach((button) =>
        button.classList.toggle(
          'is-active',
          (button as HTMLElement).dataset.panel === this.state.inspectorPanel,
        ),
      );
    if (content) content.innerHTML = renderInspectorPanel(this.state);
  }

  private syncComposerButtons(): void {
    const input = this.element<HTMLTextAreaElement>(
      '[data-role="composer-input"]',
    );
    const canSubmit = Boolean(
      input?.value.trim() &&
      this.state.activeSession?.status === 'open' &&
      !this.state.busy,
    );
    this.options.root
      .querySelectorAll<HTMLButtonElement>(
        '[data-tw-action="send"], [data-tw-action="run"]',
      )
      .forEach((button) => {
        button.disabled = !canSubmit;
      });
  }

  private renderError(): void {
    const target = this.element('[data-role="error"]');
    if (target) target.textContent = this.state.error;
  }

  private setBusy(busy: boolean): void {
    this.state.busy = busy;
    this.options.root.classList.toggle('is-busy', busy);
    this.syncComposerButtons();
  }

  private report(error: unknown): void {
    const message =
      error instanceof TaskWorkspaceApiError
        ? `${error.message}${error.retryable ? ' (retryable)' : ''}`
        : error instanceof Error
          ? error.message
          : String(error);
    this.state.error = message;
    this.renderError();
    this.options.showToast?.(message, 3600);
  }

  private clearError(): void {
    this.state.error = '';
    this.renderError();
  }

  private upsertSession(session: TaskSession): void {
    this.state.sessions = [
      session,
      ...this.state.sessions.filter(
        (candidate) => candidate.session_id !== session.session_id,
      ),
    ];
    this.state.activeSession = session;
  }

  private openNewSessionDialog(): void {
    const dialog = this.element<HTMLDialogElement>(
      '[data-role="new-session-dialog"]',
    );
    const input = this.element<HTMLInputElement>(
      '[data-role="new-session-title"]',
    );
    if (!dialog || !input || dialog.open || this.state.busy) return;
    input.value = '';
    const createButton = this.element<HTMLButtonElement>(
      '[data-tw-action="confirm-new-session"]',
    );
    if (createButton) createButton.disabled = true;
    dialog.showModal();
    input.focus();
  }

  private closeNewSessionDialog(force = false): void {
    if (this.state.busy && !force) return;
    this.element<HTMLDialogElement>(
      '[data-role="new-session-dialog"]',
    )?.close();
  }

  private async createSession(): Promise<void> {
    const title = this.element<HTMLInputElement>(
      '[data-role="new-session-title"]',
    )?.value.trim();
    if (!title || this.state.busy) return;
    const createButton = this.element<HTMLButtonElement>(
      '[data-tw-action="confirm-new-session"]',
    );
    if (createButton) createButton.disabled = true;
    this.setBusy(true);
    try {
      const { session } = await this.api.createSession(title);
      this.closeNewSessionDialog(true);
      this.upsertSession(session);
      this.state.sessionFilter = 'active';
      await this.openSession(session.session_id);
    } catch (error) {
      this.report(error);
    } finally {
      this.setBusy(false);
      const dialog = this.element<HTMLDialogElement>(
        '[data-role="new-session-dialog"]',
      );
      if (createButton && dialog?.open) createButton.disabled = false;
    }
  }

  private async selectRecipe(value: string): Promise<void> {
    const session = this.state.activeSession;
    if (!session) return;
    this.setBusy(true);
    try {
      const response = await this.api.setRunSelection(
        session.session_id,
        value === 'temporary'
          ? { kind: 'temporary_workflow' }
          : { kind: 'published_recipe', selection_token: value },
        session.row_version,
      );
      this.upsertSession(response.session);
      this.renderAll();
    } catch (error) {
      this.report(error);
      if (
        error instanceof TaskWorkspaceApiError &&
        error.code === 'selection_stale'
      ) {
        await this.refreshRecipes(true).catch(() => undefined);
      }
      await this.refreshSessions().catch(() => undefined);
      this.renderComposer();
    } finally {
      this.setBusy(false);
    }
  }

  private async submitMessage(action: 'send' | 'run'): Promise<void> {
    const session = this.state.activeSession;
    const input = this.element<HTMLTextAreaElement>(
      '[data-role="composer-input"]',
    );
    const text = input?.value.trim() ?? '';
    if (!session || !text || this.state.busy) return;
    const recipe = this.selectedRecipe();
    this.clearError();
    this.setBusy(true);
    try {
      await this.api.postMessage(session.session_id, action, text, {
        selectionToken: recipe?.selection_token,
        idempotencyKey: idempotencyKey(`task-${action}`),
      });
      if (input) input.value = '';
      await this.catchUpTimeline();
      await this.refreshSessions();
      if (action === 'run') this.scheduleRuntimeDetail();
    } catch (error) {
      this.report(error);
      if (
        error instanceof TaskWorkspaceApiError &&
        error.code === 'selection_stale'
      ) {
        await this.refreshRecipes(true).catch(() => undefined);
      }
    } finally {
      this.setBusy(false);
    }
  }

  private async updateStatus(
    action: 'complete' | 'reopen' | 'archive',
  ): Promise<void> {
    const session = this.state.activeSession;
    if (!session) return;
    const workflow = currentWorkflow(this.state);
    if (
      action !== 'reopen' &&
      workflow &&
      ['active', 'paused'].includes(String(workflow.status)) &&
      !window.confirm(
        'This TaskSession still has an active Workflow. The Runtime will continue unless you control it separately.',
      )
    ) {
      return;
    }
    this.setBusy(true);
    try {
      const response = await this.api.updateSessionStatus(
        session.session_id,
        action,
        session.row_version,
      );
      this.upsertSession(response.session);
      this.renderAll();
    } catch (error) {
      this.report(error);
    } finally {
      this.setBusy(false);
    }
  }

  private interactionPayload(
    identifier: string,
  ): Record<string, unknown> | null {
    const candidates = [
      ...this.state.localInteractions,
      ...this.state.replans.map(replanInteraction),
      ...(this.state.runtimeDetail?.pending_interactions ?? []),
      ...(isRecord(currentWorkflow(this.state)) &&
      Array.isArray(currentWorkflow(this.state)?.pending)
        ? (currentWorkflow(this.state)?.pending as unknown[]).filter(isRecord)
        : []),
      ...this.state.timeline.map((entry) => entry.payload_json),
    ];
    return (
      candidates.find((candidate) => {
        const normalized = normalizeInteraction(candidate);
        return [
          normalized.id,
          normalized.launchIntentId,
          normalized.revisionId,
        ].includes(identifier);
      }) ?? null
    );
  }

  private async submitInteraction(button: HTMLButtonElement): Promise<void> {
    const container = button.closest<HTMLElement>('.tw-interaction');
    if (!container) return;
    const identifier = container.dataset.interactionId ?? '';
    const source = this.interactionPayload(identifier);
    if (!source) return;
    const interaction = normalizeInteraction(source);
    const actionId = button.dataset.interactionAction ?? '';
    if (interaction.kind === 'temporary_confirmation') {
      await this.handleTemporaryInteraction(container, interaction, actionId);
      return;
    }
    if (
      interaction.kind === 'temporary_replan_request' ||
      interaction.kind === 'temporary_replan_confirmation'
    ) {
      await this.handleReplanInteraction(container, interaction, actionId);
      return;
    }
    const action = interaction.actions.find((item) => item.id === actionId);
    const input = container.querySelector<HTMLTextAreaElement>(
      '[data-role="interaction-value"]',
    );
    const payload = action?.payload ?? (input ? { value: input.value } : null);
    this.setBusy(true);
    try {
      await this.api.submitInteraction(interaction.id, {
        interaction_id: interaction.id,
        rendered_snapshot_hash: interaction.snapshotHash,
        action_id: actionId,
        payload_json: payload,
        payload_hash: await calculateInteractionPayloadHash(payload),
        expected_target_row_version: interaction.targetRowVersion,
        idempotency_key: idempotencyKey('interaction'),
      });
      await this.poll();
    } catch (error) {
      this.report(error);
    } finally {
      this.setBusy(false);
    }
  }

  private async handleTemporaryInteraction(
    container: HTMLElement,
    interaction: ReturnType<typeof normalizeInteraction>,
    actionId: string,
  ): Promise<void> {
    if (!interaction.launchIntentId) return;
    this.setBusy(true);
    try {
      const response = await this.api.getLaunchIntent(
        interaction.launchIntentId,
      );
      const launch = isRecord(response.launch_intent)
        ? response.launch_intent
        : response;
      const rowVersion = Number(launch.row_version ?? 0);
      if (actionId === 'confirm-temporary') {
        if (!isCurrentTemporaryRevision(launch, interaction.revisionId)) {
          throw new TaskWorkspaceApiError(
            'revision_stale',
            'This Temporary revision has been replaced. Refreshing the current revision.',
            409,
            false,
          );
        }
        await this.api.confirmTemporary(
          interaction.launchIntentId,
          interaction.revisionId,
          rowVersion,
        );
      } else if (actionId === 'cancel-temporary') {
        await this.api.cancelTemporary(interaction.launchIntentId, rowVersion);
      } else {
        const instruction = container
          .querySelector<HTMLTextAreaElement>('[data-role="interaction-value"]')
          ?.value.trim();
        if (!instruction) throw new Error('Add a revision instruction first.');
        await this.api.reviseTemporary(interaction.launchIntentId, instruction);
      }
      await this.poll();
    } catch (error) {
      this.report(error);
      if (shouldRefreshTemporaryInteraction(error)) {
        await this.catchUpTimeline().catch(() => undefined);
        await this.refreshSessions().catch(() => undefined);
        this.renderTimeline();
      }
    } finally {
      this.setBusy(false);
    }
  }

  private beginReplan(): void {
    const workflow = currentWorkflow(this.state);
    const run = currentRun(this.state);
    const workflowId = workflowIdentity(workflow);
    const runId = String(run?.id ?? '');
    if (!this.state.activeSession || !workflowId || !runId) return;
    this.state.localInteractions = [
      {
        interaction_id: `replan-request:${workflowId}:${runId}`,
        interaction_kind: 'temporary_replan_request',
        title: 'Replan remaining work',
        status: 'pending',
        workflow_id: workflowId,
        run_id: runId,
      },
      ...this.state.localInteractions.filter(
        (item) => item.interaction_kind !== 'temporary_replan_request',
      ),
    ];
    this.state.inspectorPanel = 'pending';
    this.state.inspectorCollapsed = false;
    this.renderInspector();
  }

  private async handleReplanInteraction(
    container: HTMLElement,
    interaction: ReturnType<typeof normalizeInteraction>,
    actionId: string,
  ): Promise<void> {
    const session = this.state.activeSession;
    if (!session) return;
    this.setBusy(true);
    try {
      if (interaction.kind === 'temporary_replan_request') {
        const instruction = container
          .querySelector<HTMLTextAreaElement>('[data-role="interaction-value"]')
          ?.value.trim();
        if (!instruction) throw new Error('Add a replan instruction first.');
        const response = await this.api.createReplan(
          session.session_id,
          String(interaction.raw.workflow_id ?? ''),
          String(interaction.raw.run_id ?? ''),
          instruction,
          idempotencyKey('temporary-replan'),
        );
        const replan = isRecord(response.replan) ? response.replan : response;
        this.state.replans = [
          replan,
          ...this.state.replans.filter(
            (item) => item.replan_id !== replan.replan_id,
          ),
        ];
        this.state.localInteractions = this.state.localInteractions.filter(
          (item) => normalizeInteraction(item).id !== interaction.id,
        );
      } else {
        const replan = isRecord(interaction.raw.replan)
          ? interaction.raw.replan
          : interaction.raw;
        if (actionId === 'confirm-replan') {
          await this.api.confirmReplan(
            String(replan.replan_id ?? interaction.id),
            Number(replan.row_version ?? interaction.targetRowVersion),
            String(replan.proposal_hash ?? interaction.raw.proposal_hash ?? ''),
          );
        } else {
          await this.api.cancelReplan(
            String(replan.replan_id ?? interaction.id),
            Number(replan.row_version ?? interaction.targetRowVersion),
          );
        }
      }
      await this.poll();
    } catch (error) {
      this.report(error);
    } finally {
      this.setBusy(false);
    }
  }

  private async proposeRuntimeCommand(
    action: 'pause' | 'resume' | 'cancel',
  ): Promise<void> {
    const session = this.state.activeSession;
    const workflow = currentWorkflow(this.state);
    const run = currentRun(this.state);
    const workflowId = workflowIdentity(workflow);
    const runId = String(run?.id ?? '');
    const targetRowVersion = Number(run?.row_version ?? 0);
    if (!session || !workflowId || !runId || targetRowVersion < 1) return;
    this.setBusy(true);
    try {
      const response = await this.api.createRuntimeCommandProposal(
        session.session_id,
        workflowId,
        runId,
        action,
        targetRowVersion,
        idempotencyKey(`runtime-command-${action}`),
      );
      const proposal = isRecord(response.proposal)
        ? response.proposal
        : response;
      this.state.localInteractions = [
        {
          interaction_id: String(proposal.proposal_id ?? ''),
          interaction_kind: 'runtime_command_confirmation',
          title: `${readableLabel(action)} Workflow`,
          prompt:
            'Confirm this Runtime command against the latest authoritative state.',
          status: String(proposal.status ?? 'pending'),
          target_row_version: Number(proposal.row_version ?? 0),
          proposal,
          actions: [
            {
              action_id: 'confirm-runtime-command',
              label: `Confirm ${readableLabel(action)}`,
              tone: action === 'cancel' ? 'danger' : 'primary',
            },
          ],
        },
      ];
      this.state.inspectorPanel = 'pending';
      this.renderInspector();
    } catch (error) {
      this.report(error);
    } finally {
      this.setBusy(false);
    }
  }

  private async confirmRuntimeCommand(identifier: string): Promise<void> {
    const source = this.interactionPayload(identifier);
    const proposal =
      source && isRecord(source.proposal) ? source.proposal : source;
    if (!proposal) return;
    this.setBusy(true);
    try {
      await this.api.confirmRuntimeCommand(
        String(proposal.proposal_id),
        Number(proposal.row_version ?? 1),
        String(proposal.proposal_hash ?? ''),
      );
      this.state.localInteractions = this.state.localInteractions.filter(
        (item) => item !== source,
      );
      await this.poll();
    } catch (error) {
      this.report(error);
    } finally {
      this.setBusy(false);
    }
  }

  private readonly onClick = (event: Event): void => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>(
      '[data-tw-action]',
    );
    if (!button || !this.options.root.contains(button)) return;
    const action = button.dataset.twAction;
    if (action === 'new-session') this.openNewSessionDialog();
    else if (action === 'cancel-new-session') this.closeNewSessionDialog();
    else if (action === 'confirm-new-session') void this.createSession();
    else if (action === 'select-session') {
      const sessionId = button.dataset.sessionId;
      if (sessionId) void this.openSession(sessionId);
    } else if (action === 'session-filter') {
      this.state.sessionFilter = button.dataset
        .filter as TaskWorkspaceState['sessionFilter'];
      this.renderSessionList();
    } else if (action === 'send' || action === 'run') {
      void this.submitMessage(action);
    } else if (action === 'toggle-inspector') {
      this.state.inspectorCollapsed = !this.state.inspectorCollapsed;
      this.renderInspector();
    } else if (action === 'inspector-tab') {
      this.state.inspectorPanel = button.dataset
        .panel as TaskWorkspaceState['inspectorPanel'];
      this.state.inspectorCollapsed = false;
      this.renderInspector();
    } else if (action === 'session-status') {
      void this.updateStatus(
        button.dataset.statusAction as 'complete' | 'reopen' | 'archive',
      );
    } else if (action === 'interaction') {
      if (button.dataset.interactionAction === 'confirm-runtime-command') {
        const id =
          button.closest<HTMLElement>('.tw-interaction')?.dataset.interactionId;
        if (id) void this.confirmRuntimeCommand(id);
      } else {
        void this.submitInteraction(button);
      }
    } else if (action === 'runtime-command') {
      void this.proposeRuntimeCommand(
        button.dataset.command as 'pause' | 'resume' | 'cancel',
      );
    } else if (action === 'begin-replan') {
      this.beginReplan();
    } else if (action === 'open-runtime-center') {
      const link = runtimeCenterRunLink(
        this.state.selectedWorkflowId,
        this.state.selectedRunId,
      );
      if (link) this.options.openRuntimeCenter?.(link);
    }
  };

  private readonly onInput = (event: Event): void => {
    const target = event.target as HTMLInputElement | HTMLTextAreaElement;
    if (target.matches('[data-role="session-search"]')) {
      this.state.sessionSearch = target.value;
      this.renderSessionList();
    } else if (target.matches('[data-role="new-session-title"]')) {
      const createButton = this.element<HTMLButtonElement>(
        '[data-tw-action="confirm-new-session"]',
      );
      if (createButton) createButton.disabled = !target.value.trim();
    } else if (target.matches('[data-role="composer-input"]')) {
      this.syncComposerButtons();
      target.style.height = 'auto';
      target.style.height = `${Math.min(target.scrollHeight, 160)}px`;
    }
  };

  private readonly onChange = (event: Event): void => {
    const target = event.target as HTMLSelectElement;
    if (target.matches('[data-role="recipe-selector"]')) {
      void this.selectRecipe(target.value);
    } else if (target.matches('[data-role="execution-selector"]')) {
      const [workflowId, runId] = target.value.split('\n');
      this.state.selectedWorkflowId = workflowId ?? '';
      this.state.selectedRunId = runId ?? '';
      this.renderInspector();
    }
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement;
    if (
      target.matches('[data-role="composer-input"]') &&
      (event.metaKey || event.ctrlKey) &&
      event.key === 'Enter'
    ) {
      event.preventDefault();
      void this.submitMessage(event.shiftKey ? 'run' : 'send');
    } else if (
      target.matches('[data-role="new-session-title"]') &&
      event.key === 'Enter'
    ) {
      event.preventDefault();
      void this.createSession();
    }
  };

  private readonly onVisibilityChange = (): void => {
    if (!document.hidden) void this.poll();
  };

  private element<T extends HTMLElement = HTMLElement>(
    selector: string,
  ): T | null {
    return this.options.root.querySelector<T>(selector);
  }
}
