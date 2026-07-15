// electron/renderer/app.js
var ws = null;
var reconnectTimer = null;
var currentGroupJid = '';
var launchParams = new URLSearchParams(window.location.search);
var initialAssistantTarget = launchParams.get('assistantTarget') || '';
var browserNotificationPermissionRequested = false;
var groups = [];
var messages = [];
var unreadCounts = {};
var replyToMsg = null;
var hasMoreHistory = true;
var loadingHistory = false;
var cmdPaletteIndex = -1;
var multiSelectMode = false;
var selectedMsgIds = new Set();
var pendingFiles = []; // files staged for upload on next send
var pendingFileReferences = []; // agent-visible file paths staged on next send
var pendingCardActions = new Map();
var cardActionSeq = 0;
var modelSyncTimer = null;
var INITIAL_MESSAGE_LIMIT = 100;
var LIVE_MESSAGE_BUFFER_LIMIT = 250;

var mainScreen = document.getElementById('main-screen');
var workspace = document.getElementById('workspace');
var todayPlanScreen = document.getElementById('today-plan-screen');
var assistantScreen = document.getElementById('assistant-screen');
var memoryManagementScreen = document.getElementById(
  'memory-management-screen',
);
var knowledgeManagementScreen = document.getElementById(
  'knowledge-management-screen',
);
var traceMonitorScreen = document.getElementById('trace-monitor-screen');
var featureRuntimeScreen = document.getElementById('feature-runtime-screen');
var featureRuntimeOutlet = document.getElementById('feature-runtime-outlet');
var configurationScreen = document.getElementById('configuration-screen');
var configurationServicesToggle = document.getElementById(
  'configuration-services-toggle',
);
var configurationServiceList = document.getElementById(
  'configuration-service-list',
);
var configurationFeaturesToggle = document.getElementById(
  'configuration-features-toggle',
);
var configurationFeatureList = document.getElementById(
  'configuration-feature-list',
);
var configurationServiceRefreshBtn = document.getElementById(
  'configuration-service-refresh-btn',
);
var configurationServiceAddBtn = document.getElementById(
  'configuration-service-add-btn',
);
var configurationServiceEmpty = document.getElementById(
  'configuration-service-empty',
);
var configurationServiceDetail = document.getElementById(
  'configuration-service-detail',
);
var configurationServiceTitle = document.getElementById(
  'configuration-service-title',
);
var configurationServiceSummary = document.getElementById(
  'configuration-service-summary',
);
var configurationServiceMeta = document.getElementById(
  'configuration-service-meta',
);
var configurationServiceSaveStatus = document.getElementById(
  'configuration-service-save-status',
);
var configurationServiceSaveBtn = document.getElementById(
  'configuration-service-save-btn',
);
var configurationServiceDeleteBtn = document.getElementById(
  'configuration-service-delete-btn',
);
var configurationServicesPathEl = document.getElementById(
  'configuration-services-path',
);
var configurationServiceNameInput = document.getElementById(
  'configuration-service-name-input',
);
var configurationServiceJsonEditor = document.getElementById(
  'configuration-service-json-editor',
);
var configurationServiceJsonFormatBtn = document.getElementById(
  'configuration-service-json-format-btn',
);
var configurationServiceJsonApplyBtn = document.getElementById(
  'configuration-service-json-apply-btn',
);
var configurationFeatureEmpty = document.getElementById(
  'configuration-feature-empty',
);
var configurationFeatureDetail = document.getElementById(
  'configuration-feature-detail',
);
var configurationFeatureTitle = document.getElementById(
  'configuration-feature-title',
);
var configurationFeatureSummary = document.getElementById(
  'configuration-feature-summary',
);
var configurationFeatureMeta = document.getElementById(
  'configuration-feature-meta',
);
var configurationFeatureStatus = document.getElementById(
  'configuration-feature-status',
);
var configurationFeatureToggleBtn = document.getElementById(
  'configuration-feature-toggle-btn',
);
var configurationFeatureDeleteDataBtn = document.getElementById(
  'configuration-feature-delete-data-btn',
);
var configurationFeatureDeleteSummary = document.getElementById(
  'configuration-feature-delete-summary',
);
var configurationFeatureResources = document.getElementById(
  'configuration-feature-resources',
);
var configurationServiceFieldInputs = Array.from(
  document.querySelectorAll('[data-service-config-path]'),
);
var memoryGroupsList = document.getElementById('memory-groups-list');
var memorySearchInput = document.getElementById('memory-search-input');
var memoryStatusFilter = document.getElementById('memory-status-filter');
var memoryDoctorBtn = document.getElementById('memory-doctor-btn');
var memoryMetricsBtn = document.getElementById('memory-metrics-btn');
var memoryCreateBtn = document.getElementById('memory-create-btn');
var memorySearchBtn = document.getElementById('memory-search-btn');
var memoryRefreshBtn = document.getElementById('memory-refresh-btn');
var memoryList = document.getElementById('memory-list');
var memoryEmpty = document.getElementById('memory-empty');
var memoryEditor = document.getElementById('memory-editor');
var memoryEditorTitle = document.getElementById('memory-editor-title');
var memoryLayerSelect = document.getElementById('memory-layer-select');
var memoryTypeSelect = document.getElementById('memory-type-select');
var memoryStatusSelect = document.getElementById('memory-status-select');
var memoryContentInput = document.getElementById('memory-content-input');
var memorySaveBtn = document.getElementById('memory-save-btn');
var memoryCancelBtn = document.getElementById('memory-cancel-btn');
var memoryDoctorPanel = document.getElementById('memory-doctor-panel');
var memoryDoctorSummary = document.getElementById('memory-doctor-summary');
var memoryDoctorLog = document.getElementById('memory-doctor-log');
var memoryDoctorCloseBtn = document.getElementById('memory-doctor-close-btn');
var memoryDuplicatesList = document.getElementById('memory-duplicates-list');
var memoryStaleList = document.getElementById('memory-stale-list');
var memoryConflictsList = document.getElementById('memory-conflicts-list');
var memoryGcDuplicatesBtn = document.getElementById('memory-gc-duplicates-btn');
var memoryGcStaleBtn = document.getElementById('memory-gc-stale-btn');
var memoryModalMask = document.getElementById('memory-modal-mask');
var memoryMetricsModal = document.getElementById('memory-metrics-modal');
var memoryMetricsWindow = document.getElementById('memory-metrics-window');
var memoryMetricsTotal = document.getElementById('memory-metrics-total');
var memoryMetricsList = document.getElementById('memory-metrics-list');
var memoryMetricsCloseBtn = document.getElementById('memory-metrics-close-btn');
var knowledgeMaterialList = document.getElementById('knowledge-material-list');
var knowledgeDraftList = document.getElementById('knowledge-draft-list');
var knowledgePageList = document.getElementById('knowledge-page-list');
var knowledgeJobList = document.getElementById('knowledge-job-list');
var knowledgeJobsPanel = document.getElementById('knowledge-jobs-panel');
var openKnowledgeJobsBtn = document.getElementById('open-knowledge-jobs');
var closeKnowledgeJobsBtn = document.getElementById('close-knowledge-jobs');
var knowledgeJobsTriggerMeta = document.getElementById(
  'knowledge-jobs-trigger-meta',
);
var knowledgeJobsDeleteFinishedBtn = document.getElementById(
  'knowledge-jobs-delete-finished-btn',
);
var knowledgeImportBtn = document.getElementById('knowledge-import-btn');
var knowledgeRefreshBtn = document.getElementById('knowledge-refresh-btn');
var knowledgeClearBtn = document.getElementById('knowledge-clear-btn');
var knowledgeSearchInput = document.getElementById('knowledge-search-input');
var knowledgeSearchBtn = document.getElementById('knowledge-search-btn');
var knowledgeDetailEmpty = document.getElementById('knowledge-detail-empty');
var knowledgeDetail = document.getElementById('knowledge-detail');
var knowledgeDetailTitle = document.getElementById('knowledge-detail-title');
var knowledgeDetailMeta = document.getElementById('knowledge-detail-meta');
var knowledgeDetailActions = document.getElementById(
  'knowledge-detail-actions',
);
var knowledgeDetailContent = document.getElementById(
  'knowledge-detail-content',
);
var knowledgeFileInput = document.getElementById('knowledge-file-input');
var knowledgeSelectionSummary = document.getElementById(
  'knowledge-selection-summary',
);
var knowledgeMaterialFilter = document.getElementById(
  'knowledge-material-filter',
);
var knowledgeDraftStatusFilter = document.getElementById(
  'knowledge-draft-status-filter',
);
var knowledgeDraftSelectionSummary = document.getElementById(
  'knowledge-draft-selection-summary',
);
var knowledgeDraftSelectVisibleBtn = document.getElementById(
  'knowledge-draft-select-visible-btn',
);
var knowledgeDraftClearSelectionBtn = document.getElementById(
  'knowledge-draft-clear-selection-btn',
);
var knowledgeDraftBulkDeleteBtn = document.getElementById(
  'knowledge-draft-bulk-delete-btn',
);
var knowledgePageKindFilter = document.getElementById(
  'knowledge-page-kind-filter',
);
var sidebar = document.getElementById('sidebar');
var sidebarCollapse = document.getElementById('sidebar-collapse');
var primaryNav = document.getElementById('primary-nav');
var componentManagementNavGroup = document.getElementById(
  'component-management-nav-group',
);
var componentManagementNavToggle = document.getElementById(
  'component-management-nav-toggle',
);
var componentManagementNavChildren = document.getElementById(
  'component-management-nav-children',
);
var primaryNavItems = Array.from(
  document.querySelectorAll('.primary-nav-item'),
);
var primaryNavScrollTimer = null;
var componentManagementNavKeys = [
  'assistant',
  'configuration',
  'memory-management',
  'knowledge-management',
];
var componentManagementNavExpanded = true;
var groupsList = document.getElementById('groups-list');
var refreshGroupsBtn = document.getElementById('refresh-groups');
var resetAllSessionsBtn = document.getElementById('reset-all-sessions');
var schedulersPanel = document.getElementById('schedulers-panel');
var schedulersList = document.getElementById('schedulers-list');
var openSchedulersBtn = document.getElementById('open-schedulers');
var closeSchedulersBtn = document.getElementById('close-schedulers');
var deleteAllSchedulersBtn = document.getElementById('delete-all-schedulers');
var agentStatusPanel = document.getElementById('agent-status-panel');
var agentStatusList = document.getElementById('agent-status-list');
var openAgentStatusBtn = document.getElementById('open-agent-status');
var closeAgentStatusBtn = document.getElementById('close-agent-status');
var stoppingAgentIds = new Set();
var stoppingKnowledgeJobIds = new Set();
var traceMonitorList = document.getElementById('trace-monitor-list');
var traceMonitorRefreshBtn = document.getElementById(
  'trace-monitor-refresh-btn',
);
var traceMonitorClearHistoryBtn = document.getElementById(
  'trace-monitor-clear-history-btn',
);
var traceMonitorScopeBtns = Array.from(
  document.querySelectorAll('.trace-monitor-scope-btn'),
);
var traceMonitorFilterToggle = document.getElementById(
  'trace-monitor-filter-toggle',
);
var traceMonitorFilterPanel = document.getElementById(
  'trace-monitor-filter-panel',
);
var traceMonitorDetailEmpty = document.getElementById(
  'trace-monitor-detail-empty',
);
var traceMonitorDetail = document.getElementById('trace-monitor-detail');
var traceMonitorTitle = document.getElementById('trace-monitor-title');
var traceMonitorMeta = document.getElementById('trace-monitor-meta');
var traceMonitorSummary = document.getElementById('trace-monitor-summary');
var traceMonitorTimeline = document.getElementById('trace-monitor-timeline');
var traceMonitorStatusFilter = document.getElementById(
  'trace-monitor-status-filter',
);
var traceMonitorSourceFilter = document.getElementById(
  'trace-monitor-source-filter',
);
var traceMonitorServiceFilter = document.getElementById(
  'trace-monitor-service-filter',
);
var traceMonitorFailureFilter = document.getElementById(
  'trace-monitor-failure-filter',
);
var traceMonitorRoleFilter = document.getElementById(
  'trace-monitor-role-filter',
);
var traceMonitorFilesFilter = document.getElementById(
  'trace-monitor-files-filter',
);
var traceMonitorErrorsFilter = document.getElementById(
  'trace-monitor-errors-filter',
);
var knowledgeImportMenu = null;
var knowledgeImportMenuCloseHandler = null;
var todayPlanRefreshBtn = document.getElementById('today-plan-refresh-btn');
var todayPlanViewHistoryBtn = document.getElementById(
  'today-plan-view-history-btn',
);
var todayPlanContinuePlanBtn = document.getElementById(
  'today-plan-continue-plan-btn',
);
var todayPlanCreateTodayBtn = document.getElementById(
  'today-plan-create-today-btn',
);
var todayPlanTitleEl = document.getElementById('today-plan-title');
var todayPlanPlanStatus = document.getElementById('today-plan-plan-status');
var todayPlanSubtitleEl = document.getElementById('today-plan-subtitle');
var todayPlanHeroMeta = document.getElementById('today-plan-hero-meta');
var todayPlanOverviewSummary = document.getElementById(
  'today-plan-overview-summary',
);
var todayPlanSectionMeta = document.getElementById('today-plan-section-meta');
var todayPlanAddItemBtn = document.getElementById('today-plan-add-item-btn');
var todayPlanSendMailBtn = document.getElementById('today-plan-send-mail-btn');
var todayPlanCompleteBtn = document.getElementById('today-plan-complete-btn');
var todayPlanEmpty = document.getElementById('today-plan-empty');
var todayPlanEmptyCreateBtn = document.getElementById(
  'today-plan-empty-create-btn',
);
var todayPlanEmptyContinueBtn = document.getElementById(
  'today-plan-empty-continue-btn',
);
var todayPlanContent = document.getElementById('today-plan-content');
var todayPlanItems = document.getElementById('today-plan-items');
var todayPlanHistoryModal = document.getElementById('today-plan-history-modal');
var todayPlanHistoryMask = document.getElementById('today-plan-history-mask');
var todayPlanHistoryCloseBtn = document.getElementById(
  'today-plan-history-close-btn',
);
var todayPlanHistoryModalTitle = document.getElementById(
  'today-plan-history-modal-title',
);
var todayPlanHistoryModalSubtitle = document.getElementById(
  'today-plan-history-modal-subtitle',
);
var todayPlanHistoryList = document.getElementById('today-plan-history-list');
var todayPlanCommitModal = document.getElementById('today-plan-commit-modal');
var todayPlanCommitMask = document.getElementById('today-plan-commit-mask');
var todayPlanCommitCloseBtn = document.getElementById(
  'today-plan-commit-close-btn',
);
var todayPlanCommitTitle = document.getElementById('today-plan-commit-title');
var todayPlanCommitMeta = document.getElementById('today-plan-commit-meta');
var todayPlanCommitDiff = document.getElementById('today-plan-commit-diff');
var connectionStatus = document.getElementById('connection-status');
var chatHeader = document.getElementById('chat-header');
var chatGroupName = document.getElementById('chat-group-name');
var chatGroupFolder = document.getElementById('chat-group-folder');
var messagesEl = document.getElementById('messages');
var messagesEmpty = document.getElementById('messages-empty');
var typingIndicator = document.getElementById('typing-indicator');
var inputArea = document.getElementById('input-area');
var messageInput = document.getElementById('message-input');
var sendBtn = document.getElementById('send-btn');
var attachBtn = document.getElementById('attach-btn');
var fileInput = document.getElementById('file-input');
var fileDropZone = document.getElementById('file-drop-zone');
var replyPreview = document.getElementById('reply-preview');
var replyPreviewContent = document.getElementById('reply-preview-content');
var replyPreviewClose = document.getElementById('reply-preview-close');
var pendingFilesEl = document.getElementById('pending-files-preview');
var pendingFilesContent = document.getElementById('pending-files-content');
var pendingFilesClose = document.getElementById('pending-files-close');
var commandPalette = document.getElementById('command-palette');
var mentionPicker = document.getElementById('mention-picker');
var selectModeBtn = document.getElementById('select-mode-btn');
var originalSelectIcon = selectModeBtn.innerHTML; // preserve the original 4-square grid icon
var multiSelectBar = document.getElementById('multi-select-bar');
var selectedCountEl = document.getElementById('selected-count');
var copySelectedBtn = document.getElementById('copy-selected-btn');
var deleteSelectedBtn = document.getElementById('delete-selected-btn');
var cancelSelectBtn = document.getElementById('cancel-select-btn');
var agentStatusInterval = null;
var agentStatusData = [];
var agentRunTraceByGroup = {};
var activePrimaryNavKey =
  initialAssistantTarget === 'assistant'
    ? 'assistant'
    : initialAssistantTarget === 'trace-monitor'
      ? 'trace-monitor'
      : 'agent-groups';
var todayPlanVisible = initialAssistantTarget === 'today-plan';
var todayPlanOverview = null;
var currentTodayPlan = null;
var currentTodayPlanId = '';
var todayPlanPendingPatches = {};
var todayPlanSaveTimers = {};
var todayPlanAssociationOverlay = null;
var todayPlanAssociationState = null;
var todayPlanHistoryModalMode = 'view';
var todayPlanMailSenderName = '';
var todayPlanMailToText = '';
var todayPlanMailCcText = '';
var activeTraceMonitorScope = 'active';
var enabledFeatureRuntimeItems = [];
var featureRendererModules = new Map();
var featureRendererCleanups = new Map();
var mountedFeatureNavKey = '';
var featureRendererMountSeq = 0;
var serviceConfigRegistry = {};
var serviceConfigNames = [];
var currentServiceConfigName = '';
var serviceConfigDraft = null;
var serviceConfigDirty = false;
var serviceConfigRequestSeq = 0;
var serviceConfigFilePath = '';
var serviceConfigSaving = false;
var serviceConfigFieldError = '';
var serviceConfigListExpanded = true;
var configurationMode = 'services';
var featureConfigItems = [];
var currentFeatureConfigId = '';
var featureConfigRequestSeq = 0;
var featureConfigListExpanded = true;
var featureConfigActionBusy = false;
var activeMemoryGroupJid = '';
var memoryEntries = [];
var knowledgeMaterials = [];
var knowledgeDrafts = [];
var knowledgePages = [];
var knowledgeJobs = [];
var knowledgeSelectedMaterialIds = /* @__PURE__ */ new Set();
var knowledgeSelectedDraftIds = /* @__PURE__ */ new Set();
var currentKnowledgeDetail = null;
var currentKnowledgeDraftId = '';
var currentKnowledgePageSlug = '';
var knowledgePollingTimer = null;
var knowledgeMaterialFilterValue = 'all';
var knowledgeDraftStatusFilterValue = 'all';
var knowledgePageKindFilterValue = 'all';
var memoryQueryText = '';
var memoryRequestSeq = 0;
var editingMemoryId = '';
var memoryStatusFilterValue = 'all';
var memoryDoctorReport = null;
var memoryDoctorMap = {};
var memoryMetricsSummary = null;
var assistantRefreshBtn = document.getElementById('assistant-refresh-btn');
var assistantScanBtn = document.getElementById('assistant-scan-btn');
var assistantClearDataBtn = document.getElementById('assistant-clear-data-btn');
var assistantStatusBadge = document.getElementById('assistant-status-badge');
var assistantActiveCount = document.getElementById('assistant-active-count');
var assistantUnreadCount = document.getElementById('assistant-unread-count');
var assistantScanCadence = document.getElementById('assistant-scan-cadence');
var assistantSourceCount = document.getElementById('assistant-source-count');
var assistantSettingsSummary = document.getElementById(
  'assistant-settings-summary',
);
var assistantInboxSummary = document.getElementById('assistant-inbox-summary');
var assistantInboxList = document.getElementById('assistant-inbox-list');
var assistantLogList = document.getElementById('assistant-log-list');
var assistantEnabledToggle = document.getElementById(
  'assistant-enabled-toggle',
);
var assistantScanSchedule = document.getElementById('assistant-scan-schedule');
var assistantLevelSelect = document.getElementById('assistant-level-select');
var assistantScanIntervalInput = document.getElementById(
  'assistant-scan-interval-input',
);
var assistantAutostartToggle = document.getElementById(
  'assistant-autostart-toggle',
);
var assistantAlwaysOnTopToggle = document.getElementById(
  'assistant-always-on-top-toggle',
);
var assistantMovementToggle = document.getElementById(
  'assistant-movement-toggle',
);
var assistantEvolutionSummary = document.getElementById(
  'assistant-evolution-summary',
);
var assistantEvolutionEnabledToggle = document.getElementById(
  'assistant-evolution-enabled-toggle',
);
var assistantEvolutionAutoImplementToggle = document.getElementById(
  'assistant-evolution-auto-implement-toggle',
);
var assistantEvolutionAutoAdoptToggle = document.getElementById(
  'assistant-evolution-auto-adopt-toggle',
);
var assistantEvolutionScanIntervalInput = document.getElementById(
  'assistant-evolution-scan-interval-input',
);
var assistantEvolutionSchedule = document.getElementById(
  'assistant-evolution-schedule',
);
var assistantEvolutionTriggerBtn = document.getElementById(
  'assistant-evolution-trigger-btn',
);
var assistantEvolutionPanel = document.getElementById(
  'assistant-evolution-panel',
);
var assistantSourceGrid = document.getElementById('assistant-source-grid');
var assistantSourceInputs = [];
var assistantServiceInputs = [];
var assistantLookbackInputs = [];
var assistantSourceExpandedGroups = {};
var assistantState = null;
var assistantInboxItems = [];
var assistantActionLogs = [];
var assistantInboxActionPendingItemIds = new Set();
var assistantInboxActionPendingItems = {};
var assistantFlowDetailExpandedItems = {};
var assistantFlowGroupExpandedItems = {};
var assistantLogDetailExpandedItems = {};
var assistantLogDetailExpandedLogs = {};
var assistantEvolutionDetailExpandedItems = {};
var assistantEvolutionDetailLoadingItems = {};
var assistantScanIntervalSaveTimer = null;
var assistantEvolutionScanIntervalSaveTimer = null;
var mentionSearchInput = null;
var mentionOptionsEl = null;
var mentionPickerVisible = false;
var mentionPickerIndex = -1;
var mentionCandidates = [];
var mentionInsertPos = null;
var commandSearchInput = null;
var commandOptionsEl = null;
var commandPickerVisible = false;
var commandCandidates = [];
var commandInsertPos = null;
var traceMonitorActiveRuns = [];
var traceMonitorHistoryRuns = [];
var traceMonitorHistoryOffset = 0;
var traceMonitorHistoryHasMore = false;
var traceMonitorHistoryLoading = false;
var traceMonitorHistoryClearing = false;
var traceMonitorHistoryJustCleared = false;
var currentTraceRunId = '';
var currentTraceRunRecord = null;
var currentTraceRunSteps = [];
var currentTraceRunEvents = [];
var currentTraceRunSummary = null;
var currentTraceRunHighlights = null;
var currentTraceRunScope = 'active';
var traceMonitorDetailReloadTimer = null;
var traceMonitorFilterDebounceTimer = null;
function getDefaultTraceMonitorFilters() {
  return {
    status: '',
    sourceType: '',
    sourceRefId: '',
    service: '',
    failureType: '',
    role: '',
    hasFileChanges: false,
    hasErrors: false,
  };
}
var traceMonitorFilters = getDefaultTraceMonitorFilters();

var TRACE_HISTORY_PAGE_SIZE = 10;

// --- Command palette definitions ---
var commands = [
  { name: '/clear', desc: 'Clear conversation context' },
  { name: '/compact', desc: 'Compact conversation history' },
  { name: '/new', desc: 'Start a fresh session for the next task' },
];

const ASSISTANT_AVATAR = '/assets/avatar-assistant.png';
const MAIN_GROUP_AVATAR = ASSISTANT_AVATAR;
const GROUP_INITIAL_TONES = [
  'tone-ocean',
  'tone-mint',
  'tone-amber',
  'tone-rose',
  'tone-indigo',
  'tone-cyan',
  'tone-slate',
];

function getFixedAvatar(group) {
  if (!group || typeof group.jid !== 'string') return null;
  if (group.isMain) return MAIN_GROUP_AVATAR;
  return null;
}

function getGroupInitial(group) {
  const label = String(
    group?.name || group?.folder || group?.jid || '?',
  ).trim();
  const first = Array.from(label)[0] || '?';
  return first.toUpperCase();
}

function getGroupInitialTone(group) {
  const seed = String(group?.jid || group?.folder || group?.name || '');
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return GROUP_INITIAL_TONES[hash % GROUP_INITIAL_TONES.length];
}

function renderGroupListIcon(group) {
  const avatar = getFixedAvatar(group);
  if (avatar) {
    const alt = `${group?.name || 'Group'} avatar`;
    return `<span class="item-icon item-avatar"><img src="${escapeAttribute(avatar)}" alt="${escapeAttribute(alt)}" /></span>`;
  }
  const initial = getGroupInitial(group);
  const tone = getGroupInitialTone(group);
  return `<span class="item-icon item-initial ${tone}" aria-hidden="true">${escapeHtml(initial)}</span>`;
}

var API_BASE_URL =
  window.location.origin && window.location.origin !== 'null'
    ? window.location.origin
    : 'http://localhost:3000';
var WS_BASE_URL = API_BASE_URL.replace(/^http/i, 'ws');

function apiFetch(path, options) {
  const headers = { 'Content-Type': 'application/json' };
  return fetch(`${API_BASE_URL}${path}`, { ...options, headers });
}

function apiUrl(path) {
  if (!path) return '';
  if (/^(https?:|file:|blob:|data:)/i.test(path)) return path;
  return `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

function encodeApiPathSegments(pathValue) {
  return pathValue
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function workspaceFileApiPath(filePath) {
  if (!filePath) return null;
  const normalizedPath = filePath.replace(/\\/g, '/');
  const webUploadsMarker = '/data/web-uploads/';
  const webUploadsIndex = normalizedPath.lastIndexOf(webUploadsMarker);
  if (webUploadsIndex >= 0) {
    return `/api/uploads/${encodeApiPathSegments(normalizedPath.slice(webUploadsIndex + webUploadsMarker.length))}`;
  }
  const mappings = [['/workspace/uploads/', '/api/uploads/']];
  for (const [prefix, apiPrefix] of mappings) {
    if (normalizedPath.startsWith(prefix)) {
      return `${apiPrefix}${encodeApiPathSegments(normalizedPath.slice(prefix.length))}`;
    }
  }
  if (normalizedPath.startsWith('/workspace/group/') && currentGroupJid) {
    const groupFolder = currentGroupJid.replace('web:', '');
    return `/api/files/${encodeURIComponent(groupFolder)}/${encodeApiPathSegments(normalizedPath.slice('/workspace/group/'.length))}`;
  }
  return null;
}

function containerFilePath(filePath) {
  if (!filePath) return null;
  const normalizedPath = filePath.replace(/\\/g, '/');
  if (
    /^\/workspace\/(group|uploads|attachments|desktop-captures|ai-images)\//.test(
      normalizedPath,
    )
  ) {
    return normalizedPath;
  }

  const sharedMappings = [
    ['/data/web-uploads/', '/workspace/uploads/'],
    ['/data/attachments/', '/workspace/attachments/'],
    ['/data/desktop-captures/', '/workspace/desktop-captures/'],
    ['/data/ai-images/', '/workspace/ai-images/'],
  ];
  for (const [hostMarker, containerPrefix] of sharedMappings) {
    const markerIndex = normalizedPath.lastIndexOf(hostMarker);
    if (markerIndex >= 0) {
      return `${containerPrefix}${normalizedPath.slice(markerIndex + hostMarker.length)}`;
    }
  }

  if (currentGroupJid) {
    const groupFolder = currentGroupJid.replace('web:', '');
    const groupMarker = `/groups/${groupFolder}/`;
    const groupIndex = normalizedPath.lastIndexOf(groupMarker);
    if (groupIndex >= 0) {
      return `/workspace/group/${normalizedPath.slice(groupIndex + groupMarker.length)}`;
    }
  }

  return null;
}

function shouldUseCustomAppDialogs() {
  return typeof window !== 'undefined' && Boolean(window.icarusApp);
}

async function openTextPrompt(message, defaultValue = '', options = {}) {
  const promptFn = shouldUseCustomAppDialogs()
    ? null
    : typeof window.prompt === 'function'
      ? window.prompt.bind(window)
      : null;
  if (promptFn) {
    try {
      return promptFn(message, defaultValue);
    } catch (err) {
      console.warn(
        'window.prompt unavailable, falling back to custom prompt:',
        err,
      );
    }
  }

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'app-prompt-overlay';
    overlay.innerHTML = `
      <div class="app-prompt-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(options.title || '输入')}">
        <div class="app-prompt-title">${escapeHtml(options.title || '请输入内容')}</div>
        <div class="app-prompt-message">${escapeHtml(message)}</div>
        <textarea class="app-prompt-input" rows="${options.multiline ? '5' : '3'}" placeholder="${escapeHtml(options.placeholder || '')}"></textarea>
        <div class="app-prompt-actions">
          <button type="button" class="btn-ghost" data-action="cancel">取消</button>
          <button type="button" class="btn-primary" data-action="confirm">确认</button>
        </div>
      </div>
    `;

    const input = overlay.querySelector('.app-prompt-input');
    const confirmBtn = overlay.querySelector('[data-action="confirm"]');
    const cancelBtn = overlay.querySelector('[data-action="cancel"]');
    let settled = false;

    function cleanup(value) {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(value);
    }

    input.value = defaultValue || '';
    document.body.appendChild(overlay);
    input.focus();
    input.setSelectionRange(0, input.value.length);

    confirmBtn.addEventListener('click', () => cleanup(input.value));
    cancelBtn.addEventListener('click', () => cleanup(null));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) cleanup(null);
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cleanup(null);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        cleanup(input.value);
        return;
      }
      if (!options.multiline && event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        cleanup(input.value);
      }
    });
  });
}

async function openConfirmDialog(message, options = {}) {
  const confirmFn = shouldUseCustomAppDialogs()
    ? null
    : typeof window.confirm === 'function'
      ? window.confirm.bind(window)
      : null;
  if (confirmFn) {
    try {
      return confirmFn(message);
    } catch (err) {
      console.warn(
        'window.confirm unavailable, falling back to custom confirm:',
        err,
      );
    }
  }

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    const dialogClassName = ['app-prompt-dialog', options.dialogClassName]
      .filter(Boolean)
      .join(' ');
    const actionsClassName = ['app-prompt-actions', options.actionsClassName]
      .filter(Boolean)
      .join(' ');
    const cancelButtonClassName = options.cancelButtonClassName || 'btn-ghost';
    const confirmButtonClassName =
      options.confirmButtonClassName || 'btn-primary';
    overlay.className = 'app-prompt-overlay';
    overlay.innerHTML = `
      <div class="${escapeAttribute(dialogClassName)}" role="dialog" aria-modal="true" aria-label="${escapeHtml(options.title || '确认')}">
        <div class="app-prompt-title">${escapeHtml(options.title || '请确认')}</div>
        <div class="app-prompt-message">${escapeHtml(message)}</div>
        <div class="${escapeAttribute(actionsClassName)}">
          <button type="button" class="${escapeAttribute(cancelButtonClassName)}" data-action="cancel">${escapeHtml(options.cancelText || '取消')}</button>
          <button type="button" class="${escapeAttribute(confirmButtonClassName)}" data-action="confirm">${escapeHtml(options.confirmText || '确认')}</button>
        </div>
      </div>
    `;

    const confirmBtn = overlay.querySelector('[data-action="confirm"]');
    const cancelBtn = overlay.querySelector('[data-action="cancel"]');
    let settled = false;

    function cleanup(value) {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(value);
    }

    document.body.appendChild(overlay);
    confirmBtn.focus();

    confirmBtn.addEventListener('click', () => cleanup(true));
    cancelBtn.addEventListener('click', () => cleanup(false));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) cleanup(false);
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cleanup(false);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        cleanup(true);
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        cleanup(true);
      }
    });
  });
}

function formatTodayPlanMailRecipients(values) {
  return Array.isArray(values) && values.length > 0 ? values.join(', ') : '无';
}

function parseTodayPlanMailRecipientsInput(value) {
  return String(value || '')
    .split(/[\n,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function renderTodayPlanMailDialogStatusMarkup(message, tone = 'pending') {
  if (!message) return '';
  const toneClass = tone === 'error' ? 'is-error' : 'is-pending';
  const role = tone === 'error' ? 'alert' : 'status';
  return `<div class="today-plan-mail-dialog-status ${toneClass}" role="${role}">${escapeHtml(message)}</div>`;
}

async function openTodayPlanMailSendDialog(values = {}, options = {}) {
  const prepareDraft =
    typeof options.prepareDraft === 'function' ? options.prepareDraft : null;
  const confirmDraft =
    typeof options.confirmDraft === 'function' ? options.confirmDraft : null;
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'app-prompt-overlay';
    const state = {
      step: 'compose',
      busy: false,
      statusMessage: '',
      errorMessage: '',
      values: {
        name: String(values.name || '').trim(),
        to: String(values.to || '').trim(),
        cc: String(values.cc || '').trim(),
      },
      draft: null,
    };
    let settled = false;

    function cleanup(value) {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(value);
    }

    function readComposeInputs() {
      const nameInput = overlay.querySelector('[data-field="name"]');
      const toInput = overlay.querySelector('[data-field="to"]');
      const ccInput = overlay.querySelector('[data-field="cc"]');
      return { nameInput, toInput, ccInput };
    }

    function syncComposeValues() {
      const { nameInput, toInput, ccInput } = readComposeInputs();
      state.values = {
        name: String(
          nameInput && nameInput.value ? nameInput.value : '',
        ).trim(),
        to: String(toInput && toInput.value ? toInput.value : '').trim(),
        cc: String(ccInput && ccInput.value ? ccInput.value : '').trim(),
      };
      return { nameInput };
    }

    function syncPreviewValues() {
      if (!state.draft) return {};
      const bodyInput = overlay.querySelector('[data-preview-field="body"]');
      state.draft = {
        ...state.draft,
        body: String(
          bodyInput && bodyInput.value ? bodyInput.value : '',
        ).replace(/\r\n/g, '\n'),
      };
      return { bodyInput };
    }

    async function submitCompose() {
      if (state.busy) return;
      const { nameInput } = syncComposeValues();
      if (!state.values.name) {
        alert('请输入姓名');
        if (nameInput) nameInput.focus();
        return;
      }
      if (!prepareDraft) {
        cleanup({ formData: { ...state.values }, draft: null });
        return;
      }
      state.busy = true;
      state.errorMessage = '';
      state.statusMessage = '正在生成预览，请稍候...';
      render();
      try {
        const draft = await prepareDraft({ ...state.values });
        if (!draft || !draft.id) throw new Error('未生成待发送草稿');
        state.draft = draft;
        state.step = 'preview';
        state.busy = false;
        state.statusMessage = '';
        state.errorMessage = '';
        render();
      } catch (err) {
        state.busy = false;
        state.statusMessage = '';
        state.errorMessage = err instanceof Error ? err.message : String(err);
        render();
      }
    }

    async function submitConfirm() {
      if (state.busy || !state.draft) return;
      syncPreviewValues();
      if (!confirmDraft) {
        cleanup({ formData: { ...state.values }, draft: state.draft });
        return;
      }
      state.busy = true;
      state.errorMessage = '';
      state.statusMessage = '正在发送邮件，请稍候...';
      render();
      try {
        const sentDraft = await confirmDraft(state.draft);
        cleanup({
          formData: { ...state.values },
          draft: sentDraft || state.draft,
        });
      } catch (err) {
        state.busy = false;
        state.statusMessage = '';
        state.errorMessage = err instanceof Error ? err.message : String(err);
        render();
      }
    }

    function renderCompose() {
      const statusMarkup = state.errorMessage
        ? renderTodayPlanMailDialogStatusMarkup(state.errorMessage, 'error')
        : renderTodayPlanMailDialogStatusMarkup(state.statusMessage, 'pending');
      overlay.innerHTML = `
        <div class="app-prompt-dialog today-plan-mail-compose-dialog" role="dialog" aria-modal="true" aria-label="填写计划邮件信息">
          <div class="app-prompt-title">填写计划邮件信息</div>
          <div class="app-prompt-message"><code>name</code> 为必填。<code>收件人</code>、<code>抄送人</code> 可选，留空时分别读取邮件配置中的默认值。</div>
          ${statusMarkup}
          <div class="today-plan-mail-compose-grid${state.busy ? ' is-busy' : ''}">
            <label class="today-plan-mail-compose-field">
              <span class="today-plan-mail-compose-label">姓名</span>
              <input class="today-plan-mail-compose-input" data-field="name" type="text" placeholder="例如：张頔" value="${escapeAttribute(state.values.name || '')}" ${state.busy ? 'disabled' : ''} />
            </label>
            <label class="today-plan-mail-compose-field">
              <span class="today-plan-mail-compose-label">收件人</span>
              <textarea class="app-prompt-input today-plan-mail-compose-textarea" data-field="to" rows="3" placeholder="多个地址用逗号或换行分隔；留空时使用配置默认值" ${state.busy ? 'disabled' : ''}>${escapeHtml(state.values.to || '')}</textarea>
            </label>
            <label class="today-plan-mail-compose-field">
              <span class="today-plan-mail-compose-label">抄送人</span>
              <textarea class="app-prompt-input today-plan-mail-compose-textarea" data-field="cc" rows="3" placeholder="多个地址用逗号或换行分隔；留空时使用配置默认值" ${state.busy ? 'disabled' : ''}>${escapeHtml(state.values.cc || '')}</textarea>
            </label>
          </div>
          <div class="app-prompt-actions today-plan-mail-dialog-actions">
            <button type="button" class="btn-primary btn-soft-primary today-plan-action-btn today-plan-btn-view today-plan-mail-dialog-secondary-btn" data-action="cancel" ${state.busy ? 'disabled' : ''}>取消</button>
            <button type="button" class="btn-primary btn-soft-primary today-plan-action-btn today-plan-btn-create today-plan-mail-dialog-primary-btn" data-action="confirm" ${state.busy ? 'disabled' : ''}>${state.busy ? '生成中...' : '生成预览'}</button>
          </div>
        </div>
      `;

      const { nameInput } = readComposeInputs();
      const confirmBtn = overlay.querySelector('[data-action="confirm"]');
      const cancelBtn = overlay.querySelector('[data-action="cancel"]');
      if (!state.busy && nameInput) {
        nameInput.focus();
        nameInput.setSelectionRange(0, nameInput.value.length);
      }
      if (confirmBtn) {
        confirmBtn.addEventListener('click', () => {
          void submitCompose();
        });
      }
      if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
          if (state.busy) return;
          cleanup(null);
        });
      }
    }

    function renderPreview() {
      const draft = state.draft || {};
      const statusMarkup = state.errorMessage
        ? renderTodayPlanMailDialogStatusMarkup(state.errorMessage, 'error')
        : renderTodayPlanMailDialogStatusMarkup(state.statusMessage, 'pending');
      overlay.innerHTML = `
        <div class="app-prompt-dialog today-plan-mail-preview-dialog" role="dialog" aria-modal="true" aria-label="确认发送计划邮件">
          <div class="app-prompt-title">确认发送计划邮件</div>
          <div class="app-prompt-message">预览已生成，可直接修改正文；确认后按当前内容发送。</div>
          ${statusMarkup}
          <div class="today-plan-mail-preview-grid">
            <div class="today-plan-mail-preview-item">
              <div class="today-plan-mail-preview-label">主题</div>
              <div class="today-plan-mail-preview-value">${escapeHtml(draft.subject || '--')}</div>
            </div>
            <div class="today-plan-mail-preview-item">
              <div class="today-plan-mail-preview-label">收件人</div>
              <div class="today-plan-mail-preview-value">${escapeHtml(formatTodayPlanMailRecipients(draft.to))}</div>
            </div>
            <div class="today-plan-mail-preview-item">
              <div class="today-plan-mail-preview-label">抄送</div>
              <div class="today-plan-mail-preview-value">${escapeHtml(formatTodayPlanMailRecipients(draft.cc))}</div>
            </div>
            <div class="today-plan-mail-preview-item">
              <div class="today-plan-mail-preview-label">密送</div>
              <div class="today-plan-mail-preview-value">${escapeHtml(formatTodayPlanMailRecipients(draft.bcc))}</div>
            </div>
          </div>
          <label class="today-plan-mail-preview-label today-plan-mail-preview-body-label" for="today-plan-mail-preview-body">正文</label>
          <textarea id="today-plan-mail-preview-body" class="app-prompt-input today-plan-mail-preview-body" data-preview-field="body" ${state.busy ? 'disabled' : ''}></textarea>
          <div class="app-prompt-actions today-plan-mail-dialog-actions">
            <button type="button" class="btn-primary btn-soft-primary today-plan-action-btn today-plan-btn-view today-plan-mail-dialog-secondary-btn" data-action="back" ${state.busy ? 'disabled' : ''}>返回修改</button>
            <button type="button" class="btn-primary btn-soft-primary today-plan-action-btn today-plan-btn-send today-plan-mail-dialog-primary-btn" data-action="confirm" ${state.busy ? 'disabled' : ''}>${state.busy ? '发送中...' : '确认发送'}</button>
          </div>
        </div>
      `;

      const bodyInput = overlay.querySelector('[data-preview-field="body"]');
      const confirmBtn = overlay.querySelector('[data-action="confirm"]');
      const backBtn = overlay.querySelector('[data-action="back"]');
      if (!state.busy && bodyInput) {
        bodyInput.focus();
        bodyInput.setSelectionRange(
          bodyInput.value.length,
          bodyInput.value.length,
        );
      } else if (!state.busy && confirmBtn) {
        confirmBtn.focus();
      }
      if (backBtn) {
        backBtn.addEventListener('click', () => {
          if (state.busy) return;
          syncPreviewValues();
          state.step = 'compose';
          state.statusMessage = '';
          state.errorMessage = '';
          render();
        });
      }
      if (confirmBtn) {
        confirmBtn.addEventListener('click', () => {
          void submitConfirm();
        });
      }
      if (bodyInput) bodyInput.value = draft.body || '';
    }

    function render() {
      if (state.step === 'preview') {
        renderPreview();
        return;
      }
      renderCompose();
    }

    document.body.appendChild(overlay);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay && !state.busy) cleanup(null);
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (state.busy) return;
        event.preventDefault();
        cleanup(null);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        if (state.step === 'preview') {
          void submitConfirm();
          return;
        }
        void submitCompose();
      }
    });
    render();
  });
}

function formatTime(ts) {
  const d = new Date(parseInt(ts));
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (isToday) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const pad = (value) => String(value).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatMessageTimeTitle(ts) {
  const parsedMs = parseTimestamp(ts);
  if (!Number.isFinite(parsedMs) || parsedMs <= 0) return '';
  return new Date(parsedMs).toLocaleString();
}

function formatMessageDatetime(ts) {
  const parsedMs = parseTimestamp(ts);
  if (!Number.isFinite(parsedMs) || parsedMs <= 0) return '';
  return new Date(parsedMs).toISOString();
}

function getMessageSenderDisplayName(msg, fallback) {
  const raw = String(msg?.sender_name || msg?.sender || fallback || '').trim();
  if (msg?.is_from_me && /^(you|me|web user|desktop user|web_user)$/i.test(raw))
    return '你';
  if (!raw) return msg?.is_from_me ? '你' : 'Assistant';
  if (/^assistant$/i.test(raw)) return 'Assistant';
  return raw;
}

function getMessageKindInfo(msg, kindOverride) {
  if (kindOverride === 'card')
    return { label: '卡片', className: 'msg-role-card' };
  if (kindOverride === 'file' || msg?._filePath)
    return { label: '附件', className: 'msg-role-file' };
  if (msg?.is_from_me) return { label: '用户', className: 'msg-role-user' };
  if (
    msg?.is_bot_message ||
    /assistant|agent|bot/i.test(String(msg?.sender || msg?.sender_name || ''))
  ) {
    return { label: 'Agent', className: 'msg-role-agent' };
  }
  return { label: '成员', className: 'msg-role-member' };
}

function renderMessageHeaderHtml(msg, options = {}) {
  const senderName = getMessageSenderDisplayName(
    msg,
    options.fallbackSenderName,
  );
  const kindInfo = getMessageKindInfo(msg, options.kind);
  const showSender = kindInfo.label !== '用户' && kindInfo.label !== 'Agent';
  const timeText = formatTime(msg?.timestamp);
  const timeTitle = formatMessageTimeTitle(msg?.timestamp);
  const datetime = formatMessageDatetime(msg?.timestamp);
  return `
    <div class="msg-header">
      <span class="msg-role ${escapeAttribute(kindInfo.className)}">${escapeHtml(kindInfo.label)}</span>
      ${showSender ? `<span class="msg-sender">${escapeHtml(senderName)}</span>` : ''}
      <time class="msg-time" datetime="${escapeAttribute(datetime)}" title="${escapeAttribute(timeTitle)}">${escapeHtml(timeText)}</time>
    </div>
  `;
}

function parseMessageAttachmentReferences(content) {
  const lines = String(content || '').split(/\r?\n/);
  const paths = [];
  const visibleLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '【附件】') continue;
    const pathMatch = line.match(/^\s*文件地址:\s*(.+?)\s*$/);
    if (pathMatch) {
      paths.push(pathMatch[1]);
      continue;
    }
    visibleLines.push(line);
  }

  while (visibleLines.length > 0 && visibleLines[0].trim() === '')
    visibleLines.shift();
  while (
    visibleLines.length > 0 &&
    visibleLines[visibleLines.length - 1].trim() === ''
  )
    visibleLines.pop();

  return { content: visibleLines.join('\n'), paths };
}

function createFileInfoFromPath(filePath) {
  const filename =
    String(filePath || '')
      .split('/')
      .pop() || String(filePath || '附件');
  const ext = filename.includes('.')
    ? filename.split('.').pop().toLowerCase()
    : '';
  return { filename, ext, filePath };
}

function getMessagePreviewText(msg) {
  const parsed = parseMessageAttachmentReferences(msg?.content || '');
  const text = parsed.content.replace(/\s+/g, ' ').trim();
  if (text) return text.slice(0, 80);
  if (msg?._filePath) return msg._filePath.split('/').pop() || '附件';
  if (parsed.paths.length > 0) {
    return parsed.paths
      .map((path) => path.split('/').pop() || path)
      .join(', ')
      .slice(0, 80);
  }
  return (
    String(msg?.content || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || '消息'
  );
}

function renderPlainMessageContent(text) {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

function renderMessageActionsHtml(options = {}) {
  const copyEnabled = options.copy !== false;
  return `
    <div class="msg-actions">
      ${copyEnabled ? '<button class="msg-copy-btn" title="\\u590D\\u5236"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>' : ''}
      <button class="msg-reply-btn" title="Reply"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg></button>
    </div>
  `;
}

function attachMessageInteractions(el, msg, options = {}) {
  const replyBtn = el.querySelector('.msg-reply-btn');
  if (replyBtn) {
    replyBtn.addEventListener('click', () => setReplyTo(msg));
  }

  const copyBtn = el.querySelector('.msg-copy-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => copyMessageContent(msg));
  }

  if (options.addCopyButtons !== false) {
    addCopyButtons(el);
  }

  el.addEventListener('click', (e) => {
    if (!multiSelectMode) return;
    if (e.target.closest('.msg-actions')) return;
    e.preventDefault();
    toggleMessageSelection(msg.id, el);
  });
}
// --- SVG Icon helpers ---
const SVG = {
  trash:
    '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>',
  pause:
    '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" y1="4" x2="10" y2="20"></line><line x1="14" y1="4" x2="14" y2="20"></line></svg>',
  play: '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>',
  file: '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>',
  pdf: '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>',
  paperclip:
    '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>',
  stop: '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>',
  checkSquare:
    '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>',
  square:
    '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>',
  refresh:
    '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>',
};

function iconBtnHTML(iconSvg, extraClass) {
  return `<button class="icon-btn-sm${extraClass ? ' ' + extraClass : ''}">${iconSvg}</button>`;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function renderMarkdown(text) {
  if (typeof marked === 'undefined') return escapeHtml(text);
  try {
    marked.setOptions({
      breaks: true,
      gfm: true,
      highlight: (code, lang) => {
        if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
          try {
            return hljs.highlight(code, { language: lang }).value;
          } catch {
            return code;
          }
        }
        return code;
      },
    });
    return marked.parse(text);
  } catch {
    return escapeHtml(text);
  }
}

// --- Code block copy buttons ---
function addCopyButtons(container) {
  const pres = container.querySelectorAll('pre');
  pres.forEach((pre) => {
    if (
      pre.parentElement &&
      pre.parentElement.classList.contains('code-block-wrapper')
    )
      return;
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block-wrapper';
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);

    const btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.textContent = 'Copy';
    btn.addEventListener('click', () => {
      const code = pre.textContent || '';
      navigator.clipboard.writeText(code).then(() => {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = 'Copy';
          btn.classList.remove('copied');
        }, 2000);
      });
    });
    wrapper.appendChild(btn);
  });
}

// --- File preview rendering ---
var IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'];
var PDF_EXTS = ['pdf'];

function renderFilePreview(filename, ext, filePath, fileUrl = null) {
  const div = document.createElement('div');
  div.className = 'file-preview';
  const workspaceApiPath = workspaceFileApiPath(filePath);
  const previewUrl = fileUrl
    ? apiUrl(fileUrl)
    : workspaceApiPath
      ? apiUrl(workspaceApiPath)
      : filePath
        ? `file://${filePath}`
        : apiUrl(`/api/uploads/${encodeURIComponent(filename)}`);

  if (IMAGE_EXTS.includes(ext)) {
    const img = document.createElement('img');
    img.className = 'file-preview-image';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = previewUrl;
    img.alt = filename;
    img.addEventListener('click', () => openLightbox(img.src));
    div.appendChild(img);
  } else {
    const icon = document.createElement('span');
    icon.className = 'file-preview-icon';
    icon.innerHTML = PDF_EXTS.includes(ext) ? SVG.pdf : SVG.file;
    div.appendChild(icon);

    // "打开文件" button
    if (filePath && !fileUrl && !workspaceApiPath) {
      const btn = document.createElement('button');
      btn.className = 'file-open-btn';
      btn.innerHTML = `${SVG.paperclip} ${escapeHtml(filename)}`;
      btn.addEventListener('click', () => {
        if (window.icarusApp?.openFile) {
          window.icarusApp.openFile(filePath);
        } else {
          window.open(`file://${filePath}`);
        }
      });
      div.appendChild(btn);
    } else {
      const info = document.createElement('div');
      info.className = 'file-preview-info';
      const link = document.createElement('a');
      link.className = 'file-preview-name';
      link.href = previewUrl;
      link.target = '_blank';
      link.textContent = filename;
      info.appendChild(link);
      div.appendChild(info);
    }
  }
  return div;
}

function openLightbox(src) {
  const overlay = document.createElement('div');
  overlay.className = 'lightbox-overlay';
  const img = document.createElement('img');
  img.src = src;
  overlay.appendChild(img);
  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}

// --- Interactive card detection & rendering ---
function isCardMessage(msg) {
  if (!msg.content || !msg.is_bot_message) return false;
  try {
    const parsed = JSON.parse(msg.content);
    return parsed._type === 'card' && parsed.card;
  } catch {
    return false;
  }
}

function parseCardContent(msg) {
  try {
    return JSON.parse(msg.content).card;
  } catch {
    return null;
  }
}

function lockCardInteraction(container, pendingLabel) {
  if (!container || container.dataset.locked === '1') return;
  container.dataset.locked = '1';
  container.classList.add('card-locked');
  const controls = container.querySelectorAll(
    'button, input, select, textarea',
  );
  controls.forEach((el) => {
    el.disabled = true;
  });
  if (pendingLabel) {
    const status = document.createElement('div');
    status.className = 'card-submit-status';
    status.textContent = pendingLabel;
    container.appendChild(status);
  }
}

function unlockCardInteraction(container) {
  if (!container) return;
  container.dataset.locked = '0';
  container.classList.remove('card-locked');
  const controls = container.querySelectorAll(
    'button, input, select, textarea',
  );
  controls.forEach((el) => {
    el.disabled = false;
  });
  container
    .querySelectorAll('.card-submit-status')
    .forEach((el) => el.remove());
}

function isCardAllowedOnWeb(card) {
  const channels = Array.isArray(card?.allowed_channels)
    ? card.allowed_channels
    : [];
  return channels.length === 0 || channels.includes('web');
}

function getCardChannelNotice(card) {
  if (isCardAllowedOnWeb(card)) return '';
  const channels = Array.isArray(card?.allowed_channels)
    ? card.allowed_channels.join(', ')
    : '';
  return channels
    ? `该操作不支持 Web 渠道，可用渠道：${channels}`
    : '该操作不支持 Web 渠道';
}

function validateCardFormField(input, value) {
  const text = String(value || '').trim();
  const label = input.placeholder || input.name;

  if (input.type === 'multi_select') {
    let selectedCount = 0;
    try {
      const parsed = JSON.parse(text || '[]');
      selectedCount = Array.isArray(parsed) ? parsed.filter(Boolean).length : 0;
    } catch {
      selectedCount = text
        ? text
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean).length
        : 0;
    }
    if (input.required && selectedCount === 0) return `${label} 为必填项`;
    return null;
  }

  if (input.required && !text) return `${label} 为必填项`;
  if (!text) return null;

  if (input.type === 'integer') {
    if (!/^[-+]?\d+$/.test(text)) return `${label} 必须是整数`;
    const n = Number.parseInt(text, 10);
    if (typeof input.min === 'number' && n < input.min)
      return `${label} 不能小于 ${input.min}`;
    if (typeof input.max === 'number' && n > input.max)
      return `${label} 不能大于 ${input.max}`;
  }
  if (input.type === 'number') {
    const n = Number(text);
    if (Number.isNaN(n)) return `${label} 必须是数字`;
    if (typeof input.min === 'number' && n < input.min)
      return `${label} 不能小于 ${input.min}`;
    if (typeof input.max === 'number' && n > input.max)
      return `${label} 不能大于 ${input.max}`;
  }
  if (typeof input.min_length === 'number' && text.length < input.min_length) {
    return `${label} 长度不能少于 ${input.min_length}`;
  }
  if (typeof input.max_length === 'number' && text.length > input.max_length) {
    return `${label} 长度不能超过 ${input.max_length}`;
  }
  if (input.format === 'email') {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!re.test(text)) return `${label} 不是有效邮箱`;
  }
  if (input.format === 'uri') {
    try {
      new URL(text);
    } catch {
      return `${label} 不是有效链接`;
    }
  }
  if (input.format === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text))
      return `${label} 日期格式应为 YYYY-MM-DD`;
  }
  if (input.format === 'date-time') {
    if (Number.isNaN(new Date(text).getTime())) return `${label} 时间格式无效`;
  }

  return null;
}

function renderInteractiveCard(card, callbacks = {}) {
  const container = document.createElement('div');
  container.className = 'interactive-card';
  if (callbacks.cardId)
    container.setAttribute('data-card-id', callbacks.cardId);
  const onAction =
    typeof callbacks.onAction === 'function' ? callbacks.onAction : () => {};
  const pendingLabel = callbacks.pendingLabel || '已提交，处理中...';
  const formPendingLabel =
    callbacks.formPendingLabel || '表单已提交，处理中...';
  const lockOnAction = callbacks.lockOnAction !== false;
  const uploadJid = callbacks.uploadJid || currentGroupJid || 'web:main';
  const channelNotice = getCardChannelNotice(card);
  const disabledByChannel = Boolean(channelNotice);

  const runAction = async (value, formValue, pendingText) => {
    if (container.dataset.locked === '1') return;
    if (disabledByChannel) {
      const formError = container.querySelector('.card-form-error');
      if (formError) {
        formError.textContent = channelNotice;
        formError.classList.remove('hidden');
      } else {
        showToast(channelNotice, 2200);
      }
      return;
    }
    if (lockOnAction) lockCardInteraction(container, pendingText);
    try {
      await onAction(value, formValue);
    } catch (err) {
      if (lockOnAction) unlockCardInteraction(container);
      const message = err instanceof Error ? err.message : '操作提交失败';
      const formError = container.querySelector('.card-form-error');
      if (formError) {
        formError.textContent = message;
        formError.classList.remove('hidden');
      } else {
        showToast(message, 2200);
      }
    }
  };

  // Header
  const header = document.createElement('div');
  const color = card.header.color || 'blue';
  header.className = `card-header card-color-${color}`;
  header.textContent = card.header.title;
  container.appendChild(header);

  // Body
  if (card.body) {
    const body = document.createElement('div');
    body.className = 'card-body';
    body.innerHTML = renderMarkdown(card.body);
    container.appendChild(body);
  }
  if (channelNotice) {
    const notice = document.createElement('div');
    notice.className = 'card-channel-notice';
    notice.textContent = channelNotice;
    container.appendChild(notice);
  }

  // Buttons
  if (card.buttons && card.buttons.length > 0) {
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    for (const btn of card.buttons) {
      const button = document.createElement('button');
      button.className = `card-btn card-btn-${btn.type || 'default'}`;
      button.textContent = btn.label;
      if (btn.disabled || disabledByChannel) {
        button.disabled = true;
        button.title = btn.disabledReason || channelNotice || '';
      }
      button.addEventListener('click', () => {
        runAction(btn.value, undefined, pendingLabel);
      });
      actions.appendChild(button);
    }
    container.appendChild(actions);
  }

  // Sections
  if (card.sections) {
    for (let i = 0; i < card.sections.length; i++) {
      const section = card.sections[i];
      const sectionEl = document.createElement('div');
      sectionEl.className = 'card-section';

      const bodyEl = document.createElement('div');
      bodyEl.className = 'card-body';
      bodyEl.innerHTML = renderMarkdown(section.body);
      sectionEl.appendChild(bodyEl);

      if (section.buttons && section.buttons.length > 0) {
        const actions = document.createElement('div');
        actions.className = 'card-actions';
        for (const btn of section.buttons) {
          const button = document.createElement('button');
          button.className = `card-btn card-btn-${btn.type || 'default'}`;
          button.textContent = btn.label;
          if (btn.disabled || disabledByChannel) {
            button.disabled = true;
            button.title = btn.disabledReason || channelNotice || '';
          }
          button.addEventListener('click', () => {
            runAction(btn.value, undefined, pendingLabel);
          });
          actions.appendChild(button);
        }
        sectionEl.appendChild(actions);
      }

      container.appendChild(sectionEl);
      if (i < card.sections.length - 1) {
        const hr = document.createElement('hr');
        hr.className = 'card-divider';
        container.appendChild(hr);
      }
    }
  }

  // Form
  if (card.form) {
    const formEl = document.createElement('div');
    formEl.className = 'card-form';
    const formError = document.createElement('div');
    formError.className = 'card-form-error hidden';
    formEl.appendChild(formError);

    const formInputs = {};
    const clearInputErrors = () => {
      for (const item of Object.values(formInputs)) {
        if (item.errorEl) item.errorEl.remove();
        if (item.container)
          item.container.classList.remove('card-input-invalid');
      }
    };

    const addInputError = (item, message) => {
      if (!item || !message) return;
      if (item.errorEl) item.errorEl.remove();
      if (item.container) item.container.classList.add('card-input-invalid');
      const errEl = document.createElement('div');
      errEl.className = 'card-input-error';
      errEl.textContent = message;
      item.errorEl = errEl;
      formEl.appendChild(errEl);
    };

    for (const input of card.form.inputs) {
      if (
        (input.type === 'enum' || input.type === 'multi_select') &&
        Array.isArray(input.options) &&
        input.options.length > 0
      ) {
        const selectEl = document.createElement('select');
        selectEl.className = 'card-input';
        selectEl.name = input.name;
        if (input.type === 'multi_select') {
          selectEl.multiple = true;
          selectEl.size = Math.min(Math.max(input.options.length, 3), 8);
        }
        const emptyOpt = document.createElement('option');
        emptyOpt.value = '';
        emptyOpt.textContent = input.placeholder || '请选择';
        if (input.type !== 'multi_select') selectEl.appendChild(emptyOpt);
        for (const opt of input.options) {
          const optEl = document.createElement('option');
          optEl.value = opt.value;
          optEl.textContent = opt.label || opt.value;
          selectEl.appendChild(optEl);
        }
        formInputs[input.name] = {
          el: selectEl,
          type: input.type,
          meta: input,
          container: selectEl,
        };
        formEl.appendChild(selectEl);
        if (input.error) addInputError(formInputs[input.name], input.error);
        continue;
      }

      if (input.type === 'boolean' || input.type === 'checkbox') {
        const wrap = document.createElement('label');
        wrap.className = 'card-input';
        wrap.style.display = 'flex';
        wrap.style.alignItems = 'center';
        wrap.style.gap = '8px';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.name = input.name;
        const text = document.createElement('span');
        text.textContent = input.placeholder || input.name;
        wrap.appendChild(checkbox);
        wrap.appendChild(text);
        formInputs[input.name] = {
          el: checkbox,
          type: 'boolean',
          meta: input,
          container: wrap,
        };
        formEl.appendChild(wrap);
        if (input.error) addInputError(formInputs[input.name], input.error);
        continue;
      }

      const inputEl =
        input.type === 'textarea'
          ? document.createElement('textarea')
          : document.createElement('input');
      inputEl.className = 'card-input';
      inputEl.name = input.name;
      inputEl.placeholder = input.placeholder || '';
      if (input.type !== 'textarea') {
        if (input.type === 'number') inputEl.type = 'number';
        if (input.type === 'integer') {
          inputEl.type = 'number';
          inputEl.step = '1';
        }
        if (input.type === 'token') {
          inputEl.type = 'password';
          inputEl.autocomplete = 'off';
          inputEl.spellcheck = false;
        }
        if (input.type === 'file') inputEl.type = 'file';
        if (input.format === 'date') inputEl.type = 'date';
        if (input.format === 'date-time') inputEl.type = 'datetime-local';
      } else {
        inputEl.rows = 4;
      }
      if (input.required) inputEl.required = true;
      if (typeof input.min === 'number' && 'min' in inputEl)
        inputEl.min = String(input.min);
      if (typeof input.max === 'number' && 'max' in inputEl)
        inputEl.max = String(input.max);
      if (typeof input.min_length === 'number')
        inputEl.minLength = input.min_length;
      if (typeof input.max_length === 'number')
        inputEl.maxLength = input.max_length;
      formInputs[input.name] = {
        el: inputEl,
        type: input.type || 'text',
        meta: input,
        container: inputEl,
      };
      formEl.appendChild(inputEl);
      if (input.error) addInputError(formInputs[input.name], input.error);
    }

    const submitBtn = document.createElement('button');
    submitBtn.className = `card-btn card-btn-${card.form.submitButton.type || 'default'}`;
    submitBtn.textContent = card.form.submitButton.label;
    if (card.form.submitButton.disabled || disabledByChannel) {
      submitBtn.disabled = true;
      submitBtn.title =
        card.form.submitButton.disabledReason || channelNotice || '';
    }
    submitBtn.addEventListener('click', async () => {
      clearInputErrors();
      const formValue = {};
      for (const [name, item] of Object.entries(formInputs)) {
        if (item.type === 'boolean') {
          formValue[name] = item.el.checked ? 'true' : 'false';
        } else if (item.type === 'multi_select') {
          formValue[name] = JSON.stringify(
            Array.from(item.el.selectedOptions || [])
              .map((option) => option.value)
              .filter(Boolean),
          );
        } else {
          formValue[name] = item.el.value;
        }
      }
      for (const [name, item] of Object.entries(formInputs)) {
        const val =
          item.type === 'boolean'
            ? item.el.checked
              ? 'true'
              : 'false'
            : item.type === 'multi_select'
              ? JSON.stringify(
                  Array.from(item.el.selectedOptions || [])
                    .map((option) => option.value)
                    .filter(Boolean),
                )
              : item.type === 'file'
                ? Array.from(item.el.files || [])
                    .map((file) => file.name)
                    .join(',')
                : item.el.value;
        const err = validateCardFormField(item.meta || {}, val);
        if (err) {
          addInputError(item, err);
          formError.textContent = `${name}: ${err}`;
          formError.classList.remove('hidden');
          return;
        }
      }
      formError.textContent = '';
      formError.classList.add('hidden');
      for (const [name, item] of Object.entries(formInputs)) {
        if (item.type !== 'file') continue;
        const files = Array.from(item.el.files || []);
        if (files.length === 0) {
          formValue[name] = '';
          continue;
        }
        try {
          const uploaded = await uploadFilesForJid(files, uploadJid);
          const paths = uploaded
            .map((file) => file.agentPath || file.hostPath || file.name)
            .filter(Boolean);
          formValue[name] =
            paths.length === 1 ? paths[0] : JSON.stringify(paths);
        } catch (err) {
          const message = err instanceof Error ? err.message : '文件上传失败';
          addInputError(item, message);
          formError.textContent = `${name}: ${message}`;
          formError.classList.remove('hidden');
          return;
        }
      }
      runAction(card.form.submitButton.value, formValue, formPendingLabel);
    });
    formEl.appendChild(submitBtn);
    container.appendChild(formEl);
  }

  return container;
}

function renderCardElement(card, msgId) {
  return renderInteractiveCard(card, {
    cardId: msgId,
    uploadJid: currentGroupJid || 'web:main',
    onAction: (value, formValue) => sendCardAction(value, msgId, formValue),
  });
}

function sendCardAction(value, cardId, formValue) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('WebSocket 未连接，无法提交操作'));
  }
  const requestId = `card_action_${Date.now()}_${(cardActionSeq += 1)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCardActions.delete(requestId);
      reject(new Error('操作提交超时，请稍后重试'));
    }, 15000);
    pendingCardActions.set(requestId, { resolve, reject, timer });
    sendWs({
      type: 'card_action',
      requestId,
      cardId: cardId,
      value: value,
      payload: formValue || undefined,
      formValue: formValue || undefined,
    });
  });
}

// --- Create single message element (factory) ---
function createMessageEl(msg) {
  const isUser = msg.is_from_me;
  const isSystem = msg.sender === 'system';

  if (isSystem) {
    const systemEl = document.createElement('div');
    systemEl.className = 'message system';
    systemEl.setAttribute('data-msg-id', msg.id);
    systemEl.setAttribute('data-timestamp', msg.timestamp);
    systemEl.textContent = msg.content;
    return systemEl;
  }

  // Card messages get special rendering
  if (isCardMessage(msg)) {
    const card = parseCardContent(msg);
    if (card) {
      const wrapper = document.createElement('div');
      wrapper.className = 'message assistant card-message';
      wrapper.setAttribute('data-msg-id', msg.id);
      wrapper.setAttribute('data-timestamp', msg.timestamp);
      wrapper.innerHTML = `
        <div class="msg-select-check">\u2713</div>
        <div class="msg-main">
          ${renderMessageHeaderHtml(msg, { kind: 'card', fallbackSenderName: 'Assistant' })}
          <div class="msg-body">
            ${renderMessageActionsHtml({ copy: false })}
          </div>
        </div>
      `;
      const body = wrapper.querySelector('.msg-body');
      if (body) body.appendChild(renderCardElement(card, msg.id));
      attachMessageInteractions(wrapper, msg, { addCopyButtons: false });
      return wrapper;
    }
  }

  // File messages: render as file card with icon and filename
  if (msg._filePath) {
    const fileName = msg._filePath.split('/').pop() || msg.content;
    const ext = fileName.split('.').pop().toLowerCase();
    const fileUrl = msg._fileUrl || null;
    const isImageFile = IMAGE_EXTS.includes(ext);
    const wrapper = document.createElement('div');
    wrapper.className = 'message assistant file-message';
    wrapper.setAttribute('data-msg-id', msg.id);
    wrapper.setAttribute('data-timestamp', msg.timestamp);
    wrapper.innerHTML = `
      <div class="msg-select-check">\u2713</div>
      <div class="msg-main">
        ${renderMessageHeaderHtml(msg, { kind: 'file', fallbackSenderName: 'Assistant' })}
        <div class="msg-body">
          ${renderMessageActionsHtml()}
        </div>
      </div>
    `;

    const body = wrapper.querySelector('.msg-body');
    if (isImageFile) {
      const preview = renderFilePreview(fileName, ext, msg._filePath, fileUrl);
      body.appendChild(preview);
      preview.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showFileContextMenu(e, msg._filePath);
      });
    } else {
      body.insertAdjacentHTML(
        'beforeend',
        `
        <div class="file-card" data-ext="${escapeHtml(ext)}">
          <div class="file-card-icon">${getFileIcon(ext)}</div>
          <div class="file-card-name">${escapeHtml(fileName)}</div>
        </div>
      `,
      );

      const card = wrapper.querySelector('.file-card');
      card.addEventListener('click', () => {
        if (window.icarusApp?.openFile) {
          window.icarusApp.openFile(msg._filePath);
        } else {
          window.open(fileUrl ? apiUrl(fileUrl) : `file://${msg._filePath}`);
        }
      });
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showFileContextMenu(e, msg._filePath);
      });
    }
    attachMessageInteractions(wrapper, msg, { addCopyButtons: false });
    return wrapper;
  }

  const div = document.createElement('div');
  div.setAttribute('data-msg-id', msg.id);
  div.setAttribute('data-timestamp', msg.timestamp);

  div.className = `message ${isUser ? 'user' : 'assistant'}`;

  // Reply quote block
  let replyHtml = '';
  if (msg.reply_to_id) {
    const quoted = messages.find((m) => m.id === msg.reply_to_id);
    const quotedText = quoted ? getMessagePreviewText(quoted) : '...';
    replyHtml = `<div class="msg-reply-quote" data-reply-id="${escapeAttribute(msg.reply_to_id)}">${escapeHtml(quotedText)}</div>`;
  }

  const parsedContent = parseMessageAttachmentReferences(msg.content);
  const cleanContent = parsedContent.content;
  const attachmentInfos = parsedContent.paths.map(createFileInfoFromPath);
  const renderedContent = cleanContent
    ? isUser
      ? renderPlainMessageContent(cleanContent)
      : renderMarkdown(cleanContent)
    : '';
  const attachmentsHtml =
    attachmentInfos.length > 0 ? '<div class="msg-attachments"></div>' : '';
  const modelTail =
    isUser && msg.model
      ? `<div class="msg-model-tail">模型：${escapeHtml(msg.model)}</div>`
      : '';

  div.innerHTML = `
    <div class="msg-select-check">\u2713</div>
    <div class="msg-main">
      ${renderMessageHeaderHtml(msg)}
      <div class="msg-body">
        ${renderMessageActionsHtml()}
        ${replyHtml}
        ${renderedContent ? `<div class="msg-content">${renderedContent}</div>` : ''}
        ${attachmentsHtml}
      </div>
      ${modelTail}
    </div>
  `;

  if (attachmentInfos.length > 0) {
    const attachmentsEl = div.querySelector('.msg-attachments');
    attachmentInfos.forEach((fileInfo) => {
      const preview = renderFilePreview(
        fileInfo.filename,
        fileInfo.ext,
        fileInfo.filePath,
      );
      attachmentsEl.appendChild(preview);
    });
  }

  attachMessageInteractions(div, msg);

  return div;
}

// --- File icon by extension ---
function getFileIcon(ext) {
  const icons = {
    pdf: '📄',
    doc: '📝',
    docx: '📝',
    txt: '📃',
    sql: '🗃️',
    db: '🗃️',
    png: '🖼️',
    jpg: '🖼️',
    jpeg: '🖼️',
    gif: '🖼️',
    svg: '🖼️',
    webp: '🖼️',
    mp4: '🎬',
    mov: '🎬',
    avi: '🎬',
    mp3: '🎵',
    wav: '🎵',
    flac: '🎵',
    zip: '📦',
    rar: '📦',
    tar: '📦',
    gz: '📦',
    js: '⚡',
    ts: '⚡',
    py: '🐍',
    java: '☕',
    go: '🔵',
    rs: '🦀',
    json: '📋',
    xml: '📋',
    csv: '📊',
    xls: '📊',
    xlsx: '📊',
    ppt: '📑',
    pptx: '📑',
    html: '🌐',
    css: '🎨',
  };
  return icons[ext] || '📎';
}

// --- File context menu ---
function showFileContextMenu(e, filePath) {
  // Remove existing menu if any
  closeKnowledgeImportMenu();
  document.querySelector('.context-menu')?.remove();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  const referencePath = containerFilePath(filePath);

  const items = [
    {
      label: '打开',
      icon: '📂',
      action: () => window.icarusApp?.openFile?.(filePath),
    },
    {
      label: '打开方式…',
      icon: '🔀',
      action: () => window.icarusApp?.openFileWith?.(filePath),
    },
    {
      label: '在文件夹中显示',
      icon: '📁',
      action: () => window.icarusApp?.showInFolder?.(filePath),
    },
    ...(referencePath
      ? [
          {
            label: '引用',
            icon: '↩',
            action: () => referenceFileInComposer(referencePath),
          },
        ]
      : []),
    {
      label: '复制路径',
      icon: '📋',
      action: () => navigator.clipboard?.writeText(filePath),
    },
  ];

  for (const item of items) {
    const el = document.createElement('div');
    el.className = 'context-menu-item';
    el.innerHTML = `<span class="context-menu-icon">${item.icon}</span>${escapeHtml(item.label)}`;
    el.addEventListener('click', () => {
      item.action();
      menu.remove();
    });
    menu.appendChild(el);
  }

  // Position at cursor
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  document.body.appendChild(menu);

  // Adjust if menu overflows viewport
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth)
    menu.style.left = `${window.innerWidth - rect.width - 8}px`;
  if (rect.bottom > window.innerHeight)
    menu.style.top = `${window.innerHeight - rect.height - 8}px`;

  // Close on click outside
  const closeHandler = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener('click', closeHandler);
    }
  };
  requestAnimationFrame(() => document.addEventListener('click', closeHandler));
}


function scheduleModelSync() {
  if (!currentGroupJid) return;
  if (modelSyncTimer) clearTimeout(modelSyncTimer);
  modelSyncTimer = setTimeout(async () => {
    if (!currentGroupJid) return;
    try {
      const res = await apiFetch(
        `/api/messages?jid=${encodeURIComponent(currentGroupJid)}&since=0`,
      );
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data.messages)) return;
      messages = data.messages.map((m) => ({
        ...m,
        _filePath: m.file_path || undefined,
        _fileUrl: m.file_url || undefined,
      }));
      renderMessages();
    } catch {
      // Best effort only.
    }
  }, 900);
}

// --- Skeleton loading ---
function showSkeleton() {
  messagesEmpty.style.display = 'none';
  const existing = messagesEl.querySelectorAll('.message, .skeleton-message');
  existing.forEach((el) => el.remove());
  for (let i = 0; i < 5; i++) {
    const skel = document.createElement('div');
    skel.className = 'skeleton-message';
    const widths = ['sender', i % 2 === 0 ? 'long' : 'medium', 'short'];
    widths.forEach((w) => {
      const line = document.createElement('div');
      line.className = `skeleton-line ${w}`;
      skel.appendChild(line);
    });
    messagesEl.appendChild(skel);
  }
}

function clearSkeleton() {
  const skeletons = messagesEl.querySelectorAll('.skeleton-message');
  skeletons.forEach((el) => el.remove());
}

function setConnectionStatus(status) {
  connectionStatus.className = `conn-status ${status}`;
  const label = connectionStatus.querySelector('.conn-label');
  label.textContent =
    status === 'connected'
      ? 'Connected'
      : status === 'connecting'
        ? 'Connecting...'
        : 'Disconnected';
}

function applyScreenVisibility() {
  const showTodayPlan = todayPlanVisible;
  const showFeatureRuntime =
    !showTodayPlan && getFeatureRuntimeItem(activePrimaryNavKey);
  const showAssistant = !showTodayPlan && activePrimaryNavKey === 'assistant';
  const showWorkspace =
    !showTodayPlan && activePrimaryNavKey === 'agent-groups';
  const showConfiguration =
    !showTodayPlan && activePrimaryNavKey === 'configuration';
  const showMemoryManagement =
    !showTodayPlan && activePrimaryNavKey === 'memory-management';
  const showKnowledgeManagement =
    !showTodayPlan && activePrimaryNavKey === 'knowledge-management';
  const showTraceMonitor =
    !showTodayPlan && activePrimaryNavKey === 'trace-monitor';
  if (todayPlanScreen) {
    todayPlanScreen.classList.toggle('active', showTodayPlan);
  }
  if (assistantScreen) {
    assistantScreen.classList.toggle('active', showAssistant);
  }
  if (workspace) {
    workspace.classList.toggle('active', showWorkspace);
  }
  if (configurationScreen) {
    configurationScreen.classList.toggle('active', showConfiguration);
  }
  if (memoryManagementScreen) {
    memoryManagementScreen.classList.toggle('active', showMemoryManagement);
  }
  if (knowledgeManagementScreen) {
    knowledgeManagementScreen.classList.toggle(
      'active',
      showKnowledgeManagement,
    );
  }
  if (traceMonitorScreen) {
    traceMonitorScreen.classList.toggle('active', showTraceMonitor);
  }
  if (featureRuntimeScreen) {
    featureRuntimeScreen.classList.toggle('active', !!showFeatureRuntime);
  }
}

function isComponentManagementNavKey(navKey) {
  return componentManagementNavKeys.includes(navKey);
}

function setComponentManagementNavExpanded(expanded) {
  componentManagementNavExpanded = !!expanded;
  if (componentManagementNavGroup) {
    componentManagementNavGroup.classList.toggle(
      'expanded',
      componentManagementNavExpanded,
    );
    componentManagementNavGroup.classList.toggle(
      'collapsed',
      !componentManagementNavExpanded,
    );
  }
  if (componentManagementNavToggle) {
    componentManagementNavToggle.setAttribute(
      'aria-expanded',
      componentManagementNavExpanded ? 'true' : 'false',
    );
  }
  if (componentManagementNavChildren) {
    componentManagementNavChildren.hidden = !componentManagementNavExpanded;
  }
}

function syncPrimaryNavActiveState() {
  const navKey = todayPlanVisible ? '' : activePrimaryNavKey;
  const componentNavActive = isComponentManagementNavKey(navKey);
  primaryNavItems.forEach((item) => {
    item.classList.toggle(
      'active',
      item.getAttribute('data-nav-key') === navKey,
    );
  });
  if (componentManagementNavToggle) {
    componentManagementNavToggle.classList.toggle('active', componentNavActive);
  }
}

function setPrimaryNav(navKey) {
  if (navKey === null || navKey === void 0) return;
  activePrimaryNavKey = navKey;
  todayPlanVisible = false;
  if (isComponentManagementNavKey(navKey)) {
    setComponentManagementNavExpanded(true);
  }
  if (navKey !== 'knowledge-management' && knowledgeJobsPanel) {
    knowledgeJobsPanel.classList.remove('open');
  }
  syncPrimaryNavActiveState();
  applyScreenVisibility();
  if (navKey === 'memory-management') {
    renderDoctorPanel();
    renderMemoryList();
    loadMemories();
  }
  if (navKey === 'knowledge-management') {
    loadKnowledgeBaseData({ preserveDetail: true });
    if (knowledgePollingTimer) clearInterval(knowledgePollingTimer);
    knowledgePollingTimer = setInterval(() => {
      if (activePrimaryNavKey === 'knowledge-management') {
        loadKnowledgeJobs();
      }
    }, 4000);
  } else if (knowledgePollingTimer) {
    clearInterval(knowledgePollingTimer);
    knowledgePollingTimer = null;
  }
  if (navKey === 'assistant') {
    loadAssistantState();
  }
  if (navKey === 'configuration') {
    loadServiceConfigs({ preserveSelection: true });
    loadFeatureConfigs({ preserveSelection: true });
  }
  if (navKey === 'trace-monitor') {
    loadTraceMonitorData({ force: false });
  }
  const featureItem = getFeatureRuntimeItem(navKey);
  if (featureItem) {
    mountFeatureRenderer(featureItem).catch((err) => {
      if (activePrimaryNavKey !== featureItem.navKey) return;
      console.error('Failed to mount feature renderer:', err);
      renderFeatureRuntimeStatus(err.message || 'Feature renderer failed');
    });
  } else {
    unmountCurrentFeatureRenderer();
  }
}

function toggleTodayPlanScreen() {
  todayPlanVisible = !todayPlanVisible;
  applyScreenVisibility();
  if (todayPlanVisible) {
    loadTodayPlanOverview({ forceOpenToday: true, showEmptyWhenNoToday: true });
  }
}

function cyclePrimaryNav(step) {
  refreshPrimaryNavItems();
  if (!primaryNavItems.length) return;
  const currentIndex = primaryNavItems.findIndex(
    (item) => item.getAttribute('data-nav-key') === activePrimaryNavKey,
  );
  const baseIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex =
    (baseIndex + step + primaryNavItems.length) % primaryNavItems.length;
  const nextNavKey =
    primaryNavItems[nextIndex] &&
    primaryNavItems[nextIndex].getAttribute('data-nav-key');
  if (nextNavKey) {
    setPrimaryNav(nextNavKey);
  }
}

function refreshPrimaryNavItems() {
  primaryNavItems = Array.from(document.querySelectorAll('.primary-nav-item'));
}

function featureRuntimeNavKey(feature, item) {
  return `feature:${feature.id}:${item.key}`;
}

function getFeatureRuntimeItem(navKey) {
  return (
    enabledFeatureRuntimeItems.find((item) => item.navKey === navKey) || null
  );
}

function renderFeatureRuntimeStatus(message) {
  if (!featureRuntimeOutlet) return;
  featureRuntimeOutlet.innerHTML = `<div class="feature-runtime-status">${escapeHtml(message)}</div>`;
}

async function loadEnabledFeatures() {
  if (!primaryNav) return;
  try {
    const res = await apiFetch('/api/features/enabled');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    renderFeatureNavItems(Array.isArray(data.features) ? data.features : []);
  } catch (err) {
    console.error('Failed to load enabled features:', err);
  }
}

function renderFeatureNavItems(features) {
  const existing = primaryNav.querySelectorAll('[data-feature-nav="true"]');
  existing.forEach((item) => item.remove());
  enabledFeatureRuntimeItems = [];

  const navItems = [];
  features.forEach((feature) => {
    (feature.nav || []).forEach((item) => {
      navItems.push({
        feature,
        item,
        navKey: featureRuntimeNavKey(feature, item),
        order: Number.isFinite(item.order) ? item.order : 0,
      });
    });
  });
  navItems.sort(
    (a, b) => a.order - b.order || a.item.label.localeCompare(b.item.label),
  );
  enabledFeatureRuntimeItems = navItems;
  const featureInsertBefore =
    componentManagementNavGroup &&
    componentManagementNavGroup.parentElement === primaryNav
      ? componentManagementNavGroup
      : null;

  navItems.forEach((entry) => {
    const button = document.createElement('button');
    button.className = 'primary-nav-item';
    button.setAttribute('data-nav-key', entry.navKey);
    button.setAttribute('data-feature-nav', 'true');
    button.setAttribute('data-feature-id', entry.feature.id);
    button.innerHTML = `
      <span class="primary-nav-dot"></span>
      <span class="primary-nav-label">${escapeHtml(entry.item.label || entry.feature.name)}</span>
    `;
    button.addEventListener('click', () => setPrimaryNav(entry.navKey));
    primaryNav.insertBefore(button, featureInsertBefore);
  });
  refreshPrimaryNavItems();
  syncPrimaryNavActiveState();
}

async function mountFeatureRenderer(entry) {
  if (!featureRuntimeOutlet) return;
  if (mountedFeatureNavKey === entry.navKey) return;
  const mountSeq = ++featureRendererMountSeq;
  const cleanup = featureRendererCleanups.get(mountedFeatureNavKey);
  if (typeof cleanup === 'function') {
    try {
      cleanup();
    } catch (err) {
      console.warn('Feature renderer cleanup failed:', err);
    }
  }
  featureRuntimeOutlet.innerHTML = '';
  renderFeatureRuntimeStatus('Loading...');
  const entryUrl =
    entry.item.rendererEntryUrl || entry.feature.rendererEntryUrl;
  if (!entryUrl) {
    renderFeatureRuntimeStatus('Feature renderer entry is not configured');
    mountedFeatureNavKey = entry.navKey;
    return;
  }
  let mod = featureRendererModules.get(entryUrl);
  if (!mod) {
    mod = await import(apiUrl(entryUrl));
    featureRendererModules.set(entryUrl, mod);
  }
  if (
    mountSeq !== featureRendererMountSeq ||
    activePrimaryNavKey !== entry.navKey
  ) {
    return;
  }
  featureRuntimeOutlet.innerHTML = '';
  const mount =
    typeof mod.mount === 'function' ? mod.mount : mod.default?.mount;
  if (typeof mount !== 'function') {
    renderFeatureRuntimeStatus('Feature renderer does not export mount()');
    mountedFeatureNavKey = entry.navKey;
    return;
  }
  const result = await mount({
    root: featureRuntimeOutlet,
    feature: entry.feature,
    navItem: entry.item,
    apiFetch,
    apiUrl,
    showToast,
  });
  if (
    mountSeq !== featureRendererMountSeq ||
    activePrimaryNavKey !== entry.navKey
  ) {
    try {
      if (typeof result === 'function') {
        result();
      } else if (result && typeof result.unmount === 'function') {
        result.unmount();
      }
    } catch (err) {
      console.warn('Feature renderer cleanup failed:', err);
    }
    return;
  }
  if (typeof result === 'function') {
    featureRendererCleanups.set(entry.navKey, result);
  } else if (result && typeof result.unmount === 'function') {
    featureRendererCleanups.set(entry.navKey, () => result.unmount());
  }
  mountedFeatureNavKey = entry.navKey;
}

function unmountCurrentFeatureRenderer() {
  featureRendererMountSeq += 1;
  if (!mountedFeatureNavKey) {
    if (featureRuntimeOutlet) featureRuntimeOutlet.innerHTML = '';
    return;
  }
  const cleanup = featureRendererCleanups.get(mountedFeatureNavKey);
  if (typeof cleanup === 'function') {
    try {
      cleanup();
    } catch (err) {
      console.warn('Feature renderer cleanup failed:', err);
    }
  }
  featureRendererCleanups.delete(mountedFeatureNavKey);
  mountedFeatureNavKey = '';
  if (featureRuntimeOutlet) featureRuntimeOutlet.innerHTML = '';
}

function openSchedulersPanel() {
  closeKnowledgeImportMenu();
  if (knowledgeJobsPanel) {
    knowledgeJobsPanel.classList.remove('open');
  }
  closeAgentStatusPanel();
  schedulersPanel.classList.add('open');
  schedulersPanel.setAttribute('aria-hidden', 'false');
  loadSchedulers();
}

function closeSchedulersPanel() {
  schedulersPanel.classList.remove('open');
  schedulersPanel.setAttribute('aria-hidden', 'true');
}

function openAgentStatusPanel() {
  closeKnowledgeImportMenu();
  if (knowledgeJobsPanel) {
    knowledgeJobsPanel.classList.remove('open');
  }
  closeSchedulersPanel();
  agentStatusPanel.classList.add('open');
  agentStatusPanel.setAttribute('aria-hidden', 'false');
  loadAgentStatus();
  if (agentStatusInterval) clearInterval(agentStatusInterval);
  agentStatusInterval = setInterval(updateAgentDurations, 1000);
}

function closeAgentStatusPanel() {
  agentStatusPanel.classList.remove('open');
  agentStatusPanel.setAttribute('aria-hidden', 'true');
  if (agentStatusInterval) {
    clearInterval(agentStatusInterval);
    agentStatusInterval = null;
  }
}

function openKnowledgeJobsPanel() {
  closeKnowledgeImportMenu();
  closeSchedulersPanel();
  closeAgentStatusPanel();
  if (knowledgeJobsPanel) {
    knowledgeJobsPanel.classList.add('open');
  }
  loadKnowledgeJobs();
}

function renderGroups() {
  groupsList.innerHTML = '';
  for (const group of groups) {
    const el = document.createElement('div');
    el.className = `list-item${group.jid === currentGroupJid ? ' active' : ''}`;
    el.classList.toggle('main-group', group.isMain === true);
    el.classList.toggle('secondary-group', group.isMain !== true);

    const unread = unreadCounts[group.jid] || 0;
    const iconHtml = renderGroupListIcon(group);

    el.innerHTML = `
      ${iconHtml}
      <span class="item-name">${escapeHtml(group.name)}</span>
      ${group.isMain ? '<span class="item-badge">main</span>' : ''}
      ${unread > 0 ? `<span class="item-unread">${unread > 99 ? '99+' : unread}</span>` : ''}
    `;
    el.addEventListener('click', () => selectGroup(group.jid));
    groupsList.appendChild(el);
  }
}

function getDefaultMemoryGroupJid() {
  if (!Array.isArray(groups) || groups.length === 0) return '';
  const mainGroup = groups.find((g) => g.isMain);
  return (mainGroup && mainGroup.jid) || groups[0].jid || '';
}

function selectMemoryGroup(jid) {
  activeMemoryGroupJid = jid;
  closeMemoryEditor();
  closeDoctorPanel();
  closeMemoryMetricsModal();
  memoryDoctorReport = null;
  memoryDoctorMap = {};
  memoryMetricsSummary = null;
  renderDoctorPanel();
  setDoctorLog('');
  renderMemoryGroups();
  memoryEntries = [];
  renderMemoryList();
  loadMemories();
}

function renderMemoryGroups() {
  if (!memoryGroupsList) return;
  memoryGroupsList.innerHTML = '';
  for (const group of groups) {
    const el = document.createElement('div');
    el.className = `list-item${group.jid === activeMemoryGroupJid ? ' active' : ''}`;
    el.classList.toggle('main-group', group.isMain === true);
    el.classList.toggle('secondary-group', group.isMain !== true);
    const iconHtml = renderGroupListIcon(group);
    el.innerHTML = `
      ${iconHtml}
      <span class="item-name">${escapeHtml(group.name)}</span>
      ${group.isMain ? '<span class="item-badge">main</span>' : ''}
    `;
    el.addEventListener('click', () => selectMemoryGroup(group.jid));
    memoryGroupsList.appendChild(el);
  }
}

function formatDateTime(ts) {
  if (ts === null || ts === undefined || ts === '') return '--';
  const parsedMs = parseTimestamp(ts);
  if (!Number.isFinite(parsedMs) || parsedMs <= 0) return '--';
  const parsed = new Date(parsedMs);
  return parsed.toLocaleString();
}

function parseTimestamp(ts) {
  if (ts === null || ts === undefined || ts === '') return NaN;
  const numeric = Number(ts);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function getPayloadTimestamp(payload) {
  return (
    payload.createdAt ||
    payload.created_at ||
    payload.updatedAt ||
    payload.updated_at ||
    new Date().toISOString()
  );
}

function getActiveMemoryGroup() {
  return groups.find((g) => g.jid === activeMemoryGroupJid) || null;
}

function closeMemoryEditor() {
  editingMemoryId = '';
  if (memoryEditor) memoryEditor.classList.add('hidden');
  syncMemoryModalMask();
}

function openMemoryEditor() {
  if (memoryEditor) memoryEditor.classList.remove('hidden');
  syncMemoryModalMask();
}

function closeDoctorPanel() {
  if (memoryDoctorPanel) memoryDoctorPanel.classList.add('hidden');
  syncMemoryModalMask();
}

function openDoctorPanel() {
  if (memoryDoctorPanel) memoryDoctorPanel.classList.remove('hidden');
  syncMemoryModalMask();
}

function closeMemoryMetricsModal() {
  if (memoryMetricsModal) memoryMetricsModal.classList.add('hidden');
  syncMemoryModalMask();
}

function openMemoryMetricsModal() {
  if (memoryMetricsModal) memoryMetricsModal.classList.remove('hidden');
  syncMemoryModalMask();
}

function syncMemoryModalMask() {
  if (!memoryModalMask) return;
  const editorVisible =
    memoryEditor && !memoryEditor.classList.contains('hidden');
  const doctorVisible =
    memoryDoctorPanel && !memoryDoctorPanel.classList.contains('hidden');
  const metricsVisible =
    memoryMetricsModal && !memoryMetricsModal.classList.contains('hidden');
  memoryModalMask.classList.toggle(
    'hidden',
    !(editorVisible || doctorVisible || metricsVisible),
  );
}

function setDoctorLog(text) {
  if (memoryDoctorLog) {
    memoryDoctorLog.textContent = text || '';
  }
}

function getMemoryBrief(id) {
  const m = memoryDoctorMap && memoryDoctorMap[id];
  if (!m) return id;
  const content = (m.content || '').replace(/\s+/g, ' ').slice(0, 80);
  return `${id}: ${content}`;
}

function renderMemoryMetricsModal() {
  if (!memoryMetricsWindow || !memoryMetricsTotal || !memoryMetricsList) return;
  const group = getActiveMemoryGroup();
  const groupLabel = group ? group.folder : '--';
  if (!memoryMetricsSummary) {
    memoryMetricsWindow.textContent = `${groupLabel} | 加载中...`;
    memoryMetricsTotal.textContent = '正在获取统计数据...';
    memoryMetricsList.innerHTML = '';
    return;
  }
  const summary = memoryMetricsSummary;
  memoryMetricsWindow.textContent = `${groupLabel} | 最近 ${summary.hours}h`;
  memoryMetricsTotal.textContent = `总事件数: ${summary.total}`;
  const rows = Array.isArray(summary.byEvent) ? summary.byEvent : [];
  if (rows.length === 0) {
    memoryMetricsList.innerHTML =
      '<div class="memory-metrics-item"><span>暂无事件</span><span class="count">0</span></div>';
    return;
  }
  memoryMetricsList.innerHTML = rows
    .map(
      (row) =>
        `<div class="memory-metrics-item"><span>${escapeHtml(row.event || '')}</span><span class="count">${escapeHtml(String(row.count || 0))}</span></div>`,
    )
    .join('');
}

function renderDoctorPanel() {
  if (
    !memoryDoctorPanel ||
    !memoryDoctorSummary ||
    !memoryDuplicatesList ||
    !memoryStaleList ||
    !memoryConflictsList
  )
    return;
  if (!memoryDoctorReport) {
    memoryDoctorSummary.textContent = '暂无报告';
    memoryDuplicatesList.innerHTML =
      '<div class="memory-doctor-item">请点击 Doctor 按钮生成报告</div>';
    memoryStaleList.innerHTML =
      '<div class="memory-doctor-item">请点击 Doctor 按钮生成报告</div>';
    memoryConflictsList.innerHTML =
      '<div class="memory-doctor-item">请点击 Doctor 按钮生成报告</div>';
    return;
  }
  const report = memoryDoctorReport;
  memoryDoctorSummary.textContent = `total=${report.total}, duplicate=${report.duplicateGroups.length}, conflict=${report.conflictGroups.length}, stale=${report.staleWorkingIds.length}`;

  memoryDuplicatesList.innerHTML = '';
  if (report.duplicateGroups.length === 0) {
    memoryDuplicatesList.innerHTML =
      '<div class="memory-doctor-item">无重复组</div>';
  } else {
    for (const g of report.duplicateGroups) {
      const el = document.createElement('div');
      el.className = 'memory-doctor-item';
      el.innerHTML = `
        <div><strong>${escapeHtml(g.key)}</strong></div>
        <div>${g.ids.map((id) => escapeHtml(getMemoryBrief(id))).join('<br/>')}</div>
      `;
      memoryDuplicatesList.appendChild(el);
    }
  }

  memoryStaleList.innerHTML = '';
  if (report.staleWorkingIds.length === 0) {
    memoryStaleList.innerHTML =
      '<div class="memory-doctor-item">无过期 working</div>';
  } else {
    for (const id of report.staleWorkingIds) {
      const el = document.createElement('div');
      el.className = 'memory-doctor-item';
      el.textContent = getMemoryBrief(id);
      memoryStaleList.appendChild(el);
    }
  }

  memoryConflictsList.innerHTML = '';
  if (report.conflictGroups.length === 0) {
    memoryConflictsList.innerHTML =
      '<div class="memory-doctor-item">无冲突组</div>';
  } else {
    for (const g of report.conflictGroups) {
      const ids = [...g.positiveIds, ...g.negativeIds];
      const keepDefault = g.positiveIds[0] || ids[0] || '';
      const depDefault = g.negativeIds[0] || ids[1] || '';
      const el = document.createElement('div');
      el.className = 'memory-doctor-item';
      el.innerHTML = `
        <div><strong>${escapeHtml(g.key)}</strong></div>
        <div>Positive: ${g.positiveIds.map((id) => escapeHtml(getMemoryBrief(id))).join('<br/>') || '-'}</div>
        <div>Negative: ${g.negativeIds.map((id) => escapeHtml(getMemoryBrief(id))).join('<br/>') || '-'}</div>
        <div class="memory-doctor-actions">
          <button class="memory-action-btn" data-action="keep" data-keep-default="${escapeHtml(keepDefault)}" data-deprecate-default="${escapeHtml(depDefault)}" data-ids="${escapeHtml(ids.join(','))}">Keep</button>
          <button class="memory-action-btn" data-action="merge" data-ids="${escapeHtml(ids.join(','))}">Merge</button>
        </div>
      `;
      const keepBtn = el.querySelector('button[data-action="keep"]');
      const mergeBtn = el.querySelector('button[data-action="merge"]');
      if (keepBtn) {
        keepBtn.addEventListener('click', async () => {
          const allowed = (keepBtn.getAttribute('data-ids') || '')
            .split(',')
            .filter(Boolean);
          const keepDefaultId = keepBtn.getAttribute('data-keep-default') || '';
          const depDefaultId =
            keepBtn.getAttribute('data-deprecate-default') || '';
          const keepId = (
            (await openTextPrompt(
              `输入 keep_id（候选：${allowed.join(', ')}）`,
              keepDefaultId,
              { title: '冲突处理' },
            )) || ''
          ).trim();
          const deprecateId = (
            (await openTextPrompt(
              `输入 deprecate_id（候选：${allowed.join(', ')}）`,
              depDefaultId,
              { title: '冲突处理' },
            )) || ''
          ).trim();
          if (!keepId || !deprecateId || keepId === deprecateId) return;
          if (!allowed.includes(keepId) || !allowed.includes(deprecateId)) {
            alert('所选 ID 不在该冲突组内');
            return;
          }
          await resolveConflictKeep(keepId, deprecateId);
        });
      }
      if (mergeBtn) {
        mergeBtn.addEventListener('click', async () => {
          const allowed = (mergeBtn.getAttribute('data-ids') || '')
            .split(',')
            .filter(Boolean);
          const raw = (
            (await openTextPrompt(
              `输入两个 merge_ids（逗号分隔，候选：${allowed.join(', ')}）`,
              '',
              { title: '冲突合并' },
            )) || ''
          ).trim();
          if (!raw) return;
          const picks = raw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          if (picks.length !== 2 || picks[0] === picks[1]) {
            alert('请提供两个不同的 ID');
            return;
          }
          if (!allowed.includes(picks[0]) || !allowed.includes(picks[1])) {
            alert('所选 ID 不在该冲突组内');
            return;
          }
          const mergedContent = (
            (await openTextPrompt('输入 merged_content', '', {
              title: '冲突合并',
              multiline: true,
            })) || ''
          ).trim();
          if (!mergedContent) return;
          await resolveConflictMerge([picks[0], picks[1]], mergedContent);
        });
      }
      memoryConflictsList.appendChild(el);
    }
  }
}

async function runDoctor(staleDays) {
  const group = getActiveMemoryGroup();
  if (!group) return;
  const safeDays = Number.isFinite(Number(staleDays)) ? Number(staleDays) : 7;
  openDoctorPanel();
  renderDoctorPanel();
  setDoctorLog('Doctor 执行中...');
  try {
    const res = await apiFetch('/api/memory/doctor', {
      method: 'POST',
      body: JSON.stringify({
        folder: group.folder,
        staleDays: safeDays,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    memoryDoctorReport = data.report || null;
    memoryDoctorMap = data.memoryMap || {};
    renderDoctorPanel();
    setDoctorLog(`Doctor 完成（staleDays=${safeDays}）`);
  } catch (err) {
    console.error('Doctor failed:', err);
    setDoctorLog(
      `Doctor 失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function showMemoryMetrics(hours) {
  const group = getActiveMemoryGroup();
  if (!group) {
    alert('请先选择 Group');
    return;
  }
  const safeHours = Number.isFinite(Number(hours)) ? Number(hours) : 24;
  memoryMetricsSummary = null;
  openMemoryMetricsModal();
  renderMemoryMetricsModal();
  try {
    const res = await apiFetch('/api/memory/metrics', {
      method: 'POST',
      body: JSON.stringify({
        folder: group.folder,
        hours: safeHours,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    memoryMetricsSummary = data.summary || {
      hours: safeHours,
      total: 0,
      byEvent: [],
    };
    renderMemoryMetricsModal();
  } catch (err) {
    console.error('Load memory metrics failed:', err);
    memoryMetricsSummary = { hours: safeHours, total: 0, byEvent: [] };
    renderMemoryMetricsModal();
    if (memoryMetricsTotal) {
      memoryMetricsTotal.textContent = `获取失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

async function runGcByMode(mode) {
  const group = getActiveMemoryGroup();
  if (!group) return;
  try {
    const dryRunRes = await apiFetch('/api/memory/gc', {
      method: 'POST',
      body: JSON.stringify({
        folder: group.folder,
        mode,
        dryRun: true,
      }),
    });
    const dryRunData = await dryRunRes.json();
    if (!dryRunRes.ok)
      throw new Error(dryRunData?.error || `HTTP ${dryRunRes.status}`);
    const r = dryRunData.result || {};
    const dup = (r.duplicateDeletedIds || []).length;
    const stale = (r.staleDeletedIds || []).length;
    const total = Number(r.totalCandidates || 0);
    if (total === 0) {
      setDoctorLog(`GC 预演完成：无需清理（mode=${mode}）`);
      return;
    }
    if (
      !(await openConfirmDialog(
        `GC预演结果：重复=${dup}，过期=${stale}，共=${total}。确认执行真实清理？`,
        {
          title: '确认执行 GC',
        },
      ))
    ) {
      setDoctorLog('GC 已取消');
      return;
    }
    const runRes = await apiFetch('/api/memory/gc', {
      method: 'POST',
      body: JSON.stringify({
        folder: group.folder,
        mode,
        dryRun: false,
      }),
    });
    const runData = await runRes.json();
    if (!runRes.ok) throw new Error(runData?.error || `HTTP ${runRes.status}`);
    setDoctorLog(
      `GC 完成：mode=${mode}, 删除=${runData.result?.totalCandidates || 0}`,
    );
    loadMemories(memorySearchInput?.value || '');
    runDoctor(7);
  } catch (err) {
    console.error('GC failed:', err);
    setDoctorLog(
      `GC 失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function resolveConflictKeep(keepId, deprecateId) {
  const group = getActiveMemoryGroup();
  if (!group) return;
  try {
    const res = await apiFetch('/api/memory/conflict/keep', {
      method: 'POST',
      body: JSON.stringify({
        folder: group.folder,
        keep_id: keepId,
        deprecate_id: deprecateId,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    setDoctorLog(`冲突已 Keep：${keepId} 保留，${deprecateId} 废弃`);
    loadMemories(memorySearchInput?.value || '');
    runDoctor(7);
  } catch (err) {
    console.error('Conflict keep failed:', err);
    setDoctorLog(
      `Keep 失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function resolveConflictMerge(mergeIds, mergedContent) {
  const group = getActiveMemoryGroup();
  if (!group) return;
  try {
    const res = await apiFetch('/api/memory/conflict/merge', {
      method: 'POST',
      body: JSON.stringify({
        folder: group.folder,
        merge_ids: mergeIds,
        merged_content: mergedContent,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    setDoctorLog(
      `冲突已 Merge：${mergeIds.join(',')} -> ${data?.result?.merged?.id || 'new'}`,
    );
    loadMemories(memorySearchInput?.value || '');
    runDoctor(7);
  } catch (err) {
    console.error('Conflict merge failed:', err);
    setDoctorLog(
      `Merge 失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function openCreateMemoryEditor() {
  const group = getActiveMemoryGroup();
  if (!group) {
    alert('请先选择 Group');
    return;
  }
  editingMemoryId = '';
  if (memoryEditorTitle) memoryEditorTitle.textContent = '新增记忆';
  if (memoryLayerSelect) memoryLayerSelect.value = 'working';
  if (memoryTypeSelect) memoryTypeSelect.value = 'fact';
  if (memoryStatusSelect) memoryStatusSelect.value = 'active';
  if (memoryContentInput) memoryContentInput.value = '';
  openMemoryEditor();
  memoryContentInput?.focus();
}

function openEditMemoryEditor(mem) {
  editingMemoryId = mem?.id || '';
  if (!editingMemoryId) return;
  if (memoryEditorTitle) memoryEditorTitle.textContent = '编辑记忆';
  if (memoryLayerSelect) memoryLayerSelect.value = mem.layer || 'working';
  if (memoryTypeSelect) memoryTypeSelect.value = mem.memory_type || 'fact';
  if (memoryStatusSelect) memoryStatusSelect.value = mem.status || 'active';
  if (memoryContentInput) memoryContentInput.value = mem.content || '';
  openMemoryEditor();
  memoryContentInput?.focus();
}

function renderMemoryContentBody(content) {
  const raw = typeof content === 'string' ? content.trim() : '';
  if (!raw) return '<div class="memory-content-empty">暂无内容</div>';
  const blocks = raw
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  return blocks
    .map((block) => {
      const lines = block
        .split(/\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length > 1) {
        return `<div class="memory-content-block">${lines.map((line) => `<span>${escapeHtml(line)}</span>`).join('')}</div>`;
      }
      return `<p class="memory-content-paragraph">${escapeHtml(block)}</p>`;
    })
    .join('');
}

async function saveMemoryEditor() {
  const group = getActiveMemoryGroup();
  if (!group) {
    alert('请先选择 Group');
    return;
  }
  const content = (memoryContentInput?.value || '').trim();
  if (!content) {
    alert('记忆内容不能为空');
    return;
  }
  const payload = {
    folder: group.folder,
    content,
    layer: memoryLayerSelect?.value || 'working',
    memory_type: memoryTypeSelect?.value || 'fact',
    memory_status: memoryStatusSelect?.value || 'active',
  };

  try {
    if (editingMemoryId) {
      const res = await apiFetch('/api/memory', {
        method: 'PATCH',
        body: JSON.stringify({
          memoryId: editingMemoryId,
          ...payload,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await res.json();
    } else {
      const res = await apiFetch('/api/memory', {
        method: 'POST',
        body: JSON.stringify({
          folder: payload.folder,
          content: payload.content,
          layer: payload.layer,
          memory_type: payload.memory_type,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await res.json();
    }
    closeMemoryEditor();
    loadMemories(memorySearchInput?.value || '');
  } catch (err) {
    console.error('Failed to save memory:', err);
    alert('保存记忆失败');
  }
}

async function deleteMemoryById(memoryId) {
  const group = getActiveMemoryGroup();
  if (!group) return;
  if (!(await openConfirmDialog('确认删除该记忆？', { title: '删除记忆' })))
    return;
  try {
    const res = await apiFetch(
      `/api/memory?id=${encodeURIComponent(memoryId)}&folder=${encodeURIComponent(group.folder)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await res.json();
    loadMemories(memorySearchInput?.value || '');
  } catch (err) {
    console.error('Failed to delete memory:', err);
    alert('删除记忆失败');
  }
}

function renderMemoryList() {
  if (!memoryList || !memoryEmpty) return;
  memoryList.innerHTML = '';
  const visibleMemories =
    memoryStatusFilterValue === 'all'
      ? memoryEntries
      : memoryEntries.filter(
          (m) => (m.status || 'active') === memoryStatusFilterValue,
        );
  if (!activeMemoryGroupJid) {
    memoryEmpty.textContent = '请先在左侧选择 Group';
    memoryEmpty.classList.remove('hidden');
    return;
  }
  if (!Array.isArray(visibleMemories) || visibleMemories.length === 0) {
    if (memoryEntries.length > 0 && memoryStatusFilterValue !== 'all') {
      memoryEmpty.textContent = `当前筛选（${memoryStatusFilterValue}）下无记忆`;
      memoryEmpty.classList.remove('hidden');
    } else {
      if (memoryQueryText) {
        memoryEmpty.textContent = `没有匹配“${memoryQueryText}”的记忆`;
        memoryEmpty.classList.remove('hidden');
      } else {
        memoryEmpty.classList.add('hidden');
      }
    }
    return;
  }

  memoryEmpty.classList.add('hidden');
  for (const mem of visibleMemories) {
    const item = document.createElement('div');
    item.className = 'memory-item';
    const statusClass = `status-${mem.status || 'active'}`;
    const memoryId = mem.id || '';
    item.innerHTML = `
      <div class="memory-item-header">
        <div class="memory-item-tags">
          <span class="memory-tag">${escapeHtml(mem.layer || '')}</span>
          <span class="memory-tag">${escapeHtml(mem.memory_type || '')}</span>
          <span class="memory-tag ${statusClass}">${escapeHtml(mem.status || 'active')}</span>
        </div>
        <span class="memory-item-time">${escapeHtml(formatDateTime(mem.updated_at))}</span>
      </div>
      <div class="memory-item-content-panel">
        <div class="memory-item-content-label">Content</div>
        <div class="memory-item-content-text">${renderMemoryContentBody(mem.content)}</div>
      </div>
      <div class="memory-item-footer">
        <span class="memory-item-id" title="${escapeAttribute(memoryId)}">${escapeHtml(memoryId || '--')}</span>
        <div class="memory-item-actions">
          <button class="memory-action-btn" data-action="edit" data-memory-id="${escapeAttribute(memoryId)}">
            <svg class="memory-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"></path><path d="m16.5 3.5 4 4L8 20l-5 1 1-5z"></path></svg>
            <span>编辑</span>
          </button>
          <button class="memory-action-btn danger" data-action="delete" data-memory-id="${escapeAttribute(memoryId)}">
            <svg class="memory-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="m19 6-1 14H6L5 6"></path><path d="M10 11v5"></path><path d="M14 11v5"></path></svg>
            <span>删除</span>
          </button>
        </div>
      </div>
    `;
    const editBtn = item.querySelector('button[data-action="edit"]');
    const deleteBtn = item.querySelector('button[data-action="delete"]');
    if (editBtn) {
      editBtn.addEventListener('click', () => {
        openEditMemoryEditor(mem);
      });
    }
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => {
        deleteMemoryById(mem.id);
      });
    }
    memoryList.appendChild(item);
  }
}

async function loadMemories(queryOverride) {
  const group = groups.find((g) => g.jid === activeMemoryGroupJid);
  if (!group) {
    memoryEntries = [];
    renderMemoryList();
    return;
  }

  const query =
    typeof queryOverride === 'string'
      ? queryOverride.trim()
      : (memorySearchInput?.value || '').trim();
  memoryQueryText = query;

  const reqSeq = ++memoryRequestSeq;
  if (memoryRefreshBtn) {
    memoryRefreshBtn.classList.add('spinning');
  }
  try {
    const params = new URLSearchParams({
      folder: group.folder,
      limit: '200',
    });
    if (query) params.set('query', query);
    const res = await apiFetch(`/api/memories?${params.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (reqSeq !== memoryRequestSeq) return;
    memoryEntries = Array.isArray(data.memories) ? data.memories : [];
    renderMemoryList();
  } catch (err) {
    if (reqSeq !== memoryRequestSeq) return;
    console.error('Failed to load memories:', err);
    memoryEntries = [];
    if (memoryEmpty) {
      memoryEmpty.textContent = '记忆加载失败';
      memoryEmpty.classList.remove('hidden');
    }
    if (memoryList) {
      memoryList.innerHTML = '';
    }
  } finally {
    if (reqSeq === memoryRequestSeq && memoryRefreshBtn) {
      memoryRefreshBtn.classList.remove('spinning');
    }
  }
}

function renderKnowledgeSelectionSummary() {
  if (!knowledgeSelectionSummary) return;
  knowledgeSelectionSummary.textContent = `已选 ${getSelectedKnowledgeMaterials().length} · 可见 ${getFilteredKnowledgeMaterials().length}`;
}

function renderKnowledgeDraftSelectionSummary() {
  if (!knowledgeDraftSelectionSummary) return;
  const selectedVisibleDrafts = knowledgeDrafts.filter(
    (draft) =>
      knowledgeSelectedDraftIds.has(draft.id) && draft.status !== 'published',
  );
  knowledgeDraftSelectionSummary.textContent = `已选 ${selectedVisibleDrafts.length} 份`;
  if (knowledgeDraftBulkDeleteBtn) {
    knowledgeDraftBulkDeleteBtn.disabled = selectedVisibleDrafts.length === 0;
    knowledgeDraftBulkDeleteBtn.title = selectedVisibleDrafts.length
      ? `批量删除 ${selectedVisibleDrafts.length} 份未发布草稿`
      : '请先勾选未发布草稿';
  }
}

function pruneKnowledgeMaterialSelection() {
  const validIds = new Set(knowledgeMaterials.map((material) => material.id));
  Array.from(knowledgeSelectedMaterialIds).forEach((materialId) => {
    if (!validIds.has(materialId)) {
      knowledgeSelectedMaterialIds.delete(materialId);
    }
  });
}

function getSelectedKnowledgeMaterials() {
  return knowledgeMaterials.filter((material) =>
    knowledgeSelectedMaterialIds.has(material.id),
  );
}

function isKnowledgeMaterialDeletable(material) {
  return !!(
    material &&
    material.usage_summary &&
    material.usage_summary.can_delete
  );
}

function getFilteredKnowledgeMaterials() {
  return knowledgeMaterials.filter((material) => {
    const usageSummary = material.usage_summary || {};
    if (knowledgeMaterialFilterValue === 'referenced') {
      return !usageSummary.can_delete;
    }
    if (knowledgeMaterialFilterValue === 'deletable') {
      return !!usageSummary.can_delete;
    }
    if (knowledgeMaterialFilterValue === 'selected') {
      return knowledgeSelectedMaterialIds.has(material.id);
    }
    return true;
  });
}

function getFilteredKnowledgeDrafts() {
  return knowledgeDrafts.filter((draft) => {
    if (knowledgeDraftStatusFilterValue === 'all') return true;
    return draft.status === knowledgeDraftStatusFilterValue;
  });
}

function getFilteredKnowledgePages() {
  return knowledgePages.filter((page) => {
    if (knowledgePageKindFilterValue === 'all') return true;
    return page.page_kind === knowledgePageKindFilterValue;
  });
}

function pruneKnowledgeDraftSelection() {
  const validIds = new Set(
    knowledgeDrafts
      .filter((draft) => draft.status !== 'published')
      .map((draft) => draft.id),
  );
  Array.from(knowledgeSelectedDraftIds).forEach((draftId) => {
    if (!validIds.has(draftId)) {
      knowledgeSelectedDraftIds.delete(draftId);
    }
  });
}

function refreshKnowledgePageKindFilterOptions() {
  if (!knowledgePageKindFilter) return;
  const kinds = Array.from(
    new Set(
      knowledgePages
        .map((page) => String(page.page_kind || '').trim())
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const currentValue = knowledgePageKindFilterValue;
  const options = ['<option value="all">全部页面类型</option>'];
  kinds.forEach((kind) => {
    options.push(
      `<option value="${escapeAttribute(kind)}">${escapeHtml(kind)}</option>`,
    );
  });
  if (currentValue !== 'all' && !kinds.includes(currentValue)) {
    options.push(
      `<option value="${escapeAttribute(currentValue)}">${escapeHtml(currentValue)}</option>`,
    );
  }
  knowledgePageKindFilter.innerHTML = options.join('');
  knowledgePageKindFilter.value = currentValue;
}

function clearKnowledgeDetail() {
  currentKnowledgeDetail = null;
  currentKnowledgeDraftId = '';
  currentKnowledgePageSlug = '';
  if (knowledgeDetailEmpty) knowledgeDetailEmpty.classList.remove('hidden');
  if (knowledgeDetail) knowledgeDetail.classList.add('hidden');
  if (knowledgeDetailTitle) knowledgeDetailTitle.textContent = '知识详情';
  if (knowledgeDetailMeta) knowledgeDetailMeta.innerHTML = '';
  if (knowledgeDetailActions) knowledgeDetailActions.innerHTML = '';
  if (knowledgeDetailContent) knowledgeDetailContent.innerHTML = '';
}

function renderKnowledgeMaterials() {
  if (!knowledgeMaterialList) return;
  knowledgeMaterialList.innerHTML = '';
  renderKnowledgeSelectionSummary();
  const visibleMaterials = getFilteredKnowledgeMaterials();

  if (!knowledgeMaterials.length) {
    knowledgeMaterialList.innerHTML =
      '<div class="trace-monitor-list-empty">暂无资料快照</div>';
    return;
  }

  if (!visibleMaterials.length) {
    knowledgeMaterialList.innerHTML =
      '<div class="trace-monitor-list-empty">当前筛选下没有资料</div>';
    return;
  }

  for (const material of visibleMaterials) {
    const usageSummary = material.usage_summary || {};
    const dependencyTone = isKnowledgeMaterialDeletable(material)
      ? 'deletable'
      : 'referenced';
    const dependencyLabel = isKnowledgeMaterialDeletable(material)
      ? '可删除'
      : '有依赖';
    const item = document.createElement('div');
    item.className = `knowledge-list-item${currentKnowledgeDetail?.type === 'material' && currentKnowledgeDetail.id === material.id ? ' active' : ''}`;
    const checked = knowledgeSelectedMaterialIds.has(material.id);
    item.innerHTML = `
      <div class="knowledge-list-item-head">
        <div class="knowledge-list-item-title">${escapeHtml(material.title || material.id)}</div>
      </div>
      <div class="knowledge-list-item-meta">
        <span>${escapeHtml(material.source_kind || '--')}</span>
        <span>${escapeHtml(`页面 ${usageSummary.page_ref_count || 0}`)}</span>
        <span>${escapeHtml(`草稿 ${usageSummary.draft_ref_count || 0}`)}</span>
        <span>${escapeHtml(`证据 ${usageSummary.evidence_count || 0}`)}</span>
        <span>${escapeHtml(formatDateTime(material.created_at))}</span>
      </div>
      <div class="knowledge-list-item-actions">
        <span class="knowledge-status-pill ${escapeAttribute(dependencyTone)}">${escapeHtml(dependencyLabel)}</span>
        <label class="knowledge-selection-toggle">
          <input type="checkbox" data-material-select="${escapeAttribute(material.id)}" ${checked ? 'checked' : ''} />
          选中
        </label>
      </div>
    `;
    const checkbox = item.querySelector('input[data-material-select]');
    if (checkbox) {
      checkbox.addEventListener('click', (event) => {
        event.stopPropagation();
        if (checkbox.checked) {
          knowledgeSelectedMaterialIds.add(material.id);
        } else {
          knowledgeSelectedMaterialIds.delete(material.id);
        }
        renderKnowledgeSelectionSummary();
      });
    }
    item.addEventListener('click', () => {
      openKnowledgeMaterialDetail(material.id);
    });
    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      showKnowledgeMaterialContextMenu(event, material);
    });
    knowledgeMaterialList.appendChild(item);
  }
}

function renderKnowledgeDrafts() {
  if (!knowledgeDraftList) return;
  knowledgeDraftList.innerHTML = '';
  renderKnowledgeDraftSelectionSummary();
  const visibleDrafts = getFilteredKnowledgeDrafts();
  if (!knowledgeDrafts.length) {
    knowledgeDraftList.innerHTML =
      '<div class="trace-monitor-list-empty">暂无草稿</div>';
    return;
  }
  if (!visibleDrafts.length) {
    knowledgeDraftList.innerHTML =
      '<div class="trace-monitor-list-empty">当前筛选下没有草稿</div>';
    return;
  }
  for (const draft of visibleDrafts) {
    const selectable = draft.status !== 'published';
    const checked = knowledgeSelectedDraftIds.has(draft.id);
    const item = document.createElement('div');
    item.className = `knowledge-list-item${draft.id === currentKnowledgeDraftId ? ' active' : ''}`;
    item.innerHTML = `
      <div class="knowledge-list-item-head">
        <div class="knowledge-list-item-title">${escapeHtml(draft.title || draft.target_slug || draft.id)}</div>
      </div>
      <div class="knowledge-list-item-meta">
        <span>${escapeHtml(draft.page_kind || '--')}</span>
        <span>${escapeHtml(draft.target_slug || '--')}</span>
        <span>${escapeHtml(`资料 ${draft.material_count || 0}`)}</span>
      </div>
      <div class="knowledge-list-item-actions">
        <span class="knowledge-status-pill ${escapeHtml(draft.status || 'draft')}">${escapeHtml(draft.status || 'draft')}</span>
        <label class="knowledge-selection-toggle" title="${escapeAttribute(selectable ? '加入批量删除' : '已发布草稿不参与批量删除')}">
          <input type="checkbox" data-draft-select="${escapeAttribute(draft.id)}" ${checked ? 'checked' : ''} ${selectable ? '' : 'disabled'} />
          选中
        </label>
      </div>
    `;
    const checkbox = item.querySelector('input[data-draft-select]');
    if (checkbox) {
      checkbox.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!selectable) return;
        if (checkbox.checked) {
          knowledgeSelectedDraftIds.add(draft.id);
        } else {
          knowledgeSelectedDraftIds.delete(draft.id);
        }
        renderKnowledgeDraftSelectionSummary();
      });
    }
    item.addEventListener('click', () => {
      openKnowledgeDraftDetail(draft.id);
    });
    knowledgeDraftList.appendChild(item);
  }
}

function renderKnowledgePages() {
  if (!knowledgePageList) return;
  knowledgePageList.innerHTML = '';
  const visiblePages = getFilteredKnowledgePages();
  if (!knowledgePages.length) {
    knowledgePageList.innerHTML =
      '<div class="trace-monitor-list-empty">暂无已发布页面</div>';
    return;
  }
  if (!visiblePages.length) {
    knowledgePageList.innerHTML =
      '<div class="trace-monitor-list-empty">当前筛选下没有页面</div>';
    return;
  }
  for (const page of visiblePages) {
    const item = document.createElement('div');
    item.className = `knowledge-list-item${page.slug === currentKnowledgePageSlug ? ' active' : ''}`;
    item.innerHTML = `
      <div class="knowledge-list-item-head">
        <div class="knowledge-list-item-title">${escapeHtml(page.title || page.slug)}</div>
      </div>
      <div class="knowledge-list-item-meta">
        <span>${escapeHtml(page.page_kind || '--')}</span>
        <span>${escapeHtml(page.slug || '--')}</span>
        <span>${escapeHtml(`入链 ${page.incoming_relation_count || 0}`)}</span>
      </div>
      <div class="knowledge-list-item-actions">
        <span class="knowledge-status-pill ${escapeHtml(page.status || 'published')}">${escapeHtml(page.status || 'published')}</span>
      </div>
    `;
    item.addEventListener('click', () => {
      openKnowledgePageDetail(page.slug);
    });
    knowledgePageList.appendChild(item);
  }
}

function renderKnowledgeJobs() {
  const runningCount = knowledgeJobs.filter(
    (job) => job.status === 'running',
  ).length;
  const pendingCount = knowledgeJobs.filter(
    (job) => job.status === 'pending',
  ).length;
  const finishedCount = knowledgeJobs.filter(
    (job) => job.status === 'completed' || job.status === 'failed',
  ).length;
  if (knowledgeJobsTriggerMeta) {
    knowledgeJobsTriggerMeta.textContent = `${knowledgeJobs.length} 条`;
    const summaryParts = [];
    if (runningCount) summaryParts.push(`${runningCount} 运行中`);
    if (pendingCount) summaryParts.push(`${pendingCount} 排队中`);
    openKnowledgeJobsBtn.title = summaryParts.length
      ? `后台任务 · ${summaryParts.join(' · ')}`
      : `后台任务 · ${knowledgeJobs.length} 条`;
  }

  if (knowledgeJobsDeleteFinishedBtn) {
    knowledgeJobsDeleteFinishedBtn.disabled = finishedCount === 0;
    knowledgeJobsDeleteFinishedBtn.title = finishedCount
      ? `删除 ${finishedCount} 条已完成/失败任务`
      : '没有可删除的已完成/失败任务';
  }

  if (!knowledgeJobList) return;
  const runningIds = new Set(
    knowledgeJobs
      .filter((job) => job.status === 'running')
      .map((job) => job.id),
  );
  Array.from(stoppingKnowledgeJobIds).forEach((jobId) => {
    if (!runningIds.has(jobId)) {
      stoppingKnowledgeJobIds.delete(jobId);
    }
  });

  knowledgeJobList.innerHTML = '';
  if (!knowledgeJobs.length) {
    knowledgeJobList.innerHTML =
      '<div class="agent-status-empty">暂无后台任务</div>';
    return;
  }

  for (const job of knowledgeJobs.slice(0, 50)) {
    let payload = null;
    let result = null;
    try {
      payload = job.payload_json ? JSON.parse(job.payload_json) : null;
    } catch {
      payload = null;
    }
    try {
      result = job.result_json ? JSON.parse(job.result_json) : null;
    } catch {
      result = null;
    }

    const isStopping = stoppingKnowledgeJobIds.has(job.id);
    const canStop = job.status === 'running';
    const requestLabel =
      payload?.title ||
      payload?.targetSlug ||
      result?.title ||
      result?.target_slug ||
      job.job_type ||
      job.id;
    const summaryText =
      job.error_message ||
      result?.title ||
      result?.target_slug ||
      (payload?.instruction ? `要求：${payload.instruction}` : '') ||
      '等待执行';
    const createdLabel = formatRelativeTime(job.created_at);
    const startedLabel = job.started_at
      ? formatDateTime(job.started_at)
      : '未开始';
    const finishedLabel = job.finished_at
      ? formatDateTime(job.finished_at)
      : '未结束';

    const item = document.createElement('div');
    item.className = `knowledge-job-panel-item${isStopping ? ' is-stopping' : ''}`;
    item.innerHTML = `
      <div class="knowledge-job-panel-head">
        <div class="knowledge-job-panel-title">${escapeHtml(requestLabel || job.id)}</div>
        <span class="knowledge-status-pill ${escapeHtml(job.status || 'pending')}">${escapeHtml(job.status || 'pending')}</span>
      </div>
      <div class="knowledge-job-panel-content">${escapeHtml(summaryText)}</div>
      <div class="knowledge-job-panel-meta">
        <span>${escapeHtml(`创建 ${createdLabel}`)}</span>
        <span>${escapeHtml(`开始 ${startedLabel}`)}</span>
        <span>${escapeHtml(`结束 ${finishedLabel}`)}</span>
      </div>
      ${
        canStop
          ? `
        <div class="knowledge-job-panel-actions">
          <button type="button" class="panel-action-btn stop icon-text-btn knowledge-job-stop-btn"${isStopping ? ' disabled' : ''}>
            ${isStopping ? 'Stopping...' : `${SVG.stop} Stop`}
          </button>
        </div>
      `
          : ''
      }
    `;
    const stopBtn = item.querySelector('.knowledge-job-stop-btn');
    if (stopBtn && !isStopping) {
      stopBtn.addEventListener('click', () => {
        void stopKnowledgeJob(job.id);
      });
    }
    knowledgeJobList.appendChild(item);
  }
}

function renderKnowledgeDetailActions(actions) {
  if (!knowledgeDetailActions) return;
  const actionList = Array.isArray(actions) ? actions : [];
  if (!actionList.length) {
    knowledgeDetailActions.innerHTML = '';
    return;
  }
  knowledgeDetailActions.innerHTML = actionList
    .map((action, index) => {
      const baseClass = action.kind === 'primary' ? 'btn-primary' : 'btn-ghost';
      const toneClass = action.tone === 'danger' ? ' danger' : '';
      const disabledAttr = action.disabled ? ' disabled' : '';
      return `
      <button
        type="button"
        class="${baseClass}${toneClass}"
        data-knowledge-action-index="${escapeAttribute(String(index))}"
        title="${escapeAttribute(action.title || action.label || '')}"${disabledAttr}
      >
        ${escapeHtml(action.label || '操作')}
      </button>
    `;
    })
    .join('');
  Array.from(
    knowledgeDetailActions.querySelectorAll('[data-knowledge-action-index]'),
  ).forEach((button) => {
    button.addEventListener('click', () => {
      const index = Number(button.getAttribute('data-knowledge-action-index'));
      const action = actionList[index];
      if (!action || action.disabled || typeof action.onClick !== 'function')
        return;
      action.onClick();
    });
  });
}

function renderKnowledgeReferenceList(items, renderItem) {
  if (!Array.isArray(items) || items.length === 0)
    return '<div class="knowledge-empty-inline">无</div>';
  return `
    <div class="knowledge-reference-list">
      ${items.map((item) => renderItem(item)).join('')}
    </div>
  `;
}

function renderKnowledgeDetailHtml(title, metaLines, sectionsHtml, actions) {
  if (knowledgeDetailTitle) knowledgeDetailTitle.textContent = title;
  if (knowledgeDetailMeta) {
    knowledgeDetailMeta.innerHTML = metaLines
      .map((line) => `<span class="trace-monitor-pill">${line}</span>`)
      .join('');
  }
  renderKnowledgeDetailActions(actions);
  if (knowledgeDetailContent) {
    knowledgeDetailContent.innerHTML = sectionsHtml;
  }
  if (knowledgeDetailEmpty) knowledgeDetailEmpty.classList.add('hidden');
  if (knowledgeDetail) knowledgeDetail.classList.remove('hidden');
}

function renderKnowledgeDiffMetric(label, count, tone) {
  return `
    <div class="knowledge-diff-card">
      <span class="knowledge-diff-pill ${escapeAttribute(tone || 'neutral')}">${escapeHtml(label)}</span>
      <strong>${escapeHtml(String(count))}</strong>
    </div>
  `;
}

function renderKnowledgeMaterialIdList(ids) {
  if (!Array.isArray(ids) || ids.length === 0)
    return '<div class="knowledge-empty-inline">无</div>';
  return `
    <div class="knowledge-chip-list">
      ${ids.map((id) => `<span class="knowledge-chip">${escapeHtml(id)}</span>`).join('')}
    </div>
  `;
}

function renderKnowledgeSection(title, bodyHtml, options = {}) {
  const bodyClass =
    typeof options.bodyClass === 'string' && options.bodyClass.trim()
      ? ` ${options.bodyClass.trim()}`
      : '';
  const note =
    typeof options.note === 'string' && options.note.trim()
      ? `<span class="knowledge-detail-section-note">${escapeHtml(options.note.trim())}</span>`
      : '';
  return `
    <section class="knowledge-detail-section">
      <div class="knowledge-detail-section-head">
        <h3>${escapeHtml(title || '详情')}</h3>
        ${note}
      </div>
      <div class="knowledge-detail-body${bodyClass}">
        ${bodyHtml}
      </div>
    </section>
  `;
}

function renderKnowledgeTextBody(text, emptyText = '无') {
  const value = String(text || '').trim();
  return `<div class="knowledge-detail-prose${value ? '' : ' empty'}">${escapeHtml(value || emptyText)}</div>`;
}

function renderKnowledgeRawTextBody(text) {
  return `<pre class="knowledge-detail-pre">${escapeHtml(text || '')}</pre>`;
}

function renderKnowledgePageContentSection(title, contentMarkdown) {
  return renderKnowledgeSection(
    title || '正文',
    renderKnowledgeRawTextBody(contentMarkdown || ''),
    { bodyClass: 'knowledge-detail-body-code' },
  );
}

function renderKnowledgeCardList(items, renderItem, emptyText = '无') {
  if (!Array.isArray(items) || items.length === 0) {
    return `<div class="knowledge-empty-inline">${escapeHtml(emptyText)}</div>`;
  }
  return `
    <div class="knowledge-detail-card-list">
      ${items.map((item) => `<div class="knowledge-detail-card">${renderItem(item)}</div>`).join('')}
    </div>
  `;
}

function renderKnowledgeClaimPreviewList(items, kind) {
  if (!Array.isArray(items) || items.length === 0)
    return '<div class="knowledge-empty-inline">无</div>';
  return `
    <div class="knowledge-diff-list">
      ${items
        .map((item) => {
          const previousStatement =
            item.previous_statement &&
            item.previous_statement !== item.statement
              ? `<div class="knowledge-diff-item-prev">Before: ${escapeHtml(item.previous_statement)}</div>`
              : '';
          const meta = [
            item.claim_type || 'claim',
            item.canonical_form || '',
            item.confidence === null || item.confidence === undefined
              ? ''
              : `confidence=${item.confidence}`,
          ].filter(Boolean);
          return `
          <div class="knowledge-diff-item ${escapeAttribute(kind || 'neutral')}">
            <div class="knowledge-diff-item-head">
              <span class="knowledge-diff-pill ${escapeAttribute(kind || 'neutral')}">${escapeHtml(kind || '变更')}</span>
              <span class="knowledge-diff-item-meta">${escapeHtml(meta.join(' · '))}</span>
            </div>
            ${previousStatement}
            <div class="knowledge-diff-item-main">${escapeHtml(item.statement || '')}</div>
          </div>
        `;
        })
        .join('')}
    </div>
  `;
}

function renderKnowledgeRelationPreviewList(items, kind) {
  if (!Array.isArray(items) || items.length === 0)
    return '<div class="knowledge-empty-inline">无</div>';
  return `
    <div class="knowledge-diff-list">
      ${items
        .map((item) => {
          const previousRationale =
            item.previous_rationale &&
            item.previous_rationale !== item.rationale
              ? `<div class="knowledge-diff-item-prev">Before: ${escapeHtml(item.previous_rationale)}</div>`
              : '';
          return `
          <div class="knowledge-diff-item ${escapeAttribute(kind || 'neutral')}">
            <div class="knowledge-diff-item-head">
              <span class="knowledge-diff-pill ${escapeAttribute(kind || 'neutral')}">${escapeHtml(kind || '变更')}</span>
              <span class="knowledge-diff-item-meta">${escapeHtml(`${item.relation_type || 'related_to'} -> ${item.to_page_slug || ''}`)}</span>
            </div>
            ${previousRationale}
            <div class="knowledge-diff-item-main">${escapeHtml(item.rationale || '无 rationale')}</div>
          </div>
        `;
        })
        .join('')}
    </div>
  `;
}

function renderKnowledgeContentDiff(contentDiff) {
  if (!contentDiff) return '<div class="knowledge-empty-inline">无</div>';
  const changedBlocks = Array.isArray(contentDiff.blocks)
    ? contentDiff.blocks.filter((block) => block.kind !== 'unchanged')
    : [];
  if (!changedBlocks.length) {
    return '<div class="muted">正文无段落级变化</div>';
  }
  return `
    <div class="knowledge-diff-list">
      ${changedBlocks
        .map((block) => {
          const previousText =
            block.kind === 'updated' && block.previous_text
              ? `<div class="knowledge-diff-item-prev">Before:</div><div class="knowledge-diff-item-block previous">${escapeHtml(block.previous_text || '')}</div>`
              : '';
          return `
          <div class="knowledge-diff-item ${escapeAttribute(block.kind || 'neutral')}">
            <div class="knowledge-diff-item-head">
              <span class="knowledge-diff-pill ${escapeAttribute(block.kind || 'neutral')}">${escapeHtml(block.kind || 'change')}</span>
            </div>
            ${previousText}
            ${block.kind === 'updated' ? '<div class="knowledge-diff-item-prev">After:</div>' : ''}
            <div class="knowledge-diff-item-block">${escapeHtml(block.text || '')}</div>
          </div>
        `;
        })
        .join('')}
    </div>
  `;
}

function renderKnowledgeDraftPublishPreview(preview) {
  if (!preview) return '';
  const pageChanges = Array.isArray(
    [
      preview.page_changes?.title ? '标题' : '',
      preview.page_changes?.page_kind ? '页面类型' : '',
      preview.page_changes?.summary ? '摘要' : '',
      preview.page_changes?.content_markdown ? '正文' : '',
    ].filter(Boolean),
  )
    ? [
        preview.page_changes?.title ? '标题' : '',
        preview.page_changes?.page_kind ? '页面类型' : '',
        preview.page_changes?.summary ? '摘要' : '',
        preview.page_changes?.content_markdown ? '正文' : '',
      ].filter(Boolean)
    : [];
  const modeLabel = preview.mode === 'create' ? '新建页面' : '更新现有页面';
  const existingPage = preview.existing_page || null;
  return renderKnowledgeSection(
    '发布预览',
    `
      <div class="knowledge-diff-summary">
        <div class="knowledge-diff-summary-line">
          <span class="knowledge-diff-pill ${preview.mode === 'create' ? 'added' : 'updated'}">${escapeHtml(modeLabel)}</span>
          <span>${existingPage ? `当前页面：${escapeHtml(existingPage.title || existingPage.slug || '')}` : '当前尚无已发布页面'}</span>
        </div>
        <div class="knowledge-diff-summary-line">
          <span>页面字段变化：</span>
          <span>${pageChanges.length ? escapeHtml(pageChanges.join(' / ')) : '无'}</span>
        </div>
      </div>
      <div class="knowledge-diff-grid">
        ${renderKnowledgeDiffMetric('新增陈述', preview.claims?.added?.length || 0, 'added')}
        ${renderKnowledgeDiffMetric('更新陈述', preview.claims?.updated?.length || 0, 'updated')}
        ${renderKnowledgeDiffMetric('移除陈述', preview.claims?.removed?.length || 0, 'removed')}
        ${renderKnowledgeDiffMetric('保留陈述', preview.claims?.unchanged?.length || 0, 'neutral')}
        ${renderKnowledgeDiffMetric('新增段落', preview.content_diff?.added_count || 0, 'added')}
        ${renderKnowledgeDiffMetric('更新段落', preview.content_diff?.updated_count || 0, 'updated')}
        ${renderKnowledgeDiffMetric('移除段落', preview.content_diff?.removed_count || 0, 'removed')}
      </div>
      <div class="knowledge-detail-subsection">
        <strong>正文变化</strong>
        <div class="knowledge-diff-summary-line">
          <span>保留段落：</span>
          <span>${escapeHtml(String(preview.content_diff?.unchanged_count || 0))}</span>
        </div>
        ${renderKnowledgeContentDiff(preview.content_diff)}
      </div>
      <div class="knowledge-detail-subsection">
        <strong>新增资料</strong>
        ${renderKnowledgeMaterialIdList(preview.materials?.added_material_ids || [])}
      </div>
      <div class="knowledge-detail-subsection">
        <strong>移除资料</strong>
        ${renderKnowledgeMaterialIdList(preview.materials?.removed_material_ids || [])}
      </div>
      <div class="knowledge-detail-subsection">
        <strong>新增陈述</strong>
        ${renderKnowledgeClaimPreviewList(preview.claims?.added || [], 'added')}
      </div>
      <div class="knowledge-detail-subsection">
        <strong>更新陈述</strong>
        ${renderKnowledgeClaimPreviewList(preview.claims?.updated || [], 'updated')}
      </div>
      <div class="knowledge-detail-subsection">
        <strong>移除陈述</strong>
        ${renderKnowledgeClaimPreviewList(preview.claims?.removed || [], 'removed')}
      </div>
      <div class="knowledge-detail-subsection">
        <strong>新增关系</strong>
        ${renderKnowledgeRelationPreviewList(preview.relations?.added || [], 'added')}
      </div>
      <div class="knowledge-detail-subsection">
        <strong>移除关系</strong>
        ${renderKnowledgeRelationPreviewList(preview.relations?.removed || [], 'removed')}
      </div>
    `,
    { bodyClass: 'knowledge-detail-body-rich knowledge-detail-body-accent' },
  );
}

async function openKnowledgeMaterialDetail(materialId) {
  try {
    const res = await apiFetch(
      `/api/wiki/material?id=${encodeURIComponent(materialId)}`,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const material = data.material;
    const usage = data.usage || {};
    currentKnowledgeDetail = { type: 'material', id: materialId };
    currentKnowledgeDraftId = '';
    currentKnowledgePageSlug = '';
    renderKnowledgeMaterials();
    renderKnowledgeDrafts();
    renderKnowledgePages();
    renderKnowledgeDetailHtml(
      material.title || material.id,
      [
        `<strong>资料</strong>${escapeHtml(material.id)}`,
        `<strong>来源</strong>${escapeHtml(material.source_kind || '--')}`,
        `<strong>删除</strong>${escapeHtml(usage.can_delete ? '可删除' : '有依赖')}`,
        `<strong>创建时间</strong>${escapeHtml(formatDateTime(material.created_at))}`,
      ],
      `
        ${renderKnowledgeSection('说明', renderKnowledgeTextBody(material.note || '无'))}
        ${renderKnowledgeSection(
          '引用状态',
          `
          <div class="knowledge-diff-grid">
            ${renderKnowledgeDiffMetric('引用页面', (usage.page_refs || []).length, (usage.page_refs || []).length ? 'updated' : 'neutral')}
            ${renderKnowledgeDiffMetric('关联草稿', (usage.draft_refs || []).length, (usage.draft_refs || []).length ? 'updated' : 'neutral')}
            ${renderKnowledgeDiffMetric('排队任务', (usage.job_refs || []).length, (usage.job_refs || []).length ? 'updated' : 'neutral')}
            ${renderKnowledgeDiffMetric('证据片段', usage.evidence_count || 0, usage.evidence_count || 0 ? 'updated' : 'neutral')}
          </div>
          <div class="knowledge-detail-subsection">
            <strong>被这些页面使用</strong>
            ${renderKnowledgeReferenceList(
              usage.page_refs || [],
              (item) => `
              <div class="knowledge-reference-card">
                <strong>${escapeHtml(item.title || item.slug || '')}</strong>
                <div class="knowledge-reference-card-meta">slug: ${escapeHtml(item.slug || '')}</div>
              </div>
            `,
            )}
          </div>
          <div class="knowledge-detail-subsection">
            <strong>被这些草稿引用</strong>
            ${renderKnowledgeReferenceList(
              usage.draft_refs || [],
              (item) => `
              <div class="knowledge-reference-card">
                <strong>${escapeHtml(item.title || item.id || '')}</strong>
                <div class="knowledge-reference-card-meta">${escapeHtml([item.id, item.target_slug, item.status].filter(Boolean).join(' · '))}</div>
              </div>
            `,
            )}
          </div>
          <div class="knowledge-detail-subsection">
            <strong>被这些后台任务占用</strong>
            ${renderKnowledgeReferenceList(
              usage.job_refs || [],
              (item) => `
              <div class="knowledge-reference-card">
                <strong>${escapeHtml(item.id || '')}</strong>
                <div class="knowledge-reference-card-meta">${escapeHtml([item.job_type, item.status].filter(Boolean).join(' · '))}</div>
              </div>
            `,
            )}
          </div>
          ${
            usage.can_delete
              ? '<div class="muted">当前没有页面、草稿或运行中任务依赖这份资料。</div>'
              : '<div class="knowledge-detail-warning">这份资料仍被知识库引用。要删除它，先删除相关草稿，或让页面改用其他资料后再重试。</div>'
          }
          `,
          {
            bodyClass:
              'knowledge-detail-body-rich knowledge-detail-body-accent',
          },
        )}
        ${renderKnowledgeSection(
          '原始文本',
          renderKnowledgeRawTextBody(data.extracted_text || ''),
          { bodyClass: 'knowledge-detail-body-code' },
        )}
      `,
      [
        {
          label: '删除资料',
          kind: 'ghost',
          tone: 'danger',
          disabled: !usage.can_delete,
          title: usage.can_delete
            ? '删除当前资料'
            : '仍有页面、草稿或任务依赖这份资料',
          onClick: () => {
            void deleteKnowledgeMaterial(
              materialId,
              material.title || material.id,
            );
          },
        },
      ],
    );
  } catch (err) {
    console.error('Failed to load wiki material:', err);
    showToast(
      `资料详情加载失败：${err instanceof Error ? err.message : '未知错误'}`,
    );
  }
}

async function fetchKnowledgeDraftDetail(draftId) {
  const res = await apiFetch(
    `/api/wiki/draft?id=${encodeURIComponent(draftId)}`,
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function openKnowledgeDraftDetail(draftId) {
  try {
    const detail = await fetchKnowledgeDraftDetail(draftId);
    currentKnowledgeDetail = { type: 'draft', id: draftId };
    currentKnowledgeDraftId = draftId;
    currentKnowledgePageSlug = '';
    renderKnowledgeDrafts();
    renderKnowledgePages();
    renderKnowledgeMaterials();
    const claims = Array.isArray(detail.compiled?.claims)
      ? detail.compiled.claims
      : [];
    const materials = Array.isArray(detail.materials) ? detail.materials : [];
    const publishPreview = detail.publish_preview || null;
    renderKnowledgeDetailHtml(
      detail.draft.title || detail.draft.target_slug,
      [
        `<strong>草稿</strong>${escapeHtml(detail.draft.id)}`,
        `<strong>页面 slug</strong>${escapeHtml(detail.draft.target_slug || '--')}`,
        `<strong>页面类型</strong>${escapeHtml(detail.draft.page_kind || '--')}`,
        `<strong>状态</strong>${escapeHtml(detail.draft.status || 'draft')}`,
      ],
      `
        ${renderKnowledgeSection('摘要', renderKnowledgeTextBody(detail.draft.summary || '无摘要'))}
        ${renderKnowledgeSection(
          '引用资料',
          renderKnowledgeCardList(
            materials,
            (item) => `
              <div class="knowledge-detail-card-title">${escapeHtml(item.title || item.id)}</div>
              <div class="knowledge-detail-card-meta">${escapeHtml(item.id || '')}</div>
            `,
          ),
        )}
        ${renderKnowledgeSection(
          '知识陈述',
          renderKnowledgeCardList(
            claims,
            (claim) => `
              <div class="knowledge-detail-card-label">${escapeHtml(claim.claim_type || '陈述')}</div>
              <div class="knowledge-detail-card-title">${escapeHtml(claim.statement || '')}</div>
              <div class="knowledge-detail-card-meta">${escapeHtml(claim.canonical_form || '')}</div>
            `,
          ),
          { bodyClass: 'knowledge-detail-body-rich' },
        )}
        ${renderKnowledgeDraftPublishPreview(publishPreview)}
        ${renderKnowledgePageContentSection(
          '正文',
          detail.compiled?.page?.content_markdown ||
            detail.draft.content_markdown ||
            '',
        )}
      `,
      [
        detail.draft.status === 'published'
          ? null
          : {
              label: '发布草稿',
              kind: 'primary',
              onClick: () => {
                void publishSelectedKnowledgeDraft();
              },
            },
        {
          label: '删除草稿',
          kind: 'ghost',
          tone: 'danger',
          onClick: () => {
            void deleteKnowledgeDraft(
              draftId,
              detail.draft.title || detail.draft.id,
            );
          },
        },
      ].filter(Boolean),
    );
  } catch (err) {
    console.error('Failed to load wiki draft:', err);
    showToast(
      `草稿详情加载失败：${err instanceof Error ? err.message : '未知错误'}`,
    );
  }
}

async function openKnowledgePageDetail(pageSlug) {
  try {
    const res = await apiFetch(
      `/api/wiki/page?slug=${encodeURIComponent(pageSlug)}`,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    currentKnowledgeDetail = { type: 'page', id: pageSlug };
    currentKnowledgeDraftId = '';
    currentKnowledgePageSlug = pageSlug;
    renderKnowledgeDrafts();
    renderKnowledgePages();
    renderKnowledgeMaterials();
    const claimRows = Array.isArray(data.claims) ? data.claims : [];
    const relationRows = Array.isArray(data.relations) ? data.relations : [];
    const materialRows = Array.isArray(data.materials) ? data.materials : [];
    const incomingRelationRows = Array.isArray(data.incoming_relations)
      ? data.incoming_relations
      : [];
    renderKnowledgeDetailHtml(
      data.page.title || data.page.slug,
      [
        `<strong>页面</strong>${escapeHtml(data.page.slug)}`,
        `<strong>页面类型</strong>${escapeHtml(data.page.page_kind || '--')}`,
        `<strong>更新时间</strong>${escapeHtml(formatDateTime(data.page.updated_at))}`,
      ],
      `
        ${renderKnowledgeSection('摘要', renderKnowledgeTextBody(data.page.summary || '无摘要'))}
        ${renderKnowledgePageContentSection('正文', data.page.content_markdown || '')}
        ${renderKnowledgeSection(
          '知识陈述',
          renderKnowledgeCardList(
            claimRows,
            (claim) => `
              <div class="knowledge-detail-card-label">${escapeHtml(claim.claim_type || '陈述')}</div>
              <div class="knowledge-detail-card-title">${escapeHtml(claim.statement || '')}</div>
              <div class="knowledge-detail-card-meta">${escapeHtml((claim.evidence || []).length ? `证据 ${(claim.evidence || []).length} 条` : '暂无证据')}</div>
            `,
          ),
          { bodyClass: 'knowledge-detail-body-rich' },
        )}
        ${renderKnowledgeSection(
          '引用资料',
          renderKnowledgeCardList(
            materialRows,
            (item) => `
              <div class="knowledge-detail-card-title">${escapeHtml(item.title || item.id)}</div>
              <div class="knowledge-detail-card-meta">${escapeHtml(item.id || '')}</div>
            `,
          ),
        )}
        ${renderKnowledgeSection(
          '关联关系',
          renderKnowledgeCardList(
            relationRows,
            (relation) => `
              <div class="knowledge-detail-card-label">${escapeHtml(relation.relation_type || 'related_to')}</div>
              <div class="knowledge-detail-card-title">${escapeHtml(relation.to_page_slug || '未指定目标')}</div>
              <div class="knowledge-detail-card-meta">${escapeHtml(relation.rationale || '无补充说明')}</div>
            `,
          ),
        )}
        ${renderKnowledgeSection(
          '被这些页面引用',
          `
          ${renderKnowledgeReferenceList(
            incomingRelationRows,
            (relation) => `
            <div class="knowledge-reference-card">
              <strong>${escapeHtml(relation.from_page_title || relation.from_page_slug || '')}</strong>
              <div class="knowledge-reference-card-meta">${escapeHtml(`${relation.relation_type || 'related_to'} -> ${relation.to_page_slug || ''}`)}</div>
            </div>
          `,
          )}
          ${
            incomingRelationRows.length
              ? `<div class="knowledge-detail-warning">删除此页面时，会一并移除其他页面指向它的 ${escapeHtml(String(incomingRelationRows.length))} 条关系。</div>`
              : ''
          }
          `,
          {
            bodyClass:
              'knowledge-detail-body-rich knowledge-detail-body-accent',
          },
        )}
      `,
      [
        {
          label: '删除页面',
          kind: 'ghost',
          tone: 'danger',
          onClick: () => {
            void deleteKnowledgePage(pageSlug, {
              title: data.page.title || data.page.slug,
              claimCount: claimRows.length,
              materialCount: materialRows.length,
              outgoingRelationCount: relationRows.length,
              incomingRelationCount: incomingRelationRows.length,
            });
          },
        },
      ],
    );
  } catch (err) {
    console.error('Failed to load wiki page:', err);
    showToast(
      `页面详情加载失败：${err instanceof Error ? err.message : '未知错误'}`,
    );
  }
}

async function loadKnowledgeMaterials() {
  const res = await apiFetch('/api/wiki/materials');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  knowledgeMaterials = Array.isArray(data.materials) ? data.materials : [];
  pruneKnowledgeMaterialSelection();
  renderKnowledgeMaterials();
}

async function loadKnowledgeDrafts() {
  const res = await apiFetch('/api/wiki/drafts');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  knowledgeDrafts = Array.isArray(data.drafts) ? data.drafts : [];
  pruneKnowledgeDraftSelection();
  renderKnowledgeDrafts();
}

async function loadKnowledgePages(queryOverride) {
  const query =
    typeof queryOverride === 'string'
      ? queryOverride.trim()
      : (knowledgeSearchInput?.value || '').trim();
  const endpoint = query
    ? `/api/wiki/search?q=${encodeURIComponent(query)}`
    : '/api/wiki/pages';
  const res = await apiFetch(endpoint);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  knowledgePages = Array.isArray(data.pages)
    ? data.pages
    : Array.isArray(data.results)
      ? data.results
      : [];
  refreshKnowledgePageKindFilterOptions();
  renderKnowledgePages();
}

async function loadKnowledgeJobs() {
  try {
    const res = await apiFetch('/api/wiki/jobs');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    knowledgeJobs = Array.isArray(data.jobs) ? data.jobs : [];
    renderKnowledgeJobs();

    if (
      knowledgeJobs.some(
        (job) => job.status === 'completed' || job.status === 'failed',
      )
    ) {
      await Promise.all([loadKnowledgeDrafts(), loadKnowledgePages()]);
    }
  } catch (err) {
    console.error('Failed to load wiki jobs:', err);
  }
}

async function loadKnowledgeBaseData(options = {}) {
  try {
    await Promise.all([
      loadKnowledgeMaterials(),
      loadKnowledgeDrafts(),
      loadKnowledgePages(),
      loadKnowledgeJobs(),
    ]);
    if (options.preserveDetail && currentKnowledgeDetail) {
      if (currentKnowledgeDetail.type === 'material') {
        await openKnowledgeMaterialDetail(currentKnowledgeDetail.id);
      } else if (currentKnowledgeDetail.type === 'draft') {
        await openKnowledgeDraftDetail(currentKnowledgeDetail.id);
      } else if (currentKnowledgeDetail.type === 'page') {
        await openKnowledgePageDetail(currentKnowledgeDetail.id);
      }
    } else if (!currentKnowledgeDetail) {
      clearKnowledgeDetail();
    }
  } catch (err) {
    console.error('Failed to load knowledge base:', err);
    showToast(
      `知识库加载失败：${err instanceof Error ? err.message : '未知错误'}`,
    );
  }
}

function closeKnowledgeImportMenu() {
  if (knowledgeImportMenuCloseHandler) {
    document.removeEventListener('click', knowledgeImportMenuCloseHandler);
    knowledgeImportMenuCloseHandler = null;
  }
  if (knowledgeImportMenu) {
    knowledgeImportMenu.remove();
    knowledgeImportMenu = null;
  }
  if (knowledgeImportBtn) {
    knowledgeImportBtn.setAttribute('aria-expanded', 'false');
  }
}

function showKnowledgeImportMenu() {
  if (!knowledgeImportBtn) return;
  if (knowledgeImportMenu) {
    closeKnowledgeImportMenu();
    return;
  }

  document.querySelector('.context-menu')?.remove();

  const menu = document.createElement('div');
  menu.className = 'context-menu';

  const items = [
    {
      label: '导入文本',
      icon: '📝',
      action: () => {
        closeKnowledgeImportMenu();
        void importKnowledgeText();
      },
    },
    {
      label: '导入文件',
      icon: '📄',
      action: () => {
        closeKnowledgeImportMenu();
        knowledgeFileInput?.click();
      },
    },
  ];

  for (const item of items) {
    const el = document.createElement('div');
    el.className = 'context-menu-item';
    el.innerHTML = `<span class="context-menu-icon">${item.icon}</span>${escapeHtml(item.label)}`;
    el.addEventListener('click', item.action);
    menu.appendChild(el);
  }

  document.body.appendChild(menu);
  const rect = knowledgeImportBtn.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let left = rect.right;
  let top = rect.bottom;

  if (left < 8) left = 8;
  if (left + menuRect.width > window.innerWidth - 8) {
    left = Math.max(8, rect.right - menuRect.width);
  }
  if (top + menuRect.height > window.innerHeight - 8) {
    top = Math.max(8, rect.top - menuRect.height);
  }

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  knowledgeImportMenu = menu;
  knowledgeImportBtn.setAttribute('aria-expanded', 'true');

  knowledgeImportMenuCloseHandler = (ev) => {
    if (!knowledgeImportMenu) return;
    if (
      knowledgeImportMenu.contains(ev.target) ||
      knowledgeImportBtn.contains(ev.target)
    ) {
      return;
    }
    closeKnowledgeImportMenu();
  };

  requestAnimationFrame(() => {
    document.addEventListener('click', knowledgeImportMenuCloseHandler);
  });
}

function showKnowledgeMaterialContextMenu(e, material) {
  closeKnowledgeImportMenu();
  document.querySelector('.context-menu')?.remove();

  if (!knowledgeSelectedMaterialIds.has(material.id)) {
    knowledgeSelectedMaterialIds.add(material.id);
    renderKnowledgeMaterials();
  }

  const selectedMaterials = getSelectedKnowledgeMaterials();
  const deletableCount = selectedMaterials.filter((item) =>
    isKnowledgeMaterialDeletable(item),
  ).length;
  const blockedCount = Math.max(0, selectedMaterials.length - deletableCount);
  const menu = document.createElement('div');
  menu.className = 'context-menu knowledge-material-context-menu';
  menu.innerHTML = `
    <div class="knowledge-material-context-summary">
      <div class="knowledge-material-context-count">已选 ${escapeHtml(String(selectedMaterials.length))} 份资料</div>
      <div class="knowledge-material-context-list">
        ${selectedMaterials
          .map(
            (item) => `
          <div class="knowledge-material-context-name" title="${escapeAttribute(item.title || item.id)}">
            ${escapeHtml(item.title || item.id)}
          </div>
        `,
          )
          .join('')}
      </div>
      <div class="knowledge-material-context-note">
        ${escapeHtml(`可删除 ${deletableCount} 份${blockedCount ? ` · 有依赖 ${blockedCount} 份` : ''}`)}
      </div>
    </div>
  `;

  const items = [
    {
      label: '删除所选',
      icon: '🗑',
      disabled: deletableCount === 0,
      action: async () => {
        await bulkDeleteSelectedKnowledgeMaterials();
      },
    },
    {
      label: '基于所选生成草稿',
      icon: '📝',
      disabled: selectedMaterials.length === 0,
      action: async () => {
        await generateKnowledgeDraft();
      },
    },
  ];

  items.forEach((item) => {
    const el = document.createElement('div');
    el.className = `context-menu-item${item.disabled ? ' disabled' : ''}`;
    el.innerHTML = `<span class="context-menu-icon">${item.icon}</span>${escapeHtml(item.label)}`;
    if (!item.disabled) {
      el.addEventListener('click', async () => {
        menu.remove();
        await item.action();
      });
    }
    menu.appendChild(el);
  });

  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth)
    menu.style.left = `${window.innerWidth - rect.width - 8}px`;
  if (rect.bottom > window.innerHeight)
    menu.style.top = `${window.innerHeight - rect.height - 8}px`;

  const closeHandler = (event) => {
    if (!menu.contains(event.target)) {
      menu.remove();
      document.removeEventListener('click', closeHandler);
    }
  };
  requestAnimationFrame(() => document.addEventListener('click', closeHandler));
}

function openKnowledgeTextImportDialog() {
  const existing = document.getElementById('knowledge-text-import-overlay');
  if (existing) existing.remove();

  return new Promise((resolve) => {
    const state = {
      title: '',
      text: '',
    };
    let settled = false;

    const overlay = document.createElement('div');
    overlay.id = 'knowledge-text-import-overlay';
    overlay.className = 'workflow-wizard-overlay';
    overlay.innerHTML = `
      <div class="workflow-wizard-modal knowledge-text-import-modal" role="dialog" aria-modal="true" aria-labelledby="knowledge-text-import-title">
        <div class="workflow-wizard-header">
          <div class="workflow-wizard-header-copy">
            <div class="workflow-wizard-title-row">
              <div id="knowledge-text-import-title" class="workflow-wizard-title">导入文本资料</div>
            </div>
          </div>
          <button type="button" class="workflow-wizard-action-btn workflow-wizard-close" data-knowledge-text-import-close title="关闭" aria-label="关闭">
            <span class="workflow-wizard-btn-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M7 7l10 10"/><path d="M17 7L7 17"/></svg>
            </span>
          </button>
        </div>
        <div class="workflow-wizard-body workflow-wizard-body-split knowledge-text-import-body">
          <div class="workflow-wizard-main">
            <div class="workflow-wizard-section workflow-wizard-section-hero">
              <div class="workflow-wizard-hero-grid">
                <div>
                  <div class="workflow-wizard-hero-copy">文本会作为用户显式提供的资料进入知识库，后续可勾选资料生成草稿。</div>
                </div>
                <div class="workflow-wizard-metrics">
                  <div class="workflow-wizard-metric">
                    <span>资料来源</span>
                    <strong>文本</strong>
                  </div>
                  <div class="workflow-wizard-metric">
                    <span>资料标题</span>
                    <strong id="knowledge-text-import-title-metric">未命名资料</strong>
                  </div>
                  <div class="workflow-wizard-metric">
                    <span>正文字数</span>
                    <strong id="knowledge-text-import-count-metric">0</strong>
                  </div>
                </div>
              </div>
            </div>
            <div class="workflow-wizard-section">
              <div class="workflow-wizard-label">1. 资料标题</div>
              <div class="workflow-wizard-subsection">
                <label class="knowledge-text-import-field">
                  <input id="knowledge-text-import-name" class="workflow-wizard-input" type="text" placeholder="例如：项目部署说明" aria-label="资料标题" />
                </label>
              </div>
              <div class="workflow-wizard-field-help">标题可留空；留空时会以“未命名资料”导入。</div>
            </div>
            <div class="workflow-wizard-section">
              <div class="workflow-wizard-label">2. 资料正文</div>
              <div class="workflow-wizard-subsection">
                <label class="knowledge-text-import-field">
                  <textarea id="knowledge-text-import-content" class="workflow-wizard-input knowledge-text-import-textarea" rows="10" placeholder="粘贴要导入知识库的资料文本" aria-label="资料正文"></textarea>
                </label>
              </div>
              <div class="workflow-wizard-field-help">正文不能为空。提交后会保留原始换行和格式文本。</div>
            </div>
          </div>
          <aside class="workflow-wizard-sidebar-panel knowledge-text-import-sidebar">
            <div class="workflow-wizard-section workflow-wizard-summary-card">
              <div class="workflow-wizard-label">当前导入摘要</div>
              <div id="knowledge-text-import-summary" class="workflow-wizard-selection-list"></div>
            </div>
            <div id="knowledge-text-import-validation" class="workflow-wizard-section workflow-wizard-validation-card" data-state="warning">
              <div class="workflow-wizard-label">校验提示</div>
              <div id="knowledge-text-import-hint" class="workflow-wizard-hint"></div>
            </div>
          </aside>
        </div>
        <div class="workflow-wizard-footer">
          <div class="workflow-wizard-footer-meta">
            <div class="workflow-wizard-footer-label">Import material</div>
            <div id="knowledge-text-import-footer-status" class="workflow-wizard-footer-status">请先填写资料正文</div>
          </div>
          <div class="workflow-wizard-footer-actions">
            <button type="button" class="btn-ghost workflow-wizard-action-btn workflow-wizard-secondary-btn" data-knowledge-text-import-close>
              <span class="workflow-wizard-btn-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>
              </span>
              <span>取消</span>
            </button>
            <button type="button" class="btn-primary workflow-wizard-action-btn workflow-wizard-submit-btn" data-knowledge-text-import-submit disabled>
              <span class="workflow-wizard-btn-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>
              </span>
              <span>导入资料</span>
            </button>
          </div>
        </div>
      </div>
    `;

    const titleInput = overlay.querySelector('#knowledge-text-import-name');
    const textInput = overlay.querySelector('#knowledge-text-import-content');
    const titleMetricEl = overlay.querySelector(
      '#knowledge-text-import-title-metric',
    );
    const countMetricEl = overlay.querySelector(
      '#knowledge-text-import-count-metric',
    );
    const summaryEl = overlay.querySelector('#knowledge-text-import-summary');
    const validationCardEl = overlay.querySelector(
      '#knowledge-text-import-validation',
    );
    const hintEl = overlay.querySelector('#knowledge-text-import-hint');
    const footerStatusEl = overlay.querySelector(
      '#knowledge-text-import-footer-status',
    );
    const submitBtn = overlay.querySelector(
      '[data-knowledge-text-import-submit]',
    );

    function cleanup(result) {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(result);
    }

    function renderSummary() {
      const title = String(state.title || '').trim();
      const text = String(state.text || '');
      const trimmedText = text.trim();
      const charCount = Array.from(text).length;
      const lineCount = trimmedText
        ? trimmedText.split(/\r\n|\r|\n/).length
        : 0;
      const preview = trimmedText
        ? trimmedText.replace(/\s+/g, ' ').slice(0, 88)
        : '未填写';

      titleMetricEl.textContent = title || '未命名资料';
      countMetricEl.textContent = String(charCount);
      summaryEl.innerHTML = `
        <div class="workflow-wizard-selection-item">
          <span>资料标题</span>
          <strong>${escapeHtml(title || '未命名资料')}</strong>
        </div>
        <div class="workflow-wizard-selection-item">
          <span>正文长度</span>
          <strong>${escapeHtml(`${charCount} 字 · ${lineCount} 行`)}</strong>
        </div>
        <div class="workflow-wizard-selection-item">
          <span>内容预览</span>
          <strong>${escapeHtml(preview)}</strong>
        </div>
      `;

      if (trimmedText) {
        validationCardEl.dataset.state = 'success';
        hintEl.textContent = '资料正文已填写，可以导入知识库。';
        footerStatusEl.textContent = title
          ? '将按当前标题导入文本资料'
          : '将以“未命名资料”导入文本资料';
        submitBtn.disabled = false;
      } else {
        validationCardEl.dataset.state = 'warning';
        hintEl.textContent = '请先粘贴资料正文。';
        footerStatusEl.textContent = '请先填写资料正文';
        submitBtn.disabled = true;
      }
    }

    function syncState() {
      state.title = titleInput.value;
      state.text = textInput.value;
      renderSummary();
    }

    function handleSubmit() {
      syncState();
      const text = String(state.text || '');
      if (!text.trim()) {
        textInput.focus();
        return;
      }
      cleanup({
        title: String(state.title || '').trim() || '未命名资料',
        text,
      });
    }

    document.body.appendChild(overlay);
    renderSummary();
    titleInput.focus();

    [titleInput, textInput].forEach((input) => {
      input.addEventListener('input', syncState);
      input.addEventListener('change', syncState);
    });

    titleInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        textInput.focus();
      }
    });

    Array.from(
      overlay.querySelectorAll('[data-knowledge-text-import-close]'),
    ).forEach((button) => {
      button.addEventListener('click', () => cleanup(null));
    });
    submitBtn.addEventListener('click', handleSubmit);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) cleanup(null);
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cleanup(null);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        handleSubmit();
      }
    });
  });
}

async function importKnowledgeText() {
  const payload = await openKnowledgeTextImportDialog();
  if (!payload) return;

  try {
    const res = await apiFetch('/api/wiki/materials/import', {
      method: 'POST',
      body: JSON.stringify({
        title: payload.title,
        text: payload.text,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showToast('文本资料已导入');
    await loadKnowledgeMaterials();
  } catch (err) {
    console.error('Failed to import wiki text material:', err);
    showToast(`导入失败：${err instanceof Error ? err.message : '未知错误'}`);
  }
}

async function importKnowledgeFiles(files) {
  const mainGroup = getMainGroup();
  const jid = mainGroup?.jid || 'web:main';
  for (const file of Array.from(files || [])) {
    const formData = new FormData();
    formData.append('file', file);
    try {
      const uploadRes = await fetch(
        apiUrl(`/api/upload?jid=${encodeURIComponent(jid)}`),
        {
          method: 'POST',
          body: formData,
        },
      );
      const uploadData = await uploadRes.json().catch(() => ({}));
      if (!uploadRes.ok || !uploadData.files?.[0]?.hostPath) {
        throw new Error(uploadData.error || `HTTP ${uploadRes.status}`);
      }

      const importRes = await apiFetch('/api/wiki/materials/import', {
        method: 'POST',
        body: JSON.stringify({
          title: file.name,
          hostPath: uploadData.files[0].hostPath,
        }),
      });
      const importData = await importRes.json().catch(() => ({}));
      if (!importRes.ok) {
        throw new Error(importData.error || `HTTP ${importRes.status}`);
      }
      showToast(`已导入 ${file.name}`);
    } catch (err) {
      console.error('Failed to import wiki file material:', err);
      showToast(
        `文件导入失败：${file.name} · ${err instanceof Error ? err.message : '未知错误'}`,
      );
    }
  }
  await loadKnowledgeMaterials();
}

const KNOWLEDGE_PAGE_KIND_OPTIONS = Object.freeze([
  { value: 'project', label: 'project · 项目' },
  { value: 'concept', label: 'concept · 概念' },
  { value: 'decision', label: 'decision · 决策' },
  { value: 'procedure', label: 'procedure · 流程' },
  { value: 'person', label: 'person · 人物' },
  { value: 'glossary', label: 'glossary · 术语' },
]);

const KNOWLEDGE_PAGE_KIND_LABELS = Object.freeze(
  KNOWLEDGE_PAGE_KIND_OPTIONS.reduce((result, option) => {
    result[option.value] = option.label;
    return result;
  }, {}),
);

function normalizeKnowledgePageKind(value) {
  const normalized = String(value || '').trim();
  return KNOWLEDGE_PAGE_KIND_LABELS[normalized] ? normalized : 'project';
}

function summarizeKnowledgeDraftInstruction(text) {
  const raw = String(text || '').trim();
  if (!raw) return '未补充';
  const firstLine = raw.split(/\n+/).find((line) => line.trim()) || raw;
  return firstLine.length > 52 ? `${firstLine.slice(0, 52)}...` : firstLine;
}

async function openKnowledgeDraftGenerateDialog(options = {}) {
  const selectedMaterials = Array.isArray(options.selectedMaterials)
    ? options.selectedMaterials
    : [];
  const defaultTargetSlug = String(options.defaultTargetSlug || '').trim();
  const defaultTitle = String(options.defaultTitle || '').trim();
  const defaultPageKind = normalizeKnowledgePageKind(options.defaultPageKind);
  const visibleMaterials = selectedMaterials.slice(0, 8);
  const hiddenMaterialCount = Math.max(
    0,
    selectedMaterials.length - visibleMaterials.length,
  );
  const existing = document.getElementById('knowledge-draft-generate-overlay');
  if (existing) existing.remove();

  const materialListMarkup = visibleMaterials.length
    ? visibleMaterials
        .map((material) => {
          const meta = [
            String(material.source_kind || '').trim(),
            material.created_at ? formatDateTime(material.created_at) : '',
          ]
            .filter(Boolean)
            .join(' · ');
          return `
        <div class="knowledge-draft-generate-material-card">
          <div class="knowledge-draft-generate-material-title" title="${escapeAttribute(material.title || material.id)}">
            ${escapeHtml(material.title || material.id)}
          </div>
          <div class="knowledge-draft-generate-material-meta">${escapeHtml(meta || material.id || '--')}</div>
        </div>
      `;
        })
        .join('')
    : '<div class="knowledge-draft-generate-material-empty">当前没有可用资料</div>';

  return new Promise((resolve) => {
    const state = {
      targetSlug: defaultTargetSlug,
      title: defaultTitle,
      pageKind: defaultPageKind,
      instruction: '',
    };
    let settled = false;

    const overlay = document.createElement('div');
    overlay.id = 'knowledge-draft-generate-overlay';
    overlay.className = 'workflow-wizard-overlay';
    overlay.innerHTML = `
      <div class="workflow-wizard-modal knowledge-draft-generate-modal" role="dialog" aria-modal="true" aria-labelledby="knowledge-draft-generate-title">
        <div class="workflow-wizard-header">
          <div class="workflow-wizard-header-copy">
            <div class="workflow-wizard-kicker">Knowledge Base</div>
            <div class="workflow-wizard-title-row">
              <div id="knowledge-draft-generate-title" class="workflow-wizard-title">生成知识库草稿</div>
              <span class="workflow-wizard-header-badge">单次填写全部编纂选项</span>
            </div>
            <div class="workflow-wizard-header-desc">基于当前选中的资料直接发起后台编纂任务。页面标识、标题、类型与补充要求在一个弹窗里一次完成。</div>
          </div>
          <button type="button" class="workflow-wizard-action-btn workflow-wizard-close" data-knowledge-draft-close title="关闭" aria-label="关闭">
            <span class="workflow-wizard-btn-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M7 7l10 10"/><path d="M17 7L7 17"/></svg>
            </span>
          </button>
        </div>
        <div class="workflow-wizard-body workflow-wizard-body-split knowledge-draft-generate-body">
          <div class="workflow-wizard-main">
            <div class="workflow-wizard-section workflow-wizard-section-hero">
              <div class="workflow-wizard-hero-grid">
                <div>
                  <div class="workflow-wizard-label">编纂方式</div>
                  <div class="workflow-wizard-hero-title">用所选资料直接生成知识页草稿</div>
                  <div class="workflow-wizard-hero-copy">资料会作为唯一事实来源发送到后台编纂任务。<code>slug</code> 和标题可留空，系统会结合上下文自动推断。</div>
                </div>
                <div class="workflow-wizard-metrics">
                  <div class="workflow-wizard-metric">
                    <span>已选资料</span>
                    <strong>${escapeHtml(String(selectedMaterials.length))}</strong>
                  </div>
                  <div class="workflow-wizard-metric">
                    <span>默认 slug</span>
                    <strong>${escapeHtml(defaultTargetSlug || '自动')}</strong>
                  </div>
                  <div class="workflow-wizard-metric">
                    <span>默认类型</span>
                    <strong>${escapeHtml(KNOWLEDGE_PAGE_KIND_LABELS[defaultPageKind] || defaultPageKind)}</strong>
                  </div>
                </div>
              </div>
            </div>
            <div class="workflow-wizard-section">
              <div class="workflow-wizard-label">1. 页面基础信息</div>
              <div class="workflow-wizard-subsection knowledge-draft-generate-grid">
                <label class="knowledge-draft-generate-field">
                  <span>目标页面 slug</span>
                  <input id="knowledge-draft-target-slug" class="workflow-wizard-input" type="text" placeholder="例如：project-overview" value="${escapeAttribute(defaultTargetSlug)}" />
                </label>
                <label class="knowledge-draft-generate-field">
                  <span>页面标题</span>
                  <input id="knowledge-draft-title" class="workflow-wizard-input" type="text" placeholder="例如：项目总览" value="${escapeAttribute(defaultTitle)}" />
                </label>
                <label class="knowledge-draft-generate-field knowledge-draft-generate-field-wide">
                  <span>页面类型</span>
                  <select id="knowledge-draft-page-kind" class="workflow-wizard-select">
                    ${KNOWLEDGE_PAGE_KIND_OPTIONS.map(
                      (option) => `
                      <option value="${escapeAttribute(option.value)}"${option.value === defaultPageKind ? ' selected' : ''}>${escapeHtml(option.label)}</option>
                    `,
                    ).join('')}
                  </select>
                </label>
              </div>
              <div class="workflow-wizard-field-help"><code>slug</code> 和页面标题都是可选项；留空时会在编纂任务里根据资料内容自动生成。</div>
            </div>
            <div class="workflow-wizard-section">
              <div class="workflow-wizard-label">2. 补充编纂要求</div>
              <div class="workflow-wizard-subsection">
                <label class="knowledge-draft-generate-field">
                  <span>编纂要求</span>
                  <textarea id="knowledge-draft-instruction" class="workflow-wizard-input knowledge-draft-generate-textarea" rows="6" placeholder="例如：突出流程步骤，避免泛化描述"></textarea>
                </label>
              </div>
              <div class="workflow-wizard-field-help">这些要求会一并发给后台编纂任务，作为页面组织方式和输出重点的补充约束。</div>
            </div>
          </div>
          <aside class="workflow-wizard-sidebar-panel knowledge-draft-generate-sidebar">
            <div class="workflow-wizard-section workflow-wizard-summary-card">
              <div class="workflow-wizard-label">当前配置摘要</div>
              <div id="knowledge-draft-generate-summary" class="workflow-wizard-selection-list"></div>
            </div>
            <div class="workflow-wizard-section workflow-wizard-validation-card" data-state="success">
              <div class="workflow-wizard-label">已选资料</div>
              <div class="knowledge-draft-generate-material-list">
                ${materialListMarkup}
              </div>
              ${hiddenMaterialCount > 0 ? `<div class="workflow-wizard-field-help">另有 ${escapeHtml(String(hiddenMaterialCount))} 份资料未展开，提交后会一并参与编纂。</div>` : ''}
            </div>
          </aside>
        </div>
        <div class="workflow-wizard-footer">
          <div class="workflow-wizard-footer-meta">
            <div class="workflow-wizard-footer-label">Background job</div>
            <div id="knowledge-draft-generate-footer-status" class="workflow-wizard-footer-status">将创建后台编纂任务</div>
          </div>
          <div class="workflow-wizard-footer-actions">
            <button type="button" class="btn-ghost workflow-wizard-action-btn workflow-wizard-secondary-btn" data-knowledge-draft-close>
              <span class="workflow-wizard-btn-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>
              </span>
              <span>取消</span>
            </button>
            <button type="button" class="btn-primary workflow-wizard-action-btn workflow-wizard-submit-btn" data-knowledge-draft-submit>
              <span class="workflow-wizard-btn-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>
              </span>
              <span>创建草稿任务</span>
            </button>
          </div>
        </div>
      </div>
    `;

    const targetSlugInput = overlay.querySelector(
      '#knowledge-draft-target-slug',
    );
    const titleInput = overlay.querySelector('#knowledge-draft-title');
    const pageKindSelect = overlay.querySelector('#knowledge-draft-page-kind');
    const instructionInput = overlay.querySelector(
      '#knowledge-draft-instruction',
    );
    const summaryEl = overlay.querySelector(
      '#knowledge-draft-generate-summary',
    );
    const footerStatusEl = overlay.querySelector(
      '#knowledge-draft-generate-footer-status',
    );

    function cleanup(result) {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(result);
    }

    function renderSummary() {
      const targetSlug = String(state.targetSlug || '').trim();
      const title = String(state.title || '').trim();
      const pageKind = normalizeKnowledgePageKind(state.pageKind);
      const instruction = summarizeKnowledgeDraftInstruction(state.instruction);

      summaryEl.innerHTML = `
        <div class="workflow-wizard-selection-item">
          <span>资料数量</span>
          <strong>${escapeHtml(String(selectedMaterials.length))} 份</strong>
        </div>
        <div class="workflow-wizard-selection-item">
          <span>目标 slug</span>
          <strong>${escapeHtml(targetSlug || '自动生成')}</strong>
        </div>
        <div class="workflow-wizard-selection-item">
          <span>页面标题</span>
          <strong>${escapeHtml(title || '自动总结')}</strong>
        </div>
        <div class="workflow-wizard-selection-item">
          <span>页面类型</span>
          <strong>${escapeHtml(KNOWLEDGE_PAGE_KIND_LABELS[pageKind] || pageKind)}</strong>
        </div>
        <div class="workflow-wizard-selection-item">
          <span>编纂要求</span>
          <strong>${escapeHtml(instruction)}</strong>
        </div>
      `;

      if (targetSlug && title) {
        footerStatusEl.textContent =
          '将按当前 slug、标题与页面类型创建后台编纂任务';
      } else if (targetSlug) {
        footerStatusEl.textContent =
          '将使用当前 slug，其余页面信息由后台结合资料补全';
      } else if (title) {
        footerStatusEl.textContent =
          '将使用当前标题，slug 由后台结合资料自动生成';
      } else {
        footerStatusEl.textContent =
          '将依据所选资料自动推断标题与 slug，并创建后台编纂任务';
      }
    }

    function syncState() {
      state.targetSlug = targetSlugInput.value;
      state.title = titleInput.value;
      state.pageKind = pageKindSelect.value;
      state.instruction = instructionInput.value;
      renderSummary();
    }

    function handleSubmit() {
      cleanup({
        targetSlug: String(targetSlugInput.value || '').trim(),
        title: String(titleInput.value || '').trim(),
        pageKind: normalizeKnowledgePageKind(pageKindSelect.value),
        instruction: String(instructionInput.value || '').trim(),
      });
    }

    document.body.appendChild(overlay);
    renderSummary();
    titleInput.focus();
    titleInput.setSelectionRange(0, titleInput.value.length);

    [targetSlugInput, titleInput, pageKindSelect, instructionInput].forEach(
      (input) => {
        const eventName = input.tagName === 'SELECT' ? 'change' : 'input';
        input.addEventListener(eventName, syncState);
        if (eventName !== 'change') {
          input.addEventListener('change', syncState);
        }
      },
    );

    Array.from(
      overlay.querySelectorAll('[data-knowledge-draft-close]'),
    ).forEach((button) => {
      button.addEventListener('click', () => cleanup(null));
    });
    overlay
      .querySelector('[data-knowledge-draft-submit]')
      .addEventListener('click', handleSubmit);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) cleanup(null);
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cleanup(null);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        handleSubmit();
      }
    });
  });
}

async function generateKnowledgeDraft() {
  const selectedMaterials = getSelectedKnowledgeMaterials();
  const materialIds = selectedMaterials.map((material) => material.id);
  if (!selectedMaterials.length) {
    showToast('请先勾选至少一份资料');
    return;
  }

  const selectedDraft =
    knowledgeDrafts.find((draft) => draft.id === currentKnowledgeDraftId) ||
    null;
  const selectedPage =
    knowledgePages.find((page) => page.slug === currentKnowledgePageSlug) ||
    null;
  const defaultTargetSlug =
    selectedPage?.slug || selectedDraft?.target_slug || '';
  const defaultTitle = selectedPage?.title || selectedDraft?.title || '';
  const defaultPageKind = normalizeKnowledgePageKind(
    selectedPage?.page_kind || selectedDraft?.page_kind || 'project',
  );

  const payload = await openKnowledgeDraftGenerateDialog({
    selectedMaterials,
    defaultTargetSlug,
    defaultTitle,
    defaultPageKind,
  });
  if (!payload) return;

  try {
    const res = await apiFetch('/api/wiki/draft/generate', {
      method: 'POST',
      body: JSON.stringify({
        material_ids: materialIds,
        target_slug: payload.targetSlug,
        title: payload.title,
        page_kind: payload.pageKind,
        instruction: payload.instruction,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showToast('已创建后台编纂任务');
    await loadKnowledgeJobs();
  } catch (err) {
    console.error('Failed to generate wiki draft:', err);
    showToast(
      `生成草稿失败：${err instanceof Error ? err.message : '未知错误'}`,
    );
  }
}

async function publishSelectedKnowledgeDraft() {
  if (!currentKnowledgeDraftId) {
    showToast('请先在 Drafts 中选中一个草稿');
    return;
  }

  let detail;
  try {
    detail = await fetchKnowledgeDraftDetail(currentKnowledgeDraftId);
  } catch (err) {
    console.error('Failed to validate wiki draft before publish:', err);
    showToast(
      `发布前校验失败：${err instanceof Error ? err.message : '未知错误'}`,
    );
    return;
  }

  if (detail?.draft?.status === 'published') {
    showToast('该草稿已发布，无需重复操作');
    return;
  }

  const existingPage = detail?.publish_preview?.existing_page || null;
  const nextSlug = String(
    detail?.compiled?.page?.slug || detail?.draft?.target_slug || '',
  ).trim();
  const hasSlugConflict =
    detail?.publish_preview?.mode === 'update' && Boolean(existingPage);
  const confirmMessage = hasSlugConflict
    ? `检测到 slug「${nextSlug || existingPage.slug || '--'}」已存在。\n当前页面：${existingPage.title || existingPage.slug || '未命名页面'}\n\n继续发布将覆盖该页面的当前快照。是否继续？`
    : `确认发布草稿「${detail?.draft?.title || nextSlug || currentKnowledgeDraftId}」到知识库吗？`;
  const confirmed = await openConfirmDialog(confirmMessage, {
    title: hasSlugConflict ? '覆盖现有知识库页面' : '发布知识库页面',
    confirmText: hasSlugConflict ? '确认覆盖并发布' : '发布',
    actionsClassName: 'knowledge-detail-actions',
  });
  if (!confirmed) return;

  try {
    const res = await apiFetch('/api/wiki/draft/publish', {
      method: 'POST',
      body: JSON.stringify({ draft_id: currentKnowledgeDraftId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showToast('草稿已发布到知识库');
    await loadKnowledgeBaseData();
    if (data.page?.slug) {
      await openKnowledgePageDetail(data.page.slug);
    }
  } catch (err) {
    console.error('Failed to publish wiki draft:', err);
    showToast(`发布失败：${err instanceof Error ? err.message : '未知错误'}`);
  }
}

async function deleteKnowledgeDraft(draftId, draftTitle) {
  const confirmed = await openConfirmDialog(
    `删除草稿「${draftTitle || draftId}」？已发布页面不会受影响。`,
    {
      title: '删除知识草稿',
    },
  );
  if (!confirmed) return;

  try {
    const res = await apiFetch(
      `/api/wiki/draft?id=${encodeURIComponent(draftId)}`,
      {
        method: 'DELETE',
      },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    knowledgeSelectedDraftIds.delete(draftId);
    clearKnowledgeDetail();
    showToast('草稿已删除');
    await loadKnowledgeBaseData();
  } catch (err) {
    console.error('Failed to delete wiki draft:', err);
    showToast(
      `删除草稿失败：${err instanceof Error ? err.message : '未知错误'}`,
    );
  }
}

function selectVisibleKnowledgeDrafts() {
  getFilteredKnowledgeDrafts().forEach((draft) => {
    if (draft.status !== 'published') {
      knowledgeSelectedDraftIds.add(draft.id);
    }
  });
  renderKnowledgeDrafts();
}

function clearKnowledgeDraftSelection() {
  knowledgeSelectedDraftIds.clear();
  renderKnowledgeDrafts();
}

async function bulkDeleteSelectedKnowledgeDrafts() {
  const selectedDrafts = knowledgeDrafts.filter(
    (draft) =>
      knowledgeSelectedDraftIds.has(draft.id) && draft.status !== 'published',
  );
  if (!selectedDrafts.length) {
    showToast('请先勾选至少一个未发布草稿');
    return;
  }

  const confirmed = await openConfirmDialog(
    `批量删除 ${selectedDrafts.length} 个未发布草稿？已发布页面不会受影响。`,
    { title: '批量删除知识草稿' },
  );
  if (!confirmed) return;

  try {
    const res = await apiFetch('/api/wiki/drafts/bulk-delete', {
      method: 'POST',
      body: JSON.stringify({
        draft_ids: selectedDrafts.map((draft) => draft.id),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const deletedIds = Array.isArray(data.deleted_ids) ? data.deleted_ids : [];
    const skippedPublishedIds = Array.isArray(data.skipped_published_ids)
      ? data.skipped_published_ids
      : [];
    deletedIds.forEach((draftId) => {
      knowledgeSelectedDraftIds.delete(draftId);
    });
    clearKnowledgeDetail();
    showToast(
      skippedPublishedIds.length
        ? `已删除 ${deletedIds.length} 份草稿，跳过 ${skippedPublishedIds.length} 份已发布草稿`
        : `已删除 ${deletedIds.length} 份草稿`,
      2200,
    );
    await loadKnowledgeBaseData();
  } catch (err) {
    console.error('Failed to bulk delete wiki drafts:', err);
    showToast(
      `批量删除草稿失败：${err instanceof Error ? err.message : '未知错误'}`,
    );
  }
}

async function bulkDeleteSelectedKnowledgeMaterials() {
  const selectedMaterials = getSelectedKnowledgeMaterials();
  if (!selectedMaterials.length) {
    showToast('请先勾选至少一份资料');
    return;
  }

  const deletableMaterials = selectedMaterials.filter((material) =>
    isKnowledgeMaterialDeletable(material),
  );
  const blockedMaterials = selectedMaterials.filter(
    (material) => !isKnowledgeMaterialDeletable(material),
  );
  if (!deletableMaterials.length) {
    showToast('所选资料当前都有依赖，暂时无法删除');
    return;
  }

  const confirmed = await openConfirmDialog(
    `删除所选 ${selectedMaterials.length} 份资料？${blockedMaterials.length ? `其中 ${blockedMaterials.length} 份有依赖，将自动跳过。` : ''}`,
    { title: '批量删除知识资料' },
  );
  if (!confirmed) return;

  const results = await Promise.all(
    deletableMaterials.map(async (material) => {
      try {
        const res = await apiFetch(
          `/api/wiki/material?id=${encodeURIComponent(material.id)}`,
          {
            method: 'DELETE',
          },
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return { ok: true, material };
      } catch (err) {
        return {
          ok: false,
          material,
          error: err instanceof Error ? err.message : '未知错误',
        };
      }
    }),
  );

  const deletedMaterials = results
    .filter((result) => result.ok)
    .map((result) => result.material);
  const failedMaterials = results.filter((result) => !result.ok);

  deletedMaterials.forEach((material) => {
    knowledgeSelectedMaterialIds.delete(material.id);
  });

  const shouldPreserveDetail = !(
    currentKnowledgeDetail &&
    currentKnowledgeDetail.type === 'material' &&
    deletedMaterials.some(
      (material) => material.id === currentKnowledgeDetail.id,
    )
  );
  if (!shouldPreserveDetail) {
    clearKnowledgeDetail();
  }

  await loadKnowledgeBaseData({ preserveDetail: shouldPreserveDetail });

  const summary = [
    deletedMaterials.length ? `已删除 ${deletedMaterials.length} 份` : '',
    blockedMaterials.length
      ? `跳过 ${blockedMaterials.length} 份有依赖资料`
      : '',
    failedMaterials.length ? `失败 ${failedMaterials.length} 份` : '',
  ]
    .filter(Boolean)
    .join('，');

  if (summary) {
    showToast(summary, 2600);
  } else {
    showToast('没有删除任何资料');
  }
}

async function deleteKnowledgeMaterial(materialId, materialTitle) {
  const confirmed = await openConfirmDialog(
    `删除资料「${materialTitle || materialId}」？删除后若仍需使用，需要重新导入。`,
    {
      title: '删除知识资料',
    },
  );
  if (!confirmed) return;

  try {
    const res = await apiFetch(
      `/api/wiki/material?id=${encodeURIComponent(materialId)}`,
      {
        method: 'DELETE',
      },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    knowledgeSelectedMaterialIds.delete(materialId);
    clearKnowledgeDetail();
    showToast('资料已删除');
    await loadKnowledgeBaseData();
  } catch (err) {
    console.error('Failed to delete wiki material:', err);
    showToast(
      `删除资料失败：${err instanceof Error ? err.message : '未知错误'}`,
    );
  }
}

async function deleteKnowledgePage(pageSlug, options = {}) {
  const summary = [
    options.claimCount ? `Claim ${options.claimCount} 条` : '',
    options.materialCount ? `资料 ${options.materialCount} 份` : '',
    options.outgoingRelationCount
      ? `外连关系 ${options.outgoingRelationCount} 条`
      : '',
    options.incomingRelationCount
      ? `入链关系 ${options.incomingRelationCount} 条`
      : '',
  ]
    .filter(Boolean)
    .join('，');
  const confirmed = await openConfirmDialog(
    `删除页面「${options.title || pageSlug}」？${summary ? `将同时移除 ${summary}。` : '此操作不可撤销。'}`,
    { title: '删除知识页面' },
  );
  if (!confirmed) return;

  try {
    const res = await apiFetch(
      `/api/wiki/page?slug=${encodeURIComponent(pageSlug)}`,
      {
        method: 'DELETE',
      },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    clearKnowledgeDetail();
    showToast('页面已删除');
    await loadKnowledgeBaseData();
  } catch (err) {
    console.error('Failed to delete wiki page:', err);
    showToast(
      `删除页面失败：${err instanceof Error ? err.message : '未知错误'}`,
    );
  }
}

async function clearKnowledgeWiki() {
  const summary = [
    knowledgeMaterials.length ? `资料 ${knowledgeMaterials.length} 份` : '',
    knowledgeDrafts.length ? `草稿 ${knowledgeDrafts.length} 份` : '',
    knowledgePages.length ? `页面 ${knowledgePages.length} 个` : '',
    knowledgeJobs.length ? `任务 ${knowledgeJobs.length} 条` : '',
  ]
    .filter(Boolean)
    .join('，');
  const confirmed = await openConfirmDialog(
    `确认一键清除整个 LLM Wiki？${summary ? `将删除 ${summary}。` : '这会重置资料、草稿、页面和任务记录。'}此操作不可撤销。`,
    { title: '清除 LLM Wiki' },
  );
  if (!confirmed) return;

  closeKnowledgeImportMenu();

  try {
    const res = await apiFetch('/api/wiki/all', {
      method: 'DELETE',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    knowledgeSelectedMaterialIds.clear();
    knowledgeSelectedDraftIds.clear();
    clearKnowledgeDetail();
    await loadKnowledgeBaseData();

    const clearedSummary = [
      data.material_count ? `资料 ${data.material_count} 份` : '',
      data.draft_count ? `草稿 ${data.draft_count} 份` : '',
      data.page_count ? `页面 ${data.page_count} 个` : '',
      data.job_count ? `任务 ${data.job_count} 条` : '',
    ]
      .filter(Boolean)
      .join('，');
    showToast(
      clearedSummary
        ? `已清除 LLM Wiki（${clearedSummary}）`
        : 'LLM Wiki 已清空',
      2400,
    );
  } catch (err) {
    console.error('Failed to clear LLM wiki:', err);
    showToast(
      `清除 LLM Wiki 失败：${err instanceof Error ? err.message : '未知错误'}`,
    );
  }
}

async function deleteFinishedKnowledgeJobs() {
  const deletableJobs = knowledgeJobs.filter(
    (job) => job.status === 'completed' || job.status === 'failed',
  );
  if (!deletableJobs.length) {
    showToast('没有可删除的已完成/失败任务');
    return;
  }

  const confirmed = await openConfirmDialog(
    `确认删除 ${deletableJobs.length} 条已完成/失败任务记录吗？这不会影响已生成的草稿或页面。`,
    { title: '删除后台任务记录' },
  );
  if (!confirmed) return;

  try {
    const res = await apiFetch('/api/wiki/jobs/finished', {
      method: 'DELETE',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showToast(`已删除 ${data.deleted_count || 0} 条后台任务记录`);
    await loadKnowledgeJobs();
  } catch (err) {
    console.error('Failed to delete finished wiki jobs:', err);
    showToast(
      `删除后台任务记录失败：${err instanceof Error ? err.message : '未知错误'}`,
    );
  }
}

async function stopKnowledgeJob(jobId) {
  const job = knowledgeJobs.find((item) => item.id === jobId);
  if (!job) {
    showToast('未找到该后台任务');
    return;
  }
  if (job.status !== 'running') {
    showToast('仅支持停止运行中的后台任务');
    return;
  }

  const confirmed = await openConfirmDialog(
    `确认停止任务「${job.job_type || job.id}」吗？正在进行的知识库编纂会被中断。`,
    { title: '停止后台任务' },
  );
  if (!confirmed) return;

  stoppingKnowledgeJobIds.add(jobId);
  renderKnowledgeJobs();

  try {
    const res = await apiFetch('/api/wiki/job/stop', {
      method: 'POST',
      body: JSON.stringify({ job_id: jobId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showToast('已发送停止请求');
    await loadKnowledgeJobs();
  } catch (err) {
    console.error('Failed to stop wiki job:', err);
    stoppingKnowledgeJobIds.delete(jobId);
    renderKnowledgeJobs();
    showToast(
      `停止后台任务失败：${err instanceof Error ? err.message : '未知错误'}`,
    );
  }
}

async function runKnowledgeSearch() {
  try {
    await loadKnowledgePages(knowledgeSearchInput?.value || '');
  } catch (err) {
    console.error('Failed to search wiki pages:', err);
    showToast(
      `页面搜索失败：${err instanceof Error ? err.message : '未知错误'}`,
    );
  }
}

function stringifyPrettyJson(value) {
  return JSON.stringify(value === undefined ? null : value, null, 2);
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function countNewlines(text) {
  if (!text) return 0;
  return (text.match(/\n/g) || []).length;
}

function escapeAttribute(value) {
  return escapeHtml(String(value ?? '')).replace(/"/g, '&quot;');
}


function renderMessages() {
  clearSkeleton();
  if (messages.length === 0) {
    messagesEmpty.style.display = 'flex';
    messagesEmpty.innerHTML = '<span>Select a group to initiate session</span>';
    const existing2 = messagesEl.querySelectorAll('.message');
    existing2.forEach((el) => el.remove());
    return;
  }
  messagesEmpty.style.display = 'none';
  const existing = messagesEl.querySelectorAll('.message');
  existing.forEach((el) => el.remove());
  for (const msg of messages) {
    messagesEl.appendChild(createMessageEl(msg));
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Append a single message without full re-render
function appendSingleMessage(msg) {
  messagesEmpty.style.display = 'none';
  clearSkeleton();
  // Avoid duplicate
  if (messagesEl.querySelector(`[data-msg-id="${CSS.escape(msg.id)}"]`)) return;
  const el = createMessageEl(msg);
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function trimLiveMessageBuffer() {
  if (messages.length <= LIVE_MESSAGE_BUFFER_LIMIT) return 0;

  const removedMessages = messages.slice(
    0,
    messages.length - LIVE_MESSAGE_BUFFER_LIMIT,
  );
  const removedIds = new Set(removedMessages.map((msg) => msg.id));
  messages = messages.slice(-LIVE_MESSAGE_BUFFER_LIMIT);

  if (replyToMsg && removedIds.has(replyToMsg.id)) {
    clearReplyTo();
  }

  if (selectedMsgIds.size > 0) {
    removedIds.forEach((id) => selectedMsgIds.delete(id));
    updateMultiSelectBar();
  }

  return removedMessages.length;
}

function updateChatHeader() {
  if (!currentGroupJid) {
    chatGroupName.textContent = 'Select a group';
    chatGroupFolder.textContent = '';
    return;
  }
  const group = groups.find((g) => g.jid === currentGroupJid);
  if (group) {
    chatGroupName.textContent = group.name;
    chatGroupFolder.textContent = group.isMain ? '(main)' : `@ ${group.folder}`;
  }
}

function getCurrentGroup() {
  if (!currentGroupJid) return null;
  return groups.find((g) => g.jid === currentGroupJid) || null;
}

function isCurrentGroupMain() {
  return getCurrentGroup()?.isMain === true;
}

function getMainGroup() {
  return groups.find((group) => group.isMain) || null;
}

async function loadGroups() {
  try {
    const res = await apiFetch('/api/groups');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    groups = data.groups;
    renderGroups();
    if (!groups.some((g) => g.jid === activeMemoryGroupJid)) {
      activeMemoryGroupJid = getDefaultMemoryGroupJid();
    }
    renderMemoryGroups();
    renderMemoryList();
    if (activePrimaryNavKey === 'memory-management') {
      loadMemories();
    }
  } catch (err) {
    console.error('Failed to load groups:', err);
  }
}

async function resetAllSessions() {
  if (!resetAllSessionsBtn) return;
  const confirmed = await openConfirmDialog(
    '这会让所有群组在下一次新建对话时切换到全新 session。当前正在运行的任务不会被打断。继续吗？',
    { title: '重置 Session' },
  );
  if (!confirmed) return;

  resetAllSessionsBtn.classList.add('busy');
  resetAllSessionsBtn.disabled = true;
  try {
    const res = await apiFetch('/api/sessions/reset', {
      method: 'POST',
      body: JSON.stringify({ scope: 'all' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    const resetCount = Number(data.resetCount || 0);
    showToast(`已标记 ${resetCount} 个群组使用全新 session`);
    await loadGroups();
    if (currentGroupJid) {
      await loadMessages();
    }
  } catch (err) {
    console.error('Failed to reset sessions:', err);
    showToast(`切换失败：${err instanceof Error ? err.message : '未知错误'}`);
  } finally {
    resetAllSessionsBtn.classList.remove('busy');
    resetAllSessionsBtn.disabled = false;
  }
}

async function loadSchedulers() {
  try {
    const res = await apiFetch('/api/tasks');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    schedulersList.innerHTML = '';

    if (data.tasks.length === 0) {
      schedulersList.innerHTML = `<div class="schedulers-empty">No scheduled tasks</div>`;
      return;
    }

    // Group by group_folder
    const byGroup = {};
    for (const task of data.tasks) {
      const g = task.group_folder || 'Unknown';
      if (!byGroup[g]) byGroup[g] = [];
      byGroup[g].push(task);
    }

    for (const [group, tasks] of Object.entries(byGroup)) {
      const header = document.createElement('div');
      header.className = 'scheduler-group-header';
      header.textContent = group;
      schedulersList.appendChild(header);

      for (const task of tasks) {
        const el = document.createElement('div');
        el.className = 'scheduler-item';
        const status = task.status === 'active' ? 'active' : 'paused';
        const statusIcon = task.status === 'active' ? '\u25CF' : '\u25CB';
        const nextRun = task.next_run
          ? new Date(task.next_run).toLocaleString()
          : '—';
        const scheduleValue =
          task.schedule_type === 'once' && task.schedule_value
            ? new Date(task.schedule_value).toLocaleString()
            : task.schedule_value;
        el.innerHTML = `
          <div class="scheduler-prompt">${escapeHtml(task.prompt)}</div>
          <div class="scheduler-meta">
            <span class="scheduler-status ${status}">${statusIcon} ${task.status}</span>
            <span>${task.schedule_type}: ${scheduleValue}</span>
            <span>Next: ${nextRun}</span>
            <span class="scheduler-id">${escapeHtml(task.id)}</span>
            <button class="scheduler-delete-btn" title="Delete task">${SVG.trash}</button>
          </div>
        `;
        const deleteBtn = el.querySelector('.scheduler-delete-btn');
        deleteBtn.addEventListener('click', () =>
          deleteSchedulerTask(task.id, el),
        );
        schedulersList.appendChild(el);
      }
    }
  } catch (err) {
    console.error('Failed to load schedulers:', err);
    schedulersList.innerHTML = `<div class="schedulers-empty">Failed to load schedulers</div>`;
  }
}

async function deleteSchedulerTask(taskId, el) {
  if (!(await openConfirmDialog('Delete this task?', { title: 'Delete Task' })))
    return;
  try {
    const res = await apiFetch(`/api/task?id=${encodeURIComponent(taskId)}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    el.remove();
    // Show empty message if no tasks left
    if (schedulersList.querySelectorAll('.scheduler-item').length === 0) {
      schedulersList.innerHTML = `<div class="schedulers-empty">No scheduled tasks</div>`;
    }
  } catch (err) {
    console.error('Failed to delete scheduler:', err);
    alert('Failed to delete task');
  }
}

async function deleteAllSchedulers() {
  if (
    !(await openConfirmDialog('Delete all scheduled tasks?', {
      title: 'Delete All Tasks',
    }))
  )
    return;
  try {
    const res = await apiFetch('/api/tasks', { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    schedulersList.innerHTML = `<div class="schedulers-empty">No scheduled tasks</div>`;
  } catch (err) {
    console.error('Failed to delete all schedulers:', err);
    alert('Failed to delete all tasks');
  }
}

function formatDuration(ms) {
  if (!ms && ms !== 0) return '—';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

function updateAgentDurations() {
  const now = Date.now();
  for (const agent of agentStatusData) {
    const elapsed = now - agent.startedAt;
    const el = document.querySelector(
      `[data-agent-jid="${CSS.escape(agent.groupJid)}"] .agent-status-duration`,
    );
    if (el) {
      el.textContent = formatDuration(elapsed);
    }
  }
}

function updateAgentRunTraces(runs) {
  agentRunTraceByGroup = {};
  for (const run of runs) {
    if (run && run.groupJid) {
      agentRunTraceByGroup[run.groupJid] = run;
    }
  }
}

function parseAgentEventPayload(event) {
  if (!event || !event.payload_json) return null;
  if (typeof event.payload_json === 'object') return event.payload_json;
  try {
    return JSON.parse(event.payload_json);
  } catch {
    return null;
  }
}

function renderAgentTraceEvent(event) {
  const payload = parseAgentEventPayload(event) || {};
  const summary = escapeHtml(event.summary || event.event_name || 'event');
  const kind = escapeHtml(event.event_type || 'event');
  const highlightVariant =
    event.event_name === 'file_edit_complete'
      ? 'edit'
      : event.event_name === 'file_write_complete'
        ? 'write'
        : '';
  const isHighlightedFileChange = Boolean(highlightVariant);
  const highlightTitle =
    highlightVariant === 'edit'
      ? 'Edited File'
      : highlightVariant === 'write'
        ? 'Wrote File'
        : '';
  let details = '';
  const filePath = typeof payload.path === 'string' ? payload.path : '';
  const normalizedFilePath = filePath
    .replace(/^\/workspace\/group\//, '')
    .replace(/^\/workspace\/project\//, '')
    .replace(/^\/workspace\//, '');
  const hasDiffStats = payload.additions || payload.deletions;
  const collapsedDiffLines = Array.isArray(payload.patchPreview)
    ? payload.patchPreview.slice(0, 6)
    : [];
  const hiddenDiffLines = Array.isArray(payload.patchPreview)
    ? payload.patchPreview.slice(6)
    : [];

  if (collapsedDiffLines.length > 0) {
    details += `
      <div class="agent-trace-diff">
        <div class="agent-trace-diff-header">
          ${normalizedFilePath ? `<span class="agent-trace-diff-file">${escapeHtml(normalizedFilePath)}</span>` : `<span class="agent-trace-diff-file">Modified file</span>`}
          ${hasDiffStats ? `<span class="agent-trace-diff-badge plus">+${escapeHtml(String(payload.additions || 0))}</span><span class="agent-trace-diff-badge minus">-${escapeHtml(String(payload.deletions || 0))}</span>` : ''}
        </div>
        ${collapsedDiffLines.map((line) => `<div class="agent-trace-diff-line ${line.startsWith('+') ? 'add' : 'del'}">${escapeHtml(line)}</div>`).join('')}
        ${
          hiddenDiffLines.length > 0
            ? `
          <details class="agent-trace-disclosure">
            <summary>Show ${hiddenDiffLines.length} more diff lines</summary>
            <div class="agent-trace-disclosure-body">
              ${hiddenDiffLines.map((line) => `<div class="agent-trace-diff-line ${line.startsWith('+') ? 'add' : 'del'}">${escapeHtml(line)}</div>`).join('')}
            </div>
          </details>
        `
            : ''
        }
      </div>
    `;
  }

  if (Array.isArray(payload.filenames) && payload.filenames.length > 0) {
    details += `
      <div class="agent-trace-files">
        ${payload.filenames.map((name) => `<span class="agent-trace-file">${escapeHtml(name)}</span>`).join('')}
      </div>
    `;
  }

  if (
    typeof payload.contentPreview === 'string' &&
    payload.contentPreview.trim()
  ) {
    const previewText = String(payload.contentPreview);
    const collapsedPreview =
      previewText.length > 320 ? previewText.slice(0, 320) : previewText;
    const hiddenPreview =
      previewText.length > 320 ? previewText.slice(320) : '';
    details += `
      <div class="agent-trace-preview-wrap">
        ${normalizedFilePath ? `<div class="agent-trace-preview-header">${escapeHtml(normalizedFilePath)}</div>` : ''}
        <pre class="agent-trace-preview">${escapeHtml(collapsedPreview)}${hiddenPreview ? '...' : ''}</pre>
      </div>
      ${
        hiddenPreview
          ? `
        <details class="agent-trace-disclosure">
          <summary>Show more matches</summary>
          <div class="agent-trace-preview-wrap">
            ${normalizedFilePath ? `<div class="agent-trace-preview-header">${escapeHtml(normalizedFilePath)}</div>` : ''}
            <pre class="agent-trace-preview agent-trace-preview-expanded">${escapeHtml(previewText)}</pre>
          </div>
        </details>
      `
          : ''
      }
    `;
  }

  if (hasDiffStats && collapsedDiffLines.length === 0) {
    details += `<div class="agent-trace-stats">+${escapeHtml(String(payload.additions || 0))} / -${escapeHtml(String(payload.deletions || 0))}</div>`;
  }

  return `
    <div class="agent-trace-event${isHighlightedFileChange ? ` agent-trace-event-highlight agent-trace-event-highlight-${highlightVariant}` : ''}">
      ${highlightTitle ? `<div class="agent-trace-highlight-title">${escapeHtml(highlightTitle)}</div>` : ''}
      <div class="agent-trace-event-head${isHighlightedFileChange ? ' agent-trace-event-head-highlight' : ''}">
        <span class="agent-trace-kind">${kind}</span>${summary}
      </div>
      ${details}
    </div>
  `;
}

function renderAgentStatus(agents) {
  agentStatusData = agents;
  if (agents.length === 0) {
    agentStatusList.innerHTML = `<div class="agent-status-empty">No active agents</div>`;
    return;
  }
  agentStatusList.innerHTML = '';
  for (const agent of agents) {
    const now = Date.now();
    const elapsed = now - agent.startedAt;
    const statusDot = agent.isIdle
      ? 'agent-status-dot idle'
      : 'agent-status-dot active';
    const typeLabel = agent.isTask ? 'task' : 'chat';
    const isStopping = stoppingAgentIds.has(agent.groupJid);
    const trace = agentRunTraceByGroup[agent.groupJid] || null;
    const currentAction = trace?.currentAction || '';
    const currentStep = trace?.currentStepType || '';
    const recentEvents = Array.isArray(trace?.recentEvents)
      ? trace.recentEvents.slice(-3).reverse()
      : [];

    const el = document.createElement('div');
    el.className = `agent-status-item${isStopping ? ' is-stopping' : ''}`;
    el.setAttribute('data-agent-jid', agent.groupJid);
    // Format last message time
    let lastTimeStr = '';
    if (agent.lastTime) {
      const t = new Date(
        isNaN(Number(agent.lastTime)) ? agent.lastTime : Number(agent.lastTime),
      );
      if (!isNaN(t.getTime())) {
        lastTimeStr = t.toLocaleTimeString('zh-CN', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
      }
    }

    el.innerHTML = `
      <div class="agent-status-name">
        <span class="${statusDot}"></span>
        ${escapeHtml(agent.groupName)}
      </div>
      <div class="agent-status-last-msg">
        <span class="agent-status-sender">${escapeHtml(agent.lastSender || '—')}</span>
        <span class="agent-status-time">${escapeHtml(lastTimeStr)}</span>
      </div>
      <div class="agent-status-content">${escapeHtml(agent.lastContent || '—')}</div>
      ${currentAction ? `<div class="agent-trace-current">${escapeHtml(currentAction)}</div>` : ''}
      ${currentStep ? `<div class="agent-trace-step">${escapeHtml(currentStep)}</div>` : ''}
      ${
        recentEvents.length > 0
          ? `
        <div class="agent-trace-events">
          ${recentEvents.map((event) => renderAgentTraceEvent(event)).join('')}
        </div>
      `
          : ''
      }
      <div class="agent-status-meta">
        <span class="agent-status-duration">${formatDuration(elapsed)}</span>
        <span class="agent-status-type">${typeLabel}</span>
        ${agent.pendingTaskCount > 0 ? `<span class="agent-status-pending">${agent.pendingTaskCount} pending</span>` : ''}
        ${agent.pendingOneShotCount > 0 ? `<span class="agent-status-pending">${agent.pendingOneShotCount} one-shot</span>` : ''}
        ${agent.isTask && agent.runningTaskId ? `<span class="agent-status-task-id">${escapeHtml(agent.runningTaskId.slice(0, 8))}…</span>` : ''}
      </div>
      <div class="agent-status-actions">
        <button type="button" class="panel-action-btn stop icon-text-btn agent-stop-btn"${isStopping ? ' disabled' : ''}>
          ${isStopping ? 'Stopping...' : `${SVG.stop} Stop`}
        </button>
      </div>
    `;
    const stopBtn = el.querySelector('.agent-stop-btn');
    if (!isStopping) {
      stopBtn.addEventListener('click', () =>
        stopAgent(agent.groupJid, stopBtn),
      );
    }
    agentStatusList.appendChild(el);
  }
}

async function stopAgent(groupJid, btn) {
  const agent = agentStatusData.find((item) => item.groupJid === groupJid);
  const confirmMessage =
    agent?.isTask
      ? '确认停止这个任务 agent 吗？\n\n对应任务会被标记为暂停。'
      : '确认停止这个 agent 吗？\n\n当前会话会被中止，排队中的消息和任务也会清空。';
  if (!(await openConfirmDialog(confirmMessage, { title: '停止 Agent' })))
    return;
  stoppingAgentIds.add(groupJid);
  renderAgentStatus(agentStatusData);
  try {
    const res = await apiFetch('/api/agent-status/stop', {
      method: 'POST',
      body: JSON.stringify({ groupJid }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    await loadAgentStatus();
    const toastMessage = data.stoppedTaskId
      ? '已停止任务 agent，任务已暂停'
      : '已停止 agent';
    showToast(toastMessage);
  } catch (err) {
    console.error('Failed to stop agent:', err);
    stoppingAgentIds.delete(groupJid);
    renderAgentStatus(agentStatusData);
    alert('Failed to stop agent: ' + err.message);
  }
}

async function loadAgentStatus() {
  try {
    const [statusRes, traceRes] = await Promise.all([
      apiFetch('/api/agent-status'),
      apiFetch('/api/agent-queries/active'),
    ]);
    if (!statusRes.ok) throw new Error(`HTTP ${statusRes.status}`);
    if (!traceRes.ok) throw new Error(`HTTP ${traceRes.status}`);
    const data = await statusRes.json();
    const traceData = await traceRes.json();
    updateAgentRunTraces(traceData.queries || []);
    const activeIds = new Set(
      (data.agents || []).map((agent) => agent.groupJid),
    );
    stoppingAgentIds.forEach((groupJid) => {
      if (!activeIds.has(groupJid)) {
        stoppingAgentIds.delete(groupJid);
      }
    });
    renderAgentStatus(data.agents || []);
  } catch (err) {
    console.error('Failed to load agent status:', err);
    agentStatusList.innerHTML = `<div class="agent-status-empty">Failed to load</div>`;
  }
}

function formatRelativeTime(ts) {
  const ms = parseTimestamp(ts);
  if (!Number.isFinite(ms)) return '--';
  const delta = Date.now() - ms;
  const abs = Math.abs(delta);
  if (abs < 60 * 1000) return '刚刚';
  if (abs < 60 * 60 * 1000) return `${Math.round(abs / (60 * 1000))} 分钟前`;
  if (abs < 24 * 60 * 60 * 1000)
    return `${Math.round(abs / (60 * 60 * 1000))} 小时前`;
  return `${Math.round(abs / (24 * 60 * 60 * 1000))} 天前`;
}

function getGroupDisplayNameByJid(groupJid) {
  if (!groupJid) return '未关联群组';
  const group = groups.find((item) => item.jid === groupJid);
  return group?.name || groupJid;
}

function normalizeTraceRun(run, scope) {
  if (!run) return null;
  if (scope === 'active') {
    return {
      id: run.queryId,
      scope,
      sourceType: run.sourceType || null,
      sourceRefId: run.sourceRefId || null,
      groupJid: run.groupJid || null,
      groupFolder: run.groupFolder || null,
      service: run.service || null,
      role: run.role || null,
      selectedModel: run.selectedModel || null,
      actualModel: run.actualModel || null,
      status: run.status || 'running',
      currentAction: run.currentAction || null,
      currentStepType: run.currentStepType || null,
      currentStepName: run.currentStepName || null,
      promptSummary: run.promptSummary || null,
      startedAt: run.startedAt || null,
      lastEventAt: run.lastEventAt || null,
      endedAt: null,
      latencyMs: null,
      queueLatencyMs: run.queueLatencyMs ?? null,
      containerName: run.containerName || null,
      containerRuntime: run.containerRuntime || null,
      containerExitCode: run.containerExitCode ?? null,
      containerTerminatedReason: run.containerTerminatedReason || null,
      toolCallCount: run.toolCallCount ?? null,
      failedToolCallCount: run.failedToolCallCount ?? null,
      changedFileCount: run.changedFileCount ?? null,
      artifactCount: run.artifactCount ?? null,
      artifactContractStatus: run.artifactContractStatus || null,
    };
  }
  return {
    id: run.query_id || run.id,
    scope,
    sourceType: run.source_type || run.sourceType || null,
    sourceRefId: run.source_ref_id || run.sourceRefId || null,
    groupJid: run.chat_jid || null,
    groupFolder: run.group_folder || null,
    service: run.service || null,
    role: run.role || null,
    selectedModel: run.selected_model || null,
    actualModel: run.actual_model || null,
    status: run.status || 'idle',
    currentAction: run.current_action || null,
    currentStepType: null,
    currentStepName: null,
    promptSummary: run.output_preview || null,
    startedAt: run.started_at || null,
    lastEventAt: run.last_event_at || null,
    endedAt: run.ended_at || null,
    latencyMs: run.latency_ms || null,
    queueLatencyMs: run.queue_latency_ms ?? null,
    containerName: run.container_name || null,
    containerRuntime: run.container_runtime || null,
    containerExitCode: run.container_exit_code ?? null,
    containerTerminatedReason: run.container_terminated_reason || null,
    toolCallCount: run.tool_call_count ?? null,
    failedToolCallCount: run.failed_tool_call_count ?? null,
    changedFileCount: run.changed_file_count ?? null,
    artifactCount: run.artifact_count ?? null,
    artifactContractStatus: run.artifact_contract_status || null,
    failureType: run.failure_type || null,
  };
}

function getTraceRunCollection(scope) {
  return scope === 'history' ? traceMonitorHistoryRuns : traceMonitorActiveRuns;
}

function sortTraceRunsByLatest(runs) {
  return [...runs].sort((a, b) => {
    const aTs = parseTimestamp(a.lastEventAt || a.startedAt || a.endedAt) || 0;
    const bTs = parseTimestamp(b.lastEventAt || b.startedAt || b.endedAt) || 0;
    return bTs - aTs;
  });
}

function getTraceMonitorFilterEntries() {
  const filters = traceMonitorFilters || {};
  return [
    ['status', filters.status],
    ['sourceType', filters.sourceType],
    ['sourceRefId', filters.sourceRefId],
    ['service', filters.service],
    ['failureType', filters.failureType],
    ['role', filters.role],
    ['hasFileChanges', filters.hasFileChanges ? 'true' : ''],
    ['hasErrors', filters.hasErrors ? 'true' : ''],
  ].filter(
    ([, value]) =>
      value !== undefined && value !== null && String(value).trim() !== '',
  );
}

function hasTraceMonitorFilters() {
  return getTraceMonitorFilterEntries().length > 0;
}

function buildTraceHistoryUrl(offset) {
  const params = new URLSearchParams({
    limit: String(TRACE_HISTORY_PAGE_SIZE),
    offset: String(offset),
  });
  getTraceMonitorFilterEntries().forEach(([key, value]) => {
    params.set(key, String(value));
  });
  return `/api/agent-queries?${params.toString()}`;
}

function traceRunMatchesFilters(run) {
  const filters = traceMonitorFilters || {};
  const includesValue = (actual, expected) => {
    if (!expected) return true;
    return String(actual || '')
      .toLowerCase()
      .includes(String(expected).toLowerCase());
  };
  const hasRecentErrorEvent =
    Array.isArray(run.recentEvents) &&
    run.recentEvents.some((event) => {
      const payload = parseAgentEventPayload(event) || {};
      const status = String(event?.status || '').toLowerCase();
      const eventType = String(event?.event_type || '').toLowerCase();
      const eventName = String(event?.event_name || '').toLowerCase();
      const severity = String(payload.severity || '').toLowerCase();
      return (
        status === 'error' ||
        status === 'failed' ||
        eventType === 'error' ||
        severity === 'error' ||
        eventName.includes('failed') ||
        eventName.includes('error') ||
        eventName.includes('timeout')
      );
    });
  if (filters.status && run.status !== filters.status) return false;
  if (filters.sourceType && run.sourceType !== filters.sourceType) return false;
  if (filters.sourceRefId && run.sourceRefId !== filters.sourceRefId)
    return false;
  if (!includesValue(run.service, filters.service)) return false;
  if (!includesValue(run.failureType, filters.failureType)) return false;
  if (!includesValue(run.role, filters.role)) return false;
  if (filters.hasFileChanges && !(Number(run.changedFileCount || 0) > 0))
    return false;
  if (
    filters.hasErrors &&
    !(
      run.status === 'error' ||
      run.status === 'timeout' ||
      Boolean(run.failureType) ||
      Number(run.failedToolCallCount || 0) > 0 ||
      hasRecentErrorEvent
    )
  )
    return false;
  return true;
}

function getFilteredTraceRunCollection(scope) {
  const runs = getTraceRunCollection(scope);
  if (!hasTraceMonitorFilters()) return runs;
  return runs.filter(traceRunMatchesFilters);
}

async function loadTraceHistoryPage(options) {
  const reset = Boolean(options && options.reset);
  if (traceMonitorHistoryLoading) return;
  traceMonitorHistoryLoading = true;
  if (
    activePrimaryNavKey === 'trace-monitor' &&
    activeTraceMonitorScope === 'history'
  ) {
    renderTraceMonitorList();
  }
  try {
    const offset = reset ? 0 : traceMonitorHistoryOffset;
    const res = await apiFetch(buildTraceHistoryUrl(offset));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const activeRunIds = new Set(traceMonitorActiveRuns.map((run) => run.id));
    const nextRuns = (data.queries || [])
      .map((run) => normalizeTraceRun(run, 'history'))
      .filter((run) => run && !activeRunIds.has(run.id));
    if (reset) {
      traceMonitorHistoryRuns = sortTraceRunsByLatest(nextRuns);
      if (nextRuns.length > 0) {
        traceMonitorHistoryJustCleared = false;
      }
    } else {
      const merged = [...traceMonitorHistoryRuns];
      const seen = new Set(merged.map((run) => run.id));
      for (const run of nextRuns) {
        if (!seen.has(run.id)) {
          merged.push(run);
          seen.add(run.id);
        }
      }
      traceMonitorHistoryRuns = sortTraceRunsByLatest(merged);
    }
    traceMonitorHistoryOffset = offset + (data.queries || []).length;
    traceMonitorHistoryHasMore = Boolean(data.hasMore);
  } finally {
    traceMonitorHistoryLoading = false;
  }
}

async function loadMoreTraceHistory() {
  if (traceMonitorHistoryLoading || !traceMonitorHistoryHasMore) return;
  try {
    await loadTraceHistoryPage({ reset: false });
    if (
      activePrimaryNavKey === 'trace-monitor' &&
      activeTraceMonitorScope === 'history'
    ) {
      renderTraceMonitorList();
    }
  } catch (err) {
    console.error('Failed to load more trace history:', err);
    showToast('加载更多活动历史失败');
  }
}

function getTraceRunListEmptyText(scope) {
  if (scope === 'history' && traceMonitorHistoryJustCleared) {
    return '活动历史已清空';
  }
  if (hasTraceMonitorFilters()) {
    return scope === 'history'
      ? '当前筛选下暂无历史 Agent Trace'
      : '当前筛选下暂无活跃 Agent Trace';
  }
  return scope === 'history' ? '暂无历史 Agent Trace' : '暂无活跃 Agent Trace';
}

function buildTraceRunSummary(run) {
  return (
    run.currentAction ||
    run.currentStepName ||
    run.currentStepType ||
    run.promptSummary ||
    '等待更多执行数据...'
  );
}

function buildTraceRunSubtitle(run) {
  const parts = [run.role].filter(Boolean);
  if (run.service) parts.push(run.service);
  return parts.join(' / ');
}

function buildTraceRunStats(run) {
  const stats = [];
  if (run.latencyMs || run.latencyMs === 0)
    stats.push(formatDuration(run.latencyMs));
  if (run.toolCallCount || run.toolCallCount === 0)
    stats.push(`tools ${run.toolCallCount}`);
  if (run.changedFileCount || run.changedFileCount === 0)
    stats.push(`files ${run.changedFileCount}`);
  if (run.failedToolCallCount)
    stats.push(`failed tools ${run.failedToolCallCount}`);
  if (run.actualModel || run.selectedModel)
    stats.push(run.actualModel || run.selectedModel);
  if (
    run.containerTerminatedReason &&
    run.containerTerminatedReason !== 'completed'
  ) {
    stats.push(run.containerTerminatedReason);
  }
  return stats;
}

function setTraceMonitorFilterValue(key, value) {
  if (
    !traceMonitorFilters ||
    !Object.prototype.hasOwnProperty.call(traceMonitorFilters, key)
  )
    return;
  traceMonitorFilters[key] = String(value || '').trim();
}

function syncTraceMonitorFilterControls() {
  if (traceMonitorStatusFilter)
    traceMonitorStatusFilter.value = traceMonitorFilters.status || '';
  if (traceMonitorSourceFilter)
    traceMonitorSourceFilter.value = traceMonitorFilters.sourceType || '';
  if (traceMonitorServiceFilter)
    traceMonitorServiceFilter.value = traceMonitorFilters.service || '';
  if (traceMonitorFailureFilter)
    traceMonitorFailureFilter.value = traceMonitorFilters.failureType || '';
  if (traceMonitorRoleFilter)
    traceMonitorRoleFilter.value = traceMonitorFilters.role || '';
  if (traceMonitorFilesFilter)
    traceMonitorFilesFilter.checked = Boolean(
      traceMonitorFilters.hasFileChanges,
    );
  if (traceMonitorErrorsFilter)
    traceMonitorErrorsFilter.checked = Boolean(traceMonitorFilters.hasErrors);
}

function readTraceMonitorFilterControls() {
  traceMonitorFilters = {
    ...traceMonitorFilters,
    status: String(traceMonitorStatusFilter?.value || '').trim(),
    sourceType: String(traceMonitorSourceFilter?.value || '').trim(),
    service: String(traceMonitorServiceFilter?.value || '').trim(),
    failureType: String(traceMonitorFailureFilter?.value || '').trim(),
    role: String(traceMonitorRoleFilter?.value || '').trim(),
    hasFileChanges: Boolean(traceMonitorFilesFilter?.checked),
    hasErrors: Boolean(traceMonitorErrorsFilter?.checked),
  };
}

function applyTraceMonitorFilters() {
  readTraceMonitorFilterControls();
  traceMonitorHistoryOffset = 0;
  traceMonitorHistoryHasMore = false;
  traceMonitorHistoryRuns = [];
  currentTraceRunId = '';
  currentTraceRunRecord = null;
  currentTraceRunSteps = [];
  currentTraceRunEvents = [];
  currentTraceRunSummary = null;
  currentTraceRunHighlights = null;
  renderTraceMonitorList();
  renderTraceMonitorDetailEmpty();
  if (activeTraceMonitorScope === 'history') {
    loadTraceHistoryPage({ reset: true })
      .then(() => {
        renderTraceMonitorList();
        ensureTraceSelectionVisible('history');
      })
      .catch((err) => {
        console.error('Failed to apply trace filters:', err);
        traceMonitorList.innerHTML = `<div class="trace-monitor-list-empty">Trace 筛选加载失败</div>`;
      });
    return;
  }
  ensureTraceSelectionVisible('active');
}

function scheduleTraceMonitorFilterApply() {
  if (traceMonitorFilterDebounceTimer) {
    clearTimeout(traceMonitorFilterDebounceTimer);
  }
  traceMonitorFilterDebounceTimer = setTimeout(() => {
    traceMonitorFilterDebounceTimer = null;
    applyTraceMonitorFilters();
  }, 250);
}

function setTraceMonitorFiltersCollapsed(collapsed) {
  if (!traceMonitorFilterPanel || !traceMonitorFilterToggle) return;
  traceMonitorFilterPanel.classList.toggle('collapsed', Boolean(collapsed));
  traceMonitorFilterToggle.classList.toggle('collapsed', Boolean(collapsed));
  traceMonitorFilterToggle.setAttribute(
    'aria-expanded',
    collapsed ? 'false' : 'true',
  );
}

async function openTraceMonitorRun(queryId, options = {}) {
  if (!queryId) return;
  const scope = options.scope === 'active' ? 'active' : 'history';
  if (options.preserveFilters === true) {
    if (options.sourceType)
      setTraceMonitorFilterValue('sourceType', options.sourceType);
    if (options.sourceRefId)
      setTraceMonitorFilterValue('sourceRefId', options.sourceRefId);
    if (options.role) setTraceMonitorFilterValue('role', options.role);
  } else {
    traceMonitorFilters = getDefaultTraceMonitorFilters();
  }
  syncTraceMonitorFilterControls();
  const normalized = normalizeTraceRun(
    {
      query_id: queryId,
      source_type: options.sourceType || null,
      source_ref_id: options.sourceRefId || null,
      role: options.role || null,
    },
    'history',
  );
  if (
    scope === 'history' &&
    normalized &&
    !traceMonitorHistoryRuns.some((run) => run.id === queryId)
  ) {
    traceMonitorHistoryRuns = sortTraceRunsByLatest([
      normalized,
      ...traceMonitorHistoryRuns,
    ]);
  }
  currentTraceRunId = queryId;
  setPrimaryNav('trace-monitor');
  setTraceMonitorScope(scope);
  renderTraceMonitorList();
  await loadTraceRunDetail(queryId, scope);
  loadTraceMonitorData({ force: true }).catch((err) => {
    console.error('Failed to refresh trace monitor after navigation:', err);
  });
}

function renderTraceHistoryLoadingSkeleton() {
  return `
    <div class="trace-monitor-history-skeleton" aria-hidden="true">
      <div class="trace-monitor-history-skeleton-line title"></div>
      <div class="trace-monitor-history-skeleton-line summary"></div>
      <div class="trace-monitor-history-skeleton-line meta"></div>
    </div>
  `;
}

function syncTraceMonitorHeaderActions() {
  if (!traceMonitorClearHistoryBtn) return;
  const isHistoryScope = activeTraceMonitorScope === 'history';
  const hasHistoryRuns = traceMonitorHistoryRuns.length > 0;
  traceMonitorClearHistoryBtn.style.display = isHistoryScope ? '' : 'none';
  traceMonitorClearHistoryBtn.disabled =
    !isHistoryScope || !hasHistoryRuns || traceMonitorHistoryClearing;
  traceMonitorClearHistoryBtn.title = traceMonitorHistoryClearing
    ? '正在删除活动历史'
    : '一键删除所有活动历史';
}

function renderTraceMonitorList() {
  if (!traceMonitorList) return;
  syncTraceMonitorHeaderActions();
  const runs = getFilteredTraceRunCollection(activeTraceMonitorScope);
  if (!runs.length) {
    traceMonitorList.innerHTML = `<div class="trace-monitor-list-empty">${getTraceRunListEmptyText(activeTraceMonitorScope)}</div>`;
    return;
  }
  traceMonitorList.innerHTML = '';
  for (const run of runs) {
    const runId = String(run.id || '');
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `trace-monitor-list-item${runId === currentTraceRunId ? ' active' : ''}`;
    const statusClass = getTraceStatusClass(run.status);
    const primaryTime = run.startedAt ? formatDateTime(run.startedAt) : '--';
    const secondaryTime = run.lastEventAt
      ? formatRelativeTime(run.lastEventAt)
      : '--';
    const subtitle = buildTraceRunSubtitle(run);
    const stats = buildTraceRunStats(run);
    item.innerHTML = `
      <div class="trace-monitor-list-head">
        <div class="trace-monitor-list-title">${escapeHtml(getGroupDisplayNameByJid(run.groupJid))}</div>
        <span class="trace-monitor-status ${escapeHtml(statusClass)}">${escapeHtml(run.status || 'unknown')}</span>
      </div>
      ${subtitle ? `<div class="trace-monitor-list-subtitle">${escapeHtml(subtitle)}</div>` : ''}
      <div class="trace-monitor-list-summary">${escapeHtml(buildTraceRunSummary(run))}</div>
      ${stats.length ? `<div class="trace-monitor-list-stats">${stats.map((stat) => `<span>${escapeHtml(String(stat))}</span>`).join('')}</div>` : ''}
      ${run.failureType ? `<div class="trace-monitor-list-failure">failure: ${escapeHtml(run.failureType)}</div>` : ''}
      <div class="trace-monitor-list-meta">
        <span>${escapeHtml(runId.slice(0, 8))}...</span>
        <span>${escapeHtml(primaryTime)}</span>
        <span>${escapeHtml(secondaryTime)}</span>
      </div>
    `;
    item.addEventListener('click', () => {
      loadTraceRunDetail(runId, activeTraceMonitorScope);
    });
    traceMonitorList.appendChild(item);
  }
  if (activeTraceMonitorScope === 'history') {
    const footer = document.createElement('div');
    footer.className = 'trace-monitor-list-footer';
    if (traceMonitorHistoryLoading) {
      footer.innerHTML = renderTraceHistoryLoadingSkeleton();
    } else {
      const status = document.createElement('div');
      status.className = 'trace-monitor-list-footer-status';
      status.textContent = traceMonitorHistoryHasMore
        ? '继续下滑加载更多'
        : traceMonitorHistoryRuns.length
          ? '已加载全部'
          : '暂无更多';
      footer.appendChild(status);
    }
    traceMonitorList.appendChild(footer);
  }
}

function getTraceStatusClass(status) {
  const normalized = String(status || 'idle')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-');
  return normalized === 'error' ? 'status-error' : normalized;
}

function getTraceCategoryBadgeClass(className) {
  return className === 'error'
    ? 'trace-monitor-category-badge-error'
    : className;
}

function renderTracePill(label, value) {
  if (value === undefined || value === null || value === '') return '';
  return `<span class="trace-monitor-pill"><strong>${escapeHtml(label)}</strong>${escapeHtml(String(value))}</span>`;
}

function renderTraceMonitorDetailEmpty() {
  currentTraceRunRecord = null;
  currentTraceRunSteps = [];
  currentTraceRunEvents = [];
  currentTraceRunSummary = null;
  currentTraceRunHighlights = null;
  if (traceMonitorDetail) traceMonitorDetail.classList.add('hidden');
  if (traceMonitorDetailEmpty)
    traceMonitorDetailEmpty.classList.remove('hidden');
}

function renderTraceSummaryPills(run) {
  const pills = [];
  const summary = currentTraceRunSummary || {};
  pills.push(renderTracePill('Status', run.status || '--'));
  if (run.started_at) {
    pills.push(renderTracePill('Started', formatDateTime(run.started_at)));
  }
  if (run.ended_at) {
    pills.push(renderTracePill('Ended', formatDateTime(run.ended_at)));
  }
  const durationMs = summary.durationMs ?? run.latency_ms;
  if (durationMs || durationMs === 0) {
    pills.push(renderTracePill('Duration', formatDuration(durationMs)));
  }
  if (run.selected_model) {
    pills.push(renderTracePill('Selected', run.selected_model));
  }
  if (run.actual_model) {
    pills.push(renderTracePill('Actual', run.actual_model));
  }
  if (run.role) {
    pills.push(renderTracePill('Role', run.role));
  }
  if (run.service) {
    pills.push(renderTracePill('Service', run.service));
  }
  if (run.group_folder) {
    pills.push(renderTracePill('Folder', run.group_folder));
  }
  const queueMs = summary.queueLatencyMs ?? run.queue_latency_ms;
  if (queueMs || queueMs === 0) {
    pills.push(renderTracePill('Queue', formatDuration(queueMs)));
  }
  const containerMs = summary.containerDurationMs;
  if (containerMs || containerMs === 0) {
    pills.push(renderTracePill('Container', formatDuration(containerMs)));
  } else if (run.container_terminated_reason) {
    pills.push(renderTracePill('Container', run.container_terminated_reason));
  }
  if (run.input_tokens || run.output_tokens) {
    pills.push(
      renderTracePill(
        'Tokens',
        `${run.input_tokens || 0} / ${run.output_tokens || 0}`,
      ),
    );
  }
  if (summary.toolCallCount || summary.toolCallCount === 0) {
    pills.push(
      renderTracePill(
        'Tools',
        `${summary.toolCallCount}${summary.failedToolCallCount ? ` / ${summary.failedToolCallCount} failed` : ''}`,
      ),
    );
  }
  if (summary.changedFileCount || summary.changedFileCount === 0) {
    pills.push(renderTracePill('Files', summary.changedFileCount));
  }
  if (summary.artifactCount) {
    pills.push(renderTracePill('Artifacts', summary.artifactCount));
  }
  if (run.artifact_contract_status) {
    pills.push(renderTracePill('Contract', run.artifact_contract_status));
  }
  if (run.failure_type) {
    pills.push(
      renderTracePill(
        'Failure',
        run.failure_subtype
          ? `${run.failure_type}.${run.failure_subtype}`
          : run.failure_type,
      ),
    );
  }
  return pills.filter(Boolean).join('');
}

function renderTraceMetaPills(run) {
  const pills = [];
  pills.push(renderTracePill('Run', run.query_id || run.id));
  pills.push(renderTracePill('Source', run.source_type || '--'));
  if (run.chat_jid) {
    pills.push(
      renderTracePill('Group', getGroupDisplayNameByJid(run.chat_jid)),
    );
  }
  if (run.container_name) {
    pills.push(renderTracePill('Container', run.container_name));
  }
  if (run.container_runtime) {
    pills.push(renderTracePill('Runtime', run.container_runtime));
  }
  if (run.container_exit_code || run.container_exit_code === 0) {
    pills.push(renderTracePill('Exit', run.container_exit_code));
  }
  if (run.current_action) {
    pills.push(renderTracePill('Action', run.current_action));
  }
  if (run.error_message) {
    pills.push(renderTracePill('Error', run.error_message));
  }
  return pills.filter(Boolean).join('');
}

function stringifyTracePayload(payload) {
  if (!payload) return '';
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

var TRACE_CATEGORY_META = {
  lifecycle: {
    key: 'lifecycle',
    label: '生命周期',
    className: 'lifecycle',
    order: 10,
  },
  queue: { key: 'queue', label: '排队', className: 'queue', order: 20 },
  container: {
    key: 'container',
    label: '容器',
    className: 'container',
    order: 30,
  },
  model: { key: 'model', label: '模型', className: 'model', order: 40 },
  tool: { key: 'tool', label: '工具调用', className: 'tool', order: 50 },
  file: { key: 'file', label: '文件改动', className: 'file', order: 60 },
  ipc: { key: 'ipc', label: 'IPC', className: 'ipc', order: 70 },
  evaluation: {
    key: 'evaluation',
    label: '评估',
    className: 'evaluation',
    order: 90,
  },
  human: { key: 'human', label: '人类确认', className: 'human', order: 100 },
  artifact: {
    key: 'artifact',
    label: '产物',
    className: 'artifact',
    order: 110,
  },
  output: { key: 'output', label: '输出', className: 'output', order: 120 },
  error: { key: 'error', label: '错误事件', className: 'error', order: 130 },
  general: { key: 'general', label: '', className: 'general', order: 900 },
};

function traceCategoryMeta(key, payload) {
  const normalized = String(key || '').toLowerCase();
  if (normalized === 'command') return TRACE_CATEGORY_META.tool;
  if (TRACE_CATEGORY_META[normalized]) return TRACE_CATEGORY_META[normalized];
  const payloadCategory =
    payload && typeof payload.category === 'string'
      ? payload.category.toLowerCase()
      : '';
  return TRACE_CATEGORY_META[payloadCategory] || TRACE_CATEGORY_META.general;
}

function tracePayloadPath(payload) {
  return payload?.path || payload?.resourceRef || payload?.resource_ref || '';
}

function formatTraceNumber(value) {
  if (!(value || value === 0)) return '';
  if (Math.abs(Number(value)) >= 1000)
    return Intl.NumberFormat('en', { notation: 'compact' }).format(
      Number(value),
    );
  return String(value);
}

function classifyTraceTimelineItem(item) {
  const status = String(item?.status || '').toLowerCase();
  const stepType = String(item?.step_type || '').toLowerCase();
  const eventType = String(item?.event_type || '').toLowerCase();
  const eventName = String(item?.event_name || '').toLowerCase();
  const payload =
    'event_type' in item
      ? parseAgentEventPayload(item) || {}
      : parseAgentEventPayload({ payload_json: item.payload_json }) || {};
  const summaryText = String(item?.summary || '').toLowerCase();
  const explicitCategory =
    typeof payload.category === 'string' ? payload.category.toLowerCase() : '';
  const baseCategory =
    explicitCategory ||
    (eventName.startsWith('container_') ? 'container' : '') ||
    (eventName.startsWith('model_') ? 'model' : '') ||
    (eventName.startsWith('ipc_') ? 'ipc' : '') ||
    (eventName.includes('evaluation') || eventName.includes('judge')
      ? 'evaluation'
      : '') ||
    (eventName.startsWith('human_') ? 'human' : '') ||
    (eventName.startsWith('artifact_') ? 'artifact' : '') ||
    (eventType === 'command' ? 'tool' : '') ||
    eventType ||
    stepType;

  const isError =
    status === 'error' ||
    status === 'failed' ||
    stepType === 'error' ||
    eventType === 'error' ||
    eventName.includes('error') ||
    eventName.includes('failed') ||
    eventName.includes('timeout') ||
    String(payload.severity || '').toLowerCase() === 'error' ||
    summaryText.includes('error') ||
    summaryText.includes('failed');
  if (isError) {
    return {
      key: 'error',
      label: '错误事件',
      className: 'error',
      payload,
    };
  }

  if (baseCategory && TRACE_CATEGORY_META[baseCategory]) {
    return {
      ...TRACE_CATEGORY_META[baseCategory],
      payload,
    };
  }

  const isFileChange =
    eventName.startsWith('file_') ||
    Object.prototype.hasOwnProperty.call(payload, 'patchPreview') ||
    Object.prototype.hasOwnProperty.call(payload, 'contentPreview') ||
    Object.prototype.hasOwnProperty.call(payload, 'additions') ||
    Object.prototype.hasOwnProperty.call(payload, 'deletions') ||
    (typeof payload.path === 'string' && payload.path.length > 0);
  if (isFileChange) {
    return {
      key: 'file',
      label: '文件改动',
      className: 'file',
      order: TRACE_CATEGORY_META.file.order,
      payload,
    };
  }

  const isToolCall =
    stepType === 'tool' ||
    eventType === 'tool' ||
    eventName.includes('tool') ||
    eventName.includes('search') ||
    eventName.includes('grep') ||
    eventName.includes('apply_patch') ||
    eventName.includes('write_file') ||
    eventName.includes('edit_file') ||
    eventName.includes('exec') ||
    eventName.includes('command');
  if (isToolCall) {
    return {
      key: 'tool',
      label: '工具调用',
      className: 'tool',
      order: TRACE_CATEGORY_META.tool.order,
      payload,
    };
  }

  return {
    ...TRACE_CATEGORY_META.general,
    key: 'general',
    payload,
  };
}

function renderTraceHighlightSummary(items) {
  const highlightDefs = [
    ['file', '文件改动'],
    ['tool', '工具调用'],
    ['error', '错误事件'],
    ['model', '模型调用'],
    ['ipc', 'IPC 调用'],
    ['container', '容器事件'],
    ['evaluation', '评估'],
    ['human', '人类确认'],
  ];
  const counts = Object.fromEntries(highlightDefs.map(([key]) => [key, 0]));
  for (const item of items) {
    if (item.category && counts[item.category.key] !== undefined) {
      counts[item.category.key] += 1;
    }
  }
  return `
    <div class="trace-monitor-highlight-strip">
      ${highlightDefs
        .map(
          ([key, label]) => `
        <button type="button" class="trace-monitor-highlight-card ${escapeHtml(key === 'error' ? 'trace-monitor-highlight-card-error' : key)}" data-trace-jump="${escapeHtml(key)}"${counts[key] ? '' : ' disabled'}>
          <span class="trace-monitor-highlight-label">${escapeHtml(label)}</span>
          <strong>${escapeHtml(String(counts[key] || 0))}</strong>
        </button>
      `,
        )
        .join('')}
    </div>
  `;
}

function bindTraceHighlightCardJumps() {
  if (!traceMonitorTimeline) return;
  const cards = traceMonitorTimeline.querySelectorAll('[data-trace-jump]');
  cards.forEach((card) => {
    card.addEventListener('click', () => {
      const category = card.getAttribute('data-trace-jump');
      if (!category) return;
      const target = traceMonitorTimeline.querySelector(
        `.trace-monitor-timeline-item-${CSS.escape(category)}`,
      );
      if (!target) return;
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
}

function renderTraceTimeline() {
  if (!traceMonitorTimeline || !currentTraceRunRecord) return;
  const timelineItems = [];
  for (const step of currentTraceRunSteps) {
    const category = classifyTraceTimelineItem(step);
    timelineItems.push({
      kind: 'step',
      sortAt: parseTimestamp(step.started_at) || 0,
      category,
      order: category.order || TRACE_CATEGORY_META.general.order,
      html: renderTraceStepTimelineItem(step, category),
    });
  }
  for (const event of currentTraceRunEvents) {
    const category = classifyTraceTimelineItem(event);
    timelineItems.push({
      kind: 'event',
      sortAt: parseTimestamp(event.created_at || event.started_at) || 0,
      category,
      order: category.order || TRACE_CATEGORY_META.general.order,
      html: renderTraceEventTimelineItem(event, category),
    });
  }
  timelineItems.sort((a, b) => a.sortAt - b.sortAt || a.order - b.order);
  if (!timelineItems.length) {
    traceMonitorTimeline.innerHTML = `<div class="trace-monitor-list-empty">当前 Trace 暂无可展示的时间线数据</div>`;
    return;
  }
  traceMonitorTimeline.innerHTML =
    renderTraceHighlightSummary(timelineItems) +
    timelineItems.map((item) => item.html).join('');
  bindTraceHighlightCardJumps();
}

function renderTraceStepTimelineItem(step, category) {
  const payload =
    category?.payload ||
    parseAgentEventPayload({ payload_json: step.payload_json }) ||
    null;
  const payloadBlock = payload
    ? `<details class="trace-monitor-json-disclosure"><summary>Payload</summary><pre class="trace-monitor-json">${escapeHtml(stringifyTracePayload(payload))}</pre></details>`
    : '';
  return `
    <div class="trace-monitor-timeline-item step trace-monitor-timeline-item-${escapeHtml(category.className)}">
      <span class="trace-monitor-timeline-dot"></span>
      <div class="trace-monitor-timeline-card">
        <div class="trace-monitor-timeline-head">
          <div class="trace-monitor-timeline-title">
            <span class="trace-monitor-timeline-kind">Step</span>
            <strong>${escapeHtml(step.step_name || step.step_type || 'Step')}</strong>
            ${category.label ? `<span class="trace-monitor-category-badge ${escapeHtml(getTraceCategoryBadgeClass(category.className))}">${escapeHtml(category.label)}</span>` : ''}
            <span class="trace-monitor-status ${escapeHtml(getTraceStatusClass(step.status))}">${escapeHtml(step.status || '--')}</span>
          </div>
          <div class="trace-monitor-timeline-time">
            <div>${escapeHtml(formatDateTime(step.started_at))}</div>
            <div>${escapeHtml(step.latency_ms || step.latency_ms === 0 ? formatDuration(step.latency_ms) : '--')}</div>
          </div>
        </div>
        ${step.summary ? `<div class="trace-monitor-timeline-summary">${escapeHtml(step.summary)}</div>` : ''}
        ${payloadBlock}
      </div>
    </div>
  `;
}

function renderTraceKv(items) {
  const visible = items.filter(
    (item) =>
      item &&
      item.value !== undefined &&
      item.value !== null &&
      item.value !== '',
  );
  if (!visible.length) return '';
  return `<div class="trace-monitor-structured-kv">${visible.map((item) => `<span><strong>${escapeHtml(item.label)}</strong>${escapeHtml(String(item.value))}</span>`).join('')}</div>`;
}

function renderTracePreview(label, value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const text = value.length > 800 ? `${value.slice(0, 800)}...` : value;
  return `
    <div class="trace-monitor-preview-block">
      <div class="trace-monitor-preview-label">${escapeHtml(label)}</div>
      <pre>${escapeHtml(text)}</pre>
    </div>
  `;
}

function renderTracePatchPreview(payload) {
  if (!Array.isArray(payload.patchPreview) || payload.patchPreview.length === 0)
    return '';
  return `
    <div class="trace-monitor-diff-block">
      ${payload.patchPreview
        .slice(0, 12)
        .map(
          (line) =>
            `<div class="agent-trace-diff-line ${String(line).startsWith('+') ? 'add' : String(line).startsWith('-') ? 'del' : ''}">${escapeHtml(String(line))}</div>`,
        )
        .join('')}
    </div>
  `;
}

function renderTraceStructuredEventSummary(event, category, payload) {
  const key = category?.key || 'general';
  if (key === 'tool') {
    return `
      <div class="trace-monitor-structured-summary">
        ${renderTraceKv([
          { label: 'Tool', value: payload.toolName || event.event_name },
          { label: 'Type', value: payload.toolType },
          {
            label: 'Duration',
            value:
              event.latency_ms || event.latency_ms === 0
                ? formatDuration(event.latency_ms)
                : '',
          },
          { label: 'Exit', value: payload.exitCode },
        ])}
        ${payload.commandPreview ? `<div class="trace-monitor-command-line">${escapeHtml(payload.commandPreview)}</div>` : ''}
        ${renderTracePreview('stdout', payload.stdoutPreview)}
        ${renderTracePreview('stderr', payload.stderrPreview)}
      </div>
    `;
  }
  if (key === 'file') {
    const path = tracePayloadPath(payload);
    return `
      <div class="trace-monitor-structured-summary">
        ${renderTraceKv([
          {
            label: 'Operation',
            value: payload.operation || event.event_name.replace(/^file_/, ''),
          },
          { label: 'Path', value: path },
          { label: '+', value: payload.additions },
          { label: '-', value: payload.deletions },
        ])}
        ${renderTracePatchPreview(payload)}
        ${renderTracePreview('preview', payload.contentPreview)}
      </div>
    `;
  }
  if (key === 'model') {
    const modelLatency = payload.latencyMs ?? event.latency_ms;
    return `
      <div class="trace-monitor-structured-summary">
        ${renderTraceKv([
          {
            label: 'Model',
            value: payload.actualModel || payload.requestedModel,
          },
          { label: 'Input', value: formatTraceNumber(payload.inputTokens) },
          { label: 'Output', value: formatTraceNumber(payload.outputTokens) },
          {
            label: 'Cache read',
            value: formatTraceNumber(payload.cacheReadTokens),
          },
          {
            label: 'Latency',
            value:
              modelLatency || modelLatency === 0
                ? formatDuration(modelLatency)
                : '',
          },
        ])}
      </div>
    `;
  }
  if (key === 'container') {
    const containerDuration = payload.durationMs ?? event.latency_ms;
    return `
      <div class="trace-monitor-structured-summary">
        ${renderTraceKv([
          { label: 'Runtime', value: payload.runtime },
          { label: 'Name', value: payload.containerName },
          { label: 'Image', value: payload.image },
          { label: 'Exit', value: payload.exitCode },
          { label: 'Reason', value: payload.terminatedReason },
          {
            label: 'Duration',
            value:
              containerDuration || containerDuration === 0
                ? formatDuration(containerDuration)
                : '',
          },
        ])}
        ${renderTracePreview('stderr', payload.stderrPreview)}
      </div>
    `;
  }
  if (key === 'evaluation') {
    return `
      <div class="trace-monitor-structured-summary">
        ${renderTraceKv([
          { label: 'Status', value: payload.status },
          { label: 'Score', value: payload.score },
          { label: 'Contract', value: payload.contract },
          { label: 'Findings', value: payload.findingCount },
          { label: 'Evidence', value: payload.evidenceCount },
        ])}
      </div>
    `;
  }
  if (key === 'ipc' || key === 'human' || key === 'artifact') {
    const genericLatency = payload.latencyMs ?? event.latency_ms;
    return `
      <div class="trace-monitor-structured-summary">
        ${renderTraceKv([
          {
            label: 'Operation',
            value: payload.operation || payload.action || event.event_name,
          },
          {
            label: 'Resource',
            value: payload.resourceRef || payload.requestId || payload.path,
          },
          { label: 'Status', value: payload.status || event.status },
          {
            label: 'Latency',
            value:
              genericLatency || genericLatency === 0
                ? formatDuration(genericLatency)
                : '',
          },
        ])}
      </div>
    `;
  }
  return '';
}

function renderTraceEventTimelineItem(event, category) {
  const payload = category?.payload || parseAgentEventPayload(event) || null;
  const payloadBlock = payload
    ? `<details class="trace-monitor-json-disclosure"><summary>Payload</summary><pre class="trace-monitor-json">${escapeHtml(stringifyTracePayload(payload))}</pre></details>`
    : '';
  const structuredSummary = renderTraceStructuredEventSummary(
    event,
    category,
    payload || {},
  );
  return `
    <div class="trace-monitor-timeline-item event trace-monitor-timeline-item-${escapeHtml(category.className)}">
      <span class="trace-monitor-timeline-dot"></span>
      <div class="trace-monitor-timeline-card">
        <div class="trace-monitor-timeline-head">
          <div class="trace-monitor-timeline-title">
            <span class="trace-monitor-timeline-kind">${escapeHtml(event.event_type || 'event')}</span>
            <strong>${escapeHtml(event.summary || event.event_name || 'Event')}</strong>
            ${category.label ? `<span class="trace-monitor-category-badge ${escapeHtml(getTraceCategoryBadgeClass(category.className))}">${escapeHtml(category.label)}</span>` : ''}
            ${event.status ? `<span class="trace-monitor-status ${escapeHtml(getTraceStatusClass(event.status))}">${escapeHtml(event.status)}</span>` : ''}
          </div>
          <div class="trace-monitor-timeline-time">
            <div>${escapeHtml(formatDateTime(event.created_at || event.started_at))}</div>
            <div>${escapeHtml(event.latency_ms || event.latency_ms === 0 ? formatDuration(event.latency_ms) : '--')}</div>
          </div>
        </div>
        ${structuredSummary || renderAgentTraceEvent(event)}
        ${payloadBlock}
      </div>
    </div>
  `;
}

function renderTraceRunDetail() {
  if (!currentTraceRunRecord) {
    renderTraceMonitorDetailEmpty();
    return;
  }
  if (traceMonitorDetail) traceMonitorDetail.classList.remove('hidden');
  if (traceMonitorDetailEmpty) traceMonitorDetailEmpty.classList.add('hidden');
  if (traceMonitorTitle) {
    traceMonitorTitle.textContent = getGroupDisplayNameByJid(
      currentTraceRunRecord.chat_jid,
    );
  }
  if (traceMonitorMeta) {
    traceMonitorMeta.innerHTML = renderTraceMetaPills(currentTraceRunRecord);
  }
  if (traceMonitorSummary) {
    traceMonitorSummary.innerHTML = renderTraceSummaryPills(
      currentTraceRunRecord,
    );
  }
  renderTraceTimeline();
}

async function loadTraceRunDetail(runId, scope) {
  currentTraceRunId = runId;
  currentTraceRunScope = scope || activeTraceMonitorScope;
  renderTraceMonitorList();
  if (traceMonitorTimeline) {
    traceMonitorTimeline.innerHTML = `<div class="trace-monitor-list-empty">正在加载 Trace 详情...</div>`;
  }
  if (traceMonitorDetail) traceMonitorDetail.classList.remove('hidden');
  if (traceMonitorDetailEmpty) traceMonitorDetailEmpty.classList.add('hidden');
  try {
    const detailRes = await apiFetch(
      `/api/agent-queries/${encodeURIComponent(runId)}/detail`,
    );
    if (detailRes.ok) {
      const detailData = await detailRes.json();
      currentTraceRunRecord = detailData.query || null;
      currentTraceRunSteps = Array.isArray(detailData.steps)
        ? detailData.steps
        : [];
      currentTraceRunEvents = Array.isArray(detailData.events)
        ? detailData.events
        : [];
      currentTraceRunSummary = detailData.summary || null;
      currentTraceRunHighlights = detailData.highlights || null;
    } else {
      const [runRes, stepsRes, eventsRes] = await Promise.all([
        apiFetch(`/api/agent-queries/${encodeURIComponent(runId)}`),
        apiFetch(`/api/agent-queries/${encodeURIComponent(runId)}/steps`),
        apiFetch(`/api/agent-queries/${encodeURIComponent(runId)}/events`),
      ]);
      if (!runRes.ok) throw new Error(`HTTP ${runRes.status}`);
      if (!stepsRes.ok) throw new Error(`HTTP ${stepsRes.status}`);
      if (!eventsRes.ok) throw new Error(`HTTP ${eventsRes.status}`);
      const runData = await runRes.json();
      const stepsData = await stepsRes.json();
      const eventsData = await eventsRes.json();
      currentTraceRunRecord = runData.query || null;
      currentTraceRunSteps = Array.isArray(stepsData.steps)
        ? stepsData.steps
        : [];
      currentTraceRunEvents = Array.isArray(eventsData.events)
        ? eventsData.events
        : [];
      currentTraceRunSummary = null;
      currentTraceRunHighlights = null;
    }
    renderTraceRunDetail();
  } catch (err) {
    console.error('Failed to load trace detail:', err);
    if (traceMonitorTimeline) {
      traceMonitorTimeline.innerHTML = `<div class="trace-monitor-list-empty">Trace 详情加载失败</div>`;
    }
    currentTraceRunSummary = null;
    currentTraceRunHighlights = null;
  }
}

function ensureTraceSelectionVisible(scope) {
  const runs = getFilteredTraceRunCollection(scope);
  if (!runs.length) {
    currentTraceRunId = '';
    renderTraceMonitorDetailEmpty();
    return;
  }
  const hasSelected = runs.some((run) => run.id === currentTraceRunId);
  if (!hasSelected) {
    loadTraceRunDetail(runs[0].id, scope);
    return;
  }
  renderTraceMonitorList();
}

function setTraceMonitorScope(scope) {
  activeTraceMonitorScope = scope === 'history' ? 'history' : 'active';
  traceMonitorScopeBtns.forEach((btn) => {
    btn.classList.toggle(
      'active',
      btn.getAttribute('data-trace-scope') === activeTraceMonitorScope,
    );
  });
  const runs = getFilteredTraceRunCollection(activeTraceMonitorScope);
  const hasSelected = runs.some((run) => run.id === currentTraceRunId);
  if (!hasSelected) {
    currentTraceRunId = '';
    currentTraceRunRecord = null;
    currentTraceRunSteps = [];
    currentTraceRunEvents = [];
  }
  renderTraceMonitorList();
  syncTraceMonitorHeaderActions();
  ensureTraceSelectionVisible(activeTraceMonitorScope);
  if (
    activeTraceMonitorScope === 'history' &&
    traceMonitorHistoryRuns.length === 0 &&
    !traceMonitorHistoryLoading
  ) {
    loadTraceHistoryPage({ reset: true })
      .then(() => {
        renderTraceMonitorList();
        syncTraceMonitorHeaderActions();
        ensureTraceSelectionVisible('history');
      })
      .catch((err) => {
        console.error('Failed to load trace history:', err);
      });
  }
}

function scheduleTraceDetailReload() {
  if (activePrimaryNavKey !== 'trace-monitor') return;
  if (activeTraceMonitorScope !== 'active') return;
  if (!currentTraceRunId) return;
  const isActiveSelected = getFilteredTraceRunCollection('active').some(
    (run) => run.id === currentTraceRunId,
  );
  if (!isActiveSelected) return;
  if (traceMonitorDetailReloadTimer) {
    clearTimeout(traceMonitorDetailReloadTimer);
  }
  traceMonitorDetailReloadTimer = setTimeout(() => {
    traceMonitorDetailReloadTimer = null;
    loadTraceRunDetail(currentTraceRunId, 'active');
  }, 350);
}

async function loadTraceMonitorData(options) {
  const force = Boolean(options && options.force);
  try {
    const activeRes = await apiFetch('/api/agent-queries/active');
    if (!activeRes.ok) throw new Error(`HTTP ${activeRes.status}`);
    const activeData = await activeRes.json();
    traceMonitorActiveRuns = sortTraceRunsByLatest(
      (activeData.queries || [])
        .map((run) => normalizeTraceRun(run, 'active'))
        .filter(Boolean),
    );
    if (force || traceMonitorHistoryRuns.length === 0) {
      await loadTraceHistoryPage({ reset: true });
    } else {
      traceMonitorHistoryRuns = traceMonitorHistoryRuns.filter(
        (run) =>
          !traceMonitorActiveRuns.some((activeRun) => activeRun.id === run.id),
      );
    }
    renderTraceMonitorList();
    syncTraceMonitorHeaderActions();
    if (force || !currentTraceRunId) {
      ensureTraceSelectionVisible(activeTraceMonitorScope);
      return;
    }
    const runs = getFilteredTraceRunCollection(activeTraceMonitorScope);
    if (runs.some((run) => run.id === currentTraceRunId)) {
      loadTraceRunDetail(currentTraceRunId, activeTraceMonitorScope);
    } else {
      ensureTraceSelectionVisible(activeTraceMonitorScope);
    }
  } catch (err) {
    console.error('Failed to load trace monitor:', err);
    if (traceMonitorList) {
      traceMonitorList.innerHTML = `<div class="trace-monitor-list-empty">Trace 列表加载失败</div>`;
    }
    syncTraceMonitorHeaderActions();
    renderTraceMonitorDetailEmpty();
  }
}

async function clearAllTraceHistory() {
  if (traceMonitorHistoryClearing) return;
  if (
    !(await openConfirmDialog(
      '确认删除所有 Agent 活动历史吗？\n\n当前仍在运行的活跃 Trace 不会被删除。',
      {
        title: '删除活动历史',
      },
    ))
  )
    return;
  traceMonitorHistoryClearing = true;
  syncTraceMonitorHeaderActions();
  try {
    const res = await apiFetch('/api/agent-queries', { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    traceMonitorHistoryRuns = [];
    traceMonitorHistoryOffset = 0;
    traceMonitorHistoryHasMore = false;
    traceMonitorHistoryJustCleared = true;
    if (currentTraceRunScope === 'history') {
      currentTraceRunId = '';
      currentTraceRunScope = 'history';
      renderTraceMonitorDetailEmpty();
    }
    await loadTraceHistoryPage({ reset: true });
    renderTraceMonitorList();
    syncTraceMonitorHeaderActions();
    showToast(`已删除 ${Number(data.deleted || 0)} 条活动历史`);
  } catch (err) {
    console.error('Failed to clear trace history:', err);
    alert('删除活动历史失败');
  } finally {
    traceMonitorHistoryClearing = false;
    syncTraceMonitorHeaderActions();
  }
}

async function loadMessages() {
  if (!currentGroupJid) return;
  try {
    const res = await apiFetch(
      `/api/messages?jid=${encodeURIComponent(currentGroupJid)}&since=0&limit=${INITIAL_MESSAGE_LIMIT}`,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    messages = data.messages.map((m) => ({
      ...m,
      _filePath: m.file_path || undefined,
      _fileUrl: m.file_url || undefined,
    }));
    hasMoreHistory = messages.length >= INITIAL_MESSAGE_LIMIT;
    renderMessages();
  } catch (err) {
    console.error('Failed to load messages:', err);
  }
}

// --- Infinite scroll: load older messages ---
async function loadMoreHistory() {
  if (!currentGroupJid || !hasMoreHistory || loadingHistory) return;
  if (messages.length === 0) return;

  loadingHistory = true;
  const oldestTs = messages[0].timestamp;
  const prevScrollHeight = messagesEl.scrollHeight;

  try {
    const res = await apiFetch(
      `/api/messages?jid=${encodeURIComponent(currentGroupJid)}&before=${oldestTs}&limit=50`,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.messages.length === 0) {
      hasMoreHistory = false;
      return;
    }
    // Prepend older messages
    const olderMessages = data.messages.map((m) => ({
      ...m,
      _filePath: m.file_path || undefined,
      _fileUrl: m.file_url || undefined,
    }));
    messages = [...olderMessages, ...messages];
    // Rebuild DOM and restore scroll position
    renderMessages();
    const newScrollHeight = messagesEl.scrollHeight;
    messagesEl.scrollTop = newScrollHeight - prevScrollHeight;
  } catch (err) {
    console.error('Failed to load history:', err);
  } finally {
    loadingHistory = false;
  }
}

function connectWS() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  setConnectionStatus('connecting');
  const wsUrl = `${WS_BASE_URL}/ws`;
  ws = new WebSocket(wsUrl);
  ws.onopen = () => {
    setConnectionStatus('connected');
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    sendDesktopCaptureCapabilities();
    if (currentGroupJid) {
      sendWs({ type: 'select_group', chatJid: currentGroupJid });
    }
  };
  ws.onclose = () => {
    setConnectionStatus('disconnected');
    ws = null;
    reconnectTimer = setTimeout(connectWS, 3e3);
  };
  ws.onerror = (err) => {
    console.error('WS error:', err);
    setConnectionStatus('disconnected');
  };
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      handleWsMessage(msg);
    } catch {
      console.error('Failed to parse WS message:', e.data);
    }
  };
}
function sendWs(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sendDesktopCaptureCapabilities() {
  const appApi = typeof window !== 'undefined' ? window.icarusApp : null;
  sendWs({
    type: 'desktop_capture_capabilities',
    supported: Boolean(appApi?.captureDesktop),
    platform: appApi?.platform || navigator.platform || 'browser',
  });
}

async function handleDesktopCaptureRequest(msg) {
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
  if (!requestId) return;

  const appApi = typeof window !== 'undefined' ? window.icarusApp : null;
  if (!appApi?.captureDesktop) {
    sendWs({
      type: 'desktop_capture_result',
      requestId,
      ok: false,
      error: 'Desktop capture is only available in the Electron client.',
    });
    return;
  }

  try {
    const result = await appApi.captureDesktop({
      displayId: typeof msg.displayId === 'string' ? msg.displayId : undefined,
      maxWidth: typeof msg.maxWidth === 'number' ? msg.maxWidth : undefined,
      includeImage: msg.includeImage !== false,
      includeWindows: msg.includeWindows === true,
    });
    sendWs({
      type: 'desktop_capture_result',
      requestId,
      ok: result?.ok === true,
      error: result?.error,
      details:
        [
          result?.details,
          result?.screenPermission
            ? `screenPermission=${result.screenPermission}`
            : null,
        ]
          .filter(Boolean)
          .join('\n') || undefined,
      capturedAt: result?.capturedAt,
      displays: result?.displays || [],
      windows: result?.windows || [],
      imageBase64: result?.imageBase64,
      mimeType: result?.mimeType,
      width: result?.width,
      height: result?.height,
      displayId: result?.displayId,
    });
  } catch (err) {
    sendWs({
      type: 'desktop_capture_result',
      requestId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function isAppForeground() {
  if (typeof document === 'undefined') return false;
  return document.visibilityState === 'visible' && document.hasFocus();
}

function shouldIncrementUnread(chatJid) {
  if (!chatJid) return false;
  if (chatJid !== currentGroupJid) return true;
  // Current group should also become unread if app is not in foreground.
  return !isAppForeground();
}

function clearUnreadForGroup(chatJid) {
  if (!chatJid) return;
  if (!unreadCounts[chatJid]) return;
  unreadCounts[chatJid] = 0;
  renderGroups();
}

function clearCurrentGroupUnreadIfForeground() {
  if (!currentGroupJid) return;
  if (!isAppForeground()) return;
  clearUnreadForGroup(currentGroupJid);
}


function handleWsMessage(msg) {
  switch (msg.type) {
    case 'connected':
      console.log('WS connected:', msg.message);
      break;
    case 'groups':
      groups = msg.groups || [];
      renderGroups();
      if (activePrimaryNavKey === 'trace-monitor') {
        renderTraceMonitorList();
        if (currentTraceRunRecord) {
          renderTraceRunDetail();
        }
      }
      break;
    case 'message': {
      const incoming = {
        id: msg.id,
        chat_jid: msg.chatJid,
        sender: msg.sender,
        sender_name: msg.sender_name || msg.sender,
        content: msg.content,
        timestamp: msg.timestamp,
        is_from_me: msg.is_from_me || false,
        is_bot_message: msg.is_bot_message || false,
        reply_to_id: msg.reply_to_id || null,
        model: msg.model || null,
      };
      if (incoming.chat_jid === currentGroupJid) {
        messages.push(incoming);
        const dropped = trimLiveMessageBuffer();
        if (dropped > 0) {
          renderMessages();
        } else {
          appendSingleMessage(incoming);
        }
        if (!incoming.is_from_me) {
          scheduleModelSync();
        }
      }
      if (!incoming.is_from_me && shouldIncrementUnread(incoming.chat_jid)) {
        unreadCounts[incoming.chat_jid] =
          (unreadCounts[incoming.chat_jid] || 0) + 1;
        renderGroups();
      }
      if (!incoming.is_from_me) {
        notifyAgent(incoming);
      }
      break;
    }
    case 'card': {
      const cardMsg = {
        id: msg.cardId,
        chat_jid: msg.chatJid,
        sender: 'assistant',
        sender_name: 'Assistant',
        content: JSON.stringify({ _type: 'card', card: msg.card }),
        timestamp: msg.timestamp,
        is_from_me: false,
        is_bot_message: true,
      };
      if (cardMsg.chat_jid === currentGroupJid) {
        messages.push(cardMsg);
        const dropped = trimLiveMessageBuffer();
        if (dropped > 0) {
          renderMessages();
        } else {
          appendSingleMessage(cardMsg);
        }
      }
      if (shouldIncrementUnread(cardMsg.chat_jid)) {
        unreadCounts[cardMsg.chat_jid] =
          (unreadCounts[cardMsg.chat_jid] || 0) + 1;
        renderGroups();
      }
      notifyAgent(cardMsg);
      break;
    }
    case 'file': {
      const content = msg.caption || `文件: ${msg.filePath.split('/').pop()}`;
      const fileMsg = {
        id:
          msg.id ||
          `file_${msg.timestamp}_${Math.random().toString(36).slice(2, 8)}`,
        chat_jid: msg.chatJid,
        sender: msg.sender || 'assistant',
        sender_name: msg.sender || 'Assistant',
        content,
        timestamp: msg.timestamp,
        is_from_me: false,
        is_bot_message: true,
        _filePath: msg.filePath,
        _fileUrl: msg.fileUrl || undefined,
      };
      if (fileMsg.chat_jid === currentGroupJid) {
        messages.push(fileMsg);
        const dropped = trimLiveMessageBuffer();
        if (dropped > 0) {
          renderMessages();
        } else {
          appendSingleMessage(fileMsg);
        }
      }
      if (shouldIncrementUnread(fileMsg.chat_jid)) {
        unreadCounts[fileMsg.chat_jid] =
          (unreadCounts[fileMsg.chat_jid] || 0) + 1;
        renderGroups();
      }
      notifyAgent(fileMsg);
      break;
    }
    case 'typing':
      typingIndicator.className = msg.isTyping ? '' : 'hidden';
      break;
    case 'agent_status':
      if (agentStatusPanel.classList.contains('open')) {
        renderAgentStatus(msg.agents || []);
      }
      break;
    case 'agent_query_trace':
      updateAgentRunTraces(msg.queries || []);
      traceMonitorActiveRuns = (msg.queries || [])
        .map((run) => normalizeTraceRun(run, 'active'))
        .filter(Boolean);
      if (agentStatusPanel.classList.contains('open')) {
        renderAgentStatus(agentStatusData);
      }
      if (activePrimaryNavKey === 'trace-monitor') {
        if (activeTraceMonitorScope === 'active') {
          renderTraceMonitorList();
        }
        scheduleTraceDetailReload();
      }
      break;
    case 'card_action_result': {
      const pending = pendingCardActions.get(msg.requestId);
      if (!pending) break;
      clearTimeout(pending.timer);
      pendingCardActions.delete(msg.requestId);
      if (msg.ok === false) {
        pending.reject(
          new Error(msg.error || msg.toast?.content || '操作提交失败'),
        );
      } else {
        if (msg.toast?.content) showToast(msg.toast.content, 1800);
        pending.resolve(msg);
      }
      break;
    }
    case 'assistant_state':
      assistantState = msg.state || null;
      assistantInboxItems = Array.isArray(msg.state?.latestInboxItems)
        ? msg.state.latestInboxItems
        : assistantInboxItems;
      assistantActionLogs = Array.isArray(msg.state?.latestActionLogs)
        ? msg.state.latestActionLogs
        : assistantActionLogs;
      if (activePrimaryNavKey === 'assistant') renderAssistantScreen();
      break;
    case 'assistant_event':
      handleAssistantRealtimeEvent(msg.event);
      break;
    case 'config_event':
      handleConfigRealtimeEvent(msg.event);
      break;
    case 'desktop_capture_request':
      handleDesktopCaptureRequest(msg);
      break;
    case 'error':
      console.error('WS error from server:', msg.message);
      showError(`Server error: ${msg.message}`);
      break;
  }
}
function notifyAgent(msg) {
  const group = groups.find((g) => g.jid === msg.chat_jid);
  const title = `${group?.name || 'Support Group Agent'}`;
  const body = `${msg.sender_name}: ${msg.content.slice(0, 100)}`;
  if (typeof window !== 'undefined' && window.icarusApp) {
    window.icarusApp.notify(title, body, { chatJid: msg.chat_jid });
    return;
  }

  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') {
    ensureBrowserNotificationPermission();
    return;
  }

  const notification = new Notification(title, {
    body,
    tag: `icarus-${msg.chat_jid}`,
  });
  notification.onclick = () => {
    window.focus();
    openAgentGroupFromNotification(msg.chat_jid, 'browser');
  };
}

function openAgentGroupFromNotification(chatJid, source) {
  if (typeof chatJid !== 'string' || !chatJid) return;
  setPrimaryNav('agent-groups');
  if (chatJid === currentGroupJid) {
    clearUnreadForGroup(chatJid);
    return;
  }
  selectGroup(chatJid).catch((err) => {
    console.error(
      `Failed to switch group from ${source} notification click:`,
      err,
    );
  });
}

function ensureBrowserNotificationPermission() {
  if (typeof window === 'undefined' || window.icarusApp) return;
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'default') return;
  if (browserNotificationPermissionRequested) return;

  browserNotificationPermissionRequested = true;
  Notification.requestPermission().catch((err) => {
    console.error('Failed to request browser notification permission:', err);
  });
}

function bindNotificationPermissionPrimer() {
  if (typeof window === 'undefined' || window.icarusApp) return;
  const requestOnce = () => ensureBrowserNotificationPermission();
  window.addEventListener('pointerdown', requestOnce, {
    once: true,
    capture: true,
  });
  window.addEventListener('keydown', requestOnce, {
    once: true,
    capture: true,
  });
}

function bindNotificationClickHandler() {
  if (typeof window === 'undefined' || !window.icarusApp?.onNotificationClick)
    return;
  window.icarusApp.onNotificationClick(({ chatJid }) => {
    openAgentGroupFromNotification(chatJid, 'native');
  });
}
async function selectGroup(jid) {
  if (multiSelectMode) exitMultiSelect();
  // Clear staged files when switching groups
  pendingFiles = [];
  pendingFileReferences = [];
  renderPendingFiles();
  currentGroupJid = jid;
  messages = [];
  hasMoreHistory = true;

  // Clear unread for this group
  unreadCounts[jid] = 0;

  // Show skeleton while loading
  showSkeleton();
  updateChatHeader();
  renderGroups();

  await loadMessages();
  sendWs({ type: 'select_group', chatJid: jid });
}

function appendOptimisticMessage(chatJid, content, replyToId = null) {
  const userMsg = {
    id: `opt_${Date.now()}`,
    chat_jid: chatJid,
    sender: 'me',
    sender_name: 'You',
    content,
    timestamp: Date.now().toString(),
    is_from_me: true,
    is_bot_message: false,
    reply_to_id: replyToId,
  };
  if (chatJid !== currentGroupJid) return;
  messages.push(userMsg);
  const dropped = trimLiveMessageBuffer();
  if (dropped > 0) {
    renderMessages();
  } else {
    appendSingleMessage(userMsg);
  }
}

async function sendMessageToChat(chatJid, content, options = {}) {
  const trimmed = content.trim();
  if (
    !trimmed &&
    pendingFiles.length === 0 &&
    pendingFileReferences.length === 0
  )
    return false;
  if (!chatJid) return false;

  // Upload pending files first and prepend their container paths
  let filePrefix = buildPendingFileReferencesPrefix();
  if (pendingFiles.length > 0) {
    try {
      filePrefix += await uploadPendingFiles();
    } catch (err) {
      showError(`附件上传失败: ${err}`);
      return false;
    }
  }
  pendingFileReferences = [];
  renderPendingFiles();

  const fullContent = filePrefix + trimmed;
  const payload = {
    type: 'message',
    chatJid,
    content: fullContent,
  };

  // Include reply reference if set
  const replyToId =
    options.replyToId === undefined
      ? replyToMsg
        ? replyToMsg.id
        : null
      : options.replyToId;
  if (replyToId) {
    payload.replyToId = replyToId;
  }

  sendWs(payload);
  if (options.optimistic !== false) {
    appendOptimisticMessage(chatJid, fullContent, replyToId);
  }
  return true;
}

async function sendMessage(content) {
  const sent = await sendMessageToChat(currentGroupJid, content);
  if (!sent) return;
  messageInput.value = '';
  autoResizeInput();
  clearReplyTo();
  hideCommandPalette();
  hideMentionPicker(false);
}

// --- Reply handling ---
function setReplyTo(msg) {
  replyToMsg = msg;
  const senderName = getMessageSenderDisplayName(
    msg,
    msg.sender_name || msg.sender,
  );
  replyPreviewContent.textContent = `${senderName}: ${getMessagePreviewText(msg)}`;
  replyPreview.classList.add('visible');
  messageInput.focus();
}

function clearReplyTo() {
  replyToMsg = null;
  replyPreview.classList.remove('visible');
  replyPreviewContent.textContent = '';
}

// --- Command palette ---
function ensureCommandPaletteElements() {
  if (!commandPalette || commandSearchInput || commandOptionsEl) return;

  const searchWrap = document.createElement('div');
  searchWrap.className = 'command-search-wrap';
  commandSearchInput = document.createElement('input');
  commandSearchInput.id = 'command-search-input';
  commandSearchInput.type = 'text';
  commandSearchInput.placeholder = '搜索命令';
  searchWrap.appendChild(commandSearchInput);
  commandPalette.appendChild(searchWrap);

  commandOptionsEl = document.createElement('div');
  commandOptionsEl.id = 'command-options';
  commandPalette.appendChild(commandOptionsEl);

  commandSearchInput.addEventListener('input', () => {
    cmdPaletteIndex = 0;
    renderCommandOptions();
  });

  commandSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      navigateCommandPalette(-1);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      navigateCommandPalette(1);
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (commandCandidates.length > 0) {
        e.preventDefault();
        executeCommand(commandCandidates[Math.max(cmdPaletteIndex, 0)]);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      hideCommandPalette();
    }
  });
}

function getCommandCandidates(query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return commands.slice();
  return commands.filter(
    (c) => fuzzyMatch(c.name.replace(/^\//, ''), q) || fuzzyMatch(c.desc, q),
  );
}

function renderCommandOptions() {
  if (!commandOptionsEl || !commandSearchInput) return;
  const query = commandSearchInput.value || '';
  commandCandidates = getCommandCandidates(query);
  commandOptionsEl.innerHTML = '';

  if (commandCandidates.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'mention-empty';
    empty.textContent = '没有匹配命令';
    commandOptionsEl.appendChild(empty);
    cmdPaletteIndex = -1;
    return;
  }

  if (cmdPaletteIndex < 0 || cmdPaletteIndex >= commandCandidates.length) {
    cmdPaletteIndex = 0;
  }

  commandCandidates.forEach((cmd, i) => {
    const item = document.createElement('div');
    item.className = `cmd-item${i === cmdPaletteIndex ? ' active' : ''}`;
    item.innerHTML = `<span class="cmd-item-name">${escapeHtml(cmd.name)}</span><span class="cmd-item-desc">${escapeHtml(cmd.desc)}</span>`;
    item.addEventListener('click', () => executeCommand(cmd));
    commandOptionsEl.appendChild(item);
  });
}

async function executeCommand(cmd) {
  hideCommandPalette(false);
  if (!cmd) return;
  messageInput.value = cmd.name + ' ';
  messageInput.focus();
  autoResizeInput();
}

function showCommandPalette(filter) {
  if (mentionPickerVisible) hideMentionPicker(false);
  if (!commandPalette) return;
  ensureCommandPaletteElements();
  commandInsertPos = messageInput.selectionStart;
  commandPickerVisible = true;
  commandPalette.classList.add('visible');
  cmdPaletteIndex = 0;
  const initial = (filter || '').replace(/^\//, '');
  if (commandSearchInput) commandSearchInput.value = initial;
  renderCommandOptions();
  commandSearchInput?.focus();
}

function hideCommandPalette(restoreFocus = true) {
  if (!commandPalette) return;
  commandPickerVisible = false;
  commandPalette.classList.remove('visible');
  cmdPaletteIndex = -1;
  commandCandidates = [];
  commandInsertPos = null;
  if (restoreFocus) messageInput.focus();
}


function navigateCommandPalette(direction) {
  if (!commandOptionsEl || commandCandidates.length === 0) return;
  const items = commandOptionsEl.querySelectorAll('.cmd-item');
  items[cmdPaletteIndex]?.classList.remove('active');
  cmdPaletteIndex =
    (cmdPaletteIndex + direction + commandCandidates.length) %
    commandCandidates.length;
  items[cmdPaletteIndex]?.classList.add('active');
  items[cmdPaletteIndex]?.scrollIntoView({ block: 'nearest' });
}

function selectCommandPaletteItem() {
  if (cmdPaletteIndex >= 0 && cmdPaletteIndex < commandCandidates.length) {
    executeCommand(commandCandidates[cmdPaletteIndex]);
  }
}

function fuzzyMatch(text, query) {
  const source = (text || '').toLowerCase();
  const target = (query || '').trim().toLowerCase();
  if (!target) return true;
  if (source.includes(target)) return true;
  let j = 0;
  for (let i = 0; i < source.length && j < target.length; i++) {
    if (source[i] === target[j]) j++;
  }
  return j === target.length;
}

function getMentionTargets() {
  const targets = [{ name: 'Andy', kind: '助手' }];
  const seen = new Set(['andy']);
  const folders = groups
    .filter(
      (g) =>
        g &&
        typeof g.jid === 'string' &&
        g.jid.startsWith('web:') &&
        typeof g.folder === 'string' &&
        g.folder.trim(),
    )
    .map((g) => g.folder.trim());
  folders.sort((a, b) => a.localeCompare(b, 'zh-CN'));

  for (const folder of folders) {
    const key = folder.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ name: folder, kind: '群组' });
  }
  return targets;
}

function ensureMentionPickerElements() {
  if (!mentionPicker || mentionSearchInput || mentionOptionsEl) return;

  const searchWrap = document.createElement('div');
  searchWrap.className = 'mention-search-wrap';
  mentionSearchInput = document.createElement('input');
  mentionSearchInput.id = 'mention-search-input';
  mentionSearchInput.type = 'text';
  mentionSearchInput.placeholder = '搜索助手或群组';
  searchWrap.appendChild(mentionSearchInput);
  mentionPicker.appendChild(searchWrap);

  mentionOptionsEl = document.createElement('div');
  mentionOptionsEl.id = 'mention-options';
  mentionPicker.appendChild(mentionOptionsEl);

  mentionSearchInput.addEventListener('input', () => {
    mentionPickerIndex = 0;
    renderMentionOptions();
  });

  mentionSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      navigateMentionPicker(-1);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      navigateMentionPicker(1);
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (mentionCandidates.length > 0) {
        e.preventDefault();
        selectMention(mentionCandidates[Math.max(mentionPickerIndex, 0)].name);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      hideMentionPicker();
    }
  });
}

function renderMentionOptions() {
  if (!mentionOptionsEl || !mentionSearchInput) return;
  const query = mentionSearchInput.value || '';
  mentionCandidates = getMentionTargets().filter((item) =>
    fuzzyMatch(item.name, query),
  );
  mentionOptionsEl.innerHTML = '';

  if (mentionCandidates.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'mention-empty';
    empty.textContent = '没有匹配项';
    mentionOptionsEl.appendChild(empty);
    mentionPickerIndex = -1;
    return;
  }

  if (
    mentionPickerIndex < 0 ||
    mentionPickerIndex >= mentionCandidates.length
  ) {
    mentionPickerIndex = 0;
  }

  mentionCandidates.forEach((item, i) => {
    const el = document.createElement('div');
    el.className = `mention-item${i === mentionPickerIndex ? ' active' : ''}`;
    el.innerHTML = `<span class="mention-name">${escapeHtml('@' + item.name)}</span><span class="mention-kind">${escapeHtml(item.kind)}</span>`;
    el.addEventListener('click', () => selectMention(item.name));
    mentionOptionsEl.appendChild(el);
  });
}

function navigateMentionPicker(direction) {
  if (!mentionOptionsEl || mentionCandidates.length === 0) return;
  mentionPickerIndex =
    (mentionPickerIndex + direction + mentionCandidates.length) %
    mentionCandidates.length;
  const items = mentionOptionsEl.querySelectorAll('.mention-item');
  items.forEach((el, i) =>
    el.classList.toggle('active', i === mentionPickerIndex),
  );
  items[mentionPickerIndex]?.scrollIntoView({ block: 'nearest' });
}

function showMentionPicker() {
  if (!mentionPicker) return;
  hideCommandPalette();
  ensureMentionPickerElements();
  mentionInsertPos = messageInput.selectionStart;
  mentionPickerVisible = true;
  mentionPicker.classList.add('visible');
  mentionPickerIndex = 0;
  if (mentionSearchInput) mentionSearchInput.value = '';
  renderMentionOptions();
  mentionSearchInput?.focus();
}

function hideMentionPicker(restoreFocus = true) {
  if (!mentionPicker) return;
  mentionPickerVisible = false;
  mentionPicker.classList.remove('visible');
  mentionCandidates = [];
  mentionPickerIndex = -1;
  mentionInsertPos = null;
  if (restoreFocus) messageInput.focus();
}

function selectMention(name) {
  const ta = messageInput;
  const pos =
    typeof mentionInsertPos === 'number' ? mentionInsertPos : ta.selectionStart;
  const mentionText = `@${name} `;
  ta.value = ta.value.substring(0, pos) + mentionText + ta.value.substring(pos);
  ta.selectionStart = ta.selectionEnd = pos + mentionText.length;
  hideMentionPicker(false);
  ta.focus();
  autoResizeInput();
}

function referenceFileInComposer(containerPath) {
  stageFileReference(containerPath);
  showToast('已引用文件');
}

function clipboardImageExtension(mimeType) {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpg';
  if (normalized === 'image/gif') return 'gif';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/svg+xml') return 'svg';
  const subtype = normalized
    .split('/')[1]
    ?.replace('+xml', '')
    .replace(/[^a-z0-9]/g, '');
  return subtype || 'png';
}

function clipboardImageTimestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

function isGenericClipboardImageName(name) {
  return !name || /^image\.(png|jpe?g|gif|webp|svg)$/i.test(name);
}

function withClipboardImageName(file, index, count) {
  const originalName = typeof file.name === 'string' ? file.name.trim() : '';
  if (!isGenericClipboardImageName(originalName)) return file;

  const suffix = count > 1 ? `-${index + 1}` : '';
  const filename = `clipboard-image-${clipboardImageTimestamp()}${suffix}.${clipboardImageExtension(file.type)}`;
  if (typeof File !== 'function') return file;

  try {
    return new File([file], filename, {
      type: file.type || 'image/png',
      lastModified: Date.now(),
    });
  } catch {
    return file;
  }
}

function getClipboardImageFiles(event) {
  const clipboardData = event.clipboardData;
  if (!clipboardData) return [];

  const itemFiles = Array.from(clipboardData.items || [])
    .filter(
      (item) =>
        item.kind === 'file' && String(item.type || '').startsWith('image/'),
    )
    .map((item) =>
      typeof item.getAsFile === 'function' ? item.getAsFile() : null,
    )
    .filter(Boolean);
  const rawFiles =
    itemFiles.length > 0
      ? itemFiles
      : Array.from(clipboardData.files || []).filter((file) =>
          String(file.type || '').startsWith('image/'),
        );

  return rawFiles.map((file, index) =>
    withClipboardImageName(file, index, rawFiles.length),
  );
}

function handleComposerPaste(event) {
  const imageFiles = getClipboardImageFiles(event);
  if (imageFiles.length === 0) return;

  event.preventDefault();
  if (!currentGroupJid) {
    showToast('请选择群聊后再粘贴图片', 1800);
    return;
  }

  for (const file of imageFiles) {
    stageFile(file);
  }
  showToast(
    imageFiles.length > 1 ? `已暂存 ${imageFiles.length} 张图片` : '已暂存图片',
  );
}

// Stage a file for upload on next send
function stageFile(file) {
  if (!currentGroupJid) return;
  pendingFiles.push(file);
  renderPendingFiles();
}

function stageFileReference(containerPath) {
  const normalized = String(containerPath || '').trim();
  if (!normalized || !currentGroupJid) return;
  if (!pendingFileReferences.includes(normalized)) {
    pendingFileReferences.push(normalized);
  }
  renderPendingFiles();
  messageInput.focus();
}

function getFileReferenceName(containerPath) {
  const normalized = String(containerPath || '').replace(/\\/g, '/');
  return (
    normalized.split('/').filter(Boolean).pop() || normalized || '未命名文件'
  );
}

function buildPendingFileReferencesPrefix() {
  const paths = pendingFileReferences
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  if (paths.length === 0) return '';
  return (
    '【引用文件】\n' + paths.map((p) => `文件地址: ${p}`).join('\n') + '\n'
  );
}

// Render the pending files preview bar
function renderPendingFiles() {
  if (pendingFiles.length === 0 && pendingFileReferences.length === 0) {
    pendingFilesEl.classList.remove('visible');
    pendingFilesContent.textContent = '';
    return;
  }
  const parts = [];
  if (pendingFiles.length > 0) {
    const names = pendingFiles
      .map((f) => escapeHtml(f.name || '未命名附件'))
      .join(', ');
    parts.push(`${pendingFiles.length} 个附件: ${names}`);
  }
  if (pendingFileReferences.length > 0) {
    const names = pendingFileReferences
      .map((filePath) => escapeHtml(getFileReferenceName(filePath)))
      .join(', ');
    parts.push(`${pendingFileReferences.length} 个引用: ${names}`);
  }
  pendingFilesContent.innerHTML = `${SVG.paperclip} ${parts.join(' · ')}`;
  pendingFilesEl.classList.add('visible');
}

// Upload all pending files and return the prefix string to prepend to the message
async function uploadFilesForJid(files, jid) {
  const safeFiles = Array.isArray(files) ? files : [];
  if (safeFiles.length === 0) return [];
  if (!jid) throw new Error('缺少上传目标');
  const agentPaths = [];
  const uploadedFiles = [];
  for (const file of safeFiles) {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(
      apiUrl(`/api/upload?jid=${encodeURIComponent(jid)}`),
      { method: 'POST', body: formData },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Upload failed: ${res.status}`);
    if (Array.isArray(data.files)) {
      uploadedFiles.push(...data.files);
      for (const uploaded of data.files) {
        if (uploaded?.agentPath) agentPaths.push(uploaded.agentPath);
      }
    }
  }
  return uploadedFiles.length > 0
    ? uploadedFiles
    : agentPaths.map((agentPath) => ({ agentPath }));
}

function buildUploadedFilesPrefix(uploadedFiles) {
  const agentPaths = Array.isArray(uploadedFiles)
    ? uploadedFiles.map((file) => file.agentPath).filter(Boolean)
    : [];
  if (agentPaths.length === 0) return '';
  return (
    '【附件】\n' + agentPaths.map((p) => `文件地址: ${p}`).join('\n') + '\n'
  );
}

// Upload all pending files and return the prefix string to prepend to the message
async function uploadPendingFiles() {
  if (pendingFiles.length === 0) return '';

  const uploadedFiles = await uploadFilesForJid(pendingFiles, currentGroupJid);
  pendingFiles = [];
  renderPendingFiles();

  return buildUploadedFilesPrefix(uploadedFiles);
}
function showError(msg) {
  const el = document.createElement('div');
  el.className = 'message system';
  el.textContent = `\u26A0 ${msg}`;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  setTimeout(() => el.remove(), 5e3);
}
// --- Single message copy ---
function copyMessageContent(msg) {
  navigator.clipboard.writeText(msg.content).then(() => showCopyToast());
}

function showCopyToast() {
  showToast('\u5DF2\u590D\u5236');
}

function showToast(message, duration = 1500) {
  let toast = document.getElementById('copy-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'copy-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.remove('visible');
  void toast.offsetWidth;
  toast.classList.add('visible');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('visible'), duration);
}

// --- Multi-select ---
function preserveMessageScrollAfterLayoutChange(applyChange) {
  const distanceFromBottom = Math.max(
    0,
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight,
  );

  applyChange();

  requestAnimationFrame(() => {
    messagesEl.scrollTop = Math.max(
      0,
      messagesEl.scrollHeight - messagesEl.clientHeight - distanceFromBottom,
    );
  });
}

function enterMultiSelect() {
  preserveMessageScrollAfterLayoutChange(() => {
    multiSelectMode = true;
    messagesEl.classList.add('multi-select');
    multiSelectBar.classList.add('visible');
    selectModeBtn.classList.add('active');
    selectModeBtn.innerHTML = SVG.checkSquare;
    inputArea.style.display = 'none';
    selectedMsgIds.clear();
    updateMultiSelectBar();
  });
}

function exitMultiSelect() {
  preserveMessageScrollAfterLayoutChange(() => {
    multiSelectMode = false;
    messagesEl.classList.remove('multi-select');
    multiSelectBar.classList.remove('visible');
    selectModeBtn.classList.remove('active');
    selectModeBtn.innerHTML = originalSelectIcon;
    inputArea.style.display = '';
    messagesEl
      .querySelectorAll('.message.selected')
      .forEach((el) => el.classList.remove('selected'));
    selectedMsgIds.clear();
    updateMultiSelectBar();
  });
}

function toggleMultiSelectMode() {
  if (multiSelectMode) exitMultiSelect();
  else enterMultiSelect();
}

function toggleMessageSelection(msgId, el) {
  if (selectedMsgIds.has(msgId)) {
    selectedMsgIds.delete(msgId);
    el.classList.remove('selected');
  } else {
    selectedMsgIds.add(msgId);
    el.classList.add('selected');
  }
  updateMultiSelectBar();
}

function updateMultiSelectBar() {
  const count = selectedMsgIds.size;
  selectedCountEl.textContent = '\u5DF2\u9009 ' + count + ' \u6761';
  copySelectedBtn.disabled = count === 0;
  deleteSelectedBtn.disabled = count === 0;
}

function copySelectedMessages() {
  const selected = messages.filter((m) => selectedMsgIds.has(m.id));
  if (selected.length === 0) return;
  const text = selected
    .map((m) => {
      const sender = m.sender_name || m.sender || 'Unknown';
      const time = formatTime(m.timestamp);
      return `[${sender}] ${time}\n${m.content}`;
    })
    .join('\n\n');
  navigator.clipboard.writeText(text).then(() => {
    showCopyToast();
    exitMultiSelect();
  });
}

async function deleteSelectedMessages() {
  if (!currentGroupJid) return;
  const ids = Array.from(selectedMsgIds);
  if (ids.length === 0) return;
  if (
    !(await openConfirmDialog(`删除已选的 ${ids.length} 条消息？`, {
      title: '删除消息',
    }))
  )
    return;

  try {
    const res = await apiFetch('/api/messages', {
      method: 'DELETE',
      body: JSON.stringify({ jid: currentGroupJid, ids }),
    });
    if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
    await res.json();
    await loadMessages();
    exitMultiSelect();
  } catch (err) {
    console.error('Failed to delete selected messages:', err);
    alert('删除失败');
  }
}

function autoResizeInput() {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
}

function initTakeCopterCursor() {
  // Keep the default system cursor in the web client.
  document.body.classList.remove(
    'take-copter-cursor-on',
    'take-copter-cursor-text',
  );
  document.querySelector('.take-copter-cursor')?.remove();
}

function initChatBgParticleNudge() {
  const chatAreaEl = document.getElementById('chat-area');
  const bgEl = document.getElementById('chat-animated-bg');
  if (!chatAreaEl || !bgEl) return;

  const targets = Array.from(bgEl.querySelectorAll('.bg-particle, .bg-star'));
  if (targets.length === 0) return;

  function applyNudge(clientX, clientY) {
    const areaRect = chatAreaEl.getBoundingClientRect();
    const radius = 190;
    const maxPush = 16;

    targets.forEach((el) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = cx - clientX;
      const dy = cy - clientY;
      const d = Math.hypot(dx, dy);

      if (d <= 0.01 || d > radius) {
        el.style.translate = '0 0';
        return;
      }

      const force = (1 - d / radius) * maxPush;
      const nx = (dx / d) * force;
      const ny = (dy / d) * force;

      // Constrain tiny elements inside chat area while nudging.
      const safeX = Math.max(-20, Math.min(20, nx));
      const safeY = Math.max(-16, Math.min(16, ny));
      const inArea =
        cx >= areaRect.left &&
        cx <= areaRect.right &&
        cy >= areaRect.top &&
        cy <= areaRect.bottom;
      el.style.translate = inArea ? `${safeX}px ${safeY}px` : '0 0';
    });
  }

  chatAreaEl.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      applyNudge(e.clientX, e.clientY);
    },
    { passive: true },
  );

  chatAreaEl.addEventListener('pointerleave', () => {
    targets.forEach((el) => {
      el.style.translate = '0 0';
    });
  });
}

function getTodayPlanLocalDateKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getTodayPlanDefaultAssociations() {
  return {
    chat_selections: [],
    services: [],
  };
}

function normalizeTodayPlanAssociations(associations) {
  const source =
    associations && typeof associations === 'object' ? associations : {};
  const chatSelections = Array.isArray(source.chat_selections)
    ? source.chat_selections
        .filter(
          (item) =>
            item &&
            typeof item.group_jid === 'string' &&
            Array.isArray(item.message_ids),
        )
        .map((item) => ({
          group_jid: item.group_jid,
          message_ids: Array.from(
            new Set(
              (Array.isArray(item.message_ids) ? item.message_ids : []).filter(
                (entry) => typeof entry === 'string' && entry.trim(),
              ),
            ),
          ),
        }))
        .filter((item) => item.message_ids.length > 0)
    : [];
  const services = Array.isArray(source.services)
    ? source.services
        .filter(
          (item) =>
            item &&
            typeof item.service === 'string' &&
            Array.isArray(item.branches),
        )
        .map((item) => ({
          service: item.service,
          branches: Array.from(
            new Set(
              item.branches.filter(
                (entry) => typeof entry === 'string' && entry.trim(),
              ),
            ),
          ),
        }))
    : [];
  return {
    chat_selections: chatSelections,
    services,
  };
}

function cloneTodayPlanAssociations(associations) {
  return normalizeTodayPlanAssociations(
    JSON.parse(
      JSON.stringify(associations || getTodayPlanDefaultAssociations()),
    ),
  );
}

function getTodayPlanAssociationChatEntry(state, groupJid) {
  return (
    state.associations.chat_selections.find(
      (item) => item.group_jid === groupJid,
    ) || null
  );
}

function getTodayPlanAssociationChatSelectionCount(entry) {
  if (!entry) return 0;
  return Array.isArray(entry.message_ids) ? entry.message_ids.length : 0;
}

function getTodayPlanItem(itemId) {
  if (!currentTodayPlan || !Array.isArray(currentTodayPlan.items)) return null;
  return currentTodayPlan.items.find((item) => item.id === itemId) || null;
}

function updateTodayPlanLocalItem(itemId, patch) {
  if (!currentTodayPlan || !Array.isArray(currentTodayPlan.items)) return;
  const index = currentTodayPlan.items.findIndex((item) => item.id === itemId);
  if (index < 0) return;
  currentTodayPlan.items[index] = {
    ...currentTodayPlan.items[index],
    ...patch,
  };
}

function getTodayPlanHistoryRows() {
  const rows = Array.isArray(todayPlanOverview && todayPlanOverview.history)
    ? todayPlanOverview.history
    : [];
  return rows.filter(
    (item, index) => rows.findIndex((entry) => entry.id === item.id) === index,
  );
}

function getTodayPlanResolvedStatus(plan) {
  if (!plan || typeof plan !== 'object') return '';
  if (plan.status === 'completed' || plan.status === 'continued') {
    return plan.status;
  }
  return 'active';
}

function getTodayPlanPlanStatusText(plan) {
  if (!plan) return '待创建';
  const status = getTodayPlanResolvedStatus(plan);
  if (status === 'completed') {
    return plan.plan_date === getTodayPlanLocalDateKey()
      ? '今日已完成'
      : '往日已完成';
  }
  if (status === 'continued') {
    return '已承接';
  }
  return plan.plan_date === getTodayPlanLocalDateKey()
    ? '今日进行中'
    : '往日未完成';
}

function getTodayPlanPlanStatusClass(plan) {
  if (!plan) return 'empty';
  const status = getTodayPlanResolvedStatus(plan);
  if (status === 'completed') return 'completed';
  if (status === 'continued' || plan.plan_date !== getTodayPlanLocalDateKey())
    return 'history';
  return '';
}

function isTodayPlanEditableDetail(detail) {
  return Boolean(
    detail &&
    detail.plan &&
    detail.plan.plan_date === getTodayPlanLocalDateKey() &&
    getTodayPlanResolvedStatus(detail.plan) === 'active',
  );
}

function getTodayPlanAggregateMetrics(detail) {
  const collections = [];
  if (detail && Array.isArray(detail.items)) {
    collections.push(detail.items);
  }
  if (
    detail &&
    detail.continued_from &&
    Array.isArray(detail.continued_from.items)
  ) {
    collections.push(detail.continued_from.items);
  }
  let chatCount = 0;
  let serviceCount = 0;
  let itemCount = 0;

  collections.forEach((items) => {
    itemCount += items.length;
    items.forEach((item) => {
      const relatedChats = Array.isArray(item.related_chats)
        ? item.related_chats
        : [];
      const relatedServices = Array.isArray(item.related_services)
        ? item.related_services
        : [];
      chatCount += relatedChats.reduce(
        (sum, group) =>
          sum + (Array.isArray(group.messages) ? group.messages.length : 0),
        0,
      );
      serviceCount += relatedServices.length;
    });
  });

  return {
    itemCount,
    chatCount,
    serviceCount,
  };
}

function closeTodayPlanHistoryModal() {
  if (todayPlanHistoryModal) {
    todayPlanHistoryModal.classList.add('hidden');
  }
}

function renderTodayPlanHistoryList() {
  if (!todayPlanHistoryList) return;
  const mode = todayPlanHistoryModalMode === 'continue' ? 'continue' : 'view';
  const rows =
    mode === 'continue'
      ? getTodayPlanHistoryRows().filter(
          (plan) => getTodayPlanResolvedStatus(plan) === 'active',
        )
      : getTodayPlanHistoryRows();

  if (todayPlanHistoryModalTitle) {
    todayPlanHistoryModalTitle.textContent =
      mode === 'continue' ? '继续往日计划' : '查看往日计划';
  }
  if (todayPlanHistoryModalSubtitle) {
    todayPlanHistoryModalSubtitle.textContent =
      mode === 'continue'
        ? '仅展示未完成态的往日计划。选择后会创建今日计划，并以只读方式展示其已关联内容。'
        : '从列表中选择一份往日计划，打开只读详情页。';
  }

  if (rows.length === 0) {
    todayPlanHistoryList.innerHTML = `<div class="today-plan-empty-inline">${mode === 'continue' ? '当前没有可继续的未完成往日计划。' : '还没有任何往日计划记录。'}</div>`;
    return;
  }

  todayPlanHistoryList.innerHTML = rows
    .map((plan) => {
      const isActive = currentTodayPlanId === plan.id;
      const planType = getTodayPlanPlanStatusText(plan);
      return `
      <button type="button" class="today-plan-switcher-item${isActive ? ' active' : ''}" data-today-plan-id="${escapeAttribute(plan.id)}">
        <div class="today-plan-switcher-item-head">
          <div class="today-plan-switcher-date">${escapeHtml(plan.plan_date || '--')}</div>
          <span class="today-plan-meta-chip">${escapeHtml(planType)}</span>
        </div>
        <div class="today-plan-switcher-title">${escapeHtml(plan.title || planType)}</div>
      </button>
    `;
    })
    .join('');

  Array.from(
    todayPlanHistoryList.querySelectorAll('[data-today-plan-id]'),
  ).forEach((button) => {
    button.addEventListener('click', async () => {
      const planId = button.getAttribute('data-today-plan-id') || '';
      if (!planId) return;
      if (mode === 'continue') {
        await continueTodayPlanFromHistory(planId);
        return;
      }
      closeTodayPlanHistoryModal();
      await loadTodayPlan(planId);
    });
  });
}

function openTodayPlanHistoryModal(mode = 'view') {
  todayPlanHistoryModalMode = mode === 'continue' ? 'continue' : 'view';
  renderTodayPlanHistoryList();
  if (todayPlanHistoryModal) {
    todayPlanHistoryModal.classList.remove('hidden');
  }
}

function renderTodayPlanOverviewSummary() {
  const detail =
    currentTodayPlan && currentTodayPlan.plan ? currentTodayPlan : null;
  const metrics = getTodayPlanAggregateMetrics(detail);
  const hasPlan = Boolean(detail);
  const hasTodayPlan = Boolean(todayPlanOverview && todayPlanOverview.today);
  const historyRows = getTodayPlanHistoryRows();
  const planStatus = getTodayPlanPlanStatusText(hasPlan ? detail.plan : null);
  const editable = isTodayPlanEditableDetail(detail);

  if (todayPlanPlanStatus) {
    todayPlanPlanStatus.textContent = planStatus;
    todayPlanPlanStatus.className = `today-plan-status-badge${planStatus ? ` ${getTodayPlanPlanStatusClass(hasPlan ? detail.plan : null)}` : ''}`;
  }

  if (todayPlanHeroMeta) {
    const chips = [
      `<span class="today-plan-meta-chip">⌘W 快速切换</span>`,
      `<span class="today-plan-meta-chip">${hasPlan ? escapeHtml(detail.plan.plan_date || '--') : '仅展示今日入口'}</span>`,
    ];
    if (detail && detail.continued_from && detail.continued_from.plan) {
      chips.push(
        `<span class="today-plan-meta-chip">承接自 ${escapeHtml(detail.continued_from.plan.plan_date || '--')}</span>`,
      );
    }
    todayPlanHeroMeta.innerHTML = chips.join('');
  }

  if (todayPlanOverviewSummary) {
    todayPlanOverviewSummary.innerHTML = `
      <div class="today-plan-overview-grid">
        <div class="today-plan-overview-card">
          <span>当前视图</span>
          <strong>${escapeHtml(planStatus)}</strong>
          <small>${escapeHtml(hasPlan ? detail.plan.plan_date || '--' : '创建后开始维护')}</small>
        </div>
        <div class="today-plan-overview-card">
          <span>${detail && detail.continued_from ? '可见计划项' : '计划项'}</span>
          <strong>${escapeHtml(String(metrics.itemCount))}</strong>
          <small>${escapeHtml(editable ? '包含今日计划与承接内容' : '当前详情页展示条目数')}</small>
        </div>
        <div class="today-plan-overview-card">
          <span>${detail && detail.continued_from ? '承接来源' : '消息 / 服务'}</span>
          <strong>${escapeHtml(detail && detail.continued_from ? detail.continued_from.plan.plan_date || '--' : `${metrics.chatCount} / ${metrics.serviceCount}`)}</strong>
          <small>${escapeHtml(detail && detail.continued_from ? '往日计划内容为只读展示' : '群聊消息 / 服务分支')}</small>
        </div>
      </div>
    `;
  }

  if (todayPlanViewHistoryBtn) {
    todayPlanViewHistoryBtn.disabled = false;
  }
  if (todayPlanContinuePlanBtn) {
    todayPlanContinuePlanBtn.classList.toggle('hidden', hasTodayPlan);
    todayPlanContinuePlanBtn.disabled = false;
  }
}

function renderTodayPlanMessageBody(message) {
  if (!message) return '';
  if (message.is_bot_message) {
    return renderMarkdown(message.content || '');
  }
  return escapeHtml(message.content || '').replace(/\n/g, '<br>');
}

function renderTodayPlanReplyQuote(message) {
  if (!message || !message.reply_to_id) return '';
  const preview =
    typeof message.reply_preview === 'string' && message.reply_preview.trim()
      ? message.reply_preview.trim()
      : '原消息不可用';
  return `<div class="msg-reply-quote" data-reply-id="${escapeAttribute(message.reply_to_id)}">${escapeHtml(preview)}</div>`;
}


function renderTodayPlanItemActionIcon(kind) {
  if (kind === 'associations') {
    return `
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M10 13a5 5 0 0 0 7.54.54l2-2a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
        <path d="M14 11a5 5 0 0 0-7.54-.54l-2 2a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
      </svg>
    `;
  }
  if (kind === 'delete') {
    return `
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 6h18"></path>
        <path d="M8 6V4h8v2"></path>
        <path d="M19 6l-1 14H6L5 6"></path>
        <path d="M10 11v6"></path>
        <path d="M14 11v6"></path>
      </svg>
    `;
  }
  return '';
}

function renderTodayPlanItemCard(item, index, options = {}) {
  const readonly = Boolean(options.readonly);
  const readonlyLabel = options.readonlyLabel || '只读';
  const chatCount = Array.isArray(item.related_chats)
    ? item.related_chats.reduce(
        (sum, group) =>
          sum + (Array.isArray(group.messages) ? group.messages.length : 0),
        0,
      )
    : 0;
  const serviceCount = Array.isArray(item.related_services)
    ? item.related_services.length
    : 0;
  const titleField = readonly
    ? `<div class="today-plan-static-title">${escapeHtml(item.title || '未命名计划')}</div>`
    : `<input class="today-plan-input" data-today-plan-field="title" value="${escapeAttribute(item.title || '')}" placeholder="例如：完成支付链路自测与联调安排" />`;
  const detailField = readonly
    ? `<div class="today-plan-static-detail">${escapeHtml(item.detail || '暂无补充说明').replace(/\n/g, '<br>')}</div>`
    : `<textarea class="today-plan-textarea" data-today-plan-field="detail" placeholder="补充这条计划的目标、范围、交付预期和风险">${escapeHtml(item.detail || '')}</textarea>`;

  return `
    <div class="today-plan-item-card" data-today-plan-item="${escapeAttribute(item.id)}" data-today-plan-readonly="${readonly ? '1' : '0'}">
      <div class="today-plan-item-header">
        <div class="today-plan-item-header-main">
          <span class="today-plan-item-order">${escapeHtml(String(index + 1).padStart(2, '0'))}</span>
          <div class="today-plan-item-fields">
            ${titleField}
          </div>
        </div>
        <div class="today-plan-item-actions">
          ${
            readonly
              ? `<span class="today-plan-item-readonly-note">${escapeHtml(readonlyLabel)}</span>`
              : `
            <button type="button" class="icon-btn today-plan-item-icon-btn" data-today-plan-edit="associations" data-today-plan-item-id="${escapeAttribute(item.id)}" title="关联信息" aria-label="关联信息">
              ${renderTodayPlanItemActionIcon('associations')}
            </button>
            <button type="button" class="icon-btn today-plan-item-icon-btn danger" data-today-plan-delete="${escapeAttribute(item.id)}" title="删除计划项" aria-label="删除计划项">
              ${renderTodayPlanItemActionIcon('delete')}
            </button>
          `
          }
        </div>
      </div>
      ${detailField}

      <div class="today-plan-association-summary">
        <div class="today-plan-summary-pill">
          <strong>群聊消息</strong>
          <span>${escapeHtml(String(chatCount))}</span>
        </div>
        <div class="today-plan-summary-pill">
          <strong>服务分支</strong>
          <span>${escapeHtml(String(serviceCount))}</span>
        </div>
      </div>


      <section class="today-plan-section">
        <div class="today-plan-section-header">
          <div>
            <div class="today-plan-section-title">关联群聊消息</div>
            <div class="today-plan-section-subtitle">按群展示今天被选中的消息内容。</div>
          </div>
        </div>
        ${
          chatCount === 0
            ? '<div class="today-plan-empty-inline">未关联群聊消息</div>'
            : `
          <div class="today-plan-chat-block">
            ${item.related_chats
              .map(
                (group) => `
              <div class="today-plan-chat-card">
                <div class="today-plan-chat-head">
                  <div>
                    <div class="today-plan-chat-title">${escapeHtml(group.group_name || group.group_jid)}</div>
                    <div class="today-plan-pill-row">
                      <span class="today-plan-meta-pill">${escapeHtml(String((group.messages || []).length))} 条消息</span>
                    </div>
                  </div>
                </div>
                <div class="today-plan-chat-messages">
                  ${(group.messages || [])
                    .map(
                      (message) => `
                    <div class="today-plan-chat-message${message.is_from_me ? ' from-me' : ''}${message.is_bot_message ? ' bot' : ''}">
                      <div class="today-plan-chat-message-head">
                        <span>${escapeHtml(message.sender_name || message.sender || '未知')}</span>
                        <span>${escapeHtml(formatDateTime(message.timestamp || ''))}</span>
                      </div>
                      ${renderTodayPlanReplyQuote(message)}
                      <div class="today-plan-chat-message-body">${renderTodayPlanMessageBody(message)}</div>
                    </div>
                  `,
                    )
                    .join('')}
                </div>
              </div>
            `,
              )
              .join('')}
          </div>
        `
        }
      </section>

      <section class="today-plan-section">
        <div class="today-plan-section-header">
          <div>
            <div class="today-plan-section-title">关联服务与分支</div>
            <div class="today-plan-section-subtitle">包含手动选择的服务与工作分支。</div>
          </div>
        </div>
        ${
          serviceCount === 0
            ? '<div class="today-plan-empty-inline">未关联服务分支</div>'
            : `
          <div class="today-plan-service-block">
            ${item.related_services
              .map(
                (service) => `
              <div class="today-plan-service-card">
                <div class="today-plan-service-head">
                  <div>
                    <div class="today-plan-service-title">${escapeHtml(service.service || '未命名服务')}</div>
                    <div class="today-plan-pill-row">
                      <span class="today-plan-meta-pill">${escapeHtml(service.repo_path || '未配置仓库路径')}</span>
                      <span class="today-plan-meta-pill">${service.repo_exists ? '仓库可读' : '仓库不存在'}</span>
                    </div>
                  </div>
                </div>
                <div class="today-plan-branch-list">
                  ${(service.branches || [])
                    .map(
                      (branch) => `
                    <div class="today-plan-branch-card">
                      <div class="today-plan-service-head">
                        <div>
                          <div class="today-plan-service-title">${escapeHtml(branch.name || '--')}</div>
                          <div class="today-plan-pill-row">
                            <span class="today-plan-meta-pill">来源：${escapeHtml(branch.source || 'manual')}</span>
                            ${branch.ref ? `<span class="today-plan-meta-pill">${escapeHtml(branch.ref)}</span>` : ''}
                          </div>
                        </div>
                      </div>
                      ${
                        (branch.commits || []).length === 0
                          ? `<div class="today-plan-empty-inline">${escapeHtml(branch.error || '当天没有 commit')}</div>`
                          : `
                        <div class="today-plan-commit-list">
                          ${(branch.commits || [])
                            .map(
                              (commit) => `
                            <button type="button" class="today-plan-commit-card" data-today-plan-commit="${escapeAttribute(commit.hash)}" data-today-plan-service="${escapeAttribute(service.service)}">
                              <div class="today-plan-commit-subject">${escapeHtml(commit.subject || commit.short_hash)}</div>
                              <div class="today-plan-commit-meta-row">
                                <span>${escapeHtml(commit.short_hash || '')}</span>
                                <span>${escapeHtml(commit.author || '')}</span>
                                <span>${escapeHtml(formatDateTime(commit.committed_at || ''))}</span>
                              </div>
                            </button>
                          `,
                            )
                            .join('')}
                        </div>
                      `
                      }
                    </div>
                  `,
                    )
                    .join('')}
                </div>
              </div>
            `,
              )
              .join('')}
          </div>
        `
        }
      </section>
    </div>
  `;
}

function bindEditableTodayPlanItemInteractions() {
  Array.from(
    todayPlanItems.querySelectorAll('[data-today-plan-add-item-trigger]'),
  ).forEach((button) => {
    button.addEventListener('click', async () => {
      await createTodayPlanItemEntry();
    });
  });

  Array.from(
    todayPlanItems.querySelectorAll('[data-today-plan-field]'),
  ).forEach((field) => {
    const card = field.closest('[data-today-plan-item]');
    if (!card) return;
    const itemId = card.getAttribute('data-today-plan-item') || '';
    const key = field.getAttribute('data-today-plan-field') || '';
    field.addEventListener('input', () => {
      const patch = {};
      patch[key] = field.value;
      updateTodayPlanLocalItem(itemId, patch);
      queueTodayPlanItemPatch(itemId, patch);
    });
    field.addEventListener('blur', () => {
      const patch = {};
      patch[key] = field.value;
      queueTodayPlanItemPatch(itemId, patch, true);
    });
  });

  Array.from(
    todayPlanItems.querySelectorAll('[data-today-plan-delete]'),
  ).forEach((button) => {
    button.addEventListener('click', async () => {
      const itemId = button.getAttribute('data-today-plan-delete') || '';
      if (!itemId) return;
      await deleteTodayPlanItemEntry(itemId);
    });
  });

  Array.from(
    todayPlanItems.querySelectorAll("[data-today-plan-edit='associations']"),
  ).forEach((button) => {
    button.addEventListener('click', async () => {
      const itemId = button.getAttribute('data-today-plan-item-id') || '';
      if (!itemId) return;
      await openTodayPlanAssociationDialog(itemId);
    });
  });

}

function bindTodayPlanCommitInteractions() {
  Array.from(
    todayPlanItems.querySelectorAll('[data-today-plan-commit]'),
  ).forEach((button) => {
    button.addEventListener('click', async () => {
      const service = button.getAttribute('data-today-plan-service') || '';
      const commit = button.getAttribute('data-today-plan-commit') || '';
      if (!service || !commit) return;
      await openTodayPlanCommitDialog(service, commit);
    });
  });
}

function renderTodayPlanItems() {
  if (
    !todayPlanItems ||
    !currentTodayPlan ||
    !Array.isArray(currentTodayPlan.items)
  )
    return;
  const editable = isTodayPlanEditableDetail(currentTodayPlan);
  const currentItems = Array.isArray(currentTodayPlan.items)
    ? currentTodayPlan.items
    : [];
  const continuedFrom = currentTodayPlan.continued_from || null;
  const sections = [];

  if (continuedFrom) {
    sections.push(`
      <section class="today-plan-section-block">
        <div class="today-plan-section-header">
          <div>
            <div class="today-plan-section-title">承接往日计划</div>
            <div class="today-plan-section-subtitle">来源：${escapeHtml(continuedFrom.plan.plan_date || '--')} · ${escapeHtml(getTodayPlanPlanStatusText(continuedFrom.plan))} · 以下内容均为只读展示。</div>
          </div>
        </div>
        ${
          continuedFrom.items.length === 0
            ? '<div class="today-plan-empty-inline">该往日计划没有可展示的计划项。</div>'
            : `<div class="today-plan-section-stack">${continuedFrom.items.map((item, index) => renderTodayPlanItemCard(item, index, { readonly: true, readonlyLabel: '承接内容只读' })).join('')}</div>`
        }
      </section>
    `);
  }

  sections.push(`
    <section class="today-plan-section-block">
      <div class="today-plan-section-header">
        <div>
          <div class="today-plan-section-title">${editable ? '今日计划项' : '计划详情'}</div>
          <div class="today-plan-section-subtitle">${editable ? '维护今天的计划项；每条都可以继续新增、编辑、关联和发送邮件前汇总。' : '当前页面为只读详情，不可编辑、删除、关联或处理待处理项。'}</div>
        </div>
        ${
          editable
            ? `
          <div class="today-plan-section-actions">
            <button type="button" class="icon-btn today-plan-board-icon-btn" data-today-plan-add-item-trigger="1" title="新增计划项" aria-label="新增计划项">
              <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 5v14"></path>
                <path d="M5 12h14"></path>
              </svg>
            </button>
          </div>
        `
            : ''
        }
      </div>
      ${
        currentItems.length === 0
          ? `<div class="today-plan-empty-inline">${editable ? '先新增一条计划项，再把群聊消息和服务分支挂上来。' : '当前计划没有计划项。'}</div>`
          : `<div class="today-plan-section-stack">${currentItems.map((item, index) => renderTodayPlanItemCard(item, index, { readonly: !editable, readonlyLabel: '历史计划只读' })).join('')}</div>`
      }
    </section>
  `);

  todayPlanItems.innerHTML = sections.join('');
  if (editable) {
    bindEditableTodayPlanItemInteractions();
  }
  bindTodayPlanCommitInteractions();
}

function renderTodayPlanScreen() {
  renderTodayPlanHistoryList();
  const detail =
    currentTodayPlan && currentTodayPlan.plan ? currentTodayPlan : null;
  const hasPlan = Boolean(detail);
  const hasTodayPlan = Boolean(todayPlanOverview && todayPlanOverview.today);
  const editable = isTodayPlanEditableDetail(detail);
  const currentTodayId =
    todayPlanOverview && todayPlanOverview.today
      ? todayPlanOverview.today.id
      : '';

  if (todayPlanContent) {
    todayPlanContent.classList.toggle('hidden', !hasPlan);
  }
  if (todayPlanEmpty) {
    todayPlanEmpty.classList.toggle('hidden', hasPlan);
  }
  if (todayPlanSendMailBtn) {
    todayPlanSendMailBtn.disabled = !editable;
  }
  if (todayPlanCompleteBtn) {
    todayPlanCompleteBtn.classList.toggle(
      'hidden',
      !hasPlan ||
        !detail ||
        detail.plan.plan_date !== getTodayPlanLocalDateKey(),
    );
    todayPlanCompleteBtn.disabled = !editable;
    todayPlanCompleteBtn.textContent =
      detail && detail.plan.status === 'completed'
        ? '今日计划已完成'
        : '完成今日计划';
  }
  if (todayPlanCreateTodayBtn) {
    todayPlanCreateTodayBtn.classList.toggle(
      'hidden',
      hasTodayPlan && currentTodayId === currentTodayPlanId,
    );
    if (!hasTodayPlan) {
      todayPlanCreateTodayBtn.disabled = false;
      todayPlanCreateTodayBtn.textContent = '创建今日计划';
    } else {
      todayPlanCreateTodayBtn.disabled = false;
      todayPlanCreateTodayBtn.textContent = '打开今日计划';
    }
  }
  if (todayPlanEmptyContinueBtn) {
    todayPlanEmptyContinueBtn.classList.toggle('hidden', hasTodayPlan);
    todayPlanEmptyContinueBtn.disabled = false;
  }

  renderTodayPlanOverviewSummary();
  if (!hasPlan) {
    if (todayPlanTitleEl) todayPlanTitleEl.textContent = '今日计划';
    if (todayPlanSubtitleEl)
      todayPlanSubtitleEl.textContent =
        '今天还没有创建计划。你可以直接创建今日计划，或从往日计划中查看详情、继续未完成计划。';
    if (todayPlanSectionMeta)
      todayPlanSectionMeta.textContent =
        '先创建今日计划，再把群聊消息和服务分支按计划项组织起来。';
    if (todayPlanItems) todayPlanItems.innerHTML = '';
    return;
  }

  if (todayPlanTitleEl) {
    todayPlanTitleEl.textContent =
      detail.plan.plan_date === getTodayPlanLocalDateKey()
        ? '今日计划'
        : `${detail.plan.plan_date || ''} 计划`;
  }
  if (todayPlanSubtitleEl) {
    const currentCount = Array.isArray(detail.items) ? detail.items.length : 0;
    const linkText = detail.continued_from
      ? ` · 承接自 ${detail.continued_from.plan.plan_date}`
      : '';
    todayPlanSubtitleEl.textContent = `${detail.plan.title || '今日计划'} · 共 ${currentCount} 条当前计划项${linkText}`;
  }
  if (todayPlanSectionMeta) {
    const metrics = getTodayPlanAggregateMetrics(detail);
    todayPlanSectionMeta.textContent = `${metrics.itemCount} 条可见计划项 · ${metrics.chatCount} 条消息 · ${metrics.serviceCount} 个服务`;
  }
  renderTodayPlanItems();
}

async function openOrCreateTodayPlanEntry() {
  const todayId =
    todayPlanOverview && todayPlanOverview.today
      ? todayPlanOverview.today.id
      : '';
  if (todayId) {
    await loadTodayPlan(todayId);
    return;
  }
  await createTodayPlanNow();
}

async function continueTodayPlanFromHistory(planId) {
  if (!planId) return;
  try {
    const res = await apiFetch('/api/today-plan', {
      method: 'POST',
      body: JSON.stringify({
        plan_date: getTodayPlanLocalDateKey(),
        continue_from_plan_id: planId,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    closeTodayPlanHistoryModal();
    todayPlanOverview = todayPlanOverview || { today: null, history: [] };
    todayPlanOverview.today = data.plan || null;
    currentTodayPlan = data.detail || null;
    currentTodayPlanId = data.plan && data.plan.id ? data.plan.id : '';
    await loadTodayPlanOverview({ forceOpenToday: true });
  } catch (err) {
    console.error('Failed to continue history today plan:', err);
    alert(err.message || '继续往日计划失败');
  }
}

async function completeCurrentTodayPlan() {
  if (!currentTodayPlanId) return;
  if (
    !(await openConfirmDialog(
      '确认将这份今日计划标记为已完成吗？完成后将切换为只读状态。',
      { title: '完成今日计划' },
    ))
  )
    return;
  try {
    const res = await apiFetch('/api/today-plan/complete', {
      method: 'POST',
      body: JSON.stringify({ plan_id: currentTodayPlanId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    currentTodayPlan = data.detail || null;
    if (
      todayPlanOverview &&
      todayPlanOverview.today &&
      todayPlanOverview.today.id === currentTodayPlanId
    ) {
      todayPlanOverview.today = data.plan || todayPlanOverview.today;
    }
    renderTodayPlanScreen();
  } catch (err) {
    console.error('Failed to complete today plan:', err);
    alert(err.message || '完成今日计划失败');
  }
}

async function loadTodayPlan(planId) {
  if (!planId) return;
  try {
    const res = await apiFetch(
      `/api/today-plan?id=${encodeURIComponent(planId)}`,
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    currentTodayPlan = data;
    currentTodayPlanId = data.plan && data.plan.id ? data.plan.id : planId;
    renderTodayPlanScreen();
  } catch (err) {
    console.error('Failed to load today plan:', err);
    currentTodayPlan = null;
    currentTodayPlanId = '';
    renderTodayPlanScreen();
    alert(err.message || '加载今日计划失败');
  }
}

async function loadTodayPlanOverview(options = {}) {
  try {
    const todayKey = getTodayPlanLocalDateKey();
    const res = await apiFetch(
      `/api/today-plans/overview?date=${encodeURIComponent(todayKey)}`,
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    todayPlanOverview = data;
    if (data.today && options.forceOpenToday) {
      await loadTodayPlan(data.today.id);
      return;
    }
    if (options.showEmptyWhenNoToday && !data.today) {
      currentTodayPlan = null;
      currentTodayPlanId = '';
      renderTodayPlanScreen();
      return;
    }
    if (!currentTodayPlanId && data.today) {
      await loadTodayPlan(data.today.id);
      return;
    }
    if (currentTodayPlanId) {
      await loadTodayPlan(currentTodayPlanId);
      return;
    }
    renderTodayPlanScreen();
  } catch (err) {
    console.error('Failed to load today plan overview:', err);
    todayPlanOverview = { today: null, history: [] };
    currentTodayPlan = null;
    currentTodayPlanId = '';
    renderTodayPlanScreen();
  }
}

async function createTodayPlanNow() {
  try {
    const res = await apiFetch('/api/today-plan', {
      method: 'POST',
      body: JSON.stringify({ plan_date: getTodayPlanLocalDateKey() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    todayPlanOverview = todayPlanOverview || { today: null, history: [] };
    if (data.plan) {
      todayPlanOverview.today = data.plan;
      currentTodayPlanId = data.plan.id;
    }
    currentTodayPlan = data.detail || null;
    renderTodayPlanScreen();
    await loadTodayPlanOverview({ forceOpenToday: true });
  } catch (err) {
    console.error('Failed to create today plan:', err);
    alert(err.message || '创建今日计划失败');
  }
}

async function createTodayPlanItemEntry() {
  if (!currentTodayPlanId) {
    await createTodayPlanNow();
    if (!currentTodayPlanId) return;
  }
  try {
    const res = await apiFetch('/api/today-plan/item', {
      method: 'POST',
      body: JSON.stringify({ plan_id: currentTodayPlanId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadTodayPlan(currentTodayPlanId);
  } catch (err) {
    console.error('Failed to create today plan item:', err);
    alert(err.message || '新增计划项失败');
  }
}

async function flushTodayPlanItemPatch(itemId) {
  const patch = todayPlanPendingPatches[itemId];
  if (!patch) return;
  delete todayPlanPendingPatches[itemId];
  if (todayPlanSaveTimers[itemId]) {
    clearTimeout(todayPlanSaveTimers[itemId]);
    delete todayPlanSaveTimers[itemId];
  }
  try {
    const res = await apiFetch('/api/today-plan/item', {
      method: 'PATCH',
      body: JSON.stringify({
        item_id: itemId,
        ...patch,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.item) {
      updateTodayPlanLocalItem(itemId, data.item);
    }
  } catch (err) {
    console.error('Failed to save today plan item:', err);
    alert(err.message || '保存计划项失败');
  }
}

function clearQueuedTodayPlanItemPatch(itemId) {
  delete todayPlanPendingPatches[itemId];
  if (todayPlanSaveTimers[itemId]) {
    clearTimeout(todayPlanSaveTimers[itemId]);
    delete todayPlanSaveTimers[itemId];
  }
}

function queueTodayPlanItemPatch(itemId, patch, immediate = false) {
  todayPlanPendingPatches[itemId] = {
    ...(todayPlanPendingPatches[itemId] || {}),
    ...patch,
  };
  if (todayPlanSaveTimers[itemId]) {
    clearTimeout(todayPlanSaveTimers[itemId]);
  }
  if (immediate) {
    flushTodayPlanItemPatch(itemId);
    return;
  }
  todayPlanSaveTimers[itemId] = setTimeout(() => {
    flushTodayPlanItemPatch(itemId);
  }, 320);
}

async function deleteTodayPlanItemEntry(itemId) {
  const item = getTodayPlanItem(itemId);
  if (
    !(await openConfirmDialog(
      `确认删除计划项「${item?.title || '未命名计划'}」吗？`,
      { title: '删除计划项' },
    ))
  )
    return;
  clearQueuedTodayPlanItemPatch(itemId);
  try {
    const res = await apiFetch('/api/today-plan/item', {
      method: 'DELETE',
      body: JSON.stringify({ item_id: itemId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (currentTodayPlanId) {
      await loadTodayPlan(currentTodayPlanId);
    }
  } catch (err) {
    console.error('Failed to delete today plan item:', err);
    alert(err.message || '删除计划项失败');
  }
}

function closeTodayPlanAssociationDialog() {
  if (todayPlanAssociationOverlay) {
    todayPlanAssociationOverlay.remove();
    todayPlanAssociationOverlay = null;
    todayPlanAssociationState = null;
  }
}

async function ensureTodayPlanServiceBranchesLoaded(state, service) {
  if (state.branchesByService[service] || state.loadingBranches[service])
    return;
  state.loadingBranches[service] = true;
  renderTodayPlanAssociationDialog();
  try {
    const res = await apiFetch(
      `/api/today-plan/service/branches?service=${encodeURIComponent(service)}`,
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    state.branchesByService[service] = Array.isArray(data.branches)
      ? data.branches
      : [];
  } catch (err) {
    console.error('Failed to load today plan service branches:', err);
    state.branchesByService[service] = [];
  } finally {
    state.loadingBranches[service] = false;
    renderTodayPlanAssociationDialog();
  }
}

function getTodayPlanAssociationServiceEntry(state, service) {
  return (
    state.associations.services.find((item) => item.service === service) || null
  );
}

function updateTodayPlanChatSelection(state, groupJid, messageId, checked) {
  let groupEntry = getTodayPlanAssociationChatEntry(state, groupJid);
  if (!groupEntry && checked) {
    groupEntry = {
      group_jid: groupJid,
      message_ids: [],
    };
    state.associations.chat_selections.push(groupEntry);
  }
  if (!groupEntry) return;
  groupEntry.message_ids = Array.isArray(groupEntry.message_ids)
    ? groupEntry.message_ids
    : [];
  if (checked) {
    if (!groupEntry.message_ids.includes(messageId)) {
      groupEntry.message_ids.push(messageId);
    }
  } else {
    groupEntry.message_ids = groupEntry.message_ids.filter(
      (id) => id !== messageId,
    );
    if (groupEntry.message_ids.length === 0) {
      state.associations.chat_selections =
        state.associations.chat_selections.filter(
          (item) => item.group_jid !== groupJid,
        );
    }
  }
}

function captureTodayPlanAssociationScrollState(dialog) {
  if (!dialog) return null;
  const grid = dialog.querySelector('.today-plan-association-grid');
  return {
    gridTop: grid ? grid.scrollTop : 0,
    gridLeft: grid ? grid.scrollLeft : 0,
    listTops: Array.from(
      dialog.querySelectorAll('.today-plan-association-list'),
    ).map((list) => list.scrollTop),
    listLefts: Array.from(
      dialog.querySelectorAll('.today-plan-association-list'),
    ).map((list) => list.scrollLeft),
  };
}

function restoreTodayPlanAssociationScrollState(dialog, scrollState) {
  if (!dialog || !scrollState) return;
  const grid = dialog.querySelector('.today-plan-association-grid');
  if (grid) {
    grid.scrollTop = scrollState.gridTop || 0;
    grid.scrollLeft = scrollState.gridLeft || 0;
  }
  Array.from(dialog.querySelectorAll('.today-plan-association-list')).forEach(
    (list, index) => {
      list.scrollTop = scrollState.listTops[index] || 0;
      list.scrollLeft = scrollState.listLefts[index] || 0;
    },
  );
}

function updateTodayPlanAssociationServiceBranchCount(
  dialog,
  serviceName,
  count,
) {
  const badge = Array.from(
    dialog.querySelectorAll('[data-today-plan-service-branch-count]'),
  ).find(
    (item) =>
      item.getAttribute('data-today-plan-service-branch-count') === serviceName,
  );
  if (badge) {
    badge.textContent = `已选 ${count} 个分支`;
  }
}

function renderTodayPlanAssociationDialog() {
  const state = todayPlanAssociationState;
  if (!state || !todayPlanAssociationOverlay) return;
  const dialog = todayPlanAssociationOverlay.querySelector(
    '.today-plan-association-dialog',
  );
  if (!dialog) return;
  const scrollState = captureTodayPlanAssociationScrollState(dialog);
  const chatGroups = (state.groups || []).filter((group) => {
    const messages = state.chatMessagesByGroup[group.jid] || [];
    return Array.isArray(messages) && messages.length > 0;
  });
  if (
    state.activeChatGroupJid &&
    !chatGroups.some((group) => group.jid === state.activeChatGroupJid)
  ) {
    state.activeChatGroupJid = null;
  }
  const activeChatGroup =
    chatGroups.find((group) => group.jid === state.activeChatGroupJid) || null;
  const activeChatMessages = activeChatGroup
    ? state.chatMessagesByGroup[activeChatGroup.jid] || []
    : [];
  const activeChatSelection = activeChatGroup
    ? getTodayPlanAssociationChatEntry(state, activeChatGroup.jid)
    : null;
  const activeChatSelectedIds = new Set(
    activeChatSelection && Array.isArray(activeChatSelection.message_ids)
      ? activeChatSelection.message_ids
      : [],
  );

  dialog.innerHTML = `
    <div class="today-plan-association-header">
      <div>
        <div class="today-plan-kicker">Associations</div>
        <h3>编辑关联信息</h3>
        <div class="today-plan-subtitle">勾选群聊消息与服务分支。</div>
      </div>
      <button type="button" class="icon-btn" data-today-plan-close-associations title="关闭">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>
    <div class="today-plan-association-grid">
      <section class="today-plan-association-column">
        <div class="today-plan-association-title">群聊消息</div>
        <div class="today-plan-option-desc">仅展示每个群今天最新的 200 条消息；点击群聊后在对话框中多选消息。</div>
        <div class="today-plan-association-list">
          ${
            chatGroups
              .map((group) => {
                const selectedCount = getTodayPlanAssociationChatSelectionCount(
                  getTodayPlanAssociationChatEntry(state, group.jid),
                );
                const messages = state.chatMessagesByGroup[group.jid] || [];
                const active =
                  activeChatGroup && activeChatGroup.jid === group.jid;
                const latestMessage = messages[messages.length - 1] || null;
                return `
              <button type="button" class="today-plan-option-card today-plan-chat-group-btn${active ? ' active' : ''}" data-today-plan-open-chat-group="${escapeAttribute(group.jid)}">
                <div class="today-plan-option-title">${escapeHtml(group.name || group.jid)}</div>
                <div class="today-plan-option-desc">${escapeHtml(group.folder || '')}</div>
                <div class="today-plan-pill-row">
                  <span class="today-plan-meta-pill">今日 ${escapeHtml(String(messages.length))} 条</span>
                  <span class="today-plan-meta-pill">已选 ${escapeHtml(String(selectedCount))} 条</span>
                </div>
                ${latestMessage ? `<div class="today-plan-description">${escapeHtml((latestMessage.content || '').replace(/\s+/g, ' ').trim() || '无内容')}</div>` : ''}
              </button>
            `;
              })
              .join('') ||
            '<div class="today-plan-empty-inline">今天没有可关联的群聊消息。</div>'
          }
        </div>
      </section>
      <section class="today-plan-association-column">
        <div class="today-plan-association-title">服务与分支</div>
        <div class="today-plan-option-desc">先选择服务，再为每个服务勾选一个或多个分支。</div>
        <div class="today-plan-association-list">
          ${
            (state.serviceOptions || [])
              .map((service) => {
                const selected = getTodayPlanAssociationServiceEntry(
                  state,
                  service.service,
                );
                const branches = state.branchesByService[service.service] || [];
                const loading = Boolean(state.loadingBranches[service.service]);
                const selectedBranchCount =
                  selected && Array.isArray(selected.branches)
                    ? selected.branches.length
                    : 0;
                return `
              <div class="today-plan-option-card today-plan-service-option-card${selected ? ' active' : ''}">
                <label class="today-plan-checkbox-row today-plan-service-option-head">
                  <input type="checkbox" data-today-plan-association="service" value="${escapeAttribute(service.service)}" ${selected ? 'checked' : ''} />
                  <div class="today-plan-service-option-main">
                    <div class="today-plan-option-title">${escapeHtml(service.service)}</div>
                    <div class="today-plan-option-desc">${escapeHtml(service.repo_path || '未配置仓库路径')}</div>
                  </div>
                  ${selected ? `<span class="today-plan-meta-pill" data-today-plan-service-branch-count="${escapeAttribute(service.service)}">已选 ${escapeHtml(String(selectedBranchCount))} 个分支</span>` : ''}
                </label>
                ${
                  selected
                    ? `
                  <div class="today-plan-service-branch-panel">
                    <div class="today-plan-service-branch-summary">
                      <span>分支选择</span>
                      <span>${loading ? '加载中' : `共 ${escapeHtml(String(branches.length))} 个`}</span>
                    </div>
                    ${
                      loading
                        ? '<div class="today-plan-empty-inline">正在加载分支...</div>'
                        : branches.length > 0
                          ? `
                      <div class="today-plan-service-branch-list">
                        ${branches
                          .map(
                            (branch) => `
                      <label class="today-plan-checkbox-row today-plan-service-branch-row">
                        <input type="checkbox" data-today-plan-association="branch" data-service-name="${escapeAttribute(service.service)}" value="${escapeAttribute(branch.name)}" ${selected.branches.includes(branch.name) ? 'checked' : ''} />
                        <div>
                          <div class="today-plan-option-title">${escapeHtml(branch.name)}</div>
                          <div class="today-plan-option-desc">${branch.current ? '当前分支' : branch.source === 'remote' ? '远端分支' : '本地分支'}${branch.default_branch ? ' · 默认分支' : ''}${branch.staging_branch ? ' · 预发分支' : ''}</div>
                        </div>
                      </label>
                        `,
                          )
                          .join('')}
                      </div>
                    `
                          : '<div class="today-plan-empty-inline">没有可用分支</div>'
                    }
                  </div>
                `
                    : ''
                }
              </div>
            `;
              })
              .join('') ||
            '<div class="today-plan-empty-inline">暂无服务配置</div>'
          }
        </div>
      </section>
    </div>
    <div class="today-plan-association-footer">
      <button type="button" class="btn-primary btn-soft-primary today-plan-action-btn today-plan-btn-view" data-today-plan-close-associations>取消</button>
      <button type="button" class="btn-primary btn-soft-primary today-plan-action-btn today-plan-btn-add" data-today-plan-save-associations>保存关联</button>
    </div>
    ${
      activeChatGroup
        ? `
      <div class="today-plan-chat-picker" data-today-plan-chat-picker-overlay="1">
        <div class="today-plan-chat-picker-window">
          <div class="today-plan-chat-picker-header">
            <div>
              <div class="today-plan-kicker">Chat Picker</div>
              <div class="today-plan-section-title">${escapeHtml(activeChatGroup.name || activeChatGroup.jid)}</div>
              <div class="today-plan-section-subtitle">今天最新 ${escapeHtml(String(activeChatMessages.length))} 条消息 · 已选 ${escapeHtml(String(activeChatSelectedIds.size))} 条</div>
            </div>
            <button type="button" class="icon-btn" data-today-plan-close-chat-picker title="关闭" aria-label="关闭">
              <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
          <div class="today-plan-chat-picker-toolbar">
            <div class="today-plan-option-desc">点击消息即可选择或取消。仅保存你勾选的消息，不做会话聚合。</div>
            <button type="button" class="btn-ghost" data-today-plan-clear-chat-selection="${escapeAttribute(activeChatGroup.jid)}" ${activeChatSelectedIds.size === 0 ? 'disabled' : ''}>清空已选</button>
          </div>
          <div class="today-plan-chat-picker-list">
            ${
              activeChatMessages
                .map((message) => {
                  const selected = activeChatSelectedIds.has(message.id);
                  return `
                <button type="button" class="today-plan-chat-picker-message${selected ? ' selected' : ''}${message.is_from_me ? ' from-me' : ''}${message.is_bot_message ? ' bot' : ''}" data-today-plan-chat-message="${escapeAttribute(message.id)}" data-group-jid="${escapeAttribute(activeChatGroup.jid)}">
                  <span class="today-plan-chat-picker-check">${selected ? '✓' : ''}</span>
                    <div class="today-plan-chat-picker-content">
                      <div class="today-plan-chat-picker-meta">
                        <span>${escapeHtml(message.sender_name || message.sender || '未知')}</span>
                        <span>${escapeHtml(formatDateTime(message.timestamp || ''))}</span>
                      </div>
                      ${renderTodayPlanReplyQuote(message)}
                      <div class="today-plan-chat-picker-body">${renderTodayPlanMessageBody(message)}</div>
                    </div>
                </button>
              `;
                })
                .join('') ||
              '<div class="today-plan-empty-inline">今天没有可选择的消息。</div>'
            }
          </div>
        </div>
      </div>
    `
        : ''
    }
  `;
  restoreTodayPlanAssociationScrollState(dialog, scrollState);
  requestAnimationFrame(() => {
    restoreTodayPlanAssociationScrollState(dialog, scrollState);
  });

  Array.from(
    dialog.querySelectorAll('[data-today-plan-close-associations]'),
  ).forEach((button) => {
    button.addEventListener('click', () => {
      closeTodayPlanAssociationDialog();
    });
  });

  Array.from(
    dialog.querySelectorAll('[data-today-plan-open-chat-group]'),
  ).forEach((button) => {
    button.addEventListener('click', () => {
      state.activeChatGroupJid =
        button.getAttribute('data-today-plan-open-chat-group') || null;
      renderTodayPlanAssociationDialog();
    });
  });

  Array.from(
    dialog.querySelectorAll('[data-today-plan-close-chat-picker]'),
  ).forEach((button) => {
    button.addEventListener('click', () => {
      state.activeChatGroupJid = null;
      renderTodayPlanAssociationDialog();
    });
  });

  Array.from(
    dialog.querySelectorAll('[data-today-plan-chat-picker-overlay]'),
  ).forEach((overlay) => {
    overlay.addEventListener('click', (event) => {
      if (event.target !== overlay) return;
      state.activeChatGroupJid = null;
      renderTodayPlanAssociationDialog();
    });
  });

  Array.from(dialog.querySelectorAll('[data-today-plan-chat-message]')).forEach(
    (button) => {
      button.addEventListener('click', () => {
        const groupJid = button.getAttribute('data-group-jid') || '';
        const messageId =
          button.getAttribute('data-today-plan-chat-message') || '';
        if (!groupJid || !messageId) return;
        const selection = getTodayPlanAssociationChatEntry(state, groupJid);
        const selected = Boolean(
          selection &&
          Array.isArray(selection.message_ids) &&
          selection.message_ids.includes(messageId),
        );
        updateTodayPlanChatSelection(state, groupJid, messageId, !selected);
        renderTodayPlanAssociationDialog();
      });
    },
  );

  Array.from(
    dialog.querySelectorAll('[data-today-plan-clear-chat-selection]'),
  ).forEach((button) => {
    button.addEventListener('click', () => {
      const groupJid =
        button.getAttribute('data-today-plan-clear-chat-selection') || '';
      if (!groupJid) return;
      state.associations.chat_selections =
        state.associations.chat_selections.filter(
          (item) => item.group_jid !== groupJid,
        );
      renderTodayPlanAssociationDialog();
    });
  });

  Array.from(
    dialog.querySelectorAll('[data-today-plan-association="service"]'),
  ).forEach((checkbox) => {
    checkbox.addEventListener('change', async () => {
      const serviceName = checkbox.value;
      if (checkbox.checked) {
        if (!getTodayPlanAssociationServiceEntry(state, serviceName)) {
          state.associations.services.push({
            service: serviceName,
            branches: [],
          });
        }
        if (
          state.branchesByService[serviceName] ||
          state.loadingBranches[serviceName]
        ) {
          renderTodayPlanAssociationDialog();
        } else {
          await ensureTodayPlanServiceBranchesLoaded(state, serviceName);
        }
      } else {
        state.associations.services = state.associations.services.filter(
          (item) => item.service !== serviceName,
        );
        renderTodayPlanAssociationDialog();
      }
    });
  });

  Array.from(
    dialog.querySelectorAll('[data-today-plan-association="branch"]'),
  ).forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const serviceName = checkbox.getAttribute('data-service-name') || '';
      const serviceEntry = getTodayPlanAssociationServiceEntry(
        state,
        serviceName,
      );
      if (!serviceEntry) return;
      serviceEntry.branches = Array.isArray(serviceEntry.branches)
        ? serviceEntry.branches
        : [];
      if (checkbox.checked) {
        if (!serviceEntry.branches.includes(checkbox.value)) {
          serviceEntry.branches.push(checkbox.value);
        }
      } else {
        serviceEntry.branches = serviceEntry.branches.filter(
          (branch) => branch !== checkbox.value,
        );
      }
      updateTodayPlanAssociationServiceBranchCount(
        dialog,
        serviceName,
        serviceEntry.branches.length,
      );
    });
  });

  const saveBtn = dialog.querySelector('[data-today-plan-save-associations]');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      try {
        const res = await apiFetch('/api/today-plan/item', {
          method: 'PATCH',
          body: JSON.stringify({
            item_id: state.itemId,
            associations: state.associations,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        closeTodayPlanAssociationDialog();
        if (currentTodayPlanId) {
          await loadTodayPlan(currentTodayPlanId);
        }
      } catch (err) {
        console.error('Failed to save today plan associations:', err);
        alert(err.message || '保存关联失败');
      }
    });
  }
}

async function openTodayPlanAssociationDialog(itemId) {
  const item = getTodayPlanItem(itemId);
  if (!item) return;
  closeTodayPlanAssociationDialog();
  try {
    const serviceRes = await apiFetch('/api/today-plan/services');
    const serviceData = await serviceRes.json();
    if (!serviceRes.ok)
      throw new Error(serviceData.error || `HTTP ${serviceRes.status}`);

    const chatMessagesByGroup = {};
    const groupsWithMessages = [];

    await Promise.all(
      (groups || []).map(async (group) => {
        try {
          const res = await apiFetch(
            `/api/today-plan/chat/options?jid=${encodeURIComponent(group.jid)}`,
          );
          const data = await res.json();
          chatMessagesByGroup[group.jid] = Array.isArray(data.messages)
            ? data.messages
            : [];
          if (chatMessagesByGroup[group.jid].length > 0) {
            groupsWithMessages.push(group);
          }
        } catch (err) {
          console.error('Failed to load today plan chat options:', err);
          chatMessagesByGroup[group.jid] = [];
        }
      }),
    );

    groupsWithMessages.sort((left, right) => {
      const leftMessages = chatMessagesByGroup[left.jid] || [];
      const rightMessages = chatMessagesByGroup[right.jid] || [];
      const leftLatest = leftMessages[leftMessages.length - 1];
      const rightLatest = rightMessages[rightMessages.length - 1];
      const leftRaw = (leftLatest && leftLatest.timestamp) || '';
      const rightRaw = (rightLatest && rightLatest.timestamp) || '';
      const leftNumeric = Number(leftRaw);
      const rightNumeric = Number(rightRaw);
      const leftTimestamp =
        Number.isFinite(leftNumeric) && leftNumeric > 0
          ? leftNumeric
          : Date.parse(leftRaw) || 0;
      const rightTimestamp =
        Number.isFinite(rightNumeric) && rightNumeric > 0
          ? rightNumeric
          : Date.parse(rightRaw) || 0;
      return rightTimestamp - leftTimestamp;
    });

    todayPlanAssociationState = {
      itemId,
      groups: groupsWithMessages,
      serviceOptions: Array.isArray(serviceData.services)
        ? serviceData.services
        : [],
      chatMessagesByGroup,
      branchesByService: {},
      loadingBranches: {},
      activeChatGroupJid: null,
      associations: cloneTodayPlanAssociations(item.associations),
    };

    todayPlanAssociationOverlay = document.createElement('div');
    todayPlanAssociationOverlay.className = 'today-plan-association-overlay';
    todayPlanAssociationOverlay.innerHTML = `
      <div class="today-plan-association-mask"></div>
      <div class="today-plan-association-dialog"></div>
    `;
    todayPlanAssociationOverlay
      .querySelector('.today-plan-association-mask')
      .addEventListener('click', () => {
        closeTodayPlanAssociationDialog();
      });
    document.body.appendChild(todayPlanAssociationOverlay);

    const selectedServices =
      todayPlanAssociationState.associations.services.map(
        (item2) => item2.service,
      );
    await Promise.all(
      selectedServices.map((service) =>
        ensureTodayPlanServiceBranchesLoaded(
          todayPlanAssociationState,
          service,
        ),
      ),
    );
    renderTodayPlanAssociationDialog();
  } catch (err) {
    console.error('Failed to open today plan association dialog:', err);
    alert(err.message || '加载关联信息失败');
  }
}

function closeTodayPlanCommitDialog() {
  if (todayPlanCommitModal) {
    todayPlanCommitModal.classList.add('hidden');
  }
  if (todayPlanCommitTitle) todayPlanCommitTitle.textContent = '提交详情';
  if (todayPlanCommitMeta) todayPlanCommitMeta.textContent = '';
  if (todayPlanCommitDiff) todayPlanCommitDiff.textContent = '';
}

function renderTodayPlanCommitDiff(diffText) {
  if (!todayPlanCommitDiff) return;
  const html = (diffText || '')
    .split('\n')
    .map((line) => {
      const klass = line.startsWith('+')
        ? 'add'
        : line.startsWith('-')
          ? 'del'
          : line.startsWith('@@') ||
              line.startsWith('diff --git') ||
              line.startsWith('index ')
            ? 'meta'
            : '';
      return `<span class="today-plan-diff-line${klass ? ` ${klass}` : ''}">${escapeHtml(line)}</span>`;
    })
    .join('');
  todayPlanCommitDiff.innerHTML =
    html || escapeHtml('当前 commit 没有可展示的 diff。');
}

async function openTodayPlanCommitDialog(service, commit) {
  try {
    const res = await apiFetch(
      `/api/today-plan/service/commit?service=${encodeURIComponent(service)}&commit=${encodeURIComponent(commit)}`,
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (todayPlanCommitTitle) {
      todayPlanCommitTitle.textContent =
        data.commit && data.commit.subject ? data.commit.subject : commit;
    }
    if (todayPlanCommitMeta) {
      const meta = [];
      if (data.service) meta.push(data.service);
      if (data.commit && data.commit.hash) meta.push(data.commit.hash);
      if (data.commit && data.commit.author) meta.push(data.commit.author);
      if (data.commit && data.commit.committed_at)
        meta.push(formatDateTime(data.commit.committed_at));
      todayPlanCommitMeta.textContent = meta.join(' · ');
    }
    renderTodayPlanCommitDiff(data.diff || data.error || '');
    if (todayPlanCommitModal) {
      todayPlanCommitModal.classList.remove('hidden');
    }
  } catch (err) {
    console.error('Failed to load today plan commit diff:', err);
    alert(err.message || '加载 commit diff 失败');
  }
}

async function sendTodayPlanMail() {
  if (!currentTodayPlanId) return;
  try {
    const result = await openTodayPlanMailSendDialog(
      {
        name: todayPlanMailSenderName || '',
        to: todayPlanMailToText || '',
        cc: todayPlanMailCcText || '',
      },
      {
        prepareDraft: async (formData) => {
          const name = String(formData.name || '').trim();
          const toText = String(formData.to || '').trim();
          const ccText = String(formData.cc || '').trim();
          const to = parseTodayPlanMailRecipientsInput(toText);
          const cc = parseTodayPlanMailRecipientsInput(ccText);
          todayPlanMailSenderName = name;
          todayPlanMailToText = toText;
          todayPlanMailCcText = ccText;
          const prepareRes = await apiFetch('/api/today-plan/mail/prepare', {
            method: 'POST',
            body: JSON.stringify({ plan_id: currentTodayPlanId, name, to, cc }),
          });
          const prepareData = await prepareRes.json();
          if (!prepareRes.ok)
            throw new Error(prepareData.error || `HTTP ${prepareRes.status}`);
          return prepareData.draft || null;
        },
        confirmDraft: async (draft) => {
          const confirmRes = await apiFetch('/api/today-plan/mail/confirm', {
            method: 'POST',
            body: JSON.stringify({
              draft_id: draft.id,
              subject: draft.subject,
              body: draft.body,
              to: Array.isArray(draft.to) ? draft.to : [],
              cc: Array.isArray(draft.cc) ? draft.cc : [],
              bcc: Array.isArray(draft.bcc) ? draft.bcc : [],
            }),
          });
          const confirmData = await confirmRes.json();
          if (!confirmRes.ok)
            throw new Error(confirmData.error || `HTTP ${confirmRes.status}`);
          return confirmData.draft || draft;
        },
      },
    );
    if (!result || !result.draft) return;
    const sentDraft = result.draft || {};
    const recipientCount = Array.isArray(sentDraft.to)
      ? sentDraft.to.length
      : 0;
    showToast(
      recipientCount > 0
        ? `计划邮件已发送 · ${recipientCount} 位收件人`
        : '计划邮件已发送',
      2200,
    );
  } catch (err) {
    console.error('Failed to send today plan mail:', err);
    alert(err.message || '发送计划邮件失败');
  }
}

function getAssistantSettings() {
  return assistantState && assistantState.settings
    ? assistantState.settings
    : null;
}

function getAssistantRuleCapabilities() {
  return assistantState && Array.isArray(assistantState.triggerRuleCapabilities)
    ? assistantState.triggerRuleCapabilities
    : [];
}

function getAssistantRuleSetting(ruleKey) {
  const settings = getAssistantSettings();
  return settings && settings.triggerRules && settings.triggerRules[ruleKey]
    ? settings.triggerRules[ruleKey]
    : {
        enabled: false,
        investigationEnabled: false,
        autoEnabled: false,
        lookbackDays: 3,
      };
}

function getAssistantRuleCapability(ruleKey) {
  return (
    getAssistantRuleCapabilities().find((rule) => rule.key === ruleKey) || null
  );
}

function getAssistantScanScheduleState() {
  return assistantState &&
    assistantState.schedule &&
    typeof assistantState.schedule === 'object'
    ? assistantState.schedule
    : null;
}

function getAssistantOnlineLogServiceOptions() {
  return assistantState && Array.isArray(assistantState.onlineLogServiceOptions)
    ? assistantState.onlineLogServiceOptions
    : [];
}

function getAssistantEvolutionSettings() {
  const settings = getAssistantSettings();
  return settings && settings.evolution ? settings.evolution : null;
}

function getAssistantEvolutionState() {
  return assistantState &&
    assistantState.evolution &&
    typeof assistantState.evolution === 'object'
    ? assistantState.evolution
    : null;
}

function getAssistantSourceGroupKey(rule) {
  return rule && rule.sourceLabel ? String(rule.sourceLabel) : '其他';
}

function groupAssistantRuleCapabilities(capabilities) {
  const groups = [];
  const groupByKey = {};
  capabilities.forEach((rule) => {
    const key = getAssistantSourceGroupKey(rule);
    if (!groupByKey[key]) {
      groupByKey[key] = {
        key,
        label: key,
        rules: [],
      };
      groups.push(groupByKey[key]);
    }
    groupByKey[key].rules.push(rule);
  });
  return groups;
}

function formatAssistantSourceGroupSummary(group) {
  const totalCount = group.rules.length;
  const enabledCount = group.rules.filter(
    (rule) => getAssistantRuleSetting(rule.key).enabled,
  ).length;
  const investigationCount = group.rules.filter(
    (rule) => getAssistantRuleSetting(rule.key).investigationEnabled,
  ).length;
  const autoCount = group.rules.filter(
    (rule) => getAssistantRuleSetting(rule.key).autoEnabled,
  ).length;
  const parts = [`${enabledCount}/${totalCount} 已启用`];
  if (investigationCount > 0) parts.push(`${investigationCount} 排查`);
  if (autoCount > 0) parts.push(`${autoCount} 自动`);
  return parts.join(' · ');
}

function formatAssistantRuleCapabilitySummary(rule) {
  const parts = [];
  if (rule.supportsInvestigation) parts.push('可排查');
  if (rule.supportsRepair) parts.push('可自动');
  if (rule.supportsAutoAction) parts.push('可自动处理');
  if (rule.key === 'today_plan.service_coding_anomaly')
    parts.push('异常后入箱');
  return parts.length > 0 ? parts.join(' · ') : '纯提醒';
}

function renderAssistantLookbackControl(rule, ruleSetting) {
  if (!rule || rule.key !== 'today_plan.service_coding_anomaly') return '';
  const value = Number(ruleSetting.lookbackDays);
  return `
    <label class="assistant-field assistant-rule-lookback">
      <span>天数</span>
      <input
        data-assistant-rule-lookback="${escapeAttribute(rule.key)}"
        type="number"
        min="1"
        max="30"
        step="1"
        value="${escapeAttribute(String(Number.isFinite(value) ? value : 3))}"
      />
    </label>
  `;
}

function renderAssistantOnlineLogServicePicker(rule, ruleSetting) {
  if (!rule || rule.key !== 'online.error_logs') return '';
  const services = getAssistantOnlineLogServiceOptions();
  const selected = new Set(
    Array.isArray(ruleSetting.selectedServices)
      ? ruleSetting.selectedServices
      : [],
  );
  if (services.length === 0) {
    return '<div class="assistant-service-picker-empty">暂无服务配置</div>';
  }
  return `
    <div class="assistant-service-picker">
      ${services
        .map((service) => {
          const configured = Boolean(service.configured);
          const checked = configured && selected.has(service.service);
          const meta = configured
            ? `${(service.hosts || []).join(', ')} · ${service.logsErrorPath || ''}`
            : service.disabledReason || '缺少日志配置';
          return `
          <label class="assistant-service-option${configured ? '' : ' disabled'}">
            <input
              data-assistant-rule-service="${escapeAttribute(rule.key)}"
              data-assistant-service="${escapeAttribute(service.service || '')}"
              type="checkbox"
              ${checked ? 'checked' : ''}
              ${configured ? '' : 'disabled'}
            />
            <span>
              <strong>${escapeHtml(service.service || '--')}</strong>
              <small>${escapeHtml(meta)}</small>
            </span>
          </label>
        `;
        })
        .join('')}
    </div>
  `;
}

function renderAssistantSourceRule(rule) {
  const ruleSetting = getAssistantRuleSetting(rule.key);
  const investigateDisabled = !rule.supportsInvestigation;
  const supportsAutomation = Boolean(
    rule.supportsRepair || rule.supportsAutoAction,
  );
  const autoDisabled = !supportsAutomation;
  return `
    <article class="assistant-rule-card">
      <div class="assistant-rule-main">
        <div>
          <div class="assistant-rule-title">${escapeHtml(rule.label || rule.key)}</div>
          <div class="assistant-rule-source">${escapeHtml(formatAssistantRuleCapabilitySummary(rule))}</div>
        </div>
        <label class="assistant-rule-toggle">
          <input data-assistant-rule="${escapeAttribute(rule.key)}" data-assistant-rule-field="enabled" type="checkbox" ${ruleSetting.enabled ? 'checked' : ''} />
          <span>生成</span>
        </label>
      </div>
      <div class="assistant-rule-options">
        ${renderAssistantLookbackControl(rule, ruleSetting)}
        ${
          rule.supportsInvestigation
            ? `
          <label>
            <input data-assistant-rule="${escapeAttribute(rule.key)}" data-assistant-rule-field="investigationEnabled" type="checkbox" ${ruleSetting.investigationEnabled ? 'checked' : ''} ${investigateDisabled ? 'disabled' : ''} />
            <span>排查</span>
          </label>
        `
            : ''
        }
        ${
          supportsAutomation
            ? `
          <label>
            <input data-assistant-rule="${escapeAttribute(rule.key)}" data-assistant-rule-field="autoEnabled" type="checkbox" ${ruleSetting.autoEnabled ? 'checked' : ''} ${autoDisabled ? 'disabled' : ''} />
            <span>${rule.supportsAutoAction ? '自动处理' : '自动'}</span>
          </label>
        `
            : ''
        }
        ${!rule.supportsInvestigation && !rule.supportsRepair && !rule.supportsAutoAction ? '<span class="assistant-rule-muted">纯提醒</span>' : ''}
      </div>
      ${renderAssistantOnlineLogServicePicker(rule, ruleSetting)}
    </article>
  `;
}

function formatAssistantStatusText(item) {
  if (!item) return '';
  const pending = assistantInboxActionPendingItems[item.id || ''];
  const extra = item.extra && typeof item.extra === 'object' ? item.extra : {};
  const flowStatus =
    pending && pending.status ? pending.status : extra.autoFlowStatus;
  const flowLabelMap = {
    investigating: '排查中',
    investigated: '已排查',
    repairing: '修复中',
    fixed: '已修复',
    repair_failed: '修复失败',
    failed: '排查失败',
  };
  const parts = [
    item.kind || 'notification',
    item.priority || 'normal',
    item.status || 'unread',
  ];
  if (flowStatus && flowLabelMap[flowStatus])
    parts.push(flowLabelMap[flowStatus]);
  return parts.filter(Boolean).join(' · ');
}

function renderAssistantHeroMetrics() {
  const settings = getAssistantSettings();
  const activeItems = assistantInboxItems.filter(
    (item) => !['done', 'dismissed'].includes(item.status),
  );
  const unreadCount = activeItems.filter(
    (item) => item.status === 'unread',
  ).length;
  const enabled = Boolean(settings && settings.enabled);
  const dataSourceCount =
    settings && settings.triggerRules
      ? Object.values(settings.triggerRules).filter(
          (rule) => rule && rule.enabled,
        ).length
      : 0;
  if (assistantStatusBadge) {
    assistantStatusBadge.textContent = settings
      ? enabled
        ? '运行中'
        : '已暂停'
      : '加载中';
    assistantStatusBadge.classList.toggle(
      'is-paused',
      Boolean(settings && !enabled),
    );
  }
  if (assistantActiveCount)
    assistantActiveCount.textContent = settings
      ? String(activeItems.length)
      : '--';
  if (assistantUnreadCount)
    assistantUnreadCount.textContent = settings ? String(unreadCount) : '--';
  if (assistantScanCadence) {
    assistantScanCadence.textContent = settings
      ? `${settings.scanIntervalMinutes || 10}m`
      : '--';
  }
  if (assistantSourceCount)
    assistantSourceCount.textContent = settings
      ? String(dataSourceCount)
      : '--';
}

function renderAssistantSourceRules() {
  if (!assistantSourceGrid) return;
  const capabilities = getAssistantRuleCapabilities();
  const settings = getAssistantSettings();
  if (!settings || capabilities.length === 0) {
    assistantSourceGrid.innerHTML = '<div class="assistant-empty">加载中</div>';
    assistantSourceInputs = [];
    assistantServiceInputs = [];
    assistantLookbackInputs = [];
    return;
  }
  const groups = groupAssistantRuleCapabilities(capabilities);
  assistantSourceGrid.innerHTML = groups
    .map((group) => {
      const isExpanded = Boolean(assistantSourceExpandedGroups[group.key]);
      return `
      <section class="assistant-source-group${isExpanded ? ' expanded' : ''}">
        <button type="button" class="assistant-source-group-toggle" data-assistant-source-group="${escapeAttribute(group.key)}" aria-expanded="${isExpanded ? 'true' : 'false'}">
          <span class="assistant-source-group-copy">
            <span class="assistant-source-group-title">${escapeHtml(group.label)}</span>
            <span class="assistant-source-group-meta">${escapeHtml(formatAssistantSourceGroupSummary(group))}</span>
          </span>
          <span class="assistant-source-group-chevron" aria-hidden="true">${isExpanded ? '▾' : '▸'}</span>
        </button>
        <div class="assistant-source-group-items${isExpanded ? '' : ' hidden'}">
          ${group.rules.map((rule) => renderAssistantSourceRule(rule)).join('')}
        </div>
      </section>
    `;
    })
    .join('');
  Array.from(
    assistantSourceGrid.querySelectorAll('[data-assistant-source-group]'),
  ).forEach((button) => {
    button.addEventListener('click', () => {
      const groupKey = button.getAttribute('data-assistant-source-group') || '';
      if (!groupKey) return;
      assistantSourceExpandedGroups[groupKey] =
        !assistantSourceExpandedGroups[groupKey];
      renderAssistantSourceRules();
    });
  });
  assistantSourceInputs = Array.from(
    assistantSourceGrid.querySelectorAll('[data-assistant-rule]'),
  );
  assistantSourceInputs.forEach((input) => {
    input.addEventListener('change', () => {
      const ruleKey = input.getAttribute('data-assistant-rule') || '';
      const field = input.getAttribute('data-assistant-rule-field') || '';
      if (!ruleKey || !field) return;
      const current = getAssistantRuleSetting(ruleKey);
      const next = {
        enabled: Boolean(current.enabled),
        investigationEnabled: Boolean(current.investigationEnabled),
        autoEnabled: Boolean(current.autoEnabled),
        selectedServices: Array.isArray(current.selectedServices)
          ? current.selectedServices.slice()
          : [],
        lookbackDays: Number(current.lookbackDays) || 3,
        [field]: input.checked,
      };
      if (field === 'autoEnabled' && input.checked) {
        if (getAssistantRuleCapability(ruleKey)?.supportsInvestigation) {
          next.investigationEnabled = true;
        }
      }
      updateAssistantSettingsPatch({
        triggerRules: { [ruleKey]: next },
      });
    });
  });
  assistantServiceInputs = Array.from(
    assistantSourceGrid.querySelectorAll('[data-assistant-rule-service]'),
  );
  assistantServiceInputs.forEach((input) => {
    input.addEventListener('change', () => {
      const ruleKey = input.getAttribute('data-assistant-rule-service') || '';
      const service = input.getAttribute('data-assistant-service') || '';
      if (!ruleKey || !service) return;
      const current = getAssistantRuleSetting(ruleKey);
      const selected = new Set(
        Array.isArray(current.selectedServices) ? current.selectedServices : [],
      );
      if (input.checked) selected.add(service);
      else selected.delete(service);
      updateAssistantSettingsPatch({
        triggerRules: {
          [ruleKey]: {
            enabled: Boolean(current.enabled),
            investigationEnabled: Boolean(current.investigationEnabled),
            autoEnabled: Boolean(current.autoEnabled),
            selectedServices: Array.from(selected),
            lookbackDays: Number(current.lookbackDays) || 3,
          },
        },
      });
    });
  });
  assistantLookbackInputs = Array.from(
    assistantSourceGrid.querySelectorAll('[data-assistant-rule-lookback]'),
  );
  assistantLookbackInputs.forEach((input) => {
    input.addEventListener('change', () => {
      const ruleKey = input.getAttribute('data-assistant-rule-lookback') || '';
      if (!ruleKey) return;
      const current = getAssistantRuleSetting(ruleKey);
      const lookbackDays = Math.min(
        Math.max(Math.round(Number(input.value) || 3), 1),
        30,
      );
      input.value = String(lookbackDays);
      updateAssistantSettingsPatch({
        triggerRules: {
          [ruleKey]: {
            enabled: Boolean(current.enabled),
            investigationEnabled: Boolean(current.investigationEnabled),
            autoEnabled: Boolean(current.autoEnabled),
            selectedServices: Array.isArray(current.selectedServices)
              ? current.selectedServices.slice()
              : [],
            lookbackDays,
          },
        },
      });
    });
  });
}

function getAssistantInboxRuleKey(item) {
  return item && item.extra && typeof item.extra.ruleKey === 'string'
    ? item.extra.ruleKey
    : '';
}

function canShowAssistantInvestigate(item) {
  const ruleKey = getAssistantInboxRuleKey(item);
  const rule = getAssistantRuleCapability(ruleKey);
  const setting = getAssistantRuleSetting(ruleKey);
  return Boolean(
    rule && rule.supportsInvestigation && setting.investigationEnabled,
  );
}

function getAssistantInvestigation(item) {
  const extra = item && item.extra ? item.extra : {};
  const investigation = extra.investigation || null;
  if (
    investigation &&
    typeof investigation === 'object' &&
    !Array.isArray(investigation) &&
    Array.isArray(investigation.groups)
  ) {
    return investigation;
  }
  return null;
}

function getAssistantInvestigationError(item) {
  const extra = item && item.extra ? item.extra : {};
  return extra.lastInvestigationError
    ? String(extra.lastInvestigationError)
    : '';
}

function assistantRiskLevelLabel(level) {
  if (level === 'low') return '低';
  if (level === 'medium') return '中';
  if (level === 'high') return '高';
  return '未知';
}

function assistantFlowGroupKey(itemId, groupId) {
  return `${itemId}:${groupId || 'default'}`;
}

function assistantInvestigationGroups(investigation) {
  if (!investigation || typeof investigation !== 'object') return [];
  const groups = Array.isArray(investigation.groups)
    ? investigation.groups.filter((group) => group && typeof group === 'object')
    : [];
  return groups;
}

function renderAssistantFlowField(label, value) {
  if (value === null || value === undefined || value === '') return '';
  return `
    <div class="assistant-flow-field">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(String(value))}</strong>
    </div>
  `;
}

function renderAssistantRevisionField(revisions) {
  if (!Array.isArray(revisions) || revisions.length === 0) return '';
  return renderAssistantFlowField('修订号', revisions.join(', '));
}

function renderAssistantInvestigationEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) return '';
  return `
    <div class="assistant-flow-evidence">
      ${evidence
        .map((item) => {
          const label = item && item.label ? String(item.label) : '证据';
          const value = item && item.value ? String(item.value) : '';
          if (!value) return '';
          return `
          <div class="assistant-flow-evidence-item">
            <span>${escapeHtml(label)}</span>
            <code>${escapeHtml(value)}</code>
          </div>
        `;
        })
        .join('')}
    </div>
  `;
}

function renderAssistantGroupLogs(item, group) {
  const detail = getAssistantOnlineErrorLogExtra(item);
  const logs = detail ? detail.logs : [];
  const indexes = Array.isArray(group.log_indexes)
    ? group.log_indexes
        .map((index) => Number(index))
        .filter(
          (index) =>
            Number.isInteger(index) && index >= 0 && index < logs.length,
        )
    : [];
  if (indexes.length === 0) return '';
  return `
    <div class="assistant-flow-related-logs">
      <span>关联日志</span>
      ${indexes
        .map((index) => {
          const log = logs[index] || {};
          return `
          <div class="assistant-flow-related-log">
            <strong>${escapeHtml(formatAssistantOnlineErrorLogSummary(log, index))}</strong>
            <code>${escapeHtml(String(log.rawLog || ''))}</code>
          </div>
        `;
        })
        .join('')}
    </div>
  `;
}

function renderAssistantInvestigationGroup(item, group, index) {
  const itemId = item && item.id ? item.id : '';
  const groupId = group && group.id ? String(group.id) : `group-${index + 1}`;
  const expanded = Boolean(
    assistantFlowGroupExpandedItems[assistantFlowGroupKey(itemId, groupId)],
  );
  const pending = assistantInboxActionPendingItems[itemId];
  const flowStatus = item && item.extra ? item.extra.autoFlowStatus : '';
  const repairPending =
    (pending && pending.action === 'repair' && pending.groupId === groupId) ||
    flowStatus === 'repairing';
  const itemPending =
    Boolean(pending) ||
    flowStatus === 'investigating' ||
    flowStatus === 'repairing';
  const count = Number(group.count);
  const safeCount =
    Number.isFinite(count) && count > 0
      ? Math.round(count)
      : Array.isArray(group.log_indexes)
        ? group.log_indexes.length
        : 1;
  const countLabel =
    Array.isArray(group.revisions) && group.revisions.length > 0
      ? `${safeCount} 个修订`
      : `${safeCount} 条`;
  return `
    <article class="assistant-flow-group${expanded ? ' expanded' : ''}">
      <div class="assistant-flow-group-head">
        <button type="button" class="assistant-flow-group-toggle" data-assistant-flow-group="${escapeAttribute(itemId)}" data-assistant-flow-group-id="${escapeAttribute(groupId)}" aria-expanded="${expanded ? 'true' : 'false'}">
          <span>
            <strong>${escapeHtml(group.title || `异常分类 ${index + 1}`)}</strong>
            <small>${escapeHtml(`${countLabel} · 风险 ${assistantRiskLevelLabel(group.risk_level)} · ${group.repairable === true ? '可自动修复' : '需人工确认'}`)}</small>
          </span>
          <em>${expanded ? '收起' : '展开'}</em>
        </button>
        ${group.repairable === true ? `<button type="button" class="assistant-flow-repair-btn${repairPending ? ' is-pending' : ''}" data-assistant-action="repair" data-assistant-item="${escapeAttribute(itemId)}" data-assistant-group-id="${escapeAttribute(groupId)}" ${itemPending ? 'disabled aria-disabled="true"' : ''}>${repairPending ? '修复中...' : '修复'}</button>` : ''}
      </div>
      ${
        expanded
          ? `
        <div class="assistant-flow-summary">${escapeHtml(String(group.title || ''))}</div>
        <div class="assistant-flow-fields">
          ${renderAssistantFlowField('服务', group.service)}
          ${renderAssistantFlowField('需求', group.requirement)}
          ${renderAssistantRevisionField(group.revisions)}
          ${renderAssistantFlowField('摘要', group.summary)}
          ${renderAssistantFlowField('风险', assistantRiskLevelLabel(group.risk_level))}
          ${renderAssistantFlowField('根因', group.root_cause)}
          ${renderAssistantFlowField('修复建议', group.repair_plan || (group.repairable === true ? '' : '不建议自动修复'))}
          ${renderAssistantFlowField('需处理', group.required_user_action)}
        </div>
        ${renderAssistantInvestigationEvidence(group.evidence)}
        ${renderAssistantGroupLogs(item, group)}
      `
          : ''
      }
    </article>
  `;
}

function renderAssistantAutoFlowDetail(item) {
  if (!assistantFlowDetailExpandedItems[item.id]) return '';
  const extra = item && item.extra ? item.extra : {};
  const flowStatus = extra.autoFlowStatus ? String(extra.autoFlowStatus) : '';
  const investigation = getAssistantInvestigation(item);
  const repair = extra.repair || null;
  const investigationError = getAssistantInvestigationError(item);
  const hasDetail =
    investigation ||
    repair ||
    flowStatus ||
    extra.lastAutoFlowError ||
    investigationError ||
    extra.lastRepairError;
  if (!hasDetail) return '';

  if (!investigation) {
    const lines = [];
    if (flowStatus)
      lines.push(`状态：${assistantFlowStatusLabel(flowStatus) || flowStatus}`);
    if (extra.lastAutoFlowError) lines.push(`异常：${extra.lastAutoFlowError}`);
    if (investigationError) lines.push(`排查失败：${investigationError}`);
    if (extra.lastRepairError) lines.push(`修复失败：${extra.lastRepairError}`);
    const pending =
      flowStatus === 'investigating' || flowStatus === 'repairing';
    return `
      <div class="assistant-inbox-flow${pending ? ' is-pending' : ' error'}">
        ${lines.map((line) => `<div>${escapeHtml(line)}</div>`).join('')}
        ${pending ? '<div class="assistant-flow-pending-hint">后台正在执行，完成后会自动刷新结果。</div>' : ''}
      </div>
    `;
  }

  return `
    <div class="assistant-inbox-flow">
      <div class="assistant-flow-head">
        <span>排查结果</span>
        <strong>${investigation.repairable === true ? '可自动修复' : '需人工确认'}</strong>
      </div>
      ${investigation.summary ? `<div class="assistant-flow-summary">${escapeHtml(String(investigation.summary))}</div>` : ''}
      <div class="assistant-flow-fields">
        ${renderAssistantFlowField('状态', assistantFlowStatusLabel(extra.autoFlowStatus) || '已排查')}
        ${renderAssistantFlowField('风险', assistantRiskLevelLabel(investigation.risk_level))}
        ${renderAssistantFlowField('根因', investigation.root_cause)}
        ${renderAssistantFlowField('修复建议', investigation.repair_plan || (investigation.repairable === true ? '' : '不建议自动修复'))}
        ${renderAssistantFlowField('需处理', investigation.required_user_action)}
        ${repair && repair.summary ? renderAssistantFlowField('修复', repair.summary) : ''}
        ${repair && repair.next_action ? renderAssistantFlowField('后续', repair.next_action) : ''}
        ${extra.lastRepairError ? renderAssistantFlowField('修复失败', extra.lastRepairError) : ''}
      </div>
      <div class="assistant-flow-groups">
        ${assistantInvestigationGroups(investigation)
          .map((group, index) =>
            renderAssistantInvestigationGroup(item, group, index),
          )
          .join('')}
      </div>
    </div>
  `;
}

function getAssistantOnlineErrorLogExtra(item) {
  const extra =
    item &&
    item.extra &&
    item.extra.onlineErrorLog &&
    typeof item.extra.onlineErrorLog === 'object'
      ? item.extra.onlineErrorLog
      : null;
  if (!extra) return null;
  return {
    ...extra,
    logs: Array.isArray(extra.logs) ? extra.logs : [],
  };
}

function isAssistantOnlineErrorLogItem(item) {
  return Boolean(
    item &&
    item.source_type === 'online_error_log' &&
    getAssistantOnlineErrorLogExtra(item),
  );
}

function formatAssistantOnlineErrorLogBody(item) {
  const detail = getAssistantOnlineErrorLogExtra(item);
  if (!detail) return item && item.body ? item.body : '';
  const count = Number(detail.totalErrorCount);
  const safeCount = Number.isFinite(count) ? count : detail.logs.length;
  const minutes = detail.window && Number(detail.window.minutes);
  return `最近 ${Number.isFinite(minutes) ? minutes : 10} 分钟扫描到 ${safeCount} 条 ERROR 日志。`;
}

function formatAssistantOnlineErrorLogSummary(log, index) {
  const parts = [
    `#${index + 1}`,
    log && log.time ? String(log.time) : '',
    log && log.host ? String(log.host) : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

function renderAssistantOnlineErrorLogDetails(item) {
  if (
    !isAssistantOnlineErrorLogItem(item) ||
    !assistantLogDetailExpandedItems[item.id]
  )
    return '';
  const detail = getAssistantOnlineErrorLogExtra(item);
  const logs = detail.logs;
  const scanErrors = Array.isArray(detail.scanErrors) ? detail.scanErrors : [];
  const itemExpandedLogs = assistantLogDetailExpandedLogs[item.id] || {};
  return `
    <div class="assistant-log-detail-panel" data-assistant-log-panel="${escapeAttribute(item.id)}">
      <div class="assistant-log-detail-meta">
        <span>服务：${escapeHtml(String(detail.service || item.source_ref_id || '--'))}</span>
        <span>日志：${escapeHtml(String(detail.logPath || '--'))}</span>
      </div>
      ${
        logs.length === 0
          ? '<div class="assistant-log-detail-empty">暂无日志详情</div>'
          : `
        <div class="assistant-log-detail-list">
          ${logs
            .map((log, index) => {
              const expanded = Boolean(itemExpandedLogs[index]);
              return `
              <article class="assistant-log-detail-entry${expanded ? ' expanded' : ''}">
                <button type="button" class="assistant-log-detail-toggle" data-assistant-log-item="${escapeAttribute(item.id)}" data-assistant-log-index="${escapeAttribute(String(index))}" aria-expanded="${expanded ? 'true' : 'false'}">
                  <span>${escapeHtml(formatAssistantOnlineErrorLogSummary(log, index))}</span>
                  <strong>${expanded ? '收起' : '展开'}</strong>
                </button>
                ${expanded ? `<pre class="assistant-log-detail-raw">${escapeHtml(String(log.rawLog || ''))}</pre>` : ''}
              </article>
            `;
            })
            .join('')}
        </div>
      `
      }
      ${
        scanErrors.length > 0
          ? `
        <div class="assistant-log-detail-scan-errors">
          ${scanErrors.map((scanError) => `<div>${escapeHtml(`${scanError.host || '--'}：${scanError.error || ''}`)}</div>`).join('')}
        </div>
      `
          : ''
      }
    </div>
  `;
}

function renderAssistantInboxActions(item) {
  const investigation = getAssistantInvestigation(item);
  const flowError =
    getAssistantInvestigationError(item) ||
    (item &&
      item.extra &&
      (item.extra.lastAutoFlowError || item.extra.lastRepairError));
  const pending = assistantInboxActionPendingItems[item.id || ''];
  const pendingFlowStatus = item && item.extra ? item.extra.autoFlowStatus : '';
  const hasFlowDetail = Boolean(
    investigation ||
    flowError ||
    pendingFlowStatus === 'investigating' ||
    pendingFlowStatus === 'repairing',
  );
  const isFlowPending =
    pendingFlowStatus === 'investigating' || pendingFlowStatus === 'repairing';
  const pendingAction =
    pending && pending.action
      ? pending.action
      : pendingFlowStatus === 'investigating'
        ? 'investigate'
        : pendingFlowStatus === 'repairing'
          ? 'repair'
          : '';
  const disabledAttr =
    pending || isFlowPending ? 'disabled aria-disabled="true"' : '';
  const isExecutable =
    item.action_kind === 'continue_today_plan' ||
    (typeof item.action_kind === 'string' &&
      item.action_kind.startsWith('assistant_evolution_'));
  return `
    ${hasFlowDetail ? `<button type="button" class="assistant-action-btn" data-assistant-flow-detail="${escapeAttribute(item.id)}">${assistantFlowDetailExpandedItems[item.id] ? '收起结果' : '排查结果'}</button>` : ''}
    ${isAssistantOnlineErrorLogItem(item) ? `<button type="button" class="assistant-action-btn" data-assistant-log-detail="${escapeAttribute(item.id)}">${assistantLogDetailExpandedItems[item.id] ? '收起日志' : '日志详情'}</button>` : ''}
    ${canShowAssistantInvestigate(item) ? `<button type="button" class="assistant-action-btn${pendingAction === 'investigate' ? ' is-pending' : ''}" data-assistant-action="investigate" data-assistant-item="${escapeAttribute(item.id)}" ${disabledAttr}>${pendingAction === 'investigate' ? assistantPendingLabel('investigate') : investigation ? '重新排查' : '排查'}</button>` : ''}
    ${isExecutable ? `<button type="button" class="assistant-action-btn${pendingAction === 'execute' ? ' is-pending' : ''}" data-assistant-action="execute" data-assistant-item="${escapeAttribute(item.id)}" ${disabledAttr}>${pendingAction === 'execute' ? assistantPendingLabel('execute') : escapeHtml(item.action_label || '执行')}</button>` : ''}
    <button type="button" class="assistant-action-btn${pendingAction === 'snooze' ? ' is-pending' : ''}" data-assistant-action="snooze" data-assistant-item="${escapeAttribute(item.id)}" ${disabledAttr}>${pendingAction === 'snooze' ? assistantPendingLabel('snooze') : '稍后'}</button>
    <button type="button" class="assistant-action-btn${pendingAction === 'dismiss' ? ' is-pending' : ''}" data-assistant-action="dismiss" data-assistant-item="${escapeAttribute(item.id)}" ${disabledAttr}>${pendingAction === 'dismiss' ? assistantPendingLabel('dismiss') : '忽略'}</button>
  `;
}

function renderAssistantSettings() {
  const settings = getAssistantSettings();
  if (!settings) {
    if (assistantSettingsSummary)
      assistantSettingsSummary.textContent = '加载中';
    if (assistantScanSchedule) assistantScanSchedule.textContent = '加载中';
    if (assistantEvolutionSummary)
      assistantEvolutionSummary.textContent = '加载中';
    renderAssistantHeroMetrics();
    return;
  }
  if (assistantSettingsSummary) {
    assistantSettingsSummary.textContent = `${settings.enabled ? '已启用' : '已暂停'} · ${settings.proactiveLevel} · 每 ${settings.scanIntervalMinutes} 分钟扫描`;
  }
  renderAssistantScanSchedule(settings);
  if (assistantEnabledToggle)
    assistantEnabledToggle.checked = Boolean(settings.enabled);
  if (assistantLevelSelect)
    assistantLevelSelect.value = settings.proactiveLevel || 'balanced';
  if (
    assistantScanIntervalInput &&
    document.activeElement !== assistantScanIntervalInput
  ) {
    assistantScanIntervalInput.value = String(
      settings.scanIntervalMinutes || 10,
    );
  }
  if (assistantAutostartToggle)
    assistantAutostartToggle.checked = Boolean(
      settings.desktopAssistant && settings.desktopAssistant.autostart,
    );
  if (assistantAlwaysOnTopToggle)
    assistantAlwaysOnTopToggle.checked = Boolean(
      settings.desktopAssistant && settings.desktopAssistant.alwaysOnTop,
    );
  if (assistantMovementToggle)
    assistantMovementToggle.checked = Boolean(
      settings.desktopAssistant && settings.desktopAssistant.allowMovement,
    );
  renderAssistantEvolution();
  renderAssistantSourceRules();
  renderAssistantHeroMetrics();
}

function assistantEvolutionStatusLabel(status) {
  const labels = {
    discovering: '发现方向',
    proposal_drafting: '写方案',
    proposal_evaluating: '评估方案',
    proposal_refining: '完善方案',
    waiting_user_approval: '待确认实现',
    branch_preparing: '准备分支',
    implementing: '实现中',
    checking: '检查中',
    reviewing: '复核中',
    fixing: '修复中',
    ready_for_adoption: '待采纳',
    adopting: '采纳中',
    paused: '已暂停',
    blocked_by_policy: '策略阻断',
    adoption_failed: '采纳失败',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  };
  return labels[status] || status || '无';
}

function renderAssistantScanSchedule(settings) {
  if (!assistantScanSchedule) return;
  const schedule = getAssistantScanScheduleState() || {};
  const lastScan = formatDateTime(schedule.lastScanStartedAt);
  const nextScan =
    settings && settings.enabled ? formatDateTime(schedule.nextScanAt) : '';
  const parts = [
    `上次扫描：${lastScan === '--' ? '尚未扫描' : lastScan}`,
    `下次扫描：${settings && settings.enabled ? (nextScan === '--' ? '等待调度' : nextScan) : '已关闭'}`,
    schedule.scanRunning ? '正在扫描' : '',
  ].filter(Boolean);
  assistantScanSchedule.textContent = parts.join(' · ');
}

function formatAssistantEvolutionTime(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  try {
    return new Date(numeric).toLocaleString();
  } catch {
    return String(value || '');
  }
}

function renderAssistantEvolutionSchedule(evolution, state) {
  if (!assistantEvolutionSchedule) return;
  const schedule =
    state && state.schedule && typeof state.schedule === 'object'
      ? state.schedule
      : {};
  const enabled = Boolean(evolution && evolution.enabled);
  const lastTick = formatAssistantEvolutionTime(schedule.lastTickStartedAt);
  const nextTick = enabled
    ? formatAssistantEvolutionTime(schedule.nextTickAt)
    : '';
  const interval =
    evolution && evolution.scanIntervalMinutes
      ? `${evolution.scanIntervalMinutes} 分钟`
      : '';
  const parts = [
    `上次触发：${lastTick || '尚未触发'}`,
    `下次触发：${enabled ? nextTick || '等待调度' : '已关闭'}`,
    interval ? `间隔：${interval}` : '',
    schedule.tickRunning ? '正在推进' : '',
  ].filter(Boolean);
  assistantEvolutionSchedule.textContent = parts.join(' · ');
}

function renderAssistantEvolutionField(label, value) {
  if (value === null || value === undefined || value === '') return '';
  return `
    <div class="assistant-evolution-field">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(String(value))}</span>
    </div>
  `;
}

function renderAssistantEvolutionPre(title, content) {
  if (!content) return '';
  return `
    <details class="assistant-evolution-detail">
      <summary>${escapeHtml(title)}</summary>
      <pre>${escapeHtml(String(content))}</pre>
    </details>
  `;
}

function renderAssistantEvolutionArtifacts(active) {
  const artifacts = Array.isArray(active.artifacts) ? active.artifacts : [];
  if (!artifacts.length) return '';
  const diffArtifacts = artifacts
    .filter(
      (artifact) =>
        artifact.artifact_type === 'diff' ||
        artifact.artifact_type === 'diff_summary',
    )
    .slice(-4);
  const otherArtifacts = artifacts
    .filter(
      (artifact) =>
        artifact.artifact_type !== 'diff' &&
        artifact.artifact_type !== 'diff_summary',
    )
    .slice(-6);
  const visibleArtifacts = [...diffArtifacts, ...otherArtifacts].slice(-10);
  return `
    <div class="assistant-evolution-details">
      <div class="assistant-inbox-meta">产物</div>
      ${visibleArtifacts
        .map((artifact) =>
          renderAssistantEvolutionPre(
            artifact.title || artifact.artifact_type || 'artifact',
            artifact.content || artifact.path || '',
          ),
        )
        .join('')}
    </div>
  `;
}

function renderAssistantEvolutionTimeline(active) {
  const events = Array.isArray(active.events) ? active.events : [];
  if (!events.length) return '';
  return `
    <details class="assistant-evolution-detail assistant-evolution-timeline">
      <summary>时间线</summary>
      ${events
        .slice(-8)
        .map(
          (event) => `
        <div class="assistant-evolution-timeline-item">
          <strong>${escapeHtml(event.event_type || 'event')}</strong>
          <span>${escapeHtml(formatAssistantEvolutionTime(event.created_at))}</span>
          ${event.payload && Object.keys(event.payload).length ? `<pre>${escapeHtml(JSON.stringify(event.payload, null, 2))}</pre>` : ''}
        </div>
      `,
        )
        .join('')}
    </details>
  `;
}

function getAssistantEvolutionFailureReason(item) {
  if (!item || typeof item !== 'object') return '';
  const directReason =
    item.adoption_error ||
    item.blocked_reason ||
    (item.status === 'failed'
      ? item.bug_report || item.review_summary || item.check_summary
      : '');
  if (directReason) return String(directReason);
  const events = Array.isArray(item.events) ? item.events : [];
  for (const event of events.slice().reverse()) {
    const eventType = String((event && event.event_type) || '');
    const payload =
      event && event.payload && typeof event.payload === 'object'
        ? event.payload
        : {};
    const error = payload.error || payload.reason || payload.message;
    if (
      (eventType.includes('failed') || eventType.includes('error')) &&
      error
    ) {
      return String(error);
    }
  }
  return '';
}

function getAssistantEvolutionItemBody(item) {
  const failureReason = getAssistantEvolutionFailureReason(item);
  if (failureReason) return `失败原因：${failureReason}`;
  return item.proposal || '等待下一次推进';
}

function getAssistantEvolutionItems(state, active) {
  const latestItems =
    state && Array.isArray(state.latestItems) ? state.latestItems : [];
  if (!active) return latestItems;
  return [
    active,
    ...latestItems.filter((item) => item && item.id !== active.id),
  ];
}

function patchAssistantEvolutionItem(itemId, patch) {
  if (!assistantState || !assistantState.evolution || !itemId || !patch) return;
  const evolution = assistantState.evolution;
  const latestItems = Array.isArray(evolution.latestItems)
    ? evolution.latestItems
    : [];
  assistantState = {
    ...assistantState,
    evolution: {
      ...evolution,
      activeItem:
        evolution.activeItem && evolution.activeItem.id === itemId
          ? { ...evolution.activeItem, ...patch }
          : evolution.activeItem,
      latestItems: latestItems.map((item) =>
        item && item.id === itemId ? { ...item, ...patch } : item,
      ),
    },
  };
}

function formatAssistantEvolutionItemMeta(item) {
  return [
    assistantEvolutionStatusLabel(item.status),
    item.risk_level || 'unknown',
    item.updated_at ? `更新 ${formatDateTime(item.updated_at)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function renderAssistantEvolutionDetails(item) {
  if (!assistantEvolutionDetailExpandedItems[item.id]) return '';
  if (assistantEvolutionDetailLoadingItems[item.id]) {
    return '<div class="assistant-evolution-expanded"><div class="assistant-empty">详情加载中</div></div>';
  }
  return `
    <div class="assistant-evolution-expanded">
      <div class="assistant-evolution-fields">
        ${renderAssistantEvolutionField('模块', item.module_scope || 'unknown')}
        ${renderAssistantEvolutionField('base', item.base_commit)}
        ${renderAssistantEvolutionField('head', item.head_commit)}
        ${renderAssistantEvolutionField('merge', item.merge_commit)}
        ${renderAssistantEvolutionField('失败原因', getAssistantEvolutionFailureReason(item))}
        ${renderAssistantEvolutionField('阻断', item.blocked_reason)}
        ${renderAssistantEvolutionField('采纳错误', item.adoption_error)}
      </div>
      ${renderAssistantEvolutionPre('方案', item.proposal)}
      ${renderAssistantEvolutionPre('方案评估', item.proposal_evaluation)}
      ${renderAssistantEvolutionPre('实现摘要', item.implementation_summary)}
      ${renderAssistantEvolutionPre('检查输出', item.check_summary)}
      ${renderAssistantEvolutionPre('复核结论', item.review_summary)}
      ${renderAssistantEvolutionPre('Bug 报告', item.bug_report)}
      ${renderAssistantEvolutionArtifacts(item)}
      ${renderAssistantEvolutionTimeline(item)}
    </div>
  `;
}

function renderAssistantEvolutionActions(item, isActive) {
  const canApprove = item.status === 'waiting_user_approval';
  const canAdopt = item.status === 'ready_for_adoption';
  const canPause = !['completed', 'failed', 'cancelled', 'paused'].includes(
    item.status,
  );
  const canResume =
    item.status === 'paused' || item.status === 'adoption_failed';
  const canCancel = !['completed', 'failed', 'cancelled'].includes(item.status);
  return `
    <button type="button" class="assistant-action-btn" data-assistant-evolution-detail="${escapeAttribute(item.id)}">${assistantEvolutionDetailExpandedItems[item.id] ? '收起详情' : '详情'}</button>
    ${canApprove ? `<button type="button" class="assistant-action-btn" data-assistant-evolution-action="approve-implementation" data-assistant-evolution-item="${escapeAttribute(item.id)}">确认实现</button>` : ''}
    ${canAdopt ? `<button type="button" class="assistant-action-btn" data-assistant-evolution-action="adopt" data-assistant-evolution-item="${escapeAttribute(item.id)}">采纳方案</button>` : ''}
    ${canPause ? `<button type="button" class="assistant-action-btn" data-assistant-evolution-action="pause" data-assistant-evolution-item="${escapeAttribute(item.id)}">暂停</button>` : ''}
    ${canResume ? `<button type="button" class="assistant-action-btn" data-assistant-evolution-action="resume" data-assistant-evolution-item="${escapeAttribute(item.id)}">继续</button>` : ''}
    ${canCancel ? `<button type="button" class="assistant-action-btn" data-assistant-evolution-action="cancel" data-assistant-evolution-item="${escapeAttribute(item.id)}">取消</button>` : ''}
  `;
}

async function ensureAssistantEvolutionItemDetails(itemId) {
  if (!itemId || assistantEvolutionDetailLoadingItems[itemId]) return;
  const state = getAssistantEvolutionState();
  const active =
    state && state.activeItem && state.activeItem.id === itemId
      ? state.activeItem
      : null;
  const existingItem =
    active ||
    (state && Array.isArray(state.latestItems)
      ? state.latestItems.find((item) => item && item.id === itemId)
      : null);
  if (
    existingItem &&
    (Array.isArray(existingItem.events) ||
      Array.isArray(existingItem.artifacts))
  )
    return;
  assistantEvolutionDetailLoadingItems[itemId] = true;
  renderAssistantEvolution();
  try {
    const res = await apiFetch(
      `/api/assistant/evolution/items/${encodeURIComponent(itemId)}`,
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.item) {
      patchAssistantEvolutionItem(itemId, data.item);
    }
  } catch (err) {
    console.error('Failed to load assistant evolution item:', err);
    showToast(
      err instanceof Error ? err.message : '自我进化详情加载失败',
      2200,
    );
  } finally {
    delete assistantEvolutionDetailLoadingItems[itemId];
    renderAssistantEvolution();
  }
}

function renderAssistantEvolution() {
  const evolution = getAssistantEvolutionSettings();
  const state = getAssistantEvolutionState();
  const active = state && state.activeItem ? state.activeItem : null;
  const items = getAssistantEvolutionItems(state, active);
  if (assistantEvolutionSummary) {
    const enabledLabel = evolution && evolution.enabled ? '已启用' : '已关闭';
    const statusLabel = active
      ? assistantEvolutionStatusLabel(active.status)
      : '无进行中事项';
    assistantEvolutionSummary.textContent = `${enabledLabel} · ${statusLabel} · ${items.length} 条`;
  }
  renderAssistantEvolutionSchedule(evolution, state);
  if (assistantEvolutionEnabledToggle)
    assistantEvolutionEnabledToggle.checked = Boolean(
      evolution && evolution.enabled,
    );
  if (assistantEvolutionAutoImplementToggle)
    assistantEvolutionAutoImplementToggle.checked = Boolean(
      evolution && evolution.autoImplementEnabled,
    );
  if (assistantEvolutionAutoAdoptToggle)
    assistantEvolutionAutoAdoptToggle.checked = Boolean(
      evolution && evolution.autoAdoptEnabled,
    );
  if (
    assistantEvolutionScanIntervalInput &&
    document.activeElement !== assistantEvolutionScanIntervalInput
  ) {
    assistantEvolutionScanIntervalInput.value = String(
      (evolution && evolution.scanIntervalMinutes) || 60,
    );
  }
  if (!assistantEvolutionPanel) return;
  if (items.length === 0) {
    assistantEvolutionPanel.innerHTML =
      '<div class="assistant-empty assistant-panel-empty">暂无自我进化事项</div>';
    return;
  }
  assistantEvolutionPanel.innerHTML = items
    .map(
      (item) => `
    <article class="assistant-evolution-item${active && item.id === active.id ? ' is-active' : ''}">
      <div class="assistant-inbox-main">
        <div class="assistant-inbox-meta">${escapeHtml(formatAssistantEvolutionItemMeta(item))}</div>
        <div class="assistant-inbox-title">${escapeHtml(item.direction || '待发现')}</div>
        <div class="assistant-inbox-body">${escapeHtml(getAssistantEvolutionItemBody(item))}</div>
        <div class="assistant-inbox-meta">${escapeHtml(item.work_branch || item.base_branch || '')}</div>
      </div>
      <div class="assistant-inbox-actions">
        ${renderAssistantEvolutionActions(item, Boolean(active && item.id === active.id))}
      </div>
      ${renderAssistantEvolutionDetails(item)}
    </article>
  `,
    )
    .join('');
  Array.from(
    assistantEvolutionPanel.querySelectorAll(
      '[data-assistant-evolution-detail]',
    ),
  ).forEach((button) => {
    button.addEventListener('click', () => {
      const itemId =
        button.getAttribute('data-assistant-evolution-detail') || '';
      if (!itemId) return;
      assistantEvolutionDetailExpandedItems[itemId] =
        !assistantEvolutionDetailExpandedItems[itemId];
      renderAssistantEvolution();
      if (assistantEvolutionDetailExpandedItems[itemId]) {
        ensureAssistantEvolutionItemDetails(itemId);
      }
    });
  });
  Array.from(
    assistantEvolutionPanel.querySelectorAll(
      '[data-assistant-evolution-action]',
    ),
  ).forEach((button) => {
    button.addEventListener('click', async () => {
      const action =
        button.getAttribute('data-assistant-evolution-action') || '';
      const itemId = button.getAttribute('data-assistant-evolution-item') || '';
      await runAssistantEvolutionAction(action, itemId, button);
    });
  });
}

function renderAssistantInbox() {
  if (!assistantInboxList || !assistantInboxSummary) return;
  const activeItems = assistantInboxItems.filter(
    (item) => !['done', 'dismissed'].includes(item.status),
  );
  const unreadCount = activeItems.filter(
    (item) => item.status === 'unread',
  ).length;
  assistantInboxSummary.textContent = `${activeItems.length} 条活跃 · ${unreadCount} 条未读`;
  renderAssistantHeroMetrics();
  if (assistantInboxItems.length === 0) {
    assistantInboxList.innerHTML =
      '<div class="assistant-empty assistant-panel-empty">暂无主动事项</div>';
    return;
  }
  assistantInboxList.innerHTML = assistantInboxItems
    .map(
      (item) => `
    <article class="assistant-inbox-item ${escapeAttribute(item.priority || 'normal')}${assistantInboxItemStateClass(item)}">
      <div class="assistant-inbox-main">
        <div class="assistant-inbox-meta">${escapeHtml(formatAssistantStatusText(item))}</div>
        <div class="assistant-inbox-title">${escapeHtml(item.title || '未命名事项')}</div>
        <div class="assistant-inbox-body">${escapeHtml(formatAssistantOnlineErrorLogBody(item))}</div>
      </div>
      <div class="assistant-inbox-actions">
        ${renderAssistantInboxActions(item)}
      </div>
      ${renderAssistantAutoFlowDetail(item)}
      ${renderAssistantOnlineErrorLogDetails(item)}
    </article>
  `,
    )
    .join('');

  Array.from(
    assistantInboxList.querySelectorAll('[data-assistant-flow-detail]'),
  ).forEach((button) => {
    button.addEventListener('click', () => {
      const itemId = button.getAttribute('data-assistant-flow-detail') || '';
      if (!itemId) return;
      assistantFlowDetailExpandedItems[itemId] =
        !assistantFlowDetailExpandedItems[itemId];
      renderAssistantInbox();
    });
  });
  Array.from(
    assistantInboxList.querySelectorAll('[data-assistant-log-detail]'),
  ).forEach((button) => {
    button.addEventListener('click', () => {
      const itemId = button.getAttribute('data-assistant-log-detail') || '';
      if (!itemId) return;
      assistantLogDetailExpandedItems[itemId] =
        !assistantLogDetailExpandedItems[itemId];
      if (!assistantLogDetailExpandedItems[itemId]) {
        delete assistantLogDetailExpandedLogs[itemId];
      }
      renderAssistantInbox();
    });
  });
  Array.from(
    assistantInboxList.querySelectorAll('[data-assistant-log-index]'),
  ).forEach((button) => {
    button.addEventListener('click', () => {
      const itemId = button.getAttribute('data-assistant-log-item') || '';
      const index = button.getAttribute('data-assistant-log-index') || '';
      if (!itemId || !index) return;
      assistantLogDetailExpandedLogs[itemId] =
        assistantLogDetailExpandedLogs[itemId] || {};
      assistantLogDetailExpandedLogs[itemId][index] =
        !assistantLogDetailExpandedLogs[itemId][index];
      renderAssistantInbox();
    });
  });
  Array.from(
    assistantInboxList.querySelectorAll('[data-assistant-flow-group]'),
  ).forEach((button) => {
    button.addEventListener('click', () => {
      const itemId = button.getAttribute('data-assistant-flow-group') || '';
      const groupId = button.getAttribute('data-assistant-flow-group-id') || '';
      if (!itemId || !groupId) return;
      const key = assistantFlowGroupKey(itemId, groupId);
      assistantFlowGroupExpandedItems[key] =
        !assistantFlowGroupExpandedItems[key];
      renderAssistantInbox();
    });
  });
  Array.from(
    assistantInboxList.querySelectorAll('[data-assistant-action]'),
  ).forEach((button) => {
    button.addEventListener('click', async () => {
      const itemId = button.getAttribute('data-assistant-item') || '';
      const action = button.getAttribute('data-assistant-action') || '';
      const groupId = button.getAttribute('data-assistant-group-id') || '';
      await runAssistantInboxAction(
        itemId,
        action,
        button,
        groupId ? { group_id: groupId } : {},
      );
    });
  });
}

function assistantLocalStatusForAction(action) {
  if (action === 'snooze') return 'snoozed';
  if (action === 'dismiss') return 'dismissed';
  if (action === 'mark_read') return 'read';
  if (action === 'resolve') return 'done';
  return null;
}

function assistantFlowStatusLabel(status) {
  if (status === 'investigating') return '正在排查';
  if (status === 'repairing') return '正在修复';
  if (status === 'investigated') return '已排查';
  if (status === 'fixed') return '已修复';
  if (status === 'repair_failed') return '修复失败';
  if (status === 'failed') return '排查失败';
  return status ? String(status) : '';
}

function assistantPendingLabel(action) {
  if (action === 'investigate') return '排查中...';
  if (action === 'repair') return '修复中...';
  if (action === 'execute') return '执行中...';
  if (action === 'snooze') return '处理中...';
  if (action === 'dismiss') return '处理中...';
  if (action === 'mark_read') return '处理中...';
  if (action === 'resolve') return '处理中...';
  return '处理中...';
}

function assistantFlowStatusForAction(action) {
  if (action === 'investigate') return 'investigating';
  if (action === 'repair') return 'repairing';
  return null;
}

function assistantInboxItemStateClass(item) {
  if (!item) return '';
  const pending = assistantInboxActionPendingItems[item.id || ''];
  const extra = item.extra && typeof item.extra === 'object' ? item.extra : {};
  const flowStatus =
    pending && pending.status ? pending.status : extra.autoFlowStatus;
  return flowStatus === 'investigating' || flowStatus === 'repairing'
    ? ' is-pending'
    : '';
}

function patchAssistantInboxItemFlowStatus(itemId, status) {
  if (!itemId || !status) return;
  assistantInboxItems = assistantInboxItems.map((item) =>
    item.id === itemId
      ? {
          ...item,
          extra: {
            ...(item.extra || {}),
            autoFlowStatus: status,
            ...(status === 'investigating'
              ? { lastInvestigationError: null }
              : {}),
            ...(status === 'repairing' ? { lastRepairError: null } : {}),
          },
        }
      : item,
  );
  renderAssistantInbox();
}

function patchAssistantInboxItemStatus(itemId, status) {
  assistantInboxItems = assistantInboxItems.map((item) =>
    item.id === itemId ? { ...item, status } : item,
  );
  renderAssistantInbox();
}

function renderAssistantLogs() {
  if (!assistantLogList) return;
  if (assistantActionLogs.length === 0) {
    assistantLogList.innerHTML =
      '<div class="assistant-empty assistant-panel-empty">暂无动作日志</div>';
    return;
  }
  assistantLogList.innerHTML = assistantActionLogs
    .map(
      (log) => `
    <div class="assistant-log-item">
      <div class="assistant-log-title">${escapeHtml(log.action || 'action')} · ${escapeHtml(log.status || '')}</div>
      <div class="assistant-log-meta">${escapeHtml(formatDateTime(log.created_at || ''))}${log.title ? ` · ${escapeHtml(log.title)}` : ''}</div>
    </div>
  `,
    )
    .join('');
}

function renderAssistantScreen() {
  renderAssistantSettings();
  renderAssistantInbox();
  renderAssistantLogs();
}

async function loadAssistantState() {
  try {
    const res = await apiFetch('/api/assistant/state');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    assistantState = data;
    assistantInboxItems = Array.isArray(data.latestInboxItems)
      ? data.latestInboxItems
      : [];
    assistantActionLogs = Array.isArray(data.latestActionLogs)
      ? data.latestActionLogs
      : [];
    renderAssistantScreen();
  } catch (err) {
    console.error('Failed to load assistant state:', err);
    if (assistantInboxList) {
      assistantInboxList.innerHTML = `<div class="assistant-empty">个人助手加载失败：${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
    }
  }
}

async function updateAssistantSettingsPatch(patch) {
  try {
    const res = await apiFetch('/api/assistant/settings', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    assistantState = {
      ...(assistantState || {}),
      settings: data.settings,
    };
    renderAssistantScreen();
    await loadAssistantState();
  } catch (err) {
    console.error('Failed to update assistant settings:', err);
    showToast(
      err instanceof Error ? err.message : '个人助手设置保存失败',
      2200,
    );
  }
}

function scheduleAssistantScanIntervalSave() {
  if (!assistantScanIntervalInput) return;
  if (assistantScanIntervalSaveTimer)
    clearTimeout(assistantScanIntervalSaveTimer);
  assistantScanIntervalSaveTimer = setTimeout(() => {
    assistantScanIntervalSaveTimer = null;
    updateAssistantSettingsPatch({
      scanIntervalMinutes: Number(assistantScanIntervalInput.value) || 10,
    });
  }, 350);
}

function scheduleAssistantEvolutionScanIntervalSave() {
  if (!assistantEvolutionScanIntervalInput) return;
  if (assistantEvolutionScanIntervalSaveTimer)
    clearTimeout(assistantEvolutionScanIntervalSaveTimer);
  assistantEvolutionScanIntervalSaveTimer = setTimeout(() => {
    assistantEvolutionScanIntervalSaveTimer = null;
    updateAssistantSettingsPatch({
      evolution: {
        scanIntervalMinutes:
          Number(assistantEvolutionScanIntervalInput.value) || 60,
      },
    });
  }, 350);
}

async function runAssistantEvolutionAction(action, itemId, triggerButton) {
  if (!action) return;
  if (triggerButton) triggerButton.disabled = true;
  try {
    const url = `/api/assistant/evolution/items/${encodeURIComponent(itemId || '')}/${action}`;
    const res = await apiFetch(url, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showToast('自我进化动作已执行', 1800);
    await loadAssistantState();
  } catch (err) {
    console.error('Failed to run assistant evolution action:', err);
    showToast(err instanceof Error ? err.message : '自我进化动作失败', 2600);
  } finally {
    if (triggerButton) triggerButton.disabled = false;
  }
}

async function triggerAssistantEvolutionTick(triggerButton) {
  if (triggerButton) triggerButton.disabled = true;
  try {
    const res = await apiFetch('/api/assistant/evolution/tick', {
      method: 'POST',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showToast(
      data.action === 'item_created'
        ? '已创建自我进化事项'
        : '自我进化轮询已触发',
      1800,
    );
    await loadAssistantState();
  } catch (err) {
    console.error('Failed to trigger assistant evolution tick:', err);
    showToast(err instanceof Error ? err.message : '自我进化触发失败', 2600);
  } finally {
    if (triggerButton) triggerButton.disabled = false;
  }
}

async function runAssistantScan() {
  if (assistantScanBtn) assistantScanBtn.disabled = true;
  try {
    const res = await apiFetch('/api/assistant/scan', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showToast(`扫描完成 · ${data.createdOrUpdated || 0} 条`, 1800);
    await loadAssistantState();
  } catch (err) {
    console.error('Failed to run assistant scan:', err);
    showToast(err instanceof Error ? err.message : '个人助手扫描失败', 2200);
  } finally {
    if (assistantScanBtn) assistantScanBtn.disabled = false;
  }
}

async function clearAssistantData() {
  if (
    !confirm(
      '确定清除个人助手的聊天记录、Inbox、动作日志、稍后提醒和自我进化事项/记录？运行设置会保留。',
    )
  ) {
    return;
  }
  if (assistantClearDataBtn) assistantClearDataBtn.disabled = true;
  try {
    const res = await apiFetch('/api/assistant/data', { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    assistantInboxItems = [];
    assistantActionLogs = [];
    await loadAssistantState();
    showToast(`已清除 ${data.deleted?.total || 0} 条个人助手数据`, 2200);
  } catch (err) {
    console.error('Failed to clear assistant data:', err);
    showToast(
      err instanceof Error ? err.message : '个人助手数据清除失败',
      2600,
    );
  } finally {
    if (assistantClearDataBtn) assistantClearDataBtn.disabled = false;
  }
}

async function runAssistantInboxAction(
  itemId,
  action,
  triggerButton,
  payload = {},
) {
  if (!itemId || !action) return;
  if (assistantInboxActionPendingItemIds.has(itemId)) return;
  assistantInboxActionPendingItemIds.add(itemId);
  assistantInboxActionPendingItems[itemId] = {
    action,
    groupId: payload.group_id || '',
  };

  const previousItem = assistantInboxItems.find((item) => item.id === itemId);
  const localStatus = assistantLocalStatusForAction(action);
  const flowStatus = assistantFlowStatusForAction(action);
  if (flowStatus) {
    assistantInboxActionPendingItems[itemId].status = flowStatus;
    assistantFlowDetailExpandedItems[itemId] = true;
    if (payload.group_id) {
      assistantFlowGroupExpandedItems[
        assistantFlowGroupKey(itemId, payload.group_id)
      ] = true;
    }
    patchAssistantInboxItemFlowStatus(itemId, flowStatus);
  } else {
    renderAssistantInbox();
  }
  if (localStatus) {
    patchAssistantInboxItemStatus(itemId, localStatus);
  }

  try {
    const actionPayload =
      action === 'snooze' ? { minutes: 60, ...payload } : payload;
    const res = await apiFetch('/api/agent-inbox/action', {
      method: 'POST',
      body: JSON.stringify({ item_id: itemId, action, payload: actionPayload }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (action === 'investigate' || action === 'repair') {
      assistantFlowDetailExpandedItems[itemId] = true;
      if (payload.group_id) {
        assistantFlowGroupExpandedItems[
          assistantFlowGroupKey(itemId, payload.group_id)
        ] = true;
      }
    }
    await loadAssistantState();
  } catch (err) {
    delete assistantInboxActionPendingItems[itemId];
    if (previousItem) {
      assistantInboxItems = assistantInboxItems.map((item) =>
        item.id === itemId ? previousItem : item,
      );
    }
    renderAssistantInbox();
    await loadAssistantState();
    console.error('Failed to run assistant inbox action:', err);
    showToast(err instanceof Error ? err.message : 'Inbox 动作失败', 2200);
  } finally {
    assistantInboxActionPendingItemIds.delete(itemId);
    delete assistantInboxActionPendingItems[itemId];
    renderAssistantInbox();
  }
}

function openWorkstationTargetUrl(targetUrl) {
  if (!targetUrl) return false;
  try {
    const url = new URL(targetUrl);
    const target = url.searchParams.get('assistantTarget') || '';
    if (target === 'today-plan') {
      todayPlanVisible = true;
      applyScreenVisibility();
      loadTodayPlanOverview({
        forceOpenToday: true,
        showEmptyWhenNoToday: true,
      });
    } else if (target === 'trace-monitor') {
      setPrimaryNav('trace-monitor');
      loadTraceMonitorData({ force: true });
    } else if (target === 'assistant') {
      setPrimaryNav('assistant');
    } else if (target === 'configuration') {
      setPrimaryNav('configuration');
      const service = url.searchParams.get('service') || '';
      if (service) {
        currentServiceConfigName = service;
      }
    } else {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function openAssistantItemTarget(item) {
  if (!item || !item.action_url) return;
  if (isAssistantOnlineErrorLogItem(item)) {
    setPrimaryNav('assistant');
    assistantLogDetailExpandedItems[item.id] = true;
    renderAssistantInbox();
    const detailEl = assistantInboxList?.querySelector(
      `[data-assistant-log-panel="${CSS.escape(item.id)}"]`,
    );
    detailEl?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    runAssistantInboxAction(item.id, 'mark_read');
    return;
  }
  if (!openWorkstationTargetUrl(item.action_url)) {
    window.open(item.action_url, '_blank');
  }
  runAssistantInboxAction(item.id, 'mark_read');
}

function handleAssistantRealtimeEvent(event) {
  if (!event) return;
  if (activePrimaryNavKey === 'assistant') {
    loadAssistantState();
    return;
  }
  if (event.type === 'inbox_updated') {
    const item = event.item;
    if (!item || !item.id) return;
    const index = assistantInboxItems.findIndex(
      (entry) => entry.id === item.id,
    );
    if (index >= 0) assistantInboxItems[index] = item;
    else assistantInboxItems.unshift(item);
  }
}

function normalizeServiceConfigRegistry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const next = {};
  Object.entries(input).forEach(([name, config]) => {
    const safeName = String(name || '').trim();
    if (
      !safeName ||
      !config ||
      typeof config !== 'object' ||
      Array.isArray(config)
    )
      return;
    next[safeName] = cloneJson(config);
  });
  return next;
}

function sortServiceConfigNames(registry) {
  return Object.keys(registry || {}).sort((a, b) =>
    a.localeCompare(b, 'zh-CN'),
  );
}

function getServiceConfigValue(source, pathValue) {
  if (!source || !pathValue) return undefined;
  return String(pathValue)
    .split('.')
    .reduce((acc, part) => {
      if (!acc || typeof acc !== 'object') return undefined;
      return acc[part];
    }, source);
}

function setServiceConfigValue(target, pathValue, value) {
  if (!target || !pathValue) return;
  const parts = String(pathValue).split('.').filter(Boolean);
  if (parts.length === 0) return;
  let cursor = target;
  parts.slice(0, -1).forEach((part) => {
    if (
      !cursor[part] ||
      typeof cursor[part] !== 'object' ||
      Array.isArray(cursor[part])
    ) {
      cursor[part] = {};
    }
    cursor = cursor[part];
  });
  const last = parts[parts.length - 1];
  if (
    value === '' ||
    value === undefined ||
    value === null ||
    (Array.isArray(value) && value.length === 0)
  ) {
    delete cursor[last];
    return;
  }
  cursor[last] = value;
}

function normalizeServiceFieldValue(input, type) {
  if (type === 'number') {
    const raw = typeof input === 'string' ? input.trim() : input;
    if (raw === '' || raw === null || raw === undefined) return '';
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? Math.round(numeric) : '';
  }
  if (type === 'csv') {
    const text = Array.isArray(input) ? input.join(',') : String(input || '');
    return text
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (type === 'json') {
    if (input && typeof input === 'object') return input;
    const text = String(input || '').trim();
    if (!text) return '';
    try {
      return JSON.parse(text);
    } catch (err) {
      serviceConfigFieldError = `JSON 字段格式错误：${err instanceof Error ? err.message : '无法解析'}`;
      return undefined;
    }
  }
  return typeof input === 'string' ? input.trim() : input;
}

function formatServiceFieldValue(value, type) {
  if (type === 'csv') {
    return Array.isArray(value) ? value.join(', ') : String(value || '');
  }
  if (type === 'json') {
    if (value === undefined || value === null || value === '') return '';
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value || '');
    }
  }
  if (value === undefined || value === null) return '';
  return String(value);
}

function createEmptyServiceConfig(name = '') {
  const serviceName = name.trim();
  return {
    repo_path: serviceName,
    git_url: '',
    default_branch: 'master',
    jenkins_job: '',
    staging: {
      branch: 'erp',
      jenkins_job: '',
      domain: '',
      log_hosts: [],
      logs_info: '',
      logs_error: '',
      mysql: {
        host: '',
        port: 3306,
        user: '',
        database: '',
      },
    },
    user: 'root',
    log_hosts: [],
    logs_info: '',
    logs_error: '',
    log_line_pattern: '',
    log_line_group_mapping: {
      time: 1,
      level: 2,
    },
    mysql: {
      host: '',
      port: 3306,
      user: '',
      database: '',
    },
  };
}

function updateServiceConfigSaveStatus(text, state = '') {
  if (!configurationServiceSaveStatus) return;
  configurationServiceSaveStatus.textContent = text || '';
  configurationServiceSaveStatus.dataset.state = state || '';
}

function updateServiceConfigDirty(nextDirty) {
  serviceConfigDirty = Boolean(nextDirty);
  if (configurationServiceSaveBtn) {
    configurationServiceSaveBtn.disabled =
      serviceConfigSaving || (!currentServiceConfigName && !serviceConfigDirty);
    configurationServiceSaveBtn.textContent = serviceConfigSaving
      ? '保存中...'
      : '保存并生效';
  }
  if (serviceConfigSaving) {
    updateServiceConfigSaveStatus('保存中', 'saving');
  } else if (serviceConfigDirty) {
    updateServiceConfigSaveStatus('有未保存修改', 'dirty');
  } else if (currentServiceConfigName) {
    updateServiceConfigSaveStatus('已保存', 'saved');
  } else {
    updateServiceConfigSaveStatus('未选择服务', '');
  }
}

function readServiceConfigDraftFromForm() {
  const base =
    serviceConfigDraft && typeof serviceConfigDraft === 'object'
      ? cloneJson(serviceConfigDraft)
      : {};
  serviceConfigFieldError = '';
  configurationServiceFieldInputs.forEach((input) => {
    if (serviceConfigFieldError) return;
    const pathValue = input.getAttribute('data-service-config-path') || '';
    const type = input.getAttribute('data-service-config-type') || 'text';
    const value = normalizeServiceFieldValue(input.value, type);
    if (serviceConfigFieldError) return;
    setServiceConfigValue(base, pathValue, value);
  });
  if (serviceConfigFieldError) return null;
  return base;
}

function syncServiceJsonFromForm(markDirty = true) {
  if (!currentServiceConfigName) return;
  const nextDraft = readServiceConfigDraftFromForm();
  if (!nextDraft) {
    updateServiceConfigSaveStatus(serviceConfigFieldError, 'error');
    updateServiceConfigDirty(true);
    return;
  }
  serviceConfigDraft = nextDraft;
  if (configurationServiceJsonEditor) {
    configurationServiceJsonEditor.value = stringifyPrettyJson(
      serviceConfigDraft || {},
    );
  }
  if (markDirty) updateServiceConfigDirty(true);
  renderServiceConfigHeader();
}

function renderServiceConfigHeader() {
  const draft = serviceConfigDraft || {};
  if (configurationServiceTitle) {
    configurationServiceTitle.textContent = currentServiceConfigName || '--';
  }
  if (configurationServiceSummary) {
    const repoPath = draft.repo_path || currentServiceConfigName || '--';
    const defaultBranch = draft.default_branch || '--';
    const jenkinsJob = draft.jenkins_job || '--';
    configurationServiceSummary.textContent = `${repoPath} · ${defaultBranch} · ${jenkinsJob}`;
  }
  if (configurationServiceMeta) {
    const mysql =
      draft.mysql && typeof draft.mysql === 'object' ? draft.mysql : {};
    const staging =
      draft.staging && typeof draft.staging === 'object' ? draft.staging : {};
    configurationServiceMeta.innerHTML = [
      { label: 'Repo', value: draft.repo_path || '--' },
      { label: 'Git', value: draft.git_url || '--' },
      {
        label: 'MySQL',
        value:
          mysql.database || mysql.host
            ? `${mysql.database || '--'} @ ${mysql.host || '--'}`
            : '--',
      },
      { label: 'Staging', value: staging.domain || staging.branch || '--' },
    ]
      .map(
        (item) =>
          `<span class="management-pill"><strong>${escapeHtml(item.label)}</strong>${escapeHtml(String(item.value))}</span>`,
      )
      .join('');
  }
}

function renderServiceConfigList() {
  if (!configurationServiceList) return;
  const toggle = configurationServicesToggle;
  if (toggle) {
    toggle.setAttribute(
      'aria-expanded',
      serviceConfigListExpanded ? 'true' : 'false',
    );
    const group = toggle.closest('.configuration-nav-group');
    if (group) group.classList.toggle('expanded', serviceConfigListExpanded);
    const chevron = toggle.querySelector('.configuration-nav-chevron');
    if (chevron) chevron.textContent = serviceConfigListExpanded ? '▾' : '▸';
  }
  configurationServiceList.classList.toggle(
    'hidden',
    !serviceConfigListExpanded,
  );
  if (!serviceConfigListExpanded) return;
  serviceConfigNames = sortServiceConfigNames(serviceConfigRegistry);
  if (serviceConfigNames.length === 0) {
    configurationServiceList.innerHTML =
      '<div class="management-list-empty">暂无服务配置</div>';
    return;
  }
  configurationServiceList.innerHTML = serviceConfigNames
    .map((name) => {
      const config = serviceConfigRegistry[name] || {};
      const mysql =
        config.mysql && typeof config.mysql === 'object' ? config.mysql : {};
      return `
      <button type="button" class="management-list-item configuration-service-item${name === currentServiceConfigName ? ' active' : ''}" data-service-config-name="${escapeAttribute(name)}">
        <div class="management-list-head">
          <div class="management-list-title">${escapeHtml(name)}</div>
          <span class="management-pill management-main-pill">${escapeHtml(config.default_branch || 'branch --')}</span>
        </div>
        <p class="management-list-desc">${escapeHtml(config.repo_path || config.git_url || '未配置仓库')}</p>
        <div class="management-list-meta">
          <span class="management-pill"><strong>Jenkins</strong>${escapeHtml(config.jenkins_job || '--')}</span>
          <span class="management-pill"><strong>DB</strong>${escapeHtml(mysql.database || '--')}</span>
        </div>
      </button>
    `;
    })
    .join('');
  Array.from(
    configurationServiceList.querySelectorAll('[data-service-config-name]'),
  ).forEach((button) => {
    button.addEventListener('click', () => {
      const name = button.getAttribute('data-service-config-name') || '';
      selectServiceConfig(name);
    });
  });
}

function renderServiceConfigDetail() {
  const hasSelection = Boolean(currentServiceConfigName);
  const showServices = configurationMode === 'services';
  if (configurationServiceEmpty)
    configurationServiceEmpty.classList.toggle(
      'hidden',
      !showServices || hasSelection,
    );
  if (configurationServiceDetail)
    configurationServiceDetail.classList.toggle(
      'hidden',
      !showServices || !hasSelection,
    );
  if (!hasSelection) {
    updateServiceConfigDirty(false);
    return;
  }

  if (configurationServiceNameInput) {
    configurationServiceNameInput.value = currentServiceConfigName;
  }
  configurationServiceFieldInputs.forEach((input) => {
    const pathValue = input.getAttribute('data-service-config-path') || '';
    const type = input.getAttribute('data-service-config-type') || 'text';
    input.value = formatServiceFieldValue(
      getServiceConfigValue(serviceConfigDraft || {}, pathValue),
      type,
    );
  });
  if (configurationServiceJsonEditor) {
    configurationServiceJsonEditor.value = stringifyPrettyJson(
      serviceConfigDraft || {},
    );
  }
  renderServiceConfigHeader();
  updateServiceConfigDirty(false);
}

function selectServiceConfig(name) {
  if (!name || !serviceConfigRegistry[name]) return;
  currentServiceConfigName = name;
  serviceConfigDraft = cloneJson(serviceConfigRegistry[name] || {});
  renderServiceConfigList();
  renderServiceConfigDetail();
}

function updateServiceConfigFromJson(markDirty = true) {
  if (!configurationServiceJsonEditor || !currentServiceConfigName)
    return false;
  let parsed;
  try {
    parsed = JSON.parse(configurationServiceJsonEditor.value || '{}');
  } catch (err) {
    updateServiceConfigSaveStatus(
      `JSON 格式错误：${err instanceof Error ? err.message : '无法解析'}`,
      'error',
    );
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    updateServiceConfigSaveStatus('当前服务 JSON 必须是对象', 'error');
    return false;
  }
  serviceConfigDraft = parsed;
  renderServiceConfigDetail();
  if (markDirty) updateServiceConfigDirty(true);
  return true;
}

function renameServiceConfigInDraft(nextName) {
  const safeName = nextName.trim();
  if (!safeName || safeName === currentServiceConfigName) return true;
  const exists =
    serviceConfigRegistry[safeName] && safeName !== currentServiceConfigName;
  if (exists) {
    updateServiceConfigSaveStatus('服务名称已存在', 'error');
    if (configurationServiceNameInput)
      configurationServiceNameInput.value = currentServiceConfigName;
    return false;
  }
  const previousName = currentServiceConfigName;
  currentServiceConfigName = safeName;
  serviceConfigRegistry[safeName] =
    serviceConfigDraft || createEmptyServiceConfig(safeName);
  delete serviceConfigRegistry[previousName];
  renderServiceConfigList();
  renderServiceConfigHeader();
  updateServiceConfigDirty(true);
  return true;
}

async function loadServiceConfigs(options = {}) {
  if (!configurationServiceList) return;
  const requestSeq = ++serviceConfigRequestSeq;
  const preserveSelection = options.preserveSelection !== false;
  if (!preserveSelection) {
    currentServiceConfigName = '';
    serviceConfigDraft = null;
  }
  configurationServiceList.innerHTML =
    '<div class="management-list-empty">加载服务配置中...</div>';
  try {
    const res = await apiFetch('/api/config/services');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (requestSeq !== serviceConfigRequestSeq) return;
    serviceConfigRegistry = normalizeServiceConfigRegistry(data.services || {});
    serviceConfigNames = sortServiceConfigNames(serviceConfigRegistry);
    serviceConfigFilePath = data.path || '';
    if (configurationServicesPathEl) {
      configurationServicesPathEl.textContent =
        serviceConfigFilePath || 'groups/global/services.json';
    }
    const nextSelection =
      preserveSelection &&
      currentServiceConfigName &&
      serviceConfigRegistry[currentServiceConfigName]
        ? currentServiceConfigName
        : serviceConfigNames[0] || '';
    currentServiceConfigName = '';
    serviceConfigDraft = null;
    renderServiceConfigList();
    if (nextSelection) {
      selectServiceConfig(nextSelection);
    } else {
      renderServiceConfigDetail();
    }
  } catch (err) {
    console.error('Failed to load service configs:', err);
    configurationServiceList.innerHTML = `<div class="management-list-empty">加载失败：${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
    updateServiceConfigSaveStatus('加载失败', 'error');
  }
}

async function createServiceConfig() {
  const rawName = await openTextPrompt('输入服务名称', '', {
    title: '新增服务',
  });
  const name = String(rawName || '').trim();
  if (!name) return;
  if (serviceConfigRegistry[name]) {
    alert('服务名称已存在');
    return;
  }
  serviceConfigRegistry[name] = createEmptyServiceConfig(name);
  currentServiceConfigName = name;
  serviceConfigDraft = cloneJson(serviceConfigRegistry[name]);
  renderServiceConfigList();
  renderServiceConfigDetail();
  updateServiceConfigDirty(true);
}

async function saveServiceConfigs() {
  if (serviceConfigSaving) return;
  if (currentServiceConfigName) {
    if (
      configurationServiceNameInput &&
      !renameServiceConfigInDraft(configurationServiceNameInput.value || '')
    ) {
      return;
    }
    if (!updateServiceConfigFromJson(false)) return;
  }
  const nextRegistry = normalizeServiceConfigRegistry({
    ...serviceConfigRegistry,
    ...(currentServiceConfigName
      ? { [currentServiceConfigName]: serviceConfigDraft || {} }
      : {}),
  });
  serviceConfigSaving = true;
  updateServiceConfigDirty(true);
  let saveSucceeded = false;
  try {
    const res = await apiFetch('/api/config/services', {
      method: 'POST',
      body: JSON.stringify({ services: nextRegistry }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    serviceConfigRegistry = normalizeServiceConfigRegistry(
      data.services || nextRegistry,
    );
    serviceConfigNames = sortServiceConfigNames(serviceConfigRegistry);
    if (!serviceConfigRegistry[currentServiceConfigName]) {
      currentServiceConfigName = serviceConfigNames[0] || '';
    }
    serviceConfigDraft = currentServiceConfigName
      ? cloneJson(serviceConfigRegistry[currentServiceConfigName])
      : null;
    renderServiceConfigList();
    renderServiceConfigDetail();
    saveSucceeded = true;
    updateServiceConfigSaveStatus('已保存并实时生效', 'saved');
  } catch (err) {
    console.error('Failed to save service configs:', err);
    updateServiceConfigSaveStatus(
      `保存失败：${err instanceof Error ? err.message : String(err)}`,
      'error',
    );
  } finally {
    serviceConfigSaving = false;
    if (saveSucceeded) {
      updateServiceConfigDirty(false);
      updateServiceConfigSaveStatus('已保存并实时生效', 'saved');
    } else if (
      !configurationServiceSaveStatus?.dataset ||
      configurationServiceSaveStatus?.dataset.state !== 'error'
    ) {
      updateServiceConfigDirty(false);
    } else if (configurationServiceSaveBtn) {
      configurationServiceSaveBtn.disabled = false;
      configurationServiceSaveBtn.textContent = '保存并生效';
    }
  }
}

async function deleteCurrentServiceConfig() {
  if (!currentServiceConfigName) return;
  const confirmed = await openConfirmDialog(
    `确认删除服务 ${currentServiceConfigName}？确认后会立即写入 services.json 并实时生效。`,
    {
      title: '删除服务配置',
      confirmText: '删除',
      cancelText: '取消',
      danger: true,
    },
  );
  if (!confirmed) return;
  delete serviceConfigRegistry[currentServiceConfigName];
  const nextName = sortServiceConfigNames(serviceConfigRegistry)[0] || '';
  currentServiceConfigName = '';
  serviceConfigDraft = null;
  renderServiceConfigList();
  if (nextName) selectServiceConfig(nextName);
  else renderServiceConfigDetail();
  updateServiceConfigDirty(true);
  renderServiceConfigList();
  await saveServiceConfigs();
}

function setConfigurationMode(mode) {
  configurationMode = mode === 'features' ? 'features' : 'services';
  const showServices = configurationMode === 'services';
  if (configurationServicesToggle) {
    configurationServicesToggle.classList.toggle('active', showServices);
  }
  if (configurationFeaturesToggle) {
    configurationFeaturesToggle.classList.toggle('active', !showServices);
  }
  if (configurationServiceAddBtn) {
    configurationServiceAddBtn.classList.toggle('hidden', !showServices);
  }
  if (configurationServiceEmpty) {
    configurationServiceEmpty.classList.toggle(
      'hidden',
      !showServices || Boolean(currentServiceConfigName),
    );
  }
  if (configurationServiceDetail) {
    configurationServiceDetail.classList.toggle(
      'hidden',
      !showServices || !currentServiceConfigName,
    );
  }
  if (configurationFeatureEmpty) {
    configurationFeatureEmpty.classList.toggle(
      'hidden',
      showServices || Boolean(currentFeatureConfigId),
    );
  }
  if (configurationFeatureDetail) {
    configurationFeatureDetail.classList.toggle(
      'hidden',
      showServices || !currentFeatureConfigId,
    );
  }
  if (!showServices) renderFeatureConfigDetail();
}

function renderFeatureConfigList() {
  if (!configurationFeatureList) return;
  if (configurationFeaturesToggle) {
    configurationFeaturesToggle.setAttribute(
      'aria-expanded',
      featureConfigListExpanded ? 'true' : 'false',
    );
    const group = configurationFeaturesToggle.closest('.configuration-nav-group');
    if (group) group.classList.toggle('expanded', featureConfigListExpanded);
    const chevron = configurationFeaturesToggle.querySelector(
      '.configuration-nav-chevron',
    );
    if (chevron) chevron.textContent = featureConfigListExpanded ? '▾' : '▸';
  }
  configurationFeatureList.classList.toggle(
    'hidden',
    !featureConfigListExpanded,
  );
  if (!featureConfigListExpanded) return;
  if (!featureConfigItems.length) {
    configurationFeatureList.innerHTML =
      '<div class="management-list-empty">暂无可用功能包</div>';
    return;
  }
  configurationFeatureList.innerHTML = featureConfigItems
    .map((feature) => {
      const enabled = Boolean(feature.enabled);
      return `
        <button type="button" class="management-list-item configuration-service-item${feature.id === currentFeatureConfigId ? ' active' : ''}" data-feature-config-id="${escapeAttribute(feature.id)}">
          <div class="management-list-head">
            <div class="management-list-title">${escapeHtml(feature.name || feature.id)}</div>
            <span class="management-pill management-main-pill">${enabled ? 'enabled' : 'disabled'}</span>
          </div>
          <p class="management-list-desc">${escapeHtml(feature.description || feature.id)}</p>
          <div class="management-list-meta">
            <span class="management-pill"><strong>ID</strong>${escapeHtml(feature.id)}</span>
            <span class="management-pill"><strong>Version</strong>${escapeHtml(feature.version || '--')}</span>
          </div>
        </button>
      `;
    })
    .join('');
  Array.from(
    configurationFeatureList.querySelectorAll('[data-feature-config-id]'),
  ).forEach((button) => {
    button.addEventListener('click', () => {
      const featureId = button.getAttribute('data-feature-config-id') || '';
      selectFeatureConfig(featureId);
    });
  });
}

function getSelectedFeatureConfig() {
  return (
    featureConfigItems.find((feature) => feature.id === currentFeatureConfigId) ||
    null
  );
}

function selectFeatureConfig(featureId) {
  if (!featureId) return;
  const feature = featureConfigItems.find((item) => item.id === featureId);
  if (!feature) return;
  currentFeatureConfigId = feature.id;
  setConfigurationMode('features');
  renderFeatureConfigList();
  renderFeatureConfigDetail();
  loadFeatureDeletionSummary(feature.id).catch((err) => {
    if (currentFeatureConfigId !== feature.id) return;
    renderFeatureDeletionSummaryError(err);
  });
}

function renderFeatureConfigDetail() {
  const feature = getSelectedFeatureConfig();
  const showFeatureDetail = configurationMode === 'features' && Boolean(feature);
  if (configurationFeatureEmpty) {
    configurationFeatureEmpty.classList.toggle('hidden', showFeatureDetail);
  }
  if (configurationFeatureDetail) {
    configurationFeatureDetail.classList.toggle('hidden', !showFeatureDetail);
  }
  if (!feature) return;
  if (configurationFeatureTitle) {
    configurationFeatureTitle.textContent = feature.name || feature.id;
  }
  if (configurationFeatureSummary) {
    configurationFeatureSummary.textContent =
      feature.description || 'No description';
  }
  if (configurationFeatureStatus) {
    configurationFeatureStatus.textContent = feature.enabled
      ? 'enabled'
      : 'disabled';
    configurationFeatureStatus.dataset.state = feature.enabled
      ? 'saved'
      : 'dirty';
  }
  if (configurationFeatureToggleBtn) {
    configurationFeatureToggleBtn.disabled = featureConfigActionBusy;
    configurationFeatureToggleBtn.textContent = feature.enabled
      ? '仅停用'
      : '启用';
  }
  if (configurationFeatureDeleteDataBtn) {
    configurationFeatureDeleteDataBtn.disabled = featureConfigActionBusy;
  }
  if (configurationFeatureMeta) {
    configurationFeatureMeta.innerHTML = [
      { label: 'ID', value: feature.id },
      { label: 'Version', value: feature.version || '--' },
      { label: 'API', value: feature.apiPrefix || '--' },
      { label: 'Nav', value: String(feature.nav_count || 0) },
    ]
      .map(
        (item) =>
          `<span class="management-pill"><strong>${escapeHtml(item.label)}</strong>${escapeHtml(String(item.value))}</span>`,
      )
      .join('');
  }
  if (configurationFeatureResources) {
    const resources =
      feature.resources && typeof feature.resources === 'object'
        ? Object.entries(feature.resources).filter(([, value]) => value)
        : [];
    configurationFeatureResources.innerHTML = resources.length
      ? resources
          .map(
            ([kind, value]) =>
              `<span class="management-pill"><strong>${escapeHtml(kind)}</strong>${escapeHtml(String(value))}</span>`,
          )
          .join('')
      : '<div class="management-list-empty">未声明资源</div>';
  }
}

function renderFeatureDeletionSummary(summary) {
  if (!configurationFeatureDeleteSummary) return;
  const counts = summary?.counts || {};
  const metrics = [
    ['Groups', counts.groups],
    ['Traces', counts.agent_queries],
    ['Messages', counts.messages],
    ['Projection Tables', counts.feature_projection_tables],
    ['Projection Rows', counts.feature_projection_rows],
    ['Runtime Paths', Array.isArray(summary?.paths) ? summary.paths.length : 0],
    ['Migrations', counts.feature_migrations],
  ];
  configurationFeatureDeleteSummary.innerHTML = metrics
    .map(
      ([label, value]) => `
        <div class="configuration-feature-metric">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(String(value ?? 0))}</strong>
        </div>
      `,
    )
    .join('');
}

function renderFeatureDeletionSummaryError(err) {
  if (!configurationFeatureDeleteSummary) return;
  configurationFeatureDeleteSummary.innerHTML = `<div class="management-list-empty">删除摘要加载失败：${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
}

async function loadFeatureDeletionSummary(featureId) {
  if (!configurationFeatureDeleteSummary || !featureId) return null;
  configurationFeatureDeleteSummary.innerHTML =
    '<div class="management-list-empty">加载删除摘要中...</div>';
  const res = await apiFetch(
    `/api/features/${encodeURIComponent(featureId)}/delete-summary`,
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  if (currentFeatureConfigId === featureId) {
    renderFeatureDeletionSummary(data.summary || {});
  }
  return data.summary || null;
}

async function loadFeatureConfigs(options = {}) {
  if (!configurationFeatureList) return;
  const requestSeq = ++featureConfigRequestSeq;
  const preserveSelection = options.preserveSelection !== false;
  configurationFeatureList.innerHTML =
    '<div class="management-list-empty">加载功能包中...</div>';
  try {
    const res = await apiFetch('/api/features/config');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (requestSeq !== featureConfigRequestSeq) return;
    featureConfigItems = Array.isArray(data.features) ? data.features : [];
    const nextSelection =
      preserveSelection &&
      currentFeatureConfigId &&
      featureConfigItems.some((feature) => feature.id === currentFeatureConfigId)
        ? currentFeatureConfigId
        : featureConfigItems[0]?.id || '';
    currentFeatureConfigId = nextSelection;
    renderFeatureConfigList();
    if (configurationMode === 'features') {
      renderFeatureConfigDetail();
      if (currentFeatureConfigId) {
        await loadFeatureDeletionSummary(currentFeatureConfigId);
      }
    }
  } catch (err) {
    console.error('Failed to load feature config:', err);
    configurationFeatureList.innerHTML = `<div class="management-list-empty">加载失败：${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

async function setSelectedFeatureEnabled(enabled) {
  const feature = getSelectedFeatureConfig();
  if (!feature || featureConfigActionBusy) return;
  if (!enabled) {
    const confirmed = await openConfirmDialog(
      `确认仅停用功能包 ${feature.id}？历史数据和 group 会保留。`,
      {
        title: '仅停用功能包',
        confirmText: '仅停用',
        cancelText: '取消',
      },
    );
    if (!confirmed) return;
  }
  featureConfigActionBusy = true;
  renderFeatureConfigDetail();
  try {
    const action = enabled ? 'enable' : 'disable';
    const res = await apiFetch(
      `/api/features/${encodeURIComponent(feature.id)}/${action}`,
      { method: 'POST' },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showToast(enabled ? '功能包已启用' : '功能包已停用', 1800);
    await loadEnabledFeatures();
    await loadFeatureConfigs({ preserveSelection: true });
  } catch (err) {
    showToast(
      `操作失败：${err instanceof Error ? err.message : String(err)}`,
      2600,
    );
  } finally {
    featureConfigActionBusy = false;
    renderFeatureConfigDetail();
  }
}

function formatFeatureDeletionConfirmMessage(feature, summary) {
  const counts = summary?.counts || {};
  return [
    `功能包：${feature.id}`,
    `Groups：${counts.groups || 0}`,
    `Traces：${counts.agent_queries || 0}`,
    `Projection Tables：${counts.feature_projection_tables || 0}`,
    `Runtime Paths：${Array.isArray(summary?.paths) ? summary.paths.length : 0}`,
  ].join('\n');
}

async function deleteSelectedFeatureData() {
  const feature = getSelectedFeatureConfig();
  if (!feature || featureConfigActionBusy) return;
  let summary;
  try {
    summary = await loadFeatureDeletionSummary(feature.id);
  } catch (err) {
    showToast(
      `删除摘要加载失败：${err instanceof Error ? err.message : String(err)}`,
      2600,
    );
    return;
  }
  const reviewed = await openConfirmDialog(
    formatFeatureDeletionConfirmMessage(feature, summary),
    {
      title: '停用并删除摘要',
      confirmText: '继续',
      cancelText: '取消',
      confirmButtonClassName: 'btn-primary',
    },
  );
  if (!reviewed) return;
  const confirmed = await openConfirmDialog(
    `二次确认删除功能包 ${feature.id} 的历史数据、独占 group 和运行目录。`,
    {
      title: '确认删除功能包数据',
      confirmText: '停用并删除',
      cancelText: '取消',
      confirmButtonClassName: 'btn-primary',
    },
  );
  if (!confirmed) return;

  featureConfigActionBusy = true;
  renderFeatureConfigDetail();
  try {
    const res = await apiFetch(
      `/api/features/${encodeURIComponent(feature.id)}/delete-data`,
      {
        method: 'POST',
        body: JSON.stringify({ confirm: true }),
      },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showToast('功能包数据已删除', 2200);
    await loadEnabledFeatures();
    await loadFeatureConfigs({ preserveSelection: true });
  } catch (err) {
    showToast(
      `删除失败：${err instanceof Error ? err.message : String(err)}`,
      3200,
    );
    await loadFeatureDeletionSummary(feature.id).catch(() => undefined);
  } finally {
    featureConfigActionBusy = false;
    renderFeatureConfigDetail();
  }
}

function handleConfigRealtimeEvent(event) {
  if (!event || event.type !== 'services_updated') return;
  if (
    activePrimaryNavKey === 'configuration' &&
    !serviceConfigDirty &&
    !serviceConfigSaving
  ) {
    loadServiceConfigs({ preserveSelection: true });
  }
}

// Auto-start on page load
initTakeCopterCursor();
initChatBgParticleNudge();
bindNotificationClickHandler();
bindNotificationPermissionPrimer();
window.addEventListener('focus', clearCurrentGroupUnreadIfForeground);
document.addEventListener(
  'visibilitychange',
  clearCurrentGroupUnreadIfForeground,
);
connectWS();
loadGroups();
loadEnabledFeatures();

// --- Event listeners ---
if (primaryNav) {
  primaryNav.addEventListener('scroll', () => {
    primaryNav.classList.add('is-scrolling');
    if (primaryNavScrollTimer) clearTimeout(primaryNavScrollTimer);
    primaryNavScrollTimer = setTimeout(() => {
      primaryNav.classList.remove('is-scrolling');
      primaryNavScrollTimer = null;
    }, 700);
  });

  if (componentManagementNavToggle) {
    componentManagementNavToggle.addEventListener('click', () => {
      setComponentManagementNavExpanded(!componentManagementNavExpanded);
    });
  }

  if (todayPlanVisible) {
    syncPrimaryNavActiveState();
    applyScreenVisibility();
    loadTodayPlanOverview({ forceOpenToday: true, showEmptyWhenNoToday: true });
  } else {
    setPrimaryNav(activePrimaryNavKey);
  }
}
if (
  window.icarusApp &&
  typeof window.icarusApp.onCyclePrimaryNav === 'function'
) {
  window.icarusApp.onCyclePrimaryNav(() => {
    cyclePrimaryNav(1);
  });
}
if (
  window.icarusApp &&
  typeof window.icarusApp.onToggleTodayPlan === 'function'
) {
  window.icarusApp.onToggleTodayPlan(() => {
    toggleTodayPlanScreen();
  });
}
if (
  window.icarusApp &&
  typeof window.icarusApp.onOpenWorkstationTarget === 'function'
) {
  window.icarusApp.onOpenWorkstationTarget(({ url }) => {
    if (typeof url !== 'string' || !url) return;
    if (!openWorkstationTargetUrl(url)) {
      window.open(url, '_blank');
    }
  });
}
primaryNavItems.forEach((item) => {
  item.addEventListener('click', () => {
    const navKey = item.getAttribute('data-nav-key') || '';
    setPrimaryNav(navKey);
  });
});
if (assistantRefreshBtn) {
  assistantRefreshBtn.addEventListener('click', () => {
    loadAssistantState();
  });
}
if (assistantScanBtn) {
  assistantScanBtn.addEventListener('click', () => {
    runAssistantScan();
  });
}
if (assistantClearDataBtn) {
  assistantClearDataBtn.addEventListener('click', () => {
    clearAssistantData();
  });
}
if (assistantEnabledToggle) {
  assistantEnabledToggle.addEventListener('change', () => {
    updateAssistantSettingsPatch({ enabled: assistantEnabledToggle.checked });
  });
}
if (assistantLevelSelect) {
  assistantLevelSelect.addEventListener('change', () => {
    updateAssistantSettingsPatch({
      proactiveLevel: assistantLevelSelect.value,
    });
  });
}
if (assistantScanIntervalInput) {
  assistantScanIntervalInput.addEventListener('input', () => {
    scheduleAssistantScanIntervalSave();
  });
  assistantScanIntervalInput.addEventListener('change', () => {
    if (assistantScanIntervalSaveTimer) {
      clearTimeout(assistantScanIntervalSaveTimer);
      assistantScanIntervalSaveTimer = null;
    }
    updateAssistantSettingsPatch({
      scanIntervalMinutes: Number(assistantScanIntervalInput.value) || 10,
    });
  });
}
if (assistantAutostartToggle) {
  assistantAutostartToggle.addEventListener('change', () => {
    updateAssistantSettingsPatch({
      desktopAssistant: { autostart: assistantAutostartToggle.checked },
    });
  });
}
if (assistantAlwaysOnTopToggle) {
  assistantAlwaysOnTopToggle.addEventListener('change', () => {
    updateAssistantSettingsPatch({
      desktopAssistant: { alwaysOnTop: assistantAlwaysOnTopToggle.checked },
    });
  });
}
if (assistantMovementToggle) {
  assistantMovementToggle.addEventListener('change', () => {
    updateAssistantSettingsPatch({
      desktopAssistant: { allowMovement: assistantMovementToggle.checked },
    });
  });
}
if (assistantEvolutionEnabledToggle) {
  assistantEvolutionEnabledToggle.addEventListener('change', () => {
    updateAssistantSettingsPatch({
      evolution: { enabled: assistantEvolutionEnabledToggle.checked },
    });
  });
}
if (assistantEvolutionAutoImplementToggle) {
  assistantEvolutionAutoImplementToggle.addEventListener('change', () => {
    updateAssistantSettingsPatch({
      evolution: {
        autoImplementEnabled: assistantEvolutionAutoImplementToggle.checked,
      },
    });
  });
}
if (assistantEvolutionAutoAdoptToggle) {
  assistantEvolutionAutoAdoptToggle.addEventListener('change', () => {
    updateAssistantSettingsPatch({
      evolution: {
        autoAdoptEnabled: assistantEvolutionAutoAdoptToggle.checked,
      },
    });
  });
}
if (assistantEvolutionScanIntervalInput) {
  assistantEvolutionScanIntervalInput.addEventListener('input', () => {
    scheduleAssistantEvolutionScanIntervalSave();
  });
  assistantEvolutionScanIntervalInput.addEventListener('change', () => {
    if (assistantEvolutionScanIntervalSaveTimer) {
      clearTimeout(assistantEvolutionScanIntervalSaveTimer);
      assistantEvolutionScanIntervalSaveTimer = null;
    }
    updateAssistantSettingsPatch({
      evolution: {
        scanIntervalMinutes:
          Number(assistantEvolutionScanIntervalInput.value) || 60,
      },
    });
  });
}
if (assistantEvolutionTriggerBtn) {
  assistantEvolutionTriggerBtn.addEventListener('click', async () => {
    await triggerAssistantEvolutionTick(assistantEvolutionTriggerBtn);
  });
}
if (todayPlanRefreshBtn) {
  todayPlanRefreshBtn.addEventListener('click', async () => {
    await loadTodayPlanOverview({ forceOpenToday: !currentTodayPlanId });
  });
}
if (todayPlanViewHistoryBtn) {
  todayPlanViewHistoryBtn.addEventListener('click', () => {
    openTodayPlanHistoryModal('view');
  });
}
if (todayPlanContinuePlanBtn) {
  todayPlanContinuePlanBtn.addEventListener('click', () => {
    openTodayPlanHistoryModal('continue');
  });
}
if (todayPlanCreateTodayBtn) {
  todayPlanCreateTodayBtn.addEventListener('click', async () => {
    await openOrCreateTodayPlanEntry();
  });
}
if (todayPlanEmptyCreateBtn) {
  todayPlanEmptyCreateBtn.addEventListener('click', async () => {
    await openOrCreateTodayPlanEntry();
  });
}
if (todayPlanEmptyContinueBtn) {
  todayPlanEmptyContinueBtn.addEventListener('click', () => {
    openTodayPlanHistoryModal('continue');
  });
}
if (todayPlanAddItemBtn) {
  todayPlanAddItemBtn.addEventListener('click', async () => {
    await createTodayPlanItemEntry();
  });
}
if (todayPlanSendMailBtn) {
  todayPlanSendMailBtn.addEventListener('click', async () => {
    await sendTodayPlanMail();
  });
}
if (todayPlanCompleteBtn) {
  todayPlanCompleteBtn.addEventListener('click', async () => {
    await completeCurrentTodayPlan();
  });
}
if (todayPlanCommitCloseBtn) {
  todayPlanCommitCloseBtn.addEventListener('click', () => {
    closeTodayPlanCommitDialog();
  });
}
if (todayPlanCommitMask) {
  todayPlanCommitMask.addEventListener('click', () => {
    closeTodayPlanCommitDialog();
  });
}
if (todayPlanHistoryCloseBtn) {
  todayPlanHistoryCloseBtn.addEventListener('click', () => {
    closeTodayPlanHistoryModal();
  });
}
if (todayPlanHistoryMask) {
  todayPlanHistoryMask.addEventListener('click', () => {
    closeTodayPlanHistoryModal();
  });
}

if (configurationServiceRefreshBtn) {
  configurationServiceRefreshBtn.addEventListener('click', async () => {
    await Promise.all([
      loadServiceConfigs({ preserveSelection: true }),
      loadFeatureConfigs({ preserveSelection: true }),
    ]);
  });
}
if (configurationServiceAddBtn) {
  configurationServiceAddBtn.addEventListener('click', async () => {
    serviceConfigListExpanded = true;
    renderServiceConfigList();
    await createServiceConfig();
  });
}
if (configurationServicesToggle) {
  configurationServicesToggle.addEventListener('click', () => {
    if (configurationMode !== 'services') {
      setConfigurationMode('services');
      renderServiceConfigList();
      renderServiceConfigDetail();
      return;
    }
    serviceConfigListExpanded = !serviceConfigListExpanded;
    renderServiceConfigList();
  });
}
if (configurationFeaturesToggle) {
  configurationFeaturesToggle.addEventListener('click', () => {
    if (configurationMode !== 'features') {
      setConfigurationMode('features');
      renderFeatureConfigList();
      if (!featureConfigItems.length) {
        loadFeatureConfigs({ preserveSelection: true });
      }
      return;
    }
    featureConfigListExpanded = !featureConfigListExpanded;
    renderFeatureConfigList();
  });
}
if (configurationServiceSaveBtn) {
  configurationServiceSaveBtn.addEventListener('click', async () => {
    await saveServiceConfigs();
  });
}
if (configurationServiceDeleteBtn) {
  configurationServiceDeleteBtn.addEventListener('click', async () => {
    await deleteCurrentServiceConfig();
  });
}
if (configurationServiceNameInput) {
  configurationServiceNameInput.addEventListener('change', () => {
    renameServiceConfigInDraft(configurationServiceNameInput.value || '');
  });
  configurationServiceNameInput.addEventListener('input', () => {
    updateServiceConfigDirty(true);
  });
}
configurationServiceFieldInputs.forEach((input) => {
  input.addEventListener('input', () => {
    syncServiceJsonFromForm(true);
  });
  input.addEventListener('change', () => {
    syncServiceJsonFromForm(true);
  });
});
if (configurationServiceJsonEditor) {
  configurationServiceJsonEditor.addEventListener('input', () => {
    updateServiceConfigDirty(true);
  });
}
if (configurationServiceJsonFormatBtn) {
  configurationServiceJsonFormatBtn.addEventListener('click', () => {
    if (!configurationServiceJsonEditor) return;
    try {
      configurationServiceJsonEditor.value = stringifyPrettyJson(
        JSON.parse(configurationServiceJsonEditor.value || '{}'),
      );
      updateServiceConfigSaveStatus(
        serviceConfigDirty ? '有未保存修改' : '已格式化',
        serviceConfigDirty ? 'dirty' : 'saved',
      );
    } catch (err) {
      updateServiceConfigSaveStatus(
        `JSON 格式错误：${err instanceof Error ? err.message : '无法解析'}`,
        'error',
      );
    }
  });
}
if (configurationServiceJsonApplyBtn) {
  configurationServiceJsonApplyBtn.addEventListener('click', () => {
    updateServiceConfigFromJson(true);
  });
}
if (configurationFeatureToggleBtn) {
  configurationFeatureToggleBtn.addEventListener('click', async () => {
    const feature = getSelectedFeatureConfig();
    if (!feature) return;
    await setSelectedFeatureEnabled(!feature.enabled);
  });
}
if (configurationFeatureDeleteDataBtn) {
  configurationFeatureDeleteDataBtn.addEventListener('click', async () => {
    await deleteSelectedFeatureData();
  });
}

if (memorySearchBtn) {
  memorySearchBtn.addEventListener('click', () => {
    loadMemories(memorySearchInput?.value || '');
  });
}
if (memoryDoctorBtn) {
  memoryDoctorBtn.addEventListener('click', () => {
    runDoctor(7);
  });
}
if (memoryMetricsBtn) {
  memoryMetricsBtn.addEventListener('click', () => {
    showMemoryMetrics(24);
  });
}
if (memoryDoctorCloseBtn) {
  memoryDoctorCloseBtn.addEventListener('click', () => {
    closeDoctorPanel();
  });
}
if (memoryMetricsCloseBtn) {
  memoryMetricsCloseBtn.addEventListener('click', () => {
    closeMemoryMetricsModal();
  });
}
if (memoryCreateBtn) {
  memoryCreateBtn.addEventListener('click', () => {
    openCreateMemoryEditor();
  });
}
if (traceMonitorRefreshBtn) {
  traceMonitorRefreshBtn.addEventListener('click', () => {
    loadTraceMonitorData({ force: true });
  });
}
if (traceMonitorClearHistoryBtn) {
  traceMonitorClearHistoryBtn.addEventListener('click', () => {
    clearAllTraceHistory();
  });
}
if (traceMonitorFilterToggle) {
  traceMonitorFilterToggle.addEventListener('click', () => {
    const expanded =
      traceMonitorFilterToggle.getAttribute('aria-expanded') === 'true';
    setTraceMonitorFiltersCollapsed(expanded);
  });
}
[
  traceMonitorStatusFilter,
  traceMonitorSourceFilter,
  traceMonitorFilesFilter,
  traceMonitorErrorsFilter,
].forEach((control) => {
  if (!control) return;
  control.addEventListener('change', () => {
    applyTraceMonitorFilters();
  });
});
[
  traceMonitorServiceFilter,
  traceMonitorFailureFilter,
  traceMonitorRoleFilter,
].forEach((control) => {
  if (!control) return;
  control.addEventListener('input', () => {
    scheduleTraceMonitorFilterApply();
  });
  control.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyTraceMonitorFilters();
    }
  });
});
if (traceMonitorList) {
  traceMonitorList.addEventListener('scroll', () => {
    if (
      activePrimaryNavKey !== 'trace-monitor' ||
      activeTraceMonitorScope !== 'history'
    )
      return;
    if (traceMonitorHistoryLoading || !traceMonitorHistoryHasMore) return;
    const threshold = 80;
    const distanceToBottom =
      traceMonitorList.scrollHeight -
      traceMonitorList.scrollTop -
      traceMonitorList.clientHeight;
    if (distanceToBottom <= threshold) {
      loadMoreTraceHistory();
    }
  });
}
traceMonitorScopeBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    const scope = btn.getAttribute('data-trace-scope') || 'active';
    setTraceMonitorScope(scope);
  });
});
if (memoryRefreshBtn) {
  memoryRefreshBtn.addEventListener('click', () => {
    loadMemories(memorySearchInput?.value || '');
  });
}
if (memorySaveBtn) {
  memorySaveBtn.addEventListener('click', () => {
    saveMemoryEditor();
  });
}
if (memoryCancelBtn) {
  memoryCancelBtn.addEventListener('click', () => {
    closeMemoryEditor();
  });
}
if (memorySearchInput) {
  memorySearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      loadMemories(memorySearchInput.value || '');
    }
  });
}
if (memoryStatusFilter) {
  memoryStatusFilter.addEventListener('change', () => {
    memoryStatusFilterValue = memoryStatusFilter.value || 'all';
    renderMemoryList();
  });
}
if (memoryGcDuplicatesBtn) {
  memoryGcDuplicatesBtn.addEventListener('click', () => {
    runGcByMode('duplicates');
  });
}
if (memoryGcStaleBtn) {
  memoryGcStaleBtn.addEventListener('click', () => {
    runGcByMode('stale');
  });
}
if (memoryModalMask) {
  memoryModalMask.addEventListener('click', () => {
    closeMemoryEditor();
    closeDoctorPanel();
    closeMemoryMetricsModal();
  });
}

sidebarCollapse.addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
});
refreshGroupsBtn.addEventListener('click', () => {
  refreshGroupsBtn.classList.add('spinning');
  setTimeout(() => refreshGroupsBtn.classList.remove('spinning'), 700);
  loadGroups();
  if (currentGroupJid) loadMessages();
});
if (resetAllSessionsBtn) {
  resetAllSessionsBtn.addEventListener('click', () => {
    resetAllSessions();
  });
}
openSchedulersBtn.addEventListener('click', () => {
  if (schedulersPanel.classList.contains('open')) {
    closeSchedulersPanel();
    return;
  }
  openSchedulersPanel();
});
deleteAllSchedulersBtn.addEventListener('click', deleteAllSchedulers);
closeSchedulersBtn.addEventListener('click', () => {
  closeSchedulersPanel();
});
if (openKnowledgeJobsBtn) {
  openKnowledgeJobsBtn.addEventListener('click', () => {
    if (knowledgeJobsPanel?.classList.contains('open')) {
      knowledgeJobsPanel.classList.remove('open');
      return;
    }
    openKnowledgeJobsPanel();
  });
}
if (knowledgeJobsDeleteFinishedBtn) {
  knowledgeJobsDeleteFinishedBtn.addEventListener('click', () => {
    void deleteFinishedKnowledgeJobs();
  });
}
if (closeKnowledgeJobsBtn) {
  closeKnowledgeJobsBtn.addEventListener('click', () => {
    knowledgeJobsPanel?.classList.remove('open');
  });
}
openAgentStatusBtn.addEventListener('click', () => {
  if (agentStatusPanel.classList.contains('open')) {
    closeAgentStatusPanel();
    return;
  }
  openAgentStatusPanel();
});
closeAgentStatusBtn.addEventListener('click', () => {
  closeAgentStatusPanel();
});
sendBtn.addEventListener('click', () => {
  sendMessage(messageInput.value);
});
messageInput.addEventListener('keydown', (e) => {
  // Command palette navigation
  if (commandPalette.classList.contains('visible')) {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      navigateCommandPalette(-1);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      navigateCommandPalette(1);
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (cmdPaletteIndex >= 0) {
        e.preventDefault();
        selectCommandPaletteItem();
        return;
      }
    }
    if (e.key === 'Escape') {
      hideCommandPalette();
      return;
    }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage(messageInput.value);
  }

  // Shift+Enter: insert newline, auto-continue list if current line is a list
  if (e.key === 'Enter' && e.shiftKey) {
    e.preventDefault();
    const ta = messageInput;
    const pos = ta.selectionStart;
    const before = ta.value.substring(0, pos);
    const after = ta.value.substring(pos);
    const lineStart = before.lastIndexOf('\n') + 1;
    const lineContent = before.substring(lineStart);

    const olMatch = lineContent.match(/^(\d+)\.\s/);
    const ulMatch = lineContent.match(/^-\s/);

    if (olMatch) {
      const nextNum = parseInt(olMatch[1]) + 1;
      ta.value = before + '\n' + nextNum + '. ' + after;
      ta.selectionStart = ta.selectionEnd =
        pos + 1 + String(nextNum).length + 2;
      autoResizeInput();
    } else if (ulMatch) {
      ta.value = before + '\n- ' + after;
      ta.selectionStart = ta.selectionEnd = pos + 3;
      autoResizeInput();
    } else {
      ta.value = before + '\n' + after;
      ta.selectionStart = ta.selectionEnd = pos + 1;
      autoResizeInput();
    }
  }

  if (e.key === '@') {
    e.preventDefault();
    showMentionPicker();
    return;
  }

  if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    showCommandPalette('');
    return;
  }

  // Cmd+Shift+7 = ordered list, Cmd+Shift+8 = unordered list
  if (e.metaKey && e.shiftKey) {
    if (e.key === '7') {
      e.preventDefault();
      insertListPrefix('1. ');
    } else if (e.key === '8') {
      e.preventDefault();
      insertListPrefix('- ');
    }
  }
});

messageInput.addEventListener('input', () => {
  autoResizeInput();
  if (mentionPickerVisible) hideMentionPicker(false);
  // Command palette trigger
  const val = messageInput.value;
  if (val.startsWith('/') && !val.includes(' ')) {
    showCommandPalette(val);
  } else {
    hideCommandPalette();
  }
});

messageInput.addEventListener('paste', handleComposerPaste);

// Reply preview close
replyPreviewClose.addEventListener('click', clearReplyTo);
pendingFilesClose.addEventListener('click', () => {
  pendingFiles = [];
  pendingFileReferences = [];
  renderPendingFiles();
});

attachBtn.addEventListener('click', () => {
  fileInput.click();
});
document.getElementById('at-btn').addEventListener('click', () => {
  showMentionPicker();
});

document.addEventListener('mousedown', (e) => {
  if (commandPickerVisible && commandPalette) {
    const target = e.target;
    if (
      !(
        commandPalette.contains(target) ||
        (target && target.closest && target.closest('#message-input'))
      )
    ) {
      hideCommandPalette(false);
    }
  }

  if (!mentionPickerVisible || !mentionPicker) return;
  const target = e.target;
  if (mentionPicker.contains(target)) return;
  if (target && target.closest && target.closest('#at-btn')) return;
  hideMentionPicker(false);
});

// Format toolbar - insert list prefix at beginning of current line
function insertListPrefix(prefix) {
  const ta = messageInput;
  const pos = ta.selectionStart;
  const before = ta.value.substring(0, pos);
  const after = ta.value.substring(pos);
  // Find start of current line
  const lineStart = before.lastIndexOf('\n') + 1;
  ta.value =
    before.substring(0, lineStart) +
    prefix +
    before.substring(lineStart) +
    after;
  ta.selectionStart = ta.selectionEnd = lineStart + prefix.length;
  ta.focus();
  autoResizeInput();
}

document.getElementById('format-toggle-btn').addEventListener('click', () => {
  document.getElementById('format-sub-btns').classList.toggle('hidden');
});
document
  .getElementById('fmt-ol-btn')
  .addEventListener('click', () => insertListPrefix('1. '));
document
  .getElementById('fmt-ul-btn')
  .addEventListener('click', () => insertListPrefix('- '));

fileInput.addEventListener('change', () => {
  for (const file of fileInput.files || []) {
    stageFile(file);
  }
  fileInput.value = '';
});
if (knowledgeRefreshBtn) {
  knowledgeRefreshBtn.addEventListener('click', () => {
    loadKnowledgeBaseData({ preserveDetail: true });
  });
}
if (knowledgeClearBtn) {
  knowledgeClearBtn.addEventListener('click', () => {
    void clearKnowledgeWiki();
  });
}
if (knowledgeImportBtn) {
  knowledgeImportBtn.addEventListener('click', () => {
    showKnowledgeImportMenu();
  });
}
if (knowledgeFileInput) {
  knowledgeFileInput.addEventListener('change', () => {
    const files = knowledgeFileInput.files;
    if (files && files.length > 0) {
      void importKnowledgeFiles(files);
    }
    knowledgeFileInput.value = '';
  });
}
if (knowledgeSearchBtn) {
  knowledgeSearchBtn.addEventListener('click', () => {
    void runKnowledgeSearch();
  });
}
if (knowledgeSearchInput) {
  knowledgeSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void runKnowledgeSearch();
    }
  });
}
if (knowledgeMaterialFilter) {
  knowledgeMaterialFilter.value = knowledgeMaterialFilterValue;
  knowledgeMaterialFilter.addEventListener('change', () => {
    knowledgeMaterialFilterValue = knowledgeMaterialFilter.value || 'all';
    renderKnowledgeMaterials();
  });
}
if (knowledgeDraftStatusFilter) {
  knowledgeDraftStatusFilter.value = knowledgeDraftStatusFilterValue;
  knowledgeDraftStatusFilter.addEventListener('change', () => {
    knowledgeDraftStatusFilterValue = knowledgeDraftStatusFilter.value || 'all';
    renderKnowledgeDrafts();
  });
}
if (knowledgeDraftSelectVisibleBtn) {
  knowledgeDraftSelectVisibleBtn.addEventListener('click', () => {
    selectVisibleKnowledgeDrafts();
  });
}
if (knowledgeDraftClearSelectionBtn) {
  knowledgeDraftClearSelectionBtn.addEventListener('click', () => {
    clearKnowledgeDraftSelection();
  });
}
if (knowledgeDraftBulkDeleteBtn) {
  knowledgeDraftBulkDeleteBtn.addEventListener('click', () => {
    void bulkDeleteSelectedKnowledgeDrafts();
  });
}
if (knowledgePageKindFilter) {
  knowledgePageKindFilter.value = knowledgePageKindFilterValue;
  knowledgePageKindFilter.addEventListener('change', () => {
    knowledgePageKindFilterValue = knowledgePageKindFilter.value || 'all';
    renderKnowledgePages();
  });
}
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (currentGroupJid) fileDropZone.classList.remove('hidden');
});
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) fileDropZone.classList.add('hidden');
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  fileDropZone.classList.add('hidden');
  if (!currentGroupJid) return;
  for (const file of e.dataTransfer?.files || []) {
    stageFile(file);
  }
});

// Infinite scroll
messagesEl.addEventListener('scroll', () => {
  if (messagesEl.scrollTop < 100 && hasMoreHistory && !loadingHistory) {
    loadMoreHistory();
  }
});

// Multi-select
selectModeBtn.addEventListener('click', toggleMultiSelectMode);
copySelectedBtn.addEventListener('click', copySelectedMessages);
deleteSelectedBtn.addEventListener('click', deleteSelectedMessages);
cancelSelectBtn.addEventListener('click', exitMultiSelect);
document.addEventListener('keydown', (e) => {
  if (
    (e.metaKey || e.ctrlKey) &&
    !e.shiftKey &&
    !e.altKey &&
    String(e.key || '').toLowerCase() === 'w'
  ) {
    e.preventDefault();
    toggleTodayPlanScreen();
    return;
  }
  if (
    e.key === 'Escape' &&
    todayPlanHistoryModal &&
    !todayPlanHistoryModal.classList.contains('hidden')
  ) {
    e.preventDefault();
    closeTodayPlanHistoryModal();
    return;
  }
  if (e.key === 'Escape' && todayPlanAssociationOverlay) {
    e.preventDefault();
    closeTodayPlanAssociationDialog();
    return;
  }
  if (
    e.key === 'Escape' &&
    todayPlanCommitModal &&
    !todayPlanCommitModal.classList.contains('hidden')
  ) {
    e.preventDefault();
    closeTodayPlanCommitDialog();
    return;
  }
  if (e.key === 'Escape' && schedulersPanel.classList.contains('open')) {
    e.preventDefault();
    closeSchedulersPanel();
    return;
  }
  if (e.key === 'Escape' && agentStatusPanel.classList.contains('open')) {
    e.preventDefault();
    closeAgentStatusPanel();
    return;
  }
  if (e.key === 'Escape' && mentionPickerVisible) {
    hideMentionPicker();
    return;
  }
  if (e.key === 'Escape' && multiSelectMode) {
    exitMultiSelect();
  }
  // Cmd/Ctrl+1 — toggle schedulers
  if ((e.metaKey || e.ctrlKey) && e.key === '1') {
    e.preventDefault();
    if (schedulersPanel.classList.contains('open')) {
      closeSchedulersPanel();
    } else {
      openSchedulersPanel();
    }
    return;
  }
  // Cmd/Ctrl+2 — toggle agent status
  if ((e.metaKey || e.ctrlKey) && e.key === '2') {
    e.preventDefault();
    if (agentStatusPanel.classList.contains('open')) {
      closeAgentStatusPanel();
    } else {
      openAgentStatusPanel();
    }
    return;
  }
});
