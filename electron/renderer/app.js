// electron/renderer/app.js
var ws = null;
var reconnectTimer = null;
var currentGroupJid = "";
var isStandaloneQuickChat = new URLSearchParams(window.location.search).get("quick-chat") === "1";
var browserNotificationPermissionRequested = false;
var groups = [];
var messages = [];
var unreadCounts = {};
var quickChatDraft = "";
var replyToMsg = null;
var hasMoreHistory = true;
var loadingHistory = false;
var cmdPaletteIndex = -1;
var multiSelectMode = false;
var selectedMsgIds = new Set();
var pendingFiles = []; // files staged for upload on next send
var modelSyncTimer = null;
var INITIAL_MESSAGE_LIMIT = 100;
var LIVE_MESSAGE_BUFFER_LIMIT = 250;

var mainScreen = document.getElementById("main-screen");
var workspace = document.getElementById("workspace");
var workbenchScreen = document.getElementById("workbench-screen");
var todayPlanScreen = document.getElementById("today-plan-screen");
var workflowDefinitionsScreen = document.getElementById("workflow-definitions-screen");
var cardsManagementScreen = document.getElementById("cards-management-screen");
var memoryManagementScreen = document.getElementById("memory-management-screen");
var knowledgeManagementScreen = document.getElementById("knowledge-management-screen");
var traceMonitorScreen = document.getElementById("trace-monitor-screen");
var workflowDefinitionList = document.getElementById("workflow-definition-list");
var workflowDefinitionRefreshBtn = document.getElementById("workflow-definition-refresh-btn");
var workflowDefinitionCreateBtn = document.getElementById("workflow-definition-create-btn");
var workflowDefinitionEmpty = document.getElementById("workflow-definition-empty");
var workflowDefinitionDetail = document.getElementById("workflow-definition-detail");
var workflowDefinitionTitle = document.getElementById("workflow-definition-title");
var workflowDefinitionSummary = document.getElementById("workflow-definition-summary");
var workflowDefinitionMeta = document.getElementById("workflow-definition-meta");
var workflowDefinitionPreviewCreateFormBtn = document.getElementById("workflow-definition-preview-create-form-btn");
var workflowDefinitionSaveBtn = document.getElementById("workflow-definition-save-btn");
var workflowDefinitionPublishBtn = document.getElementById("workflow-definition-publish-btn");
var workflowDefinitionVersionSummary = document.getElementById("workflow-definition-version-summary");
var workflowDefinitionVersions = document.getElementById("workflow-definition-versions");
var workflowDefinitionViewModeWrap = document.getElementById("workflow-definition-view-mode");
var workflowDefinitionViewFormBtn = document.getElementById("workflow-definition-view-form-btn");
var workflowDefinitionViewJsonBtn = document.getElementById("workflow-definition-view-json-btn");
var workflowDefinitionViewGraphBtn = document.getElementById("workflow-definition-view-graph-btn");
var workflowDefinitionEditorGrid = document.getElementById("workflow-definition-editor-grid");
var workflowDefinitionFormPanel = document.getElementById("workflow-definition-form-panel");
var workflowDefinitionEditorNote = document.getElementById("workflow-definition-editor-note");
var workflowDefinitionJsonPanel = document.getElementById("workflow-definition-json-panel");
var workflowDefinitionJsonNote = document.getElementById("workflow-definition-json-note");
var workflowDefinitionJsonEditor = document.getElementById("workflow-definition-json-editor");
var workflowDefinitionBundleLabelInput = document.getElementById("workflow-definition-bundle-label");
var workflowDefinitionKeyInput = document.getElementById("workflow-definition-key");
var workflowDefinitionNameInput = document.getElementById("workflow-definition-name");
var workflowDefinitionVersionInput = document.getElementById("workflow-definition-version");
var workflowDefinitionBundleDescriptionInput = document.getElementById("workflow-definition-bundle-description");
var workflowDefinitionDescriptionInput = document.getElementById("workflow-definition-description");
var workflowDefinitionRoleAddBtn = document.getElementById("workflow-definition-role-add-btn");
var workflowDefinitionRolesInput = document.getElementById("workflow-definition-roles");
var workflowDefinitionRoleList = document.getElementById("workflow-definition-role-list");
var workflowDefinitionRoleInspector = document.getElementById("workflow-definition-role-inspector");
var workflowDefinitionEntryPointAddBtn = document.getElementById("workflow-definition-entry-point-add-btn");
var workflowDefinitionEntryPointsInput = document.getElementById("workflow-definition-entry-points");
var workflowDefinitionEntryPointList = document.getElementById("workflow-definition-entry-point-list");
var workflowDefinitionEntryPointInspector = document.getElementById("workflow-definition-entry-point-inspector");
var workflowDefinitionStatesInput = document.getElementById("workflow-definition-states");
var workflowDefinitionStateAddBtn = document.getElementById("workflow-definition-state-add-btn");
var workflowDefinitionStateList = document.getElementById("workflow-definition-state-list");
var workflowDefinitionStateInspector = document.getElementById("workflow-definition-state-inspector");
var workflowDefinitionStatusLabelAddBtn = document.getElementById("workflow-definition-status-label-add-btn");
var workflowDefinitionStatusLabelsInput = document.getElementById("workflow-definition-status-labels");
var workflowDefinitionStatusLabelList = document.getElementById("workflow-definition-status-label-list");
var workflowDefinitionStatusLabelInspector = document.getElementById("workflow-definition-status-label-inspector");
var workflowDefinitionCreateFormFieldAddBtn = document.getElementById("workflow-definition-create-form-field-add-btn");
var workflowDefinitionCreateFormFieldList = document.getElementById("workflow-definition-create-form-field-list");
var workflowDefinitionCreateFormInspector = document.getElementById("workflow-definition-create-form-inspector");
var workflowDefinitionMetadataInput = document.getElementById("workflow-definition-metadata");
var workflowDefinitionValidationPanel = document.getElementById("workflow-definition-validation-panel");
var workflowDefinitionSidepanels = document.getElementById("workflow-definition-sidepanels");
var workflowDefinitionGraphPanel = document.getElementById("workflow-definition-graph-panel");
var workflowDefinitionValidation = document.getElementById("workflow-definition-validation");
var workflowDefinitionGraph = document.getElementById("workflow-definition-graph");
var workflowDefinitionDiffSummary = document.getElementById("workflow-definition-diff-summary");
var workflowDefinitionDiff = document.getElementById("workflow-definition-diff");
var workflowDefinitionDiffModal = document.getElementById("workflow-definition-diff-modal");
var workflowDefinitionDiffCloseBtn = document.getElementById("workflow-definition-diff-close-btn");
var cardsManagementList = document.getElementById("cards-management-list");
var cardsManagementRefreshBtn = document.getElementById("cards-management-refresh-btn");
var cardsManagementCreateBtn = document.getElementById("cards-management-create-btn");
var cardsManagementEmpty = document.getElementById("cards-management-empty");
var cardsManagementDetail = document.getElementById("cards-management-detail");
var cardsManagementTitle = document.getElementById("cards-management-title");
var cardsManagementSummary = document.getElementById("cards-management-summary");
var cardsManagementMeta = document.getElementById("cards-management-meta");
var cardsManagementSaveBtn = document.getElementById("cards-management-save-btn");
var cardsManagementCancelBtn = document.getElementById("cards-management-cancel-btn");
var cardsManagementWorkflowTypeInput = document.getElementById("cards-management-workflow-type");
var cardsManagementCardKeyInput = document.getElementById("cards-management-card-key");
var cardsManagementPatternInput = document.getElementById("cards-management-pattern");
var cardsManagementHeaderColorInput = document.getElementById("cards-management-header-color");
var cardsManagementHeaderTitleInput = document.getElementById("cards-management-header-title");
var cardsManagementBodyTemplateInput = document.getElementById("cards-management-body-template");
var cardsManagementActionAddBtn = document.getElementById("cards-management-action-add-btn");
var cardsManagementActions = document.getElementById("cards-management-actions");
var cardsManagementFormToggleBtn = document.getElementById("cards-management-form-toggle-btn");
var cardsManagementFormFieldAddBtn = document.getElementById("cards-management-form-field-add-btn");
var cardsManagementForm = document.getElementById("cards-management-form");
var cardsManagementFormNameInput = document.getElementById("cards-management-form-name");
var cardsManagementFormSubmitIdInput = document.getElementById("cards-management-form-submit-id");
var cardsManagementFormSubmitLabelInput = document.getElementById("cards-management-form-submit-label");
var cardsManagementFormSubmitTypeInput = document.getElementById("cards-management-form-submit-type");
var cardsManagementFormFields = document.getElementById("cards-management-form-fields");
var cardsManagementSectionAddBtn = document.getElementById("cards-management-section-add-btn");
var cardsManagementSections = document.getElementById("cards-management-sections");
var cardsManagementPreviewPreset = document.getElementById("cards-management-preview-preset");
var cardsManagementPreviewData = document.getElementById("cards-management-preview-data");
var cardsManagementPreview = document.getElementById("cards-management-preview");
var cardsManagementReferences = document.getElementById("cards-management-references");
var memoryGroupsList = document.getElementById("memory-groups-list");
var memoryGroupTitle = document.getElementById("memory-group-title");
var memoryGroupFolder = document.getElementById("memory-group-folder");
var memoryGroupSummary = document.getElementById("memory-group-summary");
var memorySearchInput = document.getElementById("memory-search-input");
var memoryStatusFilter = document.getElementById("memory-status-filter");
var memoryDoctorBtn = document.getElementById("memory-doctor-btn");
var memoryMetricsBtn = document.getElementById("memory-metrics-btn");
var memoryCreateBtn = document.getElementById("memory-create-btn");
var memorySearchBtn = document.getElementById("memory-search-btn");
var memoryRefreshBtn = document.getElementById("memory-refresh-btn");
var memoryList = document.getElementById("memory-list");
var memoryEmpty = document.getElementById("memory-empty");
var memoryEditor = document.getElementById("memory-editor");
var memoryEditorTitle = document.getElementById("memory-editor-title");
var memoryLayerSelect = document.getElementById("memory-layer-select");
var memoryTypeSelect = document.getElementById("memory-type-select");
var memoryStatusSelect = document.getElementById("memory-status-select");
var memoryContentInput = document.getElementById("memory-content-input");
var memorySaveBtn = document.getElementById("memory-save-btn");
var memoryCancelBtn = document.getElementById("memory-cancel-btn");
var memoryDoctorPanel = document.getElementById("memory-doctor-panel");
var memoryDoctorSummary = document.getElementById("memory-doctor-summary");
var memoryDoctorLog = document.getElementById("memory-doctor-log");
var memoryDoctorCloseBtn = document.getElementById("memory-doctor-close-btn");
var memoryDuplicatesList = document.getElementById("memory-duplicates-list");
var memoryStaleList = document.getElementById("memory-stale-list");
var memoryConflictsList = document.getElementById("memory-conflicts-list");
var memoryGcDuplicatesBtn = document.getElementById("memory-gc-duplicates-btn");
var memoryGcStaleBtn = document.getElementById("memory-gc-stale-btn");
var memoryModalMask = document.getElementById("memory-modal-mask");
var memoryMetricsModal = document.getElementById("memory-metrics-modal");
var memoryMetricsWindow = document.getElementById("memory-metrics-window");
var memoryMetricsTotal = document.getElementById("memory-metrics-total");
var memoryMetricsList = document.getElementById("memory-metrics-list");
var memoryMetricsCloseBtn = document.getElementById("memory-metrics-close-btn");
var knowledgeMaterialList = document.getElementById("knowledge-material-list");
var knowledgeDraftList = document.getElementById("knowledge-draft-list");
var knowledgePageList = document.getElementById("knowledge-page-list");
var knowledgeJobList = document.getElementById("knowledge-job-list");
var knowledgeJobsPanel = document.getElementById("knowledge-jobs-panel");
var openKnowledgeJobsBtn = document.getElementById("open-knowledge-jobs");
var closeKnowledgeJobsBtn = document.getElementById("close-knowledge-jobs");
var knowledgeJobsTriggerMeta = document.getElementById("knowledge-jobs-trigger-meta");
var knowledgeJobsDeleteFinishedBtn = document.getElementById("knowledge-jobs-delete-finished-btn");
var knowledgeImportBtn = document.getElementById("knowledge-import-btn");
var knowledgeRefreshBtn = document.getElementById("knowledge-refresh-btn");
var knowledgeClearBtn = document.getElementById("knowledge-clear-btn");
var knowledgeSearchInput = document.getElementById("knowledge-search-input");
var knowledgeSearchBtn = document.getElementById("knowledge-search-btn");
var knowledgeDetailEmpty = document.getElementById("knowledge-detail-empty");
var knowledgeDetail = document.getElementById("knowledge-detail");
var knowledgeDetailTitle = document.getElementById("knowledge-detail-title");
var knowledgeDetailMeta = document.getElementById("knowledge-detail-meta");
var knowledgeDetailActions = document.getElementById("knowledge-detail-actions");
var knowledgeDetailContent = document.getElementById("knowledge-detail-content");
var knowledgeFileInput = document.getElementById("knowledge-file-input");
var knowledgeSelectionSummary = document.getElementById("knowledge-selection-summary");
var knowledgeMaterialFilter = document.getElementById("knowledge-material-filter");
var knowledgeDraftStatusFilter = document.getElementById("knowledge-draft-status-filter");
var knowledgeDraftSelectionSummary = document.getElementById("knowledge-draft-selection-summary");
var knowledgeDraftSelectVisibleBtn = document.getElementById("knowledge-draft-select-visible-btn");
var knowledgeDraftClearSelectionBtn = document.getElementById("knowledge-draft-clear-selection-btn");
var knowledgeDraftBulkDeleteBtn = document.getElementById("knowledge-draft-bulk-delete-btn");
var knowledgePageKindFilter = document.getElementById("knowledge-page-kind-filter");
var sidebar = document.getElementById("sidebar");
var sidebarCollapse = document.getElementById("sidebar-collapse");
var primaryNav = document.getElementById("primary-nav");
var primaryNavItems = Array.from(document.querySelectorAll(".primary-nav-item"));
var groupsList = document.getElementById("groups-list");
var refreshGroupsBtn = document.getElementById("refresh-groups");
var resetAllSessionsBtn = document.getElementById("reset-all-sessions");
var schedulersPanel = document.getElementById("schedulers-panel");
var schedulersList = document.getElementById("schedulers-list");
var openSchedulersBtn = document.getElementById("open-schedulers");
var closeSchedulersBtn = document.getElementById("close-schedulers");
var deleteAllSchedulersBtn = document.getElementById("delete-all-schedulers");
var agentStatusPanel = document.getElementById("agent-status-panel");
var agentStatusList = document.getElementById("agent-status-list");
var openAgentStatusBtn = document.getElementById("open-agent-status");
var closeAgentStatusBtn = document.getElementById("close-agent-status");
var stoppingAgentIds = new Set();
var stoppingKnowledgeJobIds = new Set();
var traceMonitorList = document.getElementById("trace-monitor-list");
var traceMonitorRefreshBtn = document.getElementById("trace-monitor-refresh-btn");
var traceMonitorClearHistoryBtn = document.getElementById("trace-monitor-clear-history-btn");
var traceMonitorScopeBtns = Array.from(document.querySelectorAll(".trace-monitor-scope-btn"));
var traceMonitorDetailEmpty = document.getElementById("trace-monitor-detail-empty");
var traceMonitorDetail = document.getElementById("trace-monitor-detail");
var traceMonitorTitle = document.getElementById("trace-monitor-title");
var traceMonitorMeta = document.getElementById("trace-monitor-meta");
var traceMonitorSummary = document.getElementById("trace-monitor-summary");
var traceMonitorTimeline = document.getElementById("trace-monitor-timeline");
var knowledgeImportMenu = null;
var knowledgeImportMenuCloseHandler = null;
var workbenchSidebar = document.getElementById("workbench-sidebar");
var workbenchSidebarCollapse = document.getElementById("workbench-sidebar-collapse");
var workbenchTaskList = document.getElementById("workbench-task-list");
var workbenchRefreshBtn = document.getElementById("workbench-refresh-btn");
var workbenchCreateTaskBtn = document.getElementById("workbench-create-task-btn");
var workbenchDeleteAllBtn = document.getElementById("workbench-delete-all-btn");
var workbenchDetailEmpty = document.getElementById("workbench-detail-empty");
var workbenchTaskDetail = document.getElementById("workbench-task-detail");
var workbenchTaskTitle = document.getElementById("workbench-task-title");
var workbenchTaskMeta = document.getElementById("workbench-task-meta");
var workbenchTaskActions = document.getElementById("workbench-task-actions");
var workbenchSubtasks = document.getElementById("workbench-subtasks");
var workbenchActionItemsPanel = document.getElementById("workbench-action-items-panel");
var workbenchActionItems = document.getElementById("workbench-action-items");
var workbenchArtifacts = document.getElementById("workbench-artifacts");
var workbenchRequirementOrigin = document.getElementById("workbench-requirement-origin");
var workbenchAssets = document.getElementById("workbench-assets");
var workbenchAddLinkBtn = document.getElementById("workbench-add-link-btn");
var workbenchAddFileBtn = document.getElementById("workbench-add-file-btn");
var workbenchComments = document.getElementById("workbench-comments");
var workbenchCommentInput = document.getElementById("workbench-comment-input");
var workbenchCommentSubmit = document.getElementById("workbench-comment-submit");
var workbenchTimeline = document.getElementById("workbench-timeline");
var todayPlanRefreshBtn = document.getElementById("today-plan-refresh-btn");
var todayPlanViewHistoryBtn = document.getElementById("today-plan-view-history-btn");
var todayPlanContinuePlanBtn = document.getElementById("today-plan-continue-plan-btn");
var todayPlanCreateTodayBtn = document.getElementById("today-plan-create-today-btn");
var todayPlanTitleEl = document.getElementById("today-plan-title");
var todayPlanPlanStatus = document.getElementById("today-plan-plan-status");
var todayPlanSubtitleEl = document.getElementById("today-plan-subtitle");
var todayPlanHeroMeta = document.getElementById("today-plan-hero-meta");
var todayPlanOverviewSummary = document.getElementById("today-plan-overview-summary");
var todayPlanSectionMeta = document.getElementById("today-plan-section-meta");
var todayPlanAddItemBtn = document.getElementById("today-plan-add-item-btn");
var todayPlanSendMailBtn = document.getElementById("today-plan-send-mail-btn");
var todayPlanCompleteBtn = document.getElementById("today-plan-complete-btn");
var todayPlanEmpty = document.getElementById("today-plan-empty");
var todayPlanEmptyCreateBtn = document.getElementById("today-plan-empty-create-btn");
var todayPlanEmptyContinueBtn = document.getElementById("today-plan-empty-continue-btn");
var todayPlanContent = document.getElementById("today-plan-content");
var todayPlanItems = document.getElementById("today-plan-items");
var todayPlanHistoryModal = document.getElementById("today-plan-history-modal");
var todayPlanHistoryMask = document.getElementById("today-plan-history-mask");
var todayPlanHistoryCloseBtn = document.getElementById("today-plan-history-close-btn");
var todayPlanHistoryModalTitle = document.getElementById("today-plan-history-modal-title");
var todayPlanHistoryModalSubtitle = document.getElementById("today-plan-history-modal-subtitle");
var todayPlanHistoryList = document.getElementById("today-plan-history-list");
var todayPlanCommitModal = document.getElementById("today-plan-commit-modal");
var todayPlanCommitMask = document.getElementById("today-plan-commit-mask");
var todayPlanCommitCloseBtn = document.getElementById("today-plan-commit-close-btn");
var todayPlanCommitTitle = document.getElementById("today-plan-commit-title");
var todayPlanCommitMeta = document.getElementById("today-plan-commit-meta");
var todayPlanCommitDiff = document.getElementById("today-plan-commit-diff");
var connectionStatus = document.getElementById("connection-status");
var chatHeader = document.getElementById("chat-header");
var chatGroupName = document.getElementById("chat-group-name");
var chatGroupFolder = document.getElementById("chat-group-folder");
var messagesEl = document.getElementById("messages");
var messagesEmpty = document.getElementById("messages-empty");
var typingIndicator = document.getElementById("typing-indicator");
var inputArea = document.getElementById("input-area");
var messageInput = document.getElementById("message-input");
var sendBtn = document.getElementById("send-btn");
var quickChatOverlay = document.getElementById("quick-chat-overlay");
var quickChatTarget = document.getElementById("quick-chat-target");
var quickChatInput = document.getElementById("quick-chat-input");
var quickChatSendBtn = document.getElementById("quick-chat-send");
var quickChatOpenMainBtn = document.getElementById("quick-chat-open-main");
var quickChatCloseBtn = document.getElementById("quick-chat-close");
var attachBtn = document.getElementById("attach-btn");
var fileInput = document.getElementById("file-input");
var fileDropZone = document.getElementById("file-drop-zone");
var replyPreview = document.getElementById("reply-preview");
var replyPreviewContent = document.getElementById("reply-preview-content");
var replyPreviewClose = document.getElementById("reply-preview-close");
var pendingFilesEl = document.getElementById("pending-files-preview");
var pendingFilesContent = document.getElementById("pending-files-content");
var pendingFilesClose = document.getElementById("pending-files-close");
var commandPalette = document.getElementById("command-palette");
var mentionPicker = document.getElementById("mention-picker");
var selectModeBtn = document.getElementById("select-mode-btn");
var originalSelectIcon = selectModeBtn.innerHTML; // preserve the original 4-square grid icon
var multiSelectBar = document.getElementById("multi-select-bar");
var selectedCountEl = document.getElementById("selected-count");
var copySelectedBtn = document.getElementById("copy-selected-btn");
var deleteSelectedBtn = document.getElementById("delete-selected-btn");
var cancelSelectBtn = document.getElementById("cancel-select-btn");
var agentStatusInterval = null;
var agentStatusData = [];
var agentRunTraceByGroup = {};
var activePrimaryNavKey = "agent-groups";
var todayPlanVisible = false;
var todayPlanOverview = null;
var currentTodayPlan = null;
var currentTodayPlanId = "";
var todayPlanPendingPatches = {};
var todayPlanSaveTimers = {};
var todayPlanAssociationOverlay = null;
var todayPlanAssociationState = null;
var todayPlanHistoryModalMode = "view";
var todayPlanMailSenderName = "";
var todayPlanMailToText = "";
var todayPlanMailCcText = "";
var activeTraceMonitorScope = "active";
var workflowDefinitionBundles = [];
var currentWorkflowDefinitionKey = "";
var currentWorkflowDefinitionDetail = null;
var workflowDefinitionSelectedVersion = null;
var workflowDefinitionDiffFocus = null;
var workflowDefinitionViewMode = "form";
var workflowDefinitionSelectedRoleKey = "";
var workflowDefinitionSelectedEntryPointKey = "";
var workflowDefinitionSelectedStateKey = "";
var workflowDefinitionSelectedStatusLabelKey = "";
var workflowDefinitionSelectedCreateFormFieldKey = "";
var workflowDefinitionCardsRegistry = {};
var workflowDefinitionRequestSeq = 0;
var cardsRegistry = {};
var currentCardSelection = null;
var cardsManagementExpandedGroups = {};
var cardsManagementGroupsInitialized = false;
var cardsManagementEditMode = false;
var cardsManagementEditSnapshot = null;
var cardsRequestSeq = 0;
var workflowDefinitionReferenceDetails = {};
var cardsDragState = null;
var cardsPreviewPresets = {
  default: {
    id: "WF-2026-001",
    name: "示例需求：Cards 管理页",
    service: "nanoclaw-web",
    context: {
      deliverable: "workflow/cards-preview.md",
      work_branch: "feature/cards-web-management",
    },
    owner: "alice",
    environment: "staging",
  },
  deploy: {
    id: "WF-DEPLOY-108",
    name: "预发部署确认",
    service: "gateway-service",
    context: {
      deliverable: "projects/gateway/iteration/deploy-checklist.md",
      work_branch: "release/pre-2026-04-10",
    },
    owner: "deploy-bot",
    environment: "pre",
  },
  review: {
    id: "WF-REVIEW-214",
    name: "开发回修确认",
    service: "workflow-engine",
    context: {
      deliverable: "projects/workflow/iteration/review-round-2.md",
      work_branch: "feature/review-loop",
    },
    owner: "reviewer",
    environment: "dev",
    revision_text: "请补充失败回滚说明和状态迁移图。",
  },
  testing: {
    id: "WF-TEST-330",
    name: "测试 access token 提交",
    service: "api-platform",
    context: {
      deliverable: "projects/api-platform/iteration/testing-brief.md",
      work_branch: "feature/testing-token",
      access_token: "demo-token-123456",
    },
    owner: "qa-bot",
    environment: "staging",
  },
};
var activeMemoryGroupJid = "";
var memoryEntries = [];
var knowledgeMaterials = [];
var knowledgeDrafts = [];
var knowledgePages = [];
var knowledgeJobs = [];
var knowledgeSelectedMaterialIds = /* @__PURE__ */ new Set();
var knowledgeSelectedDraftIds = /* @__PURE__ */ new Set();
var currentKnowledgeDetail = null;
var currentKnowledgeDraftId = "";
var currentKnowledgePageSlug = "";
var knowledgePollingTimer = null;
var knowledgeMaterialFilterValue = "all";
var knowledgeDraftStatusFilterValue = "all";
var knowledgePageKindFilterValue = "all";
const WORKBENCH_CONTEXT_BADGES = [
  { key: "requirement_preset", label: "关联需求" },
  { key: "main_branch", label: "主分支" },
  { key: "work_branch", label: "工作分支" },
  { key: "staging_base_branch", label: "预发分支" },
  { key: "staging_work_branch", label: "预发工作分支" },
];
var memoryQueryText = "";
var memoryRequestSeq = 0;
var editingMemoryId = "";
var memoryStatusFilterValue = "all";
var memoryDoctorReport = null;
var memoryDoctorMap = {};
var memoryMetricsSummary = null;
var workbenchTasks = [];
var currentWorkbenchDetail = null;
var currentWorkbenchTaskId = "";
var expandedWorkbenchTimelineIds = /* @__PURE__ */ new Set();
var workbenchSelectedSubtaskId = "";
var workbenchAnimatedSubtaskKey = "";
var workbenchFollowCurrentSubtaskOnce = false;
var workbenchRetryComposerSubtaskId = "";
var workbenchRetryComposerDraft = "";
var workbenchRetrySubmitting = false;
var workbenchDetailLoading = false;
var workbenchQueuedDetailTaskId = "";
var workbenchDetailReloadTimer = null;
var workbenchPendingReminderIdsByTask = {};
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
var workflowCreateOptionsCache = null;
var workflowCreateOptionsLoading = null;
var traceMonitorActiveRuns = [];
var traceMonitorHistoryRuns = [];
var traceMonitorHistoryOffset = 0;
var traceMonitorHistoryHasMore = false;
var traceMonitorHistoryLoading = false;
var traceMonitorHistoryClearing = false;
var traceMonitorHistoryJustCleared = false;
var currentTraceRunId = "";
var currentTraceRunRecord = null;
var currentTraceRunSteps = [];
var currentTraceRunEvents = [];
var currentTraceRunScope = "active";
var traceMonitorDetailReloadTimer = null;

var TRACE_HISTORY_PAGE_SIZE = 10;

// --- Command palette definitions ---
var commands = [
  { name: "/clear", desc: "Clear conversation context" },
  { name: "/compact", desc: "Compact conversation history" },
  { name: "/new", desc: "Start a fresh session for the next task" },
];

const MAIN_GROUP_AVATAR = "/assets/doraemon-face.png";
const GROUP_AVATAR_POOL = [
  "/assets/avatar-char-dorami.png",
  "/assets/avatar-char-shizuka.png",
  "/assets/avatar-char-suneo.png",
  "/assets/avatar-char-gounda-takeshi.png",
  "/assets/avatar-char-tamako-nobi-mother.png",
  "/assets/avatar-char-nobisuke-nobi-father.png",
  "/assets/avatar-char-teacher.png",
];

var fixedGroupAvatarMap = null;

function initFixedGroupAvatarMap() {
  if (!Array.isArray(groups) || groups.length === 0) return;
  if (fixedGroupAvatarMap) {
    let stale = false;
    for (const group of groups) {
      if (!group || typeof group.jid !== "string" || group.isMain) continue;
      const assigned = fixedGroupAvatarMap[group.jid];
      if (assigned && !GROUP_AVATAR_POOL.includes(assigned)) {
        stale = true;
        break;
      }
    }
    if (!stale) return;
  }
  fixedGroupAvatarMap = {};
  let poolIndex = 0;
  for (const group of groups) {
    if (!group || typeof group.jid !== "string") continue;
    if (group.isMain) {
      fixedGroupAvatarMap[group.jid] = MAIN_GROUP_AVATAR;
      continue;
    }
    if (poolIndex < GROUP_AVATAR_POOL.length) {
      fixedGroupAvatarMap[group.jid] = GROUP_AVATAR_POOL[poolIndex];
      poolIndex += 1;
    }
  }
}

function getFixedAvatar(group) {
  if (!group || typeof group.jid !== "string") return null;
  if (group.isMain) return MAIN_GROUP_AVATAR;
  if (!fixedGroupAvatarMap) return null;
  return fixedGroupAvatarMap[group.jid] || null;
}

function apiFetch(path, options) {
  const headers = { "Content-Type": "application/json" };
  return fetch(`http://localhost:3000${path}`, { ...options, headers });
}

function apiUrl(path) {
  if (!path) return "";
  if (/^(https?:|file:|blob:|data:)/i.test(path)) return path;
  return `http://localhost:3000${path.startsWith("/") ? path : `/${path}`}`;
}

function encodeApiPathSegments(pathValue) {
  return pathValue
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function workspaceFileApiPath(filePath) {
  if (!filePath) return null;
  const normalizedPath = filePath.replace(/\\/g, "/");
  const webUploadsMarker = "/data/web-uploads/";
  const webUploadsIndex = normalizedPath.lastIndexOf(webUploadsMarker);
  if (webUploadsIndex >= 0) {
    return `/api/uploads/${encodeApiPathSegments(normalizedPath.slice(webUploadsIndex + webUploadsMarker.length))}`;
  }
  const mappings = [
    ["/workspace/uploads/", "/api/uploads/"],
  ];
  for (const [prefix, apiPrefix] of mappings) {
    if (normalizedPath.startsWith(prefix)) {
      return `${apiPrefix}${encodeApiPathSegments(normalizedPath.slice(prefix.length))}`;
    }
  }
  if (normalizedPath.startsWith("/workspace/group/") && currentGroupJid) {
    const groupFolder = currentGroupJid.replace("web:", "");
    return `/api/files/${encodeURIComponent(groupFolder)}/${encodeApiPathSegments(normalizedPath.slice("/workspace/group/".length))}`;
  }
  return null;
}

function containerFilePath(filePath) {
  if (!filePath) return null;
  const normalizedPath = filePath.replace(/\\/g, "/");
  if (/^\/workspace\/(group|uploads|attachments|ai-images)\//.test(normalizedPath)) {
    return normalizedPath;
  }

  const sharedMappings = [
    ["/data/web-uploads/", "/workspace/uploads/"],
    ["/data/attachments/", "/workspace/attachments/"],
    ["/data/ai-images/", "/workspace/ai-images/"],
  ];
  for (const [hostMarker, containerPrefix] of sharedMappings) {
    const markerIndex = normalizedPath.lastIndexOf(hostMarker);
    if (markerIndex >= 0) {
      return `${containerPrefix}${normalizedPath.slice(markerIndex + hostMarker.length)}`;
    }
  }

  if (currentGroupJid) {
    const groupFolder = currentGroupJid.replace("web:", "");
    const groupMarker = `/groups/${groupFolder}/`;
    const groupIndex = normalizedPath.lastIndexOf(groupMarker);
    if (groupIndex >= 0) {
      return `/workspace/group/${normalizedPath.slice(groupIndex + groupMarker.length)}`;
    }
  }

  return null;
}

function shouldUseCustomAppDialogs() {
  return typeof window !== "undefined" && Boolean(window.nanoclawApp);
}

async function openTextPrompt(message, defaultValue = "", options = {}) {
  const promptFn = shouldUseCustomAppDialogs()
    ? null
    : typeof window.prompt === "function"
      ? window.prompt.bind(window)
      : null;
  if (promptFn) {
    try {
      return promptFn(message, defaultValue);
    } catch (err) {
      console.warn("window.prompt unavailable, falling back to custom prompt:", err);
    }
  }

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "app-prompt-overlay";
    overlay.innerHTML = `
      <div class="app-prompt-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(options.title || "输入")}">
        <div class="app-prompt-title">${escapeHtml(options.title || "请输入内容")}</div>
        <div class="app-prompt-message">${escapeHtml(message)}</div>
        <textarea class="app-prompt-input" rows="${options.multiline ? "5" : "3"}" placeholder="${escapeHtml(options.placeholder || "")}"></textarea>
        <div class="app-prompt-actions">
          <button type="button" class="btn-ghost" data-action="cancel">取消</button>
          <button type="button" class="btn-primary" data-action="confirm">确认</button>
        </div>
      </div>
    `;

    const input = overlay.querySelector(".app-prompt-input");
    const confirmBtn = overlay.querySelector('[data-action="confirm"]');
    const cancelBtn = overlay.querySelector('[data-action="cancel"]');
    let settled = false;

    function cleanup(value) {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(value);
    }

    input.value = defaultValue || "";
    document.body.appendChild(overlay);
    input.focus();
    input.setSelectionRange(0, input.value.length);

    confirmBtn.addEventListener("click", () => cleanup(input.value));
    cancelBtn.addEventListener("click", () => cleanup(null));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) cleanup(null);
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cleanup(null);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        cleanup(input.value);
        return;
      }
      if (!options.multiline && event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        cleanup(input.value);
      }
    });
  });
}

async function openConfirmDialog(message, options = {}) {
  const confirmFn = shouldUseCustomAppDialogs()
    ? null
    : typeof window.confirm === "function"
      ? window.confirm.bind(window)
      : null;
  if (confirmFn) {
    try {
      return confirmFn(message);
    } catch (err) {
      console.warn("window.confirm unavailable, falling back to custom confirm:", err);
    }
  }

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    const dialogClassName = ["app-prompt-dialog", options.dialogClassName].filter(Boolean).join(" ");
    const actionsClassName = ["app-prompt-actions", options.actionsClassName].filter(Boolean).join(" ");
    const cancelButtonClassName = options.cancelButtonClassName || "btn-ghost";
    const confirmButtonClassName = options.confirmButtonClassName || "btn-primary";
    overlay.className = "app-prompt-overlay";
    overlay.innerHTML = `
      <div class="${escapeAttribute(dialogClassName)}" role="dialog" aria-modal="true" aria-label="${escapeHtml(options.title || "确认")}">
        <div class="app-prompt-title">${escapeHtml(options.title || "请确认")}</div>
        <div class="app-prompt-message">${escapeHtml(message)}</div>
        <div class="${escapeAttribute(actionsClassName)}">
          <button type="button" class="${escapeAttribute(cancelButtonClassName)}" data-action="cancel">${escapeHtml(options.cancelText || "取消")}</button>
          <button type="button" class="${escapeAttribute(confirmButtonClassName)}" data-action="confirm">${escapeHtml(options.confirmText || "确认")}</button>
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

    confirmBtn.addEventListener("click", () => cleanup(true));
    cancelBtn.addEventListener("click", () => cleanup(false));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) cleanup(false);
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cleanup(false);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        cleanup(true);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        cleanup(true);
      }
    });
  });
}

function formatTodayPlanMailRecipients(values) {
  return Array.isArray(values) && values.length > 0 ? values.join(", ") : "无";
}

function parseTodayPlanMailRecipientsInput(value) {
  return String(value || "")
    .split(/[\n,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function renderTodayPlanMailDialogStatusMarkup(message, tone = "pending") {
  if (!message) return "";
  const toneClass = tone === "error" ? "is-error" : "is-pending";
  const role = tone === "error" ? "alert" : "status";
  return `<div class="today-plan-mail-dialog-status ${toneClass}" role="${role}">${escapeHtml(message)}</div>`;
}

async function openTodayPlanMailSendDialog(values = {}, options = {}) {
  const prepareDraft = typeof options.prepareDraft === "function" ? options.prepareDraft : null;
  const confirmDraft = typeof options.confirmDraft === "function" ? options.confirmDraft : null;
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "app-prompt-overlay";
    const state = {
      step: "compose",
      busy: false,
      statusMessage: "",
      errorMessage: "",
      values: {
        name: String(values.name || "").trim(),
        to: String(values.to || "").trim(),
        cc: String(values.cc || "").trim(),
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
        name: String(nameInput && nameInput.value ? nameInput.value : "").trim(),
        to: String(toInput && toInput.value ? toInput.value : "").trim(),
        cc: String(ccInput && ccInput.value ? ccInput.value : "").trim(),
      };
      return { nameInput };
    }

    function syncPreviewValues() {
      if (!state.draft) return {};
      const bodyInput = overlay.querySelector('[data-preview-field="body"]');
      state.draft = {
        ...state.draft,
        body: String(bodyInput && bodyInput.value ? bodyInput.value : "").replace(/\r\n/g, "\n"),
      };
      return { bodyInput };
    }

    async function submitCompose() {
      if (state.busy) return;
      const { nameInput } = syncComposeValues();
      if (!state.values.name) {
        alert("请输入姓名");
        if (nameInput) nameInput.focus();
        return;
      }
      if (!prepareDraft) {
        cleanup({ formData: { ...state.values }, draft: null });
        return;
      }
      state.busy = true;
      state.errorMessage = "";
      state.statusMessage = "正在生成预览，请稍候...";
      render();
      try {
        const draft = await prepareDraft({ ...state.values });
        if (!draft || !draft.id) throw new Error("未生成待发送草稿");
        state.draft = draft;
        state.step = "preview";
        state.busy = false;
        state.statusMessage = "";
        state.errorMessage = "";
        render();
      } catch (err) {
        state.busy = false;
        state.statusMessage = "";
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
      state.errorMessage = "";
      state.statusMessage = "正在发送邮件，请稍候...";
      render();
      try {
        const sentDraft = await confirmDraft(state.draft);
        cleanup({
          formData: { ...state.values },
          draft: sentDraft || state.draft,
        });
      } catch (err) {
        state.busy = false;
        state.statusMessage = "";
        state.errorMessage = err instanceof Error ? err.message : String(err);
        render();
      }
    }

    function renderCompose() {
      const statusMarkup = state.errorMessage
        ? renderTodayPlanMailDialogStatusMarkup(state.errorMessage, "error")
        : renderTodayPlanMailDialogStatusMarkup(state.statusMessage, "pending");
      overlay.innerHTML = `
        <div class="app-prompt-dialog today-plan-mail-compose-dialog" role="dialog" aria-modal="true" aria-label="填写计划邮件信息">
          <div class="app-prompt-title">填写计划邮件信息</div>
          <div class="app-prompt-message"><code>name</code> 为必填。<code>收件人</code>、<code>抄送人</code> 可选，留空时分别读取邮件配置中的默认值。</div>
          ${statusMarkup}
          <div class="today-plan-mail-compose-grid${state.busy ? " is-busy" : ""}">
            <label class="today-plan-mail-compose-field">
              <span class="today-plan-mail-compose-label">姓名</span>
              <input class="today-plan-mail-compose-input" data-field="name" type="text" placeholder="例如：张頔" value="${escapeAttribute(state.values.name || "")}" ${state.busy ? "disabled" : ""} />
            </label>
            <label class="today-plan-mail-compose-field">
              <span class="today-plan-mail-compose-label">收件人</span>
              <textarea class="app-prompt-input today-plan-mail-compose-textarea" data-field="to" rows="3" placeholder="多个地址用逗号或换行分隔；留空时使用配置默认值" ${state.busy ? "disabled" : ""}>${escapeHtml(state.values.to || "")}</textarea>
            </label>
            <label class="today-plan-mail-compose-field">
              <span class="today-plan-mail-compose-label">抄送人</span>
              <textarea class="app-prompt-input today-plan-mail-compose-textarea" data-field="cc" rows="3" placeholder="多个地址用逗号或换行分隔；留空时使用配置默认值" ${state.busy ? "disabled" : ""}>${escapeHtml(state.values.cc || "")}</textarea>
            </label>
          </div>
          <div class="app-prompt-actions today-plan-mail-dialog-actions">
            <button type="button" class="btn-primary btn-soft-primary today-plan-action-btn today-plan-btn-view today-plan-mail-dialog-secondary-btn" data-action="cancel" ${state.busy ? "disabled" : ""}>取消</button>
            <button type="button" class="btn-primary btn-soft-primary today-plan-action-btn today-plan-btn-create today-plan-mail-dialog-primary-btn" data-action="confirm" ${state.busy ? "disabled" : ""}>${state.busy ? "生成中..." : "生成预览"}</button>
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
        confirmBtn.addEventListener("click", () => {
          void submitCompose();
        });
      }
      if (cancelBtn) {
        cancelBtn.addEventListener("click", () => {
          if (state.busy) return;
          cleanup(null);
        });
      }
    }

    function renderPreview() {
      const draft = state.draft || {};
      const statusMarkup = state.errorMessage
        ? renderTodayPlanMailDialogStatusMarkup(state.errorMessage, "error")
        : renderTodayPlanMailDialogStatusMarkup(state.statusMessage, "pending");
      overlay.innerHTML = `
        <div class="app-prompt-dialog today-plan-mail-preview-dialog" role="dialog" aria-modal="true" aria-label="确认发送计划邮件">
          <div class="app-prompt-title">确认发送计划邮件</div>
          <div class="app-prompt-message">预览已生成，可直接修改正文；确认后按当前内容发送。</div>
          ${statusMarkup}
          <div class="today-plan-mail-preview-grid">
            <div class="today-plan-mail-preview-item">
              <div class="today-plan-mail-preview-label">主题</div>
              <div class="today-plan-mail-preview-value">${escapeHtml(draft.subject || "--")}</div>
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
          <textarea id="today-plan-mail-preview-body" class="app-prompt-input today-plan-mail-preview-body" data-preview-field="body" ${state.busy ? "disabled" : ""}></textarea>
          <div class="app-prompt-actions today-plan-mail-dialog-actions">
            <button type="button" class="btn-primary btn-soft-primary today-plan-action-btn today-plan-btn-view today-plan-mail-dialog-secondary-btn" data-action="back" ${state.busy ? "disabled" : ""}>返回修改</button>
            <button type="button" class="btn-primary btn-soft-primary today-plan-action-btn today-plan-btn-send today-plan-mail-dialog-primary-btn" data-action="confirm" ${state.busy ? "disabled" : ""}>${state.busy ? "发送中..." : "确认发送"}</button>
          </div>
        </div>
      `;

      const bodyInput = overlay.querySelector('[data-preview-field="body"]');
      const confirmBtn = overlay.querySelector('[data-action="confirm"]');
      const backBtn = overlay.querySelector('[data-action="back"]');
      if (!state.busy && bodyInput) {
        bodyInput.focus();
        bodyInput.setSelectionRange(bodyInput.value.length, bodyInput.value.length);
      } else if (!state.busy && confirmBtn) {
        confirmBtn.focus();
      }
      if (backBtn) {
        backBtn.addEventListener("click", () => {
          if (state.busy) return;
          syncPreviewValues();
          state.step = "compose";
          state.statusMessage = "";
          state.errorMessage = "";
          render();
        });
      }
      if (confirmBtn) {
        confirmBtn.addEventListener("click", () => {
          void submitConfirm();
        });
      }
      if (bodyInput) bodyInput.value = draft.body || "";
    }

    function render() {
      if (state.step === "preview") {
        renderPreview();
        return;
      }
      renderCompose();
    }

    document.body.appendChild(overlay);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay && !state.busy) cleanup(null);
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (state.busy) return;
        event.preventDefault();
        cleanup(null);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        if (state.step === "preview") {
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
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  if (isToday) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  const pad = (value) => String(value).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// --- SVG Icon helpers ---
const SVG = {
  trash: '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>',
  pause: '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" y1="4" x2="10" y2="20"></line><line x1="14" y1="4" x2="14" y2="20"></line></svg>',
  play: '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>',
  file: '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>',
  pdf: '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>',
  paperclip: '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>',
  stop: '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>',
  checkSquare: '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>',
  square: '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>',
  refresh: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>',
};

function iconBtnHTML(iconSvg, extraClass) {
  return `<button class="icon-btn-sm${extraClass ? ' ' + extraClass : ''}">${iconSvg}</button>`;
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function renderMarkdown(text) {
  if (typeof marked === "undefined") return escapeHtml(text);
  try {
    marked.setOptions({
      breaks: true,
      gfm: true,
      highlight: (code, lang) => {
        if (typeof hljs !== "undefined" && lang && hljs.getLanguage(lang)) {
          try {
            return hljs.highlight(code, { language: lang }).value;
          } catch {
            return code;
          }
        }
        return code;
      }
    });
    return marked.parse(text);
  } catch {
    return escapeHtml(text);
  }
}

// --- Code block copy buttons ---
function addCopyButtons(container) {
  const pres = container.querySelectorAll("pre");
  pres.forEach((pre) => {
    if (pre.parentElement && pre.parentElement.classList.contains("code-block-wrapper")) return;
    const wrapper = document.createElement("div");
    wrapper.className = "code-block-wrapper";
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);

    const btn = document.createElement("button");
    btn.className = "code-copy-btn";
    btn.textContent = "Copy";
    btn.addEventListener("click", () => {
      const code = pre.textContent || "";
      navigator.clipboard.writeText(code).then(() => {
        btn.textContent = "Copied!";
        btn.classList.add("copied");
        setTimeout(() => {
          btn.textContent = "Copy";
          btn.classList.remove("copied");
        }, 2000);
      });
    });
    wrapper.appendChild(btn);
  });
}

// --- File preview detection ---
var IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "svg", "webp"];
var PDF_EXTS = ["pdf"];

function detectFileUpload(content) {
  // Detect agent-visible workspace file references.
  const pathMatch = content.match(/文件地址:\s*(.+)/);
  if (pathMatch) {
    const filePath = pathMatch[1].trim();
    const filename = filePath.split("/").pop() || filePath;
    const ext = filename.split(".").pop().toLowerCase();
    return { filename, ext, filePath };
  }
  return null;
}

function renderFilePreview(filename, ext, filePath, fileUrl = null) {
  const div = document.createElement("div");
  div.className = "file-preview";
  const workspaceApiPath = workspaceFileApiPath(filePath);
  const previewUrl = fileUrl
    ? apiUrl(fileUrl)
    : workspaceApiPath
      ? apiUrl(workspaceApiPath)
      : filePath
        ? `file://${filePath}`
        : apiUrl(`/api/uploads/${encodeURIComponent(filename)}`);

  if (IMAGE_EXTS.includes(ext)) {
    const img = document.createElement("img");
    img.className = "file-preview-image";
    img.loading = "lazy";
    img.decoding = "async";
    img.src = previewUrl;
    img.alt = filename;
    img.addEventListener("click", () => openLightbox(img.src));
    div.appendChild(img);
  } else {
    const icon = document.createElement("span");
    icon.className = "file-preview-icon";
    icon.innerHTML = PDF_EXTS.includes(ext) ? SVG.pdf : SVG.file;
    div.appendChild(icon);

    // "打开文件" button
    if (filePath && !fileUrl && !workspaceApiPath) {
      const btn = document.createElement("button");
      btn.className = "file-open-btn";
      btn.innerHTML = `${SVG.paperclip} ${escapeHtml(filename)}`;
      btn.addEventListener("click", () => {
        if (window.nanoclawApp?.openFile) {
          window.nanoclawApp.openFile(filePath);
        } else {
          window.open(`file://${filePath}`);
        }
      });
      div.appendChild(btn);
    } else {
      const info = document.createElement("div");
      info.className = "file-preview-info";
      const link = document.createElement("a");
      link.className = "file-preview-name";
      link.href = previewUrl;
      link.target = "_blank";
      link.textContent = filename;
      info.appendChild(link);
      div.appendChild(info);
    }
  }
  return div;
}

function openLightbox(src) {
  const overlay = document.createElement("div");
  overlay.className = "lightbox-overlay";
  const img = document.createElement("img");
  img.src = src;
  overlay.appendChild(img);
  overlay.addEventListener("click", () => overlay.remove());
  document.body.appendChild(overlay);
}

// --- Interactive card detection & rendering ---
function isCardMessage(msg) {
  if (!msg.content || !msg.is_bot_message) return false;
  try {
    const parsed = JSON.parse(msg.content);
    return parsed._type === "card" && parsed.card;
  } catch { return false; }
}

function parseCardContent(msg) {
  try { return JSON.parse(msg.content).card; } catch { return null; }
}

function lockCardInteraction(container, pendingLabel) {
  if (!container || container.dataset.locked === "1") return;
  container.dataset.locked = "1";
  container.classList.add("card-locked");
  const controls = container.querySelectorAll("button, input, select, textarea");
  controls.forEach((el) => {
    el.disabled = true;
  });
  if (pendingLabel) {
    const status = document.createElement("div");
    status.className = "card-submit-status";
    status.textContent = pendingLabel;
    container.appendChild(status);
  }
}

function validateCardFormField(input, value) {
  const text = String(value || "").trim();
  const label = input.placeholder || input.name;

  if (input.required && !text) return `${label} 为必填项`;
  if (!text) return null;

  if (input.type === "integer") {
    if (!/^[-+]?\d+$/.test(text)) return `${label} 必须是整数`;
    const n = Number.parseInt(text, 10);
    if (typeof input.min === "number" && n < input.min) return `${label} 不能小于 ${input.min}`;
    if (typeof input.max === "number" && n > input.max) return `${label} 不能大于 ${input.max}`;
  }
  if (input.type === "number") {
    const n = Number(text);
    if (Number.isNaN(n)) return `${label} 必须是数字`;
    if (typeof input.min === "number" && n < input.min) return `${label} 不能小于 ${input.min}`;
    if (typeof input.max === "number" && n > input.max) return `${label} 不能大于 ${input.max}`;
  }
  if (typeof input.min_length === "number" && text.length < input.min_length) {
    return `${label} 长度不能少于 ${input.min_length}`;
  }
  if (typeof input.max_length === "number" && text.length > input.max_length) {
    return `${label} 长度不能超过 ${input.max_length}`;
  }
  if (input.format === "email") {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!re.test(text)) return `${label} 不是有效邮箱`;
  }
  if (input.format === "uri") {
    try { new URL(text); } catch { return `${label} 不是有效链接`; }
  }
  if (input.format === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${label} 日期格式应为 YYYY-MM-DD`;
  }
  if (input.format === "date-time") {
    if (Number.isNaN(new Date(text).getTime())) return `${label} 时间格式无效`;
  }

  return null;
}

function renderCardElement(card, msgId) {
  const container = document.createElement("div");
  container.className = "interactive-card";
  container.setAttribute("data-card-id", msgId);

  // Header
  const header = document.createElement("div");
  const color = card.header.color || "blue";
  header.className = `card-header card-color-${color}`;
  header.textContent = card.header.title;
  container.appendChild(header);

  // Body
  if (card.body) {
    const body = document.createElement("div");
    body.className = "card-body";
    body.innerHTML = renderMarkdown(card.body);
    container.appendChild(body);
  }

  // Buttons
  if (card.buttons && card.buttons.length > 0) {
    const actions = document.createElement("div");
    actions.className = "card-actions";
    for (const btn of card.buttons) {
      const button = document.createElement("button");
      button.className = `card-btn card-btn-${btn.type || "default"}`;
      button.textContent = btn.label;
      button.addEventListener("click", () => {
        lockCardInteraction(container, "已提交，处理中...");
        sendCardAction(btn.value, msgId);
      });
      actions.appendChild(button);
    }
    container.appendChild(actions);
  }

  // Sections (workflow list)
  if (card.sections) {
    for (let i = 0; i < card.sections.length; i++) {
      const section = card.sections[i];
      const sectionEl = document.createElement("div");
      sectionEl.className = "card-section";

      const bodyEl = document.createElement("div");
      bodyEl.className = "card-body";
      bodyEl.innerHTML = renderMarkdown(section.body);
      sectionEl.appendChild(bodyEl);

      if (section.buttons && section.buttons.length > 0) {
        const actions = document.createElement("div");
        actions.className = "card-actions";
        for (const btn of section.buttons) {
          const button = document.createElement("button");
          button.className = `card-btn card-btn-${btn.type || "default"}`;
          button.textContent = btn.label;
          button.addEventListener("click", () => {
            lockCardInteraction(container, "已提交，处理中...");
            sendCardAction(btn.value, msgId);
          });
          actions.appendChild(button);
        }
        sectionEl.appendChild(actions);
      }

      container.appendChild(sectionEl);
      if (i < card.sections.length - 1) {
        const hr = document.createElement("hr");
        hr.className = "card-divider";
        container.appendChild(hr);
      }
    }
  }

  // Form
  if (card.form) {
    const formEl = document.createElement("div");
    formEl.className = "card-form";
    const formError = document.createElement("div");
    formError.className = "card-form-error hidden";
    formEl.appendChild(formError);

    const formInputs = {};
    const clearInputErrors = () => {
      for (const item of Object.values(formInputs)) {
        if (item.errorEl) item.errorEl.remove();
        if (item.container) item.container.classList.remove("card-input-invalid");
      }
    };

    const addInputError = (item, message) => {
      if (!item || !message) return;
      if (item.errorEl) item.errorEl.remove();
      if (item.container) item.container.classList.add("card-input-invalid");
      const errEl = document.createElement("div");
      errEl.className = "card-input-error";
      errEl.textContent = message;
      item.errorEl = errEl;
      formEl.appendChild(errEl);
    };

    for (const input of card.form.inputs) {
      if (input.type === "enum" && Array.isArray(input.options) && input.options.length > 0) {
        const selectEl = document.createElement("select");
        selectEl.className = "card-input";
        selectEl.name = input.name;
        const emptyOpt = document.createElement("option");
        emptyOpt.value = "";
        emptyOpt.textContent = input.placeholder || "请选择";
        selectEl.appendChild(emptyOpt);
        for (const opt of input.options) {
          const optEl = document.createElement("option");
          optEl.value = opt.value;
          optEl.textContent = opt.label || opt.value;
          selectEl.appendChild(optEl);
        }
        formInputs[input.name] = { el: selectEl, type: "enum", meta: input, container: selectEl };
        formEl.appendChild(selectEl);
        if (input.error) addInputError(formInputs[input.name], input.error);
        continue;
      }

      if (input.type === "boolean") {
        const wrap = document.createElement("label");
        wrap.className = "card-input";
        wrap.style.display = "flex";
        wrap.style.alignItems = "center";
        wrap.style.gap = "8px";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.name = input.name;
        const text = document.createElement("span");
        text.textContent = input.placeholder || input.name;
        wrap.appendChild(checkbox);
        wrap.appendChild(text);
        formInputs[input.name] = { el: checkbox, type: "boolean", meta: input, container: wrap };
        formEl.appendChild(wrap);
        if (input.error) addInputError(formInputs[input.name], input.error);
        continue;
      }

      const inputEl = input.type === "textarea"
        ? document.createElement("textarea")
        : document.createElement("input");
      inputEl.className = "card-input";
      inputEl.name = input.name;
      inputEl.placeholder = input.placeholder || "";
      if (input.type !== "textarea") {
        if (input.type === "number") inputEl.type = "number";
        if (input.type === "integer") {
          inputEl.type = "number";
          inputEl.step = "1";
        }
        if (input.format === "date") inputEl.type = "date";
        if (input.format === "date-time") inputEl.type = "datetime-local";
      } else {
        inputEl.rows = 4;
      }
      if (input.required) inputEl.required = true;
      if (typeof input.min === "number" && "min" in inputEl) inputEl.min = String(input.min);
      if (typeof input.max === "number" && "max" in inputEl) inputEl.max = String(input.max);
      if (typeof input.min_length === "number") inputEl.minLength = input.min_length;
      if (typeof input.max_length === "number") inputEl.maxLength = input.max_length;
      formInputs[input.name] = { el: inputEl, type: input.type || "text", meta: input, container: inputEl };
      formEl.appendChild(inputEl);
      if (input.error) addInputError(formInputs[input.name], input.error);
    }

    const submitBtn = document.createElement("button");
    submitBtn.className = `card-btn card-btn-${card.form.submitButton.type || "default"}`;
    submitBtn.textContent = card.form.submitButton.label;
    submitBtn.addEventListener("click", () => {
      clearInputErrors();
      const formValue = {};
      for (const [name, item] of Object.entries(formInputs)) {
        if (item.type === "boolean") {
          formValue[name] = item.el.checked ? "true" : "false";
        } else {
          formValue[name] = item.el.value;
        }
      }
      for (const [name, item] of Object.entries(formInputs)) {
        const val = item.type === "boolean" ? (item.el.checked ? "true" : "false") : item.el.value;
        const err = validateCardFormField(item.meta || {}, val);
        if (err) {
          addInputError(item, err);
          formError.textContent = `${name}: ${err}`;
          formError.classList.remove("hidden");
          return;
        }
      }
      formError.textContent = "";
      formError.classList.add("hidden");
      lockCardInteraction(container, "表单已提交，处理中...");
      sendCardAction(card.form.submitButton.value, msgId, formValue);
    });
    formEl.appendChild(submitBtn);
    container.appendChild(formEl);
  }

  return container;
}

function sendCardAction(value, cardId, formValue) {
  sendWs({
    type: "card_action",
    cardId: cardId,
    value: value,
    formValue: formValue || undefined,
  });
}

function getMessageAvatarHtml(isUser) {
  const avatarSrc = isUser ? "/assets/nobita.png" : "/assets/doraemon-face.png";
  const avatarAlt = isUser ? "Nobita" : "Doraemon";
  return `<div class="msg-avatar"><img src="${avatarSrc}" alt="${avatarAlt}" /></div>`;
}

// --- Create single message element (factory) ---
function createMessageEl(msg) {
  // Card messages get special rendering
  if (isCardMessage(msg)) {
    const card = parseCardContent(msg);
    if (card) {
      const senderName = msg.sender_name || msg.sender || "Assistant";
      const wrapper = document.createElement("div");
      wrapper.className = "message assistant card-message";
      wrapper.setAttribute("data-msg-id", msg.id);
      wrapper.setAttribute("data-timestamp", msg.timestamp);
      wrapper.innerHTML = `
        <div class="msg-select-check">\u2713</div>
        ${getMessageAvatarHtml(false)}
        <div class="msg-main">
          <div class="msg-header">
            <span class="msg-sender">${escapeHtml(senderName)}</span>
            <span class="msg-time">${formatTime(msg.timestamp)}</span>
          </div>
          <div class="msg-body"></div>
        </div>
      `;
      const body = wrapper.querySelector(".msg-body");
      if (body) body.appendChild(renderCardElement(card, msg.id));
      wrapper.addEventListener("click", (e) => {
        if (!multiSelectMode) return;
        if (e.target.closest(".msg-actions")) return;
        e.preventDefault();
        toggleMessageSelection(msg.id, wrapper);
      });
      return wrapper;
    }
  }

  // File messages: render as file card with icon and filename
  if (msg._filePath) {
    const senderName = msg.sender_name || msg.sender || "Assistant";
    const fileName = msg._filePath.split("/").pop() || msg.content;
    const ext = fileName.split(".").pop().toLowerCase();
    const fileUrl = msg._fileUrl || null;
    const isImageFile = IMAGE_EXTS.includes(ext);
    const wrapper = document.createElement("div");
    wrapper.className = "message assistant file-message";
    wrapper.setAttribute("data-msg-id", msg.id);
    wrapper.setAttribute("data-timestamp", msg.timestamp);
    wrapper.innerHTML = `
      <div class="msg-select-check">\u2713</div>
      ${getMessageAvatarHtml(false)}
      <div class="msg-main">
        <div class="msg-header">
          <span class="msg-sender">${escapeHtml(senderName)}</span>
          <span class="msg-time">${formatTime(msg.timestamp)}</span>
        </div>
        <div class="msg-body"></div>
      </div>
    `;

    const body = wrapper.querySelector(".msg-body");
    if (isImageFile) {
      const preview = renderFilePreview(fileName, ext, msg._filePath, fileUrl);
      body.appendChild(preview);
      preview.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showFileContextMenu(e, msg._filePath);
      });
    } else {
      body.innerHTML = `
        <div class="file-card" data-ext="${escapeHtml(ext)}">
          <div class="file-card-icon">${getFileIcon(ext)}</div>
          <div class="file-card-name">${escapeHtml(fileName)}</div>
        </div>
      `;

      const card = wrapper.querySelector(".file-card");
      card.addEventListener("click", () => {
        if (window.nanoclawApp?.openFile) {
          window.nanoclawApp.openFile(msg._filePath);
        } else {
          window.open(fileUrl ? apiUrl(fileUrl) : `file://${msg._filePath}`);
        }
      });
      card.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showFileContextMenu(e, msg._filePath);
      });
    }
    wrapper.addEventListener("click", (e) => {
      if (!multiSelectMode) return;
      if (e.target.closest(".msg-actions")) return;
      e.preventDefault();
      toggleMessageSelection(msg.id, wrapper);
    });
    return wrapper;
  }

  const div = document.createElement("div");
  const isUser = msg.is_from_me;
  const isSystem = msg.sender === "system";
  div.setAttribute("data-msg-id", msg.id);
  div.setAttribute("data-timestamp", msg.timestamp);

  if (isSystem) {
    div.className = "message system";
    div.textContent = msg.content;
    return div;
  }

  div.className = `message ${isUser ? "user" : "assistant"}`;

  // Reply quote block
  let replyHtml = "";
  if (msg.reply_to_id) {
    const quoted = messages.find((m) => m.id === msg.reply_to_id);
    const quotedText = quoted ? quoted.content.slice(0, 80) : "...";
    replyHtml = `<div class="msg-reply-quote" data-reply-id="${escapeHtml(msg.reply_to_id)}">${escapeHtml(quotedText)}</div>`;
  }

  const renderedContent = isUser ? escapeHtml(msg.content) : renderMarkdown(msg.content);
  const modelTail = isUser && msg.model
    ? `<div class="msg-model-tail">模型：${escapeHtml(msg.model)}</div>`
    : "";

  // Check for file upload
  const fileInfo = detectFileUpload(msg.content);
  const groupFolder = currentGroupJid.replace("web:", "");

  div.innerHTML = `
    <div class="msg-select-check">\u2713</div>
    ${getMessageAvatarHtml(isUser)}
    <div class="msg-main">
      <div class="msg-header">
        ${msg.sender_name ? `<span class="msg-sender">${escapeHtml(msg.sender_name)}</span>` : ""}
        <span class="msg-time">${formatTime(msg.timestamp)}</span>
      </div>
      <div class="msg-body">
        <div class="msg-actions">
          <button class="msg-copy-btn" title="\u590D\u5236"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>
          <button class="msg-reply-btn" title="Reply"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg></button>
        </div>
        ${replyHtml}
        <div class="msg-content">${renderedContent}</div>
      </div>
      ${modelTail}
    </div>
  `;

  // Add file preview if detected
  if (fileInfo) {
    const preview = renderFilePreview(fileInfo.filename, fileInfo.ext, fileInfo.filePath);
    const contentEl = div.querySelector(".msg-content");
    contentEl.appendChild(preview);
  }

  // Add copy buttons to code blocks
  addCopyButtons(div);

  // Reply button handler
  const replyBtn = div.querySelector(".msg-reply-btn");
  if (replyBtn) {
    replyBtn.addEventListener("click", () => setReplyTo(msg));
  }

  // Copy button handler
  const copyBtn = div.querySelector(".msg-copy-btn");
  if (copyBtn) {
    copyBtn.addEventListener("click", () => copyMessageContent(msg));
  }

  // Multi-select click handler
  div.addEventListener("click", (e) => {
    if (!multiSelectMode) return;
    if (e.target.closest(".msg-actions")) return;
    e.preventDefault();
    toggleMessageSelection(msg.id, div);
  });

  return div;
}

// --- File icon by extension ---
function getFileIcon(ext) {
  const icons = {
    pdf: "📄", doc: "📝", docx: "📝", txt: "📃",
    sql: "🗃️", db: "🗃️",
    png: "🖼️", jpg: "🖼️", jpeg: "🖼️", gif: "🖼️", svg: "🖼️", webp: "🖼️",
    mp4: "🎬", mov: "🎬", avi: "🎬",
    mp3: "🎵", wav: "🎵", flac: "🎵",
    zip: "📦", rar: "📦", tar: "📦", gz: "📦",
    js: "⚡", ts: "⚡", py: "🐍", java: "☕", go: "🔵", rs: "🦀",
    json: "📋", xml: "📋", csv: "📊",
    xls: "📊", xlsx: "📊",
    ppt: "📑", pptx: "📑",
    html: "🌐", css: "🎨",
  };
  return icons[ext] || "📎";
}

// --- File context menu ---
function showFileContextMenu(e, filePath) {
  // Remove existing menu if any
  closeKnowledgeImportMenu();
  document.querySelector(".context-menu")?.remove();

  const menu = document.createElement("div");
  menu.className = "context-menu";
  const referencePath = containerFilePath(filePath);

  const items = [
    { label: "打开", icon: "📂", action: () => window.nanoclawApp?.openFile?.(filePath) },
    { label: "打开方式…", icon: "🔀", action: () => window.nanoclawApp?.openFileWith?.(filePath) },
    { label: "在文件夹中显示", icon: "📁", action: () => window.nanoclawApp?.showInFolder?.(filePath) },
    ...(referencePath ? [{ label: "引用", icon: "↩", action: () => referenceFileInComposer(referencePath) }] : []),
    { label: "复制路径", icon: "📋", action: () => navigator.clipboard?.writeText(filePath) },
  ];

  for (const item of items) {
    const el = document.createElement("div");
    el.className = "context-menu-item";
    el.innerHTML = `<span class="context-menu-icon">${item.icon}</span>${escapeHtml(item.label)}`;
    el.addEventListener("click", () => {
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
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 8}px`;

  // Close on click outside
  const closeHandler = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener("click", closeHandler);
    }
  };
  requestAnimationFrame(() => document.addEventListener("click", closeHandler));
}

function showCardsListContextMenu(e, workflowType, cardKey) {
  closeKnowledgeImportMenu();
  document.querySelector(".context-menu")?.remove();

  const menu = document.createElement("div");
  menu.className = "context-menu";

  const items = [
    {
      label: "复制当前卡片",
      icon: "⎘",
      action: async () => {
        currentCardSelection = { workflowType, cardKey };
        renderCardsList();
        renderCardsDetailPane();
        await duplicateCurrentCardDraft();
      },
    },
    {
      label: "删除当前卡片",
      icon: "🗑",
      action: async () => {
        currentCardSelection = { workflowType, cardKey };
        renderCardsList();
        renderCardsDetailPane();
        await deleteCurrentCard();
      },
    },
  ];

  for (const item of items) {
    const el = document.createElement("div");
    el.className = "context-menu-item";
    el.innerHTML = `<span class="context-menu-icon">${item.icon}</span>${escapeHtml(item.label)}`;
    el.addEventListener("click", async () => {
      menu.remove();
      await item.action();
    });
    menu.appendChild(el);
  }

  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 8}px`;

  const closeHandler = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener("click", closeHandler);
    }
  };
  requestAnimationFrame(() => document.addEventListener("click", closeHandler));
}

function scheduleModelSync() {
  if (!currentGroupJid) return;
  if (modelSyncTimer) clearTimeout(modelSyncTimer);
  modelSyncTimer = setTimeout(async () => {
    if (!currentGroupJid) return;
    try {
      const res = await apiFetch(`/api/messages?jid=${encodeURIComponent(currentGroupJid)}&since=0`);
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data.messages)) return;
      messages = data.messages.map(m => ({
        ...m,
        _filePath: m.file_path || undefined,
        _fileUrl: m.file_url || undefined
      }));
      renderMessages();
    } catch {
      // Best effort only.
    }
  }, 900);
}

// --- Skeleton loading ---
function showSkeleton() {
  messagesEmpty.style.display = "none";
  const existing = messagesEl.querySelectorAll(".message, .skeleton-message");
  existing.forEach((el) => el.remove());
  for (let i = 0; i < 5; i++) {
    const skel = document.createElement("div");
    skel.className = "skeleton-message";
    const widths = ["sender", i % 2 === 0 ? "long" : "medium", "short"];
    widths.forEach((w) => {
      const line = document.createElement("div");
      line.className = `skeleton-line ${w}`;
      skel.appendChild(line);
    });
    messagesEl.appendChild(skel);
  }
}

function clearSkeleton() {
  const skeletons = messagesEl.querySelectorAll(".skeleton-message");
  skeletons.forEach((el) => el.remove());
}

function setConnectionStatus(status) {
  connectionStatus.className = `conn-status ${status}`;
  const label = connectionStatus.querySelector(".conn-label");
  label.textContent = status === "connected" ? "Connected" : status === "connecting" ? "Connecting..." : "Disconnected";
}

function applyScreenVisibility() {
  const showTodayPlan = todayPlanVisible;
  const showWorkbench = !showTodayPlan && activePrimaryNavKey === "workbench";
  const showWorkspace = !showTodayPlan && activePrimaryNavKey === "agent-groups";
  const showWorkflowDefinitions = !showTodayPlan && activePrimaryNavKey === "workflow-definitions";
  const showCardsManagement = !showTodayPlan && activePrimaryNavKey === "cards-management";
  const showMemoryManagement = !showTodayPlan && activePrimaryNavKey === "memory-management";
  const showKnowledgeManagement = !showTodayPlan && activePrimaryNavKey === "knowledge-management";
  const showTraceMonitor = !showTodayPlan && activePrimaryNavKey === "trace-monitor";
  if (todayPlanScreen) {
    todayPlanScreen.classList.toggle("active", showTodayPlan);
  }
  if (workbenchScreen) {
    workbenchScreen.classList.toggle("active", showWorkbench);
  }
  if (workspace) {
    workspace.classList.toggle("active", showWorkspace);
  }
  if (workflowDefinitionsScreen) {
    workflowDefinitionsScreen.classList.toggle("active", showWorkflowDefinitions);
  }
  if (cardsManagementScreen) {
    cardsManagementScreen.classList.toggle("active", showCardsManagement);
  }
  if (memoryManagementScreen) {
    memoryManagementScreen.classList.toggle("active", showMemoryManagement);
  }
  if (knowledgeManagementScreen) {
    knowledgeManagementScreen.classList.toggle("active", showKnowledgeManagement);
  }
  if (traceMonitorScreen) {
    traceMonitorScreen.classList.toggle("active", showTraceMonitor);
  }
}

function setPrimaryNav(navKey) {
  if (navKey === null || navKey === void 0) return;
  activePrimaryNavKey = navKey;
  todayPlanVisible = false;
  if (navKey !== "knowledge-management" && knowledgeJobsPanel) {
    knowledgeJobsPanel.classList.remove("open");
  }
  primaryNavItems.forEach((item) => {
    item.classList.toggle("active", item.getAttribute("data-nav-key") === navKey);
  });
  applyScreenVisibility();
  if (navKey === "memory-management") {
    renderDoctorPanel();
    renderMemoryList();
    loadMemories();
  }
  if (navKey === "knowledge-management") {
    loadKnowledgeBaseData({ preserveDetail: true });
    if (knowledgePollingTimer) clearInterval(knowledgePollingTimer);
    knowledgePollingTimer = setInterval(() => {
      if (activePrimaryNavKey === "knowledge-management") {
        loadKnowledgeJobs();
      }
    }, 4000);
  } else if (knowledgePollingTimer) {
    clearInterval(knowledgePollingTimer);
    knowledgePollingTimer = null;
  }
  if (navKey === "workbench") {
    loadWorkbenchTasks();
  }
  if (navKey === "workflow-definitions") {
    loadWorkflowDefinitions({ preserveSelection: true });
  }
  if (navKey === "cards-management") {
    loadCardsRegistry({ preserveSelection: true });
  }
  if (navKey === "trace-monitor") {
    loadTraceMonitorData({ force: false });
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
  if (!primaryNavItems.length) return;
  const currentIndex = primaryNavItems.findIndex((item) => item.getAttribute("data-nav-key") === activePrimaryNavKey);
  const baseIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = (baseIndex + step + primaryNavItems.length) % primaryNavItems.length;
  const nextNavKey = primaryNavItems[nextIndex] && primaryNavItems[nextIndex].getAttribute("data-nav-key");
  if (nextNavKey) {
    setPrimaryNav(nextNavKey);
  }
}

function openSchedulersPanel() {
  closeKnowledgeImportMenu();
  if (knowledgeJobsPanel) {
    knowledgeJobsPanel.classList.remove("open");
  }
  agentStatusPanel.classList.remove("open");
  if (agentStatusInterval) {
    clearInterval(agentStatusInterval);
    agentStatusInterval = null;
  }
  schedulersPanel.classList.add("open");
  loadSchedulers();
}

function openAgentStatusPanel() {
  closeKnowledgeImportMenu();
  if (knowledgeJobsPanel) {
    knowledgeJobsPanel.classList.remove("open");
  }
  schedulersPanel.classList.remove("open");
  agentStatusPanel.classList.add("open");
  loadAgentStatus();
  if (agentStatusInterval) clearInterval(agentStatusInterval);
  agentStatusInterval = setInterval(updateAgentDurations, 1000);
}

function openKnowledgeJobsPanel() {
  closeKnowledgeImportMenu();
  schedulersPanel.classList.remove("open");
  agentStatusPanel.classList.remove("open");
  if (agentStatusInterval) {
    clearInterval(agentStatusInterval);
    agentStatusInterval = null;
  }
  if (knowledgeJobsPanel) {
    knowledgeJobsPanel.classList.add("open");
  }
  loadKnowledgeJobs();
}

function renderGroups() {
  initFixedGroupAvatarMap();
  groupsList.innerHTML = "";
  for (const group of groups) {
    const el = document.createElement("div");
    el.className = `list-item${group.jid === currentGroupJid ? " active" : ""}`;

    const avatar = getFixedAvatar(group);
    const initial = (group.name || "?")[0].toUpperCase();
    const unread = unreadCounts[group.jid] || 0;
    const iconHtml = avatar
      ? `<span class="item-icon item-avatar"><img src="${avatar}" alt="Group avatar" /></span>`
      : `<span class="item-icon">${escapeHtml(initial)}</span>`;

    el.innerHTML = `
      ${iconHtml}
      <span class="item-name">${escapeHtml(group.name)}</span>
      ${group.isMain ? '<span class="item-badge">main</span>' : ""}
      ${unread > 0 ? `<span class="item-unread">${unread > 99 ? "99+" : unread}</span>` : ""}
    `;
    el.addEventListener("click", () => selectGroup(group.jid));
    groupsList.appendChild(el);
  }
}

function getDefaultMemoryGroupJid() {
  if (!Array.isArray(groups) || groups.length === 0) return "";
  const mainGroup = groups.find((g) => g.isMain);
  return (mainGroup && mainGroup.jid) || groups[0].jid || "";
}

function updateMemoryGroupHeader() {
  if (!memoryGroupTitle || !memoryGroupFolder || !memoryGroupSummary) return;
  const group = groups.find((g) => g.jid === activeMemoryGroupJid);
  if (!group) {
    memoryGroupTitle.textContent = "记忆管理";
    memoryGroupFolder.textContent = "";
    memoryGroupSummary.textContent = "请先在左侧选择一个 Group。记忆管理按 Group（group_folder）隔离。";
    return;
  }
  memoryGroupTitle.textContent = group.name;
  memoryGroupFolder.textContent = group.isMain ? "(main)" : `@ ${group.folder}`;
  memoryGroupSummary.textContent = `当前 Group: ${group.folder}。可在此范围内进行记忆检索、整理与维护。`;
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
  setDoctorLog("");
  renderMemoryGroups();
  updateMemoryGroupHeader();
  loadMemories();
}

function renderMemoryGroups() {
  if (!memoryGroupsList) return;
  initFixedGroupAvatarMap();
  memoryGroupsList.innerHTML = "";
  for (const group of groups) {
    const el = document.createElement("div");
    el.className = `list-item${group.jid === activeMemoryGroupJid ? " active" : ""}`;
    const avatar = getFixedAvatar(group);
    const initial = (group.name || "?")[0].toUpperCase();
    const iconHtml = avatar
      ? `<span class="item-icon item-avatar"><img src="${avatar}" alt="Group avatar" /></span>`
      : `<span class="item-icon">${escapeHtml(initial)}</span>`;
    el.innerHTML = `
      ${iconHtml}
      <span class="item-name">${escapeHtml(group.name)}</span>
      ${group.isMain ? '<span class="item-badge">main</span>' : ""}
    `;
    el.addEventListener("click", () => selectMemoryGroup(group.jid));
    memoryGroupsList.appendChild(el);
  }
}

function formatDateTime(ts) {
  if (ts === null || ts === undefined || ts === "") return "--";
  const parsedMs = parseTimestamp(ts);
  if (!Number.isFinite(parsedMs) || parsedMs <= 0) return "--";
  const parsed = new Date(parsedMs);
  return parsed.toLocaleString();
}

function parseTimestamp(ts) {
  if (ts === null || ts === undefined || ts === "") return NaN;
  const numeric = Number(ts);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function getPayloadTimestamp(payload) {
  return payload.createdAt || payload.created_at || payload.updatedAt || payload.updated_at || new Date().toISOString();
}

function getActiveMemoryGroup() {
  return groups.find((g) => g.jid === activeMemoryGroupJid) || null;
}

function closeMemoryEditor() {
  editingMemoryId = "";
  if (memoryEditor) memoryEditor.classList.add("hidden");
  syncMemoryModalMask();
}

function openMemoryEditor() {
  if (memoryEditor) memoryEditor.classList.remove("hidden");
  syncMemoryModalMask();
}

function closeDoctorPanel() {
  if (memoryDoctorPanel) memoryDoctorPanel.classList.add("hidden");
  syncMemoryModalMask();
}

function openDoctorPanel() {
  if (memoryDoctorPanel) memoryDoctorPanel.classList.remove("hidden");
  syncMemoryModalMask();
}

function closeMemoryMetricsModal() {
  if (memoryMetricsModal) memoryMetricsModal.classList.add("hidden");
  syncMemoryModalMask();
}

function openMemoryMetricsModal() {
  if (memoryMetricsModal) memoryMetricsModal.classList.remove("hidden");
  syncMemoryModalMask();
}

function syncMemoryModalMask() {
  if (!memoryModalMask) return;
  const editorVisible = memoryEditor && !memoryEditor.classList.contains("hidden");
  const doctorVisible = memoryDoctorPanel && !memoryDoctorPanel.classList.contains("hidden");
  const metricsVisible = memoryMetricsModal && !memoryMetricsModal.classList.contains("hidden");
  memoryModalMask.classList.toggle("hidden", !(editorVisible || doctorVisible || metricsVisible));
}

function setDoctorLog(text) {
  if (memoryDoctorLog) {
    memoryDoctorLog.textContent = text || "";
  }
}

function getMemoryBrief(id) {
  const m = memoryDoctorMap && memoryDoctorMap[id];
  if (!m) return id;
  const content = (m.content || "").replace(/\s+/g, " ").slice(0, 80);
  return `${id}: ${content}`;
}

function renderMemoryMetricsModal() {
  if (!memoryMetricsWindow || !memoryMetricsTotal || !memoryMetricsList) return;
  const group = getActiveMemoryGroup();
  const groupLabel = group ? group.folder : "--";
  if (!memoryMetricsSummary) {
    memoryMetricsWindow.textContent = `${groupLabel} | 加载中...`;
    memoryMetricsTotal.textContent = "正在获取统计数据...";
    memoryMetricsList.innerHTML = "";
    return;
  }
  const summary = memoryMetricsSummary;
  memoryMetricsWindow.textContent = `${groupLabel} | 最近 ${summary.hours}h`;
  memoryMetricsTotal.textContent = `总事件数: ${summary.total}`;
  const rows = Array.isArray(summary.byEvent) ? summary.byEvent : [];
  if (rows.length === 0) {
    memoryMetricsList.innerHTML = '<div class="memory-metrics-item"><span>暂无事件</span><span class="count">0</span></div>';
    return;
  }
  memoryMetricsList.innerHTML = rows
    .map(
      (row) =>
        `<div class="memory-metrics-item"><span>${escapeHtml(row.event || "")}</span><span class="count">${escapeHtml(String(row.count || 0))}</span></div>`,
    )
    .join("");
}

function renderDoctorPanel() {
  if (!memoryDoctorPanel || !memoryDoctorSummary || !memoryDuplicatesList || !memoryStaleList || !memoryConflictsList) return;
  if (!memoryDoctorReport) {
    memoryDoctorSummary.textContent = "暂无报告";
    memoryDuplicatesList.innerHTML = '<div class="memory-doctor-item">请点击 Doctor 按钮生成报告</div>';
    memoryStaleList.innerHTML = '<div class="memory-doctor-item">请点击 Doctor 按钮生成报告</div>';
    memoryConflictsList.innerHTML = '<div class="memory-doctor-item">请点击 Doctor 按钮生成报告</div>';
    return;
  }
  const report = memoryDoctorReport;
  memoryDoctorSummary.textContent =
    `total=${report.total}, duplicate=${report.duplicateGroups.length}, conflict=${report.conflictGroups.length}, stale=${report.staleWorkingIds.length}`;

  memoryDuplicatesList.innerHTML = "";
  if (report.duplicateGroups.length === 0) {
    memoryDuplicatesList.innerHTML = '<div class="memory-doctor-item">无重复组</div>';
  } else {
    for (const g of report.duplicateGroups) {
      const el = document.createElement("div");
      el.className = "memory-doctor-item";
      el.innerHTML = `
        <div><strong>${escapeHtml(g.key)}</strong></div>
        <div>${g.ids.map((id) => escapeHtml(getMemoryBrief(id))).join("<br/>")}</div>
      `;
      memoryDuplicatesList.appendChild(el);
    }
  }

  memoryStaleList.innerHTML = "";
  if (report.staleWorkingIds.length === 0) {
    memoryStaleList.innerHTML = '<div class="memory-doctor-item">无过期 working</div>';
  } else {
    for (const id of report.staleWorkingIds) {
      const el = document.createElement("div");
      el.className = "memory-doctor-item";
      el.textContent = getMemoryBrief(id);
      memoryStaleList.appendChild(el);
    }
  }

  memoryConflictsList.innerHTML = "";
  if (report.conflictGroups.length === 0) {
    memoryConflictsList.innerHTML = '<div class="memory-doctor-item">无冲突组</div>';
  } else {
    for (const g of report.conflictGroups) {
      const ids = [...g.positiveIds, ...g.negativeIds];
      const keepDefault = g.positiveIds[0] || ids[0] || "";
      const depDefault = g.negativeIds[0] || ids[1] || "";
      const el = document.createElement("div");
      el.className = "memory-doctor-item";
      el.innerHTML = `
        <div><strong>${escapeHtml(g.key)}</strong></div>
        <div>Positive: ${g.positiveIds.map((id) => escapeHtml(getMemoryBrief(id))).join("<br/>") || "-"}</div>
        <div>Negative: ${g.negativeIds.map((id) => escapeHtml(getMemoryBrief(id))).join("<br/>") || "-"}</div>
        <div class="memory-doctor-actions">
          <button class="memory-action-btn" data-action="keep" data-keep-default="${escapeHtml(keepDefault)}" data-deprecate-default="${escapeHtml(depDefault)}" data-ids="${escapeHtml(ids.join(','))}">Keep</button>
          <button class="memory-action-btn" data-action="merge" data-ids="${escapeHtml(ids.join(','))}">Merge</button>
        </div>
      `;
      const keepBtn = el.querySelector('button[data-action="keep"]');
      const mergeBtn = el.querySelector('button[data-action="merge"]');
      if (keepBtn) {
        keepBtn.addEventListener("click", async () => {
          const allowed = (keepBtn.getAttribute("data-ids") || "").split(",").filter(Boolean);
          const keepDefaultId = keepBtn.getAttribute("data-keep-default") || "";
          const depDefaultId = keepBtn.getAttribute("data-deprecate-default") || "";
          const keepId = ((await openTextPrompt(`输入 keep_id（候选：${allowed.join(", ")}）`, keepDefaultId, { title: "冲突处理" })) || "").trim();
          const deprecateId = ((await openTextPrompt(`输入 deprecate_id（候选：${allowed.join(", ")}）`, depDefaultId, { title: "冲突处理" })) || "").trim();
          if (!keepId || !deprecateId || keepId === deprecateId) return;
          if (!allowed.includes(keepId) || !allowed.includes(deprecateId)) {
            alert("所选 ID 不在该冲突组内");
            return;
          }
          await resolveConflictKeep(keepId, deprecateId);
        });
      }
      if (mergeBtn) {
        mergeBtn.addEventListener("click", async () => {
          const allowed = (mergeBtn.getAttribute("data-ids") || "").split(",").filter(Boolean);
          const raw = ((await openTextPrompt(`输入两个 merge_ids（逗号分隔，候选：${allowed.join(", ")}）`, "", { title: "冲突合并" })) || "").trim();
          if (!raw) return;
          const picks = raw.split(",").map((s) => s.trim()).filter(Boolean);
          if (picks.length !== 2 || picks[0] === picks[1]) {
            alert("请提供两个不同的 ID");
            return;
          }
          if (!allowed.includes(picks[0]) || !allowed.includes(picks[1])) {
            alert("所选 ID 不在该冲突组内");
            return;
          }
          const mergedContent = ((await openTextPrompt("输入 merged_content", "", { title: "冲突合并", multiline: true })) || "").trim();
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
  setDoctorLog("Doctor 执行中...");
  try {
    const res = await apiFetch("/api/memory/doctor", {
      method: "POST",
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
    console.error("Doctor failed:", err);
    setDoctorLog(`Doctor 失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function showMemoryMetrics(hours) {
  const group = getActiveMemoryGroup();
  if (!group) {
    alert("请先选择 Group");
    return;
  }
  const safeHours = Number.isFinite(Number(hours)) ? Number(hours) : 24;
  memoryMetricsSummary = null;
  openMemoryMetricsModal();
  renderMemoryMetricsModal();
  try {
    const res = await apiFetch("/api/memory/metrics", {
      method: "POST",
      body: JSON.stringify({
        folder: group.folder,
        hours: safeHours,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    memoryMetricsSummary = data.summary || { hours: safeHours, total: 0, byEvent: [] };
    renderMemoryMetricsModal();
  } catch (err) {
    console.error("Load memory metrics failed:", err);
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
    const dryRunRes = await apiFetch("/api/memory/gc", {
      method: "POST",
      body: JSON.stringify({
        folder: group.folder,
        mode,
        dryRun: true,
      }),
    });
    const dryRunData = await dryRunRes.json();
    if (!dryRunRes.ok) throw new Error(dryRunData?.error || `HTTP ${dryRunRes.status}`);
    const r = dryRunData.result || {};
    const dup = (r.duplicateDeletedIds || []).length;
    const stale = (r.staleDeletedIds || []).length;
    const total = Number(r.totalCandidates || 0);
    if (total === 0) {
      setDoctorLog(`GC 预演完成：无需清理（mode=${mode}）`);
      return;
    }
    if (
      !(await openConfirmDialog(`GC预演结果：重复=${dup}，过期=${stale}，共=${total}。确认执行真实清理？`, {
        title: "确认执行 GC",
      }))
    ) {
      setDoctorLog("GC 已取消");
      return;
    }
    const runRes = await apiFetch("/api/memory/gc", {
      method: "POST",
      body: JSON.stringify({
        folder: group.folder,
        mode,
        dryRun: false,
      }),
    });
    const runData = await runRes.json();
    if (!runRes.ok) throw new Error(runData?.error || `HTTP ${runRes.status}`);
    setDoctorLog(`GC 完成：mode=${mode}, 删除=${runData.result?.totalCandidates || 0}`);
    loadMemories(memorySearchInput?.value || "");
    runDoctor(7);
  } catch (err) {
    console.error("GC failed:", err);
    setDoctorLog(`GC 失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function resolveConflictKeep(keepId, deprecateId) {
  const group = getActiveMemoryGroup();
  if (!group) return;
  try {
    const res = await apiFetch("/api/memory/conflict/keep", {
      method: "POST",
      body: JSON.stringify({
        folder: group.folder,
        keep_id: keepId,
        deprecate_id: deprecateId,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    setDoctorLog(`冲突已 Keep：${keepId} 保留，${deprecateId} 废弃`);
    loadMemories(memorySearchInput?.value || "");
    runDoctor(7);
  } catch (err) {
    console.error("Conflict keep failed:", err);
    setDoctorLog(`Keep 失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function resolveConflictMerge(mergeIds, mergedContent) {
  const group = getActiveMemoryGroup();
  if (!group) return;
  try {
    const res = await apiFetch("/api/memory/conflict/merge", {
      method: "POST",
      body: JSON.stringify({
        folder: group.folder,
        merge_ids: mergeIds,
        merged_content: mergedContent,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    setDoctorLog(`冲突已 Merge：${mergeIds.join(",")} -> ${data?.result?.merged?.id || "new"}`);
    loadMemories(memorySearchInput?.value || "");
    runDoctor(7);
  } catch (err) {
    console.error("Conflict merge failed:", err);
    setDoctorLog(`Merge 失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function openCreateMemoryEditor() {
  const group = getActiveMemoryGroup();
  if (!group) {
    alert("请先选择 Group");
    return;
  }
  editingMemoryId = "";
  if (memoryEditorTitle) memoryEditorTitle.textContent = "新增记忆";
  if (memoryLayerSelect) memoryLayerSelect.value = "working";
  if (memoryTypeSelect) memoryTypeSelect.value = "fact";
  if (memoryStatusSelect) memoryStatusSelect.value = "active";
  if (memoryContentInput) memoryContentInput.value = "";
  openMemoryEditor();
  memoryContentInput?.focus();
}

function openEditMemoryEditor(mem) {
  editingMemoryId = mem?.id || "";
  if (!editingMemoryId) return;
  if (memoryEditorTitle) memoryEditorTitle.textContent = "编辑记忆";
  if (memoryLayerSelect) memoryLayerSelect.value = mem.layer || "working";
  if (memoryTypeSelect) memoryTypeSelect.value = mem.memory_type || "fact";
  if (memoryStatusSelect) memoryStatusSelect.value = mem.status || "active";
  if (memoryContentInput) memoryContentInput.value = mem.content || "";
  openMemoryEditor();
  memoryContentInput?.focus();
}

async function saveMemoryEditor() {
  const group = getActiveMemoryGroup();
  if (!group) {
    alert("请先选择 Group");
    return;
  }
  const content = (memoryContentInput?.value || "").trim();
  if (!content) {
    alert("记忆内容不能为空");
    return;
  }
  const payload = {
    folder: group.folder,
    content,
    layer: memoryLayerSelect?.value || "working",
    memory_type: memoryTypeSelect?.value || "fact",
    memory_status: memoryStatusSelect?.value || "active",
  };

  try {
    if (editingMemoryId) {
      const res = await apiFetch("/api/memory", {
        method: "PATCH",
        body: JSON.stringify({
          memoryId: editingMemoryId,
          ...payload,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await res.json();
    } else {
      const res = await apiFetch("/api/memory", {
        method: "POST",
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
    loadMemories(memorySearchInput?.value || "");
  } catch (err) {
    console.error("Failed to save memory:", err);
    alert("保存记忆失败");
  }
}

async function deleteMemoryById(memoryId) {
  const group = getActiveMemoryGroup();
  if (!group) return;
  if (!(await openConfirmDialog("确认删除该记忆？", { title: "删除记忆" }))) return;
  try {
    const res = await apiFetch(
      `/api/memory?id=${encodeURIComponent(memoryId)}&folder=${encodeURIComponent(group.folder)}`,
      { method: "DELETE" },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await res.json();
    loadMemories(memorySearchInput?.value || "");
  } catch (err) {
    console.error("Failed to delete memory:", err);
    alert("删除记忆失败");
  }
}

function renderMemoryList() {
  if (!memoryList || !memoryEmpty) return;
  memoryList.innerHTML = "";
  const visibleMemories =
    memoryStatusFilterValue === "all"
      ? memoryEntries
      : memoryEntries.filter((m) => (m.status || "active") === memoryStatusFilterValue);
  if (!activeMemoryGroupJid) {
    memoryEmpty.textContent = "请先在左侧选择 Group";
    memoryEmpty.classList.remove("hidden");
    return;
  }
  if (!Array.isArray(visibleMemories) || visibleMemories.length === 0) {
    if (memoryEntries.length > 0 && memoryStatusFilterValue !== "all") {
      memoryEmpty.textContent = `当前筛选（${memoryStatusFilterValue}）下无记忆`;
      memoryEmpty.classList.remove("hidden");
    } else {
      if (memoryQueryText) {
        memoryEmpty.textContent = `没有匹配“${memoryQueryText}”的记忆`;
        memoryEmpty.classList.remove("hidden");
      } else {
        memoryEmpty.classList.add("hidden");
      }
    }
    return;
  }

  memoryEmpty.classList.add("hidden");
  for (const mem of visibleMemories) {
    const item = document.createElement("div");
    item.className = "memory-item";
    const statusClass = `status-${mem.status || "active"}`;
    item.innerHTML = `
      <div class="memory-item-header">
        <span class="memory-tag">${escapeHtml(mem.layer || "")}</span>
        <span class="memory-tag">${escapeHtml(mem.memory_type || "")}</span>
        <span class="memory-tag ${statusClass}">${escapeHtml(mem.status || "active")}</span>
        <span class="memory-item-time">${escapeHtml(formatDateTime(mem.updated_at))}</span>
      </div>
      <p class="memory-item-content">${escapeHtml(mem.content || "")}</p>
      <div class="memory-item-actions">
        <button class="memory-action-btn" data-action="edit" data-memory-id="${escapeHtml(mem.id || "")}">编辑</button>
        <button class="memory-action-btn danger" data-action="delete" data-memory-id="${escapeHtml(mem.id || "")}">删除</button>
      </div>
    `;
    const editBtn = item.querySelector('button[data-action="edit"]');
    const deleteBtn = item.querySelector('button[data-action="delete"]');
    if (editBtn) {
      editBtn.addEventListener("click", () => {
        openEditMemoryEditor(mem);
      });
    }
    if (deleteBtn) {
      deleteBtn.addEventListener("click", () => {
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
    typeof queryOverride === "string"
      ? queryOverride.trim()
      : (memorySearchInput?.value || "").trim();
  memoryQueryText = query;

  const reqSeq = ++memoryRequestSeq;
  if (memoryRefreshBtn) {
    memoryRefreshBtn.classList.add("spinning");
  }
  try {
    const params = new URLSearchParams({
      folder: group.folder,
      limit: "200",
    });
    if (query) params.set("query", query);
    const res = await apiFetch(`/api/memories?${params.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (reqSeq !== memoryRequestSeq) return;
    memoryEntries = Array.isArray(data.memories) ? data.memories : [];
    renderMemoryList();
  } catch (err) {
    if (reqSeq !== memoryRequestSeq) return;
    console.error("Failed to load memories:", err);
    memoryEntries = [];
    if (memoryEmpty) {
      memoryEmpty.textContent = "记忆加载失败";
      memoryEmpty.classList.remove("hidden");
    }
    if (memoryList) {
      memoryList.innerHTML = "";
    }
  } finally {
    if (reqSeq === memoryRequestSeq && memoryRefreshBtn) {
      memoryRefreshBtn.classList.remove("spinning");
    }
  }
}

function renderKnowledgeSelectionSummary() {
  if (!knowledgeSelectionSummary) return;
  knowledgeSelectionSummary.textContent = `已选 ${getSelectedKnowledgeMaterials().length} · 可见 ${getFilteredKnowledgeMaterials().length}`;
}

function renderKnowledgeDraftSelectionSummary() {
  if (!knowledgeDraftSelectionSummary) return;
  const selectedVisibleDrafts = knowledgeDrafts.filter((draft) => knowledgeSelectedDraftIds.has(draft.id) && draft.status !== "published");
  knowledgeDraftSelectionSummary.textContent = `已选 ${selectedVisibleDrafts.length} 份`;
  if (knowledgeDraftBulkDeleteBtn) {
    knowledgeDraftBulkDeleteBtn.disabled = selectedVisibleDrafts.length === 0;
    knowledgeDraftBulkDeleteBtn.title = selectedVisibleDrafts.length
      ? `批量删除 ${selectedVisibleDrafts.length} 份未发布草稿`
      : "请先勾选未发布草稿";
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
  return knowledgeMaterials.filter((material) => knowledgeSelectedMaterialIds.has(material.id));
}

function isKnowledgeMaterialDeletable(material) {
  return !!(material && material.usage_summary && material.usage_summary.can_delete);
}

function getFilteredKnowledgeMaterials() {
  return knowledgeMaterials.filter((material) => {
    const usageSummary = material.usage_summary || {};
    if (knowledgeMaterialFilterValue === "referenced") {
      return !usageSummary.can_delete;
    }
    if (knowledgeMaterialFilterValue === "deletable") {
      return !!usageSummary.can_delete;
    }
    if (knowledgeMaterialFilterValue === "selected") {
      return knowledgeSelectedMaterialIds.has(material.id);
    }
    return true;
  });
}

function getFilteredKnowledgeDrafts() {
  return knowledgeDrafts.filter((draft) => {
    if (knowledgeDraftStatusFilterValue === "all") return true;
    return draft.status === knowledgeDraftStatusFilterValue;
  });
}

function getFilteredKnowledgePages() {
  return knowledgePages.filter((page) => {
    if (knowledgePageKindFilterValue === "all") return true;
    return page.page_kind === knowledgePageKindFilterValue;
  });
}

function pruneKnowledgeDraftSelection() {
  const validIds = new Set(
    knowledgeDrafts
      .filter((draft) => draft.status !== "published")
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
        .map((page) => String(page.page_kind || "").trim())
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b, "zh-CN"));
  const currentValue = knowledgePageKindFilterValue;
  const options = ['<option value="all">全部页面类型</option>'];
  kinds.forEach((kind) => {
    options.push(`<option value="${escapeAttribute(kind)}">${escapeHtml(kind)}</option>`);
  });
  if (currentValue !== "all" && !kinds.includes(currentValue)) {
    options.push(`<option value="${escapeAttribute(currentValue)}">${escapeHtml(currentValue)}</option>`);
  }
  knowledgePageKindFilter.innerHTML = options.join("");
  knowledgePageKindFilter.value = currentValue;
}

function clearKnowledgeDetail() {
  currentKnowledgeDetail = null;
  currentKnowledgeDraftId = "";
  currentKnowledgePageSlug = "";
  if (knowledgeDetailEmpty) knowledgeDetailEmpty.classList.remove("hidden");
  if (knowledgeDetail) knowledgeDetail.classList.add("hidden");
  if (knowledgeDetailTitle) knowledgeDetailTitle.textContent = "知识详情";
  if (knowledgeDetailMeta) knowledgeDetailMeta.innerHTML = "";
  if (knowledgeDetailActions) knowledgeDetailActions.innerHTML = "";
  if (knowledgeDetailContent) knowledgeDetailContent.innerHTML = "";
}

function renderKnowledgeMaterials() {
  if (!knowledgeMaterialList) return;
  knowledgeMaterialList.innerHTML = "";
  renderKnowledgeSelectionSummary();
  const visibleMaterials = getFilteredKnowledgeMaterials();

  if (!knowledgeMaterials.length) {
    knowledgeMaterialList.innerHTML = '<div class="trace-monitor-list-empty">暂无资料快照</div>';
    return;
  }

  if (!visibleMaterials.length) {
    knowledgeMaterialList.innerHTML = '<div class="trace-monitor-list-empty">当前筛选下没有资料</div>';
    return;
  }

  for (const material of visibleMaterials) {
    const usageSummary = material.usage_summary || {};
    const dependencyTone = isKnowledgeMaterialDeletable(material) ? "deletable" : "referenced";
    const dependencyLabel = isKnowledgeMaterialDeletable(material) ? "可删除" : "有依赖";
    const item = document.createElement("div");
    item.className = `knowledge-list-item${currentKnowledgeDetail?.type === "material" && currentKnowledgeDetail.id === material.id ? " active" : ""}`;
    const checked = knowledgeSelectedMaterialIds.has(material.id);
    item.innerHTML = `
      <div class="knowledge-list-item-head">
        <div class="knowledge-list-item-title">${escapeHtml(material.title || material.id)}</div>
      </div>
      <div class="knowledge-list-item-meta">
        <span>${escapeHtml(material.source_kind || "--")}</span>
        <span>${escapeHtml(`页面 ${usageSummary.page_ref_count || 0}`)}</span>
        <span>${escapeHtml(`草稿 ${usageSummary.draft_ref_count || 0}`)}</span>
        <span>${escapeHtml(`证据 ${usageSummary.evidence_count || 0}`)}</span>
        <span>${escapeHtml(formatDateTime(material.created_at))}</span>
      </div>
      <div class="knowledge-list-item-actions">
        <span class="knowledge-status-pill ${escapeAttribute(dependencyTone)}">${escapeHtml(dependencyLabel)}</span>
        <label class="knowledge-selection-toggle">
          <input type="checkbox" data-material-select="${escapeAttribute(material.id)}" ${checked ? "checked" : ""} />
          选中
        </label>
      </div>
    `;
    const checkbox = item.querySelector('input[data-material-select]');
    if (checkbox) {
      checkbox.addEventListener("click", (event) => {
        event.stopPropagation();
        if (checkbox.checked) {
          knowledgeSelectedMaterialIds.add(material.id);
        } else {
          knowledgeSelectedMaterialIds.delete(material.id);
        }
        renderKnowledgeSelectionSummary();
      });
    }
    item.addEventListener("click", () => {
      openKnowledgeMaterialDetail(material.id);
    });
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      showKnowledgeMaterialContextMenu(event, material);
    });
    knowledgeMaterialList.appendChild(item);
  }
}

function renderKnowledgeDrafts() {
  if (!knowledgeDraftList) return;
  knowledgeDraftList.innerHTML = "";
  renderKnowledgeDraftSelectionSummary();
  const visibleDrafts = getFilteredKnowledgeDrafts();
  if (!knowledgeDrafts.length) {
    knowledgeDraftList.innerHTML = '<div class="trace-monitor-list-empty">暂无草稿</div>';
    return;
  }
  if (!visibleDrafts.length) {
    knowledgeDraftList.innerHTML = '<div class="trace-monitor-list-empty">当前筛选下没有草稿</div>';
    return;
  }
  for (const draft of visibleDrafts) {
    const selectable = draft.status !== "published";
    const checked = knowledgeSelectedDraftIds.has(draft.id);
    const item = document.createElement("div");
    item.className = `knowledge-list-item${draft.id === currentKnowledgeDraftId ? " active" : ""}`;
    item.innerHTML = `
      <div class="knowledge-list-item-head">
        <div class="knowledge-list-item-title">${escapeHtml(draft.title || draft.target_slug || draft.id)}</div>
      </div>
      <div class="knowledge-list-item-meta">
        <span>${escapeHtml(draft.page_kind || "--")}</span>
        <span>${escapeHtml(draft.target_slug || "--")}</span>
        <span>${escapeHtml(`资料 ${draft.material_count || 0}`)}</span>
      </div>
      <div class="knowledge-list-item-actions">
        <span class="knowledge-status-pill ${escapeHtml(draft.status || "draft")}">${escapeHtml(draft.status || "draft")}</span>
        <label class="knowledge-selection-toggle" title="${escapeAttribute(selectable ? "加入批量删除" : "已发布草稿不参与批量删除")}">
          <input type="checkbox" data-draft-select="${escapeAttribute(draft.id)}" ${checked ? "checked" : ""} ${selectable ? "" : "disabled"} />
          选中
        </label>
      </div>
    `;
    const checkbox = item.querySelector('input[data-draft-select]');
    if (checkbox) {
      checkbox.addEventListener("click", (event) => {
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
    item.addEventListener("click", () => {
      openKnowledgeDraftDetail(draft.id);
    });
    knowledgeDraftList.appendChild(item);
  }
}

function renderKnowledgePages() {
  if (!knowledgePageList) return;
  knowledgePageList.innerHTML = "";
  const visiblePages = getFilteredKnowledgePages();
  if (!knowledgePages.length) {
    knowledgePageList.innerHTML = '<div class="trace-monitor-list-empty">暂无已发布页面</div>';
    return;
  }
  if (!visiblePages.length) {
    knowledgePageList.innerHTML = '<div class="trace-monitor-list-empty">当前筛选下没有页面</div>';
    return;
  }
  for (const page of visiblePages) {
    const item = document.createElement("div");
    item.className = `knowledge-list-item${page.slug === currentKnowledgePageSlug ? " active" : ""}`;
    item.innerHTML = `
      <div class="knowledge-list-item-head">
        <div class="knowledge-list-item-title">${escapeHtml(page.title || page.slug)}</div>
      </div>
      <div class="knowledge-list-item-meta">
        <span>${escapeHtml(page.page_kind || "--")}</span>
        <span>${escapeHtml(page.slug || "--")}</span>
        <span>${escapeHtml(`入链 ${page.incoming_relation_count || 0}`)}</span>
      </div>
      <div class="knowledge-list-item-actions">
        <span class="knowledge-status-pill ${escapeHtml(page.status || "published")}">${escapeHtml(page.status || "published")}</span>
      </div>
    `;
    item.addEventListener("click", () => {
      openKnowledgePageDetail(page.slug);
    });
    knowledgePageList.appendChild(item);
  }
}

function renderKnowledgeJobs() {
  const runningCount = knowledgeJobs.filter((job) => job.status === "running").length;
  const pendingCount = knowledgeJobs.filter((job) => job.status === "pending").length;
  const finishedCount = knowledgeJobs.filter((job) => job.status === "completed" || job.status === "failed").length;
  if (knowledgeJobsTriggerMeta) {
    knowledgeJobsTriggerMeta.textContent = `${knowledgeJobs.length} 条`;
    const summaryParts = [];
    if (runningCount) summaryParts.push(`${runningCount} 运行中`);
    if (pendingCount) summaryParts.push(`${pendingCount} 排队中`);
    openKnowledgeJobsBtn.title = summaryParts.length
      ? `后台任务 · ${summaryParts.join(" · ")}`
      : `后台任务 · ${knowledgeJobs.length} 条`;
  }

  if (knowledgeJobsDeleteFinishedBtn) {
    knowledgeJobsDeleteFinishedBtn.disabled = finishedCount === 0;
    knowledgeJobsDeleteFinishedBtn.title = finishedCount
      ? `删除 ${finishedCount} 条已完成/失败任务`
      : "没有可删除的已完成/失败任务";
  }

  if (!knowledgeJobList) return;
  const runningIds = new Set(
    knowledgeJobs
      .filter((job) => job.status === "running")
      .map((job) => job.id),
  );
  Array.from(stoppingKnowledgeJobIds).forEach((jobId) => {
    if (!runningIds.has(jobId)) {
      stoppingKnowledgeJobIds.delete(jobId);
    }
  });

  knowledgeJobList.innerHTML = "";
  if (!knowledgeJobs.length) {
    knowledgeJobList.innerHTML = '<div class="agent-status-empty">暂无后台任务</div>';
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
    const canStop = job.status === "running";
    const requestLabel = payload?.title || payload?.targetSlug || result?.title || result?.target_slug || job.job_type || job.id;
    const summaryText = job.error_message
      || result?.title
      || result?.target_slug
      || (payload?.instruction ? `要求：${payload.instruction}` : "")
      || "等待执行";
    const createdLabel = formatRelativeTime(job.created_at);
    const startedLabel = job.started_at ? formatDateTime(job.started_at) : "未开始";
    const finishedLabel = job.finished_at ? formatDateTime(job.finished_at) : "未结束";

    const item = document.createElement("div");
    item.className = `knowledge-job-panel-item${isStopping ? " is-stopping" : ""}`;
    item.innerHTML = `
      <div class="knowledge-job-panel-head">
        <div class="knowledge-job-panel-title">${escapeHtml(requestLabel || job.id)}</div>
        <span class="knowledge-status-pill ${escapeHtml(job.status || "pending")}">${escapeHtml(job.status || "pending")}</span>
      </div>
      <div class="knowledge-job-panel-content">${escapeHtml(summaryText)}</div>
      <div class="knowledge-job-panel-meta">
        <span>${escapeHtml(`创建 ${createdLabel}`)}</span>
        <span>${escapeHtml(`开始 ${startedLabel}`)}</span>
        <span>${escapeHtml(`结束 ${finishedLabel}`)}</span>
      </div>
      ${canStop ? `
        <div class="knowledge-job-panel-actions">
          <button type="button" class="panel-action-btn stop icon-text-btn knowledge-job-stop-btn"${isStopping ? " disabled" : ""}>
            ${isStopping ? "Stopping..." : `${SVG.stop} Stop`}
          </button>
        </div>
      ` : ""}
    `;
    const stopBtn = item.querySelector(".knowledge-job-stop-btn");
    if (stopBtn && !isStopping) {
      stopBtn.addEventListener("click", () => {
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
    knowledgeDetailActions.innerHTML = "";
    return;
  }
  knowledgeDetailActions.innerHTML = actionList.map((action, index) => {
    const baseClass = action.kind === "primary" ? "btn-primary" : "btn-ghost";
    const toneClass = action.tone === "danger" ? " danger" : "";
    const disabledAttr = action.disabled ? " disabled" : "";
    return `
      <button
        type="button"
        class="${baseClass}${toneClass}"
        data-knowledge-action-index="${escapeAttribute(String(index))}"
        title="${escapeAttribute(action.title || action.label || "")}"${disabledAttr}
      >
        ${escapeHtml(action.label || "操作")}
      </button>
    `;
  }).join("");
  Array.from(knowledgeDetailActions.querySelectorAll("[data-knowledge-action-index]")).forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.getAttribute("data-knowledge-action-index"));
      const action = actionList[index];
      if (!action || action.disabled || typeof action.onClick !== "function") return;
      action.onClick();
    });
  });
}

function renderKnowledgeReferenceList(items, renderItem) {
  if (!Array.isArray(items) || items.length === 0) return '<div class="knowledge-empty-inline">无</div>';
  return `
    <div class="knowledge-reference-list">
      ${items.map((item) => renderItem(item)).join("")}
    </div>
  `;
}

function renderKnowledgeDetailHtml(title, metaLines, sectionsHtml, actions) {
  if (knowledgeDetailTitle) knowledgeDetailTitle.textContent = title;
  if (knowledgeDetailMeta) {
    knowledgeDetailMeta.innerHTML = metaLines.map((line) => `<span class="trace-monitor-pill">${line}</span>`).join("");
  }
  renderKnowledgeDetailActions(actions);
  if (knowledgeDetailContent) {
    knowledgeDetailContent.innerHTML = sectionsHtml;
  }
  if (knowledgeDetailEmpty) knowledgeDetailEmpty.classList.add("hidden");
  if (knowledgeDetail) knowledgeDetail.classList.remove("hidden");
}

function renderKnowledgeDiffMetric(label, count, tone) {
  return `
    <div class="knowledge-diff-card">
      <span class="knowledge-diff-pill ${escapeAttribute(tone || "neutral")}">${escapeHtml(label)}</span>
      <strong>${escapeHtml(String(count))}</strong>
    </div>
  `;
}

function renderKnowledgeMaterialIdList(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return '<div class="knowledge-empty-inline">无</div>';
  return `
    <div class="knowledge-chip-list">
      ${ids.map((id) => `<span class="knowledge-chip">${escapeHtml(id)}</span>`).join("")}
    </div>
  `;
}

function renderKnowledgeSection(title, bodyHtml, options = {}) {
  const bodyClass = typeof options.bodyClass === "string" && options.bodyClass.trim()
    ? ` ${options.bodyClass.trim()}`
    : "";
  const note = typeof options.note === "string" && options.note.trim()
    ? `<span class="knowledge-detail-section-note">${escapeHtml(options.note.trim())}</span>`
    : "";
  return `
    <section class="knowledge-detail-section">
      <div class="knowledge-detail-section-head">
        <h3>${escapeHtml(title || "详情")}</h3>
        ${note}
      </div>
      <div class="knowledge-detail-body${bodyClass}">
        ${bodyHtml}
      </div>
    </section>
  `;
}

function renderKnowledgeTextBody(text, emptyText = "无") {
  const value = String(text || "").trim();
  return `<div class="knowledge-detail-prose${value ? "" : " empty"}">${escapeHtml(value || emptyText)}</div>`;
}

function renderKnowledgeRawTextBody(text) {
  return `<pre class="knowledge-detail-pre">${escapeHtml(text || "")}</pre>`;
}

function renderKnowledgePageContentSection(title, contentMarkdown) {
  return renderKnowledgeSection(
    title || "正文",
    renderKnowledgeRawTextBody(contentMarkdown || ""),
    { bodyClass: "knowledge-detail-body-code" },
  );
}

function renderKnowledgeCardList(items, renderItem, emptyText = "无") {
  if (!Array.isArray(items) || items.length === 0) {
    return `<div class="knowledge-empty-inline">${escapeHtml(emptyText)}</div>`;
  }
  return `
    <div class="knowledge-detail-card-list">
      ${items.map((item) => `<div class="knowledge-detail-card">${renderItem(item)}</div>`).join("")}
    </div>
  `;
}

function renderKnowledgeClaimPreviewList(items, kind) {
  if (!Array.isArray(items) || items.length === 0) return '<div class="knowledge-empty-inline">无</div>';
  return `
    <div class="knowledge-diff-list">
      ${items.map((item) => {
        const previousStatement = item.previous_statement && item.previous_statement !== item.statement
          ? `<div class="knowledge-diff-item-prev">Before: ${escapeHtml(item.previous_statement)}</div>`
          : "";
        const meta = [
          item.claim_type || "claim",
          item.canonical_form || "",
          item.confidence === null || item.confidence === undefined ? "" : `confidence=${item.confidence}`,
        ].filter(Boolean);
        return `
          <div class="knowledge-diff-item ${escapeAttribute(kind || "neutral")}">
            <div class="knowledge-diff-item-head">
              <span class="knowledge-diff-pill ${escapeAttribute(kind || "neutral")}">${escapeHtml(kind || "变更")}</span>
              <span class="knowledge-diff-item-meta">${escapeHtml(meta.join(" · "))}</span>
            </div>
            ${previousStatement}
            <div class="knowledge-diff-item-main">${escapeHtml(item.statement || "")}</div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderKnowledgeRelationPreviewList(items, kind) {
  if (!Array.isArray(items) || items.length === 0) return '<div class="knowledge-empty-inline">无</div>';
  return `
    <div class="knowledge-diff-list">
      ${items.map((item) => {
        const previousRationale = item.previous_rationale && item.previous_rationale !== item.rationale
          ? `<div class="knowledge-diff-item-prev">Before: ${escapeHtml(item.previous_rationale)}</div>`
          : "";
        return `
          <div class="knowledge-diff-item ${escapeAttribute(kind || "neutral")}">
            <div class="knowledge-diff-item-head">
              <span class="knowledge-diff-pill ${escapeAttribute(kind || "neutral")}">${escapeHtml(kind || "变更")}</span>
              <span class="knowledge-diff-item-meta">${escapeHtml(`${item.relation_type || "related_to"} -> ${item.to_page_slug || ""}`)}</span>
            </div>
            ${previousRationale}
            <div class="knowledge-diff-item-main">${escapeHtml(item.rationale || "无 rationale")}</div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderKnowledgeContentDiff(contentDiff) {
  if (!contentDiff) return '<div class="knowledge-empty-inline">无</div>';
  const changedBlocks = Array.isArray(contentDiff.blocks)
    ? contentDiff.blocks.filter((block) => block.kind !== "unchanged")
    : [];
  if (!changedBlocks.length) {
    return '<div class="muted">正文无段落级变化</div>';
  }
  return `
    <div class="knowledge-diff-list">
      ${changedBlocks.map((block) => {
        const previousText = block.kind === "updated" && block.previous_text
          ? `<div class="knowledge-diff-item-prev">Before:</div><div class="knowledge-diff-item-block previous">${escapeHtml(block.previous_text || "")}</div>`
          : "";
        return `
          <div class="knowledge-diff-item ${escapeAttribute(block.kind || "neutral")}">
            <div class="knowledge-diff-item-head">
              <span class="knowledge-diff-pill ${escapeAttribute(block.kind || "neutral")}">${escapeHtml(block.kind || "change")}</span>
            </div>
            ${previousText}
            ${block.kind === "updated" ? '<div class="knowledge-diff-item-prev">After:</div>' : ""}
            <div class="knowledge-diff-item-block">${escapeHtml(block.text || "")}</div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderKnowledgeDraftPublishPreview(preview) {
  if (!preview) return "";
  const pageChanges = Array.isArray([
    preview.page_changes?.title ? "标题" : "",
    preview.page_changes?.page_kind ? "页面类型" : "",
    preview.page_changes?.summary ? "摘要" : "",
    preview.page_changes?.content_markdown ? "正文" : "",
  ].filter(Boolean)) ? [
    preview.page_changes?.title ? "标题" : "",
    preview.page_changes?.page_kind ? "页面类型" : "",
    preview.page_changes?.summary ? "摘要" : "",
    preview.page_changes?.content_markdown ? "正文" : "",
  ].filter(Boolean) : [];
  const modeLabel = preview.mode === "create" ? "新建页面" : "更新现有页面";
  const existingPage = preview.existing_page || null;
  return renderKnowledgeSection(
    "发布预览",
    `
      <div class="knowledge-diff-summary">
        <div class="knowledge-diff-summary-line">
          <span class="knowledge-diff-pill ${preview.mode === "create" ? "added" : "updated"}">${escapeHtml(modeLabel)}</span>
          <span>${existingPage ? `当前页面：${escapeHtml(existingPage.title || existingPage.slug || "")}` : "当前尚无已发布页面"}</span>
        </div>
        <div class="knowledge-diff-summary-line">
          <span>页面字段变化：</span>
          <span>${pageChanges.length ? escapeHtml(pageChanges.join(" / ")) : "无"}</span>
        </div>
      </div>
      <div class="knowledge-diff-grid">
        ${renderKnowledgeDiffMetric("新增陈述", preview.claims?.added?.length || 0, "added")}
        ${renderKnowledgeDiffMetric("更新陈述", preview.claims?.updated?.length || 0, "updated")}
        ${renderKnowledgeDiffMetric("移除陈述", preview.claims?.removed?.length || 0, "removed")}
        ${renderKnowledgeDiffMetric("保留陈述", preview.claims?.unchanged?.length || 0, "neutral")}
        ${renderKnowledgeDiffMetric("新增段落", preview.content_diff?.added_count || 0, "added")}
        ${renderKnowledgeDiffMetric("更新段落", preview.content_diff?.updated_count || 0, "updated")}
        ${renderKnowledgeDiffMetric("移除段落", preview.content_diff?.removed_count || 0, "removed")}
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
        ${renderKnowledgeClaimPreviewList(preview.claims?.added || [], "added")}
      </div>
      <div class="knowledge-detail-subsection">
        <strong>更新陈述</strong>
        ${renderKnowledgeClaimPreviewList(preview.claims?.updated || [], "updated")}
      </div>
      <div class="knowledge-detail-subsection">
        <strong>移除陈述</strong>
        ${renderKnowledgeClaimPreviewList(preview.claims?.removed || [], "removed")}
      </div>
      <div class="knowledge-detail-subsection">
        <strong>新增关系</strong>
        ${renderKnowledgeRelationPreviewList(preview.relations?.added || [], "added")}
      </div>
      <div class="knowledge-detail-subsection">
        <strong>移除关系</strong>
        ${renderKnowledgeRelationPreviewList(preview.relations?.removed || [], "removed")}
      </div>
    `,
    { bodyClass: "knowledge-detail-body-rich knowledge-detail-body-accent" },
  );
}

async function openKnowledgeMaterialDetail(materialId) {
  try {
    const res = await apiFetch(`/api/wiki/material?id=${encodeURIComponent(materialId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const material = data.material;
    const usage = data.usage || {};
    currentKnowledgeDetail = { type: "material", id: materialId };
    currentKnowledgeDraftId = "";
    currentKnowledgePageSlug = "";
    renderKnowledgeMaterials();
    renderKnowledgeDrafts();
    renderKnowledgePages();
    renderKnowledgeDetailHtml(
      material.title || material.id,
      [
        `<strong>资料</strong>${escapeHtml(material.id)}`,
        `<strong>来源</strong>${escapeHtml(material.source_kind || "--")}`,
        `<strong>删除</strong>${escapeHtml(usage.can_delete ? "可删除" : "有依赖")}`,
        `<strong>创建时间</strong>${escapeHtml(formatDateTime(material.created_at))}`,
      ],
      `
        ${renderKnowledgeSection("说明", renderKnowledgeTextBody(material.note || "无"))}
        ${renderKnowledgeSection(
          "引用状态",
          `
          <div class="knowledge-diff-grid">
            ${renderKnowledgeDiffMetric("引用页面", (usage.page_refs || []).length, (usage.page_refs || []).length ? "updated" : "neutral")}
            ${renderKnowledgeDiffMetric("关联草稿", (usage.draft_refs || []).length, (usage.draft_refs || []).length ? "updated" : "neutral")}
            ${renderKnowledgeDiffMetric("排队任务", (usage.job_refs || []).length, (usage.job_refs || []).length ? "updated" : "neutral")}
            ${renderKnowledgeDiffMetric("证据片段", usage.evidence_count || 0, (usage.evidence_count || 0) ? "updated" : "neutral")}
          </div>
          <div class="knowledge-detail-subsection">
            <strong>被这些页面使用</strong>
            ${renderKnowledgeReferenceList(usage.page_refs || [], (item) => `
              <div class="knowledge-reference-card">
                <strong>${escapeHtml(item.title || item.slug || "")}</strong>
                <div class="knowledge-reference-card-meta">slug: ${escapeHtml(item.slug || "")}</div>
              </div>
            `)}
          </div>
          <div class="knowledge-detail-subsection">
            <strong>被这些草稿引用</strong>
            ${renderKnowledgeReferenceList(usage.draft_refs || [], (item) => `
              <div class="knowledge-reference-card">
                <strong>${escapeHtml(item.title || item.id || "")}</strong>
                <div class="knowledge-reference-card-meta">${escapeHtml([item.id, item.target_slug, item.status].filter(Boolean).join(" · "))}</div>
              </div>
            `)}
          </div>
          <div class="knowledge-detail-subsection">
            <strong>被这些后台任务占用</strong>
            ${renderKnowledgeReferenceList(usage.job_refs || [], (item) => `
              <div class="knowledge-reference-card">
                <strong>${escapeHtml(item.id || "")}</strong>
                <div class="knowledge-reference-card-meta">${escapeHtml([item.job_type, item.status].filter(Boolean).join(" · "))}</div>
              </div>
            `)}
          </div>
          ${usage.can_delete
            ? '<div class="muted">当前没有页面、草稿或运行中任务依赖这份资料。</div>'
            : '<div class="knowledge-detail-warning">这份资料仍被知识库引用。要删除它，先删除相关草稿，或让页面改用其他资料后再重试。</div>'}
          `,
          { bodyClass: "knowledge-detail-body-rich knowledge-detail-body-accent" },
        )}
        ${renderKnowledgeSection(
          "原始文本",
          renderKnowledgeRawTextBody(data.extracted_text || ""),
          { bodyClass: "knowledge-detail-body-code" },
        )}
      `,
      [
        {
          label: "删除资料",
          kind: "ghost",
          tone: "danger",
          disabled: !usage.can_delete,
          title: usage.can_delete ? "删除当前资料" : "仍有页面、草稿或任务依赖这份资料",
          onClick: () => {
            void deleteKnowledgeMaterial(materialId, material.title || material.id);
          },
        },
      ],
    );
  } catch (err) {
    console.error("Failed to load wiki material:", err);
    showToast(`资料详情加载失败：${err instanceof Error ? err.message : "未知错误"}`);
  }
}

async function fetchKnowledgeDraftDetail(draftId) {
  const res = await apiFetch(`/api/wiki/draft?id=${encodeURIComponent(draftId)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function openKnowledgeDraftDetail(draftId) {
  try {
    const detail = await fetchKnowledgeDraftDetail(draftId);
    currentKnowledgeDetail = { type: "draft", id: draftId };
    currentKnowledgeDraftId = draftId;
    currentKnowledgePageSlug = "";
    renderKnowledgeDrafts();
    renderKnowledgePages();
    renderKnowledgeMaterials();
    const claims = Array.isArray(detail.compiled?.claims) ? detail.compiled.claims : [];
    const materials = Array.isArray(detail.materials) ? detail.materials : [];
    const publishPreview = detail.publish_preview || null;
    renderKnowledgeDetailHtml(
      detail.draft.title || detail.draft.target_slug,
      [
        `<strong>草稿</strong>${escapeHtml(detail.draft.id)}`,
        `<strong>页面 slug</strong>${escapeHtml(detail.draft.target_slug || "--")}`,
        `<strong>页面类型</strong>${escapeHtml(detail.draft.page_kind || "--")}`,
        `<strong>状态</strong>${escapeHtml(detail.draft.status || "draft")}`,
      ],
      `
        ${renderKnowledgeSection("摘要", renderKnowledgeTextBody(detail.draft.summary || "无摘要"))}
        ${renderKnowledgeSection(
          "引用资料",
          renderKnowledgeCardList(
            materials,
            (item) => `
              <div class="knowledge-detail-card-title">${escapeHtml(item.title || item.id)}</div>
              <div class="knowledge-detail-card-meta">${escapeHtml(item.id || "")}</div>
            `,
          ),
        )}
        ${renderKnowledgeSection(
          "知识陈述",
          renderKnowledgeCardList(
            claims,
            (claim) => `
              <div class="knowledge-detail-card-label">${escapeHtml(claim.claim_type || "陈述")}</div>
              <div class="knowledge-detail-card-title">${escapeHtml(claim.statement || "")}</div>
              <div class="knowledge-detail-card-meta">${escapeHtml(claim.canonical_form || "")}</div>
            `,
          ),
          { bodyClass: "knowledge-detail-body-rich" },
        )}
        ${renderKnowledgeDraftPublishPreview(publishPreview)}
        ${renderKnowledgePageContentSection(
          "正文",
          detail.compiled?.page?.content_markdown || detail.draft.content_markdown || "",
        )}
      `,
      [
        detail.draft.status === "published"
          ? null
          : {
              label: "发布草稿",
              kind: "primary",
              onClick: () => {
                void publishSelectedKnowledgeDraft();
              },
            },
        {
          label: "删除草稿",
          kind: "ghost",
          tone: "danger",
          onClick: () => {
            void deleteKnowledgeDraft(draftId, detail.draft.title || detail.draft.id);
          },
        },
      ].filter(Boolean),
    );
  } catch (err) {
    console.error("Failed to load wiki draft:", err);
    showToast(`草稿详情加载失败：${err instanceof Error ? err.message : "未知错误"}`);
  }
}

async function openKnowledgePageDetail(pageSlug) {
  try {
    const res = await apiFetch(`/api/wiki/page?slug=${encodeURIComponent(pageSlug)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    currentKnowledgeDetail = { type: "page", id: pageSlug };
    currentKnowledgeDraftId = "";
    currentKnowledgePageSlug = pageSlug;
    renderKnowledgeDrafts();
    renderKnowledgePages();
    renderKnowledgeMaterials();
    const claimRows = Array.isArray(data.claims) ? data.claims : [];
    const relationRows = Array.isArray(data.relations) ? data.relations : [];
    const materialRows = Array.isArray(data.materials) ? data.materials : [];
    const incomingRelationRows = Array.isArray(data.incoming_relations) ? data.incoming_relations : [];
    renderKnowledgeDetailHtml(
      data.page.title || data.page.slug,
      [
        `<strong>页面</strong>${escapeHtml(data.page.slug)}`,
        `<strong>页面类型</strong>${escapeHtml(data.page.page_kind || "--")}`,
        `<strong>更新时间</strong>${escapeHtml(formatDateTime(data.page.updated_at))}`,
      ],
      `
        ${renderKnowledgeSection("摘要", renderKnowledgeTextBody(data.page.summary || "无摘要"))}
        ${renderKnowledgePageContentSection("正文", data.page.content_markdown || "")}
        ${renderKnowledgeSection(
          "知识陈述",
          renderKnowledgeCardList(
            claimRows,
            (claim) => `
              <div class="knowledge-detail-card-label">${escapeHtml(claim.claim_type || "陈述")}</div>
              <div class="knowledge-detail-card-title">${escapeHtml(claim.statement || "")}</div>
              <div class="knowledge-detail-card-meta">${escapeHtml((claim.evidence || []).length ? `证据 ${(claim.evidence || []).length} 条` : "暂无证据")}</div>
            `,
          ),
          { bodyClass: "knowledge-detail-body-rich" },
        )}
        ${renderKnowledgeSection(
          "引用资料",
          renderKnowledgeCardList(
            materialRows,
            (item) => `
              <div class="knowledge-detail-card-title">${escapeHtml(item.title || item.id)}</div>
              <div class="knowledge-detail-card-meta">${escapeHtml(item.id || "")}</div>
            `,
          ),
        )}
        ${renderKnowledgeSection(
          "关联关系",
          renderKnowledgeCardList(
            relationRows,
            (relation) => `
              <div class="knowledge-detail-card-label">${escapeHtml(relation.relation_type || "related_to")}</div>
              <div class="knowledge-detail-card-title">${escapeHtml(relation.to_page_slug || "未指定目标")}</div>
              <div class="knowledge-detail-card-meta">${escapeHtml(relation.rationale || "无补充说明")}</div>
            `,
          ),
        )}
        ${renderKnowledgeSection(
          "被这些页面引用",
          `
          ${renderKnowledgeReferenceList(incomingRelationRows, (relation) => `
            <div class="knowledge-reference-card">
              <strong>${escapeHtml(relation.from_page_title || relation.from_page_slug || "")}</strong>
              <div class="knowledge-reference-card-meta">${escapeHtml(`${relation.relation_type || "related_to"} -> ${relation.to_page_slug || ""}`)}</div>
            </div>
          `)}
          ${incomingRelationRows.length
            ? `<div class="knowledge-detail-warning">删除此页面时，会一并移除其他页面指向它的 ${escapeHtml(String(incomingRelationRows.length))} 条关系。</div>`
            : ""}
          `,
          { bodyClass: "knowledge-detail-body-rich knowledge-detail-body-accent" },
        )}
      `,
      [
        {
          label: "删除页面",
          kind: "ghost",
          tone: "danger",
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
    console.error("Failed to load wiki page:", err);
    showToast(`页面详情加载失败：${err instanceof Error ? err.message : "未知错误"}`);
  }
}

async function loadKnowledgeMaterials() {
  const res = await apiFetch("/api/wiki/materials");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  knowledgeMaterials = Array.isArray(data.materials) ? data.materials : [];
  pruneKnowledgeMaterialSelection();
  renderKnowledgeMaterials();
}

async function loadKnowledgeDrafts() {
  const res = await apiFetch("/api/wiki/drafts");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  knowledgeDrafts = Array.isArray(data.drafts) ? data.drafts : [];
  pruneKnowledgeDraftSelection();
  renderKnowledgeDrafts();
}

async function loadKnowledgePages(queryOverride) {
  const query =
    typeof queryOverride === "string"
      ? queryOverride.trim()
      : (knowledgeSearchInput?.value || "").trim();
  const endpoint = query
    ? `/api/wiki/search?q=${encodeURIComponent(query)}`
    : "/api/wiki/pages";
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
    const res = await apiFetch("/api/wiki/jobs");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    knowledgeJobs = Array.isArray(data.jobs) ? data.jobs : [];
    renderKnowledgeJobs();

    if (knowledgeJobs.some((job) => job.status === "completed" || job.status === "failed")) {
      await Promise.all([loadKnowledgeDrafts(), loadKnowledgePages()]);
    }
  } catch (err) {
    console.error("Failed to load wiki jobs:", err);
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
      if (currentKnowledgeDetail.type === "material") {
        await openKnowledgeMaterialDetail(currentKnowledgeDetail.id);
      } else if (currentKnowledgeDetail.type === "draft") {
        await openKnowledgeDraftDetail(currentKnowledgeDetail.id);
      } else if (currentKnowledgeDetail.type === "page") {
        await openKnowledgePageDetail(currentKnowledgeDetail.id);
      }
    } else if (!currentKnowledgeDetail) {
      clearKnowledgeDetail();
    }
  } catch (err) {
    console.error("Failed to load knowledge base:", err);
    showToast(`知识库加载失败：${err instanceof Error ? err.message : "未知错误"}`);
  }
}

function closeKnowledgeImportMenu() {
  if (knowledgeImportMenuCloseHandler) {
    document.removeEventListener("click", knowledgeImportMenuCloseHandler);
    knowledgeImportMenuCloseHandler = null;
  }
  if (knowledgeImportMenu) {
    knowledgeImportMenu.remove();
    knowledgeImportMenu = null;
  }
  if (knowledgeImportBtn) {
    knowledgeImportBtn.setAttribute("aria-expanded", "false");
  }
}

function showKnowledgeImportMenu() {
  if (!knowledgeImportBtn) return;
  if (knowledgeImportMenu) {
    closeKnowledgeImportMenu();
    return;
  }

  document.querySelector(".context-menu")?.remove();

  const menu = document.createElement("div");
  menu.className = "context-menu";

  const items = [
    {
      label: "导入文本",
      icon: "📝",
      action: () => {
        closeKnowledgeImportMenu();
        void importKnowledgeText();
      },
    },
    {
      label: "导入文件",
      icon: "📄",
      action: () => {
        closeKnowledgeImportMenu();
        knowledgeFileInput?.click();
      },
    },
  ];

  for (const item of items) {
    const el = document.createElement("div");
    el.className = "context-menu-item";
    el.innerHTML = `<span class="context-menu-icon">${item.icon}</span>${escapeHtml(item.label)}`;
    el.addEventListener("click", item.action);
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
  knowledgeImportBtn.setAttribute("aria-expanded", "true");

  knowledgeImportMenuCloseHandler = (ev) => {
    if (!knowledgeImportMenu) return;
    if (knowledgeImportMenu.contains(ev.target) || knowledgeImportBtn.contains(ev.target)) {
      return;
    }
    closeKnowledgeImportMenu();
  };

  requestAnimationFrame(() => {
    document.addEventListener("click", knowledgeImportMenuCloseHandler);
  });
}

function showKnowledgeMaterialContextMenu(e, material) {
  closeKnowledgeImportMenu();
  document.querySelector(".context-menu")?.remove();

  if (!knowledgeSelectedMaterialIds.has(material.id)) {
    knowledgeSelectedMaterialIds.add(material.id);
    renderKnowledgeMaterials();
  }

  const selectedMaterials = getSelectedKnowledgeMaterials();
  const deletableCount = selectedMaterials.filter((item) => isKnowledgeMaterialDeletable(item)).length;
  const blockedCount = Math.max(0, selectedMaterials.length - deletableCount);
  const menu = document.createElement("div");
  menu.className = "context-menu knowledge-material-context-menu";
  menu.innerHTML = `
    <div class="knowledge-material-context-summary">
      <div class="knowledge-material-context-count">已选 ${escapeHtml(String(selectedMaterials.length))} 份资料</div>
      <div class="knowledge-material-context-list">
        ${selectedMaterials.map((item) => `
          <div class="knowledge-material-context-name" title="${escapeAttribute(item.title || item.id)}">
            ${escapeHtml(item.title || item.id)}
          </div>
        `).join("")}
      </div>
      <div class="knowledge-material-context-note">
        ${escapeHtml(`可删除 ${deletableCount} 份${blockedCount ? ` · 有依赖 ${blockedCount} 份` : ""}`)}
      </div>
    </div>
  `;

  const items = [
    {
      label: "删除所选",
      icon: "🗑",
      disabled: deletableCount === 0,
      action: async () => {
        await bulkDeleteSelectedKnowledgeMaterials();
      },
    },
    {
      label: "基于所选生成草稿",
      icon: "📝",
      disabled: selectedMaterials.length === 0,
      action: async () => {
        await generateKnowledgeDraft();
      },
    },
  ];

  items.forEach((item) => {
    const el = document.createElement("div");
    el.className = `context-menu-item${item.disabled ? " disabled" : ""}`;
    el.innerHTML = `<span class="context-menu-icon">${item.icon}</span>${escapeHtml(item.label)}`;
    if (!item.disabled) {
      el.addEventListener("click", async () => {
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
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 8}px`;

  const closeHandler = (event) => {
    if (!menu.contains(event.target)) {
      menu.remove();
      document.removeEventListener("click", closeHandler);
    }
  };
  requestAnimationFrame(() => document.addEventListener("click", closeHandler));
}

function openKnowledgeTextImportDialog() {
  const existing = document.getElementById("knowledge-text-import-overlay");
  if (existing) existing.remove();

  return new Promise((resolve) => {
    const state = {
      title: "",
      text: "",
    };
    let settled = false;

    const overlay = document.createElement("div");
    overlay.id = "knowledge-text-import-overlay";
    overlay.className = "workflow-wizard-overlay";
    overlay.innerHTML = `
      <div class="workflow-wizard-modal knowledge-text-import-modal" role="dialog" aria-modal="true" aria-labelledby="knowledge-text-import-title">
        <div class="workflow-wizard-header">
          <div class="workflow-wizard-header-copy">
            <div class="workflow-wizard-kicker">Knowledge Base</div>
            <div class="workflow-wizard-title-row">
              <div id="knowledge-text-import-title" class="workflow-wizard-title">导入文本资料</div>
              <span class="workflow-wizard-header-badge">单次填写标题与正文</span>
            </div>
            <div class="workflow-wizard-header-desc">把资料标题和正文集中在一个弹窗里完成，提交后直接写入知识库资料快照。</div>
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
                  <div class="workflow-wizard-label">导入方式</div>
                  <div class="workflow-wizard-hero-title">粘贴文本生成资料快照</div>
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
                  <span>标题</span>
                  <input id="knowledge-text-import-name" class="workflow-wizard-input" type="text" placeholder="例如：项目部署说明" />
                </label>
              </div>
              <div class="workflow-wizard-field-help">标题可留空；留空时会以“未命名资料”导入。</div>
            </div>
            <div class="workflow-wizard-section">
              <div class="workflow-wizard-label">2. 资料正文</div>
              <div class="workflow-wizard-subsection">
                <label class="knowledge-text-import-field">
                  <span>正文</span>
                  <textarea id="knowledge-text-import-content" class="workflow-wizard-input knowledge-text-import-textarea" rows="10" placeholder="粘贴要导入知识库的资料文本"></textarea>
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

    const titleInput = overlay.querySelector("#knowledge-text-import-name");
    const textInput = overlay.querySelector("#knowledge-text-import-content");
    const titleMetricEl = overlay.querySelector("#knowledge-text-import-title-metric");
    const countMetricEl = overlay.querySelector("#knowledge-text-import-count-metric");
    const summaryEl = overlay.querySelector("#knowledge-text-import-summary");
    const validationCardEl = overlay.querySelector("#knowledge-text-import-validation");
    const hintEl = overlay.querySelector("#knowledge-text-import-hint");
    const footerStatusEl = overlay.querySelector("#knowledge-text-import-footer-status");
    const submitBtn = overlay.querySelector("[data-knowledge-text-import-submit]");

    function cleanup(result) {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(result);
    }

    function renderSummary() {
      const title = String(state.title || "").trim();
      const text = String(state.text || "");
      const trimmedText = text.trim();
      const charCount = Array.from(text).length;
      const lineCount = trimmedText ? trimmedText.split(/\r\n|\r|\n/).length : 0;
      const preview = trimmedText
        ? trimmedText.replace(/\s+/g, " ").slice(0, 88)
        : "未填写";

      titleMetricEl.textContent = title || "未命名资料";
      countMetricEl.textContent = String(charCount);
      summaryEl.innerHTML = `
        <div class="workflow-wizard-selection-item">
          <span>资料标题</span>
          <strong>${escapeHtml(title || "未命名资料")}</strong>
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
        validationCardEl.dataset.state = "success";
        hintEl.textContent = "资料正文已填写，可以导入知识库。";
        footerStatusEl.textContent = title
          ? "将按当前标题导入文本资料"
          : "将以“未命名资料”导入文本资料";
        submitBtn.disabled = false;
      } else {
        validationCardEl.dataset.state = "warning";
        hintEl.textContent = "请先粘贴资料正文。";
        footerStatusEl.textContent = "请先填写资料正文";
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
      const text = String(state.text || "");
      if (!text.trim()) {
        textInput.focus();
        return;
      }
      cleanup({
        title: String(state.title || "").trim() || "未命名资料",
        text,
      });
    }

    document.body.appendChild(overlay);
    renderSummary();
    titleInput.focus();

    [titleInput, textInput].forEach((input) => {
      input.addEventListener("input", syncState);
      input.addEventListener("change", syncState);
    });

    titleInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        textInput.focus();
      }
    });

    Array.from(overlay.querySelectorAll("[data-knowledge-text-import-close]")).forEach((button) => {
      button.addEventListener("click", () => cleanup(null));
    });
    submitBtn.addEventListener("click", handleSubmit);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) cleanup(null);
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cleanup(null);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
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
    const res = await apiFetch("/api/wiki/materials/import", {
      method: "POST",
      body: JSON.stringify({
        title: payload.title,
        text: payload.text,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showToast("文本资料已导入");
    await loadKnowledgeMaterials();
  } catch (err) {
    console.error("Failed to import wiki text material:", err);
    showToast(`导入失败：${err instanceof Error ? err.message : "未知错误"}`);
  }
}

async function importKnowledgeFiles(files) {
  const mainGroup = getMainGroup();
  const jid = mainGroup?.jid || "web:main";
  for (const file of Array.from(files || [])) {
    const formData = new FormData();
    formData.append("file", file);
    try {
      const uploadRes = await fetch(`http://localhost:3000/api/upload?jid=${encodeURIComponent(jid)}`, {
        method: "POST",
        body: formData,
      });
      const uploadData = await uploadRes.json().catch(() => ({}));
      if (!uploadRes.ok || !uploadData.files?.[0]?.hostPath) {
        throw new Error(uploadData.error || `HTTP ${uploadRes.status}`);
      }

      const importRes = await apiFetch("/api/wiki/materials/import", {
        method: "POST",
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
      console.error("Failed to import wiki file material:", err);
      showToast(`文件导入失败：${file.name} · ${err instanceof Error ? err.message : "未知错误"}`);
    }
  }
  await loadKnowledgeMaterials();
}

const KNOWLEDGE_PAGE_KIND_OPTIONS = Object.freeze([
  { value: "project", label: "project · 项目" },
  { value: "concept", label: "concept · 概念" },
  { value: "decision", label: "decision · 决策" },
  { value: "procedure", label: "procedure · 流程" },
  { value: "person", label: "person · 人物" },
  { value: "glossary", label: "glossary · 术语" },
]);

const KNOWLEDGE_PAGE_KIND_LABELS = Object.freeze(
  KNOWLEDGE_PAGE_KIND_OPTIONS.reduce((result, option) => {
    result[option.value] = option.label;
    return result;
  }, {})
);

function normalizeKnowledgePageKind(value) {
  const normalized = String(value || "").trim();
  return KNOWLEDGE_PAGE_KIND_LABELS[normalized] ? normalized : "project";
}

function summarizeKnowledgeDraftInstruction(text) {
  const raw = String(text || "").trim();
  if (!raw) return "未补充";
  const firstLine = raw.split(/\n+/).find((line) => line.trim()) || raw;
  return firstLine.length > 52 ? `${firstLine.slice(0, 52)}...` : firstLine;
}

async function openKnowledgeDraftGenerateDialog(options = {}) {
  const selectedMaterials = Array.isArray(options.selectedMaterials) ? options.selectedMaterials : [];
  const defaultTargetSlug = String(options.defaultTargetSlug || "").trim();
  const defaultTitle = String(options.defaultTitle || "").trim();
  const defaultPageKind = normalizeKnowledgePageKind(options.defaultPageKind);
  const visibleMaterials = selectedMaterials.slice(0, 8);
  const hiddenMaterialCount = Math.max(0, selectedMaterials.length - visibleMaterials.length);
  const existing = document.getElementById("knowledge-draft-generate-overlay");
  if (existing) existing.remove();

  const materialListMarkup = visibleMaterials.length
    ? visibleMaterials.map((material) => {
      const meta = [
        String(material.source_kind || "").trim(),
        material.created_at ? formatDateTime(material.created_at) : "",
      ].filter(Boolean).join(" · ");
      return `
        <div class="knowledge-draft-generate-material-card">
          <div class="knowledge-draft-generate-material-title" title="${escapeAttribute(material.title || material.id)}">
            ${escapeHtml(material.title || material.id)}
          </div>
          <div class="knowledge-draft-generate-material-meta">${escapeHtml(meta || material.id || "--")}</div>
        </div>
      `;
    }).join("")
    : '<div class="knowledge-draft-generate-material-empty">当前没有可用资料</div>';

  return new Promise((resolve) => {
    const state = {
      targetSlug: defaultTargetSlug,
      title: defaultTitle,
      pageKind: defaultPageKind,
      instruction: "",
    };
    let settled = false;

    const overlay = document.createElement("div");
    overlay.id = "knowledge-draft-generate-overlay";
    overlay.className = "workflow-wizard-overlay";
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
                    <strong>${escapeHtml(defaultTargetSlug || "自动")}</strong>
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
                    ${KNOWLEDGE_PAGE_KIND_OPTIONS.map((option) => `
                      <option value="${escapeAttribute(option.value)}"${option.value === defaultPageKind ? " selected" : ""}>${escapeHtml(option.label)}</option>
                    `).join("")}
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
              ${hiddenMaterialCount > 0 ? `<div class="workflow-wizard-field-help">另有 ${escapeHtml(String(hiddenMaterialCount))} 份资料未展开，提交后会一并参与编纂。</div>` : ""}
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

    const targetSlugInput = overlay.querySelector("#knowledge-draft-target-slug");
    const titleInput = overlay.querySelector("#knowledge-draft-title");
    const pageKindSelect = overlay.querySelector("#knowledge-draft-page-kind");
    const instructionInput = overlay.querySelector("#knowledge-draft-instruction");
    const summaryEl = overlay.querySelector("#knowledge-draft-generate-summary");
    const footerStatusEl = overlay.querySelector("#knowledge-draft-generate-footer-status");

    function cleanup(result) {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(result);
    }

    function renderSummary() {
      const targetSlug = String(state.targetSlug || "").trim();
      const title = String(state.title || "").trim();
      const pageKind = normalizeKnowledgePageKind(state.pageKind);
      const instruction = summarizeKnowledgeDraftInstruction(state.instruction);

      summaryEl.innerHTML = `
        <div class="workflow-wizard-selection-item">
          <span>资料数量</span>
          <strong>${escapeHtml(String(selectedMaterials.length))} 份</strong>
        </div>
        <div class="workflow-wizard-selection-item">
          <span>目标 slug</span>
          <strong>${escapeHtml(targetSlug || "自动生成")}</strong>
        </div>
        <div class="workflow-wizard-selection-item">
          <span>页面标题</span>
          <strong>${escapeHtml(title || "自动总结")}</strong>
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
        footerStatusEl.textContent = "将按当前 slug、标题与页面类型创建后台编纂任务";
      } else if (targetSlug) {
        footerStatusEl.textContent = "将使用当前 slug，其余页面信息由后台结合资料补全";
      } else if (title) {
        footerStatusEl.textContent = "将使用当前标题，slug 由后台结合资料自动生成";
      } else {
        footerStatusEl.textContent = "将依据所选资料自动推断标题与 slug，并创建后台编纂任务";
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
        targetSlug: String(targetSlugInput.value || "").trim(),
        title: String(titleInput.value || "").trim(),
        pageKind: normalizeKnowledgePageKind(pageKindSelect.value),
        instruction: String(instructionInput.value || "").trim(),
      });
    }

    document.body.appendChild(overlay);
    renderSummary();
    titleInput.focus();
    titleInput.setSelectionRange(0, titleInput.value.length);

    [targetSlugInput, titleInput, pageKindSelect, instructionInput].forEach((input) => {
      const eventName = input.tagName === "SELECT" ? "change" : "input";
      input.addEventListener(eventName, syncState);
      if (eventName !== "change") {
        input.addEventListener("change", syncState);
      }
    });

    Array.from(overlay.querySelectorAll("[data-knowledge-draft-close]")).forEach((button) => {
      button.addEventListener("click", () => cleanup(null));
    });
    overlay.querySelector("[data-knowledge-draft-submit]").addEventListener("click", handleSubmit);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) cleanup(null);
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cleanup(null);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
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
    showToast("请先勾选至少一份资料");
    return;
  }

  const selectedDraft = knowledgeDrafts.find((draft) => draft.id === currentKnowledgeDraftId) || null;
  const selectedPage = knowledgePages.find((page) => page.slug === currentKnowledgePageSlug) || null;
  const defaultTargetSlug = selectedPage?.slug || selectedDraft?.target_slug || "";
  const defaultTitle = selectedPage?.title || selectedDraft?.title || "";
  const defaultPageKind = normalizeKnowledgePageKind(selectedPage?.page_kind || selectedDraft?.page_kind || "project");

  const payload = await openKnowledgeDraftGenerateDialog({
    selectedMaterials,
    defaultTargetSlug,
    defaultTitle,
    defaultPageKind,
  });
  if (!payload) return;

  try {
    const res = await apiFetch("/api/wiki/draft/generate", {
      method: "POST",
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
    showToast("已创建后台编纂任务");
    await loadKnowledgeJobs();
  } catch (err) {
    console.error("Failed to generate wiki draft:", err);
    showToast(`生成草稿失败：${err instanceof Error ? err.message : "未知错误"}`);
  }
}

async function publishSelectedKnowledgeDraft() {
  if (!currentKnowledgeDraftId) {
    showToast("请先在 Drafts 中选中一个草稿");
    return;
  }

  let detail;
  try {
    detail = await fetchKnowledgeDraftDetail(currentKnowledgeDraftId);
  } catch (err) {
    console.error("Failed to validate wiki draft before publish:", err);
    showToast(`发布前校验失败：${err instanceof Error ? err.message : "未知错误"}`);
    return;
  }

  if (detail?.draft?.status === "published") {
    showToast("该草稿已发布，无需重复操作");
    return;
  }

  const existingPage = detail?.publish_preview?.existing_page || null;
  const nextSlug = String(detail?.compiled?.page?.slug || detail?.draft?.target_slug || "").trim();
  const hasSlugConflict =
    detail?.publish_preview?.mode === "update" && Boolean(existingPage);
  const confirmMessage = hasSlugConflict
    ? `检测到 slug「${nextSlug || existingPage.slug || "--"}」已存在。\n当前页面：${existingPage.title || existingPage.slug || "未命名页面"}\n\n继续发布将覆盖该页面的当前快照。是否继续？`
    : `确认发布草稿「${detail?.draft?.title || nextSlug || currentKnowledgeDraftId}」到知识库吗？`;
  const confirmed = await openConfirmDialog(confirmMessage, {
    title: hasSlugConflict ? "覆盖现有知识库页面" : "发布知识库页面",
    confirmText: hasSlugConflict ? "确认覆盖并发布" : "发布",
    actionsClassName: "knowledge-detail-actions",
  });
  if (!confirmed) return;

  try {
    const res = await apiFetch("/api/wiki/draft/publish", {
      method: "POST",
      body: JSON.stringify({ draft_id: currentKnowledgeDraftId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showToast("草稿已发布到知识库");
    await loadKnowledgeBaseData();
    if (data.page?.slug) {
      await openKnowledgePageDetail(data.page.slug);
    }
  } catch (err) {
    console.error("Failed to publish wiki draft:", err);
    showToast(`发布失败：${err instanceof Error ? err.message : "未知错误"}`);
  }
}

async function deleteKnowledgeDraft(draftId, draftTitle) {
  const confirmed = await openConfirmDialog(`删除草稿「${draftTitle || draftId}」？已发布页面不会受影响。`, {
    title: "删除知识草稿",
  });
  if (!confirmed) return;

  try {
    const res = await apiFetch(`/api/wiki/draft?id=${encodeURIComponent(draftId)}`, {
      method: "DELETE",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    knowledgeSelectedDraftIds.delete(draftId);
    clearKnowledgeDetail();
    showToast("草稿已删除");
    await loadKnowledgeBaseData();
  } catch (err) {
    console.error("Failed to delete wiki draft:", err);
    showToast(`删除草稿失败：${err instanceof Error ? err.message : "未知错误"}`);
  }
}

function selectVisibleKnowledgeDrafts() {
  getFilteredKnowledgeDrafts().forEach((draft) => {
    if (draft.status !== "published") {
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
  const selectedDrafts = knowledgeDrafts.filter((draft) => knowledgeSelectedDraftIds.has(draft.id) && draft.status !== "published");
  if (!selectedDrafts.length) {
    showToast("请先勾选至少一个未发布草稿");
    return;
  }

  const confirmed = await openConfirmDialog(
    `批量删除 ${selectedDrafts.length} 个未发布草稿？已发布页面不会受影响。`,
    { title: "批量删除知识草稿" },
  );
  if (!confirmed) return;

  try {
    const res = await apiFetch("/api/wiki/drafts/bulk-delete", {
      method: "POST",
      body: JSON.stringify({
        draft_ids: selectedDrafts.map((draft) => draft.id),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const deletedIds = Array.isArray(data.deleted_ids) ? data.deleted_ids : [];
    const skippedPublishedIds = Array.isArray(data.skipped_published_ids) ? data.skipped_published_ids : [];
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
    console.error("Failed to bulk delete wiki drafts:", err);
    showToast(`批量删除草稿失败：${err instanceof Error ? err.message : "未知错误"}`);
  }
}

async function bulkDeleteSelectedKnowledgeMaterials() {
  const selectedMaterials = getSelectedKnowledgeMaterials();
  if (!selectedMaterials.length) {
    showToast("请先勾选至少一份资料");
    return;
  }

  const deletableMaterials = selectedMaterials.filter((material) => isKnowledgeMaterialDeletable(material));
  const blockedMaterials = selectedMaterials.filter((material) => !isKnowledgeMaterialDeletable(material));
  if (!deletableMaterials.length) {
    showToast("所选资料当前都有依赖，暂时无法删除");
    return;
  }

  const confirmed = await openConfirmDialog(
    `删除所选 ${selectedMaterials.length} 份资料？${blockedMaterials.length ? `其中 ${blockedMaterials.length} 份有依赖，将自动跳过。` : ""}`,
    { title: "批量删除知识资料" },
  );
  if (!confirmed) return;

  const results = await Promise.all(deletableMaterials.map(async (material) => {
    try {
      const res = await apiFetch(`/api/wiki/material?id=${encodeURIComponent(material.id)}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return { ok: true, material };
    } catch (err) {
      return {
        ok: false,
        material,
        error: err instanceof Error ? err.message : "未知错误",
      };
    }
  }));

  const deletedMaterials = results.filter((result) => result.ok).map((result) => result.material);
  const failedMaterials = results.filter((result) => !result.ok);

  deletedMaterials.forEach((material) => {
    knowledgeSelectedMaterialIds.delete(material.id);
  });

  const shouldPreserveDetail = !(
    currentKnowledgeDetail &&
    currentKnowledgeDetail.type === "material" &&
    deletedMaterials.some((material) => material.id === currentKnowledgeDetail.id)
  );
  if (!shouldPreserveDetail) {
    clearKnowledgeDetail();
  }

  await loadKnowledgeBaseData({ preserveDetail: shouldPreserveDetail });

  const summary = [
    deletedMaterials.length ? `已删除 ${deletedMaterials.length} 份` : "",
    blockedMaterials.length ? `跳过 ${blockedMaterials.length} 份有依赖资料` : "",
    failedMaterials.length ? `失败 ${failedMaterials.length} 份` : "",
  ].filter(Boolean).join("，");

  if (summary) {
    showToast(summary, 2600);
  } else {
    showToast("没有删除任何资料");
  }
}

async function deleteKnowledgeMaterial(materialId, materialTitle) {
  const confirmed = await openConfirmDialog(`删除资料「${materialTitle || materialId}」？删除后若仍需使用，需要重新导入。`, {
    title: "删除知识资料",
  });
  if (!confirmed) return;

  try {
    const res = await apiFetch(`/api/wiki/material?id=${encodeURIComponent(materialId)}`, {
      method: "DELETE",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    knowledgeSelectedMaterialIds.delete(materialId);
    clearKnowledgeDetail();
    showToast("资料已删除");
    await loadKnowledgeBaseData();
  } catch (err) {
    console.error("Failed to delete wiki material:", err);
    showToast(`删除资料失败：${err instanceof Error ? err.message : "未知错误"}`);
  }
}

async function deleteKnowledgePage(pageSlug, options = {}) {
  const summary = [
    options.claimCount ? `Claim ${options.claimCount} 条` : "",
    options.materialCount ? `资料 ${options.materialCount} 份` : "",
    options.outgoingRelationCount ? `外连关系 ${options.outgoingRelationCount} 条` : "",
    options.incomingRelationCount ? `入链关系 ${options.incomingRelationCount} 条` : "",
  ].filter(Boolean).join("，");
  const confirmed = await openConfirmDialog(
    `删除页面「${options.title || pageSlug}」？${summary ? `将同时移除 ${summary}。` : "此操作不可撤销。"}`,
    { title: "删除知识页面" },
  );
  if (!confirmed) return;

  try {
    const res = await apiFetch(`/api/wiki/page?slug=${encodeURIComponent(pageSlug)}`, {
      method: "DELETE",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    clearKnowledgeDetail();
    showToast("页面已删除");
    await loadKnowledgeBaseData();
  } catch (err) {
    console.error("Failed to delete wiki page:", err);
    showToast(`删除页面失败：${err instanceof Error ? err.message : "未知错误"}`);
  }
}

async function clearKnowledgeWiki() {
  const summary = [
    knowledgeMaterials.length ? `资料 ${knowledgeMaterials.length} 份` : "",
    knowledgeDrafts.length ? `草稿 ${knowledgeDrafts.length} 份` : "",
    knowledgePages.length ? `页面 ${knowledgePages.length} 个` : "",
    knowledgeJobs.length ? `任务 ${knowledgeJobs.length} 条` : "",
  ].filter(Boolean).join("，");
  const confirmed = await openConfirmDialog(
    `确认一键清除整个 LLM Wiki？${summary ? `将删除 ${summary}。` : "这会重置资料、草稿、页面和任务记录。"}此操作不可撤销。`,
    { title: "清除 LLM Wiki" },
  );
  if (!confirmed) return;

  closeKnowledgeImportMenu();

  try {
    const res = await apiFetch("/api/wiki/all", {
      method: "DELETE",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    knowledgeSelectedMaterialIds.clear();
    knowledgeSelectedDraftIds.clear();
    clearKnowledgeDetail();
    await loadKnowledgeBaseData();

    const clearedSummary = [
      data.material_count ? `资料 ${data.material_count} 份` : "",
      data.draft_count ? `草稿 ${data.draft_count} 份` : "",
      data.page_count ? `页面 ${data.page_count} 个` : "",
      data.job_count ? `任务 ${data.job_count} 条` : "",
    ].filter(Boolean).join("，");
    showToast(clearedSummary ? `已清除 LLM Wiki（${clearedSummary}）` : "LLM Wiki 已清空", 2400);
  } catch (err) {
    console.error("Failed to clear LLM wiki:", err);
    showToast(`清除 LLM Wiki 失败：${err instanceof Error ? err.message : "未知错误"}`);
  }
}

async function deleteFinishedKnowledgeJobs() {
  const deletableJobs = knowledgeJobs.filter((job) => job.status === "completed" || job.status === "failed");
  if (!deletableJobs.length) {
    showToast("没有可删除的已完成/失败任务");
    return;
  }

  const confirmed = await openConfirmDialog(
    `确认删除 ${deletableJobs.length} 条已完成/失败任务记录吗？这不会影响已生成的草稿或页面。`,
    { title: "删除后台任务记录" },
  );
  if (!confirmed) return;

  try {
    const res = await apiFetch("/api/wiki/jobs/finished", {
      method: "DELETE",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showToast(`已删除 ${data.deleted_count || 0} 条后台任务记录`);
    await loadKnowledgeJobs();
  } catch (err) {
    console.error("Failed to delete finished wiki jobs:", err);
    showToast(`删除后台任务记录失败：${err instanceof Error ? err.message : "未知错误"}`);
  }
}

async function stopKnowledgeJob(jobId) {
  const job = knowledgeJobs.find((item) => item.id === jobId);
  if (!job) {
    showToast("未找到该后台任务");
    return;
  }
  if (job.status !== "running") {
    showToast("仅支持停止运行中的后台任务");
    return;
  }

  const confirmed = await openConfirmDialog(
    `确认停止任务「${job.job_type || job.id}」吗？正在进行的知识库编纂会被中断。`,
    { title: "停止后台任务" },
  );
  if (!confirmed) return;

  stoppingKnowledgeJobIds.add(jobId);
  renderKnowledgeJobs();

  try {
    const res = await apiFetch("/api/wiki/job/stop", {
      method: "POST",
      body: JSON.stringify({ job_id: jobId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showToast("已发送停止请求");
    await loadKnowledgeJobs();
  } catch (err) {
    console.error("Failed to stop wiki job:", err);
    stoppingKnowledgeJobIds.delete(jobId);
    renderKnowledgeJobs();
    showToast(`停止后台任务失败：${err instanceof Error ? err.message : "未知错误"}`);
  }
}

async function runKnowledgeSearch() {
  try {
    await loadKnowledgePages(knowledgeSearchInput?.value || "");
  } catch (err) {
    console.error("Failed to search wiki pages:", err);
    showToast(`页面搜索失败：${err instanceof Error ? err.message : "未知错误"}`);
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
  return escapeHtml(String(value ?? "")).replace(/"/g, "&quot;");
}

function createWorkflowDefinitionTemplate(key, name, description) {
  return {
    key,
    name: name || key,
    description: description || "",
    version: 1,
    status: "draft",
    roles: {
      owner: {
        label: "负责人",
        channels: {
          web: "web_main",
        },
      },
    },
    entry_points: {
      start: {
        label: "默认入口",
        state: "todo",
      },
    },
    states: {
      todo: {
        type: "terminal",
        label: "待配置",
        description: "创建后请继续完善 roles、entry_points 与 states。",
      },
    },
    status_labels: {
      todo: "待配置",
    },
    create_form: {
      fields: [
        {
          key: "requirement_custom",
          label: "任务名称",
          type: "text",
          placeholder: "输入任务名称",
        },
      ],
    },
    metadata: {
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  };
}

function getWorkflowDefinitionVersionList() {
  const versions = currentWorkflowDefinitionDetail?.bundle?.versions;
  if (!Array.isArray(versions)) return [];
  return [...versions].sort((a, b) => b.version - a.version);
}

function getEditableWorkflowDefinition() {
  const selected = getSelectedWorkflowDefinitionVersion();
  return selected?.status === "draft" ? selected : null;
}

function getSelectedWorkflowDefinitionVersion() {
  const versions = getWorkflowDefinitionVersionList();
  return (
    versions.find((version) => version.version === workflowDefinitionSelectedVersion) ||
    versions[0] ||
    null
  );
}

function isSelectedWorkflowDefinitionDraft() {
  return getSelectedWorkflowDefinitionVersion()?.status === "draft";
}

function getWorkflowDefinitionModeAllowsEditing() {
  return workflowDefinitionViewMode === "form" || workflowDefinitionViewMode === "json";
}

function buildWorkflowDefinitionJsonDocument(version) {
  if (!version) return {};
  return {
    key: version.key,
    name: version.name || "",
    description: version.description || "",
    version: version.version,
    status: version.status,
    roles: cloneJson(version.roles || {}),
    entry_points: cloneJson(version.entry_points || {}),
    states: cloneJson(version.states || {}),
    status_labels: cloneJson(version.status_labels || {}),
    create_form: cloneJson(version.create_form || {}),
    metadata: cloneJson(version.metadata || {}),
  };
}

function parseWorkflowDefinitionJsonDocument() {
  const rawValue = workflowDefinitionJsonEditor?.value || "";
  let parsed;
  try {
    parsed = rawValue.trim() ? JSON.parse(rawValue) : {};
  } catch (err) {
    throw new Error(`流程定义 JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("流程定义 JSON 必须是对象");
  }
  return parsed;
}

function syncWorkflowDefinitionJsonFromForm() {
  if (workflowDefinitionViewMode !== "json" || !isSelectedWorkflowDefinitionDraft() || !workflowDefinitionJsonEditor) return;
  try {
    const payload = getWorkflowDefinitionSavePayload("form");
    const selectedVersion = getSelectedWorkflowDefinitionVersion();
    workflowDefinitionJsonEditor.value = stringifyPrettyJson({
      key: payload.key,
      name: payload.definition.name,
      description: payload.definition.description || "",
      version: selectedVersion?.version || 0,
      status: selectedVersion?.status || "draft",
      roles: payload.definition.roles || {},
      entry_points: payload.definition.entry_points || {},
      states: payload.definition.states || {},
      status_labels: payload.definition.status_labels || {},
      metadata: payload.definition.metadata || {},
    });
  } catch {
    // Keep user's current JSON text untouched if the form is temporarily invalid.
  }
}

function syncWorkflowDefinitionFormFromJson() {
  if (workflowDefinitionViewMode !== "json" || !isSelectedWorkflowDefinitionDraft()) return;
  const selectedVersion = getSelectedWorkflowDefinitionVersion();
  const bundle = currentWorkflowDefinitionDetail?.bundle || {};
  if (!selectedVersion) return;
  const parsed = parseWorkflowDefinitionJsonDocument();
  const nextDefinition = {
    ...selectedVersion,
    name: typeof parsed.name === "string" ? parsed.name : selectedVersion.name,
    description: typeof parsed.description === "string" ? parsed.description : selectedVersion.description,
    roles: parsed.roles && typeof parsed.roles === "object" ? parsed.roles : {},
    entry_points: parsed.entry_points && typeof parsed.entry_points === "object" ? parsed.entry_points : {},
    states: parsed.states && typeof parsed.states === "object" ? parsed.states : {},
    status_labels: parsed.status_labels && typeof parsed.status_labels === "object" ? parsed.status_labels : {},
    metadata: parsed.metadata && typeof parsed.metadata === "object" ? parsed.metadata : {},
  };
  renderWorkflowDefinitionEditor(nextDefinition, bundle);
}

function setWorkflowDefinitionViewMode(nextMode) {
  if (!["form", "json", "graph"].includes(nextMode)) return;
  if (workflowDefinitionViewMode === nextMode) return;
  try {
    if (workflowDefinitionViewMode === "json" && nextMode !== "json" && isSelectedWorkflowDefinitionDraft()) {
      syncWorkflowDefinitionFormFromJson();
    }
    if (workflowDefinitionViewMode !== "json" && nextMode === "json" && isSelectedWorkflowDefinitionDraft()) {
      syncWorkflowDefinitionJsonFromForm();
    }
  } catch (err) {
    showToast(err instanceof Error ? err.message : "视图切换失败", 2200);
    return;
  }
  workflowDefinitionViewMode = nextMode;
  renderWorkflowDefinitionDetailPane();
}

function setWorkflowDefinitionEditorReadonly(isReadonly, selectedVersion) {
  workflowDefinitionDetail?.classList.toggle("workflow-definition-readonly", isReadonly);
  if (workflowDefinitionEditorNote) {
    if (!selectedVersion) {
      workflowDefinitionEditorNote.textContent = "";
    } else if (isReadonly) {
      workflowDefinitionEditorNote.textContent =
        `当前选中 v${selectedVersion.version} · ${getWorkflowDefinitionVersionStatusLabel(selectedVersion.status)} · 只读`;
    } else {
      workflowDefinitionEditorNote.textContent =
        `当前选中 v${selectedVersion.version} · ${getWorkflowDefinitionVersionStatusLabel(selectedVersion.status)}`;
    }
  }
  if (workflowDefinitionJsonNote) {
    if (!selectedVersion) {
      workflowDefinitionJsonNote.textContent = "";
    } else if (isReadonly) {
      workflowDefinitionJsonNote.textContent =
        `当前选中 v${selectedVersion.version} · ${getWorkflowDefinitionVersionStatusLabel(selectedVersion.status)} · 只读`;
    } else {
      workflowDefinitionJsonNote.textContent =
        `当前选中 v${selectedVersion.version} · ${getWorkflowDefinitionVersionStatusLabel(selectedVersion.status)}`;
    }
  }

  if (workflowDefinitionEditorGrid) {
    Array.from(
      workflowDefinitionEditorGrid.querySelectorAll("input, textarea, select, button"),
    ).forEach((el) => {
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el instanceof HTMLButtonElement)) {
        return;
      }
      if (el === workflowDefinitionKeyInput || el === workflowDefinitionVersionInput) {
        el.disabled = true;
        return;
      }
      el.disabled = !!isReadonly;
    });
  }
}

function parseWorkflowDefinitionJsonField(label, rawValue, fallback) {
  const source = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!source) {
    return cloneJson(fallback);
  }
  try {
    return JSON.parse(source);
  } catch (err) {
    throw new Error(`${label} JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

function getStatesFromEditor() {
  if (!workflowDefinitionStatesInput) return {};
  return parseWorkflowDefinitionJsonField("States", workflowDefinitionStatesInput.value || "{}", {});
}

function getEntryPointsFromEditor() {
  if (!workflowDefinitionEntryPointsInput) return {};
  return parseWorkflowDefinitionJsonField("Entry Points", workflowDefinitionEntryPointsInput.value || "{}", {});
}

function getStatusLabelsFromEditor() {
  if (!workflowDefinitionStatusLabelsInput) return {};
  return parseWorkflowDefinitionJsonField("Status Labels", workflowDefinitionStatusLabelsInput.value || "{}", {});
}

function getRolesFromEditor() {
  if (!workflowDefinitionRolesInput) return {};
  return parseWorkflowDefinitionJsonField("Roles", workflowDefinitionRolesInput.value || "{}", {});
}

function getCreateFormFromEditor() {
  const editable = getEditableWorkflowDefinition();
  return cloneJson(editable?.create_form || { fields: [] });
}

function updateStatesEditor(states) {
  if (!workflowDefinitionStatesInput) return;
  workflowDefinitionStatesInput.value = stringifyPrettyJson(states || {});
}

function updateEntryPointsEditor(entryPoints) {
  if (!workflowDefinitionEntryPointsInput) return;
  workflowDefinitionEntryPointsInput.value = stringifyPrettyJson(entryPoints || {});
}

function updateStatusLabelsEditor(statusLabels) {
  if (!workflowDefinitionStatusLabelsInput) return;
  workflowDefinitionStatusLabelsInput.value = stringifyPrettyJson(statusLabels || {});
}

function updateRolesEditor(roles) {
  if (!workflowDefinitionRolesInput) return;
  workflowDefinitionRolesInput.value = stringifyPrettyJson(roles || {});
}

function updateCreateFormEditor(createForm) {
  const editable = getEditableWorkflowDefinition();
  if (editable) editable.create_form = cloneJson(createForm || { fields: [] });
}

function collectWorkflowDefinitionRoleReferences(roleKey, states, entryPoints) {
  const refs = [];
  Object.entries(entryPoints || {}).forEach(([entryKey, entry]) => {
    if (entry?.deliverable_role === roleKey) {
      refs.push(`entry_points.${entryKey}.deliverable_role`);
    }
  });
  Object.entries(states || {}).forEach(([stateKey, state]) => {
    if (state?.delegate?.role === roleKey) refs.push(`states.${stateKey}.delegate.role`);
    if (state?.on_complete?.success?.delegate?.role === roleKey) refs.push(`states.${stateKey}.on_complete.success.delegate.role`);
    if (state?.on_complete?.failure?.delegate?.role === roleKey) refs.push(`states.${stateKey}.on_complete.failure.delegate.role`);
    if (state?.on_approve?.delegate?.role === roleKey) refs.push(`states.${stateKey}.on_approve.delegate.role`);
    if (state?.on_revise?.delegate?.role === roleKey) refs.push(`states.${stateKey}.on_revise.delegate.role`);
  });
  return refs;
}

function createWorkflowDefinitionRoleTemplate() {
  return {
    label: "新角色",
    description: "",
    channels: {
      web: "",
    },
  };
}

const WORKFLOW_DEFINITION_DRAFT_CHANNEL_PREFIX = "__workflow_definition_draft_channel__";

function isWorkflowDefinitionDraftChannelKey(channelKey) {
  return typeof channelKey === "string" && channelKey.startsWith(WORKFLOW_DEFINITION_DRAFT_CHANNEL_PREFIX);
}

function getWorkflowDefinitionRoleChannelDisplayKey(channelKey) {
  return isWorkflowDefinitionDraftChannelKey(channelKey) ? "" : channelKey;
}

function createWorkflowDefinitionDraftChannelKey(channels) {
  let index = 1;
  let draftKey = `${WORKFLOW_DEFINITION_DRAFT_CHANNEL_PREFIX}${index}`;
  while (Object.prototype.hasOwnProperty.call(channels || {}, draftKey)) {
    index += 1;
    draftKey = `${WORKFLOW_DEFINITION_DRAFT_CHANNEL_PREFIX}${index}`;
  }
  return draftKey;
}

function addWorkflowDefinitionRoleChannel(channelKey = "", initialValue = "") {
  if (!workflowDefinitionSelectedRoleKey) return;
  const safeValue = String(initialValue || "");
  const keyPattern = /^[a-zA-Z0-9_-]+$/;
  const requestedKey = (channelKey || "").trim();
  if (requestedKey && !keyPattern.test(requestedKey)) {
    throw new Error("channel key 仅支持字母、数字、_ 和 -");
  }
  let addedKey = "";
  applyWorkflowDefinitionRolePatch(workflowDefinitionSelectedRoleKey, (role) => {
    role.channels = role.channels || {};
    const nextKey = requestedKey || createWorkflowDefinitionDraftChannelKey(role.channels);
    if (requestedKey && Object.prototype.hasOwnProperty.call(role.channels, nextKey)) {
      throw new Error(`channel "${nextKey}" 已存在`);
    }
    role.channels[nextKey] = safeValue;
    addedKey = nextKey;
    return cleanupWorkflowDefinitionRoleObject(role);
  });
  return addedKey;
}

function renameWorkflowDefinitionRoleChannel(oldKey, newKey) {
  if (!workflowDefinitionSelectedRoleKey || !oldKey) return;
  const safeNewKey = (newKey || "").trim();
  const keyPattern = /^[a-zA-Z0-9_-]+$/;
  if (!safeNewKey || safeNewKey === oldKey) return;
  if (!keyPattern.test(safeNewKey)) {
    throw new Error("channel key 仅支持字母、数字、_ 和 -");
  }
  applyWorkflowDefinitionRolePatch(workflowDefinitionSelectedRoleKey, (role) => {
    role.channels = role.channels || {};
    if (!Object.prototype.hasOwnProperty.call(role.channels, oldKey)) {
      throw new Error(`channel "${oldKey}" 不存在`);
    }
    if (Object.prototype.hasOwnProperty.call(role.channels, safeNewKey)) {
      throw new Error(`channel "${safeNewKey}" 已存在`);
    }
    const previousValue = role.channels[oldKey];
    delete role.channels[oldKey];
    role.channels[safeNewKey] = previousValue;
    return cleanupWorkflowDefinitionRoleObject(role);
  });
}

function addWorkflowDefinitionRoleChannelFromButton() {
  if (!workflowDefinitionRoleInspector) return;
  try {
    const addedKey = addWorkflowDefinitionRoleChannel("", "");
    const keyInput = workflowDefinitionRoleInspector.querySelector(
      `[data-role-channel-storage-key="${escapeAttribute(addedKey)}"]`,
    );
    if (keyInput instanceof HTMLInputElement) keyInput.focus();
  } catch (err) {
    alert(err instanceof Error ? err.message : "新增 channel 失败");
  }
}

function handleWorkflowDefinitionRoleChannelRename(input, nextTarget = null) {
  const oldKey = input.getAttribute("data-role-channel-key-original") || "";
  const newKey = (input.value || "").trim();
  if (!oldKey) {
    input.value = newKey;
    return;
  }
  if (!newKey) {
    input.value = isWorkflowDefinitionDraftChannelKey(oldKey) ? "" : oldKey;
    return;
  }
  if (newKey === oldKey) return;
  try {
    renameWorkflowDefinitionRoleChannel(oldKey, newKey);
    input.setAttribute("data-role-channel-key-original", newKey);
    if (
      nextTarget instanceof Element &&
      nextTarget.getAttribute("data-role-channel") === oldKey
    ) {
      const valueInput = workflowDefinitionRoleInspector?.querySelector(
        getWorkflowDefinitionInspectorSelector("data-role-channel", newKey),
      );
      if (valueInput instanceof HTMLInputElement) valueInput.focus();
    }
  } catch (err) {
    input.value = isWorkflowDefinitionDraftChannelKey(oldKey) ? "" : oldKey;
    alert(err instanceof Error ? err.message : "重命名 channel 失败");
  }
}

function deleteWorkflowDefinitionRoleChannel(channelKey) {
  if (!workflowDefinitionSelectedRoleKey || !channelKey) return;
  applyWorkflowDefinitionRolePatch(workflowDefinitionSelectedRoleKey, (role) => {
    role.channels = role.channels || {};
    delete role.channels[channelKey];
    return cleanupWorkflowDefinitionRoleObject(role);
  });
}

function createWorkflowDefinitionEntryPointTemplate() {
  return {
    label: "新入口",
    state: workflowDefinitionSelectedStateKey || "",
  };
}

function createWorkflowDefinitionCreateFormFieldTemplate() {
  return {
    key: "new_field",
    label: "新字段",
    type: "text",
    placeholder: "",
  };
}

function getCurrentWorkflowCardRefs() {
  const workflowCards = workflowDefinitionCardsRegistry?.[currentWorkflowDefinitionKey] || {};
  return Object.keys(workflowCards);
}

function collectWorkflowDefinitionValidationItems(definition, bundleKey) {
  const items = [];
  const roles = definition?.roles || {};
  const states = definition?.states || {};
  const entryPoints = definition?.entry_points || {};
  const statusLabels = definition?.status_labels || {};
  const createForm = definition?.create_form || {};
  const createFields = Array.isArray(createForm.fields) ? createForm.fields : [];
  const roleOptions = Object.keys(roles);
  const stateOptions = Object.keys(states);
  const entryPointOptions = Object.keys(entryPoints);
  const workflowCards = Object.keys(workflowDefinitionCardsRegistry?.[bundleKey || ""] || {});
  const pushItem = (group, message) => {
    items.push({ group, message });
  };

  Object.entries(entryPoints).forEach(([entryKey, entry]) => {
    if (entry?.state && !stateOptions.includes(entry.state)) {
      pushItem("entry_points", `entry_points.${entryKey}.state 引用了不存在的 state: ${entry.state}`);
    }
    if (entry?.deliverable_role && !roleOptions.includes(entry.deliverable_role)) {
      pushItem("entry_points", `entry_points.${entryKey}.deliverable_role 引用了不存在的 role: ${entry.deliverable_role}`);
    }
  });

  Object.entries(states).forEach(([stateKey, state]) => {
    if (state?.delegate?.role && !roleOptions.includes(state.delegate.role)) {
      pushItem("states", `states.${stateKey}.delegate.role 引用了不存在的 role: ${state.delegate.role}`);
    }
    if (state?.card?.ref && !workflowCards.includes(state.card.ref)) {
      pushItem("cards", `states.${stateKey}.card.ref 引用了不存在的 card: ${state.card.ref}`);
    }
    [
      ["on_complete.success", state?.on_complete?.success],
      ["on_complete.failure", state?.on_complete?.failure],
      ["on_approve", state?.on_approve],
      ["on_revise", state?.on_revise],
    ].forEach(([path, transition]) => {
      if (!transition) return;
      if (transition.target && !stateOptions.includes(transition.target)) {
        pushItem("states", `states.${stateKey}.${path}.target 引用了不存在的 state: ${transition.target}`);
      }
      if (transition.delegate?.role && !roleOptions.includes(transition.delegate.role)) {
        pushItem("roles", `states.${stateKey}.${path}.delegate.role 引用了不存在的 role: ${transition.delegate.role}`);
      }
      if (transition.card?.ref && !workflowCards.includes(transition.card.ref)) {
        pushItem("cards", `states.${stateKey}.${path}.card.ref 引用了不存在的 card: ${transition.card.ref}`);
      }
    });
  });

  Object.keys(statusLabels).forEach((stateKey) => {
    if (!stateOptions.includes(stateKey)) {
      pushItem("status_labels", `status_labels.${stateKey} 对应的 state 不存在`);
    }
  });

  const createFieldKeys = new Set();
  createFields.forEach((field, index) => {
    const path = `create_form.fields[${index}]`;
    if (!field?.key) {
      pushItem("create_form", `${path}.key 不能为空`);
    } else if (createFieldKeys.has(field.key)) {
      pushItem("create_form", `${path}.key 重复：${field.key}`);
    } else {
      createFieldKeys.add(field.key);
    }
    if (Array.isArray(field?.visible_when?.entry_points)) {
      field.visible_when.entry_points.forEach((entryKey) => {
        if (!entryPointOptions.includes(entryKey)) {
          pushItem("create_form", `${path}.visible_when.entry_points 引用了不存在的 entry point: ${entryKey}`);
        }
      });
    }
    const equals = field?.visible_when?.equals;
    if (equals && typeof equals === "object") {
      Object.keys(equals).forEach((depKey) => {
        if (!createFields.some((item) => item?.key === depKey)) {
          pushItem("create_form", `${path}.visible_when.equals 引用了不存在的字段: ${depKey}`);
        }
      });
    }
  });
  if (!Object.keys(entryPoints).length) {
    pushItem("entry_points", "entry_points 不能为空");
  }
  if (!Object.keys(states).length) {
    pushItem("states", "states 不能为空");
  }
  return items;
}

function createWorkflowDefinitionStateTemplate(type) {
  if (type === "delegation") {
    return {
      type: "delegation",
      label: "新状态",
      delegate: {
        role: "",
      },
      on_complete: {
        success: {
          target: "",
        },
        failure: {
          target: "",
        },
      },
    };
  }
  if (type === "confirmation") {
    return {
      type: "confirmation",
      label: "新确认状态",
      card: {
        ref: "",
      },
      on_approve: {
        target: "",
      },
      on_revise: {
        target: "",
      },
    };
  }
  return {
    type,
    label: "新状态",
  };
}

function collectWorkflowDefinitionStateReferences(stateKey, states, entryPoints) {
  const refs = [];
  Object.entries(entryPoints || {}).forEach(([entryKey, entry]) => {
    if (entry?.state === stateKey) {
      refs.push(`entry_points.${entryKey}`);
    }
  });
  Object.entries(states || {}).forEach(([otherStateKey, state]) => {
    if (state?.on_complete?.success?.target === stateKey) {
      refs.push(`states.${otherStateKey}.on_complete.success.target`);
    }
    if (state?.on_complete?.failure?.target === stateKey) {
      refs.push(`states.${otherStateKey}.on_complete.failure.target`);
    }
    if (state?.on_approve?.target === stateKey) {
      refs.push(`states.${otherStateKey}.on_approve.target`);
    }
    if (state?.on_revise?.target === stateKey) {
      refs.push(`states.${otherStateKey}.on_revise.target`);
    }
  });
  return refs;
}

function applyWorkflowDefinitionStatePatch(stateKey, updater) {
  if (!stateKey) return;
  try {
    const states = getStatesFromEditor();
    const currentState = cloneJson(states[stateKey] || {});
    states[stateKey] = updater(currentState) || currentState;
    updateStatesEditor(states);
    const editable = getEditableWorkflowDefinition();
    if (editable) {
      editable.states = states;
    }
    renderWorkflowDefinitionStateEditor(states);
    renderWorkflowDefinitionGraph({
      states,
      entry_points: editable?.entry_points || {},
    });
  } catch (err) {
    console.error("Failed to patch state inspector:", err);
    showToast(err instanceof Error ? err.message : "State 配置解析失败", 2200);
  }
}

function applyWorkflowDefinitionRolePatch(roleKey, updater) {
  if (!roleKey) return;
  try {
    const roles = getRolesFromEditor();
    roles[roleKey] = updater(cloneJson(roles[roleKey] || {})) || roles[roleKey];
    updateRolesEditor(roles);
    const editable = getEditableWorkflowDefinition();
    if (editable) editable.roles = roles;
    renderWorkflowDefinitionRoleEditor(roles);
    renderWorkflowDefinitionStateEditor();
  } catch (err) {
    showToast(err instanceof Error ? err.message : "Role 配置解析失败", 2200);
  }
}

function getWorkflowDefinitionInspectorSelector(attributeName, attributeValue) {
  if (!attributeName) return "";
  const safeValue =
    typeof CSS !== "undefined" && CSS && typeof CSS.escape === "function"
      ? CSS.escape(String(attributeValue || ""))
      : String(attributeValue || "").replace(/["\\]/g, "\\$&");
  return `[${attributeName}="${safeValue}"]`;
}

function captureWorkflowDefinitionInspectorSelection(el) {
  return {
    start: typeof el?.selectionStart === "number" ? el.selectionStart : null,
    end: typeof el?.selectionEnd === "number" ? el.selectionEnd : null,
  };
}

function restoreWorkflowDefinitionInspectorFocus(root, selector, selection) {
  if (!root || !selector) return;
  const nextField = root.querySelector(selector);
  if (!nextField || typeof nextField.focus !== "function") return;
  nextField.focus();
  if (
    typeof selection?.start === "number" &&
    typeof selection?.end === "number" &&
    typeof nextField.setSelectionRange === "function"
  ) {
    nextField.setSelectionRange(selection.start, selection.end);
  }
}

function applyWorkflowDefinitionEntryPointPatch(entryKey, updater) {
  if (!entryKey) return;
  try {
    const entryPoints = getEntryPointsFromEditor();
    entryPoints[entryKey] = updater(cloneJson(entryPoints[entryKey] || {})) || entryPoints[entryKey];
    updateEntryPointsEditor(entryPoints);
    const editable = getEditableWorkflowDefinition();
    if (editable) editable.entry_points = entryPoints;
    renderWorkflowDefinitionEntryPointEditor(entryPoints);
    renderWorkflowDefinitionGraph({
      states: editable?.states || getStatesFromEditor(),
      entry_points: entryPoints,
    });
  } catch (err) {
    showToast(err instanceof Error ? err.message : "Entry Point 配置解析失败", 2200);
  }
}

function applyWorkflowDefinitionStatusLabelPatch(stateKey, updater) {
  if (!stateKey) return;
  try {
    const statusLabels = getStatusLabelsFromEditor();
    statusLabels[stateKey] = updater(statusLabels[stateKey] || "");
    updateStatusLabelsEditor(statusLabels);
    const editable = getEditableWorkflowDefinition();
    if (editable) editable.status_labels = statusLabels;
    renderWorkflowDefinitionStatusLabelEditor(statusLabels);
  } catch (err) {
    showToast(err instanceof Error ? err.message : "Status Label 配置解析失败", 2200);
  }
}

function applyWorkflowDefinitionCreateFormPatch(updater) {
  try {
    const createForm = getCreateFormFromEditor();
    const nextCreateForm = updater(cloneJson(createForm)) || createForm;
    if (!Array.isArray(nextCreateForm.fields)) nextCreateForm.fields = [];
    updateCreateFormEditor(nextCreateForm);
    renderWorkflowDefinitionCreateFormEditor(nextCreateForm);
  } catch (err) {
    showToast(err instanceof Error ? err.message : "Create Form 配置解析失败", 2200);
  }
}

async function addWorkflowDefinitionCreateFormField() {
  const rawKey = await openTextPrompt("输入新的表单字段 key", "", { title: "新增 Create Form 字段" });
  const fieldKey = (rawKey || "").trim();
  if (!fieldKey) return;
  if (!/^[a-zA-Z0-9_-]+$/.test(fieldKey)) {
    alert("字段 key 仅支持字母、数字、_ 和 -");
    return;
  }
  applyWorkflowDefinitionCreateFormPatch((createForm) => {
    createForm.fields = Array.isArray(createForm.fields) ? createForm.fields : [];
    if (createForm.fields.some((field) => field?.key === fieldKey)) {
      throw new Error(`字段 "${fieldKey}" 已存在`);
    }
    const nextField = createWorkflowDefinitionCreateFormFieldTemplate();
    nextField.key = fieldKey;
    nextField.label = fieldKey;
    createForm.fields.push(nextField);
    workflowDefinitionSelectedCreateFormFieldKey = fieldKey;
    return createForm;
  });
}

async function renameWorkflowDefinitionCreateFormField() {
  if (!workflowDefinitionSelectedCreateFormFieldKey) return;
  const oldKey = workflowDefinitionSelectedCreateFormFieldKey;
  const rawKey = await openTextPrompt("输入新的字段 key", oldKey, { title: "重命名 Create Form 字段" });
  const newKey = (rawKey || "").trim();
  if (!newKey || newKey === oldKey) return;
  if (!/^[a-zA-Z0-9_-]+$/.test(newKey)) {
    alert("字段 key 仅支持字母、数字、_ 和 -");
    return;
  }
  applyWorkflowDefinitionCreateFormPatch((createForm) => {
    createForm.fields = Array.isArray(createForm.fields) ? createForm.fields : [];
    if (createForm.fields.some((field) => field?.key === newKey)) {
      throw new Error(`字段 "${newKey}" 已存在`);
    }
    createForm.fields.forEach((field) => {
      if (field?.key === oldKey) {
        field.key = newKey;
      }
      const equals = field?.visible_when?.equals;
      if (equals && typeof equals === "object" && Object.prototype.hasOwnProperty.call(equals, oldKey)) {
        equals[newKey] = equals[oldKey];
        delete equals[oldKey];
      }
    });
    if (Array.isArray(createForm.name_field_keys)) {
      createForm.name_field_keys = createForm.name_field_keys.map((key) => (key === oldKey ? newKey : key));
    }
    workflowDefinitionSelectedCreateFormFieldKey = newKey;
    return createForm;
  });
}

async function deleteWorkflowDefinitionCreateFormField() {
  if (!workflowDefinitionSelectedCreateFormFieldKey) return;
  const fieldKey = workflowDefinitionSelectedCreateFormFieldKey;
  if (!(await openConfirmDialog(`确认删除字段 "${fieldKey}" 吗？`, { title: "删除 Create Form 字段" }))) return;
  applyWorkflowDefinitionCreateFormPatch((createForm) => {
    createForm.fields = (createForm.fields || []).filter((field) => field?.key !== fieldKey);
    createForm.fields.forEach((field) => {
      const equals = field?.visible_when?.equals;
      if (equals && typeof equals === "object" && Object.prototype.hasOwnProperty.call(equals, fieldKey)) {
        delete equals[fieldKey];
        if (!Object.keys(equals).length) delete field.visible_when.equals;
      }
    });
    if (Array.isArray(createForm.name_field_keys)) {
      createForm.name_field_keys = createForm.name_field_keys.filter((key) => key !== fieldKey);
    }
    workflowDefinitionSelectedCreateFormFieldKey = createForm.fields[0]?.key || "";
    return createForm;
  });
}

function renderWorkflowDefinitionCreateFormEditor(createFormArg) {
  if (!workflowDefinitionCreateFormFieldList || !workflowDefinitionCreateFormInspector) return;
  const createForm = createFormArg || getCreateFormFromEditor();
  const fields = Array.isArray(createForm.fields) ? createForm.fields : [];
  if (!workflowDefinitionSelectedCreateFormFieldKey || !fields.some((field) => field?.key === workflowDefinitionSelectedCreateFormFieldKey)) {
    workflowDefinitionSelectedCreateFormFieldKey = fields[0]?.key || "";
  }
  workflowDefinitionCreateFormFieldList.innerHTML = fields.length
    ? fields
        .map((field) => {
          const key = field?.key || "";
          const active = workflowDefinitionSelectedCreateFormFieldKey === key;
          return `
            <button type="button" class="workflow-definition-state-list-item${active ? " active" : ""}" data-create-form-field-select="${escapeAttribute(key)}">
              <strong>${escapeHtml(field?.label || key || "未命名字段")}</strong>
              <span>${escapeHtml(key || "--")} · ${escapeHtml(field?.type || "--")}</span>
            </button>
          `;
        })
        .join("")
    : '<div class="workflow-definition-state-list-empty">暂无 create form 字段，可先新增。</div>';
  Array.from(workflowDefinitionCreateFormFieldList.querySelectorAll("[data-create-form-field-select]")).forEach((button) => {
    button.addEventListener("click", () => {
      workflowDefinitionSelectedCreateFormFieldKey = button.getAttribute("data-create-form-field-select") || "";
      renderWorkflowDefinitionCreateFormEditor(createForm);
    });
  });

  const selectedField = fields.find((field) => field?.key === workflowDefinitionSelectedCreateFormFieldKey) || null;
  const availableEntryPoints = Object.keys(getEntryPointsFromEditor());
  const availableFieldKeys = fields.map((field) => field?.key).filter(Boolean);
  const legacyNameFieldKeys = Array.isArray(createForm.name_field_keys) ? createForm.name_field_keys : [];
  const visibleEqualsEntries = selectedField?.visible_when?.equals && typeof selectedField.visible_when.equals === "object"
    ? Object.entries(selectedField.visible_when.equals)
    : [];
  const optionEntries = Array.isArray(selectedField?.options) ? selectedField.options : [];

  workflowDefinitionCreateFormInspector.innerHTML = `
    <div class="workflow-definition-state-inspector-head">
      <span>Create Form</span>
      ${
        selectedField
          ? `<div class="workflow-definition-state-head-actions">
              <button type="button" class="btn-ghost" data-create-form-action="rename">重命名</button>
              <button type="button" class="btn-ghost" data-create-form-action="delete">删除</button>
            </div>`
          : ""
      }
    </div>
    <div class="workflow-definition-state-inspector-body">
      <section class="workflow-definition-state-inspector-section">
        <div class="workflow-definition-state-inspector-title">
          <span>Task Title</span>
        </div>
        <div class="workflow-definition-panel-note">
          任务名称已固定为系统字段 <code>title</code>，不再从 create form 字段中选择来源。
          ${
            legacyNameFieldKeys.length > 0
              ? ` 当前遗留 name_field_keys：${escapeHtml(legacyNameFieldKeys.join(", "))}`
              : ""
          }
        </div>
        ${
          legacyNameFieldKeys.length > 0
            ? '<div class="workflow-definition-inline-actions"><button type="button" class="btn-ghost" data-create-form-clear-name-keys>清空遗留配置</button></div>'
            : ""
        }
      </section>
      ${
        selectedField
          ? `
            <div class="workflow-definition-state-inspector-grid">
              <label class="workflow-definition-field">
                <span>Field Key</span>
                <input data-create-form-field="key" type="text" value="${escapeAttribute(selectedField.key || "")}" readonly />
              </label>
              <label class="workflow-definition-field">
                <span>Type</span>
                <select data-create-form-field="type">
                  ${["text", "choice", "requirement_select"]
                    .map((type) => `<option value="${type}" ${selectedField.type === type ? "selected" : ""}>${type}</option>`)
                    .join("")}
                </select>
              </label>
            </div>
            <div class="workflow-definition-state-inspector-grid">
              <label class="workflow-definition-field">
                <span>Label</span>
                <input data-create-form-field="label" type="text" value="${escapeAttribute(selectedField.label || "")}" />
              </label>
              <label class="workflow-definition-field">
                <span>Default Value</span>
                <input data-create-form-field="default_value" type="text" value="${escapeAttribute(selectedField.default_value || "")}" />
              </label>
            </div>
            <label class="workflow-definition-field workflow-definition-field-block">
              <span>Placeholder</span>
              <input data-create-form-field="placeholder" type="text" value="${escapeAttribute(selectedField.placeholder || "")}" />
            </label>
            <label class="workflow-definition-field workflow-definition-field-block">
              <span>Helper Text</span>
              <textarea data-create-form-field="helper_text" rows="2">${escapeHtml(selectedField.helper_text || "")}</textarea>
            </label>
            <label class="workflow-definition-field workflow-definition-checkbox-field">
              <span class="workflow-definition-checkbox-title">Searchable</span>
              <span class="workflow-definition-checkbox-control">
                <input data-create-form-field="searchable" type="checkbox" ${selectedField.searchable ? "checked" : ""} />
                <span class="workflow-definition-switch" aria-hidden="true">
                  <span class="workflow-definition-switch-track"></span>
                  <span class="workflow-definition-switch-thumb"></span>
                </span>
                <span class="workflow-definition-checkbox-text">${selectedField.searchable ? "已启用" : "未启用"}</span>
              </span>
            </label>
            <section class="workflow-definition-state-inspector-section">
              <div class="workflow-definition-state-inspector-title">
                <span>Visible Entry Points</span>
              </div>
              <div class="workflow-definition-choice-grid">
                ${
                  availableEntryPoints.length
                    ? availableEntryPoints
                        .map(
                          (entryKey) => `
                            <label class="workflow-definition-choice-chip">
                              <input
                                data-create-form-visible-entry-point="${escapeAttribute(entryKey)}"
                                type="checkbox"
                                ${Array.isArray(selectedField.visible_when?.entry_points) && selectedField.visible_when.entry_points.includes(entryKey) ? "checked" : ""}
                              />
                              <span>${escapeHtml(entryKey)}</span>
                            </label>
                          `,
                        )
                        .join("")
                    : '<div class="workflow-definition-state-inspector-empty">当前没有可选 entry point。</div>'
                }
              </div>
            </section>
            <section class="workflow-definition-state-inspector-section">
              <div class="workflow-definition-state-inspector-title">
                <span>Visible Equals</span>
                <span class="workflow-definition-inline-actions">
                  <button type="button" class="btn-ghost" data-create-form-action="add-equals">新增条件</button>
                </span>
              </div>
              ${
                visibleEqualsEntries.length
                  ? visibleEqualsEntries
                      .map(
                        ([depKey, expected]) => `
                          <label class="workflow-definition-field workflow-definition-field-block">
                            <span>条件</span>
                            <div class="workflow-definition-inline-actions">
                              <input
                                data-create-form-equals-key="${escapeAttribute(depKey)}"
                                type="text"
                                value="${escapeAttribute(depKey)}"
                                placeholder="依赖字段 key"
                              />
                              <input
                                data-create-form-equals-value="${escapeAttribute(depKey)}"
                                type="text"
                                value="${escapeAttribute(Array.isArray(expected) ? expected.join(", ") : expected || "")}"
                                placeholder="期望值，多个值用逗号分隔"
                              />
                              <button type="button" class="btn-ghost" data-create-form-equals-delete="${escapeAttribute(depKey)}">删除</button>
                            </div>
                          </label>
                        `,
                      )
                      .join("")
                  : '<div class="workflow-definition-state-inspector-empty">当前没有字段联动条件。</div>'
              }
            </section>
            <section class="workflow-definition-state-inspector-section">
              <div class="workflow-definition-state-inspector-title">
                <span>Options</span>
                <span class="workflow-definition-inline-actions">
                  <button type="button" class="btn-ghost" data-create-form-action="add-option">新增选项</button>
                </span>
              </div>
              ${
                optionEntries.length
                  ? optionEntries
                      .map(
                        (option, index) => `
                          <label class="workflow-definition-field workflow-definition-field-block">
                            <span>选项 ${index + 1}</span>
                            <div class="workflow-definition-inline-actions">
                              <input
                                data-create-form-option-value="${index}"
                                type="text"
                                value="${escapeAttribute(option?.value || "")}"
                                placeholder="value"
                              />
                              <input
                                data-create-form-option-label="${index}"
                                type="text"
                                value="${escapeAttribute(option?.label || "")}"
                                placeholder="label"
                              />
                              <button type="button" class="btn-ghost" data-create-form-option-delete="${index}">删除</button>
                            </div>
                          </label>
                        `,
                      )
                      .join("")
                  : '<div class="workflow-definition-state-inspector-empty">当前没有选项。</div>'
              }
            </section>
            <div class="workflow-definition-panel-note">可引用字段：${escapeHtml(availableFieldKeys.join(", ") || "--")}</div>
          `
          : '<div class="workflow-definition-state-inspector-empty">选择一个字段查看结构化编辑面板。</div>'
      }
    </div>
  `;

  Array.from(workflowDefinitionCreateFormInspector.querySelectorAll("[data-create-form-field]")).forEach((el) => {
    const path = el.getAttribute("data-create-form-field") || "";
    const eventName = el.type === "checkbox" ? "change" : "input";
    el.addEventListener(eventName, () => {
      applyWorkflowDefinitionCreateFormPatch((nextCreateForm) => {
        const field = (nextCreateForm.fields || []).find((item) => item?.key === workflowDefinitionSelectedCreateFormFieldKey);
        if (!field) return nextCreateForm;
        if (el.type === "checkbox") {
          field[path] = !!el.checked;
        } else if (path === "type") {
          field.type = el.value || "text";
        } else if (el.value) {
          field[path] = el.value;
        } else {
          delete field[path];
        }
        return nextCreateForm;
      });
    });
  });

  Array.from(workflowDefinitionCreateFormInspector.querySelectorAll("[data-create-form-visible-entry-point]")).forEach((input) => {
    input.addEventListener("change", () => {
      const entryKey = input.getAttribute("data-create-form-visible-entry-point") || "";
      applyWorkflowDefinitionCreateFormPatch((nextCreateForm) => {
        const field = (nextCreateForm.fields || []).find((item) => item?.key === workflowDefinitionSelectedCreateFormFieldKey);
        if (!field) return nextCreateForm;
        const entryPoints = Array.isArray(field.visible_when?.entry_points) ? [...field.visible_when.entry_points] : [];
        const idx = entryPoints.indexOf(entryKey);
        if (input.checked && idx < 0) entryPoints.push(entryKey);
        if (!input.checked && idx >= 0) entryPoints.splice(idx, 1);
        field.visible_when = field.visible_when || {};
        if (entryPoints.length) field.visible_when.entry_points = entryPoints;
        else delete field.visible_when.entry_points;
        if (!Object.keys(field.visible_when).length) delete field.visible_when;
        return nextCreateForm;
      });
    });
  });

  const renameBtn = workflowDefinitionCreateFormInspector.querySelector("[data-create-form-action='rename']");
  const deleteBtn = workflowDefinitionCreateFormInspector.querySelector("[data-create-form-action='delete']");
  const addEqualsBtn = workflowDefinitionCreateFormInspector.querySelector("[data-create-form-action='add-equals']");
  const addOptionBtn = workflowDefinitionCreateFormInspector.querySelector("[data-create-form-action='add-option']");
  const clearNameKeysBtn = workflowDefinitionCreateFormInspector.querySelector("[data-create-form-clear-name-keys]");
  if (renameBtn) renameBtn.addEventListener("click", () => renameWorkflowDefinitionCreateFormField());
  if (deleteBtn) deleteBtn.addEventListener("click", () => deleteWorkflowDefinitionCreateFormField());
  if (clearNameKeysBtn) {
    clearNameKeysBtn.addEventListener("click", () => {
      applyWorkflowDefinitionCreateFormPatch((nextCreateForm) => {
        delete nextCreateForm.name_field_keys;
        return nextCreateForm;
      });
    });
  }
  if (addEqualsBtn) {
    addEqualsBtn.addEventListener("click", () => {
      applyWorkflowDefinitionCreateFormPatch((nextCreateForm) => {
        const field = (nextCreateForm.fields || []).find((item) => item?.key === workflowDefinitionSelectedCreateFormFieldKey);
        if (!field) return nextCreateForm;
        field.visible_when = field.visible_when || {};
        field.visible_when.equals = field.visible_when.equals || {};
        let idx = 1;
        let key = "field_key";
        while (Object.prototype.hasOwnProperty.call(field.visible_when.equals, key)) {
          idx += 1;
          key = `field_key_${idx}`;
        }
        field.visible_when.equals[key] = "";
        return nextCreateForm;
      });
    });
  }
  if (addOptionBtn) {
    addOptionBtn.addEventListener("click", () => {
      applyWorkflowDefinitionCreateFormPatch((nextCreateForm) => {
        const field = (nextCreateForm.fields || []).find((item) => item?.key === workflowDefinitionSelectedCreateFormFieldKey);
        if (!field) return nextCreateForm;
        field.options = Array.isArray(field.options) ? field.options : [];
        field.options.push({ value: "", label: "" });
        return nextCreateForm;
      });
    });
  }
  Array.from(workflowDefinitionCreateFormInspector.querySelectorAll("[data-create-form-equals-key]")).forEach((input) => {
    input.addEventListener("change", () => {
      const oldKey = input.getAttribute("data-create-form-equals-key") || "";
      const newKey = (input.value || "").trim();
      if (!oldKey || !newKey || oldKey === newKey) {
        renderWorkflowDefinitionCreateFormEditor(getCreateFormFromEditor());
        return;
      }
      applyWorkflowDefinitionCreateFormPatch((nextCreateForm) => {
        const field = (nextCreateForm.fields || []).find((item) => item?.key === workflowDefinitionSelectedCreateFormFieldKey);
        const equals = field?.visible_when?.equals;
        if (!field || !equals || typeof equals !== "object") return nextCreateForm;
        if (Object.prototype.hasOwnProperty.call(equals, newKey)) {
          throw new Error(`条件字段 "${newKey}" 已存在`);
        }
        equals[newKey] = equals[oldKey];
        delete equals[oldKey];
        return nextCreateForm;
      });
    });
  });
  Array.from(workflowDefinitionCreateFormInspector.querySelectorAll("[data-create-form-equals-value]")).forEach((input) => {
    input.addEventListener("input", () => {
      const depKey = input.getAttribute("data-create-form-equals-value") || "";
      applyWorkflowDefinitionCreateFormPatch((nextCreateForm) => {
        const field = (nextCreateForm.fields || []).find((item) => item?.key === workflowDefinitionSelectedCreateFormFieldKey);
        const equals = field?.visible_when?.equals;
        if (!field || !equals || typeof equals !== "object" || !depKey) return nextCreateForm;
        const parts = (input.value || "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
        equals[depKey] = parts.length <= 1 ? parts[0] || "" : parts;
        return nextCreateForm;
      });
    });
  });
  Array.from(workflowDefinitionCreateFormInspector.querySelectorAll("[data-create-form-equals-delete]")).forEach((button) => {
    button.addEventListener("click", () => {
      const depKey = button.getAttribute("data-create-form-equals-delete") || "";
      applyWorkflowDefinitionCreateFormPatch((nextCreateForm) => {
        const field = (nextCreateForm.fields || []).find((item) => item?.key === workflowDefinitionSelectedCreateFormFieldKey);
        const equals = field?.visible_when?.equals;
        if (!field || !equals || typeof equals !== "object" || !depKey) return nextCreateForm;
        delete equals[depKey];
        if (!Object.keys(equals).length) delete field.visible_when.equals;
        if (field.visible_when && !Object.keys(field.visible_when).length) delete field.visible_when;
        return nextCreateForm;
      });
    });
  });
  Array.from(workflowDefinitionCreateFormInspector.querySelectorAll("[data-create-form-option-value]")).forEach((input) => {
    input.addEventListener("input", () => {
      const index = Number(input.getAttribute("data-create-form-option-value"));
      applyWorkflowDefinitionCreateFormPatch((nextCreateForm) => {
        const field = (nextCreateForm.fields || []).find((item) => item?.key === workflowDefinitionSelectedCreateFormFieldKey);
        if (!field || !Array.isArray(field.options) || !field.options[index]) return nextCreateForm;
        field.options[index].value = input.value || "";
        return nextCreateForm;
      });
    });
  });
  Array.from(workflowDefinitionCreateFormInspector.querySelectorAll("[data-create-form-option-label]")).forEach((input) => {
    input.addEventListener("input", () => {
      const index = Number(input.getAttribute("data-create-form-option-label"));
      applyWorkflowDefinitionCreateFormPatch((nextCreateForm) => {
        const field = (nextCreateForm.fields || []).find((item) => item?.key === workflowDefinitionSelectedCreateFormFieldKey);
        if (!field || !Array.isArray(field.options) || !field.options[index]) return nextCreateForm;
        field.options[index].label = input.value || "";
        return nextCreateForm;
      });
    });
  });
  Array.from(workflowDefinitionCreateFormInspector.querySelectorAll("[data-create-form-option-delete]")).forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.getAttribute("data-create-form-option-delete"));
      applyWorkflowDefinitionCreateFormPatch((nextCreateForm) => {
        const field = (nextCreateForm.fields || []).find((item) => item?.key === workflowDefinitionSelectedCreateFormFieldKey);
        if (!field || !Array.isArray(field.options)) return nextCreateForm;
        field.options.splice(index, 1);
        if (!field.options.length) delete field.options;
        return nextCreateForm;
      });
    });
  });
}

async function addWorkflowDefinitionState() {
  const rawKey = await openTextPrompt("输入新的 state key", "", { title: "新增 State" });
  const stateKey = (rawKey || "").trim();
  if (!stateKey) return;
  if (!/^[a-zA-Z0-9_-]+$/.test(stateKey)) {
    alert("state key 仅支持字母、数字、_ 和 -");
    return;
  }
  try {
    const states = getStatesFromEditor();
    if (states[stateKey]) {
      alert(`state "${stateKey}" 已存在`);
      return;
    }
    const rawType = await openTextPrompt(
      "输入 state type（delegation / confirmation / terminal / system）",
      "delegation",
      { title: "新增 State" },
    );
    const type = (rawType || "delegation").trim();
    if (!["delegation", "confirmation", "terminal", "system"].includes(type)) {
      alert("state type 不合法");
      return;
    }
    states[stateKey] = createWorkflowDefinitionStateTemplate(type);
    updateStatesEditor(states);
    const editable = getEditableWorkflowDefinition();
    if (editable) editable.states = states;
    updateWorkflowDefinitionSelectedState(stateKey);
    showToast(`已新增 state: ${stateKey}`);
  } catch (err) {
    alert(err instanceof Error ? err.message : "新增 state 失败");
  }
}

async function addWorkflowDefinitionRole() {
  const rawKey = await openTextPrompt("输入新的 role key", "", { title: "新增 Role" });
  const roleKey = (rawKey || "").trim();
  if (!roleKey) return;
  if (!/^[a-zA-Z0-9_-]+$/.test(roleKey)) {
    alert("role key 仅支持字母、数字、_ 和 -");
    return;
  }
  try {
    const roles = getRolesFromEditor();
    if (roles[roleKey]) {
      alert(`role "${roleKey}" 已存在`);
      return;
    }
    roles[roleKey] = createWorkflowDefinitionRoleTemplate();
    updateRolesEditor(roles);
    const editable = getEditableWorkflowDefinition();
    if (editable) editable.roles = roles;
    workflowDefinitionSelectedRoleKey = roleKey;
    renderWorkflowDefinitionRoleEditor(roles);
    renderWorkflowDefinitionStateEditor();
    showToast(`已新增 role: ${roleKey}`);
  } catch (err) {
    alert(err instanceof Error ? err.message : "新增 role 失败");
  }
}

async function renameWorkflowDefinitionRole() {
  if (!workflowDefinitionSelectedRoleKey) return;
  const oldKey = workflowDefinitionSelectedRoleKey;
  const rawKey = await openTextPrompt("输入新的 role key", oldKey, { title: "重命名 Role" });
  const newKey = (rawKey || "").trim();
  if (!newKey || newKey === oldKey) return;
  if (!/^[a-zA-Z0-9_-]+$/.test(newKey)) {
    alert("role key 仅支持字母、数字、_ 和 -");
    return;
  }
  try {
    const roles = getRolesFromEditor();
    const states = getStatesFromEditor();
    const entryPoints = getEntryPointsFromEditor();
    if (roles[newKey]) {
      alert(`role "${newKey}" 已存在`);
      return;
    }
    const nextRoles = {};
    Object.entries(roles).forEach(([key, role]) => {
      nextRoles[key === oldKey ? newKey : key] = role;
    });
    Object.values(entryPoints).forEach((entry) => {
      if (entry?.deliverable_role === oldKey) entry.deliverable_role = newKey;
    });
    Object.values(states).forEach((state) => {
      if (state?.delegate?.role === oldKey) state.delegate.role = newKey;
      if (state?.on_complete?.success?.delegate?.role === oldKey) state.on_complete.success.delegate.role = newKey;
      if (state?.on_complete?.failure?.delegate?.role === oldKey) state.on_complete.failure.delegate.role = newKey;
      if (state?.on_approve?.delegate?.role === oldKey) state.on_approve.delegate.role = newKey;
      if (state?.on_revise?.delegate?.role === oldKey) state.on_revise.delegate.role = newKey;
    });
    updateRolesEditor(nextRoles);
    updateEntryPointsEditor(entryPoints);
    updateStatesEditor(states);
    const editable = getEditableWorkflowDefinition();
    if (editable) {
      editable.roles = nextRoles;
      editable.entry_points = entryPoints;
      editable.states = states;
    }
    workflowDefinitionSelectedRoleKey = newKey;
    renderWorkflowDefinitionRoleEditor(nextRoles);
    renderWorkflowDefinitionEntryPointEditor(entryPoints);
    renderWorkflowDefinitionStateEditor(states);
    showToast(`已重命名 role: ${oldKey} -> ${newKey}`);
  } catch (err) {
    alert(err instanceof Error ? err.message : "重命名 role 失败");
  }
}

async function deleteWorkflowDefinitionRole() {
  if (!workflowDefinitionSelectedRoleKey) return;
  try {
    const roles = getRolesFromEditor();
    const states = getStatesFromEditor();
    const entryPoints = getEntryPointsFromEditor();
    const refs = collectWorkflowDefinitionRoleReferences(workflowDefinitionSelectedRoleKey, states, entryPoints);
    if (refs.length > 0) {
      alert(`该 role 仍被引用，无法删除：\n\n${refs.join("\n")}`);
      return;
    }
    if (!(await openConfirmDialog(`确认删除 role "${workflowDefinitionSelectedRoleKey}" 吗？`, { title: "删除 Role" }))) return;
    delete roles[workflowDefinitionSelectedRoleKey];
    updateRolesEditor(roles);
    const editable = getEditableWorkflowDefinition();
    if (editable) editable.roles = roles;
    workflowDefinitionSelectedRoleKey = Object.keys(roles)[0] || "";
    renderWorkflowDefinitionRoleEditor(roles);
    renderWorkflowDefinitionStateEditor();
    renderWorkflowDefinitionEntryPointEditor(entryPoints);
    showToast("已删除 role");
  } catch (err) {
    alert(err instanceof Error ? err.message : "删除 role 失败");
  }
}

async function addWorkflowDefinitionEntryPoint() {
  const rawKey = await openTextPrompt("输入新的 entry point key", "", { title: "新增 Entry Point" });
  const entryKey = (rawKey || "").trim();
  if (!entryKey) return;
  if (!/^[a-zA-Z0-9_-]+$/.test(entryKey)) {
    alert("entry point key 仅支持字母、数字、_ 和 -");
    return;
  }
  try {
    const entryPoints = getEntryPointsFromEditor();
    if (entryPoints[entryKey]) {
      alert(`entry point "${entryKey}" 已存在`);
      return;
    }
    entryPoints[entryKey] = createWorkflowDefinitionEntryPointTemplate();
    updateEntryPointsEditor(entryPoints);
    const editable = getEditableWorkflowDefinition();
    if (editable) editable.entry_points = entryPoints;
    workflowDefinitionSelectedEntryPointKey = entryKey;
    renderWorkflowDefinitionEntryPointEditor(entryPoints);
    renderWorkflowDefinitionGraph({
      states: editable?.states || getStatesFromEditor(),
      entry_points: entryPoints,
    });
    showToast(`已新增 entry point: ${entryKey}`);
  } catch (err) {
    alert(err instanceof Error ? err.message : "新增 entry point 失败");
  }
}

async function renameWorkflowDefinitionEntryPoint() {
  if (!workflowDefinitionSelectedEntryPointKey) return;
  const oldKey = workflowDefinitionSelectedEntryPointKey;
  const rawKey = await openTextPrompt("输入新的 entry point key", oldKey, { title: "重命名 Entry Point" });
  const newKey = (rawKey || "").trim();
  if (!newKey || newKey === oldKey) return;
  if (!/^[a-zA-Z0-9_-]+$/.test(newKey)) {
    alert("entry point key 仅支持字母、数字、_ 和 -");
    return;
  }
  try {
    const entryPoints = getEntryPointsFromEditor();
    if (entryPoints[newKey]) {
      alert(`entry point "${newKey}" 已存在`);
      return;
    }
    const nextEntryPoints = {};
    Object.entries(entryPoints).forEach(([key, entry]) => {
      nextEntryPoints[key === oldKey ? newKey : key] = entry;
    });
    updateEntryPointsEditor(nextEntryPoints);
    const editable = getEditableWorkflowDefinition();
    if (editable) editable.entry_points = nextEntryPoints;
    workflowDefinitionSelectedEntryPointKey = newKey;
    renderWorkflowDefinitionEntryPointEditor(nextEntryPoints);
    renderWorkflowDefinitionGraph({
      states: editable?.states || getStatesFromEditor(),
      entry_points: nextEntryPoints,
    });
    showToast(`已重命名 entry point: ${oldKey} -> ${newKey}`);
  } catch (err) {
    alert(err instanceof Error ? err.message : "重命名 entry point 失败");
  }
}

async function deleteWorkflowDefinitionEntryPoint() {
  if (!workflowDefinitionSelectedEntryPointKey) return;
  try {
    const entryPoints = getEntryPointsFromEditor();
    if (
      !(await openConfirmDialog(`确认删除 entry point "${workflowDefinitionSelectedEntryPointKey}" 吗？`, {
        title: "删除 Entry Point",
      }))
    ) return;
    delete entryPoints[workflowDefinitionSelectedEntryPointKey];
    updateEntryPointsEditor(entryPoints);
    const editable = getEditableWorkflowDefinition();
    if (editable) editable.entry_points = entryPoints;
    workflowDefinitionSelectedEntryPointKey = Object.keys(entryPoints)[0] || "";
    renderWorkflowDefinitionEntryPointEditor(entryPoints);
    renderWorkflowDefinitionGraph({
      states: editable?.states || getStatesFromEditor(),
      entry_points: entryPoints,
    });
    showToast("已删除 entry point");
  } catch (err) {
    alert(err instanceof Error ? err.message : "删除 entry point 失败");
  }
}

async function addWorkflowDefinitionStatusLabel() {
  const sourceStateKey = workflowDefinitionSelectedStateKey || Object.keys(getStatesFromEditor())[0] || "";
  const rawKey = await openTextPrompt("输入要绑定的 state key", sourceStateKey, {
    title: "新增 Status Label",
  });
  const stateKey = (rawKey || "").trim();
  if (!stateKey) return;
  try {
    const statusLabels = getStatusLabelsFromEditor();
    if (statusLabels[stateKey]) {
      alert(`status label "${stateKey}" 已存在`);
      return;
    }
    statusLabels[stateKey] = "";
    updateStatusLabelsEditor(statusLabels);
    const editable = getEditableWorkflowDefinition();
    if (editable) editable.status_labels = statusLabels;
    workflowDefinitionSelectedStatusLabelKey = stateKey;
    renderWorkflowDefinitionStatusLabelEditor(statusLabels);
    showToast(`已新增 status label: ${stateKey}`);
  } catch (err) {
    alert(err instanceof Error ? err.message : "新增 status label 失败");
  }
}

async function deleteWorkflowDefinitionStatusLabel() {
  if (!workflowDefinitionSelectedStatusLabelKey) return;
  try {
    const statusLabels = getStatusLabelsFromEditor();
    if (
      !(await openConfirmDialog(`确认删除 status label "${workflowDefinitionSelectedStatusLabelKey}" 吗？`, {
        title: "删除 Status Label",
      }))
    ) return;
    delete statusLabels[workflowDefinitionSelectedStatusLabelKey];
    updateStatusLabelsEditor(statusLabels);
    const editable = getEditableWorkflowDefinition();
    if (editable) editable.status_labels = statusLabels;
    workflowDefinitionSelectedStatusLabelKey = Object.keys(statusLabels)[0] || "";
    renderWorkflowDefinitionStatusLabelEditor(statusLabels);
    showToast("已删除 status label");
  } catch (err) {
    alert(err instanceof Error ? err.message : "删除 status label 失败");
  }
}

async function renameWorkflowDefinitionState() {
  if (!workflowDefinitionSelectedStateKey) return;
  const oldKey = workflowDefinitionSelectedStateKey;
  const rawKey = await openTextPrompt("输入新的 state key", oldKey, { title: "重命名 State" });
  const newKey = (rawKey || "").trim();
  if (!newKey || newKey === oldKey) return;
  if (!/^[a-zA-Z0-9_-]+$/.test(newKey)) {
    alert("state key 仅支持字母、数字、_ 和 -");
    return;
  }
  try {
    const states = getStatesFromEditor();
    const entryPoints = getEntryPointsFromEditor();
    const statusLabels = getStatusLabelsFromEditor();
    if (!states[oldKey]) return;
    if (states[newKey]) {
      alert(`state "${newKey}" 已存在`);
      return;
    }
    const nextStates = {};
    Object.entries(states).forEach(([key, state]) => {
      const actualKey = key === oldKey ? newKey : key;
      const clonedState = cloneJson(state);
      if (clonedState?.on_complete?.success?.target === oldKey) clonedState.on_complete.success.target = newKey;
      if (clonedState?.on_complete?.failure?.target === oldKey) clonedState.on_complete.failure.target = newKey;
      if (clonedState?.on_approve?.target === oldKey) clonedState.on_approve.target = newKey;
      if (clonedState?.on_revise?.target === oldKey) clonedState.on_revise.target = newKey;
      nextStates[actualKey] = clonedState;
    });
    Object.values(entryPoints).forEach((entry) => {
      if (entry?.state === oldKey) entry.state = newKey;
    });
    if (Object.prototype.hasOwnProperty.call(statusLabels, oldKey)) {
      statusLabels[newKey] = statusLabels[oldKey];
      delete statusLabels[oldKey];
    }
    updateStatesEditor(nextStates);
    updateEntryPointsEditor(entryPoints);
    updateStatusLabelsEditor(statusLabels);
    const editable = getEditableWorkflowDefinition();
    if (editable) {
      editable.states = nextStates;
      editable.entry_points = entryPoints;
      editable.status_labels = statusLabels;
    }
    updateWorkflowDefinitionSelectedState(newKey);
    showToast(`已重命名 state: ${oldKey} -> ${newKey}`);
  } catch (err) {
    alert(err instanceof Error ? err.message : "重命名 state 失败");
  }
}

async function deleteWorkflowDefinitionState() {
  if (!workflowDefinitionSelectedStateKey) return;
  try {
    const states = getStatesFromEditor();
    const entryPoints = getEntryPointsFromEditor();
    const statusLabels = getStatusLabelsFromEditor();
    const refs = collectWorkflowDefinitionStateReferences(
      workflowDefinitionSelectedStateKey,
      states,
      entryPoints,
    );
    if (refs.length > 0) {
      alert(`该 state 仍被引用，无法删除：\n\n${refs.join("\n")}`);
      return;
    }
    if (!(await openConfirmDialog(`确认删除 state "${workflowDefinitionSelectedStateKey}" 吗？`, { title: "删除 State" }))) {
      return;
    }
    delete states[workflowDefinitionSelectedStateKey];
    delete statusLabels[workflowDefinitionSelectedStateKey];
    updateStatesEditor(states);
    updateStatusLabelsEditor(statusLabels);
    const editable = getEditableWorkflowDefinition();
    if (editable) {
      editable.states = states;
      editable.status_labels = statusLabels;
    }
    workflowDefinitionSelectedStateKey = Object.keys(states)[0] || "";
    renderWorkflowDefinitionStateEditor(states);
    renderWorkflowDefinitionGraph({
      states,
      entry_points: editable?.entry_points || {},
    });
    showToast("已删除 state");
  } catch (err) {
    alert(err instanceof Error ? err.message : "删除 state 失败");
  }
}

function getWorkflowDefinitionSavePayload(forcedMode) {
  const effectiveMode = forcedMode || workflowDefinitionViewMode;
  const selectedVersion = getSelectedWorkflowDefinitionVersion();
  const key = (workflowDefinitionKeyInput?.value || selectedVersion?.key || "").trim();
  if (!key) {
    throw new Error("缺少 workflow key");
  }
  if (effectiveMode === "json") {
    const parsed = parseWorkflowDefinitionJsonDocument();
    const name = String(parsed.name || "").trim();
    if (!name) {
      throw new Error("Name 不能为空");
    }
    return {
      key,
      label:
        (workflowDefinitionBundleLabelInput?.value || "").trim() ||
        currentWorkflowDefinitionDetail?.bundle?.label ||
        name,
      description:
        (workflowDefinitionBundleDescriptionInput?.value || "").trim() ||
        currentWorkflowDefinitionDetail?.bundle?.description ||
        "",
      definition: {
        name,
        description: String(parsed.description || "").trim(),
        roles: parseWorkflowDefinitionJsonField("Roles", JSON.stringify(parsed.roles || {}), {}),
        entry_points: parseWorkflowDefinitionJsonField(
          "Entry Points",
          JSON.stringify(parsed.entry_points || {}),
          {},
        ),
        states: parseWorkflowDefinitionJsonField("States", JSON.stringify(parsed.states || {}), {}),
        status_labels: parseWorkflowDefinitionJsonField(
          "Status Labels",
          JSON.stringify(parsed.status_labels || {}),
          {},
        ),
        create_form: parseWorkflowDefinitionJsonField(
          "Create Form",
          JSON.stringify(parsed.create_form || {}),
          {},
        ),
        metadata: parseWorkflowDefinitionJsonField(
          "Metadata",
          JSON.stringify(parsed.metadata || {}),
          {},
        ),
      },
    };
  }
  const name = (workflowDefinitionNameInput?.value || "").trim();
  if (!name) {
    throw new Error("Name 不能为空");
  }
  const editable = getEditableWorkflowDefinition();
  const fallback = editable || createWorkflowDefinitionTemplate(key, key, "");
  return {
    key,
    label: (workflowDefinitionBundleLabelInput?.value || "").trim() || name,
    description: (workflowDefinitionBundleDescriptionInput?.value || "").trim(),
    definition: {
      name,
      description: (workflowDefinitionDescriptionInput?.value || "").trim(),
      roles: parseWorkflowDefinitionJsonField(
        "Roles",
        workflowDefinitionRolesInput?.value || "",
        fallback.roles || {},
      ),
      entry_points: parseWorkflowDefinitionJsonField(
        "Entry Points",
        workflowDefinitionEntryPointsInput?.value || "",
        fallback.entry_points || {},
      ),
      states: parseWorkflowDefinitionJsonField(
        "States",
        workflowDefinitionStatesInput?.value || "",
        fallback.states || {},
      ),
      status_labels: parseWorkflowDefinitionJsonField(
        "Status Labels",
        workflowDefinitionStatusLabelsInput?.value || "",
        fallback.status_labels || {},
      ),
      create_form: cloneJson(editable?.create_form || fallback.create_form || {}),
      metadata: parseWorkflowDefinitionJsonField(
        "Metadata",
        workflowDefinitionMetadataInput?.value || "",
        fallback.metadata || {},
      ),
    },
  };
}

function renderWorkflowDefinitionEditor(definition, bundle) {
  if (!definition) return;
  if (workflowDefinitionBundleLabelInput) {
    workflowDefinitionBundleLabelInput.value = bundle?.label || definition.name || definition.key || "";
  }
  if (workflowDefinitionKeyInput) {
    workflowDefinitionKeyInput.value = definition.key || "";
  }
  if (workflowDefinitionNameInput) {
    workflowDefinitionNameInput.value = definition.name || "";
  }
  if (workflowDefinitionVersionInput) {
    workflowDefinitionVersionInput.value = definition.version ? `v${definition.version}` : "--";
  }
  if (workflowDefinitionBundleDescriptionInput) {
    workflowDefinitionBundleDescriptionInput.value = bundle?.description || definition.description || "";
  }
  if (workflowDefinitionDescriptionInput) {
    workflowDefinitionDescriptionInput.value = definition.description || "";
  }
  if (workflowDefinitionRolesInput) {
    workflowDefinitionRolesInput.value = stringifyPrettyJson(definition.roles || {});
  }
  if (workflowDefinitionEntryPointsInput) {
    workflowDefinitionEntryPointsInput.value = stringifyPrettyJson(definition.entry_points || {});
  }
  if (workflowDefinitionStatesInput) {
    workflowDefinitionStatesInput.value = stringifyPrettyJson(definition.states || {});
  }
  if (workflowDefinitionStatusLabelsInput) {
    workflowDefinitionStatusLabelsInput.value = stringifyPrettyJson(definition.status_labels || {});
  }
  if (workflowDefinitionMetadataInput) {
    workflowDefinitionMetadataInput.value = stringifyPrettyJson(definition.metadata || {});
  }
  renderWorkflowDefinitionRoleEditor(definition.roles || {});
  renderWorkflowDefinitionEntryPointEditor(definition.entry_points || {});
  renderWorkflowDefinitionStateEditor(definition.states || {});
  renderWorkflowDefinitionStatusLabelEditor(definition.status_labels || {});
  renderWorkflowDefinitionCreateFormEditor(definition.create_form || { fields: [] });
}

function hideWorkflowDefinitionValidationPanel() {
  if (workflowDefinitionValidationPanel) {
    workflowDefinitionValidationPanel.classList.add("hidden");
  }
  if (workflowDefinitionValidation) {
    workflowDefinitionValidation.innerHTML = "";
  }
  if (workflowDefinitionViewMode !== "graph" && workflowDefinitionSidepanels) {
    workflowDefinitionSidepanels.classList.add("hidden");
  }
}

function renderWorkflowDefinitionValidationPanel(validationState) {
  if (!workflowDefinitionValidationPanel || !workflowDefinitionValidation) return;
  const localValidationItems = Array.isArray(validationState?.localValidationItems)
    ? validationState.localValidationItems
    : [];
  const serverErrors = Array.isArray(validationState?.serverErrors)
    ? validationState.serverErrors
    : [];
  const blocks = [];

  if (localValidationItems.length > 0) {
    const grouped = localValidationItems.reduce((acc, item) => {
      const key = item.group || "other";
      if (!acc[key]) acc[key] = [];
      acc[key].push(item);
      return acc;
    }, {});
    blocks.push(
      `<div class="workflow-definition-validation-note">发布前校验发现 ${escapeHtml(String(localValidationItems.length))} 个结构问题。</div>`,
    );
    Object.entries(grouped).forEach(([group, messages]) => {
      blocks.push(
        `<div class="workflow-definition-validation-note">分组 ${escapeHtml(group)} · ${escapeHtml(String(messages.length))} 项</div>`,
      );
      messages.forEach((item) => {
        blocks.push(
          `<button type="button" class="workflow-definition-validation-error workflow-definition-validation-link" data-workflow-validation-jump="${escapeAttribute(JSON.stringify(item))}">${escapeHtml(item.message)}</button>`,
        );
      });
    });
  }

  if (serverErrors.length > 0) {
    blocks.push(
      `<div class="workflow-definition-validation-note">后端校验返回 ${escapeHtml(String(serverErrors.length))} 个问题。</div>`,
    );
    serverErrors.forEach((error) => {
      blocks.push(`<div class="workflow-definition-validation-error">${escapeHtml(error)}</div>`);
    });
  }

  workflowDefinitionValidation.innerHTML = blocks.join("");
  workflowDefinitionValidationPanel.classList.remove("hidden");
  if (workflowDefinitionSidepanels) {
    workflowDefinitionSidepanels.classList.remove("hidden");
  }
  Array.from(workflowDefinitionValidation.querySelectorAll("[data-workflow-validation-jump]")).forEach((button) => {
    button.addEventListener("click", () => {
      const raw = button.getAttribute("data-workflow-validation-jump") || "";
      try {
        jumpToWorkflowValidationItem(JSON.parse(raw));
      } catch (err) {
        console.error("Failed to parse workflow validation jump payload:", err);
      }
    });
  });
}

function renderWorkflowDefinitionDiff(detail) {
  if (!workflowDefinitionDiff || !workflowDefinitionDiffSummary) return;
  if (workflowDefinitionDiffFocus) {
    const source = getWorkflowDefinitionVersionByNumber(workflowDefinitionDiffFocus.sourceVersion);
    const target = getWorkflowDefinitionVersionByNumber(workflowDefinitionDiffFocus.targetVersion);
    if (source && target) {
      const left = stringifyPrettyJson(getWorkflowDefinitionDiffComparable(source)).split("\n");
      const right = stringifyPrettyJson(getWorkflowDefinitionDiffComparable(target)).split("\n");
      const maxLength = Math.max(left.length, right.length);
      let changedCount = 0;
      const rows = [];

      for (let i = 0; i < maxLength; i += 1) {
        const leftLine = left[i];
        const rightLine = right[i];
        if (leftLine === rightLine) {
          rows.push({
            type: "unchanged",
            lineNo: i + 1,
            text: `  ${leftLine ?? ""}`,
          });
          continue;
        }
        if (leftLine !== undefined) {
          changedCount += 1;
          rows.push({
            type: "removed",
            lineNo: i + 1,
            text: `- ${leftLine}`,
          });
        }
        if (rightLine !== undefined) {
          changedCount += 1;
          rows.push({
            type: "added",
            lineNo: i + 1,
            text: `+ ${rightLine}`,
          });
        }
      }

      workflowDefinitionDiffSummary.textContent = `v${source.version} -> v${target.version} · ${changedCount} 处行级变更`;
      workflowDefinitionDiff.innerHTML = rows.length
        ? rows
            .map(
              (row) => `
                <div class="workflow-definition-diff-line ${escapeHtml(row.type)}">
                  <span class="workflow-definition-diff-line-no">${escapeHtml(String(row.lineNo))}</span>
                  <span>${escapeHtml(row.text)}</span>
                </div>
              `,
            )
            .join("")
        : `<div class="workflow-definition-diff-empty">v${source.version} 与 v${target.version} 当前完全一致。</div>`;
      return;
    }
    clearWorkflowDefinitionVersionDiffFocus();
  }

  const draft = detail?.draft_definition || null;
  const published = detail?.published_definition || null;
  if (!draft && !published) {
    workflowDefinitionDiffSummary.textContent = "暂无可对比版本";
    workflowDefinitionDiff.innerHTML =
      '<div class="workflow-definition-diff-empty">当前没有 draft / published 版本可供比较。</div>';
    return;
  }
  if (!draft || !published) {
    workflowDefinitionDiffSummary.textContent = !draft ? "仅有 published" : "仅有 draft";
    workflowDefinitionDiff.innerHTML =
      '<div class="workflow-definition-diff-empty">需要同时存在 draft 和 published 才能生成对比。</div>';
    return;
  }

  const left = stringifyPrettyJson(getWorkflowDefinitionDiffComparable(published)).split("\n");
  const right = stringifyPrettyJson(getWorkflowDefinitionDiffComparable(draft)).split("\n");
  const maxLength = Math.max(left.length, right.length);
  let changedCount = 0;
  const rows = [];

  for (let i = 0; i < maxLength; i += 1) {
    const leftLine = left[i];
    const rightLine = right[i];
    if (leftLine === rightLine) {
      rows.push({
        type: "unchanged",
        lineNo: i + 1,
        text: `  ${leftLine ?? ""}`,
      });
      continue;
    }
    if (leftLine !== undefined) {
      changedCount += 1;
      rows.push({
        type: "removed",
        lineNo: i + 1,
        text: `- ${leftLine}`,
      });
    }
    if (rightLine !== undefined) {
      changedCount += 1;
      rows.push({
        type: "added",
        lineNo: i + 1,
        text: `+ ${rightLine}`,
      });
    }
  }

  workflowDefinitionDiffSummary.textContent = `published v${published.version} -> draft v${draft.version} · ${changedCount} 处行级变更`;
  workflowDefinitionDiff.innerHTML = rows.length
    ? rows
        .map(
          (row) => `
            <div class="workflow-definition-diff-line ${escapeHtml(row.type)}">
              <span class="workflow-definition-diff-line-no">${escapeHtml(String(row.lineNo))}</span>
              <span>${escapeHtml(row.text)}</span>
            </div>
          `,
        )
        .join("")
    : '<div class="workflow-definition-diff-empty">draft 与 published 当前完全一致。</div>';
}

function jumpToWorkflowValidationItem(item) {
  const message = String(item?.message || "");
  const stateMatch = message.match(/^states\.([^.]+)/);
  if (stateMatch) {
    updateWorkflowDefinitionSelectedState(stateMatch[1]);
    return;
  }
  const entryMatch = message.match(/^entry_points\.([^.]+)/);
  if (entryMatch) {
    workflowDefinitionSelectedEntryPointKey = entryMatch[1];
    renderWorkflowDefinitionEntryPointEditor();
    focusWorkflowDefinitionJsonField(workflowDefinitionEntryPointsInput, entryMatch[1]);
    return;
  }
  const statusMatch = message.match(/^status_labels\.([^. ]+)/);
  if (statusMatch) {
    workflowDefinitionSelectedStatusLabelKey = statusMatch[1];
    renderWorkflowDefinitionStatusLabelEditor();
    focusWorkflowDefinitionJsonField(workflowDefinitionStatusLabelsInput, statusMatch[1]);
    return;
  }
  if (String(item?.group || "") === "roles") {
    const roleMatch = message.match(/role: ([^ ]+)/);
    if (roleMatch) {
      workflowDefinitionSelectedRoleKey = roleMatch[1];
      renderWorkflowDefinitionRoleEditor();
      focusWorkflowDefinitionJsonField(workflowDefinitionRolesInput, roleMatch[1]);
      return;
    }
  }
  if (String(item?.group || "") === "cards") {
    const cardMatch = message.match(/card: ([^ ]+)/);
    if (cardMatch) {
      setPrimaryNav("cards-management");
      currentCardSelection = {
        workflowType: currentWorkflowDefinitionKey,
        cardKey: cardMatch[1],
      };
      renderCardsList();
      renderCardsDetailPane();
      return;
    }
  }
  if (String(item?.group || "") === "json") {
    workflowDefinitionStatesInput?.focus();
  }
}

function focusWorkflowDefinitionStateInEditor(stateKey) {
  if (!workflowDefinitionStatesInput || !stateKey) return;
  const source = workflowDefinitionStatesInput.value || "";
  const marker = `"${stateKey}"`;
  const start = source.indexOf(marker);
  if (start < 0) return;

  let depth = 0;
  let firstBrace = -1;
  let end = source.length;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") {
      if (firstBrace < 0) firstBrace = i;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (firstBrace >= 0 && depth === 0) {
        end = i + 1;
        break;
      }
    }
  }

  const selectionStart = start;
  const selectionEnd = Math.max(end, start + marker.length);
  workflowDefinitionStatesInput.focus();
  workflowDefinitionStatesInput.setSelectionRange(selectionStart, selectionEnd);

  const lineHeight = 22;
  const lineIndex = countNewlines(source.slice(0, selectionStart));
  workflowDefinitionStatesInput.scrollTop = Math.max(0, lineIndex * lineHeight - lineHeight * 2);
}

function focusWorkflowDefinitionJsonField(textarea, key) {
  if (!textarea || !key) return;
  const source = textarea.value || "";
  const marker = `"${key}"`;
  const start = source.indexOf(marker);
  if (start < 0) {
    textarea.focus();
    return;
  }
  textarea.focus();
  textarea.setSelectionRange(start, Math.min(source.length, start + marker.length));
  const lineHeight = 22;
  const lineIndex = countNewlines(source.slice(0, start));
  textarea.scrollTop = Math.max(0, lineIndex * lineHeight - lineHeight * 2);
}

function buildStateTransitionInspectorHtml(prefix, transition) {
  const safe = transition || {};
  return `
    <div class="workflow-definition-state-inspector-grid">
      <label class="workflow-definition-field">
        <span>Target</span>
        <input list="workflow-definition-state-options" data-state-field="${escapeAttribute(prefix)}.target" type="text" value="${escapeAttribute(safe.target || "")}" />
      </label>
      <label class="workflow-definition-field">
        <span>Card Ref</span>
        <input list="workflow-definition-card-options" data-state-field="${escapeAttribute(prefix)}.card.ref" type="text" value="${escapeAttribute(safe.card?.ref || "")}" />
      </label>
      <label class="workflow-definition-field">
        <span>Delegate Role</span>
        <input list="workflow-definition-role-options" data-state-field="${escapeAttribute(prefix)}.delegate.role" type="text" value="${escapeAttribute(safe.delegate?.role || "")}" />
      </label>
      <label class="workflow-definition-field">
        <span>Delegate Skill</span>
        <input data-state-field="${escapeAttribute(prefix)}.delegate.skill" type="text" value="${escapeAttribute(safe.delegate?.skill || "")}" />
      </label>
    </div>
    <label class="workflow-definition-field workflow-definition-field-block">
      <span>Task Template</span>
      <textarea data-state-field="${escapeAttribute(prefix)}.delegate.task_template" rows="3">${escapeHtml(safe.delegate?.task_template || "")}</textarea>
    </label>
    <label class="workflow-definition-field workflow-definition-field-block">
      <span>Notify Template</span>
      <textarea data-state-field="${escapeAttribute(prefix)}.notify.template" rows="3">${escapeHtml(safe.notify?.template || "")}</textarea>
    </label>
    <label class="workflow-definition-field workflow-definition-field-block workflow-definition-checkbox-field">
      <span class="workflow-definition-checkbox-title">Increment Round</span>
      <span class="workflow-definition-checkbox-control">
        <input data-state-field="${escapeAttribute(prefix)}.effects.increment_round" type="checkbox" ${safe.effects?.increment_round ? "checked" : ""} />
        <span class="workflow-definition-switch" aria-hidden="true">
          <span class="workflow-definition-switch-track"></span>
          <span class="workflow-definition-switch-thumb"></span>
        </span>
        <span class="workflow-definition-checkbox-text">${safe.effects?.increment_round ? "已启用" : "未启用"}</span>
      </span>
    </label>
  `;
}

function setNestedValue(target, path, rawValue, options = {}) {
  const parts = path.split(".");
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (!cursor[key] || typeof cursor[key] !== "object") {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  const leaf = parts[parts.length - 1];
  const value = options.boolean ? Boolean(rawValue) : String(rawValue || "");
  if (options.boolean) {
    if (value) cursor[leaf] = true;
    else delete cursor[leaf];
  } else if (value) {
    cursor[leaf] = value;
  } else {
    delete cursor[leaf];
  }
}

function cleanupStateObject(obj) {
  if (!obj || typeof obj !== "object") return obj;
  Object.keys(obj).forEach((key) => {
    const value = obj[key];
    if (value && typeof value === "object") {
      cleanupStateObject(value);
      if (Array.isArray(value) && value.length === 0) {
        delete obj[key];
      } else if (!Array.isArray(value) && Object.keys(value).length === 0) {
        delete obj[key];
      }
    } else if (value === "" || value === undefined || value === null) {
      delete obj[key];
    }
  });
  return obj;
}

function cleanupWorkflowDefinitionRoleObject(role) {
  if (!role || typeof role !== "object") return role;
  const preservedChannels =
    role.channels && typeof role.channels === "object" && !Array.isArray(role.channels)
      ? { ...role.channels }
      : null;
  const cleanedRole = cleanupStateObject(role);
  if (preservedChannels && Object.keys(preservedChannels).length) {
    cleanedRole.channels = preservedChannels;
  }
  return cleanedRole;
}

function updateWorkflowDefinitionSelectedState(stateKey) {
  workflowDefinitionSelectedStateKey = stateKey || "";
  renderWorkflowDefinitionStateEditor();
  const graphSource = getEditableWorkflowDefinition() || {};
  renderWorkflowDefinitionGraph(graphSource);
  if (workflowDefinitionSelectedStateKey) {
    focusWorkflowDefinitionStateInEditor(workflowDefinitionSelectedStateKey);
  }
}

function bindWorkflowDefinitionStateInspectorEvents() {
  if (!workflowDefinitionStateInspector) return;
  Array.from(workflowDefinitionStateInspector.querySelectorAll("[data-state-field]")).forEach((el) => {
    const eventName = el.tagName === "SELECT" ? "change" : el.type === "checkbox" ? "change" : "input";
    el.addEventListener(eventName, () => {
      const path = el.getAttribute("data-state-field") || "";
      if (!path || !workflowDefinitionSelectedStateKey) return;
      const selection = captureWorkflowDefinitionInspectorSelection(el);
      applyWorkflowDefinitionStatePatch(workflowDefinitionSelectedStateKey, (state) => {
        if (path === "type") {
          const nextType = el.value;
          const nextState = createWorkflowDefinitionStateTemplate(nextType);
          nextState.label = state.label || nextState.label;
          if (state.description) nextState.description = state.description;
          return cleanupStateObject(nextState);
        }
        setNestedValue(state, path, el.type === "checkbox" ? el.checked : el.value, {
          boolean: el.type === "checkbox",
        });
        return cleanupStateObject(state);
      });
      if (el.tagName !== "SELECT" && el.type !== "checkbox" && path !== "type") {
        restoreWorkflowDefinitionInspectorFocus(
          workflowDefinitionStateInspector,
          getWorkflowDefinitionInspectorSelector("data-state-field", path),
          selection,
        );
      }
    });
  });
  const renameBtn = workflowDefinitionStateInspector.querySelector("[data-state-action='rename']");
  const deleteBtn = workflowDefinitionStateInspector.querySelector("[data-state-action='delete']");
  if (renameBtn) {
    renameBtn.addEventListener("click", () => {
      renameWorkflowDefinitionState();
    });
  }
  if (deleteBtn) {
    deleteBtn.addEventListener("click", () => {
      deleteWorkflowDefinitionState();
    });
  }
}

function renderWorkflowDefinitionRoleEditor(rolesArg) {
  if (!workflowDefinitionRoleList || !workflowDefinitionRoleInspector) return;
  let roles = rolesArg;
  try {
    roles = roles || getRolesFromEditor();
  } catch (err) {
    workflowDefinitionRoleList.innerHTML =
      '<div class="workflow-definition-state-list-empty">Role 配置解析失败，暂时无法渲染结构化编辑器。</div>';
    workflowDefinitionRoleInspector.innerHTML =
      `<div class="workflow-definition-state-inspector-empty">${escapeHtml(err instanceof Error ? err.message : "Role 配置解析失败")}</div>`;
    return;
  }
  const roleEntries = Object.entries(roles || {});
  if (!roleEntries.length) {
    workflowDefinitionRoleList.innerHTML = '<div class="workflow-definition-state-list-empty">暂无 role，可先新增。</div>';
    workflowDefinitionRoleInspector.innerHTML =
      '<div class="workflow-definition-state-inspector-empty">选择一个 role 查看结构化编辑面板。</div>';
    return;
  }
  if (!workflowDefinitionSelectedRoleKey || !roles[workflowDefinitionSelectedRoleKey]) {
    workflowDefinitionSelectedRoleKey = roleEntries[0][0];
  }
  workflowDefinitionRoleList.innerHTML = roleEntries
    .map(
      ([roleKey, role]) => `
        <button type="button" class="workflow-definition-state-list-item${workflowDefinitionSelectedRoleKey === roleKey ? " active" : ""}" data-role-select="${escapeAttribute(roleKey)}">
          <strong>${escapeHtml(role.label || roleKey)}</strong>
          <span>${escapeHtml(roleKey)}</span>
        </button>
      `,
    )
    .join("");
  Array.from(workflowDefinitionRoleList.querySelectorAll("[data-role-select]")).forEach((button) => {
    button.addEventListener("click", () => {
      workflowDefinitionSelectedRoleKey = button.getAttribute("data-role-select") || "";
      renderWorkflowDefinitionRoleEditor(roles);
    });
  });
  const selectedRole = roles[workflowDefinitionSelectedRoleKey];
  const channelEntries = Object.entries(selectedRole?.channels || {});
  workflowDefinitionRoleInspector.innerHTML = `
    <div class="workflow-definition-state-inspector-head">
      <span>${escapeHtml(selectedRole.label || workflowDefinitionSelectedRoleKey)} · ${escapeHtml(workflowDefinitionSelectedRoleKey)}</span>
      <div class="workflow-definition-state-head-actions">
        <button type="button" class="btn-ghost" data-role-action="rename">重命名</button>
        <button type="button" class="btn-ghost" data-role-action="delete">删除</button>
      </div>
    </div>
    <div class="workflow-definition-state-inspector-body">
      <div class="workflow-definition-state-inspector-grid">
        <label class="workflow-definition-field">
          <span>Label</span>
          <input data-role-field="label" type="text" value="${escapeAttribute(selectedRole?.label || "")}" />
        </label>
      </div>
      <label class="workflow-definition-field">
        <span>Description</span>
        <textarea data-role-field="description" rows="2">${escapeHtml(selectedRole?.description || "")}</textarea>
      </label>
      <section class="workflow-definition-state-inspector-section">
        <div class="workflow-definition-state-inspector-title">
          <span>Channels</span>
          <span class="workflow-definition-inline-actions">
            <button type="button" class="btn-ghost" data-role-action="add-channel">新增 Channel</button>
          </span>
        </div>
        ${
          channelEntries.length
            ? channelEntries
                .map(
                  ([channelKey, value]) => `
                    <label class="workflow-definition-field workflow-definition-field-block">
                      <span>Channel</span>
                      <div class="workflow-definition-inline-actions">
                        <input
                          data-role-channel-key="${escapeAttribute(channelKey)}"
                          data-role-channel-key-original="${escapeAttribute(channelKey)}"
                          data-role-channel-storage-key="${escapeAttribute(channelKey)}"
                          type="text"
                          value="${escapeAttribute(getWorkflowDefinitionRoleChannelDisplayKey(channelKey))}"
                        />
                        <input data-role-channel="${escapeAttribute(channelKey)}" type="text" value="${escapeAttribute(value || "")}" />
                        <button type="button" class="btn-ghost" data-role-channel-delete="${escapeAttribute(channelKey)}">删除</button>
                      </div>
                    </label>
                  `,
                )
                .join("")
            : '<div class="workflow-definition-state-inspector-empty">当前没有 channel，可点击右上角新增 Channel。</div>'
        }
      </section>
    </div>
  `;
  Array.from(workflowDefinitionRoleInspector.querySelectorAll("[data-role-field]")).forEach((el) => {
    const path = el.getAttribute("data-role-field") || "";
    el.addEventListener(el.tagName === "TEXTAREA" ? "input" : "input", () => {
      const selection = captureWorkflowDefinitionInspectorSelection(el);
      applyWorkflowDefinitionRolePatch(workflowDefinitionSelectedRoleKey, (role) => {
        role[path] = el.value || "";
        return cleanupWorkflowDefinitionRoleObject(role);
      });
      restoreWorkflowDefinitionInspectorFocus(
        workflowDefinitionRoleInspector,
        getWorkflowDefinitionInspectorSelector("data-role-field", path),
        selection,
      );
    });
  });
  Array.from(workflowDefinitionRoleInspector.querySelectorAll("[data-role-channel]")).forEach((el) => {
    const channelKey = el.getAttribute("data-role-channel") || "";
    el.addEventListener("input", () => {
      const selection = captureWorkflowDefinitionInspectorSelection(el);
      applyWorkflowDefinitionRolePatch(workflowDefinitionSelectedRoleKey, (role) => {
        role.channels = role.channels || {};
        role.channels[channelKey] = el.value || "";
        return cleanupWorkflowDefinitionRoleObject(role);
      });
      restoreWorkflowDefinitionInspectorFocus(
        workflowDefinitionRoleInspector,
        getWorkflowDefinitionInspectorSelector("data-role-channel", channelKey),
        selection,
      );
    });
  });
  Array.from(workflowDefinitionRoleInspector.querySelectorAll("[data-role-channel-key]")).forEach((el) => {
    el.addEventListener("blur", (event) => {
      handleWorkflowDefinitionRoleChannelRename(el, event.relatedTarget || null);
    });
  });
  const renameBtn = workflowDefinitionRoleInspector.querySelector("[data-role-action='rename']");
  const deleteBtn = workflowDefinitionRoleInspector.querySelector("[data-role-action='delete']");
  const addChannelBtn = workflowDefinitionRoleInspector.querySelector("[data-role-action='add-channel']");
  Array.from(workflowDefinitionRoleInspector.querySelectorAll("[data-role-channel-delete]")).forEach((button) => {
    button.addEventListener("click", () => {
      deleteWorkflowDefinitionRoleChannel(button.getAttribute("data-role-channel-delete") || "");
    });
  });
  if (renameBtn) renameBtn.addEventListener("click", () => renameWorkflowDefinitionRole());
  if (deleteBtn) deleteBtn.addEventListener("click", () => deleteWorkflowDefinitionRole());
  if (addChannelBtn) addChannelBtn.addEventListener("click", () => addWorkflowDefinitionRoleChannelFromButton());
}

function renderWorkflowDefinitionEntryPointEditor(entryPointsArg) {
  if (!workflowDefinitionEntryPointList || !workflowDefinitionEntryPointInspector) return;
  let entryPoints = entryPointsArg;
  try {
    entryPoints = entryPoints || getEntryPointsFromEditor();
  } catch (err) {
    workflowDefinitionEntryPointList.innerHTML =
      '<div class="workflow-definition-state-list-empty">Entry Point 配置解析失败，暂时无法渲染结构化编辑器。</div>';
    workflowDefinitionEntryPointInspector.innerHTML =
      `<div class="workflow-definition-state-inspector-empty">${escapeHtml(err instanceof Error ? err.message : "Entry Point 配置解析失败")}</div>`;
    return;
  }
  const entryEntries = Object.entries(entryPoints || {});
  if (!entryEntries.length) {
    workflowDefinitionEntryPointList.innerHTML = '<div class="workflow-definition-state-list-empty">暂无 entry point，可先新增。</div>';
    workflowDefinitionEntryPointInspector.innerHTML =
      '<div class="workflow-definition-state-inspector-empty">选择一个 entry point 查看结构化编辑面板。</div>';
    return;
  }
  if (!workflowDefinitionSelectedEntryPointKey || !entryPoints[workflowDefinitionSelectedEntryPointKey]) {
    workflowDefinitionSelectedEntryPointKey = entryEntries[0][0];
  }
  workflowDefinitionEntryPointList.innerHTML = entryEntries
    .map(
      ([entryKey, entry]) => `
        <button type="button" class="workflow-definition-state-list-item${workflowDefinitionSelectedEntryPointKey === entryKey ? " active" : ""}" data-entry-point-select="${escapeAttribute(entryKey)}">
          <strong>${escapeHtml(entry.label || entryKey)}</strong>
          <span>${escapeHtml(entryKey)} · ${escapeHtml(entry.state || "--")}</span>
        </button>
      `,
    )
    .join("");
  Array.from(workflowDefinitionEntryPointList.querySelectorAll("[data-entry-point-select]")).forEach((button) => {
    button.addEventListener("click", () => {
      workflowDefinitionSelectedEntryPointKey = button.getAttribute("data-entry-point-select") || "";
      renderWorkflowDefinitionEntryPointEditor(entryPoints);
    });
  });
  const selectedEntry = entryPoints[workflowDefinitionSelectedEntryPointKey];
  const roleOptions = Object.keys(getRolesFromEditor());
  const stateOptions = Object.keys(getStatesFromEditor());
  const warnings = [];
  if (selectedEntry?.state && !stateOptions.includes(selectedEntry.state)) warnings.push(`state 引用了不存在的 state: ${selectedEntry.state}`);
  if (selectedEntry?.deliverable_role && !roleOptions.includes(selectedEntry.deliverable_role)) warnings.push(`deliverable_role 引用了不存在的 role: ${selectedEntry.deliverable_role}`);
  workflowDefinitionEntryPointInspector.innerHTML = `
    <div class="workflow-definition-state-inspector-head">
      <span>${escapeHtml(selectedEntry.label || workflowDefinitionSelectedEntryPointKey)} · ${escapeHtml(workflowDefinitionSelectedEntryPointKey)}</span>
      <div class="workflow-definition-state-head-actions">
        <button type="button" class="btn-ghost" data-entry-point-action="rename">重命名</button>
        <button type="button" class="btn-ghost" data-entry-point-action="delete">删除</button>
      </div>
    </div>
    <div class="workflow-definition-state-inspector-body">
      ${
        warnings.length
          ? `<section class="workflow-definition-state-validation">${warnings
              .map((item) => `<div class="workflow-definition-state-validation-item">${escapeHtml(item)}</div>`)
              .join("")}</section>`
          : ""
      }
      <div class="workflow-definition-state-inspector-grid">
        <label class="workflow-definition-field">
          <span>Label</span>
          <input data-entry-point-field="label" type="text" value="${escapeAttribute(selectedEntry?.label || "")}" />
        </label>
        <label class="workflow-definition-field">
          <span>State</span>
          <input list="workflow-definition-state-options-entry" data-entry-point-field="state" type="text" value="${escapeAttribute(selectedEntry?.state || "")}" />
        </label>
      </div>
      <label class="workflow-definition-field">
        <span>Description</span>
        <textarea data-entry-point-field="description" rows="2">${escapeHtml(selectedEntry?.description || "")}</textarea>
      </label>
      <div class="workflow-definition-state-inspector-grid">
        <label class="workflow-definition-field">
          <span>Deliverable Role</span>
          <input list="workflow-definition-role-options-entry" data-entry-point-field="deliverable_role" type="text" value="${escapeAttribute(selectedEntry?.deliverable_role || "")}" />
        </label>
        <label class="workflow-definition-field workflow-definition-checkbox-field">
          <span class="workflow-definition-checkbox-title">Requires Deliverable</span>
          <span class="workflow-definition-checkbox-control">
            <input data-entry-point-field="requires_deliverable" type="checkbox" ${selectedEntry?.requires_deliverable ? "checked" : ""} />
            <span class="workflow-definition-switch" aria-hidden="true">
              <span class="workflow-definition-switch-track"></span>
              <span class="workflow-definition-switch-thumb"></span>
            </span>
            <span class="workflow-definition-checkbox-text">${selectedEntry?.requires_deliverable ? "已启用" : "未启用"}</span>
          </span>
        </label>
      </div>
      <datalist id="workflow-definition-state-options-entry">${stateOptions.map((stateKey) => `<option value="${escapeAttribute(stateKey)}"></option>`).join("")}</datalist>
      <datalist id="workflow-definition-role-options-entry">${roleOptions.map((roleKey) => `<option value="${escapeAttribute(roleKey)}"></option>`).join("")}</datalist>
    </div>
  `;
  Array.from(workflowDefinitionEntryPointInspector.querySelectorAll("[data-entry-point-field]")).forEach((el) => {
    const path = el.getAttribute("data-entry-point-field") || "";
    const eventName = el.type === "checkbox" ? "change" : "input";
    el.addEventListener(eventName, () => {
      const selection = captureWorkflowDefinitionInspectorSelection(el);
      applyWorkflowDefinitionEntryPointPatch(workflowDefinitionSelectedEntryPointKey, (entry) => {
        if (el.type === "checkbox") {
          if (el.checked) entry[path] = true;
          else delete entry[path];
        } else if (el.value) {
          entry[path] = el.value;
        } else {
          delete entry[path];
        }
        return cleanupStateObject(entry);
      });
      if (el.type !== "checkbox") {
        restoreWorkflowDefinitionInspectorFocus(
          workflowDefinitionEntryPointInspector,
          getWorkflowDefinitionInspectorSelector("data-entry-point-field", path),
          selection,
        );
      }
    });
  });
  const renameBtn = workflowDefinitionEntryPointInspector.querySelector("[data-entry-point-action='rename']");
  const deleteBtn = workflowDefinitionEntryPointInspector.querySelector("[data-entry-point-action='delete']");
  if (renameBtn) renameBtn.addEventListener("click", () => renameWorkflowDefinitionEntryPoint());
  if (deleteBtn) deleteBtn.addEventListener("click", () => deleteWorkflowDefinitionEntryPoint());
}

function renderWorkflowDefinitionStatusLabelEditor(statusLabelsArg) {
  if (!workflowDefinitionStatusLabelList || !workflowDefinitionStatusLabelInspector) return;
  let statusLabels = statusLabelsArg;
  try {
    statusLabels = statusLabels || getStatusLabelsFromEditor();
  } catch (err) {
    workflowDefinitionStatusLabelList.innerHTML =
      '<div class="workflow-definition-state-list-empty">Status Label 配置解析失败，暂时无法渲染结构化编辑器。</div>';
    workflowDefinitionStatusLabelInspector.innerHTML =
      `<div class="workflow-definition-state-inspector-empty">${escapeHtml(err instanceof Error ? err.message : "Status Label 配置解析失败")}</div>`;
    return;
  }
  const labelEntries = Object.entries(statusLabels || {});
  if (!labelEntries.length) {
    workflowDefinitionStatusLabelList.innerHTML = '<div class="workflow-definition-state-list-empty">暂无 status label，可先新增。</div>';
    workflowDefinitionStatusLabelInspector.innerHTML =
      '<div class="workflow-definition-state-inspector-empty">选择一个 status label 查看结构化编辑面板。</div>';
    return;
  }
  if (!workflowDefinitionSelectedStatusLabelKey || !Object.prototype.hasOwnProperty.call(statusLabels, workflowDefinitionSelectedStatusLabelKey)) {
    workflowDefinitionSelectedStatusLabelKey = labelEntries[0][0];
  }
  workflowDefinitionStatusLabelList.innerHTML = labelEntries
    .map(
      ([stateKey, value]) => `
        <button type="button" class="workflow-definition-state-list-item${workflowDefinitionSelectedStatusLabelKey === stateKey ? " active" : ""}" data-status-label-select="${escapeAttribute(stateKey)}">
          <strong>${escapeHtml(stateKey)}</strong>
          <span>${escapeHtml(String(value || ""))}</span>
        </button>
      `,
    )
    .join("");
  Array.from(workflowDefinitionStatusLabelList.querySelectorAll("[data-status-label-select]")).forEach((button) => {
    button.addEventListener("click", () => {
      workflowDefinitionSelectedStatusLabelKey = button.getAttribute("data-status-label-select") || "";
      renderWorkflowDefinitionStatusLabelEditor(statusLabels);
    });
  });
  const stateOptions = Object.keys(getStatesFromEditor());
  const missingState = workflowDefinitionSelectedStatusLabelKey && !stateOptions.includes(workflowDefinitionSelectedStatusLabelKey);
  workflowDefinitionStatusLabelInspector.innerHTML = `
    <div class="workflow-definition-state-inspector-head">
      <span>${escapeHtml(workflowDefinitionSelectedStatusLabelKey)}</span>
      <div class="workflow-definition-state-head-actions">
        <button type="button" class="btn-ghost" data-status-label-action="delete">删除</button>
      </div>
    </div>
    <div class="workflow-definition-state-inspector-body">
      ${
        missingState
          ? `<section class="workflow-definition-state-validation"><div class="workflow-definition-state-validation-item">当前 status label 对应的 state 不存在：${escapeHtml(workflowDefinitionSelectedStatusLabelKey)}</div></section>`
          : ""
      }
      <label class="workflow-definition-field">
        <span>Label Text</span>
        <textarea data-status-label-field="value" rows="3">${escapeHtml(statusLabels[workflowDefinitionSelectedStatusLabelKey] || "")}</textarea>
      </label>
    </div>
  `;
  const valueInput = workflowDefinitionStatusLabelInspector.querySelector("[data-status-label-field='value']");
  if (valueInput) {
    valueInput.addEventListener("input", () => {
      const selection = captureWorkflowDefinitionInspectorSelection(valueInput);
      applyWorkflowDefinitionStatusLabelPatch(workflowDefinitionSelectedStatusLabelKey, () => valueInput.value || "");
      restoreWorkflowDefinitionInspectorFocus(
        workflowDefinitionStatusLabelInspector,
        getWorkflowDefinitionInspectorSelector("data-status-label-field", "value"),
        selection,
      );
    });
  }
  const deleteBtn = workflowDefinitionStatusLabelInspector.querySelector("[data-status-label-action='delete']");
  if (deleteBtn) deleteBtn.addEventListener("click", () => deleteWorkflowDefinitionStatusLabel());
}

function renderWorkflowDefinitionStateEditor(statesArg) {
  if (!workflowDefinitionStateList || !workflowDefinitionStateInspector) return;
  let states = statesArg;
  try {
    states = states || getStatesFromEditor();
  } catch (err) {
    workflowDefinitionStateList.innerHTML =
      '<div class="workflow-definition-state-list-empty">State 配置解析失败，暂时无法渲染结构化编辑器。</div>';
    workflowDefinitionStateInspector.innerHTML =
      `<div class="workflow-definition-state-inspector-empty">${escapeHtml(
        err instanceof Error ? err.message : "State 配置解析失败",
      )}</div>`;
    return;
  }

  const stateEntries = Object.entries(states || {});
  if (!stateEntries.length) {
    workflowDefinitionStateList.innerHTML =
      '<div class="workflow-definition-state-list-empty">暂无 state，可先在 JSON 里新增。</div>';
    workflowDefinitionStateInspector.innerHTML =
      '<div class="workflow-definition-state-inspector-empty">选择一个 state 查看结构化编辑面板。</div>';
    return;
  }

  if (!workflowDefinitionSelectedStateKey || !states[workflowDefinitionSelectedStateKey]) {
    workflowDefinitionSelectedStateKey = stateEntries[0][0];
  }

  workflowDefinitionStateList.innerHTML = stateEntries
    .map(
      ([stateKey, state]) => `
        <button
          type="button"
          class="workflow-definition-state-list-item${workflowDefinitionSelectedStateKey === stateKey ? " active" : ""}"
          data-state-select="${escapeAttribute(stateKey)}"
        >
          <strong>${escapeHtml(state.label || stateKey)}</strong>
          <span>${escapeHtml(stateKey)} · ${escapeHtml(state.type || "--")}</span>
        </button>
      `,
    )
    .join("");

  Array.from(workflowDefinitionStateList.querySelectorAll("[data-state-select]")).forEach((button) => {
    button.addEventListener("click", () => {
      updateWorkflowDefinitionSelectedState(button.getAttribute("data-state-select") || "");
    });
  });

  const selectedState = states[workflowDefinitionSelectedStateKey];
  if (!selectedState) {
    workflowDefinitionStateInspector.innerHTML =
      '<div class="workflow-definition-state-inspector-empty">选择一个 state 查看结构化编辑面板。</div>';
    return;
  }

  const roleOptions = Object.keys(getRolesFromEditor());
  const stateOptions = Object.keys(states);
  const cardOptions = getCurrentWorkflowCardRefs();
  const validationItems = [];
  if (selectedState.type === "delegation") {
    if (selectedState.delegate?.role && !roleOptions.includes(selectedState.delegate.role)) {
      validationItems.push(`delegate.role 引用了不存在的 role: ${selectedState.delegate.role}`);
    }
    if (selectedState.on_complete?.success?.target && !stateOptions.includes(selectedState.on_complete.success.target)) {
      validationItems.push(`success.target 引用了不存在的 state: ${selectedState.on_complete.success.target}`);
    }
    if (selectedState.on_complete?.failure?.target && !stateOptions.includes(selectedState.on_complete.failure.target)) {
      validationItems.push(`failure.target 引用了不存在的 state: ${selectedState.on_complete.failure.target}`);
    }
    if (
      selectedState.on_complete?.success?.delegate?.role &&
      !roleOptions.includes(selectedState.on_complete.success.delegate.role)
    ) {
      validationItems.push(`success.delegate.role 引用了不存在的 role: ${selectedState.on_complete.success.delegate.role}`);
    }
    if (
      selectedState.on_complete?.failure?.delegate?.role &&
      !roleOptions.includes(selectedState.on_complete.failure.delegate.role)
    ) {
      validationItems.push(`failure.delegate.role 引用了不存在的 role: ${selectedState.on_complete.failure.delegate.role}`);
    }
    if (
      selectedState.on_complete?.success?.card?.ref &&
      !cardOptions.includes(selectedState.on_complete.success.card.ref)
    ) {
      validationItems.push(`success.card.ref 引用了不存在的 card: ${selectedState.on_complete.success.card.ref}`);
    }
    if (
      selectedState.on_complete?.failure?.card?.ref &&
      !cardOptions.includes(selectedState.on_complete.failure.card.ref)
    ) {
      validationItems.push(`failure.card.ref 引用了不存在的 card: ${selectedState.on_complete.failure.card.ref}`);
    }
  }
  if (selectedState.type === "confirmation") {
    if (selectedState.card?.ref && !cardOptions.includes(selectedState.card.ref)) {
      validationItems.push(`card.ref 引用了不存在的 card: ${selectedState.card.ref}`);
    }
    if (selectedState.on_approve?.target && !stateOptions.includes(selectedState.on_approve.target)) {
      validationItems.push(`on_approve.target 引用了不存在的 state: ${selectedState.on_approve.target}`);
    }
    if (selectedState.on_revise?.target && !stateOptions.includes(selectedState.on_revise.target)) {
      validationItems.push(`on_revise.target 引用了不存在的 state: ${selectedState.on_revise.target}`);
    }
    if (selectedState.on_approve?.delegate?.role && !roleOptions.includes(selectedState.on_approve.delegate.role)) {
      validationItems.push(`on_approve.delegate.role 引用了不存在的 role: ${selectedState.on_approve.delegate.role}`);
    }
    if (selectedState.on_revise?.delegate?.role && !roleOptions.includes(selectedState.on_revise.delegate.role)) {
      validationItems.push(`on_revise.delegate.role 引用了不存在的 role: ${selectedState.on_revise.delegate.role}`);
    }
    if (selectedState.on_approve?.card?.ref && !cardOptions.includes(selectedState.on_approve.card.ref)) {
      validationItems.push(`on_approve.card.ref 引用了不存在的 card: ${selectedState.on_approve.card.ref}`);
    }
    if (selectedState.on_revise?.card?.ref && !cardOptions.includes(selectedState.on_revise.card.ref)) {
      validationItems.push(`on_revise.card.ref 引用了不存在的 card: ${selectedState.on_revise.card.ref}`);
    }
  }

  let inspectorHtml = `
    <div class="workflow-definition-state-inspector-head">
      <span>${escapeHtml(selectedState.label || workflowDefinitionSelectedStateKey)} · ${escapeHtml(workflowDefinitionSelectedStateKey)}</span>
      <div class="workflow-definition-state-head-actions">
        <button type="button" class="btn-ghost" data-state-action="rename">重命名</button>
        <button type="button" class="btn-ghost" data-state-action="delete">删除</button>
      </div>
    </div>
    <div class="workflow-definition-state-inspector-body">
      <div class="workflow-definition-state-inspector-grid">
        <label class="workflow-definition-field">
          <span>Type</span>
          <select data-state-field="type">
            <option value="delegation" ${selectedState.type === "delegation" ? "selected" : ""}>delegation</option>
            <option value="confirmation" ${selectedState.type === "confirmation" ? "selected" : ""}>confirmation</option>
            <option value="terminal" ${selectedState.type === "terminal" ? "selected" : ""}>terminal</option>
            <option value="system" ${selectedState.type === "system" ? "selected" : ""}>system</option>
          </select>
        </label>
        <label class="workflow-definition-field">
          <span>Label</span>
          <input data-state-field="label" type="text" value="${escapeAttribute(selectedState.label || "")}" />
        </label>
      </div>
      <label class="workflow-definition-field">
        <span>Description</span>
        <textarea data-state-field="description" rows="2">${escapeHtml(selectedState.description || "")}</textarea>
      </label>
  `;

  if (validationItems.length) {
    inspectorHtml += `
      <section class="workflow-definition-state-validation">
        ${validationItems
          .map((item) => `<div class="workflow-definition-state-validation-item">${escapeHtml(item)}</div>`)
          .join("")}
      </section>
    `;
  }

  if (selectedState.type === "delegation") {
    inspectorHtml += `
      <section class="workflow-definition-state-inspector-section">
        <div class="workflow-definition-state-inspector-title">Delegate</div>
        <div class="workflow-definition-state-inspector-grid">
          <label class="workflow-definition-field">
            <span>Role</span>
            <input list="workflow-definition-role-options" data-state-field="delegate.role" type="text" value="${escapeAttribute(selectedState.delegate?.role || "")}" />
          </label>
          <label class="workflow-definition-field">
            <span>Skill</span>
            <input data-state-field="delegate.skill" type="text" value="${escapeAttribute(selectedState.delegate?.skill || "")}" />
          </label>
        </div>
        <label class="workflow-definition-field workflow-definition-field-block">
          <span>Task Template</span>
          <textarea data-state-field="delegate.task_template" rows="3">${escapeHtml(selectedState.delegate?.task_template || "")}</textarea>
        </label>
      </section>
      <section class="workflow-definition-state-inspector-section">
        <div class="workflow-definition-state-inspector-title">On Complete Success</div>
        ${buildStateTransitionInspectorHtml("on_complete.success", selectedState.on_complete?.success)}
      </section>
      <section class="workflow-definition-state-inspector-section">
        <div class="workflow-definition-state-inspector-title">On Complete Failure</div>
        ${buildStateTransitionInspectorHtml("on_complete.failure", selectedState.on_complete?.failure)}
      </section>
    `;
  } else if (selectedState.type === "confirmation") {
    inspectorHtml += `
      <section class="workflow-definition-state-inspector-section">
        <div class="workflow-definition-state-inspector-title">Card</div>
        <label class="workflow-definition-field">
          <span>Card Ref</span>
          <input list="workflow-definition-card-options" data-state-field="card.ref" type="text" value="${escapeAttribute(selectedState.card?.ref || "")}" />
        </label>
      </section>
      <section class="workflow-definition-state-inspector-section">
        <div class="workflow-definition-state-inspector-title">On Approve</div>
        ${buildStateTransitionInspectorHtml("on_approve", selectedState.on_approve)}
      </section>
      <section class="workflow-definition-state-inspector-section">
        <div class="workflow-definition-state-inspector-title">On Revise</div>
        ${buildStateTransitionInspectorHtml("on_revise", selectedState.on_revise)}
      </section>
    `;
  }

  inspectorHtml += "</div>";
  workflowDefinitionStateInspector.innerHTML = `
    ${inspectorHtml}
    <datalist id="workflow-definition-role-options"></datalist>
    <datalist id="workflow-definition-state-options"></datalist>
    <datalist id="workflow-definition-card-options"></datalist>
  `;

  const roleDatalist = workflowDefinitionStateInspector.querySelector("#workflow-definition-role-options");
  if (roleDatalist) {
    roleDatalist.innerHTML = roleOptions
      .map((role) => `<option value="${escapeAttribute(role)}"></option>`)
      .join("");
  }
  const stateDatalist = workflowDefinitionStateInspector.querySelector("#workflow-definition-state-options");
  if (stateDatalist) {
    stateDatalist.innerHTML = stateOptions
      .map((stateKey) => `<option value="${escapeAttribute(stateKey)}"></option>`)
      .join("");
  }
  const cardDatalist = workflowDefinitionStateInspector.querySelector("#workflow-definition-card-options");
  if (cardDatalist) {
    cardDatalist.innerHTML = cardOptions
      .map((cardKey) => `<option value="${escapeAttribute(cardKey)}"></option>`)
      .join("");
  }
  bindWorkflowDefinitionStateInspectorEvents();
}

function buildWorkflowTransitionSummary(label, transition) {
  if (!transition) return "";
  const lines = [];
  lines.push(`<div><strong>${escapeHtml(label)}</strong>→ ${escapeHtml(transition.target || "--")}</div>`);
  if (transition.delegate?.role || transition.delegate?.skill) {
    lines.push(
      `<span>delegate: ${escapeHtml(
        [transition.delegate?.role, transition.delegate?.skill].filter(Boolean).join(" / ") || "--",
      )}</span>`,
    );
  }
  if (transition.card?.ref) {
    lines.push(`<span>card: ${escapeHtml(transition.card.ref)}</span>`);
  }
  if (transition.notify?.template) {
    lines.push(`<span>notify: ${escapeHtml(transition.notify.template.slice(0, 72))}</span>`);
  }
  if (transition.effects?.increment_round) {
    lines.push("<span>effects: increment_round</span>");
  }
  return `
    <div class="workflow-definition-graph-transition">
      ${lines[0]}
      <div class="workflow-definition-graph-transition-lines">${lines.slice(1).join("")}</div>
    </div>
  `;
}

function renderWorkflowDefinitionGraph(definition) {
  if (!workflowDefinitionGraph) return;
  const states = definition?.states || {};
  const entryStateNames = new Set(
    Object.values(definition?.entry_points || {})
      .map((entry) => entry?.state)
      .filter(Boolean),
  );

  const stateEntries = Object.entries(states);
  if (stateEntries.length === 0) {
    workflowDefinitionGraph.innerHTML =
      '<div class="workflow-definition-graph-empty">当前 definition 没有 states，可先在编辑器里补充。</div>';
    return;
  }

  workflowDefinitionGraph.innerHTML = stateEntries
    .map(([stateKey, state]) => {
      const badges = [
        `<span class="workflow-definition-graph-badge">${escapeHtml(state.type || "--")}</span>`,
      ];
      if (entryStateNames.has(stateKey)) {
        badges.push('<span class="workflow-definition-graph-badge">entry</span>');
      }
      const meta = [];
      if (state.delegate?.role) {
        meta.push(`<span>role: ${escapeHtml(state.delegate.role)}</span>`);
      }
      if (state.delegate?.skill) {
        meta.push(`<span>skill: ${escapeHtml(state.delegate.skill)}</span>`);
      }
      if (state.card?.ref) {
        meta.push(`<span>card: ${escapeHtml(state.card.ref)}</span>`);
      }

      const transitions = [];
      if (state.on_complete?.success) {
        transitions.push(buildWorkflowTransitionSummary("success", state.on_complete.success));
      }
      if (state.on_complete?.failure) {
        transitions.push(buildWorkflowTransitionSummary("failure", state.on_complete.failure));
      }
      if (state.on_approve) {
        transitions.push(buildWorkflowTransitionSummary("approve", state.on_approve));
      }
      if (state.on_revise) {
        transitions.push(buildWorkflowTransitionSummary("revise", state.on_revise));
      }

      return `
        <article
          class="workflow-definition-graph-node ${escapeHtml(state.type || "unknown")}${entryStateNames.has(stateKey) ? " entry" : ""}${workflowDefinitionSelectedStateKey === stateKey ? " active" : ""}"
          data-state-key="${escapeHtml(stateKey)}"
        >
          <div class="workflow-definition-graph-node-head">
            <div>
              <div class="workflow-definition-graph-node-title">${escapeHtml(state.label || stateKey)}</div>
              <div class="workflow-definition-graph-node-subtitle">${escapeHtml(stateKey)}</div>
            </div>
            <div class="workflow-definition-graph-node-badges">${badges.join("")}</div>
          </div>
          ${meta.length ? `<div class="workflow-definition-graph-meta">${meta.join("")}</div>` : ""}
          ${
            transitions.length
              ? `<div class="workflow-definition-graph-transitions">${transitions.join("")}</div>`
              : '<div class="workflow-definition-graph-empty">无后续 transition</div>'
          }
        </article>
      `;
    })
    .join("");

  Array.from(workflowDefinitionGraph.querySelectorAll("[data-state-key]")).forEach((node) => {
    node.addEventListener("click", () => {
      const stateKey = node.getAttribute("data-state-key") || "";
      if (!stateKey) return;
      updateWorkflowDefinitionSelectedState(stateKey);
    });
  });
}

function getWorkflowDefinitionDiffComparable(version) {
  if (!version) return null;
  const metadata = cloneJson(version.metadata || {});
  delete metadata.created_at;
  delete metadata.updated_at;
  delete metadata.based_on_version;
  return {
    name: version.name || "",
    description: version.description || "",
    roles: cloneJson(version.roles || {}),
    entry_points: cloneJson(version.entry_points || {}),
    states: cloneJson(version.states || {}),
    status_labels: cloneJson(version.status_labels || {}),
    create_form: cloneJson(version.create_form || {}),
    metadata,
  };
}

function getWorkflowDefinitionVersionStatusLabel(status) {
  if (status === "published") return "Published";
  if (status === "draft") return "Draft";
  if (status === "archived") return "Archived";
  return status || "Unknown";
}

function getWorkflowDefinitionVersionByNumber(versionNumber) {
  return getWorkflowDefinitionVersionList().find((version) => version.version === versionNumber) || null;
}

function clearWorkflowDefinitionVersionDiffFocus() {
  workflowDefinitionDiffFocus = null;
}

function closeWorkflowDefinitionDiffModal() {
  clearWorkflowDefinitionVersionDiffFocus();
  if (workflowDefinitionDiffModal) {
    workflowDefinitionDiffModal.classList.add("hidden");
  }
}

function openWorkflowDefinitionDiffModal(sourceVersion, targetVersion) {
  setWorkflowDefinitionVersionDiffFocus(sourceVersion, targetVersion);
  renderWorkflowDefinitionDiff(currentWorkflowDefinitionDetail);
  if (workflowDefinitionDiffModal) {
    workflowDefinitionDiffModal.classList.remove("hidden");
  }
}

function setWorkflowDefinitionVersionDiffFocus(sourceVersion, targetVersion) {
  if (!sourceVersion || !targetVersion || sourceVersion.version === targetVersion.version) {
    clearWorkflowDefinitionVersionDiffFocus();
    return;
  }
  workflowDefinitionDiffFocus = {
    sourceVersion: sourceVersion.version,
    targetVersion: targetVersion.version,
  };
}

function showWorkflowDefinitionVersionContextMenu(e, version) {
  closeKnowledgeImportMenu();
  document.querySelector(".context-menu")?.remove();

  const published = currentWorkflowDefinitionDetail?.published_definition || null;
  const draft = currentWorkflowDefinitionDetail?.draft_definition || null;
  const remainingVersions = getWorkflowDefinitionVersionList().filter((item) => item.version !== version.version);
  const compareTarget =
    version.status === "published"
      ? draft && draft.version !== version.version
        ? draft
        : null
      : published && published.version !== version.version
        ? published
        : draft && draft.version !== version.version
          ? draft
          : null;
  const canCopy = version.status !== "draft";
  const canPublish = version.status !== "published";
  const canDelete =
    version.status !== "published" &&
    remainingVersions.length > 0 &&
    remainingVersions.some((item) => item.status === "published");

  const items = [
    {
      label: canCopy ? "复制为 draft" : "当前版本已是 draft",
      icon: "⎘",
      disabled: !canCopy,
      action: async () => {
        await copySelectedWorkflowDefinitionVersionToDraft(version);
      },
    },
    {
      label: canPublish ? "发布该版本" : "当前版本已发布",
      icon: "🚀",
      disabled: !canPublish,
      action: async () => {
        await publishWorkflowDefinitionVersion(version);
      },
    },
    {
      label: compareTarget
        ? `查看与 v${compareTarget.version} 的差异`
        : "当前没有可对比版本",
      icon: "⇄",
      disabled: !compareTarget,
      action: async () => {
        workflowDefinitionSelectedVersion = version.version;
        renderWorkflowDefinitionVersions();
        openWorkflowDefinitionDiffModal(compareTarget, version);
      },
    },
    {
      label: canDelete ? "删除该版本" : "当前版本不可删除",
      icon: "🗑",
      disabled: !canDelete,
      action: async () => {
        await deleteWorkflowDefinitionVersion(version);
      },
    },
  ];

  const menu = document.createElement("div");
  menu.className = "context-menu";

  for (const item of items) {
    const el = document.createElement("div");
    el.className = `context-menu-item${item.disabled ? " disabled" : ""}`;
    el.innerHTML = `<span class="context-menu-icon">${item.icon}</span>${escapeHtml(item.label)}`;
    if (!item.disabled) {
      el.addEventListener("click", async () => {
        menu.remove();
        await item.action();
      });
    }
    menu.appendChild(el);
  }

  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 8}px`;

  const closeHandler = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener("click", closeHandler);
    }
  };
  requestAnimationFrame(() => document.addEventListener("click", closeHandler));
}

function renderWorkflowDefinitionVersions() {
  if (!workflowDefinitionVersions || !workflowDefinitionVersionSummary) return;
  const versions = getWorkflowDefinitionVersionList();
  workflowDefinitionVersionSummary.textContent = versions.length
    ? `共 ${versions.length} 个版本 · 右键版本可复制、发布、对比或删除`
    : "暂无版本";
  workflowDefinitionVersions.innerHTML = "";
  if (!versions.length) {
    workflowDefinitionVersions.innerHTML = '<div class="workflow-definition-list-empty">当前 definition 还没有任何版本。</div>';
    return;
  }
  versions.forEach((version) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `workflow-definition-version-chip${version.version === workflowDefinitionSelectedVersion ? " active" : ""}`;
    button.innerHTML = `
      <div class="workflow-definition-version-chip-head">
        <strong>v${escapeHtml(String(version.version))}</strong>
        <span class="workflow-definition-version-status workflow-definition-version-status-${escapeHtml(version.status || "unknown")}">
          ${escapeHtml(getWorkflowDefinitionVersionStatusLabel(version.status))}
        </span>
      </div>
      <span>${escapeHtml(version.name || version.key || "")}</span>
    `;
    button.addEventListener("click", () => {
      workflowDefinitionSelectedVersion = version.version;
      clearWorkflowDefinitionVersionDiffFocus();
      renderWorkflowDefinitionDetailPane();
    });
    button.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      workflowDefinitionSelectedVersion = version.version;
      renderWorkflowDefinitionDetailPane();
      showWorkflowDefinitionVersionContextMenu(e, version);
    });
    workflowDefinitionVersions.appendChild(button);
  });
}

function renderWorkflowDefinitionDetailPane() {
  if (!workflowDefinitionEmpty || !workflowDefinitionDetail) return;
  if (!currentWorkflowDefinitionDetail) {
    workflowDefinitionEmpty.classList.remove("hidden");
    workflowDefinitionDetail.classList.add("hidden");
    return;
  }

  const detail = currentWorkflowDefinitionDetail;
  const bundle = detail.bundle || {};
  const selectedVersion = getSelectedWorkflowDefinitionVersion();
  const isDraftSelected = selectedVersion?.status === "draft";
  const isGraphMode = workflowDefinitionViewMode === "graph";
  const isJsonMode = workflowDefinitionViewMode === "json";
  const canEditCurrentView = getWorkflowDefinitionModeAllowsEditing() && isDraftSelected;
  const displayDefinition = selectedVersion || null;
  const graphSource = displayDefinition;
  workflowDefinitionEmpty.classList.add("hidden");
  workflowDefinitionDetail.classList.remove("hidden");
  if (workflowDefinitionTitle) {
    workflowDefinitionTitle.textContent = bundle.label || displayDefinition?.name || bundle.key || "--";
  }
  if (workflowDefinitionSummary) {
    workflowDefinitionSummary.textContent =
      bundle.description ||
      displayDefinition?.description ||
      "当前 workflow definition 暂无描述。";
  }
  if (workflowDefinitionMeta) {
    const meta = [];
    meta.push(`<span class="workflow-definition-pill workflow-definition-main-pill"><strong>Key</strong>${escapeHtml(bundle.key || "")}</span>`);
    meta.push(
      `<span class="workflow-definition-pill"><strong>Published</strong>${escapeHtml(detail.published_definition ? `v${detail.published_definition.version}` : "--")}</span>`,
    );
    meta.push(
      `<span class="workflow-definition-pill"><strong>Draft</strong>${escapeHtml(detail.draft_definition ? `v${detail.draft_definition.version}` : "--")}</span>`,
    );
    meta.push(
      `<span class="workflow-definition-pill"><strong>Versions</strong>${escapeHtml(String(Array.isArray(bundle.versions) ? bundle.versions.length : 0))}</span>`,
    );
    workflowDefinitionMeta.innerHTML = meta.join("");
  }

  if (workflowDefinitionPublishBtn) {
    workflowDefinitionPublishBtn.disabled = !canEditCurrentView;
    workflowDefinitionPublishBtn.classList.toggle("hidden", !canEditCurrentView);
  }
  if (workflowDefinitionPreviewCreateFormBtn) {
    workflowDefinitionPreviewCreateFormBtn.disabled = !displayDefinition;
    workflowDefinitionPreviewCreateFormBtn.classList.toggle("hidden", !displayDefinition);
  }
  if (workflowDefinitionSaveBtn) {
    workflowDefinitionSaveBtn.classList.toggle("hidden", !canEditCurrentView);
  }
  if (workflowDefinitionEditorGrid) {
    workflowDefinitionEditorGrid.classList.toggle("hidden", isJsonMode);
    workflowDefinitionEditorGrid.classList.toggle("workflow-definition-grid-single", !isJsonMode);
  }
  if (workflowDefinitionFormPanel) {
    workflowDefinitionFormPanel.classList.toggle("hidden", isGraphMode);
  }
  if (workflowDefinitionJsonPanel) {
    workflowDefinitionJsonPanel.classList.toggle("hidden", !isJsonMode);
  }
  if (workflowDefinitionSidepanels) {
    const shouldShowSidepanels = isGraphMode || !workflowDefinitionValidationPanel?.classList.contains("hidden");
    workflowDefinitionSidepanels.classList.toggle("hidden", !shouldShowSidepanels);
  }
  if (workflowDefinitionGraphPanel) {
    workflowDefinitionGraphPanel.classList.toggle("hidden", !isGraphMode);
  }
  if (workflowDefinitionViewFormBtn) {
    workflowDefinitionViewFormBtn.classList.toggle("active", workflowDefinitionViewMode === "form");
  }
  if (workflowDefinitionViewJsonBtn) {
    workflowDefinitionViewJsonBtn.classList.toggle("active", workflowDefinitionViewMode === "json");
  }
  if (workflowDefinitionViewGraphBtn) {
    workflowDefinitionViewGraphBtn.classList.toggle("active", workflowDefinitionViewMode === "graph");
  }
  if (displayDefinition) {
    renderWorkflowDefinitionEditor(displayDefinition, bundle);
  }
  if (workflowDefinitionJsonEditor && displayDefinition) {
    if (!(document.activeElement === workflowDefinitionJsonEditor && workflowDefinitionViewMode === "json")) {
      workflowDefinitionJsonEditor.value = stringifyPrettyJson(buildWorkflowDefinitionJsonDocument(displayDefinition));
    }
    workflowDefinitionJsonEditor.disabled = !canEditCurrentView;
  }
  setWorkflowDefinitionEditorReadonly(!canEditCurrentView, selectedVersion);
  renderWorkflowDefinitionVersions();
  renderWorkflowDefinitionGraph(graphSource);
  if (!canEditCurrentView && !isGraphMode) {
    hideWorkflowDefinitionValidationPanel();
  }
}

function renderWorkflowDefinitionList() {
  if (!workflowDefinitionList) return;
  workflowDefinitionList.innerHTML = "";
  if (!Array.isArray(workflowDefinitionBundles) || workflowDefinitionBundles.length === 0) {
    workflowDefinitionList.innerHTML =
      '<div class="workflow-definition-list-empty">还没有 workflow definitions，点击右上角 + 开始创建。</div>';
    return;
  }
  workflowDefinitionBundles.forEach((bundle) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `workflow-definition-list-item${bundle.key === currentWorkflowDefinitionKey ? " active" : ""}`;
    item.innerHTML = `
      <div class="workflow-definition-list-head">
        <div>
          <div class="workflow-definition-list-title">${escapeHtml(bundle.label || bundle.key || "")}</div>
          <div class="workflow-definition-list-key">${escapeHtml(bundle.key || "")}</div>
        </div>
      </div>
      <p class="workflow-definition-list-desc">${escapeHtml(bundle.description || "暂无描述")}</p>
      <div class="workflow-definition-list-meta">
        <span class="workflow-definition-pill"><strong>Published</strong>${escapeHtml(bundle.published_version ? `v${bundle.published_version}` : "--")}</span>
        <span class="workflow-definition-pill"><strong>Draft</strong>${escapeHtml(bundle.draft_version ? `v${bundle.draft_version}` : "--")}</span>
        <span class="workflow-definition-pill"><strong>Count</strong>${escapeHtml(String(bundle.version_count || 0))}</span>
      </div>
    `;
    item.addEventListener("click", () => {
      loadWorkflowDefinitionDetail(bundle.key);
    });
    workflowDefinitionList.appendChild(item);
  });
}

async function loadWorkflowDefinitionDetail(key) {
  const safeKey = (key || "").trim();
  if (!safeKey) return;
  currentWorkflowDefinitionKey = safeKey;
  renderWorkflowDefinitionList();
  hideWorkflowDefinitionValidationPanel();
  const reqSeq = ++workflowDefinitionRequestSeq;
  try {
    const res = await apiFetch(`/api/workflow-definitions/${encodeURIComponent(safeKey)}`);
    const data = await res.json();
    if (reqSeq !== workflowDefinitionRequestSeq) return;
    if (!res.ok) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    currentWorkflowDefinitionDetail = data;
    workflowDefinitionReferenceDetails[safeKey] = data;
    clearWorkflowDefinitionVersionDiffFocus();
    if (workflowDefinitionDiffModal) {
      workflowDefinitionDiffModal.classList.add("hidden");
    }
    workflowDefinitionSelectedRoleKey = "";
    workflowDefinitionSelectedEntryPointKey = "";
    workflowDefinitionSelectedStateKey = "";
    workflowDefinitionSelectedStatusLabelKey = "";
    const versions = getWorkflowDefinitionVersionList();
    if (!versions.some((version) => version.version === workflowDefinitionSelectedVersion)) {
      workflowDefinitionSelectedVersion = versions[0]?.version ?? null;
    }
    renderWorkflowDefinitionList();
    renderWorkflowDefinitionDetailPane();
  } catch (err) {
    if (reqSeq !== workflowDefinitionRequestSeq) return;
    console.error("Failed to load workflow definition detail:", err);
    currentWorkflowDefinitionDetail = null;
    renderWorkflowDefinitionDetailPane();
    alert(err instanceof Error ? err.message : "流程定义详情加载失败");
  }
}

async function loadWorkflowDefinitions(options = {}) {
  const preserveSelection = options.preserveSelection !== false;
  if (workflowDefinitionRefreshBtn) {
    workflowDefinitionRefreshBtn.classList.add("spinning");
  }
  try {
    const [definitionsRes, cardsRes] = await Promise.all([
      apiFetch("/api/workflow-definitions"),
      apiFetch("/api/cards"),
    ]);
    const data = await definitionsRes.json();
    const cardsData = await cardsRes.json();
    if (!definitionsRes.ok) {
      throw new Error(data?.error || `HTTP ${definitionsRes.status}`);
    }
    workflowDefinitionCardsRegistry = cardsRes.ok ? cardsData?.cards || {} : {};
    workflowDefinitionBundles = Array.isArray(data.definitions) ? data.definitions : [];
    if (!preserveSelection || !workflowDefinitionBundles.some((bundle) => bundle.key === currentWorkflowDefinitionKey)) {
      currentWorkflowDefinitionKey = workflowDefinitionBundles[0]?.key || "";
    }
    renderWorkflowDefinitionList();
    if (currentWorkflowDefinitionKey) {
      await loadWorkflowDefinitionDetail(currentWorkflowDefinitionKey);
    } else {
      currentWorkflowDefinitionDetail = null;
      workflowDefinitionSelectedVersion = null;
      clearWorkflowDefinitionVersionDiffFocus();
      if (workflowDefinitionDiffModal) {
        workflowDefinitionDiffModal.classList.add("hidden");
      }
      renderWorkflowDefinitionDetailPane();
    }
  } catch (err) {
    console.error("Failed to load workflow definitions:", err);
    workflowDefinitionBundles = [];
    currentWorkflowDefinitionDetail = null;
    clearWorkflowDefinitionVersionDiffFocus();
    if (workflowDefinitionDiffModal) {
      workflowDefinitionDiffModal.classList.add("hidden");
    }
    renderWorkflowDefinitionList();
    renderWorkflowDefinitionDetailPane();
    if (workflowDefinitionList) {
      workflowDefinitionList.innerHTML =
        `<div class="workflow-definition-list-empty">流程定义加载失败：${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
    }
  } finally {
    if (workflowDefinitionRefreshBtn) {
      workflowDefinitionRefreshBtn.classList.remove("spinning");
    }
  }
}

async function saveWorkflowDefinitionDraft() {
  try {
    const payload = getWorkflowDefinitionSavePayload();
    const res = await apiFetch(`/api/workflow-definitions/${encodeURIComponent(payload.key)}`, {
      method: "POST",
      body: JSON.stringify({
        label: payload.label,
        description: payload.description,
        definition: payload.definition,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    showToast(`已保存 ${payload.key} draft`);
    await loadWorkflowDefinitions({ preserveSelection: true });
    await loadWorkflowDefinitionDetail(payload.key);
  } catch (err) {
    console.error("Failed to save workflow definition draft:", err);
    alert(err instanceof Error ? err.message : "保存 draft 失败");
  }
}

function collectWorkflowDefinitionPublishLocalErrors() {
  try {
    const payload = getWorkflowDefinitionSavePayload();
    return {
      payload,
      items: collectWorkflowDefinitionValidationItems(payload.definition, payload.key),
    };
  } catch (err) {
    return {
      payload: null,
      items: [{ group: "json", message: err instanceof Error ? err.message : String(err) }],
    };
  }
}

async function publishWorkflowDefinitionDraft() {
  if (!currentWorkflowDefinitionKey) {
    alert("请先选择 workflow definition");
    return;
  }
  const localValidation = collectWorkflowDefinitionPublishLocalErrors();
  if (localValidation.items.length > 0) {
    renderWorkflowDefinitionValidationPanel({
      localValidationItems: localValidation.items,
      serverErrors: [],
    });
    return;
  }
  try {
    const payload = localValidation.payload;
    const saveRes = await apiFetch(`/api/workflow-definitions/${encodeURIComponent(payload.key)}`, {
      method: "POST",
      body: JSON.stringify({
        label: payload.label,
        description: payload.description,
        definition: payload.definition,
      }),
    });
    const saveData = await saveRes.json();
    if (!saveRes.ok) {
      renderWorkflowDefinitionValidationPanel({
        localValidationItems: [],
        serverErrors: [saveData?.error || `HTTP ${saveRes.status}`],
      });
      return;
    }

    const publishRes = await apiFetch(
      `/api/workflow-definitions/${encodeURIComponent(currentWorkflowDefinitionKey)}/publish`,
      { method: "POST", body: JSON.stringify({}) },
    );
    const publishData = await publishRes.json();
    if (!publishRes.ok) {
      renderWorkflowDefinitionValidationPanel({
        localValidationItems: [],
        serverErrors: String(publishData?.error || `HTTP ${publishRes.status}`)
          .split(";")
          .map((item) => item.trim())
          .filter(Boolean),
      });
      return;
    }
    hideWorkflowDefinitionValidationPanel();
    showToast(`已发布 ${currentWorkflowDefinitionKey}`);
    await loadWorkflowDefinitions({ preserveSelection: true });
    await loadWorkflowDefinitionDetail(currentWorkflowDefinitionKey);
  } catch (err) {
    console.error("Failed to publish workflow definition:", err);
    alert(err instanceof Error ? err.message : "发布 draft 失败");
  }
}

async function publishWorkflowDefinitionVersion(version) {
  const bundleKey = currentWorkflowDefinitionDetail?.bundle?.key;
  if (!bundleKey || !version?.version) {
    alert("当前没有可发布的版本");
    return;
  }
  if (!(await openConfirmDialog(`确认发布 ${bundleKey} 的 v${version.version} 吗？`, { title: "发布版本" }))) {
    return;
  }
  try {
    const res = await apiFetch(`/api/workflow-definitions/${encodeURIComponent(bundleKey)}/publish`, {
      method: "POST",
      body: JSON.stringify({ version: version.version }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    clearWorkflowDefinitionVersionDiffFocus();
    workflowDefinitionSelectedVersion = data?.definition?.version || version.version;
    showToast(`已发布 v${version.version}`);
    await loadWorkflowDefinitions({ preserveSelection: true });
    await loadWorkflowDefinitionDetail(bundleKey);
  } catch (err) {
    console.error("Failed to publish workflow definition version:", err);
    alert(err instanceof Error ? err.message : "发布版本失败");
  }
}

async function copyPublishedWorkflowDefinitionToDraft() {
  const published = currentWorkflowDefinitionDetail?.published_definition;
  const bundle = currentWorkflowDefinitionDetail?.bundle;
  if (!published || !bundle?.key) {
    alert("当前没有 published version 可复制");
    return;
  }
  try {
    const nextMetadata = {
      ...(published.metadata || {}),
      based_on_version: published.version,
      updated_at: new Date().toISOString(),
    };
    const res = await apiFetch(`/api/workflow-definitions/${encodeURIComponent(bundle.key)}`, {
      method: "POST",
      body: JSON.stringify({
        label: bundle.label || published.name || bundle.key,
        description: bundle.description || published.description || "",
        definition: {
          name: published.name,
          description: published.description || "",
          roles: cloneJson(published.roles || {}),
          entry_points: cloneJson(published.entry_points || {}),
          states: cloneJson(published.states || {}),
          status_labels: cloneJson(published.status_labels || {}),
          metadata: nextMetadata,
        },
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    clearWorkflowDefinitionVersionDiffFocus();
    workflowDefinitionSelectedVersion = data?.definition?.version || published.version;
    showToast("已复制 published 到 draft");
    await loadWorkflowDefinitions({ preserveSelection: true });
    await loadWorkflowDefinitionDetail(bundle.key);
  } catch (err) {
    console.error("Failed to copy published definition:", err);
    alert(err instanceof Error ? err.message : "复制 published 失败");
  }
}

async function copySelectedWorkflowDefinitionVersionToDraft(selectedVersion) {
  const selected = selectedVersion || getSelectedWorkflowDefinitionVersion();
  const bundle = currentWorkflowDefinitionDetail?.bundle;
  if (!selected || !bundle?.key) {
    alert("当前没有可复制的版本");
    return;
  }
  try {
    const nextMetadata = {
      ...(selected.metadata || {}),
      based_on_version: selected.version,
      updated_at: new Date().toISOString(),
    };
    const res = await apiFetch(`/api/workflow-definitions/${encodeURIComponent(bundle.key)}`, {
      method: "POST",
      body: JSON.stringify({
        label: bundle.label || selected.name || bundle.key,
        description: bundle.description || selected.description || "",
        definition: {
          name: selected.name,
          description: selected.description || "",
          roles: cloneJson(selected.roles || {}),
          entry_points: cloneJson(selected.entry_points || {}),
          states: cloneJson(selected.states || {}),
          status_labels: cloneJson(selected.status_labels || {}),
          metadata: nextMetadata,
        },
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    clearWorkflowDefinitionVersionDiffFocus();
    workflowDefinitionSelectedVersion = data?.definition?.version || null;
    showToast(`已复制 v${selected.version} 到 draft`);
    await loadWorkflowDefinitions({ preserveSelection: true });
    await loadWorkflowDefinitionDetail(bundle.key);
  } catch (err) {
    console.error("Failed to copy selected workflow definition version:", err);
    alert(err instanceof Error ? err.message : "复制选中版本失败");
  }
}

async function deleteWorkflowDefinitionVersion(version) {
  const bundleKey = currentWorkflowDefinitionDetail?.bundle?.key;
  if (!bundleKey || !version?.version) {
    alert("当前没有可删除的版本");
    return;
  }
  if (!(await openConfirmDialog(`确认删除 ${bundleKey} 的 v${version.version} 吗？`, { title: "删除版本" }))) {
    return;
  }
  try {
    const res = await apiFetch(`/api/workflow-definitions/${encodeURIComponent(bundleKey)}/version`, {
      method: "DELETE",
      body: JSON.stringify({ version: version.version }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    if (workflowDefinitionSelectedVersion === version.version) {
      workflowDefinitionSelectedVersion = null;
    }
    if (
      workflowDefinitionDiffFocus &&
      (workflowDefinitionDiffFocus.sourceVersion === version.version ||
        workflowDefinitionDiffFocus.targetVersion === version.version)
    ) {
      clearWorkflowDefinitionVersionDiffFocus();
    }
    showToast(`已删除 v${version.version}`);
    await loadWorkflowDefinitions({ preserveSelection: true });
    await loadWorkflowDefinitionDetail(bundleKey);
  } catch (err) {
    console.error("Failed to delete workflow definition version:", err);
    alert(err instanceof Error ? err.message : "删除版本失败");
  }
}

async function createWorkflowDefinition() {
  const rawKey = await openTextPrompt("输入新的 workflow key", "", { title: "新建流程定义" });
  const key = (rawKey || "").trim();
  if (!key) return;
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
    alert("workflow key 仅支持字母、数字、_ 和 -");
    return;
  }
  if (workflowDefinitionBundles.some((bundle) => bundle.key === key)) {
    alert(`workflow definition "${key}" 已存在`);
    return;
  }
  const name = ((await openTextPrompt("输入流程名称", key, { title: "新建流程定义" })) || key).trim();
  const description = (
    (await openTextPrompt("输入流程描述（可选）", "", { title: "新建流程定义", multiline: true })) ||
    ""
  ).trim();

  const template = createWorkflowDefinitionTemplate(key, name, description);
  try {
    const res = await apiFetch(`/api/workflow-definitions/${encodeURIComponent(key)}`, {
      method: "POST",
      body: JSON.stringify({
        label: name,
        description,
        definition: {
          name: template.name,
          description: template.description,
          roles: template.roles,
          entry_points: template.entry_points,
          states: template.states,
          status_labels: template.status_labels,
          metadata: template.metadata,
        },
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    currentWorkflowDefinitionKey = key;
    workflowDefinitionSelectedVersion = null;
    showToast(`已创建 ${key}`);
    await loadWorkflowDefinitions({ preserveSelection: true });
    await loadWorkflowDefinitionDetail(key);
  } catch (err) {
    console.error("Failed to create workflow definition:", err);
    alert(err instanceof Error ? err.message : "创建流程定义失败");
  }
}

function getSortedCardWorkflowTypes() {
  return Object.keys(cardsRegistry || {}).sort((a, b) => a.localeCompare(b));
}

function getCurrentCardConfig() {
  if (!currentCardSelection) return null;
  return cardsRegistry?.[currentCardSelection.workflowType]?.[currentCardSelection.cardKey] || null;
}

function createEmptyCardConfig() {
  return {
    pattern: "info_actions",
    header: {
      title_template: "",
      color: "blue",
    },
    body_template: "",
    actions: [],
  };
}

function normalizeCardConfig(card) {
  const safe = cloneJson(card || {});
  return {
    pattern: safe.pattern || "info_actions",
    header: {
      title_template: safe.header?.title_template || "",
      color: safe.header?.color || "blue",
    },
    body_template: safe.body_template || "",
    actions: Array.isArray(safe.actions) ? safe.actions : [],
    form: safe.form
      ? {
          name: safe.form.name || "",
          submit_action: {
            id: safe.form.submit_action?.id || "",
            label: safe.form.submit_action?.label || "",
            type: safe.form.submit_action?.type || "",
          },
          fields: Array.isArray(safe.form.fields) ? safe.form.fields : [],
        }
      : null,
    sections: Array.isArray(safe.sections) ? safe.sections : [],
  };
}

function getCardEditorWorkflowTypeDraft() {
  return (cardsManagementWorkflowTypeInput?.value || currentCardSelection?.workflowType || "").trim();
}

function getCardEditorKeyDraft() {
  return (cardsManagementCardKeyInput?.value || currentCardSelection?.cardKey || "").trim();
}

function parseCardOptionsText(raw) {
  return String(raw || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("|");
      const value = (parts.shift() || "").trim();
      const label = parts.join("|").trim();
      return label ? { value, label } : { value };
    })
    .filter((item) => item.value);
}

function parseCardActionJsonText(raw) {
  const text = String(raw || "").trim();
  if (!text) return { actions: [], error: null };
  try {
    const parsed = JSON.parse(text);
    return { actions: Array.isArray(parsed) ? parsed : [], error: null };
  } catch (err) {
    return { actions: [], error: err instanceof Error ? err.message : "Invalid JSON" };
  }
}

function getSelectedCardsPreviewPreset() {
  const key = cardsManagementPreviewPreset?.value || "default";
  return cloneJson(cardsPreviewPresets[key] || cardsPreviewPresets.default);
}

function syncCardsPreviewDataInputFromPreset() {
  if (!cardsManagementPreviewData) return;
  cardsManagementPreviewData.value = JSON.stringify(getSelectedCardsPreviewPreset(), null, 2);
}

function getCardsPreviewData() {
  const fallback = getSelectedCardsPreviewPreset();
  const raw = cardsManagementPreviewData?.value || "";
  const text = raw.trim();
  if (!text) {
    return { data: fallback, error: null };
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { data: fallback, error: "Mock Data JSON 必须是对象" };
    }
    return { data: parsed, error: null };
  } catch (err) {
    return { data: fallback, error: err instanceof Error ? err.message : "Invalid JSON" };
  }
}

function renderCardRowEmpty(container, message) {
  if (!container) return;
  container.innerHTML = `<div class="cards-management-row-empty">${escapeHtml(message)}</div>`;
}

function clearCardsFieldErrors() {
  document.querySelectorAll(".cards-management-field-error").forEach((el) => el.remove());
  document.querySelectorAll(".workflow-definition-field.cards-management-field-invalid").forEach((el) => {
    el.classList.remove("cards-management-field-invalid");
  });
}

function renderCardsFieldErrors(errors) {
  clearCardsFieldErrors();
  const errorMap = new Map();
  (errors || []).forEach((error) => {
    if (!error?.path || !error?.message) return;
    if (!errorMap.has(error.path)) errorMap.set(error.path, []);
    errorMap.get(error.path).push(error.message);
  });
  errorMap.forEach((messages, path) => {
    const field = document.querySelector(`.workflow-definition-field[data-card-field-path="${path}"]`);
    if (!field) return;
    field.classList.add("cards-management-field-invalid");
    const error = document.createElement("div");
    error.className = "cards-management-field-error";
    error.textContent = messages[0];
    field.appendChild(error);
  });
}

function getCardsManagementIconSvg(name) {
  const icons = {
    add: '<svg class="cards-management-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>',
    remove: '<svg class="cards-management-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>',
    up: '<svg class="cards-management-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6l-6 6M12 6l6 6M12 6v12" /></svg>',
    down: '<svg class="cards-management-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 18l-6-6M12 18l6-6M12 6v12" /></svg>',
    jump: '<svg class="cards-management-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17L17 7" /><path d="M9 7h8v8" /></svg>',
  };
  return icons[name] || "";
}

function renderCardActionRows(actions) {
  if (!cardsManagementActions) return;
  const rows = Array.isArray(actions) ? actions : [];
  if (!rows.length) {
    renderCardRowEmpty(cardsManagementActions, "当前没有 actions，可新增按钮动作。");
    return;
  }
  cardsManagementActions.innerHTML = rows
    .map((action, index) => `
      <div class="cards-management-row" data-card-action-row="${index}">
        <div class="cards-management-row-head">
          <div class="cards-management-row-title">Action ${index + 1}</div>
          <button type="button" class="cards-management-icon-btn danger" data-card-action-remove="${index}" title="删除操作" aria-label="删除操作">${getCardsManagementIconSvg("remove")}</button>
        </div>
        <div class="cards-management-row-grid">
          <label class="workflow-definition-field" data-card-field-path="actions[${index}].id">
            <span>ID</span>
            <input data-card-action-field="${index}.id" type="text" value="${escapeAttribute(action.id || "")}" />
          </label>
          <label class="workflow-definition-field">
            <span>Label</span>
            <input data-card-action-field="${index}.label" type="text" value="${escapeAttribute(action.label || "")}" />
          </label>
          <label class="workflow-definition-field">
            <span>Type</span>
            <select data-card-action-field="${index}.type">
              <option value=""${!action.type ? " selected" : ""}>default</option>
              <option value="primary"${action.type === "primary" ? " selected" : ""}>primary</option>
              <option value="danger"${action.type === "danger" ? " selected" : ""}>danger</option>
            </select>
          </label>
        </div>
      </div>
    `)
    .join("");
}

function renderCardFormFields(fields) {
  if (!cardsManagementFormFields) return;
  const rows = Array.isArray(fields) ? fields : [];
  if (!rows.length) {
    renderCardRowEmpty(cardsManagementFormFields, "当前没有 form fields，可新增输入项。");
    return;
  }
  cardsManagementFormFields.innerHTML = rows
    .map((field, index) => `
      <div class="cards-management-row" data-card-form-field-row="${index}">
        <div class="cards-management-row-head">
          <div class="cards-management-row-title">Field ${index + 1}</div>
          <button type="button" class="cards-management-icon-btn danger" data-card-form-field-remove="${index}" title="删除字段" aria-label="删除字段">${getCardsManagementIconSvg("remove")}</button>
        </div>
        <div class="cards-management-row-grid">
          <label class="workflow-definition-field" data-card-field-path="form.fields[${index}].name">
            <span>Name</span>
            <input data-card-form-field="${index}.name" type="text" value="${escapeAttribute(field.name || "")}" />
          </label>
          <label class="workflow-definition-field">
            <span>Label</span>
            <input data-card-form-field="${index}.label" type="text" value="${escapeAttribute(field.label || "")}" />
          </label>
          <label class="workflow-definition-field">
            <span>Type</span>
            <select data-card-form-field="${index}.type">
              ${["text", "textarea", "number", "integer", "boolean", "enum"].map((type) => `<option value="${type}"${field.type === type ? " selected" : ""}>${type}</option>`).join("")}
            </select>
          </label>
        </div>
        <div class="cards-management-row-grid compact">
          <label class="workflow-definition-field">
            <span>Placeholder</span>
            <input data-card-form-field="${index}.placeholder" type="text" value="${escapeAttribute(field.placeholder || "")}" />
          </label>
          <label class="workflow-definition-field">
            <span>Format</span>
            <select data-card-form-field="${index}.format">
              <option value=""${!field.format ? " selected" : ""}>none</option>
              <option value="email"${field.format === "email" ? " selected" : ""}>email</option>
              <option value="uri"${field.format === "uri" ? " selected" : ""}>uri</option>
              <option value="date"${field.format === "date" ? " selected" : ""}>date</option>
              <option value="date-time"${field.format === "date-time" ? " selected" : ""}>date-time</option>
            </select>
          </label>
        </div>
        <div class="cards-management-row-grid">
          <label class="workflow-definition-field">
            <span>Min</span>
            <input data-card-form-field="${index}.min" type="number" value="${escapeAttribute(field.min ?? "")}" />
          </label>
          <label class="workflow-definition-field">
            <span>Max</span>
            <input data-card-form-field="${index}.max" type="number" value="${escapeAttribute(field.max ?? "")}" />
          </label>
          <label class="workflow-definition-field">
            <span>Required</span>
            <select data-card-form-field="${index}.required">
              <option value="false"${field.required ? "" : " selected"}>false</option>
              <option value="true"${field.required ? " selected" : ""}>true</option>
            </select>
          </label>
        </div>
        <div class="cards-management-row-grid">
          <label class="workflow-definition-field">
            <span>Min Length</span>
            <input data-card-form-field="${index}.min_length" type="number" value="${escapeAttribute(field.min_length ?? "")}" />
          </label>
          <label class="workflow-definition-field">
            <span>Max Length</span>
            <input data-card-form-field="${index}.max_length" type="number" value="${escapeAttribute(field.max_length ?? "")}" />
          </label>
          <label class="workflow-definition-field" data-card-field-path="form.fields[${index}].options">
            <span>Options</span>
            <textarea data-card-form-field="${index}.options" rows="3" placeholder="value|label&#10;draft|草稿">${escapeHtml(Array.isArray(field.options) ? field.options.map((option) => option.label ? `${option.value}|${option.label}` : option.value).join("\n") : "")}</textarea>
          </label>
        </div>
      </div>
    `)
    .join("");
}

function renderCardSections(sections) {
  if (!cardsManagementSections) return;
  const rows = Array.isArray(sections) ? sections : [];
  if (!rows.length) {
    renderCardRowEmpty(cardsManagementSections, "当前没有 sections，只有 pattern=section_list 时才需要。");
    return;
  }
  cardsManagementSections.innerHTML = rows
    .map((section, index) => `
      <div class="cards-management-row cards-management-draggable" tabindex="0" draggable="true" data-card-drag-type="section" data-card-drag-index="${index}" data-card-section-row="${index}">
        <div class="cards-management-row-head">
          <div class="cards-management-row-title-wrap">
            <span class="cards-management-drag-handle" title="拖拽排序">::</span>
            <div class="cards-management-row-title">Section ${index + 1}</div>
          </div>
          <div class="cards-management-inline-actions">
            <button type="button" class="cards-management-icon-btn" data-card-section-move="up:${index}" title="上移分组" aria-label="上移分组">${getCardsManagementIconSvg("up")}</button>
            <button type="button" class="cards-management-icon-btn" data-card-section-move="down:${index}" title="下移分组" aria-label="下移分组">${getCardsManagementIconSvg("down")}</button>
            <button type="button" class="cards-management-icon-btn" data-card-section-action-add="${index}" title="新增分组操作" aria-label="新增分组操作">${getCardsManagementIconSvg("add")}</button>
            <button type="button" class="cards-management-icon-btn danger" data-card-section-remove="${index}" title="删除分组" aria-label="删除分组">${getCardsManagementIconSvg("remove")}</button>
          </div>
        </div>
        <label class="workflow-definition-field" data-card-field-path="sections">
          <span>Body Template</span>
          <textarea data-card-section-field="${index}.body_template" rows="4">${escapeHtml(section.body_template || "")}</textarea>
        </label>
        <section class="workflow-definition-field workflow-definition-field-block">
          <div class="cards-management-section-head">
            <span>Section Actions</span>
          </div>
          <div class="cards-management-rows">
            ${
              Array.isArray(section.actions) && section.actions.length
                ? section.actions
                    .map((action, actionIndex) => `
                      <div class="cards-management-row cards-management-subrow cards-management-draggable" tabindex="0" draggable="true" data-card-drag-type="section-action" data-card-drag-index="${index}.${actionIndex}" data-card-section-action-row="${index}.${actionIndex}">
                        <div class="cards-management-row-head">
                          <div class="cards-management-row-title-wrap">
                            <span class="cards-management-drag-handle" title="拖拽排序">::</span>
                            <div class="cards-management-row-title">Action ${actionIndex + 1}</div>
                          </div>
                          <div class="cards-management-inline-actions">
                            <button type="button" class="cards-management-icon-btn" data-card-section-action-move="up:${index}.${actionIndex}" title="上移操作" aria-label="上移操作">${getCardsManagementIconSvg("up")}</button>
                            <button type="button" class="cards-management-icon-btn" data-card-section-action-move="down:${index}.${actionIndex}" title="下移操作" aria-label="下移操作">${getCardsManagementIconSvg("down")}</button>
                            <button type="button" class="cards-management-icon-btn danger" data-card-section-action-remove="${index}.${actionIndex}" title="删除操作" aria-label="删除操作">${getCardsManagementIconSvg("remove")}</button>
                          </div>
                        </div>
                        <div class="cards-management-row-grid">
                          <label class="workflow-definition-field">
                            <span>ID</span>
                            <input data-card-section-action-field="${index}.${actionIndex}.id" type="text" value="${escapeAttribute(action.id || "")}" />
                          </label>
                          <label class="workflow-definition-field">
                            <span>Label</span>
                            <input data-card-section-action-field="${index}.${actionIndex}.label" type="text" value="${escapeAttribute(action.label || "")}" />
                          </label>
                          <label class="workflow-definition-field">
                            <span>Type</span>
                            <select data-card-section-action-field="${index}.${actionIndex}.type">
                              <option value=""${!action.type ? " selected" : ""}>default</option>
                              <option value="primary"${action.type === "primary" ? " selected" : ""}>primary</option>
                              <option value="danger"${action.type === "danger" ? " selected" : ""}>danger</option>
                            </select>
                          </label>
                        </div>
                      </div>
                    `)
                    .join("")
                : '<div class="cards-management-row-empty">当前 section 没有 actions，可单独新增。</div>'
            }
          </div>
        </section>
      </div>
    `)
    .join("");
}

function renderCardsEditor(card) {
  const safe = normalizeCardConfig(card);
  if (cardsManagementPatternInput) cardsManagementPatternInput.value = safe.pattern || "info_actions";
  if (cardsManagementHeaderColorInput) cardsManagementHeaderColorInput.value = safe.header.color || "blue";
  if (cardsManagementHeaderTitleInput) cardsManagementHeaderTitleInput.value = safe.header.title_template || "";
  if (cardsManagementBodyTemplateInput) cardsManagementBodyTemplateInput.value = safe.body_template || "";
  if (cardsManagementFormNameInput) cardsManagementFormNameInput.value = safe.form?.name || "";
  if (cardsManagementFormSubmitIdInput) cardsManagementFormSubmitIdInput.value = safe.form?.submit_action?.id || "";
  if (cardsManagementFormSubmitLabelInput) cardsManagementFormSubmitLabelInput.value = safe.form?.submit_action?.label || "";
  if (cardsManagementFormSubmitTypeInput) cardsManagementFormSubmitTypeInput.value = safe.form?.submit_action?.type || "";
  if (cardsManagementForm) {
    cardsManagementForm.classList.toggle("hidden", !safe.form);
  }
  if (cardsManagementFormToggleBtn) {
    const enabled = Boolean(safe.form);
    cardsManagementFormToggleBtn.classList.toggle("active", enabled);
    cardsManagementFormToggleBtn.setAttribute("aria-pressed", enabled ? "true" : "false");
    cardsManagementFormToggleBtn.title = enabled ? "关闭表单" : "启用表单";
    cardsManagementFormToggleBtn.setAttribute("aria-label", enabled ? "关闭表单" : "启用表单");
  }
  if (cardsManagementFormFieldAddBtn) {
    cardsManagementFormFieldAddBtn.disabled = !safe.form;
  }
  renderCardActionRows(safe.actions);
  renderCardFormFields(safe.form?.fields || []);
  renderCardSections(safe.sections || []);
  updateCardsDetailEditState();
}

function setCardsManagementEditMode(isEditing) {
  cardsManagementEditMode = Boolean(isEditing);
  if (cardsManagementSaveBtn) {
    cardsManagementSaveBtn.textContent = cardsManagementEditMode ? "保存" : "编辑";
  }
  if (cardsManagementCancelBtn) {
    cardsManagementCancelBtn.classList.toggle("hidden", !cardsManagementEditMode);
  }
  updateCardsDetailEditState();
}

function updateCardsDetailEditState() {
  if (!cardsManagementDetail) return;
  cardsManagementDetail.classList.toggle("cards-management-readonly", !cardsManagementEditMode);
  cardsManagementDetail.classList.toggle("cards-management-editing", cardsManagementEditMode);
  const editorPanel = cardsManagementDetail.querySelector(".cards-management-editor-panel");
  if (!editorPanel) return;
  const editableControls = editorPanel.querySelectorAll(
    "input, textarea, select, button"
  );
  editableControls.forEach((control) => {
    if (control === cardsManagementSaveBtn || control === cardsManagementCancelBtn) return;
    control.disabled = !cardsManagementEditMode;
  });
}

function beginCardsEditing() {
  const current = getCurrentCardConfig();
  if (!currentCardSelection || !current) {
    alert("请先选择一个卡片");
    return;
  }
  cardsManagementEditSnapshot = {
    workflowType: currentCardSelection.workflowType,
    cardKey: currentCardSelection.cardKey,
    card: cloneJson(current),
  };
  setCardsManagementEditMode(true);
}

function cancelCardsEditing() {
  if (
    cardsManagementEditSnapshot &&
    cardsManagementEditSnapshot.workflowType &&
    cardsManagementEditSnapshot.cardKey
  ) {
    const { workflowType, cardKey, card } = cardsManagementEditSnapshot;
    if (!cardsRegistry[workflowType]) {
      cardsRegistry[workflowType] = {};
    }
    cardsRegistry[workflowType][cardKey] = cloneJson(card);
    workflowDefinitionCardsRegistry = cloneJson(cardsRegistry);
  }
  cardsManagementEditSnapshot = null;
  setCardsManagementEditMode(false);
  renderCardsDetailPane();
}

function getCardActionRowsFromEditor() {
  if (!cardsManagementActions) return [];
  return Array.from(cardsManagementActions.querySelectorAll("[data-card-action-row]")).map((row) => {
    const index = row.getAttribute("data-card-action-row");
    return {
      id: (row.querySelector(`[data-card-action-field="${index}.id"]`)?.value || "").trim(),
      label: (row.querySelector(`[data-card-action-field="${index}.label"]`)?.value || "").trim(),
      type: (row.querySelector(`[data-card-action-field="${index}.type"]`)?.value || "").trim() || undefined,
    };
  });
}

function getCardFormFieldsFromEditor(validationErrors) {
  if (!cardsManagementFormFields) return [];
  return Array.from(cardsManagementFormFields.querySelectorAll("[data-card-form-field-row]")).map((row) => {
    const index = row.getAttribute("data-card-form-field-row");
    const type = row.querySelector(`[data-card-form-field="${index}.type"]`)?.value || "text";
    const field = {
      name: (row.querySelector(`[data-card-form-field="${index}.name"]`)?.value || "").trim(),
      label: (row.querySelector(`[data-card-form-field="${index}.label"]`)?.value || "").trim() || undefined,
      type,
      placeholder: (row.querySelector(`[data-card-form-field="${index}.placeholder"]`)?.value || "").trim() || undefined,
      required: (row.querySelector(`[data-card-form-field="${index}.required"]`)?.value || "") === "true" || undefined,
      format: (row.querySelector(`[data-card-form-field="${index}.format"]`)?.value || "").trim() || undefined,
    };
    const min = (row.querySelector(`[data-card-form-field="${index}.min"]`)?.value || "").trim();
    const max = (row.querySelector(`[data-card-form-field="${index}.max"]`)?.value || "").trim();
    const minLength = (row.querySelector(`[data-card-form-field="${index}.min_length"]`)?.value || "").trim();
    const maxLength = (row.querySelector(`[data-card-form-field="${index}.max_length"]`)?.value || "").trim();
    if (min) field.min = Number(min);
    if (max) field.max = Number(max);
    if (minLength) field.min_length = Number(minLength);
    if (maxLength) field.max_length = Number(maxLength);
    const options = parseCardOptionsText(row.querySelector(`[data-card-form-field="${index}.options"]`)?.value || "");
    if (type === "enum") field.options = options;
    return field;
  });
}

function getCardSectionsFromEditor(validationErrors) {
  if (!cardsManagementSections) return [];
  return Array.from(cardsManagementSections.querySelectorAll("[data-card-section-row]")).map((row) => {
    const index = row.getAttribute("data-card-section-row");
    const bodyTemplate = row.querySelector(`[data-card-section-field="${index}.body_template"]`)?.value || "";
    const actions = Array.from(row.querySelectorAll(`[data-card-section-action-row^="${index}."]`)).map((actionRow) => {
      const actionKey = actionRow.getAttribute("data-card-section-action-row");
      return {
        id: (actionRow.querySelector(`[data-card-section-action-field="${actionKey}.id"]`)?.value || "").trim(),
        label: (actionRow.querySelector(`[data-card-section-action-field="${actionKey}.label"]`)?.value || "").trim(),
        type: (actionRow.querySelector(`[data-card-section-action-field="${actionKey}.type"]`)?.value || "").trim() || undefined,
      };
    });
    return {
      body_template: bodyTemplate,
      actions,
    };
  });
}

function validateCardDraft(cardState) {
  const errors = [];
  const workflowType = (cardState.workflowType || "").trim();
  const cardKey = (cardState.cardKey || "").trim();
  const card = cardState.card || createEmptyCardConfig();
  const pushError = (path, message) => {
    errors.push({ path, message });
  };

  if (!workflowType) {
    pushError("workflowType", "流程类型不能为空");
  }
  if (!cardKey) {
    pushError("cardKey", "卡片标识不能为空");
  }
  if (!card.pattern) {
    pushError("pattern", "展示模式不能为空");
  }
  if (!String(card.header?.title_template || "").trim()) {
    pushError("header.title_template", "标题模板不能为空");
  }

  const actionIds = new Set();
  (card.actions || []).forEach((action, index) => {
    const actionId = String(action.id || "").trim();
    if (!actionId) {
      pushError(`actions[${index}].id`, "操作 ID 不能为空");
      return;
    }
    if (actionIds.has(actionId)) {
      pushError(`actions[${index}].id`, `操作 ID「${actionId}」重复`);
    }
    actionIds.add(actionId);
  });

  if (card.form) {
    if (!String(card.form.name || "").trim()) {
      pushError("form.name", "表单名称不能为空");
    }
    if (!String(card.form.submit_action?.id || "").trim()) {
      pushError("form.submit_action.id", "提交动作 ID 不能为空");
    }
    const fieldNames = new Set();
    (card.form.fields || []).forEach((field, index) => {
      const fieldName = String(field.name || "").trim();
      if (!fieldName) {
        pushError(`form.fields[${index}].name`, "字段名称不能为空");
        return;
      }
      if (fieldNames.has(fieldName)) {
        pushError(`form.fields[${index}].name`, `字段名称「${fieldName}」重复`);
      }
      fieldNames.add(fieldName);
      if (field.type === "enum" && (!Array.isArray(field.options) || field.options.length === 0)) {
        pushError(`form.fields[${index}].options`, "枚举类型必须配置选项");
      }
    });
  }

  if ((card.pattern === "confirm_revise" || card.pattern === "form_submit") && !card.form) {
    pushError("form.name", `当前展示模式 ${card.pattern} 必须启用表单`);
  }
  if (card.pattern === "section_list" && (!Array.isArray(card.sections) || card.sections.length === 0)) {
    pushError("sections", "当前展示模式必须至少有一个分组");
  }

  return errors;
}

function createCardPreviewValue(actionId) {
  return { action: actionId || "preview_action" };
}

function moveArrayItem(list, fromIndex, toIndex) {
  if (!Array.isArray(list)) return list;
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= list.length ||
    toIndex >= list.length ||
    fromIndex === toIndex
  ) {
    return list;
  }
  const next = list.slice();
  const removed = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, removed[0]);
  return next;
}

function interpolateCardTemplate(template, sampleData) {
  return String(template || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, function (_, key) {
    return Object.prototype.hasOwnProperty.call(sampleData, key) ? sampleData[key] : `<${key}>`;
  });
}

function buildPreviewCardFromConfig(card, sampleData) {
  const safe = normalizeCardConfig(card);
  const templateData = sampleData && typeof sampleData.context === "object" && !Array.isArray(sampleData.context)
    ? { ...sampleData.context, ...sampleData }
    : sampleData;
  return {
    header: {
      title: interpolateCardTemplate(safe.header.title_template || "Card Preview", templateData),
      color: safe.header.color || "blue",
    },
    body: interpolateCardTemplate(safe.body_template || "", templateData),
    buttons: (safe.actions || []).map((action) => ({
      label: action.label || action.id || "Action",
      type: action.type || "default",
      value: createCardPreviewValue(action.id),
    })),
    sections: (safe.sections || []).map((section) => ({
      body: interpolateCardTemplate(section.body_template || "", templateData),
      buttons: (Array.isArray(section.actions) ? section.actions : []).map((action) => ({
        label: action.label || action.id || "Action",
        type: action.type || "default",
        value: createCardPreviewValue(action.id),
      })),
    })),
    form: safe.form
      ? {
          inputs: (safe.form.fields || []).map((field) => ({
            ...field,
            placeholder: field.placeholder || field.label || field.name,
          })),
          submitButton: {
            label: safe.form.submit_action?.label || safe.form.submit_action?.id || "Submit",
            type: safe.form.submit_action?.type || "default",
            value: createCardPreviewValue(safe.form.submit_action?.id),
          },
        }
      : null,
  };
}

function readCurrentCardEditorState() {
  const validationErrors = [];
  const workflowType = getCardEditorWorkflowTypeDraft();
  const cardKey = getCardEditorKeyDraft();
  const card = {
    pattern: cardsManagementPatternInput?.value || "info_actions",
    header: {
      title_template: cardsManagementHeaderTitleInput?.value || "",
      color: cardsManagementHeaderColorInput?.value || "blue",
    },
  };
  const bodyTemplate = cardsManagementBodyTemplateInput?.value || "";
  if (bodyTemplate.trim()) {
    card.body_template = bodyTemplate;
  }
  const actions = getCardActionRowsFromEditor();
  if (actions.length > 0) {
    card.actions = actions;
  }
  const hasForm = cardsManagementForm && !cardsManagementForm.classList.contains("hidden");
  if (hasForm) {
    card.form = {
      name: cardsManagementFormNameInput?.value || "",
      submit_action: {
        id: cardsManagementFormSubmitIdInput?.value || "",
        label: cardsManagementFormSubmitLabelInput?.value || "",
        type: cardsManagementFormSubmitTypeInput?.value || undefined,
      },
      fields: getCardFormFieldsFromEditor(validationErrors),
    };
  }
  const sections = getCardSectionsFromEditor(validationErrors);
  if (sections.length > 0) {
    card.sections = sections;
  }
  return {
    workflowType,
    cardKey,
    card,
    validationErrors,
  };
}

function syncCurrentCardDraftFromEditor() {
  if (!currentCardSelection) return null;
  const state = readCurrentCardEditorState();
  if (!cardsRegistry[currentCardSelection.workflowType]) {
    cardsRegistry[currentCardSelection.workflowType] = {};
  }
  cardsRegistry[currentCardSelection.workflowType][currentCardSelection.cardKey] = cloneJson(state.card);
  workflowDefinitionCardsRegistry = cloneJson(cardsRegistry);
  return state;
}

function renderCardsPreview(state) {
  if (!cardsManagementPreview) return;
  cardsManagementPreview.innerHTML = "";
  const previewDataState = getCardsPreviewData();
  const previewCard = buildPreviewCardFromConfig(state.card, previewDataState.data);
  cardsManagementPreview.appendChild(renderCardElement(previewCard, "__preview__"));
}

function collectCardReferencesFromStateTransitions(stateKey, state, cardRef, refs) {
  if (state?.card?.ref === cardRef) {
    refs.push({ stateKey, path: "card.ref", type: state.type || "unknown" });
  }
  if (state?.on_complete?.success?.card?.ref === cardRef) {
    refs.push({ stateKey, path: "on_complete.success.card.ref", type: state.type || "unknown" });
  }
  if (state?.on_complete?.failure?.card?.ref === cardRef) {
    refs.push({ stateKey, path: "on_complete.failure.card.ref", type: state.type || "unknown" });
  }
  if (state?.on_approve?.card?.ref === cardRef) {
    refs.push({ stateKey, path: "on_approve.card.ref", type: state.type || "unknown" });
  }
  if (state?.on_revise?.card?.ref === cardRef) {
    refs.push({ stateKey, path: "on_revise.card.ref", type: state.type || "unknown" });
  }
}

function getCardReferenceItems(workflowType, cardKey) {
  const refs = [];
  const details = Object.values(workflowDefinitionReferenceDetails || {});
  details.forEach((detail) => {
    const bundleKey = detail?.bundle?.key || "";
    if (bundleKey !== workflowType) return;
    [
      { source: "draft", definition: detail?.draft_definition || null },
      { source: "published", definition: detail?.published_definition || null },
    ].forEach((entry) => {
      if (!entry.definition) return;
      const states = entry.definition.states || {};
      Object.entries(states).forEach(([stateKey, state]) => {
        const before = refs.length;
        collectCardReferencesFromStateTransitions(stateKey, state, cardKey, refs);
        for (let i = before; i < refs.length; i++) {
          refs[i].source = entry.source;
          refs[i].version = entry.definition.version;
        }
      });
    });
  });
  const grouped = {};
  refs.forEach((ref) => {
    const key = `${ref.stateKey}__${ref.path}`;
    if (!grouped[key]) {
      grouped[key] = {
        stateKey: ref.stateKey,
        path: ref.path,
        type: ref.type,
        sources: [],
        versions: [],
      };
    }
    grouped[key].sources.push(ref.source);
    if (ref.version !== undefined && ref.version !== null) grouped[key].versions.push(ref.version);
  });
  return Object.values(grouped).map((item) => {
    const uniqueSources = Array.from(new Set(item.sources));
    const uniqueVersions = Array.from(new Set(item.versions)).sort((a, b) => b - a);
    let sourceLabel = uniqueSources[0] || "--";
    if (uniqueSources.includes("draft") && uniqueSources.includes("published")) {
      sourceLabel = "both";
    }
    return {
      stateKey: item.stateKey,
      path: item.path,
      type: item.type,
      source: sourceLabel,
      versions: uniqueVersions,
      draft_only: sourceLabel === "draft",
      published_only: sourceLabel === "published",
      both: sourceLabel === "both",
    };
  });
}

async function jumpToWorkflowDefinitionState(workflowKey, stateKey) {
  try {
    setPrimaryNav("workflow-definitions");
    if (!workflowKey) return;
    if (currentWorkflowDefinitionKey !== workflowKey) {
      await loadWorkflowDefinitionDetail(workflowKey);
    }
    updateWorkflowDefinitionSelectedState(stateKey);
    showToast(`已跳转到 ${workflowKey} / ${stateKey}`);
  } catch (err) {
    console.error("Failed to jump to workflow definition state:", err);
    alert(err instanceof Error ? err.message : "跳转到 workflow definition 失败");
  }
}

function renderCardsReferences(state) {
  if (!cardsManagementReferences) return;
  const refs = getCardReferenceItems(state.workflowType, state.cardKey);
  if (!refs.length) {
    cardsManagementReferences.innerHTML =
      '<div class="cards-management-reference-empty">当前没有 workflow state 引用这张 card。</div>';
    return;
  }
  cardsManagementReferences.innerHTML = refs
    .map((ref) => `
      <div class="cards-management-reference-item">
        <div class="cards-management-reference-title">${escapeHtml(ref.stateKey)}</div>
        <div class="cards-management-reference-meta">
          <span class="workflow-definition-pill cards-management-pill"><strong>source</strong>${escapeHtml(ref.source || "--")}${Array.isArray(ref.versions) && ref.versions.length ? ` v${escapeHtml(ref.versions.join("/"))}` : ""}</span>
          <span class="workflow-definition-pill cards-management-pill secondary"><strong>type</strong>${escapeHtml(ref.type || "--")}</span>
          <span class="workflow-definition-pill cards-management-pill secondary"><strong>path</strong>${escapeHtml(ref.path)}</span>
          <button type="button" class="cards-management-icon-btn" data-card-reference-jump="${escapeAttribute(state.workflowType)}:${escapeAttribute(ref.stateKey)}" title="跳转到状态" aria-label="跳转到状态">${getCardsManagementIconSvg("jump")}</button>
        </div>
      </div>
    `)
    .join("");
  Array.from(cardsManagementReferences.querySelectorAll("[data-card-reference-jump]")).forEach((button) => {
    button.addEventListener("click", async () => {
      const raw = button.getAttribute("data-card-reference-jump") || "";
      const parts = raw.split(":");
      await jumpToWorkflowDefinitionState(parts[0] || "", parts.slice(1).join(":") || "");
    });
  });
}

function renderCardsSummaryFromState(state) {
  if (cardsManagementTitle) {
    cardsManagementTitle.textContent = state.card.header?.title_template || state.cardKey || "Untitled Card";
  }
  if (cardsManagementSummary) {
    cardsManagementSummary.textContent = "";
  }
  if (cardsManagementMeta) {
    const meta = [
      `<span class="workflow-definition-pill workflow-definition-main-pill cards-management-pill"><strong>流程类型</strong>${escapeHtml(state.workflowType || "--")}</span>`,
      `<span class="workflow-definition-pill cards-management-pill secondary"><strong>卡片标识</strong>${escapeHtml(state.cardKey || "--")}</span>`,
      `<span class="workflow-definition-pill cards-management-pill secondary"><strong>展示模式</strong>${escapeHtml(state.card.pattern || "--")}</span>`,
      `<span class="workflow-definition-pill cards-management-pill secondary"><strong>操作数</strong>${escapeHtml(String((state.card.actions || []).length))}</span>`,
    ];
    cardsManagementMeta.innerHTML = meta.join("");
  }
}

function renderCardsDerivedPanels(state) {
  renderCardsSummaryFromState(state);
  renderCardsPreview(state);
  renderCardsReferences(state);
  renderCardsList();
}

function renderCardsDetailPane() {
  if (!cardsManagementEmpty || !cardsManagementDetail) return;
  const card = getCurrentCardConfig();
  if (!currentCardSelection || !card) {
    clearCardsFieldErrors();
    cardsManagementEditSnapshot = null;
    setCardsManagementEditMode(false);
    cardsManagementEmpty.classList.remove("hidden");
    cardsManagementDetail.classList.add("hidden");
    return;
  }
  cardsManagementEmpty.classList.add("hidden");
  cardsManagementDetail.classList.remove("hidden");
  clearCardsFieldErrors();
  if (cardsManagementWorkflowTypeInput) cardsManagementWorkflowTypeInput.value = currentCardSelection.workflowType || "";
  if (cardsManagementCardKeyInput) cardsManagementCardKeyInput.value = currentCardSelection.cardKey || "";
  if (cardsManagementPreviewData && !cardsManagementPreviewData.value.trim()) {
    syncCardsPreviewDataInputFromPreset();
  }
  renderCardsEditor(card);
  const state = readCurrentCardEditorState();
  renderCardsDerivedPanels(state);
  updateCardsDetailEditState();
}

function renderCardsList() {
  if (!cardsManagementList) return;
  cardsManagementList.innerHTML = "";
  const workflowTypes = getSortedCardWorkflowTypes();
  if (!workflowTypes.length) {
    cardsManagementExpandedGroups = {};
    cardsManagementGroupsInitialized = false;
    cardsManagementList.innerHTML = '<div class="workflow-definition-list-empty">还没有 cards，点击右上角 + 创建第一张 card。</div>';
    return;
  }

  const nextExpandedGroups = {};
  workflowTypes.forEach((workflowType) => {
    if (cardsManagementExpandedGroups[workflowType]) {
      nextExpandedGroups[workflowType] = true;
    }
  });
  cardsManagementExpandedGroups = nextExpandedGroups;

  if (!cardsManagementGroupsInitialized) {
    cardsManagementExpandedGroups = { [workflowTypes[0]]: true };
    cardsManagementGroupsInitialized = true;
  }

  workflowTypes.forEach((workflowType) => {
    const group = document.createElement("section");
    group.className = "cards-management-group";
    const cardKeys = Object.keys(cardsRegistry[workflowType] || {}).sort((a, b) => a.localeCompare(b));
    const isExpanded = Boolean(cardsManagementExpandedGroups[workflowType]);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = `cards-management-group-toggle${isExpanded ? " expanded" : ""}`;
    toggle.setAttribute("aria-expanded", isExpanded ? "true" : "false");
    toggle.innerHTML = `
      <span class="cards-management-group-title">${escapeHtml(workflowType)}</span>
      <span class="cards-management-group-chevron">${isExpanded ? "▾" : "▸"}</span>
    `;
    toggle.addEventListener("click", () => {
      cardsManagementExpandedGroups[workflowType] = !cardsManagementExpandedGroups[workflowType];
      renderCardsList();
    });
    group.appendChild(toggle);

    const items = document.createElement("div");
    items.className = `cards-management-group-items${isExpanded ? "" : " hidden"}`;
    cardKeys.forEach((cardKey) => {
      const card = normalizeCardConfig(cardsRegistry[workflowType][cardKey]);
      const item = document.createElement("button");
      item.type = "button";
      item.className = `workflow-definition-list-item cards-management-list-item${currentCardSelection && currentCardSelection.workflowType === workflowType && currentCardSelection.cardKey === cardKey ? " active" : ""}`;
      item.innerHTML = `
        <div class="workflow-definition-list-head">
          <div>
            <div class="workflow-definition-list-title">${escapeHtml(card.header.title_template || cardKey)}</div>
            <div class="workflow-definition-list-key">${escapeHtml(cardKey)}</div>
          </div>
        </div>
      `;
      item.addEventListener("click", () => {
        if (cardsManagementEditMode) {
          cancelCardsEditing();
        }
        currentCardSelection = { workflowType, cardKey };
        cardsManagementEditSnapshot = null;
        setCardsManagementEditMode(false);
        renderCardsList();
        renderCardsDetailPane();
      });
      item.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (cardsManagementEditMode) {
          cancelCardsEditing();
        }
        currentCardSelection = { workflowType, cardKey };
        cardsManagementEditSnapshot = null;
        setCardsManagementEditMode(false);
        renderCardsList();
        renderCardsDetailPane();
        showCardsListContextMenu(e, workflowType, cardKey);
      });
      items.appendChild(item);
    });
    group.appendChild(items);
    cardsManagementList.appendChild(group);
  });
}

async function loadCardsRegistry(options = {}) {
  const preserveSelection = options.preserveSelection !== false;
  if (cardsManagementRefreshBtn) {
    cardsManagementRefreshBtn.classList.add("spinning");
  }
  const reqSeq = ++cardsRequestSeq;
  try {
    const res = await apiFetch("/api/cards");
    const data = await res.json();
    if (reqSeq !== cardsRequestSeq) return;
    if (!res.ok) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    cardsRegistry = cloneJson(data.cards || {});
    workflowDefinitionCardsRegistry = cloneJson(cardsRegistry);
    cardsManagementEditSnapshot = null;
    setCardsManagementEditMode(false);
    if (
      !preserveSelection ||
      !currentCardSelection ||
      !cardsRegistry[currentCardSelection.workflowType] ||
      !cardsRegistry[currentCardSelection.workflowType][currentCardSelection.cardKey]
    ) {
      const firstWorkflowType = getSortedCardWorkflowTypes()[0] || "";
      const firstCardKey = firstWorkflowType ? Object.keys(cardsRegistry[firstWorkflowType] || {}).sort((a, b) => a.localeCompare(b))[0] || "" : "";
      currentCardSelection = firstWorkflowType && firstCardKey ? { workflowType: firstWorkflowType, cardKey: firstCardKey } : null;
    }
    if (Object.keys(workflowDefinitionReferenceDetails).length === 0) {
      await loadWorkflowDefinitionReferenceDetails();
    }
    renderCardsList();
    renderCardsDetailPane();
  } catch (err) {
    if (reqSeq !== cardsRequestSeq) return;
    console.error("Failed to load cards registry:", err);
    cardsRegistry = {};
    currentCardSelection = null;
    cardsManagementEditSnapshot = null;
    setCardsManagementEditMode(false);
    renderCardsList();
    renderCardsDetailPane();
    if (cardsManagementList) {
      cardsManagementList.innerHTML =
        `<div class="workflow-definition-list-empty">Cards 加载失败：${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
    }
  } finally {
    if (cardsManagementRefreshBtn) {
      cardsManagementRefreshBtn.classList.remove("spinning");
    }
  }
}

async function loadWorkflowDefinitionReferenceDetails() {
  try {
    const listRes = await apiFetch("/api/workflow-definitions");
    const listData = await listRes.json();
    if (!listRes.ok) {
      throw new Error(listData?.error || `HTTP ${listRes.status}`);
    }
    const bundles = Array.isArray(listData.definitions) ? listData.definitions : [];
    const detailEntries = await Promise.all(
      bundles.map(async (bundle) => {
        const res = await apiFetch(`/api/workflow-definitions/${encodeURIComponent(bundle.key)}`);
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data?.error || `HTTP ${res.status}`);
        }
        return [bundle.key, data];
      }),
    );
    workflowDefinitionReferenceDetails = Object.fromEntries(detailEntries);
  } catch (err) {
    console.error("Failed to load workflow definition references:", err);
    workflowDefinitionReferenceDetails = {};
  }
}

function buildCardsSavePayload() {
  const state = readCurrentCardEditorState();
  const nextRegistry = cloneJson(cardsRegistry || {});
  if (!currentCardSelection) {
    return { cards: nextRegistry, state };
  }
  if (nextRegistry[currentCardSelection.workflowType]) {
    delete nextRegistry[currentCardSelection.workflowType][currentCardSelection.cardKey];
    if (Object.keys(nextRegistry[currentCardSelection.workflowType]).length === 0) {
      delete nextRegistry[currentCardSelection.workflowType];
    }
  }
  if (!nextRegistry[state.workflowType]) {
    nextRegistry[state.workflowType] = {};
  }
  nextRegistry[state.workflowType][state.cardKey] = cloneJson(state.card);
  return { cards: nextRegistry, state };
}

async function saveCurrentCard() {
  try {
    const payload = buildCardsSavePayload();
    const previewDataState = getCardsPreviewData();
    const validationErrors = [...(payload.state.validationErrors || []), ...validateCardDraft(payload.state)];
    if (previewDataState.error) {
      validationErrors.push({ path: "previewData", message: `预览数据 JSON 无法解析：${previewDataState.error}` });
    }
    if (validationErrors.length > 0) {
      renderCardsFieldErrors(validationErrors);
      return;
    }
    clearCardsFieldErrors();
    const currentSelection = currentCardSelection;
    const routeWorkflowType = encodeURIComponent(currentSelection?.workflowType || payload.state.workflowType);
    const routeCardKey = encodeURIComponent(currentSelection?.cardKey || payload.state.cardKey);
    const res = await apiFetch(`/api/cards/${routeWorkflowType}/${routeCardKey}`, {
      method: "POST",
      body: JSON.stringify({
        workflow_type: payload.state.workflowType,
        card_key: payload.state.cardKey,
        card: payload.state.card,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    cardsRegistry = cloneJson(payload.cards);
    workflowDefinitionCardsRegistry = cloneJson(payload.cards);
    currentCardSelection = {
      workflowType: payload.state.workflowType,
      cardKey: payload.state.cardKey,
    };
    cardsManagementEditSnapshot = null;
    setCardsManagementEditMode(false);
    showToast(`已保存当前卡片：${payload.state.workflowType}/${payload.state.cardKey}`);
    await loadCardsRegistry({ preserveSelection: true });
  } catch (err) {
    console.error("Failed to save current card:", err);
    alert(err instanceof Error ? err.message : "保存当前卡片失败");
  }
}

async function createCardDraft() {
  const workflowType = ((await openTextPrompt("输入流程类型", currentCardSelection?.workflowType || "dev_test", {
    title: "新建卡片",
  })) || "").trim();
  if (!workflowType) return;
  const cardKey = ((await openTextPrompt("输入卡片标识", "", {
    title: "新建卡片",
  })) || "").trim();
  if (!cardKey) return;
  if (!cardsRegistry[workflowType]) {
    cardsRegistry[workflowType] = {};
  }
  if (cardsRegistry[workflowType][cardKey]) {
    alert(`卡片 "${workflowType}/${cardKey}" 已存在`);
    return;
  }
  cardsRegistry[workflowType][cardKey] = createEmptyCardConfig();
  currentCardSelection = { workflowType, cardKey };
  cardsManagementEditSnapshot = null;
  setCardsManagementEditMode(false);
  renderCardsList();
  renderCardsDetailPane();
  showToast(`已创建 ${workflowType}/${cardKey}`);
}

async function duplicateCurrentCardDraft() {
  const current = getCurrentCardConfig();
  if (!currentCardSelection || !current) {
    alert("请先选择一个卡片");
    return;
  }
  const workflowType = ((await openTextPrompt("复制到流程类型", currentCardSelection.workflowType, {
    title: "复制卡片",
  })) || "").trim();
  if (!workflowType) return;
  const cardKey = ((await openTextPrompt("复制后的卡片标识", `${currentCardSelection.cardKey}_copy`, {
    title: "复制卡片",
  })) || "").trim();
  if (!cardKey) return;
  if (!cardsRegistry[workflowType]) {
    cardsRegistry[workflowType] = {};
  }
  if (cardsRegistry[workflowType][cardKey]) {
    alert(`卡片 "${workflowType}/${cardKey}" 已存在`);
    return;
  }
  cardsRegistry[workflowType][cardKey] = cloneJson(current);
  currentCardSelection = { workflowType, cardKey };
  cardsManagementEditSnapshot = null;
  setCardsManagementEditMode(false);
  renderCardsList();
  renderCardsDetailPane();
  showToast(`已复制到 ${workflowType}/${cardKey}`);
}

function addCardActionRow() {
  const card = normalizeCardConfig(getCurrentCardConfig() || createEmptyCardConfig());
  card.actions.push({ id: "", label: "", type: "" });
  if (currentCardSelection) {
    cardsRegistry[currentCardSelection.workflowType][currentCardSelection.cardKey] = card;
  }
  renderCardsEditor(card);
  renderCardsDerivedPanels(readCurrentCardEditorState());
}

function toggleCardFormPanel() {
  const card = normalizeCardConfig(getCurrentCardConfig() || createEmptyCardConfig());
  if (card.form) {
    card.form = null;
  } else {
    card.form = {
      name: "",
      submit_action: { id: "", label: "", type: "" },
      fields: [],
    };
  }
  if (currentCardSelection) {
    cardsRegistry[currentCardSelection.workflowType][currentCardSelection.cardKey] = card;
  }
  renderCardsEditor(card);
  renderCardsDerivedPanels(readCurrentCardEditorState());
}

function addCardFormFieldRow() {
  const card = normalizeCardConfig(getCurrentCardConfig() || createEmptyCardConfig());
  if (!card.form) {
    card.form = {
      name: "",
      submit_action: { id: "", label: "", type: "" },
      fields: [],
    };
  }
  card.form.fields.push({ name: "", label: "", type: "text" });
  if (currentCardSelection) {
    cardsRegistry[currentCardSelection.workflowType][currentCardSelection.cardKey] = card;
  }
  renderCardsEditor(card);
  renderCardsDerivedPanels(readCurrentCardEditorState());
}

function addCardSectionRow() {
  const card = normalizeCardConfig(getCurrentCardConfig() || createEmptyCardConfig());
  card.sections.push({ body_template: "", actions: [] });
  if (currentCardSelection) {
    cardsRegistry[currentCardSelection.workflowType][currentCardSelection.cardKey] = card;
  }
  renderCardsEditor(card);
  renderCardsDerivedPanels(readCurrentCardEditorState());
}

function addCardSectionActionRow(sectionIndex) {
  const card = normalizeCardConfig(getCurrentCardConfig() || createEmptyCardConfig());
  if (!Array.isArray(card.sections)) {
    card.sections = [];
  }
  if (!card.sections[sectionIndex]) {
    card.sections[sectionIndex] = { body_template: "", actions: [] };
  }
  if (!Array.isArray(card.sections[sectionIndex].actions)) {
    card.sections[sectionIndex].actions = [];
  }
  card.sections[sectionIndex].actions.push({ id: "", label: "", type: "" });
  if (currentCardSelection) {
    cardsRegistry[currentCardSelection.workflowType][currentCardSelection.cardKey] = card;
  }
  renderCardsEditor(card);
  renderCardsDerivedPanels(readCurrentCardEditorState());
}

function moveCardSection(direction, sectionIndex) {
  const card = normalizeCardConfig(getCurrentCardConfig() || createEmptyCardConfig());
  const nextIndex = direction === "up" ? sectionIndex - 1 : sectionIndex + 1;
  card.sections = moveArrayItem(card.sections || [], sectionIndex, nextIndex);
  if (currentCardSelection) {
    cardsRegistry[currentCardSelection.workflowType][currentCardSelection.cardKey] = card;
  }
  renderCardsEditor(card);
  renderCardsDerivedPanels(readCurrentCardEditorState());
}

function moveCardSectionAction(direction, sectionIndex, actionIndex) {
  const card = normalizeCardConfig(getCurrentCardConfig() || createEmptyCardConfig());
  if (!card.sections[sectionIndex] || !Array.isArray(card.sections[sectionIndex].actions)) {
    return;
  }
  const nextIndex = direction === "up" ? actionIndex - 1 : actionIndex + 1;
  card.sections[sectionIndex].actions = moveArrayItem(
    card.sections[sectionIndex].actions,
    actionIndex,
    nextIndex,
  );
  if (currentCardSelection) {
    cardsRegistry[currentCardSelection.workflowType][currentCardSelection.cardKey] = card;
  }
  renderCardsEditor(card);
  renderCardsDerivedPanels(readCurrentCardEditorState());
}

function reorderCardSection(fromIndex, toIndex) {
  const card = normalizeCardConfig(getCurrentCardConfig() || createEmptyCardConfig());
  card.sections = moveArrayItem(card.sections || [], fromIndex, toIndex);
  if (currentCardSelection) {
    cardsRegistry[currentCardSelection.workflowType][currentCardSelection.cardKey] = card;
  }
  renderCardsEditor(card);
  renderCardsDerivedPanels(readCurrentCardEditorState());
}

function reorderCardSectionAction(sectionIndex, fromIndex, toIndex) {
  const card = normalizeCardConfig(getCurrentCardConfig() || createEmptyCardConfig());
  if (!card.sections[sectionIndex] || !Array.isArray(card.sections[sectionIndex].actions)) return;
  card.sections[sectionIndex].actions = moveArrayItem(card.sections[sectionIndex].actions, fromIndex, toIndex);
  if (currentCardSelection) {
    cardsRegistry[currentCardSelection.workflowType][currentCardSelection.cardKey] = card;
  }
  renderCardsEditor(card);
  renderCardsDerivedPanels(readCurrentCardEditorState());
}

function bindCardsDragEvents() {
  if (!cardsManagementSections) return;
  cardsManagementSections.addEventListener("dragstart", (event) => {
    if (!cardsManagementEditMode) return;
    const row = event.target.closest("[data-card-drag-type]");
    if (!row) return;
    cardsDragState = {
      type: row.getAttribute("data-card-drag-type") || "",
      index: row.getAttribute("data-card-drag-index") || "",
    };
    row.classList.add("dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", cardsDragState.index);
    }
  });
  cardsManagementSections.addEventListener("dragover", (event) => {
    if (!cardsManagementEditMode) return;
    const row = event.target.closest("[data-card-drag-type]");
    if (!row || !cardsDragState) return;
    const targetType = row.getAttribute("data-card-drag-type") || "";
    if (targetType !== cardsDragState.type) return;
    event.preventDefault();
    if (cardsDragState.type === "section-action") {
      const targetIndex = row.getAttribute("data-card-drag-index") || "";
      if (targetIndex.split(".")[0] !== cardsDragState.index.split(".")[0]) return;
    }
    row.classList.add("drag-over");
  });
  cardsManagementSections.addEventListener("dragleave", (event) => {
    if (!cardsManagementEditMode) return;
    const row = event.target.closest("[data-card-drag-type]");
    if (row) row.classList.remove("drag-over");
  });
  cardsManagementSections.addEventListener("drop", (event) => {
    if (!cardsManagementEditMode) return;
    const row = event.target.closest("[data-card-drag-type]");
    if (!row || !cardsDragState) return;
    row.classList.remove("drag-over");
    const targetType = row.getAttribute("data-card-drag-type") || "";
    const targetIndex = row.getAttribute("data-card-drag-index") || "";
    if (targetType !== cardsDragState.type) return;
    event.preventDefault();
    if (targetType === "section") {
      reorderCardSection(Number(cardsDragState.index), Number(targetIndex));
      return;
    }
    if (targetType === "section-action") {
      const [fromSection, fromAction] = cardsDragState.index.split(".").map(Number);
      const [toSection, toAction] = targetIndex.split(".").map(Number);
      if (fromSection !== toSection) return;
      reorderCardSectionAction(fromSection, fromAction, toAction);
    }
  });
  cardsManagementSections.addEventListener("dragend", () => {
    if (!cardsManagementEditMode) return;
    cardsDragState = null;
    Array.from(cardsManagementSections.querySelectorAll(".dragging, .drag-over")).forEach((el) => {
      el.classList.remove("dragging", "drag-over");
    });
  });
  cardsManagementSections.addEventListener("keydown", (event) => {
    if (!cardsManagementEditMode) return;
    const row = event.target.closest("[data-card-drag-type]");
    if (!row) return;
    const type = row.getAttribute("data-card-drag-type") || "";
    const index = row.getAttribute("data-card-drag-index") || "";
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const direction = event.key === "ArrowUp" ? "up" : "down";
    if (type === "section") {
      moveCardSection(direction, Number(index));
      showToast(`已通过键盘${direction === "up" ? "上移" : "下移"} section`);
      return;
    }
    if (type === "section-action") {
      const [sectionIndex, actionIndex] = index.split(".").map(Number);
      moveCardSectionAction(direction, sectionIndex, actionIndex);
      showToast(`已通过键盘${direction === "up" ? "上移" : "下移"} action`);
    }
  });
}

async function deleteCurrentCard() {
  if (!currentCardSelection) {
    alert("请先选择一个 card");
    return;
  }
  const { workflowType, cardKey } = currentCardSelection;
  if (!(await openConfirmDialog(`确认删除 ${workflowType}/${cardKey} 吗？`, { title: "删除卡片" }))) {
    return;
  }
  try {
    const nextRegistry = cloneJson(cardsRegistry || {});
    if (nextRegistry[workflowType]) {
      delete nextRegistry[workflowType][cardKey];
      if (Object.keys(nextRegistry[workflowType]).length === 0) {
        delete nextRegistry[workflowType];
      }
    }
    const res = await apiFetch("/api/cards", {
      method: "POST",
      body: JSON.stringify({ cards: nextRegistry }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    cardsRegistry = cloneJson(nextRegistry);
    workflowDefinitionCardsRegistry = cloneJson(nextRegistry);
    const firstWorkflowType = getSortedCardWorkflowTypes()[0] || "";
    const firstCardKey = firstWorkflowType
      ? Object.keys(cardsRegistry[firstWorkflowType] || {}).sort((a, b) => a.localeCompare(b))[0] || ""
      : "";
    currentCardSelection = firstWorkflowType && firstCardKey ? { workflowType: firstWorkflowType, cardKey: firstCardKey } : null;
    cardsManagementEditSnapshot = null;
    setCardsManagementEditMode(false);
    showToast(`已删除 ${workflowType}/${cardKey}`);
    renderCardsList();
    renderCardsDetailPane();
  } catch (err) {
    console.error("Failed to delete current card:", err);
    alert(err instanceof Error ? err.message : "删除当前卡片失败");
  }
}

function bindCardsRowEvents() {
  if (cardsManagementActions) {
    cardsManagementActions.addEventListener("click", (event) => {
      if (!cardsManagementEditMode) return;
      const removeBtn = event.target.closest("[data-card-action-remove]");
      if (!removeBtn) return;
      const index = Number(removeBtn.getAttribute("data-card-action-remove"));
      const card = normalizeCardConfig(getCurrentCardConfig() || createEmptyCardConfig());
      card.actions.splice(index, 1);
      if (currentCardSelection) {
        cardsRegistry[currentCardSelection.workflowType][currentCardSelection.cardKey] = card;
      }
      renderCardsEditor(card);
      renderCardsDerivedPanels(readCurrentCardEditorState());
    });
    cardsManagementActions.addEventListener("input", () => {
      if (!cardsManagementEditMode) return;
      clearCardsFieldErrors();
      const state = syncCurrentCardDraftFromEditor();
      if (state) renderCardsDerivedPanels(state);
    });
  }

  if (cardsManagementFormFields) {
    cardsManagementFormFields.addEventListener("click", (event) => {
      if (!cardsManagementEditMode) return;
      const removeBtn = event.target.closest("[data-card-form-field-remove]");
      if (!removeBtn) return;
      const index = Number(removeBtn.getAttribute("data-card-form-field-remove"));
      const card = normalizeCardConfig(getCurrentCardConfig() || createEmptyCardConfig());
      if (card.form) {
        card.form.fields.splice(index, 1);
      }
      if (currentCardSelection) {
        cardsRegistry[currentCardSelection.workflowType][currentCardSelection.cardKey] = card;
      }
      renderCardsEditor(card);
      renderCardsDerivedPanels(readCurrentCardEditorState());
    });
    cardsManagementFormFields.addEventListener("input", () => {
      if (!cardsManagementEditMode) return;
      clearCardsFieldErrors();
      const state = syncCurrentCardDraftFromEditor();
      if (state) renderCardsDerivedPanels(state);
    });
  }

  if (cardsManagementSections) {
    cardsManagementSections.addEventListener("click", (event) => {
      if (!cardsManagementEditMode) return;
      const moveBtn = event.target.closest("[data-card-section-move]");
      if (moveBtn) {
        const parts = (moveBtn.getAttribute("data-card-section-move") || "").split(":");
        moveCardSection(parts[0], Number(parts[1]));
        return;
      }
      const removeBtn = event.target.closest("[data-card-section-remove]");
      if (removeBtn) {
        const index = Number(removeBtn.getAttribute("data-card-section-remove"));
        const card = normalizeCardConfig(getCurrentCardConfig() || createEmptyCardConfig());
        card.sections.splice(index, 1);
        if (currentCardSelection) {
          cardsRegistry[currentCardSelection.workflowType][currentCardSelection.cardKey] = card;
        }
        renderCardsEditor(card);
        renderCardsDerivedPanels(readCurrentCardEditorState());
        return;
      }
      const addBtn = event.target.closest("[data-card-section-action-add]");
      if (addBtn) {
        const index = Number(addBtn.getAttribute("data-card-section-action-add"));
        addCardSectionActionRow(index);
        return;
      }
      const moveActionBtn = event.target.closest("[data-card-section-action-move]");
      if (moveActionBtn) {
        const parts = (moveActionBtn.getAttribute("data-card-section-action-move") || "").split(":");
        const actionPath = (parts[1] || "").split(".");
        moveCardSectionAction(parts[0], Number(actionPath[0]), Number(actionPath[1]));
        return;
      }
      const removeActionBtn = event.target.closest("[data-card-section-action-remove]");
      if (removeActionBtn) {
        const actionPath = (removeActionBtn.getAttribute("data-card-section-action-remove") || "").split(".");
        const sectionIndex = Number(actionPath[0]);
        const actionIndex = Number(actionPath[1]);
        const card = normalizeCardConfig(getCurrentCardConfig() || createEmptyCardConfig());
        if (card.sections[sectionIndex] && Array.isArray(card.sections[sectionIndex].actions)) {
          card.sections[sectionIndex].actions.splice(actionIndex, 1);
        }
        if (currentCardSelection) {
          cardsRegistry[currentCardSelection.workflowType][currentCardSelection.cardKey] = card;
        }
        renderCardsEditor(card);
        renderCardsDerivedPanels(readCurrentCardEditorState());
      }
    });
    cardsManagementSections.addEventListener("input", () => {
      if (!cardsManagementEditMode) return;
      clearCardsFieldErrors();
      const state = syncCurrentCardDraftFromEditor();
      if (state) renderCardsDerivedPanels(state);
    });
  }
}

function renderMessages() {
  clearSkeleton();
  if (messages.length === 0) {
    messagesEmpty.style.display = "flex";
    messagesEmpty.innerHTML = '<span>Select a group to initiate session</span>';
    const existing2 = messagesEl.querySelectorAll(".message");
    existing2.forEach((el) => el.remove());
    return;
  }
  messagesEmpty.style.display = "none";
  const existing = messagesEl.querySelectorAll(".message");
  existing.forEach((el) => el.remove());
  for (const msg of messages) {
    messagesEl.appendChild(createMessageEl(msg));
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Append a single message without full re-render
function appendSingleMessage(msg) {
  messagesEmpty.style.display = "none";
  clearSkeleton();
  // Avoid duplicate
  if (messagesEl.querySelector(`[data-msg-id="${CSS.escape(msg.id)}"]`)) return;
  const el = createMessageEl(msg);
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function trimLiveMessageBuffer() {
  if (messages.length <= LIVE_MESSAGE_BUFFER_LIMIT) return 0;

  const removedMessages = messages.slice(0, messages.length - LIVE_MESSAGE_BUFFER_LIMIT);
  const removedIds = new Set(removedMessages.map((msg) => msg.id));
  messages = messages.slice(-LIVE_MESSAGE_BUFFER_LIMIT);

  if (replyToMsg && removedIds.has(replyToMsg.id)) {
    clearReplyTo();
  }

  if (selectedMsgIds.size > 0) {
    removedIds.forEach((id) => selectedMsgIds.delete(id));
    updateSelectedBar();
  }

  return removedMessages.length;
}

function updateChatHeader() {
  if (!currentGroupJid) {
    chatGroupName.textContent = "Select a group";
    chatGroupFolder.textContent = "";
    return;
  }
  const group = groups.find((g) => g.jid === currentGroupJid);
  if (group) {
    chatGroupName.textContent = group.name;
    chatGroupFolder.textContent = group.isMain ? "(main)" : `@ ${group.folder}`;
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

function syncQuickChatTarget() {
  if (!quickChatTarget) return;
  const mainGroup = getMainGroup();
  if (!mainGroup) {
    quickChatTarget.textContent = "未找到主群，请先完成主群初始化。";
    return;
  }
  quickChatTarget.textContent = `发送到 ${mainGroup.name}${mainGroup.folder ? ` · @ ${mainGroup.folder}` : ""}`;
}

function isQuickChatOpen() {
  return !!quickChatOverlay && !quickChatOverlay.classList.contains("hidden");
}

function openQuickChat(options = {}) {
  if (!quickChatOverlay || !quickChatInput) return;
  syncQuickChatTarget();
  if (typeof options.prefill === "string") {
    quickChatDraft = options.prefill;
  }
  quickChatInput.value = quickChatDraft;
  quickChatOverlay.classList.remove("hidden");
  quickChatOverlay.setAttribute("aria-hidden", "false");
  document.body.classList.add("quick-chat-open");
  requestAnimationFrame(() => {
    quickChatInput.focus();
    quickChatInput.setSelectionRange(quickChatInput.value.length, quickChatInput.value.length);
  });
}

function closeQuickChat() {
  if (!quickChatOverlay || !quickChatInput) return;
  quickChatDraft = quickChatInput.value;
  if (isStandaloneQuickChat) {
    window.nanoclawApp?.hideWindow?.();
    return;
  }
  quickChatOverlay.classList.add("hidden");
  quickChatOverlay.setAttribute("aria-hidden", "true");
  document.body.classList.remove("quick-chat-open");
}

function toggleQuickChat() {
  if (isQuickChatOpen()) {
    closeQuickChat();
    return;
  }
  openQuickChat();
}

function initStandaloneQuickChatMode() {
  if (!isStandaloneQuickChat) return;
  document.body.classList.add("quick-chat-window", "quick-chat-open");
  if (mainScreen) mainScreen.classList.add("hidden");
  openQuickChat();
}

async function loadGroups() {
  try {
    const res = await apiFetch("/api/groups");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    groups = data.groups;
    renderGroups();
    syncQuickChatTarget();
    if (!groups.some((g) => g.jid === activeMemoryGroupJid)) {
      activeMemoryGroupJid = getDefaultMemoryGroupJid();
    }
    renderMemoryGroups();
    updateMemoryGroupHeader();
    renderMemoryList();
    if (activePrimaryNavKey === "memory-management") {
      loadMemories();
    }
  } catch (err) {
    console.error("Failed to load groups:", err);
  }
}

async function resetAllSessions() {
  if (!resetAllSessionsBtn) return;
  const confirmed = await openConfirmDialog(
    "这会让所有群组在下一次新建对话时切换到全新 session。当前正在运行的任务不会被打断。继续吗？",
    { title: "重置 Session" },
  );
  if (!confirmed) return;

  resetAllSessionsBtn.classList.add("busy");
  resetAllSessionsBtn.disabled = true;
  try {
    const res = await apiFetch("/api/sessions/reset", {
      method: "POST",
      body: JSON.stringify({ scope: "all" }),
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
    console.error("Failed to reset sessions:", err);
    showToast(`切换失败：${err instanceof Error ? err.message : "未知错误"}`);
  } finally {
    resetAllSessionsBtn.classList.remove("busy");
    resetAllSessionsBtn.disabled = false;
  }
}

async function loadSchedulers() {
  try {
    const res = await apiFetch("/api/tasks");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    schedulersList.innerHTML = "";

    if (data.tasks.length === 0) {
      schedulersList.innerHTML = `<div class="schedulers-empty">No scheduled tasks</div>`;
      return;
    }

    // Group by group_folder
    const byGroup = {};
    for (const task of data.tasks) {
      const g = task.group_folder || "Unknown";
      if (!byGroup[g]) byGroup[g] = [];
      byGroup[g].push(task);
    }

    for (const [group, tasks] of Object.entries(byGroup)) {
      const header = document.createElement("div");
      header.className = "scheduler-group-header";
      header.textContent = group;
      schedulersList.appendChild(header);

      for (const task of tasks) {
        const el = document.createElement("div");
        el.className = "scheduler-item";
        const status = task.status === "active" ? "active" : "paused";
        const statusIcon = task.status === "active" ? "\u25CF" : "\u25CB";
        const nextRun = task.next_run ? new Date(task.next_run).toLocaleString() : "—";
        const scheduleValue = task.schedule_type === 'once' && task.schedule_value
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
        const deleteBtn = el.querySelector(".scheduler-delete-btn");
        deleteBtn.addEventListener("click", () => deleteSchedulerTask(task.id, el));
        schedulersList.appendChild(el);
      }
    }
  } catch (err) {
    console.error("Failed to load schedulers:", err);
    schedulersList.innerHTML = `<div class="schedulers-empty">Failed to load schedulers</div>`;
  }
}

async function deleteSchedulerTask(taskId, el) {
  if (!(await openConfirmDialog("Delete this task?", { title: "Delete Task" }))) return;
  try {
    const res = await apiFetch(`/api/task?id=${encodeURIComponent(taskId)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    el.remove();
    // Show empty message if no tasks left
    if (schedulersList.querySelectorAll(".scheduler-item").length === 0) {
      schedulersList.innerHTML = `<div class="schedulers-empty">No scheduled tasks</div>`;
    }
  } catch (err) {
    console.error("Failed to delete scheduler:", err);
    alert("Failed to delete task");
  }
}

async function deleteAllSchedulers() {
  if (!(await openConfirmDialog("Delete all scheduled tasks?", { title: "Delete All Tasks" }))) return;
  try {
    const res = await apiFetch("/api/tasks", { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    schedulersList.innerHTML = `<div class="schedulers-empty">No scheduled tasks</div>`;
  } catch (err) {
    console.error("Failed to delete all schedulers:", err);
    alert("Failed to delete all tasks");
  }
}

function formatDuration(ms) {
  if (!ms && ms !== 0) return "—";
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
    const el = document.querySelector(`[data-agent-jid="${CSS.escape(agent.groupJid)}"] .agent-status-duration`);
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
  if (typeof event.payload_json === "object") return event.payload_json;
  try {
    return JSON.parse(event.payload_json);
  } catch {
    return null;
  }
}

function renderAgentTraceEvent(event) {
  const payload = parseAgentEventPayload(event) || {};
  const summary = escapeHtml(event.summary || event.event_name || "event");
  const kind = escapeHtml(event.event_type || "event");
  const highlightVariant =
    event.event_name === "file_edit_complete"
      ? "edit"
      : event.event_name === "file_write_complete"
        ? "write"
        : "";
  const isHighlightedFileChange = Boolean(highlightVariant);
  const highlightTitle =
    highlightVariant === "edit"
      ? "Edited File"
      : highlightVariant === "write"
        ? "Wrote File"
        : "";
  let details = "";
  const filePath = typeof payload.path === "string" ? payload.path : "";
  const normalizedFilePath = filePath
    .replace(/^\/workspace\/group\//, "")
    .replace(/^\/workspace\/project\//, "")
    .replace(/^\/workspace\//, "");
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
          ${hasDiffStats ? `<span class="agent-trace-diff-badge plus">+${escapeHtml(String(payload.additions || 0))}</span><span class="agent-trace-diff-badge minus">-${escapeHtml(String(payload.deletions || 0))}</span>` : ""}
        </div>
        ${collapsedDiffLines.map((line) => `<div class="agent-trace-diff-line ${line.startsWith("+") ? "add" : "del"}">${escapeHtml(line)}</div>`).join("")}
        ${hiddenDiffLines.length > 0 ? `
          <details class="agent-trace-disclosure">
            <summary>Show ${hiddenDiffLines.length} more diff lines</summary>
            <div class="agent-trace-disclosure-body">
              ${hiddenDiffLines.map((line) => `<div class="agent-trace-diff-line ${line.startsWith("+") ? "add" : "del"}">${escapeHtml(line)}</div>`).join("")}
            </div>
          </details>
        ` : ""}
      </div>
    `;
  }

  if (Array.isArray(payload.filenames) && payload.filenames.length > 0) {
    details += `
      <div class="agent-trace-files">
        ${payload.filenames.map((name) => `<span class="agent-trace-file">${escapeHtml(name)}</span>`).join("")}
      </div>
    `;
  }

  if (typeof payload.contentPreview === "string" && payload.contentPreview.trim()) {
    const previewText = String(payload.contentPreview);
    const collapsedPreview = previewText.length > 320 ? previewText.slice(0, 320) : previewText;
    const hiddenPreview = previewText.length > 320 ? previewText.slice(320) : "";
    details += `
      <div class="agent-trace-preview-wrap">
        ${normalizedFilePath ? `<div class="agent-trace-preview-header">${escapeHtml(normalizedFilePath)}</div>` : ""}
        <pre class="agent-trace-preview">${escapeHtml(collapsedPreview)}${hiddenPreview ? "..." : ""}</pre>
      </div>
      ${hiddenPreview ? `
        <details class="agent-trace-disclosure">
          <summary>Show more matches</summary>
          <div class="agent-trace-preview-wrap">
            ${normalizedFilePath ? `<div class="agent-trace-preview-header">${escapeHtml(normalizedFilePath)}</div>` : ""}
            <pre class="agent-trace-preview agent-trace-preview-expanded">${escapeHtml(previewText)}</pre>
          </div>
        </details>
      ` : ""}
    `;
  }

  if (hasDiffStats && collapsedDiffLines.length === 0) {
    details += `<div class="agent-trace-stats">+${escapeHtml(String(payload.additions || 0))} / -${escapeHtml(String(payload.deletions || 0))}</div>`;
  }

  return `
    <div class="agent-trace-event${isHighlightedFileChange ? ` agent-trace-event-highlight agent-trace-event-highlight-${highlightVariant}` : ""}">
      ${highlightTitle ? `<div class="agent-trace-highlight-title">${escapeHtml(highlightTitle)}</div>` : ""}
      <div class="agent-trace-event-head${isHighlightedFileChange ? " agent-trace-event-head-highlight" : ""}">
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
  agentStatusList.innerHTML = "";
  for (const agent of agents) {
    const now = Date.now();
    const elapsed = now - agent.startedAt;
    const statusDot = agent.isIdle ? "agent-status-dot idle" : "agent-status-dot active";
    const typeLabel = agent.isTask ? "task" : "chat";
    const isStopping = stoppingAgentIds.has(agent.groupJid);
    const trace = agentRunTraceByGroup[agent.groupJid] || null;
    const currentAction = trace?.currentAction || "";
    const currentStep = trace?.currentStepType || "";
    const recentEvents = Array.isArray(trace?.recentEvents) ? trace.recentEvents.slice(-3).reverse() : [];

    const el = document.createElement("div");
    el.className = `agent-status-item${isStopping ? " is-stopping" : ""}`;
    el.setAttribute("data-agent-jid", agent.groupJid);
    // Format last message time
    let lastTimeStr = "";
    if (agent.lastTime) {
      const t = new Date(isNaN(Number(agent.lastTime)) ? agent.lastTime : Number(agent.lastTime));
      if (!isNaN(t.getTime())) {
        lastTimeStr = t.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      }
    }

    el.innerHTML = `
      <div class="agent-status-name">
        <span class="${statusDot}"></span>
        ${escapeHtml(agent.groupName)}
      </div>
      <div class="agent-status-last-msg">
        <span class="agent-status-sender">${escapeHtml(agent.lastSender || "—")}</span>
        <span class="agent-status-time">${escapeHtml(lastTimeStr)}</span>
      </div>
      <div class="agent-status-content">${escapeHtml(agent.lastContent || "—")}</div>
      ${currentAction ? `<div class="agent-trace-current">${escapeHtml(currentAction)}</div>` : ""}
      ${currentStep ? `<div class="agent-trace-step">${escapeHtml(currentStep)}</div>` : ""}
      ${recentEvents.length > 0 ? `
        <div class="agent-trace-events">
          ${recentEvents.map((event) => renderAgentTraceEvent(event)).join("")}
        </div>
      ` : ""}
      <div class="agent-status-meta">
        <span class="agent-status-duration">${formatDuration(elapsed)}</span>
        <span class="agent-status-type">${typeLabel}</span>
        ${agent.activeWorkflowCount > 0 ? `<span class="agent-status-workflow-count">workflow ${escapeHtml(String(agent.activeWorkflowCount))}</span>` : ""}
        ${agent.pendingTaskCount > 0 ? `<span class="agent-status-pending">${agent.pendingTaskCount} pending</span>` : ""}
        ${agent.isTask && agent.runningTaskId ? `<span class="agent-status-task-id">${escapeHtml(agent.runningTaskId.slice(0, 8))}…</span>` : ""}
      </div>
      <div class="agent-status-actions">
        <button type="button" class="panel-action-btn stop icon-text-btn agent-stop-btn"${isStopping ? " disabled" : ""}>
          ${isStopping ? "Stopping..." : `${SVG.stop} Stop`}
        </button>
      </div>
    `;
    const stopBtn = el.querySelector(".agent-stop-btn");
    if (!isStopping) {
      stopBtn.addEventListener("click", () => stopAgent(agent.groupJid, stopBtn));
    }
    agentStatusList.appendChild(el);
  }
}

async function stopAgent(groupJid, btn) {
  const agent = agentStatusData.find((item) => item.groupJid === groupJid);
  const activeWorkflowCount = Number(agent?.activeWorkflowCount || 0);
  const confirmMessage =
    activeWorkflowCount > 0
      ? `确认停止这个 agent 吗？\n\n这会同时取消 ${activeWorkflowCount} 个关联 workflow。`
      : agent?.isTask
        ? "确认停止这个任务 agent 吗？\n\n对应任务会被标记为暂停。"
        : "确认停止这个 agent 吗？\n\n当前会话会被中止，排队中的消息和任务也会清空。";
  if (!(await openConfirmDialog(confirmMessage, { title: "停止 Agent" }))) return;
  stoppingAgentIds.add(groupJid);
  renderAgentStatus(agentStatusData);
  try {
    const res = await apiFetch("/api/agent-status/stop", {
      method: "POST",
      body: JSON.stringify({ groupJid }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    await loadAgentStatus();
    const toastMessage =
      data.cancelledWorkflowIds?.length > 0
        ? `已停止 agent，并取消 ${data.cancelledWorkflowIds.length} 个 workflow`
        : data.stoppedTaskId
          ? "已停止任务 agent，任务已暂停"
          : "已停止 agent";
    showToast(toastMessage);
  } catch (err) {
    console.error("Failed to stop agent:", err);
    stoppingAgentIds.delete(groupJid);
    renderAgentStatus(agentStatusData);
    alert("Failed to stop agent: " + err.message);
  }
}

async function loadAgentStatus() {
  try {
    const [statusRes, traceRes] = await Promise.all([
      apiFetch("/api/agent-status"),
      apiFetch("/api/agent-queries/active")
    ]);
    if (!statusRes.ok) throw new Error(`HTTP ${statusRes.status}`);
    if (!traceRes.ok) throw new Error(`HTTP ${traceRes.status}`);
    const data = await statusRes.json();
    const traceData = await traceRes.json();
    updateAgentRunTraces(traceData.queries || []);
    const activeIds = new Set((data.agents || []).map((agent) => agent.groupJid));
    stoppingAgentIds.forEach((groupJid) => {
      if (!activeIds.has(groupJid)) {
        stoppingAgentIds.delete(groupJid);
      }
    });
    renderAgentStatus(data.agents || []);
  } catch (err) {
    console.error("Failed to load agent status:", err);
    agentStatusList.innerHTML = `<div class="agent-status-empty">Failed to load</div>`;
  }
}

function formatRelativeTime(ts) {
  const ms = parseTimestamp(ts);
  if (!Number.isFinite(ms)) return "--";
  const delta = Date.now() - ms;
  const abs = Math.abs(delta);
  if (abs < 60 * 1000) return "刚刚";
  if (abs < 60 * 60 * 1000) return `${Math.round(abs / (60 * 1000))} 分钟前`;
  if (abs < 24 * 60 * 60 * 1000) return `${Math.round(abs / (60 * 60 * 1000))} 小时前`;
  return `${Math.round(abs / (24 * 60 * 60 * 1000))} 天前`;
}

function getGroupDisplayNameByJid(groupJid) {
  if (!groupJid) return "未关联群组";
  const group = groups.find((item) => item.jid === groupJid);
  return group?.name || groupJid;
}

function normalizeTraceRun(run, scope) {
  if (!run) return null;
  if (scope === "active") {
    return {
      id: run.queryId,
      scope,
      groupJid: run.groupJid || null,
      groupFolder: run.groupFolder || null,
      workflowId: run.workflowId || null,
      stageKey: run.stageKey || null,
      selectedModel: run.selectedModel || null,
      actualModel: run.actualModel || null,
      status: run.status || "running",
      currentAction: run.currentAction || null,
      currentStepType: run.currentStepType || null,
      currentStepName: run.currentStepName || null,
      promptSummary: run.promptSummary || null,
      startedAt: run.startedAt || null,
      lastEventAt: run.lastEventAt || null,
      endedAt: null,
      latencyMs: null,
    };
  }
  return {
    id: run.query_id || run.id,
    scope,
    groupJid: run.chat_jid || null,
    groupFolder: run.group_folder || null,
    workflowId: run.workflow_id || null,
    stageKey: run.stage_key || null,
    selectedModel: run.selected_model || null,
    actualModel: run.actual_model || null,
    status: run.status || "idle",
    currentAction: run.current_action || null,
    currentStepType: null,
    currentStepName: null,
    promptSummary: run.output_preview || null,
    startedAt: run.started_at || null,
    lastEventAt: run.last_event_at || null,
    endedAt: run.ended_at || null,
    latencyMs: run.latency_ms || null,
  };
}

function getTraceRunCollection(scope) {
  return scope === "history" ? traceMonitorHistoryRuns : traceMonitorActiveRuns;
}

function sortTraceRunsByLatest(runs) {
  return [...runs].sort((a, b) => {
    const aTs = parseTimestamp(a.lastEventAt || a.startedAt || a.endedAt) || 0;
    const bTs = parseTimestamp(b.lastEventAt || b.startedAt || b.endedAt) || 0;
    return bTs - aTs;
  });
}

async function loadTraceHistoryPage(options) {
  const reset = Boolean(options && options.reset);
  if (traceMonitorHistoryLoading) return;
  traceMonitorHistoryLoading = true;
  if (activePrimaryNavKey === "trace-monitor" && activeTraceMonitorScope === "history") {
    renderTraceMonitorList();
  }
  try {
    const offset = reset ? 0 : traceMonitorHistoryOffset;
    const res = await apiFetch(`/api/agent-queries?limit=${TRACE_HISTORY_PAGE_SIZE}&offset=${offset}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const activeRunIds = new Set(traceMonitorActiveRuns.map((run) => run.id));
    const nextRuns = (data.queries || [])
      .map((run) => normalizeTraceRun(run, "history"))
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
    if (activePrimaryNavKey === "trace-monitor" && activeTraceMonitorScope === "history") {
      renderTraceMonitorList();
    }
  } catch (err) {
    console.error("Failed to load more trace history:", err);
    showToast("加载更多活动历史失败");
  }
}

function getTraceRunListEmptyText(scope) {
  if (scope === "history" && traceMonitorHistoryJustCleared) {
    return "活动历史已清空";
  }
  return scope === "history" ? "暂无历史 Agent Trace" : "暂无活跃 Agent Trace";
}

function buildTraceRunSummary(run) {
  return run.currentAction || run.currentStepName || run.currentStepType || run.promptSummary || "等待更多执行数据...";
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
  const isHistoryScope = activeTraceMonitorScope === "history";
  const hasHistoryRuns = traceMonitorHistoryRuns.length > 0;
  traceMonitorClearHistoryBtn.style.display = isHistoryScope ? "" : "none";
  traceMonitorClearHistoryBtn.disabled =
    !isHistoryScope || !hasHistoryRuns || traceMonitorHistoryClearing;
  traceMonitorClearHistoryBtn.title = traceMonitorHistoryClearing
    ? "正在删除活动历史"
    : "一键删除所有活动历史";
}

function renderTraceMonitorList() {
  if (!traceMonitorList) return;
  syncTraceMonitorHeaderActions();
  const runs = getTraceRunCollection(activeTraceMonitorScope);
  if (!runs.length) {
    traceMonitorList.innerHTML = `<div class="trace-monitor-list-empty">${getTraceRunListEmptyText(activeTraceMonitorScope)}</div>`;
    return;
  }
  traceMonitorList.innerHTML = "";
  for (const run of runs) {
    const runId = String(run.id || "");
    const item = document.createElement("button");
    item.type = "button";
    item.className = `trace-monitor-list-item${runId === currentTraceRunId ? " active" : ""}`;
    const statusClass = String(run.status || "idle").toLowerCase();
    const primaryTime = run.startedAt ? formatDateTime(run.startedAt) : "--";
    const secondaryTime = run.lastEventAt ? formatRelativeTime(run.lastEventAt) : "--";
    item.innerHTML = `
      <div class="trace-monitor-list-head">
        <div class="trace-monitor-list-title">${escapeHtml(getGroupDisplayNameByJid(run.groupJid))}</div>
        <span class="trace-monitor-status ${escapeHtml(statusClass)}">${escapeHtml(run.status || "unknown")}</span>
      </div>
      <div class="trace-monitor-list-summary">${escapeHtml(buildTraceRunSummary(run))}</div>
      <div class="trace-monitor-list-meta">
        <span>${escapeHtml(runId.slice(0, 8))}...</span>
        <span>${escapeHtml(primaryTime)}</span>
        <span>${escapeHtml(secondaryTime)}</span>
      </div>
    `;
    item.addEventListener("click", () => {
      loadTraceRunDetail(runId, activeTraceMonitorScope);
    });
    traceMonitorList.appendChild(item);
  }
  if (activeTraceMonitorScope === "history") {
    const footer = document.createElement("div");
    footer.className = "trace-monitor-list-footer";
    if (traceMonitorHistoryLoading) {
      footer.innerHTML = renderTraceHistoryLoadingSkeleton();
    } else {
      const status = document.createElement("div");
      status.className = "trace-monitor-list-footer-status";
      status.textContent = traceMonitorHistoryHasMore
        ? "继续下滑加载更多"
        : traceMonitorHistoryRuns.length
          ? "已加载全部"
          : "暂无更多";
      footer.appendChild(status);
    }
    traceMonitorList.appendChild(footer);
  }
}

function renderTraceMonitorDetailEmpty() {
  currentTraceRunRecord = null;
  currentTraceRunSteps = [];
  currentTraceRunEvents = [];
  if (traceMonitorDetail) traceMonitorDetail.classList.add("hidden");
  if (traceMonitorDetailEmpty) traceMonitorDetailEmpty.classList.remove("hidden");
}

function renderTraceSummaryPills(run) {
  const pills = [];
  pills.push(`<span class="trace-monitor-pill"><strong>Status</strong>${escapeHtml(run.status || "--")}</span>`);
  if (run.started_at) {
    pills.push(`<span class="trace-monitor-pill"><strong>Started</strong>${escapeHtml(formatDateTime(run.started_at))}</span>`);
  }
  if (run.ended_at) {
    pills.push(`<span class="trace-monitor-pill"><strong>Ended</strong>${escapeHtml(formatDateTime(run.ended_at))}</span>`);
  }
  if (run.latency_ms || run.latency_ms === 0) {
    pills.push(`<span class="trace-monitor-pill"><strong>Duration</strong>${escapeHtml(formatDuration(run.latency_ms))}</span>`);
  }
  if (run.selected_model) {
    pills.push(`<span class="trace-monitor-pill"><strong>Selected</strong>${escapeHtml(run.selected_model)}</span>`);
  }
  if (run.actual_model) {
    pills.push(`<span class="trace-monitor-pill"><strong>Actual</strong>${escapeHtml(run.actual_model)}</span>`);
  }
  if (run.workflow_id) {
    pills.push(`<span class="trace-monitor-pill"><strong>Workflow</strong>${escapeHtml(run.workflow_id)}</span>`);
  }
  if (run.stage_key) {
    pills.push(`<span class="trace-monitor-pill"><strong>Stage</strong>${escapeHtml(run.stage_key)}</span>`);
  }
  if (run.group_folder) {
    pills.push(`<span class="trace-monitor-pill"><strong>Folder</strong>${escapeHtml(run.group_folder)}</span>`);
  }
  return pills.join("");
}

function renderTraceMetaPills(run) {
  const pills = [];
  pills.push(`<span class="trace-monitor-pill"><strong>Run</strong>${escapeHtml(run.query_id || run.id)}</span>`);
  pills.push(`<span class="trace-monitor-pill"><strong>Source</strong>${escapeHtml(run.source_type || "--")}</span>`);
  if (run.chat_jid) {
    pills.push(`<span class="trace-monitor-pill"><strong>Group</strong>${escapeHtml(getGroupDisplayNameByJid(run.chat_jid))}</span>`);
  }
  if (run.current_action) {
    pills.push(`<span class="trace-monitor-pill"><strong>Action</strong>${escapeHtml(run.current_action)}</span>`);
  }
  if (run.error_message) {
    pills.push(`<span class="trace-monitor-pill"><strong>Error</strong>${escapeHtml(run.error_message)}</span>`);
  }
  return pills.join("");
}

function stringifyTracePayload(payload) {
  if (!payload) return "";
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function classifyTraceTimelineItem(item) {
  const status = String(item?.status || "").toLowerCase();
  const stepType = String(item?.step_type || "").toLowerCase();
  const eventType = String(item?.event_type || "").toLowerCase();
  const eventName = String(item?.event_name || "").toLowerCase();
  const payload = "event_type" in item ? parseAgentEventPayload(item) || {} : parseAgentEventPayload({ payload_json: item.payload_json }) || {};
  const summaryText = String(item?.summary || "").toLowerCase();

  const isError =
    status === "error" ||
    status === "failed" ||
    stepType === "error" ||
    eventType === "error" ||
    eventName.includes("error") ||
    eventName.includes("failed") ||
    summaryText.includes("error") ||
    summaryText.includes("failed");
  if (isError) {
    return {
      key: "error",
      label: "错误事件",
      className: "error",
      payload,
    };
  }

  const isFileChange =
    eventName.startsWith("file_") ||
    Object.prototype.hasOwnProperty.call(payload, "patchPreview") ||
    Object.prototype.hasOwnProperty.call(payload, "contentPreview") ||
    Object.prototype.hasOwnProperty.call(payload, "additions") ||
    Object.prototype.hasOwnProperty.call(payload, "deletions") ||
    (typeof payload.path === "string" && payload.path.length > 0);
  if (isFileChange) {
    return {
      key: "file",
      label: "文件改动",
      className: "file",
      payload,
    };
  }

  const isToolCall =
    stepType === "tool" ||
    eventType === "tool" ||
    eventName.includes("tool") ||
    eventName.includes("search") ||
    eventName.includes("grep") ||
    eventName.includes("apply_patch") ||
    eventName.includes("write_file") ||
    eventName.includes("edit_file") ||
    eventName.includes("exec") ||
    eventName.includes("command");
  if (isToolCall) {
    return {
      key: "tool",
      label: "工具调用",
      className: "tool",
      payload,
    };
  }

  return {
    key: "general",
    label: "",
    className: "general",
    payload,
  };
}

function renderTraceHighlightSummary(items) {
  const counts = { file: 0, tool: 0, error: 0 };
  for (const item of items) {
    if (item.category && counts[item.category.key] !== undefined) {
      counts[item.category.key] += 1;
    }
  }
  return `
    <div class="trace-monitor-highlight-strip">
      <button type="button" class="trace-monitor-highlight-card file" data-trace-jump="file">
        <span class="trace-monitor-highlight-label">文件改动</span>
        <strong>${escapeHtml(String(counts.file))}</strong>
      </button>
      <button type="button" class="trace-monitor-highlight-card tool" data-trace-jump="tool">
        <span class="trace-monitor-highlight-label">工具调用</span>
        <strong>${escapeHtml(String(counts.tool))}</strong>
      </button>
      <button type="button" class="trace-monitor-highlight-card error" data-trace-jump="error">
        <span class="trace-monitor-highlight-label">错误事件</span>
        <strong>${escapeHtml(String(counts.error))}</strong>
      </button>
    </div>
  `;
}

function bindTraceHighlightCardJumps() {
  if (!traceMonitorTimeline) return;
  const cards = traceMonitorTimeline.querySelectorAll("[data-trace-jump]");
  cards.forEach((card) => {
    card.addEventListener("click", () => {
      const category = card.getAttribute("data-trace-jump");
      if (!category) return;
      const target = traceMonitorTimeline.querySelector(`.trace-monitor-timeline-item-${CSS.escape(category)}`);
      if (!target) return;
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
}

function renderTraceTimeline() {
  if (!traceMonitorTimeline || !currentTraceRunRecord) return;
  const timelineItems = [];
  for (const step of currentTraceRunSteps) {
    const category = classifyTraceTimelineItem(step);
    timelineItems.push({
      kind: "step",
      sortAt: parseTimestamp(step.started_at) || 0,
      category,
      html: renderTraceStepTimelineItem(step, category),
    });
  }
  for (const event of currentTraceRunEvents) {
    const category = classifyTraceTimelineItem(event);
    timelineItems.push({
      kind: "event",
      sortAt: parseTimestamp(event.created_at || event.started_at) || 0,
      category,
      html: renderTraceEventTimelineItem(event, category),
    });
  }
  timelineItems.sort((a, b) => a.sortAt - b.sortAt);
  if (!timelineItems.length) {
      traceMonitorTimeline.innerHTML = `<div class="trace-monitor-list-empty">当前 Trace 暂无可展示的时间线数据</div>`;
    return;
  }
  traceMonitorTimeline.innerHTML = renderTraceHighlightSummary(timelineItems) + timelineItems.map((item) => item.html).join("");
  bindTraceHighlightCardJumps();
}

function renderTraceStepTimelineItem(step, category) {
  const payload = category?.payload || parseAgentEventPayload({ payload_json: step.payload_json }) || null;
  const payloadBlock = payload ? `<pre class="trace-monitor-json">${escapeHtml(stringifyTracePayload(payload))}</pre>` : "";
  return `
    <div class="trace-monitor-timeline-item step trace-monitor-timeline-item-${escapeHtml(category.className)}">
      <span class="trace-monitor-timeline-dot"></span>
      <div class="trace-monitor-timeline-card">
        <div class="trace-monitor-timeline-head">
          <div class="trace-monitor-timeline-title">
            <span class="trace-monitor-timeline-kind">Step</span>
            <strong>${escapeHtml(step.step_name || step.step_type || "Step")}</strong>
            ${category.label ? `<span class="trace-monitor-category-badge ${escapeHtml(category.className)}">${escapeHtml(category.label)}</span>` : ""}
            <span class="trace-monitor-status ${escapeHtml(String(step.status || "idle").toLowerCase())}">${escapeHtml(step.status || "--")}</span>
          </div>
          <div class="trace-monitor-timeline-time">
            <div>${escapeHtml(formatDateTime(step.started_at))}</div>
            <div>${escapeHtml(step.latency_ms || step.latency_ms === 0 ? formatDuration(step.latency_ms) : "--")}</div>
          </div>
        </div>
        ${step.summary ? `<div class="trace-monitor-timeline-summary">${escapeHtml(step.summary)}</div>` : ""}
        ${payloadBlock}
      </div>
    </div>
  `;
}

function renderTraceEventTimelineItem(event, category) {
  const payload = category?.payload || parseAgentEventPayload(event) || null;
  const payloadBlock = payload ? `<pre class="trace-monitor-json">${escapeHtml(stringifyTracePayload(payload))}</pre>` : "";
  return `
    <div class="trace-monitor-timeline-item event trace-monitor-timeline-item-${escapeHtml(category.className)}">
      <span class="trace-monitor-timeline-dot"></span>
      <div class="trace-monitor-timeline-card">
        <div class="trace-monitor-timeline-head">
          <div class="trace-monitor-timeline-title">
            <span class="trace-monitor-timeline-kind">${escapeHtml(event.event_type || "event")}</span>
            <strong>${escapeHtml(event.summary || event.event_name || "Event")}</strong>
            ${category.label ? `<span class="trace-monitor-category-badge ${escapeHtml(category.className)}">${escapeHtml(category.label)}</span>` : ""}
            ${event.status ? `<span class="trace-monitor-status ${escapeHtml(String(event.status).toLowerCase())}">${escapeHtml(event.status)}</span>` : ""}
          </div>
          <div class="trace-monitor-timeline-time">
            <div>${escapeHtml(formatDateTime(event.created_at || event.started_at))}</div>
            <div>${escapeHtml(event.latency_ms || event.latency_ms === 0 ? formatDuration(event.latency_ms) : "--")}</div>
          </div>
        </div>
        ${renderAgentTraceEvent(event)}
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
  if (traceMonitorDetail) traceMonitorDetail.classList.remove("hidden");
  if (traceMonitorDetailEmpty) traceMonitorDetailEmpty.classList.add("hidden");
  if (traceMonitorTitle) {
    traceMonitorTitle.textContent = getGroupDisplayNameByJid(currentTraceRunRecord.chat_jid);
  }
  if (traceMonitorMeta) {
    traceMonitorMeta.innerHTML = renderTraceMetaPills(currentTraceRunRecord);
  }
  if (traceMonitorSummary) {
    traceMonitorSummary.innerHTML = renderTraceSummaryPills(currentTraceRunRecord);
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
  if (traceMonitorDetail) traceMonitorDetail.classList.remove("hidden");
  if (traceMonitorDetailEmpty) traceMonitorDetailEmpty.classList.add("hidden");
  try {
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
    currentTraceRunSteps = Array.isArray(stepsData.steps) ? stepsData.steps : [];
    currentTraceRunEvents = Array.isArray(eventsData.events) ? eventsData.events : [];
    renderTraceRunDetail();
  } catch (err) {
    console.error("Failed to load trace detail:", err);
    if (traceMonitorTimeline) {
      traceMonitorTimeline.innerHTML = `<div class="trace-monitor-list-empty">Trace 详情加载失败</div>`;
    }
  }
}

function ensureTraceSelectionVisible(scope) {
  const runs = getTraceRunCollection(scope);
  if (!runs.length) {
    currentTraceRunId = "";
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
  activeTraceMonitorScope = scope === "history" ? "history" : "active";
  traceMonitorScopeBtns.forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-trace-scope") === activeTraceMonitorScope);
  });
  const runs = getTraceRunCollection(activeTraceMonitorScope);
  const hasSelected = runs.some((run) => run.id === currentTraceRunId);
  if (!hasSelected) {
    currentTraceRunId = "";
    currentTraceRunRecord = null;
    currentTraceRunSteps = [];
    currentTraceRunEvents = [];
  }
  renderTraceMonitorList();
  syncTraceMonitorHeaderActions();
  ensureTraceSelectionVisible(activeTraceMonitorScope);
  if (activeTraceMonitorScope === "history" && traceMonitorHistoryRuns.length === 0 && !traceMonitorHistoryLoading) {
    loadTraceHistoryPage({ reset: true })
      .then(() => {
        renderTraceMonitorList();
        syncTraceMonitorHeaderActions();
        ensureTraceSelectionVisible("history");
      })
      .catch((err) => {
        console.error("Failed to load trace history:", err);
      });
  }
}

function scheduleTraceDetailReload() {
  if (activePrimaryNavKey !== "trace-monitor") return;
  if (activeTraceMonitorScope !== "active") return;
  if (!currentTraceRunId) return;
  const isActiveSelected = traceMonitorActiveRuns.some((run) => run.id === currentTraceRunId);
  if (!isActiveSelected) return;
  if (traceMonitorDetailReloadTimer) {
    clearTimeout(traceMonitorDetailReloadTimer);
  }
  traceMonitorDetailReloadTimer = setTimeout(() => {
    traceMonitorDetailReloadTimer = null;
    loadTraceRunDetail(currentTraceRunId, "active");
  }, 350);
}

async function loadTraceMonitorData(options) {
  const force = Boolean(options && options.force);
  try {
    const activeRes = await apiFetch("/api/agent-queries/active");
    if (!activeRes.ok) throw new Error(`HTTP ${activeRes.status}`);
    const activeData = await activeRes.json();
    traceMonitorActiveRuns = sortTraceRunsByLatest((activeData.queries || [])
      .map((run) => normalizeTraceRun(run, "active"))
      .filter(Boolean));
    if (force || traceMonitorHistoryRuns.length === 0) {
      await loadTraceHistoryPage({ reset: true });
    } else {
      traceMonitorHistoryRuns = traceMonitorHistoryRuns.filter(
        (run) => !traceMonitorActiveRuns.some((activeRun) => activeRun.id === run.id),
      );
    }
    renderTraceMonitorList();
    syncTraceMonitorHeaderActions();
    if (force || !currentTraceRunId) {
      ensureTraceSelectionVisible(activeTraceMonitorScope);
      return;
    }
    const runs = getTraceRunCollection(activeTraceMonitorScope);
    if (runs.some((run) => run.id === currentTraceRunId)) {
      loadTraceRunDetail(currentTraceRunId, activeTraceMonitorScope);
    } else {
      ensureTraceSelectionVisible(activeTraceMonitorScope);
    }
  } catch (err) {
    console.error("Failed to load trace monitor:", err);
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
    !(await openConfirmDialog("确认删除所有 Agent 活动历史吗？\n\n当前仍在运行的活跃 Trace 不会被删除。", {
      title: "删除活动历史",
    }))
  ) return;
  traceMonitorHistoryClearing = true;
  syncTraceMonitorHeaderActions();
  try {
    const res = await apiFetch("/api/agent-queries", { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    traceMonitorHistoryRuns = [];
    traceMonitorHistoryOffset = 0;
    traceMonitorHistoryHasMore = false;
    traceMonitorHistoryJustCleared = true;
    if (currentTraceRunScope === "history") {
      currentTraceRunId = "";
      currentTraceRunScope = "history";
      renderTraceMonitorDetailEmpty();
    }
    await loadTraceHistoryPage({ reset: true });
    renderTraceMonitorList();
    syncTraceMonitorHeaderActions();
    showToast(`已删除 ${Number(data.deleted || 0)} 条活动历史`);
  } catch (err) {
    console.error("Failed to clear trace history:", err);
    alert("删除活动历史失败");
  } finally {
    traceMonitorHistoryClearing = false;
    syncTraceMonitorHeaderActions();
  }
}
var TERMINAL_STATUSES = ["passed", "ops_failed", "cancelled"];

async function loadWorkbenchTasks(preferredTaskId, autoSelect = true, refreshDetail = true) {
  try {
    const res = await apiFetch("/api/workbench/tasks");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    workbenchTasks = Array.isArray(data.tasks) ? data.tasks : [];
    renderWorkbenchTaskList();

    const nextTaskId = preferredTaskId && workbenchTasks.some((task) => task.id === preferredTaskId)
      ? preferredTaskId
      : currentWorkbenchTaskId && workbenchTasks.some((task) => task.id === currentWorkbenchTaskId)
        ? currentWorkbenchTaskId
        : autoSelect && workbenchTasks[0]
          ? workbenchTasks[0].id
          : "";

    if (nextTaskId && refreshDetail) {
      loadWorkbenchTaskDetail(nextTaskId);
    } else if (!nextTaskId) {
      currentWorkbenchTaskId = "";
      currentWorkbenchDetail = null;
      workbenchTaskDetail.classList.add("hidden");
      workbenchDetailEmpty.classList.remove("hidden");
    }
  } catch (err) {
    console.error("Failed to load workbench tasks:", err);
    workbenchTaskList.innerHTML = `<div class="workbench-empty">任务加载失败</div>`;
  }
}

async function deleteAllWorkbenchTaskData() {
  if (
    !(await openConfirmDialog("确认删除所有任务相关数据？这会清空工作台中的任务、阶段、审批和产出记录。", {
      title: "删除任务数据",
    }))
  ) return;
  try {
    const res = await apiFetch("/api/workbench/tasks", { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    workbenchTasks = [];
    currentWorkbenchTaskId = "";
    currentWorkbenchDetail = null;
    renderWorkbenchTaskList();
    workbenchTaskDetail.classList.add("hidden");
    workbenchDetailEmpty.classList.remove("hidden");
  } catch (err) {
    console.error("Failed to delete all workbench task data:", err);
    alert("删除任务数据失败");
  }
}

async function deleteWorkbenchTask(task) {
  if (!task?.id) {
    alert("缺少任务 ID");
    return;
  }
  if (!(await openConfirmDialog(`确认删除任务「${task.title || task.id}」吗？`, {
    title: "删除任务",
  }))) {
    return;
  }
  try {
    const preferredTaskId = currentWorkbenchTaskId === task.id ? "" : currentWorkbenchTaskId;
    const res = await apiFetch(`/api/workbench/task?id=${encodeURIComponent(task.id)}`, {
      method: "DELETE",
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    showToast(`已删除任务：${task.title || task.id}`);
    await loadWorkbenchTasks(preferredTaskId, true, true);
  } catch (err) {
    console.error("Failed to delete workbench task:", err);
    alert(err instanceof Error ? err.message : "删除任务失败");
  }
}

function showWorkbenchTaskContextMenu(e, task) {
  closeKnowledgeImportMenu();
  document.querySelector(".context-menu")?.remove();

  const menu = document.createElement("div");
  menu.className = "context-menu";

  const items = [
    {
      label: "复制任务 ID",
      icon: "📋",
      action: async () => {
        await navigator.clipboard?.writeText(task.id || "");
        showToast(`已复制任务 ID：${task.id || "--"}`);
      },
    },
    {
      label: "删除该任务",
      icon: "🗑",
      action: async () => {
        await deleteWorkbenchTask(task);
      },
    },
  ];

  for (const item of items) {
    const el = document.createElement("div");
    el.className = "context-menu-item";
    el.innerHTML = `<span class="context-menu-icon">${item.icon}</span>${escapeHtml(item.label)}`;
    el.addEventListener("click", async () => {
      menu.remove();
      await item.action();
    });
    menu.appendChild(el);
  }

  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 8}px`;

  const closeHandler = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener("click", closeHandler);
    }
  };
  requestAnimationFrame(() => document.addEventListener("click", closeHandler));
}

function renderWorkbenchTaskList() {
  workbenchTasks = sortWorkbenchTaskItems(workbenchTasks);
  workbenchTaskList.innerHTML = "";
  if (workbenchTasks.length === 0) {
    workbenchTaskList.innerHTML = `<div class="workbench-empty">暂无任务，点击“新建任务”开始。</div>`;
    return;
  }

  for (const task of workbenchTasks) {
    const pendingCount = Number(task.pending_action_count || 0);
    const hasPending = pendingCount > 0 || Boolean(task.pending_approval);
    const updatedAt = task.updated_at || task.created_at || "";
    const el = document.createElement("div");
    el.className = `workbench-task-item${task.id === currentWorkbenchTaskId ? " active" : ""}${hasPending ? " has-pending" : ""}`;
    el.innerHTML = `
      <div class="workbench-task-card-glow" aria-hidden="true"></div>
      <div class="workbench-task-topline">
        <span class="workbench-task-type-chip">${escapeHtml(task.workflow_type || "workflow")}</span>
        <span class="workbench-task-time">${escapeHtml(updatedAt ? formatDateTime(updatedAt) : "--")}</span>
      </div>
      <div class="workbench-task-title-row">
        <div class="workbench-task-title">${escapeHtml(task.title)}</div>
        ${hasPending ? `<span class="workbench-task-pending-dot" title="有待处理项"></span>` : ""}
      </div>
      <div class="workbench-task-badges">
        <span class="workbench-badge"><strong>服务</strong>${escapeHtml(task.service)}</span>
        <span class="workbench-badge"><strong>流程状态</strong>${escapeHtml(getWorkbenchWorkflowStatusLabel(task))}</span>
        <span class="workbench-badge"><strong>任务态</strong>${escapeHtml(getWorkbenchTaskStateLabel(task.task_state))}</span>
        ${hasPending ? `<span class="workbench-badge workbench-badge-pending"><strong>待处理</strong>${pendingCount > 0 ? ` ${escapeHtml(String(pendingCount))}` : ""}</span>` : ""}
      </div>
      <div class="workbench-task-stage-strip">
        <span class="workbench-task-stage-label">当前阶段</span>
        <strong>${escapeHtml(getWorkbenchWorkflowStageLabel(task))}</strong>
      </div>
      <div class="workbench-task-snippet">
        ${(() => {
          const context = getWorkbenchTaskContext(task);
          const branch = typeof context.work_branch === "string" ? context.work_branch.trim() : "";
          return branch ? `分支：${escapeHtml(branch)}` : "尚未生成开发分支";
        })()}
      </div>
    `;
    el.addEventListener("click", () => loadWorkbenchTaskDetail(task.id));
    el.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      showWorkbenchTaskContextMenu(event, task);
    });
    workbenchTaskList.appendChild(el);
  }
}

function getWorkbenchTaskStateLabel(taskState) {
  switch (taskState) {
    case "success":
      return "成功";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    default:
      return "进行中";
  }
}

function getWorkbenchWorkflowStatusLabel(task) {
  if (!task) return "";
  return task.workflow_status_label || task.workflow_status || "";
}

function getWorkbenchWorkflowStageLabel(task) {
  if (!task) return "";
  return task.workflow_stage_label || task.workflow_stage || "";
}

function sortWorkbenchTaskItems(tasks) {
  if (!Array.isArray(tasks)) return [];
  return [...tasks].sort((a, b) => {
    const aTs = parseTimestamp(a?.updated_at || a?.created_at || "");
    const bTs = parseTimestamp(b?.updated_at || b?.created_at || "");
    const safeATs = Number.isFinite(aTs) ? aTs : 0;
    const safeBTs = Number.isFinite(bTs) ? bTs : 0;
    if (safeATs !== safeBTs) return safeBTs - safeATs;
    return String(b?.id || "").localeCompare(String(a?.id || ""));
  });
}

async function loadWorkbenchTaskDetail(taskId) {
  if (!taskId) return;
  if (workbenchDetailLoading) {
    workbenchQueuedDetailTaskId = taskId;
    return;
  }
  workbenchDetailLoading = true;
  try {
    const res = await apiFetch(`/api/workbench/task?id=${encodeURIComponent(taskId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const detail = await res.json();
    currentWorkbenchTaskId = detail.task && detail.task.id ? detail.task.id : taskId;
    renderWorkbenchTaskList();
    renderWorkbenchTaskDetail(detail);
  } catch (err) {
    console.error("Failed to load workbench task detail:", err);
    alert("任务详情加载失败");
  } finally {
    workbenchDetailLoading = false;
    const queuedTaskId = workbenchQueuedDetailTaskId;
    workbenchQueuedDetailTaskId = "";
    if (queuedTaskId) {
      loadWorkbenchTaskDetail(queuedTaskId);
    }
  }
}

function scheduleWorkbenchTaskDetailReload(taskId, delay = 250) {
  if (!taskId) return;
  if (workbenchDetailReloadTimer) clearTimeout(workbenchDetailReloadTimer);
  workbenchDetailReloadTimer = setTimeout(() => {
    workbenchDetailReloadTimer = null;
    loadWorkbenchTaskDetail(taskId);
  }, delay);
}

async function refreshWorkbenchView() {
  const activeTaskId = currentWorkbenchTaskId;
  await loadWorkbenchTasks(activeTaskId, true, false);
  if (activeTaskId && workbenchTasks.some((task) => task.id === activeTaskId)) {
    await loadWorkbenchTaskDetail(activeTaskId);
  }
}

function getWorkbenchPendingActionItems(detail) {
  if (!detail || !Array.isArray(detail.action_items)) return [];
  return detail.action_items.filter((item) => item && item.status === "pending");
}

function getWorkbenchPendingActionItemId(item) {
  if (!item) return "";
  if (typeof item.id === "string" && item.id) return item.id;
  return [
    item.item_type || "",
    item.source_type || "",
    item.source_ref_id || "",
    item.title || "",
    item.created_at || "",
  ].join(":");
}

function showWorkbenchPendingReminder(task, pendingItems) {
  if (!task || !Array.isArray(pendingItems) || pendingItems.length === 0) return;
  const firstItem = pendingItems[0];
  const itemCountLabel = pendingItems.length > 1 ? `等 ${pendingItems.length} 项待处理` : "有新的待处理项";
  const body = `${firstItem.title || getWorkbenchWorkflowStageLabel(task) || "当前任务"}，${itemCountLabel}`;
  showToast(`工作台提醒：${body}`, 3200);
}

function showWorkbenchPendingSystemNotification(task, pendingItems) {
  if (!task || !Array.isArray(pendingItems) || pendingItems.length === 0) return;
  const firstItem = pendingItems[0];
  const itemCountLabel = pendingItems.length > 1 ? `等 ${pendingItems.length} 项待处理` : "有新的待处理项";
  const body = `${firstItem.title || getWorkbenchWorkflowStageLabel(task) || "当前任务"}，${itemCountLabel}`;

  if (typeof window !== "undefined" && window.nanoclawApp?.notify) {
    window.nanoclawApp.notify(`工作台：${task.title || "任务"}`, body, { taskId: task.id });
    return;
  }

  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") {
    ensureBrowserNotificationPermission();
    return;
  }

  const notification = new Notification(`工作台：${task.title || "任务"}`, {
    body,
    tag: `nanoclaw-workbench-${task.id}`,
  });
  notification.onclick = () => {
    window.focus();
    setPrimaryNav("workbench");
    loadWorkbenchTaskDetail(task.id).catch((err) => {
      console.error("Failed to open workbench task from browser notification click:", err);
    });
  };
}

function maybeNotifyWorkbenchPending(detail, previousDetail) {
  const taskId = detail && detail.task && detail.task.id;
  if (!taskId) return;

  const pendingItems = getWorkbenchPendingActionItems(detail);
  const pendingIds = pendingItems
    .map((item) => getWorkbenchPendingActionItemId(item))
    .filter(Boolean);

  if (pendingIds.length === 0) {
    delete workbenchPendingReminderIdsByTask[taskId];
    return;
  }

  const previousTaskId = previousDetail && previousDetail.task && previousDetail.task.id;
  if (previousTaskId !== taskId) {
    workbenchPendingReminderIdsByTask[taskId] = pendingIds;
    return;
  }

  const previousPendingIds = new Set(
    getWorkbenchPendingActionItems(previousDetail)
      .map((item) => getWorkbenchPendingActionItemId(item))
      .filter(Boolean)
  );
  const remindedIds = new Set(workbenchPendingReminderIdsByTask[taskId] || []);
  const newPendingItems = pendingItems.filter((item) => {
    const itemId = getWorkbenchPendingActionItemId(item);
    return itemId && !previousPendingIds.has(itemId) && !remindedIds.has(itemId);
  });

  workbenchPendingReminderIdsByTask[taskId] = pendingIds;
  const shouldShowToast =
    newPendingItems.length > 0 &&
    isAppForeground() &&
    activePrimaryNavKey === "workbench" &&
    currentWorkbenchTaskId === taskId;
  if (shouldShowToast) {
    showWorkbenchPendingReminder(detail.task, newPendingItems);
  }
}

function maybeNotifyWorkbenchPendingFromRealtimeEvent(event) {
  if (!event || event.type !== "action_item_updated") return;
  const payload = event.payload || {};
  const taskId = event.taskId || "";
  const itemId = typeof payload.id === "string" ? payload.id : "";
  if (!taskId || !itemId) return;

  const existingIds = new Set(workbenchPendingReminderIdsByTask[taskId] || []);
  const nextStatus = typeof payload.status === "string" ? payload.status : "";
  if (nextStatus === "pending") {
    const isNewPending = !existingIds.has(itemId);
    existingIds.add(itemId);
    workbenchPendingReminderIdsByTask[taskId] = Array.from(existingIds);
    if (!isNewPending || isAppForeground()) return;

    const existingTask = workbenchTasks.find((item) => item.id === taskId);
    const task = existingTask || {
      id: taskId,
      title: typeof payload.taskTitle === "string" ? payload.taskTitle : "任务",
      workflow_stage_label:
        typeof payload.workflowStageLabel === "string"
          ? payload.workflowStageLabel
          : "",
    };
    showWorkbenchPendingSystemNotification(task, [{
      id: itemId,
      title: typeof payload.title === "string" ? payload.title : "",
    }]);
    return;
  }

  if (["resolved", "confirmed", "skipped", "cancelled", "expired"].includes(nextStatus)) {
    existingIds.delete(itemId);
    if (existingIds.size > 0) {
      workbenchPendingReminderIdsByTask[taskId] = Array.from(existingIds);
    } else {
      delete workbenchPendingReminderIdsByTask[taskId];
    }
  }
}

function syncWorkbenchTaskPendingState(taskId, actionItems) {
  if (!taskId) return;
  const taskIdx = workbenchTasks.findIndex((item) => item.id === taskId);
  if (taskIdx < 0) return;
  const pendingActionCount = Array.isArray(actionItems)
    ? actionItems.filter((item) => item && item.status === "pending").length
    : 0;
  workbenchTasks[taskIdx] = {
    ...workbenchTasks[taskIdx],
    pending_approval: pendingActionCount > 0,
    pending_action_count: pendingActionCount,
  };
  renderWorkbenchTaskList();
}

function getWorkbenchTaskContext(task) {
  const context = task && typeof task.context === "object" && !Array.isArray(task.context)
    ? task.context
    : {};
  return context || {};
}

function mergeWorkbenchTaskContext(existingTask, nextContext) {
  const existingContext = getWorkbenchTaskContext(existingTask);
  if (!nextContext || typeof nextContext !== "object" || Array.isArray(nextContext)) {
    return { ...existingContext };
  }
  return { ...existingContext, ...nextContext };
}

function renderWorkbenchContextBadges(task) {
  const context = getWorkbenchTaskContext(task);
  return WORKBENCH_CONTEXT_BADGES
    .map(({ key, label }) => {
      const value = typeof context[key] === "string" ? context[key].trim() : "";
      return value ? `<span class="workbench-badge">${label}：${escapeHtml(value)}</span>` : "";
    })
    .join("");
}

function renderWorkbenchTaskDetail(detail) {
  const task = detail.task;
  if (!task) return;
  const previousDetail = currentWorkbenchDetail;
  if (!previousDetail || previousDetail.task?.id !== task.id) {
    expandedWorkbenchTimelineIds.clear();
  }
  currentWorkbenchDetail = detail;

  workbenchDetailEmpty.classList.add("hidden");
  workbenchTaskDetail.classList.remove("hidden");
  workbenchTaskTitle.textContent = task.title;
  workbenchTaskMeta.innerHTML = `
    <span class="workbench-badge">${escapeHtml(task.service)}</span>
    <span class="workbench-badge">${escapeHtml(task.workflow_type)}</span>
    ${renderWorkbenchContextBadges(task)}
    ${task.round > 0 ? `<span class="workbench-badge">Round ${escapeHtml(String(task.round))}</span>` : ""}
    <span class="workbench-badge"><strong>流程状态</strong>${escapeHtml(getWorkbenchWorkflowStatusLabel(task))}</span>
    <span class="workbench-badge"><strong>任务态</strong>${escapeHtml(getWorkbenchTaskStateLabel(task.task_state))}</span>
  `;

  renderWorkbenchActions(task);
  renderWorkbenchSubtasks(detail.subtasks || []);
  renderWorkbenchActionItems(detail.action_items || [], task);
  renderWorkbenchArtifacts(detail.artifacts || []);
  renderWorkbenchRequirementOrigin(task, detail.assets || []);
  renderWorkbenchAssets(detail.assets || []);
  renderWorkbenchComments(detail.comments || []);
  renderWorkbenchTimeline(detail.timeline || []);
  maybeNotifyWorkbenchPending(detail, previousDetail);
  syncWorkbenchTaskPendingState(task.id, detail.action_items || []);
}

function getWorkbenchBadgeIcon(kind) {
  switch (kind) {
    case "status-current":
      return '<svg viewBox="0 0 24 24"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>';
    case "status-completed":
      return '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>';
    case "status-failed":
      return '<svg viewBox="0 0 24 24"><path d="M7 7l10 10"/><path d="M17 7L7 17"/></svg>';
    case "status-cancelled":
      return '<svg viewBox="0 0 24 24"><path d="M8 8h8v8H8z"/></svg>';
    case "status-pending":
      return '<svg viewBox="0 0 24 24"><path d="M12 8v4"/><path d="M12 16h.01"/></svg>';
    case "approval":
      return '<svg viewBox="0 0 24 24"><path d="M12 3l7 4v5c0 5-3.5 7.5-7 9-3.5-1.5-7-4-7-9V7z"/></svg>';
    case "input":
      return '<svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M4 12h10"/><path d="M4 17h7"/></svg>';
    case "question":
      return '<svg viewBox="0 0 24 24"><path d="M9.5 9a2.5 2.5 0 1 1 4.3 1.7c-.8.8-1.8 1.4-1.8 2.8"/><path d="M12 17h.01"/></svg>';
    case "message":
      return '<svg viewBox="0 0 24 24"><path d="M4 6h16v10H7l-3 3z"/></svg>';
    case "ready":
      return '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>';
    case "missing":
      return '<svg viewBox="0 0 24 24"><path d="M12 8v5"/><path d="M12 16h.01"/></svg>';
    case "time":
      return '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>';
    case "artifact":
      return '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
    case "asset":
      return '<svg viewBox="0 0 24 24"><path d="M4 19h16"/><path d="M7 16l4-5 3 3 3-4 3 6"/></svg>';
    case "timeline-manual":
      return '<svg viewBox="0 0 24 24"><path d="M12 5v14"/><path d="M5 12h14"/></svg>';
    case "timeline-approval":
      return '<svg viewBox="0 0 24 24"><path d="M12 3l7 4v5c0 5-3.5 7.5-7 9-3.5-1.5-7-4-7-9V7z"/></svg>';
    case "timeline-flow":
      return '<svg viewBox="0 0 24 24"><path d="M5 7h6"/><path d="M13 7h6"/><path d="M11 7l2 5-2 5"/></svg>';
    case "timeline-execution":
      return '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .33 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.33 1.7 1.7 0 0 0-1.03 1.55V22a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.57 1.7 1.7 0 0 0-1.87.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .33-1.87 1.7 1.7 0 0 0-1.55-1.03H2a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.57-1.11 1.7 1.7 0 0 0-.33-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.33H8.1a1.7 1.7 0 0 0 1.03-1.55V2a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.11 1.57 1.7 1.7 0 0 0 1.87-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.33 1.87v.08a1.7 1.7 0 0 0 1.55 1.03H22a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.57 1.11z"/></svg>';
    default:
      return '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/></svg>';
  }
}

function renderWorkbenchBadge(label, kind = "default") {
  return `<span class="workbench-badge workbench-badge-${escapeAttribute(kind)}"><span class="workbench-badge-icon" aria-hidden="true">${getWorkbenchBadgeIcon(kind)}</span><span>${escapeHtml(label)}</span></span>`;
}

function renderWorkbenchRequirementOrigin(task, assets) {
  if (!workbenchRequirementOrigin) return;
  const context = getWorkbenchTaskContext(task);
  const requirementDescription = typeof context.requirement_description === "string"
    ? context.requirement_description.trim()
    : "";
  const requirementFiles = Array.isArray(context.requirement_files)
    ? context.requirement_files.filter((item) => typeof item === "string" && item.trim())
    : [];
  const requirementFileAssets = (Array.isArray(assets) ? assets : []).filter((item) => item.asset_type === "requirement_file");

  if (!requirementDescription && requirementFiles.length === 0 && requirementFileAssets.length === 0) {
    workbenchRequirementOrigin.innerHTML = `<div class="workbench-empty">暂无原始需求信息</div>`;
    return;
  }

  const fileMap = new Map();
  requirementFiles.forEach((item) => fileMap.set(item, { path: item, title: item }));
  requirementFileAssets.forEach((item) => {
    const key = item.path || item.url || item.title;
    if (!key) return;
    fileMap.set(key, item);
  });

  const fileItems = Array.from(fileMap.values());
  workbenchRequirementOrigin.innerHTML = `
    <div class="workbench-origin-item">
      <div class="workbench-origin-header">
        <strong>需求描述</strong>
      </div>
      <div class="workbench-origin-body">${requirementDescription ? escapeHtml(requirementDescription).replace(/\n/g, "<br>") : "未填写"}</div>
    </div>
    <div class="workbench-origin-item">
      <div class="workbench-origin-header">
        <strong>需求附件</strong>
      </div>
      <div class="workbench-origin-body">
        ${fileItems.length > 0
          ? fileItems.map((item) => {
              const href = item.path ? `file://${item.path}` : item.url;
              const label = item.title || item.path || item.url || "附件";
              const meta = item.path || item.url || "";
              return `
                <div class="workbench-origin-asset">
                  ${href
                    ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`
                    : `<span>${escapeHtml(label)}</span>`}
                  ${meta ? `<div class="workbench-origin-meta">${escapeHtml(meta)}</div>` : ""}
                </div>
              `;
            }).join("")
          : "无"}
      </div>
    </div>
  `;
}

function renderWorkbenchActions(task) {
  workbenchTaskActions.innerHTML = "";
  const buttons = [];
  if (task.workflow_status === "paused") {
    buttons.push({ title: "恢复任务", action: "resume", icon: SVG.play });
  } else if (!TERMINAL_STATUSES.includes(task.workflow_status)) {
    buttons.push({ title: "暂停任务", action: "pause", icon: SVG.pause });
  }
  if (!TERMINAL_STATUSES.includes(task.workflow_status)) {
    buttons.push({ title: "取消任务", action: "cancel", icon: SVG.trash, danger: true });
  }

  buttons.forEach((item) => {
    const btn = document.createElement("button");
    btn.className = `icon-btn workbench-task-action-btn${item.danger ? " danger" : ""}`;
    btn.type = "button";
    btn.title = item.title;
    btn.setAttribute("aria-label", item.title);
    btn.setAttribute("data-tooltip", item.title);
    btn.innerHTML = item.icon;
    btn.addEventListener("click", () => triggerWorkbenchAction(task.id, item.action));
    workbenchTaskActions.appendChild(btn);
  });
}

function renderWorkbenchSubtasks(subtasks) {
  workbenchSubtasks.innerHTML = "";
  if (subtasks.length === 0) {
    workbenchSubtasks.innerHTML = `<div class="workbench-empty">暂无阶段数据</div>`;
    return;
  }
  function getDisplaySubtasks(items) {
    const currentItems = items.filter((item) => item.status === "current");
    if (currentItems.length <= 1) {
      return items;
    }

    const taskCurrentStage = currentWorkbenchDetail && currentWorkbenchDetail.task
      ? currentWorkbenchDetail.task.workflow_stage
      : "";
    const preferredCurrent = currentItems.find((item) => item.stage_key === taskCurrentStage)
      || currentItems[currentItems.length - 1];

    return items.map((item) => {
      if (item.status !== "current" || item.id === preferredCurrent.id) {
        return item;
      }
      return {
        ...item,
        status: "completed",
      };
    });
  }
  function isAwaitingStage(item) {
    return item.stage_type === "confirmation"
      || (typeof item.stage_key === "string" && item.stage_key.startsWith("awaiting_"));
  }
  function getSubtaskStatusLabel(item) {
    if (item.status === "current" && isAwaitingStage(item)) {
      return "待确认";
    }
    if (item.manually_skipped && item.status === "completed") {
      return "已跳过";
    }
    const statusLabelMap = {
      pending: "未开始",
      current: "进行中",
      completed: "已完成",
      failed: "失败",
      cancelled: "已取消",
    };
    return statusLabelMap[item.status] || item.status;
  }
  function getSubtaskStatusSummary(item) {
    if (item.status === "current") {
      return isAwaitingStage(item) ? "等待确认" : "进行中";
    }
    if (item.manually_skipped && item.status === "completed") {
      return "手动跳过";
    }
    if (item.status === "failed") return "待修复";
    if (item.status === "cancelled") return "已取消";
    if (item.status === "completed") return "已通过";
    return "待开始";
  }
  function getSubtaskActiveTime(item) {
    return item.updated_at || item.created_at || "";
  }
  function getSubtaskTimeLabel(item) {
    const activeTime = getSubtaskActiveTime(item);
    return activeTime ? formatRelativeTime(activeTime) : "等待推进";
  }
  function getSubtaskMetaList(item) {
    const list = [];
    if (item.role) list.push(`角色 · ${item.role}`);
    if (item.target_folder) list.push(`群组 · ${item.target_folder}`);
    const activeTime = getSubtaskActiveTime(item);
    if (activeTime) list.push(`更新 · ${formatDateTime(activeTime)}`);
    return list;
  }
  const displaySubtasks = getDisplaySubtasks(subtasks);
  const currentSubtask = displaySubtasks.find((item) => item.status === "current") || null;
  const persistedSelection = displaySubtasks.find((item) => item.id === workbenchSelectedSubtaskId) || null;
  const shouldAutoFollowCurrent =
    workbenchFollowCurrentSubtaskOnce &&
    currentSubtask &&
    (!persistedSelection || currentSubtask.id !== persistedSelection.id);
  const selectedId = shouldAutoFollowCurrent
    ? currentSubtask.id
    : persistedSelection
      ? persistedSelection.id
      : (currentSubtask || subtasks[0]).id;
  workbenchSelectedSubtaskId = selectedId;
  if (shouldAutoFollowCurrent) {
    workbenchFollowCurrentSubtaskOnce = false;
  }
  const animationKey = `${currentWorkbenchTaskId}:${selectedId}`;
  const shouldAnimateSelection = workbenchAnimatedSubtaskKey !== animationKey;
  workbenchAnimatedSubtaskKey = animationKey;

  const chainEl = document.createElement("div");
  chainEl.className = "workbench-subtasks-chain";

  displaySubtasks.forEach((item) => {
    const stepIndex = displaySubtasks.findIndex((subtask) => subtask.id === item.id) + 1;
    const el = document.createElement("button");
    el.type = "button";
    el.className = `workbench-subtask-step ${item.status}${item.id === selectedId ? " active" : ""}`;
    if (item.id === selectedId && shouldAnimateSelection) {
      el.classList.add("animate-in");
    }
    const stepHint = item.status === "current"
      ? (isAwaitingStage(item) ? "等待确认" : "正在处理")
      : item.manually_skipped && item.status === "completed"
        ? "已手动跳过"
      : item.status === "failed"
        ? "需处理"
        : item.status === "cancelled"
          ? "已取消"
        : item.status === "completed"
          ? "已通过"
          : "待开始";
    const stepHintIcon = getWorkbenchSubtaskStatusIcon(item.status);
    const summaryLabel = getSubtaskStatusSummary(item);
    const timeLabel = getSubtaskTimeLabel(item);
    const metaTags = [summaryLabel, timeLabel];
    if (item.role) metaTags.push(item.role);
    el.innerHTML = `
      <div class="workbench-subtask-card">
        ${item.status === "current" ? '<span class="workbench-subtask-spotlight"></span>' : ""}
        <div class="workbench-subtask-card-topline">
          <span class="workbench-subtask-index">${String(stepIndex).padStart(2, "0")}</span>
          <span class="workbench-subtask-topline-text">${escapeHtml(summaryLabel)}</span>
          ${item.status === "current" ? '<span class="workbench-current-chip">当前</span>' : ""}
        </div>
        <div class="workbench-subtask-title">${escapeHtml(item.stage_label || item.title)}</div>
        <div class="workbench-subtask-meta-row">
          ${metaTags.map((tag) => `<span class="workbench-subtask-meta-pill">${escapeHtml(tag)}</span>`).join("")}
        </div>
        <div class="workbench-subtask-caption">
          <span class="workbench-subtask-caption-icon" aria-hidden="true">${stepHintIcon}</span>
          <span>${escapeHtml(stepHint)}</span>
        </div>
      </div>
      <div class="workbench-subtask-marker">
        <span class="workbench-subtask-dot"></span>
        <span class="workbench-subtask-line"></span>
      </div>
    `;
    el.addEventListener("click", () => {
      workbenchSelectedSubtaskId = item.id;
      renderWorkbenchSubtasks(subtasks);
    });
    chainEl.appendChild(el);
  });

  const selected = displaySubtasks.find((item) => item.id === selectedId) || displaySubtasks[0];
  const selectedIndex = displaySubtasks.findIndex((item) => item.id === selected.id) + 1;
  const normalizedSelectedResult = typeof selected.result === "string"
    ? selected.result.replace(/^结果摘要[:：]\s*/u, "").trim()
    : "";
  let formattedSelectedResult = normalizedSelectedResult;
  if (normalizedSelectedResult) {
    try {
      formattedSelectedResult = JSON.stringify(JSON.parse(normalizedSelectedResult), null, 2);
    } catch {
      formattedSelectedResult = normalizedSelectedResult;
    }
  }
  const selectedBody = formattedSelectedResult
    ? escapeHtml(formattedSelectedResult)
    : selected.manually_skipped
      ? "该阶段已由人工按成功处理跳过，流程直接进入下一阶段"
    : selected.status === "current" && isAwaitingStage(selected)
      ? "等待审批确认后进入下一阶段"
      : "等待执行或审批推进";
  const detailHint = selected.manually_skipped
    ? `
      <div class="workbench-subtask-hint current">
        <div class="workbench-subtask-hint-title">已手动跳过</div>
        <div class="workbench-subtask-hint-body">
          这个阶段未按原路径完成，而是由人工按“成功处理”跳过；当前仅保留历史记录，不提供重跑入口。
        </div>
      </div>
    `
    : selected.status === "failed"
    ? `
      <div class="workbench-subtask-hint failed">
        <div class="workbench-subtask-hint-title">处理建议</div>
        <div class="workbench-subtask-hint-body">
          优先查看结果摘要中的报错信息；如果不再处理这个阶段，也可以点击“跳过此节点”，按该节点成功处理并直接进入下一阶段。
        </div>
      </div>
    `
    : selected.status === "cancelled"
      ? `
        <div class="workbench-subtask-hint cancelled">
          <div class="workbench-subtask-hint-title">阶段已取消</div>
          <div class="workbench-subtask-hint-body">
            这个阶段因手动取消或流程终止而停止；如需继续流程，可点击“跳过此节点”，按该节点成功处理并直接进入下一阶段。
          </div>
        </div>
      `
    : selected.status === "current"
      ? `
        <div class="workbench-subtask-hint current">
          <div class="workbench-subtask-hint-title">当前焦点</div>
          <div class="workbench-subtask-hint-body">
            ${escapeHtml(isAwaitingStage(selected) ? "这个阶段正在等待审批确认。" : "这个阶段正在执行中，可关注结果摘要与时间线更新。")}
          </div>
        </div>
      `
      : "";
  const selectedMeta = getSubtaskMetaList(selected);
  const detailEl = document.createElement("div");
  detailEl.className = `workbench-subtask-detail-card ${selected.status}${shouldAnimateSelection ? " animate-in" : ""}`;
  detailEl.innerHTML = `
    <div class="workbench-subtask-detail-hero">
      <div class="workbench-subtask-detail-hero-main">
        <div class="workbench-subtask-detail-kicker">Stage ${String(selectedIndex).padStart(2, "0")}</div>
        <div class="workbench-item-title">
          <span class="workbench-subtask-detail-index">阶段 ${selectedIndex}</span>
          ${escapeHtml(selected.stage_label || selected.title)}
        </div>
        <div class="workbench-subtask-detail-status-row">
          ${renderWorkbenchBadge(getSubtaskStatusLabel(selected), `status-${selected.status || "pending"}`)}
          ${selected.manually_skipped ? renderWorkbenchBadge("已手动跳过", "status-cancelled") : ""}
          ${selected.stage_key ? renderWorkbenchBadge(selected.stage_key, "message") : ""}
        </div>
      </div>
      <div class="workbench-subtask-detail-aside">
        <span class="workbench-subtask-detail-time-label">最近动态</span>
        <strong>${escapeHtml(getSubtaskTimeLabel(selected))}</strong>
        <span>${escapeHtml(getSubtaskActiveTime(selected) ? formatDateTime(getSubtaskActiveTime(selected)) : "暂无记录")}</span>
      </div>
    </div>
    ${selectedMeta.length > 0
      ? `<div class="workbench-subtask-detail-meta-grid">${selectedMeta.map((entry) => `<div class="workbench-subtask-detail-meta-item">${escapeHtml(entry)}</div>`).join("")}</div>`
      : ""}
    <div class="workbench-item-body workbench-subtask-detail-body">${selectedBody}</div>
    ${detailHint}
  `;

  const activeTask = currentWorkbenchDetail && currentWorkbenchDetail.task
    ? currentWorkbenchDetail.task
    : null;
  const isRetryComposerOpen = workbenchRetryComposerSubtaskId === selected.id;
  const canRetryDelegation =
    selected.stage_type === "delegation"
    && !selected.manually_skipped
    && (selected.status === "failed" || selected.status === "cancelled");
  const canReturnConfirmation =
    selected.stage_type === "confirmation"
    && !selected.manually_skipped
    && selected.status === "completed";

  if (canRetryDelegation || canReturnConfirmation) {
    const actions = document.createElement("div");
    actions.className = "workbench-subtask-actions";
    if (selected.stage_type === "delegation" && selected.status === "failed") {
      const retryBtn = document.createElement("button");
      retryBtn.className = "btn-ghost";
      retryBtn.textContent = isRetryComposerOpen ? "收起补充" : "重跑";
      retryBtn.addEventListener("click", () => toggleWorkbenchRetryComposer(selected.id));
      actions.appendChild(retryBtn);
    }
    if (canReturnConfirmation && activeTask) {
      const returnBtn = document.createElement("button");
      returnBtn.className = "btn-ghost";
      returnBtn.textContent = "回到此节点";
      returnBtn.addEventListener("click", async () => {
        if (
          !(await openConfirmDialog(`确认回到“${selected.stage_label || selected.title}”并重新处理该确认节点吗？`, {
            title: "回到确认节点",
          }))
        ) return;
        triggerWorkbenchSubtaskRetry(currentWorkbenchTaskId, selected.id, "", {
          reloadAfterSuccess: true,
        });
      });
      actions.appendChild(returnBtn);
    }
    if (canRetryDelegation && activeTask) {
      const labels = getWorkbenchApprovalLabels(activeTask, {
        approval_type: selected.stage_key,
        action_mode: "approve_only",
      });
      const skipBtn = document.createElement("button");
      skipBtn.className = "btn-ghost";
      skipBtn.textContent = labels.skip || "跳过此节点";
      skipBtn.addEventListener("click", async () => {
        if (
          !(await openConfirmDialog(`确认按“成功处理”跳过“${selected.stage_label || selected.title}”并直接进入下一步吗？`, {
            title: "跳过节点",
          }))
        ) return;
        triggerWorkbenchAction(activeTask.id, "skip", selected.id);
      });
      actions.appendChild(skipBtn);
    }
    detailEl.appendChild(actions);

    if (selected.stage_type === "delegation" && selected.status === "failed" && isRetryComposerOpen) {
      const retryComposer = document.createElement("div");
      retryComposer.className = "workbench-retry-composer";
      retryComposer.innerHTML = `
        <label class="workbench-retry-label" for="workbench-retry-note">
          给 agent 补充一些信息，重跑时会一起注入提示词
        </label>
        <textarea
          id="workbench-retry-note"
          rows="4"
          placeholder="例如：报错的复现条件、期望修复方式、不能修改的范围、需要重点关注的文件"
        >${escapeHtml(workbenchRetryComposerDraft)}</textarea>
        <div class="workbench-retry-actions">
          <button type="button" class="btn-primary" ${workbenchRetrySubmitting ? "disabled" : ""}>确认重跑</button>
          <button type="button" class="btn-ghost" data-action="cancel-retry" ${workbenchRetrySubmitting ? "disabled" : ""}>取消</button>
        </div>
      `;
      const retryTextarea = retryComposer.querySelector("#workbench-retry-note");
      if (retryTextarea) {
        retryTextarea.addEventListener("input", (event) => {
          workbenchRetryComposerDraft = event.target.value;
        });
      }
      const retryConfirmBtn = retryComposer.querySelector(".btn-primary");
      if (retryConfirmBtn) {
        retryConfirmBtn.addEventListener("click", () =>
          triggerWorkbenchSubtaskRetry(currentWorkbenchTaskId, selected.id, workbenchRetryComposerDraft)
        );
      }
      const retryCancelBtn = retryComposer.querySelector('[data-action="cancel-retry"]');
      if (retryCancelBtn) {
        retryCancelBtn.addEventListener("click", () => closeWorkbenchRetryComposer());
      }
      detailEl.appendChild(retryComposer);
      requestAnimationFrame(() => {
        if (document.activeElement !== retryTextarea) {
          retryTextarea?.focus();
          if (typeof retryTextarea?.selectionStart === "number") {
            const end = retryTextarea.value.length;
            retryTextarea.setSelectionRange(end, end);
          }
        }
      });
    }
  }

  workbenchSubtasks.appendChild(chainEl);
  workbenchSubtasks.appendChild(detailEl);

  const activeStep = chainEl.querySelector(".workbench-subtask-step.active");
  if (activeStep) {
    const targetLeft =
      activeStep.offsetLeft -
      Math.max(0, (chainEl.clientWidth - activeStep.clientWidth) / 2);
    chainEl.scrollTo({
      left: Math.max(0, targetLeft),
      behavior: "auto",
    });
  }
}

function getWorkbenchSubtaskStatusIcon(status) {
  switch (status) {
    case "current":
      return '<svg viewBox="0 0 24 24"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>';
    case "completed":
      return '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>';
    case "failed":
      return '<svg viewBox="0 0 24 24"><path d="M7 7l10 10"/><path d="M17 7L7 17"/></svg>';
    case "cancelled":
      return '<svg viewBox="0 0 24 24"><path d="M8 8h8v8H8z"/><path d="M12 5v3"/><path d="M12 16v3"/></svg>';
    default:
      return '<svg viewBox="0 0 24 24"><path d="M12 8v4"/><path d="M12 16h.01"/></svg>';
  }
}

function getWorkbenchApprovalLabels(task, approval) {
  const approvalType = approval.approval_type || task.workflow_status;
  switch (approvalType) {
    case "plan_confirm":
      return { approve: "进入开发", revise: "返回方案修改", skip: "跳过此节点" };
    case "plan_examine_confirm":
      return { approve: "继续开发", revise: "返回方案修改", skip: "跳过此节点" };
    case "dev_examine_confirm":
      return { approve: "继续后续流程", revise: "返回开发修正", skip: "跳过此节点" };
    case "awaiting_confirm":
      return { approve: "开始预发部署", revise: "", skip: "跳过此节点" };
    case "testing_confirm":
      return { approve: "", revise: "填写 access_token 并开始测试", skip: "跳过鉴权直接测试" };
    default:
      return {
        approve: "通过",
        revise: approval.action_mode === "approve_or_revise" ? "驳回并修改" : "",
        skip: "跳过此节点",
      };
  }
}

function renderWorkbenchActionItems(actionItems, task) {
  workbenchActionItems.innerHTML = "";
  if (actionItems.length === 0) {
    if (workbenchActionItemsPanel) workbenchActionItemsPanel.classList.add("hidden");
    workbenchActionItems.innerHTML = `<div class="workbench-empty">当前没有待处理项</div>`;
    return;
  }
  if (workbenchActionItemsPanel) workbenchActionItemsPanel.classList.remove("hidden");
  actionItems.forEach((item) => {
    const el = document.createElement("div");
    el.className = "workbench-approval-item";
    const badge = item.item_type === "approval"
      ? "待确认"
      : item.source_type === "request_human_input"
        ? "人工输入"
        : item.source_type === "ask_user_question"
          ? "提问"
          : "消息";
    const badgeKind = item.item_type === "approval"
      ? "approval"
      : item.source_type === "request_human_input"
        ? "input"
        : item.source_type === "ask_user_question"
          ? "question"
          : "message";
    el.innerHTML = `
      <div class="workbench-item-row">
        <div class="workbench-item-title">${escapeHtml(item.title)}</div>
        ${renderWorkbenchBadge(badge, badgeKind)}
      </div>
      <div class="workbench-item-body">${escapeHtml(item.body)}</div>
    `;
    const actions = document.createElement("div");
    actions.className = "workbench-task-actions";
    if (item.item_type === "approval") {
      const labels = getWorkbenchApprovalLabels(task, {
        approval_type: item.stage_key || task.workflow_status,
        action_mode: item.action_mode || "approve_only",
      });
      if (item.action_mode !== "input_required") {
        const approveBtn = document.createElement("button");
        approveBtn.className = "btn-ghost workbench-action-btn workbench-action-btn-primary";
        approveBtn.textContent = labels.approve;
        approveBtn.addEventListener("click", () => triggerWorkbenchAction(task.id, "approve"));
        actions.appendChild(approveBtn);
      }
      const skipBtn = document.createElement("button");
      skipBtn.className = "btn-ghost workbench-action-btn";
      skipBtn.textContent = labels.skip || "跳过此节点";
      skipBtn.addEventListener("click", async () => {
        if (!(await openConfirmDialog(`确认跳过“${item.title}”并进入下一步吗？`, { title: "跳过节点" }))) return;
        triggerWorkbenchAction(task.id, "skip");
      });
      actions.appendChild(skipBtn);
      if (item.action_mode === "approve_or_revise" || item.action_mode === "input_required") {
        const reviseBtn = document.createElement("button");
        reviseBtn.className = item.action_mode === "input_required"
          ? "btn-ghost workbench-action-btn workbench-action-btn-primary"
          : "btn-ghost workbench-action-btn";
        reviseBtn.textContent = labels.revise || "驳回并修改";
        reviseBtn.addEventListener("click", () =>
          triggerWorkbenchAction(task.id, item.action_mode === "input_required" ? "submit_access_token" : "revise")
        );
        actions.appendChild(reviseBtn);
      }
    } else {
      const askQuestion = item.source_type === "ask_user_question"
        ? item.extra?.current_question || item.extra?.questions?.[0]
        : null;
      const askOptions = askQuestion?.options;
      if (Array.isArray(askOptions) && askOptions.length > 0) {
        const optionsRow = document.createElement("div");
        optionsRow.className = "workbench-ask-options";
        askOptions.forEach((opt) => {
          const optBtn = document.createElement("button");
          optBtn.className = "btn-ghost workbench-action-btn workbench-ask-btn";
          optBtn.textContent = opt.label;
          if (opt.description) optBtn.title = opt.description;
          optBtn.addEventListener("click", () => triggerWorkbenchActionItem(task.id, item.id, "reply", opt.label));
          optionsRow.appendChild(optBtn);
        });
        actions.appendChild(optionsRow);
        const fallbackRow = document.createElement("div");
        fallbackRow.className = "workbench-ask-fallback";
        const replyBtn = document.createElement("button");
        replyBtn.className = "btn-ghost workbench-action-btn workbench-action-btn-primary";
        replyBtn.textContent = "自定义回复";
        replyBtn.addEventListener("click", () => triggerWorkbenchActionItem(task.id, item.id, "reply"));
        fallbackRow.appendChild(replyBtn);
        const skipBtn = document.createElement("button");
        skipBtn.className = "btn-ghost workbench-action-btn workbench-action-btn-muted";
        skipBtn.textContent = "跳过";
        skipBtn.addEventListener("click", () => triggerWorkbenchActionItem(task.id, item.id, "skip"));
        fallbackRow.appendChild(skipBtn);
        actions.appendChild(fallbackRow);
      } else {
        if (item.replyable) {
          const replyBtn = document.createElement("button");
          replyBtn.className = "btn-ghost workbench-action-btn workbench-action-btn-primary";
          replyBtn.textContent = "回复";
          replyBtn.addEventListener("click", () => triggerWorkbenchActionItem(task.id, item.id, "reply"));
          actions.appendChild(replyBtn);
        }
        const approveBtn = document.createElement("button");
        approveBtn.className = "btn-ghost workbench-action-btn";
        approveBtn.textContent = "确认";
        approveBtn.addEventListener("click", () => triggerWorkbenchActionItem(task.id, item.id, "confirm"));
        actions.appendChild(approveBtn);
        const skipBtn = document.createElement("button");
        skipBtn.className = "btn-ghost workbench-action-btn workbench-action-btn-muted";
        skipBtn.textContent = "跳过";
        skipBtn.addEventListener("click", () => triggerWorkbenchActionItem(task.id, item.id, "skip"));
        actions.appendChild(skipBtn);
        const cancelBtn = document.createElement("button");
        cancelBtn.className = "btn-ghost workbench-action-btn workbench-action-btn-danger";
        cancelBtn.textContent = "取消";
        cancelBtn.addEventListener("click", () => triggerWorkbenchActionItem(task.id, item.id, "cancel"));
        actions.appendChild(cancelBtn);
      }
    }
    el.appendChild(actions);
    workbenchActionItems.appendChild(el);
  });
}

function sortWorkbenchItemsByCreatedAt(items) {
  if (!Array.isArray(items)) return [];
  return [...items].sort((a, b) => {
    const aTs = parseTimestamp(a?.created_at || "");
    const bTs = parseTimestamp(b?.created_at || "");
    const safeATs = Number.isFinite(aTs) ? aTs : 0;
    const safeBTs = Number.isFinite(bTs) ? bTs : 0;
    if (safeATs !== safeBTs) return safeBTs - safeATs;
    return String(b?.id || "").localeCompare(String(a?.id || ""));
  });
}

function applyWorkbenchActionItemRealtimeUpdate(payload) {
  if (!currentWorkbenchDetail || !Array.isArray(currentWorkbenchDetail.action_items)) {
    return false;
  }
  const itemId = typeof payload.id === "string" ? payload.id : "";
  if (!itemId) return false;
  const previousDetail = {
    task: currentWorkbenchDetail.task,
    action_items: currentWorkbenchDetail.action_items.map((item) => ({ ...item })),
  };

  const nextStatus = typeof payload.status === "string" ? payload.status : "";
  const existingIdx = currentWorkbenchDetail.action_items.findIndex((item) => item.id === itemId);
  const shouldRemove = ["resolved", "confirmed", "skipped", "cancelled", "expired"].includes(nextStatus);
  if (shouldRemove) {
    if (existingIdx < 0) return true;
    currentWorkbenchDetail.action_items.splice(existingIdx, 1);
    renderWorkbenchActionItems(currentWorkbenchDetail.action_items, currentWorkbenchDetail.task);
    return true;
  }

  if (nextStatus && nextStatus !== "pending") {
    return false;
  }

  const nextItem = existingIdx >= 0
    ? { ...currentWorkbenchDetail.action_items[existingIdx] }
    : {
        id: itemId,
        item_type: payload.itemType === "approval" ? "approval" : "interactive",
        source_type: typeof payload.sourceType === "string" ? payload.sourceType : "workflow",
        title: "",
        body: "",
        status: "pending",
        stage_key: typeof payload.stageKey === "string" ? payload.stageKey : undefined,
        delegation_id: typeof payload.delegationId === "string" ? payload.delegationId : undefined,
        group_folder: typeof payload.groupFolder === "string" ? payload.groupFolder : undefined,
        source_ref_id: typeof payload.sourceRefId === "string" ? payload.sourceRefId : undefined,
        replyable: Boolean(payload.replyable),
        action_mode: typeof payload.actionMode === "string" ? payload.actionMode : undefined,
        created_at: typeof payload.createdAt === "string" ? payload.createdAt : new Date().toISOString(),
        extra: payload.extra && typeof payload.extra === "object" ? payload.extra : undefined,
      };

  if (typeof payload.title === "string") nextItem.title = payload.title;
  if (typeof payload.body === "string") nextItem.body = payload.body;
  if (typeof payload.stageKey === "string") nextItem.stage_key = payload.stageKey;
  if (typeof payload.delegationId === "string") nextItem.delegation_id = payload.delegationId;
  if (typeof payload.groupFolder === "string") nextItem.group_folder = payload.groupFolder;
  if (typeof payload.sourceRefId === "string") nextItem.source_ref_id = payload.sourceRefId;
  if (typeof payload.replyable === "boolean") nextItem.replyable = payload.replyable;
  if (typeof payload.actionMode === "string") nextItem.action_mode = payload.actionMode;
  if (typeof payload.itemType === "string") {
    nextItem.item_type = payload.itemType === "approval" ? "approval" : "interactive";
  }
  if (typeof payload.sourceType === "string") nextItem.source_type = payload.sourceType;
  if (typeof payload.createdAt === "string") nextItem.created_at = payload.createdAt;
  if (payload.extra && typeof payload.extra === "object") nextItem.extra = payload.extra;
  nextItem.status = "pending";

  if (existingIdx >= 0) {
    currentWorkbenchDetail.action_items[existingIdx] = nextItem;
  } else {
    currentWorkbenchDetail.action_items.push(nextItem);
  }
  currentWorkbenchDetail.action_items = sortWorkbenchItemsByCreatedAt(currentWorkbenchDetail.action_items);
  renderWorkbenchActionItems(currentWorkbenchDetail.action_items, currentWorkbenchDetail.task);
  maybeNotifyWorkbenchPending(currentWorkbenchDetail, previousDetail);
  return true;
}

function renderWorkbenchArtifacts(artifacts) {
  const sortedArtifacts = sortWorkbenchItemsByCreatedAt(artifacts);
  workbenchArtifacts.innerHTML = "";
  if (sortedArtifacts.length === 0) {
    workbenchArtifacts.innerHTML = `<div class="workbench-empty">暂无产出物</div>`;
    return;
  }
  sortedArtifacts.forEach((item) => {
    const el = document.createElement("div");
    const canOpen = Boolean(item.exists && item.absolute_path);
    el.className = `workbench-artifact-item${canOpen ? " is-clickable" : ""}`;
    el.innerHTML = `
      <div class="workbench-item-row">
        <div class="workbench-item-title">${escapeHtml(item.title)}</div>
        ${renderWorkbenchBadge(item.exists ? "ready" : "missing", item.exists ? "ready" : "missing")}
      </div>
      <div class="workbench-item-body">${escapeHtml(item.path)}</div>
    `;
    if (canOpen) {
      el.title = "点击打开产出物";
      el.addEventListener("click", () => {
        if (window.nanoclawApp?.openFile) {
          window.nanoclawApp.openFile(item.absolute_path);
        } else {
          window.open(`file://${item.absolute_path}`);
        }
      });
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showFileContextMenu(e, item.absolute_path);
      });
    }
    workbenchArtifacts.appendChild(el);
  });
}

function renderWorkbenchAssets(assets) {
  const sortedAssets = sortWorkbenchItemsByCreatedAt(assets);
  workbenchAssets.innerHTML = "";
  if (sortedAssets.length === 0) {
    workbenchAssets.innerHTML = `<div class="workbench-empty">暂无上下文资产</div>`;
    return;
  }
  sortedAssets.forEach((item) => {
    const el = document.createElement("div");
    el.className = "workbench-artifact-item";
    const href = item.url || (item.path ? `file://${item.path}` : "");
    el.innerHTML = `
      <div class="workbench-item-row">
        <div class="workbench-item-title">${escapeHtml(item.title)}</div>
        ${renderWorkbenchBadge(item.asset_type, "asset")}
      </div>
      <div class="workbench-item-body">${escapeHtml(item.note || item.path || item.url || "")}</div>
    `;
    if (href) {
      el.style.cursor = "pointer";
      el.addEventListener("click", () => window.open(href));
    }
    workbenchAssets.appendChild(el);
  });
}

function renderWorkbenchComments(comments) {
  const sortedComments = sortWorkbenchItemsByCreatedAt(comments);
  workbenchComments.innerHTML = "";
  if (sortedComments.length === 0) {
    workbenchComments.innerHTML = `<div class="workbench-empty">暂无备注评论</div>`;
    return;
  }
  sortedComments.forEach((item) => {
    const el = document.createElement("div");
    el.className = "workbench-event-item";
    el.innerHTML = `
      <div class="workbench-item-row">
        <div class="workbench-item-title">${escapeHtml(item.author)}</div>
        ${renderWorkbenchBadge(formatDateTime(item.created_at), "time")}
      </div>
      <div class="workbench-item-body">${escapeHtml(item.content)}</div>
    `;
    workbenchComments.appendChild(el);
  });
}

function renderWorkbenchTimeline(timeline) {
  const sortedTimeline = sortWorkbenchTimeline(timeline);
  workbenchTimeline.innerHTML = "";
  if (sortedTimeline.length === 0) {
    workbenchTimeline.innerHTML = `<div class="workbench-empty">暂无执行记录</div>`;
    return;
  }
  sortedTimeline.forEach((item) => {
    const el = document.createElement("div");
    const itemKey = item.id || `${item.type || "execution"}-${item.created_at || ""}-${item.title || ""}`;
    const isExpanded = expandedWorkbenchTimelineIds.has(itemKey);
    el.className = `workbench-event-item workbench-timeline-item ${item.type || ""}${isExpanded ? " expanded" : ""}`;
    el.setAttribute("data-timeline-id", itemKey);
    const eventTypeLabel = item.type === "manual"
      ? "手动处理"
      : item.type === "approval"
        ? "审批"
        : item.type === "artifact"
          ? "产物"
          : item.type === "lifecycle"
            ? "流程"
            : "执行";
    const eventTypeKind = item.type === "manual"
      ? "timeline-manual"
      : item.type === "approval"
        ? "timeline-approval"
        : item.type === "lifecycle"
          ? "timeline-flow"
          : item.type === "artifact"
            ? "artifact"
            : "timeline-execution";
    const detailBody = item.body && String(item.body).trim() ? escapeHtml(item.body) : "暂无详细信息";
    el.innerHTML = `
      <button type="button" class="workbench-timeline-toggle" aria-expanded="${isExpanded ? "true" : "false"}">
        <div class="workbench-item-row">
          <div class="workbench-item-title">
            ${escapeHtml(item.title)}
            ${renderWorkbenchBadge(eventTypeLabel, eventTypeKind)}
          </div>
          <div class="workbench-timeline-meta">
            ${renderWorkbenchBadge(formatDateTime(item.created_at), "time")}
            <span class="workbench-timeline-chevron" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>
            </span>
          </div>
        </div>
      </button>
      <div class="workbench-item-body workbench-timeline-body">${detailBody}</div>
    `;
    const toggleBtn = el.querySelector(".workbench-timeline-toggle");
    toggleBtn?.addEventListener("click", () => {
      const nextExpanded = !el.classList.contains("expanded");
      el.classList.toggle("expanded", nextExpanded);
      toggleBtn.setAttribute("aria-expanded", nextExpanded ? "true" : "false");
      if (nextExpanded) {
        expandedWorkbenchTimelineIds.add(itemKey);
      } else {
        expandedWorkbenchTimelineIds.delete(itemKey);
      }
    });
    workbenchTimeline.appendChild(el);
  });
}

function sortWorkbenchTimeline(timeline) {
  if (!Array.isArray(timeline)) return [];
  return [...timeline].sort((a, b) => {
    const aTs = parseTimestamp(a?.created_at || "");
    const bTs = parseTimestamp(b?.created_at || "");
    const safeATs = Number.isFinite(aTs) ? aTs : 0;
    const safeBTs = Number.isFinite(bTs) ? bTs : 0;
    if (safeATs !== safeBTs) return safeATs - safeBTs;
    return String(a?.id || "").localeCompare(String(b?.id || ""));
  });
}

async function triggerWorkbenchAction(taskId, action, subtaskId = "") {
  let revisionText = "";
  let accessToken = "";
  if (action === "revise") {
    revisionText = await openTextPrompt("请输入修改意见", "", {
      title: "修改意见",
      multiline: true,
    }) || "";
    if (!revisionText.trim()) return;
  } else if (action === "submit_access_token") {
    accessToken = await openTextPrompt("请输入 access_token", "", {
      title: "填写 access_token",
      placeholder: "请输入测试 token",
    }) || "";
    if (!accessToken.trim()) return;
  }
  try {
    const res = await apiFetch("/api/workbench/task/action", {
      method: "POST",
      body: JSON.stringify({
        task_id: taskId,
        subtask_id: subtaskId || undefined,
        action,
        revision_text: revisionText,
        context: accessToken ? { access_token: accessToken } : void 0,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (action === "skip") {
      workbenchSelectedSubtaskId = "";
      workbenchFollowCurrentSubtaskOnce = true;
    }
    await loadWorkbenchTasks(taskId);
  } catch (err) {
    console.error("Failed to run workbench action:", err);
    alert(err.message || "任务操作失败");
  }
}

async function triggerWorkbenchActionItem(taskId, actionItemId, action, prefillText) {
  let replyText = "";
  if (action === "reply") {
    if (typeof prefillText === "string" && prefillText) {
      replyText = prefillText;
    } else {
      replyText = await openTextPrompt("请输入回复内容", "", {
        title: "回复待处理项",
        multiline: true,
      }) || "";
      if (!replyText.trim()) return;
    }
  }
  try {
    const res = await apiFetch("/api/workbench/action-item", {
      method: "POST",
      body: JSON.stringify({
        task_id: taskId,
        action_item_id: actionItemId,
        action,
        reply_text: replyText || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadWorkbenchTaskDetail(taskId);
  } catch (err) {
    console.error("Failed to handle workbench action item:", err);
    const message = err instanceof Error ? err.message : "待处理项操作失败";
    if (/Action item not found/i.test(message)) {
      try {
        await loadWorkbenchTaskDetail(taskId);
      } catch (reloadErr) {
        console.error("Failed to reload stale workbench detail:", reloadErr);
      }
      showToast("待处理项已失效，已刷新工作台", 2200);
      return;
    }
    if (typeof window !== "undefined" && typeof window.alert === "function" && !shouldUseCustomAppDialogs()) {
      window.alert(message);
      return;
    }
    showToast(message, 2200);
  }
}

function toggleWorkbenchRetryComposer(subtaskId) {
  if (workbenchRetryComposerSubtaskId === subtaskId) {
    closeWorkbenchRetryComposer();
    return;
  }
  workbenchRetryComposerSubtaskId = subtaskId;
  workbenchRetryComposerDraft = "";
  renderWorkbenchSubtasks(currentWorkbenchDetail?.subtasks || []);
}

function closeWorkbenchRetryComposer() {
  workbenchRetryComposerSubtaskId = "";
  workbenchRetryComposerDraft = "";
  workbenchRetrySubmitting = false;
  renderWorkbenchSubtasks(currentWorkbenchDetail?.subtasks || []);
}

async function triggerWorkbenchSubtaskRetry(taskId, subtaskId, retryNote = "", options = {}) {
  workbenchRetrySubmitting = true;
  renderWorkbenchSubtasks(currentWorkbenchDetail?.subtasks || []);
  try {
    const res = await apiFetch("/api/workbench/subtask/retry", {
      method: "POST",
      body: JSON.stringify({
        task_id: taskId,
        subtask_id: subtaskId,
        retry_note: retryNote || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (options.reloadAfterSuccess) {
      workbenchSelectedSubtaskId = "";
      workbenchFollowCurrentSubtaskOnce = true;
      closeWorkbenchRetryComposer();
      await loadWorkbenchTasks(taskId);
      return;
    }
    closeWorkbenchRetryComposer();
  } catch (err) {
    console.error("Failed to retry subtask:", err);
    alert(err.message || "子任务重跑失败");
    workbenchRetrySubmitting = false;
    renderWorkbenchSubtasks(currentWorkbenchDetail?.subtasks || []);
  }
}

async function submitWorkbenchComment() {
  if (!currentWorkbenchTaskId || !workbenchCommentInput.value.trim()) return;
  try {
    const res = await apiFetch("/api/workbench/task/comment", {
      method: "POST",
      body: JSON.stringify({
        task_id: currentWorkbenchTaskId,
        author: "Web User",
        content: workbenchCommentInput.value.trim(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    workbenchCommentInput.value = "";
  } catch (err) {
    console.error("Failed to add workbench comment:", err);
    alert(err.message || "添加备注失败");
  }
}

async function addWorkbenchLinkAsset() {
  if (!currentWorkbenchTaskId) return;
  const url = await openTextPrompt("输入链接 URL", "https://", {
    title: "添加链接",
    placeholder: "https://",
  });
  if (!url || !url.trim()) return;
  const title = await openTextPrompt("链接标题", "参考链接", {
    title: "添加链接",
  }) || "参考链接";
  const note = await openTextPrompt("补充说明", "", {
    title: "添加链接",
    multiline: true,
  }) || "";
  try {
    const res = await apiFetch("/api/workbench/task/asset", {
      method: "POST",
      body: JSON.stringify({
        task_id: currentWorkbenchTaskId,
        title,
        asset_type: "link",
        url: url.trim(),
        note,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  } catch (err) {
    console.error("Failed to add workbench link asset:", err);
    alert(err.message || "添加链接失败");
  }
}

async function addWorkbenchFileAsset() {
  if (!currentWorkbenchTaskId) return;
  const picker = document.createElement("input");
  picker.type = "file";
  picker.onchange = async () => {
    const file = picker.files && picker.files[0];
    if (!file) return;
    try {
      const formData = new FormData();
      formData.append("file", file);
      const uploadRes = await fetch(
        `http://localhost:3000/api/upload?jid=${encodeURIComponent(currentGroupJid || groups.find((g) => g.isMain)?.jid || "")}`,
        { method: "POST", body: formData }
      );
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) throw new Error(uploadData.error || `HTTP ${uploadRes.status}`);
      const uploaded = uploadData.files && uploadData.files[0];
      if (!uploaded) throw new Error("上传结果为空");
      const note = await openTextPrompt("补充说明", "", {
        title: "添加文件",
        multiline: true,
      }) || "";
      const assetRes = await apiFetch("/api/workbench/task/asset", {
        method: "POST",
        body: JSON.stringify({
          task_id: currentWorkbenchTaskId,
          title: file.name,
          asset_type: "file",
          path: uploaded.hostPath,
          note,
        }),
      });
      const assetData = await assetRes.json();
      if (!assetRes.ok) throw new Error(assetData.error || `HTTP ${assetRes.status}`);
    } catch (err) {
      console.error("Failed to add workbench file asset:", err);
      alert(err.message || "添加文件失败");
    }
  };
  picker.click();
}

async function openWorkbenchCreateTaskModal() {
  const optionsData = await loadWorkflowCreateOptions();
  const workflowTypes = Array.isArray(optionsData.workflow_types) ? optionsData.workflow_types : [];
  const services = Array.isArray(optionsData.services) ? optionsData.services : [];
  const requirementsByService = optionsData.requirements_by_service || {};
  const mainGroup = groups.find((group) => group.isMain) || groups[0];

  if (!mainGroup) {
    alert("未找到可用主群，无法创建任务");
    return;
  }
  if (workflowTypes.length === 0 || services.length === 0) {
    alert("当前没有可用流程类型或服务配置");
    return;
  }

  const existing = document.getElementById("workbench-create-overlay");
  if (existing) existing.remove();

  const state = {
    title: "",
    workflowType: workflowTypes[0].type,
    entryPoint: workflowTypes[0].entry_points[0] || "",
    service: services[0],
    fieldSearch: {},
    formValues: {},
    uploadingFiles: 0,
  };

  const overlay = document.createElement("div");
  overlay.id = "workbench-create-overlay";
  overlay.className = "workflow-wizard-overlay";
  overlay.innerHTML = `
    <div class="workflow-wizard-modal workbench-create-modal">
      <div class="workflow-wizard-header workbench-create-header">
        <div class="workflow-wizard-header-copy">
          <div class="workflow-wizard-kicker">Workbench</div>
          <div class="workflow-wizard-title-row">
            <div class="workflow-wizard-title">新建工作台任务</div>
            <span class="workflow-wizard-header-badge">更精致的任务发起面板</span>
          </div>
          <div class="workflow-wizard-header-desc">按流程、入口点与服务维度快速组织任务，右侧会实时显示当前配置摘要与校验状态。</div>
        </div>
        <button type="button" class="workflow-wizard-action-btn workflow-wizard-close" id="workbench-create-close" title="关闭" aria-label="关闭">
          <span class="workflow-wizard-btn-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M7 7l10 10"/><path d="M17 7L7 17"/></svg>
          </span>
        </button>
      </div>
      <div class="workflow-wizard-steps" aria-hidden="true">
        <div class="workflow-wizard-step is-active">
          <span>01</span>
          <strong>选择流程</strong>
        </div>
        <div class="workflow-wizard-step">
          <span>02</span>
          <strong>补充信息</strong>
        </div>
        <div class="workflow-wizard-step">
          <span>03</span>
          <strong>确认创建</strong>
        </div>
      </div>
      <div class="workflow-wizard-body workflow-wizard-body-split">
        <div class="workflow-wizard-main">
          <div class="workflow-wizard-section workflow-wizard-section-hero">
            <div class="workflow-wizard-hero-grid">
              <div>
                <div class="workflow-wizard-label">任务创建方式</div>
                <div class="workflow-wizard-hero-title">从工作台直接发起标准流程</div>
                <div class="workflow-wizard-hero-copy">适合需求规划、开发、测试等多阶段协作。切换流程后，表单会自动切换对应字段与规则。</div>
              </div>
              <div class="workflow-wizard-metrics">
                <div class="workflow-wizard-metric">
                  <span>可用流程</span>
                  <strong>${workflowTypes.length}</strong>
                </div>
                <div class="workflow-wizard-metric">
                  <span>服务数量</span>
                  <strong>${services.length}</strong>
                </div>
                <div class="workflow-wizard-metric">
                  <span>主群</span>
                  <strong>${escapeHtml(mainGroup.name || mainGroup.jid || '默认')}</strong>
                </div>
              </div>
            </div>
          </div>
          <div class="workflow-wizard-section">
            <div class="workflow-wizard-label">1. 任务名称</div>
            <div class="workflow-wizard-subsection">
              <input
                id="wb-title-input"
                class="workflow-wizard-input"
                type="text"
                placeholder="输入任务名称"
                maxlength="120"
              />
            </div>
          </div>
          <div class="workflow-wizard-section">
            <div class="workflow-wizard-label">2. 流程类型</div>
            <div id="wb-type-select-wrap" class="workflow-wizard-subsection"></div>
          </div>
          <div class="workflow-wizard-section">
            <div class="workflow-wizard-label">3. 入口点</div>
            <div id="wb-entry-options" class="workflow-wizard-options"></div>
          </div>
          <div class="workflow-wizard-section">
            <div class="workflow-wizard-label">4. 服务名称</div>
            <div id="wb-service-options" class="workflow-wizard-options"></div>
          </div>
          <div id="wb-dynamic-fields"></div>
        </div>
        <aside class="workflow-wizard-sidebar-panel">
          <div id="wb-type-summary" class="workflow-wizard-subsection"></div>
          <div class="workflow-wizard-section workflow-wizard-summary-card">
            <div class="workflow-wizard-label">当前配置摘要</div>
            <div id="wb-selection-summary" class="workflow-wizard-selection-list"></div>
          </div>
          <div class="workflow-wizard-section workflow-wizard-validation-card" id="wb-validation-card">
            <div class="workflow-wizard-label">校验提示</div>
            <div id="wb-requirement-hint" class="workflow-wizard-hint"></div>
          </div>
        </aside>
      </div>
      <div class="workflow-wizard-footer workbench-create-footer">
        <div class="workflow-wizard-footer-meta">
          <div class="workflow-wizard-footer-label">Ready to launch</div>
          <div id="wb-footer-status" class="workflow-wizard-footer-status">请先完成基础配置</div>
        </div>
        <div class="workflow-wizard-footer-actions">
          <button type="button" id="wb-cancel-btn" class="btn-ghost workflow-wizard-action-btn workflow-wizard-secondary-btn">
            <span class="workflow-wizard-btn-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>
            </span>
            <span>取消</span>
          </button>
          <button type="button" id="wb-submit-btn" class="btn-primary workflow-wizard-action-btn workflow-wizard-submit-btn">
            <span class="workflow-wizard-btn-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>
            </span>
            <span>创建任务</span>
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const typeSelectWrapEl = overlay.querySelector("#wb-type-select-wrap");
  const titleInputEl = overlay.querySelector("#wb-title-input");
  const typeSummaryEl = overlay.querySelector("#wb-type-summary");
  const entryOptionsEl = overlay.querySelector("#wb-entry-options");
  const serviceOptionsEl = overlay.querySelector("#wb-service-options");
  const dynamicFieldsEl = overlay.querySelector("#wb-dynamic-fields");
  const reqHintEl = overlay.querySelector("#wb-requirement-hint");
  const validationCardEl = overlay.querySelector("#wb-validation-card");
  const selectionSummaryEl = overlay.querySelector("#wb-selection-summary");
  const footerStatusEl = overlay.querySelector("#wb-footer-status");
  const submitBtn = overlay.querySelector("#wb-submit-btn");
  const submitBtnLabelEl = submitBtn.querySelector("span:last-child");

  function closeWorkbenchCreateModal() {
    overlay.remove();
  }

  function getSelectedWorkflowType() {
    return workflowTypes.find((item) => item.type === state.workflowType) || workflowTypes[0];
  }

  function getEntryPoints() {
    return Array.isArray(getSelectedWorkflowType().entry_points) ? getSelectedWorkflowType().entry_points : [];
  }

  function getRequirements() {
    const rows = requirementsByService[state.service];
    return Array.isArray(rows) ? rows : [];
  }

  function getFallbackCreateForm(selectedType) {
    if (selectedType.type === "dev_test") {
      return {
        fields: [
          {
            key: "requirement_custom",
            label: "需求描述",
            type: "textarea",
            placeholder: "请描述需求背景、目标、范围与限制条件",
            required: true,
            visible_when: { entry_points: ["plan"] },
          },
          {
            key: "requirement_files",
            label: "需求附件",
            type: "file_uploads",
            helper_text: "支持上传多个文件，创建后会把文件地址一起带给 Plan Agent。",
            visible_when: { entry_points: ["plan"] },
          },
          {
            key: "requirement_preset",
            label: "关联需求",
            type: "requirement_select",
            searchable: true,
            helper_text: "选择已有需求目录，用于定位交付物与历史文档。",
            visible_when: { entry_points: ["dev", "testing"] },
          },
          {
            key: "main_branch",
            label: "main_branch（主分支，可选）",
            type: "text",
            placeholder: "例如：main",
          },
          {
            key: "staging_base_branch",
            label: "staging_base_branch（预发分支，可选）",
            type: "text",
            placeholder: "例如：staging",
          },
          {
            key: "work_branch",
            label: "work_branch（工作分支，可选）",
            type: "text",
            placeholder: "例如：feature/xxx",
          },
          {
            key: "staging_work_branch",
            label: "staging_work_branch（预发工作分支，可选）",
            type: "text",
            placeholder: "例如：staging-deploy/feature-xxx",
          },
        ],
      };
    }

    return {
      fields: [
        {
          key: "requirement_mode",
          label: "任务来源",
          type: "choice",
          default_value: "preset",
          options: [
            { value: "preset", label: "已有需求" },
            { value: "custom", label: "自定义任务" },
          ],
        },
        {
          key: "requirement_preset",
          label: "关联需求",
          type: "requirement_select",
          helper_text: "选择已有需求目录，用于定位交付物与历史文档。",
          visible_when: { equals: { requirement_mode: "preset" } },
        },
        {
          key: "requirement_custom",
          label: "任务名称",
          type: "text",
          placeholder: "输入任务名称",
          visible_when: { equals: { requirement_mode: "custom" } },
        },
      ],
    };
  }

  function getCreateForm() {
    return getSelectedWorkflowType().create_form || getFallbackCreateForm(getSelectedWorkflowType());
  }

  function ensureCreateFormDefaults() {
    const form = getCreateForm();
    (form.fields || []).forEach((field) => {
      if (state.formValues[field.key] !== void 0) return;
      if (field.default_value !== void 0) {
        state.formValues[field.key] = field.default_value;
        return;
      }
      if (field.type === "choice" && Array.isArray(field.options) && field.options.length > 0) {
        state.formValues[field.key] = field.options[0].value;
        return;
      }
      if (field.type === "file_uploads") {
        state.formValues[field.key] = [];
        return;
      }
      state.formValues[field.key] = "";
    });
  }

  function isFieldVisible(field) {
    const rule = field.visible_when;
    if (!rule) return true;
    if (Array.isArray(rule.entry_points) && rule.entry_points.length > 0 && !rule.entry_points.includes(state.entryPoint)) {
      return false;
    }
    if (rule.equals && typeof rule.equals === "object") {
      const entries = Object.entries(rule.equals);
      for (const [depKey, expected] of entries) {
        const actual = state.formValues[depKey];
        if (Array.isArray(expected)) {
          if (!expected.includes(actual)) return false;
        } else if (actual !== expected) {
          return false;
        }
      }
    }
    return true;
  }

  function getVisibleCreateFields() {
    ensureCreateFormDefaults();
    return (getCreateForm().fields || []).filter((field) => isFieldVisible(field));
  }

  function isCreateFieldFilled(field) {
    const value = state.formValues[field.key];
    if (field.type === "file_uploads") {
      return Array.isArray(value) && value.some((item) => item && typeof item.path === "string" && item.path.trim());
    }
    if (Array.isArray(value)) return value.length > 0;
    return typeof value === "string" ? value.trim().length > 0 : value !== void 0 && value !== null;
  }

  function getMissingRequiredCreateFields() {
    return getVisibleCreateFields().filter((field) => field.required === true && !isCreateFieldFilled(field));
  }

  function getFileUploadFields() {
    return getVisibleCreateFields().filter((field) => field.type === "file_uploads");
  }

  function getFileUploadSummary() {
    const labels = [];
    getFileUploadFields().forEach((field) => {
      const files = Array.isArray(state.formValues[field.key]) ? state.formValues[field.key] : [];
      files.forEach((item) => {
        if (!item) return;
        labels.push(item.name || item.path || "未命名附件");
      });
    });
    return labels;
  }

  function buildCreateFormContext() {
    const context = {};
    getVisibleCreateFields().forEach((field) => {
      const value = state.formValues[field.key];
      if (field.type === "file_uploads") {
        const paths = Array.isArray(value)
          ? value
            .map((item) => item && item.path)
            .filter((item) => typeof item === "string" && item.trim())
          : [];
        if (paths.length > 0) context[field.key] = paths;
        return;
      }
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed) context[field.key] = trimmed;
        return;
      }
      if (value !== void 0 && value !== null) {
        context[field.key] = value;
      }
    });
    return context;
  }

  function getTaskTitle() {
    return typeof state.title === "string" ? state.title.trim() : "";
  }

  function getRequirementDescription() {
    const candidates = ["requirement_description", "requirement_custom"];
    const visibleKeys = new Set(getVisibleCreateFields().map((field) => field.key));
    for (const key of candidates) {
      if (!visibleKeys.has(key)) continue;
      const raw = state.formValues[key];
      if (typeof raw === "string" && raw.trim()) {
        return raw.trim();
      }
    }
    return "";
  }

  function getSelectedRequirementName() {
    const candidates = ["requirement_preset", "deliverable_source"];
    const visibleKeys = new Set(getVisibleCreateFields().map((field) => field.key));
    for (const key of candidates) {
      if (!visibleKeys.has(key)) continue;
      const raw = state.formValues[key];
      if (typeof raw === "string" && raw.trim()) {
        return raw.trim();
      }
    }
    return "";
  }

  function setFieldValue(key, value) {
    state.formValues[key] = value;
  }

  async function uploadWorkbenchCreateFiles(files) {
    if (!files || files.length === 0) return [];
    state.uploadingFiles += files.length;
    updateValidation();
    try {
      const formData = new FormData();
      Array.from(files).forEach((file) => formData.append("file", file));
      const uploadRes = await fetch(
        `http://localhost:3000/api/upload?jid=${encodeURIComponent(mainGroup.jid)}`,
        { method: "POST", body: formData }
      );
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) throw new Error(uploadData.error || `HTTP ${uploadRes.status}`);
      return Array.isArray(uploadData.files) ? uploadData.files : [];
    } finally {
      state.uploadingFiles = Math.max(0, state.uploadingFiles - files.length);
      updateValidation();
    }
  }

  function summarizeRequirementDescription(text) {
    const raw = typeof text === "string" ? text.trim() : "";
    if (!raw) return "待填写";
    const firstLine = raw.split(/\n+/).find((line) => line.trim()) || raw;
    return firstLine.length > 48 ? `${firstLine.slice(0, 48)}...` : firstLine;
  }

  function getRequirementDeliverables(reqName) {
    const req = getRequirements().find((item) => item.requirement_name === reqName);
    return Array.isArray(req?.deliverables) ? req.deliverables : [];
  }

  function getRequiredDeliverableFile() {
    const detail = getSelectedWorkflowType().entry_points_detail?.[state.entryPoint];
    return resolveRequiredDeliverableFile(detail);
  }

  function updateValidation() {
    const taskTitle = getTaskTitle();
    const requirementDescription = getRequirementDescription();
    const selectedRequirement = getSelectedRequirementName();
    const detail = getSelectedWorkflowType().entry_points_detail?.[state.entryPoint];
    const deliverableRequired = !!detail?.requires_deliverable;
    const requiredFile = getRequiredDeliverableFile();
    const deliverableFiles = getRequirementDeliverables(selectedRequirement);
    const deliverableOk = !deliverableRequired || deliverableFiles.includes(requiredFile);
    const missingRequiredFields = getMissingRequiredCreateFields();
    const missingRequiredField = missingRequiredFields[0];
    let validationTone = "info";

    if (!taskTitle) {
      reqHintEl.textContent = "请输入任务名称";
      validationTone = "warning";
    } else if (state.uploadingFiles > 0) {
      reqHintEl.textContent = `附件上传中（${state.uploadingFiles}）...`;
      validationTone = "info";
    } else if (missingRequiredField) {
      reqHintEl.textContent = `请填写${missingRequiredField.label || missingRequiredField.key}`;
      validationTone = "warning";
    } else if (deliverableRequired && !selectedRequirement) {
      reqHintEl.textContent = "请选择关联需求后再创建";
      validationTone = "warning";
    } else if (deliverableRequired) {
      reqHintEl.textContent = deliverableOk
        ? `已校验交付物文件：${requiredFile}`
        : `当前入口点要求存在 ${requiredFile}，所选需求暂不满足`;
      validationTone = deliverableOk ? "success" : "warning";
    } else {
      reqHintEl.textContent = "将使用当前名称创建新的工作流任务";
      validationTone = "success";
    }

    validationCardEl.dataset.state = validationTone;
    let summaryText = `将向 ${state.service || "--"} 发起 ${state.entryPoint || "--"} 流程`;
    if (!taskTitle) {
      summaryText = "请填写任务名称后再创建";
    } else if (state.uploadingFiles > 0) {
      summaryText = `等待 ${state.uploadingFiles} 个附件上传完成`;
    } else if (missingRequiredField) {
      summaryText = `请补充${missingRequiredField.label || missingRequiredField.key}`;
    } else if (deliverableRequired && !selectedRequirement) {
      summaryText = "请先选择关联需求";
    } else if (deliverableRequired && !deliverableOk) {
      summaryText = `缺少必需交付物 ${requiredFile}`;
    }
    footerStatusEl.textContent = summaryText;
    if (submitBtnLabelEl) {
      submitBtnLabelEl.textContent = state.uploadingFiles > 0 ? "上传中..." : "创建任务";
    }
    if (selectionSummaryEl) {
      const summaryTitle = getSelectedWorkflowType().name || getSelectedWorkflowType().type || "--";
      const summarySubtitle = `${state.service || "--"} · ${state.entryPoint || "--"}`;
      const visibleFields = getVisibleCreateFields();
      const hasRequirementDescriptionField = visibleFields.some((field) => ["requirement_description", "requirement_custom"].includes(field.key));
      const fileUploadFields = getFileUploadFields();
      const fileUploadSummary = getFileUploadSummary();
      const summaryItems = [
        { label: "流程", value: getSelectedWorkflowType().name || getSelectedWorkflowType().type || "--" },
        { label: "入口点", value: state.entryPoint || "--" },
        { label: "服务", value: state.service || "--" },
        { label: "任务名称", value: taskTitle || "待填写" },
        {
          label: "需求描述",
          value: requirementDescription
            ? summarizeRequirementDescription(requirementDescription)
            : (hasRequirementDescriptionField ? "待填写" : "--")
        },
        {
          label: "关联需求",
          value: selectedRequirement || "--"
        },
        {
          label: "附件",
          value: fileUploadFields.length > 0
            ? (fileUploadSummary.length > 0 ? fileUploadSummary.join("、") : "无")
            : "--"
        },
        { label: "交付物", value: deliverableRequired ? (deliverableOk ? `已满足 ${requiredFile}` : `缺少 ${requiredFile}`) : "当前入口无需交付物" }
      ];
      selectionSummaryEl.innerHTML = `
        <div class="workflow-wizard-confirm-card" data-state="${escapeAttribute(validationTone)}">
          <div class="workflow-wizard-confirm-hero">
            <div class="workflow-wizard-confirm-kicker">任务确认卡</div>
            <div class="workflow-wizard-confirm-title">${escapeHtml(summaryTitle)}</div>
            <div class="workflow-wizard-confirm-subtitle">${escapeHtml(summarySubtitle)}</div>
          </div>
          <div class="workflow-wizard-confirm-grid">
            ${summaryItems.map((item) => `
              <div class="workflow-wizard-selection-item">
                <span>${escapeHtml(item.label)}</span>
                <strong>${escapeHtml(item.value)}</strong>
              </div>
            `).join("")}
          </div>
        </div>
      `;
    }

    submitBtn.disabled =
      !taskTitle ||
      missingRequiredFields.length > 0 ||
      !state.entryPoint ||
      !state.service ||
      (deliverableRequired && !selectedRequirement) ||
      !deliverableOk ||
      state.uploadingFiles > 0;
  }

  function refreshWorkbenchCreateModal() {
    ensureCreateFormDefaults();
    if (titleInputEl) {
      titleInputEl.value = state.title || "";
      titleInputEl.oninput = () => {
        state.title = titleInputEl.value;
        updateValidation();
      };
    }
    typeSelectWrapEl.innerHTML = "";
    typeSelectWrapEl.className = "workflow-wizard-segmented-wrap";
    renderSingleOptions(
      typeSelectWrapEl,
      workflowTypes.map((item) => ({
        value: item.type,
        label: item.name || item.type,
        description: item.type !== item.name ? item.type : "",
      })),
      state.workflowType,
      (value) => {
        state.workflowType = value;
        state.entryPoint = getEntryPoints()[0] || "";
        refreshWorkbenchCreateModal();
      },
      "segmented"
    );

    const selectedType = getSelectedWorkflowType();
    const roleItems = Object.entries(selectedType.role_channels || {});
    const entryItems = Array.isArray(selectedType.entry_points) ? selectedType.entry_points : [];
    typeSummaryEl.innerHTML = `
      <div class="workflow-wizard-flow-summary">
        <div class="workflow-wizard-flow-title">${escapeHtml(selectedType.name || selectedType.type)}</div>
        <div class="workflow-wizard-flow-caption">选择不同流程后，会切换对应的入口点与补充字段，任务名称始终固定展示。</div>
        <div class="workflow-wizard-flow-group">
          <span class="workflow-wizard-flow-group-label">可用入口点</span>
          <div class="workflow-wizard-flow-pills">
            ${entryItems.length > 0
              ? entryItems.map((entry) => {
                  const detail = selectedType.entry_points_detail?.[entry];
                  return `<span class="workflow-wizard-flow-pill">${escapeHtml(entry)}${detail?.requires_deliverable ? " · 需交付物" : ""}</span>`;
                }).join("")
              : '<span class="workflow-wizard-empty">暂无入口点</span>'}
          </div>
        </div>
        <div class="workflow-wizard-flow-group">
          <span class="workflow-wizard-flow-group-label">流程角色</span>
          <div class="workflow-wizard-flow-pills">
            ${roleItems.length > 0
              ? roleItems.map(([role, channels]) => {
                  const webChannel = channels?.web || channels?.feishu || Object.values(channels || {})[0] || "--";
                  return `<span class="workflow-wizard-flow-pill"><strong>${escapeHtml(role)}</strong>${escapeHtml(webChannel)}</span>`;
                }).join("")
              : '<span class="workflow-wizard-empty">暂无角色配置</span>'}
          </div>
        </div>
      </div>
    `;

    const entryPoints = getEntryPoints();
    if (!state.entryPoint || !entryPoints.includes(state.entryPoint)) {
      state.entryPoint = entryPoints[0] || "";
    }
    renderSingleOptions(
      entryOptionsEl,
      entryPoints.map((entry) => ({
        value: entry,
        label: getSelectedWorkflowType().entry_points_detail?.[entry]?.requires_deliverable ? `${entry} (需要交付物)` : entry,
        description: getSelectedWorkflowType().entry_points_detail?.[entry]?.requires_deliverable ? "需要交付物" : "可直接发起",
      })),
      state.entryPoint,
      (value) => {
        state.entryPoint = value;
        refreshWorkbenchCreateModal();
      },
      "segmented"
    );

    renderSingleOptions(
      serviceOptionsEl,
      services.map((service) => ({ value: service, label: service, description: "目标服务" })),
      state.service,
      (value) => {
        state.service = value;
        refreshWorkbenchCreateModal();
      },
      "segmented"
    );

    const reqs = getRequirements();
    dynamicFieldsEl.innerHTML = "";
    const visibleFields = getVisibleCreateFields();
    visibleFields.forEach((field, idx) => {
      const fieldLabel =
        field.key === "requirement_preset" || field.key === "deliverable_source"
          ? "关联需求"
          : field.label;
      const fieldHelp =
        field.key === "requirement_preset" || field.key === "deliverable_source"
          ? "选择已有需求目录，用于定位交付物与历史文档。"
          : field.helper_text;
      const section = document.createElement("div");
      section.className = "workflow-wizard-section";
      const label = document.createElement("div");
      label.className = "workflow-wizard-label";
      label.textContent = `${idx + 5}. ${fieldLabel}`;
      section.appendChild(label);

      const wrap = document.createElement("div");
      wrap.className = "workflow-wizard-subsection";
      section.appendChild(wrap);

      if (field.type === "text") {
        const input = document.createElement("input");
        input.className = "workflow-wizard-input";
        input.placeholder = field.placeholder || "";
        input.value = state.formValues[field.key] || "";
        input.addEventListener("input", () => {
          setFieldValue(field.key, input.value);
          updateValidation();
        });
        wrap.appendChild(input);
      } else if (field.type === "textarea") {
        const textarea = document.createElement("textarea");
        textarea.className = "workflow-wizard-input";
        textarea.placeholder = field.placeholder || "";
        textarea.rows = 5;
        textarea.value = state.formValues[field.key] || "";
        textarea.addEventListener("input", () => {
          setFieldValue(field.key, textarea.value);
          updateValidation();
        });
        wrap.appendChild(textarea);
      } else if (field.type === "choice") {
        const opts = document.createElement("div");
        opts.className = "workflow-wizard-options compact";
        wrap.appendChild(opts);
        renderSingleOptions(
          opts,
          Array.isArray(field.options) ? field.options : [],
          state.formValues[field.key],
          (value) => {
            setFieldValue(field.key, value);
            refreshWorkbenchCreateModal();
          }
        );
      } else if (field.type === "requirement_select") {
        if (!state.formValues[field.key] && reqs.length > 0) {
          setFieldValue(field.key, reqs[0].requirement_name);
        }
        const searchKey = `${field.key}__search`;
        if (field.searchable) {
          const search = document.createElement("input");
          search.className = "workflow-wizard-input";
          search.placeholder = "搜索已有需求";
          search.value = state.fieldSearch[searchKey] || "";
          search.addEventListener("input", () => {
            state.fieldSearch[searchKey] = search.value;
            refreshWorkbenchCreateModal();
          });
          wrap.appendChild(search);
        }
        const optionsWrap = document.createElement("div");
        optionsWrap.className = "workflow-wizard-options";
        if (field.searchable) {
          optionsWrap.style.marginTop = "8px";
        }
        wrap.appendChild(optionsWrap);
        const keyword = (state.fieldSearch[searchKey] || "").trim();
        const filteredReqs = reqs.filter((item) => !keyword || item.requirement_name.includes(keyword));
        renderSingleOptions(
          optionsWrap,
          filteredReqs.map((item) => ({ value: item.requirement_name, label: item.requirement_name })),
          state.formValues[field.key],
          (value) => {
            setFieldValue(field.key, value);
            refreshWorkbenchCreateModal();
          }
        );
      } else if (field.type === "file_uploads") {
        const files = Array.isArray(state.formValues[field.key]) ? state.formValues[field.key] : [];
        const toolbar = document.createElement("div");
        toolbar.className = "workflow-wizard-file-toolbar";
        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "workflow-wizard-upload-icon-btn";
        addBtn.title = state.uploadingFiles > 0 ? "附件上传中" : "上传附件";
        addBtn.setAttribute("aria-label", state.uploadingFiles > 0 ? "附件上传中" : "上传附件");
        addBtn.innerHTML = state.uploadingFiles > 0
          ? '<span class="workflow-wizard-upload-spinner" aria-hidden="true"></span>'
          : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V7"/><path d="M8.5 10.5 12 7l3.5 3.5"/><path d="M5 17.5v.5A2 2 0 0 0 7 20h10a2 2 0 0 0 2-2v-.5"/><path d="M8 20h8"/></svg>';
        addBtn.disabled = state.uploadingFiles > 0;
        addBtn.addEventListener("click", () => {
          const picker = document.createElement("input");
          picker.type = "file";
          picker.multiple = true;
          picker.onchange = async () => {
            const selectedFiles = picker.files ? Array.from(picker.files) : [];
            if (selectedFiles.length === 0) return;
            try {
              const uploadedFiles = await uploadWorkbenchCreateFiles(selectedFiles);
              setFieldValue(
                field.key,
                files.concat(
                  uploadedFiles.map((item) => ({
                    name: item.name,
                    path: item.hostPath,
                  }))
                )
              );
              refreshWorkbenchCreateModal();
            } catch (err) {
              console.error("Failed to upload workbench create files:", err);
              alert(err.message || "上传附件失败");
            }
          };
          picker.click();
        });
        toolbar.appendChild(addBtn);
        wrap.appendChild(toolbar);

        const list = document.createElement("div");
        list.className = "workflow-wizard-file-list";
        if (files.length === 0) {
          list.innerHTML = `
            <div class="workflow-wizard-file-empty">
              <div class="workflow-wizard-file-empty-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h4"/></svg>
              </div>
              <div class="workflow-wizard-file-empty-copy">暂未上传附件</div>
            </div>
          `;
        } else {
          list.innerHTML = files.map((item, fileIdx) => `
            <div class="workflow-wizard-file-card">
              <div class="workflow-wizard-file-card-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h4"/></svg>
              </div>
              <div class="workflow-wizard-file-card-body">
                <span>${escapeHtml(item.name || `附件 ${fileIdx + 1}`)}</span>
                <strong title="${escapeAttribute(item.path || "--")}">${escapeHtml(item.path || "--")}</strong>
              </div>
              <button
                type="button"
                class="workflow-wizard-file-remove-btn"
                data-file-remove-index="${fileIdx}"
                title="移除附件"
                aria-label="移除附件 ${escapeAttribute(item.name || `附件 ${fileIdx + 1}`)}"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>
              </button>
            </div>
          `).join("");
        }
        wrap.appendChild(list);

        list.querySelectorAll("[data-file-remove-index]").forEach((btn) => {
          btn.addEventListener("click", () => {
            const idx = Number(btn.getAttribute("data-file-remove-index"));
            if (Number.isNaN(idx)) return;
            const nextFiles = files.filter((_, idx2) => idx2 !== idx);
            setFieldValue(field.key, nextFiles);
            refreshWorkbenchCreateModal();
          });
        });
      }

      if (fieldHelp) {
        const helper = document.createElement("div");
        helper.className = "workflow-wizard-field-help";
        helper.textContent = fieldHelp;
        section.appendChild(helper);
      }

      dynamicFieldsEl.appendChild(section);
    });

    updateValidation();
  }

  overlay.querySelector("#workbench-create-close").addEventListener("click", closeWorkbenchCreateModal);
  overlay.querySelector("#wb-cancel-btn").addEventListener("click", closeWorkbenchCreateModal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeWorkbenchCreateModal();
  });
  submitBtn.addEventListener("click", async () => {
    const title = getTaskTitle();
    const requirementDescription = getRequirementDescription();
    const selectedRequirement = getSelectedRequirementName();
    const detail = getSelectedWorkflowType().entry_points_detail?.[state.entryPoint];
    const deliverableRequired = !!detail?.requires_deliverable;
    const requiredFile = getRequiredDeliverableFile();
    const deliverableFiles = getRequirementDeliverables(selectedRequirement);
    const missingRequiredFields = getMissingRequiredCreateFields();
    if (!title) return;
    if (missingRequiredFields.length > 0) return;
    if (deliverableRequired && !selectedRequirement) return;
    if (deliverableRequired && !deliverableFiles.includes(requiredFile)) {
      alert(`当前入口点要求交付物文件 ${requiredFile}，所选需求不满足。`);
      return;
    }
    const createFormContext = buildCreateFormContext();

    try {
      const res = await apiFetch("/api/workbench/task", {
        method: "POST",
        body: JSON.stringify({
          title,
          service: state.service,
          source_jid: mainGroup.jid,
          start_from: state.entryPoint,
          workflow_type: state.workflowType,
          context: {
            ...createFormContext,
            deliverable: deliverableRequired ? selectedRequirement : createFormContext.deliverable,
            requirement_description: requirementDescription || createFormContext.requirement_description,
            requirement_preset: selectedRequirement || void 0,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      closeWorkbenchCreateModal();
      const createdDetail = data.detail && data.detail.task ? data.detail : null;
      const selectedTaskId = data.task_id || (createdDetail && createdDetail.task && createdDetail.task.id) || data.workflow_id || "";

      if (createdDetail) {
        currentWorkbenchTaskId = createdDetail.task.id;
        currentWorkbenchDetail = createdDetail;
        const taskIdx = workbenchTasks.findIndex((item) => item.id === createdDetail.task.id);
        if (taskIdx >= 0) {
          workbenchTasks[taskIdx] = { ...workbenchTasks[taskIdx], ...createdDetail.task };
        } else {
          workbenchTasks.unshift(createdDetail.task);
        }
        renderWorkbenchTaskList();
        renderWorkbenchTaskDetail(createdDetail);
      }

      await loadWorkbenchTasks(selectedTaskId, false, !createdDetail);
      if (selectedTaskId) {
        scheduleWorkbenchTaskDetailReload(selectedTaskId, createdDetail ? 400 : 0);
      }
    } catch (err) {
      console.error("Failed to create workbench task:", err);
      alert(err.message || "任务创建失败");
    }
  });

  refreshWorkbenchCreateModal();
}

async function loadMessages() {
  if (!currentGroupJid) return;
  try {
    const res = await apiFetch(
      `/api/messages?jid=${encodeURIComponent(currentGroupJid)}&since=0&limit=${INITIAL_MESSAGE_LIMIT}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    messages = data.messages.map(m => ({
      ...m,
      _filePath: m.file_path || undefined,
      _fileUrl: m.file_url || undefined
    }));
    hasMoreHistory = messages.length >= INITIAL_MESSAGE_LIMIT;
    renderMessages();
  } catch (err) {
    console.error("Failed to load messages:", err);
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
      `/api/messages?jid=${encodeURIComponent(currentGroupJid)}&before=${oldestTs}&limit=50`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.messages.length === 0) {
      hasMoreHistory = false;
      return;
    }
    // Prepend older messages
    const olderMessages = data.messages.map(m => ({
      ...m,
      _filePath: m.file_path || undefined,
      _fileUrl: m.file_url || undefined
    }));
    messages = [...olderMessages, ...messages];
    // Rebuild DOM and restore scroll position
    renderMessages();
    const newScrollHeight = messagesEl.scrollHeight;
    messagesEl.scrollTop = newScrollHeight - prevScrollHeight;
  } catch (err) {
    console.error("Failed to load history:", err);
  } finally {
    loadingHistory = false;
  }
}

function connectWS() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  setConnectionStatus("connecting");
  const wsUrl = "ws://localhost:3000/ws";
  ws = new WebSocket(wsUrl);
  ws.onopen = () => {
    setConnectionStatus("connected");
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (currentGroupJid) {
      sendWs({ type: "select_group", chatJid: currentGroupJid });
    }
  };
  ws.onclose = () => {
    setConnectionStatus("disconnected");
    ws = null;
    reconnectTimer = setTimeout(connectWS, 3e3);
  };
  ws.onerror = (err) => {
    console.error("WS error:", err);
    setConnectionStatus("disconnected");
  };
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      handleWsMessage(msg);
    } catch {
      console.error("Failed to parse WS message:", e.data);
    }
  };
}
function sendWs(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function isAppForeground() {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "visible" && document.hasFocus();
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

function handleWorkbenchRealtimeEvent(event) {
  if (!event) return;
  applyWorkbenchRealtimeEvent(event);
}

function applyWorkbenchRealtimeEvent(event) {
  if (!event) return;
  const payload = event.payload || {};
  maybeNotifyWorkbenchPendingFromRealtimeEvent(event);
  const taskIdx = workbenchTasks.findIndex((item) => item.id === event.taskId);

  if (taskIdx >= 0) {
    const existing = workbenchTasks[taskIdx];
    if (event.type === "task_created") {
      workbenchTasks[taskIdx] = { ...existing, ...payload };
    } else if (event.type === "task_updated") {
      workbenchTasks[taskIdx] = {
        ...existing,
        workflow_status: payload.workflowStatus || existing.workflow_status,
        workflow_status_label:
          payload.workflowStatusLabel || existing.workflow_status_label,
        task_state: typeof payload.taskState === "string" ? payload.taskState : existing.task_state,
        workflow_stage: payload.workflowStage || existing.workflow_stage,
        workflow_stage_label:
          payload.workflowStageLabel || existing.workflow_stage_label,
        context: mergeWorkbenchTaskContext(existing, payload.context),
        updated_at: payload.updatedAt || existing.updated_at,
        pending_approval: typeof payload.pendingApproval === "boolean" ? payload.pendingApproval : existing.pending_approval,
        pending_action_count:
          typeof payload.pendingActionCount === "number" ? payload.pendingActionCount : existing.pending_action_count,
      };
    } else if (event.type === "action_item_updated") {
      workbenchTasks[taskIdx] = {
        ...existing,
        pending_approval: typeof payload.pendingApproval === "boolean" ? payload.pendingApproval : existing.pending_approval,
        pending_action_count:
          typeof payload.pendingActionCount === "number" ? payload.pendingActionCount : existing.pending_action_count,
      };
    }
    workbenchTasks = sortWorkbenchTaskItems(workbenchTasks);
    renderWorkbenchTaskList();
  } else if (event.type === "task_created" && payload.id) {
    workbenchTasks.push({
      id: event.taskId,
      title: payload.title || "新任务",
      service: payload.service || "",
      workflow_type: payload.workflowType || "",
      workflow_status: payload.workflowStatus || "created",
      workflow_status_label: payload.workflowStatusLabel || payload.workflowStatus || "created",
      task_state: typeof payload.taskState === "string" ? payload.taskState : "running",
      workflow_stage: payload.workflowStage || payload.workflowStatus || "created",
      workflow_stage_label:
        payload.workflowStageLabel || payload.workflowStage || payload.workflowStatus || "created",
      context: mergeWorkbenchTaskContext(null, payload.context),
      round: 0,
      source_jid: payload.sourceJid || "",
      created_at: getPayloadTimestamp(payload),
      updated_at: getPayloadTimestamp(payload),
      pending_approval: Boolean(payload.pendingApproval),
      pending_action_count: typeof payload.pendingActionCount === "number" ? payload.pendingActionCount : 0,
      active_delegation_id: "",
    });
    workbenchTasks = sortWorkbenchTaskItems(workbenchTasks);
    renderWorkbenchTaskList();
  }

  if (!currentWorkbenchDetail || currentWorkbenchTaskId !== event.taskId) return;

  if (event.type === "task_updated") {
    currentWorkbenchDetail.task = {
      ...currentWorkbenchDetail.task,
      workflow_status:
        payload.workflowStatus || currentWorkbenchDetail.task.workflow_status,
      workflow_status_label:
        payload.workflowStatusLabel || currentWorkbenchDetail.task.workflow_status_label,
      task_state:
        typeof payload.taskState === "string" ? payload.taskState : currentWorkbenchDetail.task.task_state,
      workflow_stage:
        payload.workflowStage || currentWorkbenchDetail.task.workflow_stage,
      workflow_stage_label:
        payload.workflowStageLabel || currentWorkbenchDetail.task.workflow_stage_label,
      context: mergeWorkbenchTaskContext(currentWorkbenchDetail.task, payload.context),
      updated_at: payload.updatedAt || currentWorkbenchDetail.task.updated_at,
      pending_approval:
        typeof payload.pendingApproval === "boolean" ? payload.pendingApproval : currentWorkbenchDetail.task.pending_approval,
      pending_action_count:
        typeof payload.pendingActionCount === "number" ? payload.pendingActionCount : currentWorkbenchDetail.task.pending_action_count,
    };
    renderWorkbenchTaskDetail(currentWorkbenchDetail);
  } else if (event.type === "subtask_updated") {
    const subtask = currentWorkbenchDetail.subtasks.find((item) => item.id === payload.id);
    if (subtask) {
      if (payload.status && ["completed", "current", "pending", "failed", "cancelled"].includes(payload.status)) {
        subtask.status = payload.status;
      }
      if (typeof payload.manuallySkipped === "boolean") {
        subtask.manually_skipped = payload.manuallySkipped;
      }
      if (payload.groupFolder) subtask.target_folder = payload.groupFolder;
      renderWorkbenchSubtasks(currentWorkbenchDetail.subtasks);
    } else {
      scheduleWorkbenchTaskDetailReload(currentWorkbenchTaskId);
    }
  } else if (event.type === "event_created") {
    const nextId = payload.id || `rt-${Date.now()}`;
    const existingIdx = currentWorkbenchDetail.timeline.findIndex((item) => item.id === nextId);
    const nextItem = {
      id: nextId,
      type: payload.status === "manual_skip" ? "manual" : "delegation",
      title: payload.title || "任务更新",
      body: payload.body || "",
      created_at: getPayloadTimestamp(payload),
      status: payload.status || ""
    };
    if (existingIdx >= 0) {
      currentWorkbenchDetail.timeline[existingIdx] = nextItem;
    } else {
      currentWorkbenchDetail.timeline.push(nextItem);
    }
    currentWorkbenchDetail.timeline = sortWorkbenchTimeline(currentWorkbenchDetail.timeline);
    renderWorkbenchTimeline(currentWorkbenchDetail.timeline);
  } else if (event.type === "artifact_created") {
    const exists = currentWorkbenchDetail.artifacts.some((item) => item.id === payload.id);
    if (!exists) {
      currentWorkbenchDetail.artifacts.push({
        id: payload.id,
        title: payload.title || "新产出",
        artifact_type: payload.artifactType || "artifact",
        path: payload.path || "",
        absolute_path: payload.absolutePath || "",
        exists: true,
        created_at: getPayloadTimestamp(payload),
      });
      currentWorkbenchDetail.artifacts = sortWorkbenchItemsByCreatedAt(currentWorkbenchDetail.artifacts);
      renderWorkbenchArtifacts(currentWorkbenchDetail.artifacts);
    }
  } else if (event.type === "action_item_updated") {
    if (!applyWorkbenchActionItemRealtimeUpdate(payload)) {
      scheduleWorkbenchTaskDetailReload(currentWorkbenchTaskId);
    }
  } else if (event.type === "comment_created") {
    currentWorkbenchDetail.comments.push({
      id: payload.id,
      author: payload.author || "Web User",
      content: payload.content || "",
      created_at: getPayloadTimestamp(payload),
    });
    currentWorkbenchDetail.comments = sortWorkbenchItemsByCreatedAt(currentWorkbenchDetail.comments);
    renderWorkbenchComments(currentWorkbenchDetail.comments);
  } else if (event.type === "asset_created") {
    currentWorkbenchDetail.assets.push({
      id: payload.id,
      title: payload.title || "新资产",
      asset_type: payload.assetType || "asset",
      path: payload.path || null,
      url: payload.url || null,
      note: payload.note || null,
      created_at: getPayloadTimestamp(payload),
    });
    currentWorkbenchDetail.assets = sortWorkbenchItemsByCreatedAt(currentWorkbenchDetail.assets);
    renderWorkbenchAssets(currentWorkbenchDetail.assets);
  }
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case "connected":
      console.log("WS connected:", msg.message);
      break;
    case "groups":
      groups = msg.groups || [];
      renderGroups();
      syncQuickChatTarget();
      if (activePrimaryNavKey === "trace-monitor") {
        renderTraceMonitorList();
        if (currentTraceRunRecord) {
          renderTraceRunDetail();
        }
      }
      break;
    case "message": {
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
        model: msg.model || null
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
        unreadCounts[incoming.chat_jid] = (unreadCounts[incoming.chat_jid] || 0) + 1;
        renderGroups();
      }
      if (!incoming.is_from_me) {
        notifyAgent(incoming);
      }
      break;
    }
    case "card": {
      const cardMsg = {
        id: msg.cardId,
        chat_jid: msg.chatJid,
        sender: "assistant",
        sender_name: "Assistant",
        content: JSON.stringify({ _type: "card", card: msg.card }),
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
        unreadCounts[cardMsg.chat_jid] = (unreadCounts[cardMsg.chat_jid] || 0) + 1;
        renderGroups();
      }
      notifyAgent(cardMsg);
      break;
    }
    case "file": {
      const content = msg.caption || `文件: ${msg.filePath.split("/").pop()}`;
      const fileMsg = {
        id: msg.id || `file_${msg.timestamp}_${Math.random().toString(36).slice(2, 8)}`,
        chat_jid: msg.chatJid,
        sender: msg.sender || "assistant",
        sender_name: msg.sender || "Assistant",
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
        unreadCounts[fileMsg.chat_jid] = (unreadCounts[fileMsg.chat_jid] || 0) + 1;
        renderGroups();
      }
      notifyAgent(fileMsg);
      break;
    }
    case "typing":
      typingIndicator.className = msg.isTyping ? "" : "hidden";
      break;
    case "agent_status":
      if (agentStatusPanel.classList.contains("open")) {
        renderAgentStatus(msg.agents || []);
      }
      break;
    case "agent_query_trace":
      updateAgentRunTraces(msg.queries || []);
      traceMonitorActiveRuns = (msg.queries || [])
        .map((run) => normalizeTraceRun(run, "active"))
        .filter(Boolean);
      if (agentStatusPanel.classList.contains("open")) {
        renderAgentStatus(agentStatusData);
      }
      if (activePrimaryNavKey === "trace-monitor") {
        if (activeTraceMonitorScope === "active") {
          renderTraceMonitorList();
        }
        scheduleTraceDetailReload();
      }
      break;
    case "workbench_event":
      handleWorkbenchRealtimeEvent(msg.event);
      break;
    case "error":
      console.error("WS error from server:", msg.message);
      showError(`Server error: ${msg.message}`);
      break;
  }
}
function notifyAgent(msg) {
  const group = groups.find((g) => g.jid === msg.chat_jid);
  const title = `${group?.name || "Support Group Agent"}`;
  const body = `${msg.sender_name}: ${msg.content.slice(0, 100)}`;
  if (typeof window !== "undefined" && window.nanoclawApp) {
    window.nanoclawApp.notify(title, body, { chatJid: msg.chat_jid });
    return;
  }

  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") {
    ensureBrowserNotificationPermission();
    return;
  }

  const notification = new Notification(title, {
    body,
    tag: `nanoclaw-${msg.chat_jid}`,
  });
  notification.onclick = () => {
    window.focus();
    openAgentGroupFromNotification(msg.chat_jid, "browser");
  };
}

function openAgentGroupFromNotification(chatJid, source) {
  if (typeof chatJid !== "string" || !chatJid) return;
  setPrimaryNav("agent-groups");
  if (chatJid === currentGroupJid) {
    clearUnreadForGroup(chatJid);
    return;
  }
  selectGroup(chatJid).catch((err) => {
    console.error(`Failed to switch group from ${source} notification click:`, err);
  });
}

function ensureBrowserNotificationPermission() {
  if (typeof window === "undefined" || window.nanoclawApp) return;
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "default") return;
  if (browserNotificationPermissionRequested) return;

  browserNotificationPermissionRequested = true;
  Notification.requestPermission().catch((err) => {
    console.error("Failed to request browser notification permission:", err);
  });
}

function bindNotificationPermissionPrimer() {
  if (typeof window === "undefined" || window.nanoclawApp) return;
  const requestOnce = () => ensureBrowserNotificationPermission();
  window.addEventListener("pointerdown", requestOnce, { once: true, capture: true });
  window.addEventListener("keydown", requestOnce, { once: true, capture: true });
}

function bindNotificationClickHandler() {
  if (typeof window === "undefined" || !window.nanoclawApp?.onNotificationClick) return;
  window.nanoclawApp.onNotificationClick(({ chatJid, taskId }) => {
    if (typeof taskId === "string" && taskId) {
      setPrimaryNav("workbench");
      loadWorkbenchTaskDetail(taskId).catch((err) => {
        console.error("Failed to switch task from notification click:", err);
      });
      return;
    }
    openAgentGroupFromNotification(chatJid, "native");
  });
}
async function selectGroup(jid) {
  if (multiSelectMode) exitMultiSelect();
  // Clear staged files when switching groups
  pendingFiles = [];
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
  sendWs({ type: "select_group", chatJid: jid });
}

function appendOptimisticMessage(chatJid, content, replyToId = null) {
  const userMsg = {
    id: `opt_${Date.now()}`,
    chat_jid: chatJid,
    sender: "me",
    sender_name: "You",
    content,
    timestamp: Date.now().toString(),
    is_from_me: true,
    is_bot_message: false,
    reply_to_id: replyToId
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
  if (!trimmed && (!options.pendingFiles || options.pendingFiles.length === 0)) return false;
  if (!chatJid) return false;

  // Upload pending files first and prepend their container paths
  let filePrefix = "";
  const stagedFiles = Array.isArray(options.pendingFiles) ? options.pendingFiles : pendingFiles;
  if (stagedFiles.length > 0) {
    try {
      filePrefix = await uploadPendingFiles();
    } catch (err) {
      showError(`附件上传失败: ${err}`);
      return false;
    }
  }

  const fullContent = filePrefix + trimmed;
  const payload = {
    type: "message",
    chatJid,
    content: fullContent,
  };

  // Include reply reference if set
  const replyToId = options.replyToId === undefined ? (replyToMsg ? replyToMsg.id : null) : options.replyToId;
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
  messageInput.value = "";
  autoResizeInput();
  clearReplyTo();
  hideCommandPalette();
  hideMentionPicker(false);
}

async function sendQuickChatMessage() {
  if (!quickChatInput) return;
  const mainGroup = getMainGroup();
  if (!mainGroup) {
    showToast("未找到主群，无法发送", 2200);
    return;
  }
  const sent = await sendMessageToChat(mainGroup.jid, quickChatInput.value, {
    optimistic: mainGroup.jid === currentGroupJid,
    replyToId: null,
  });
  if (!sent) return;
  quickChatInput.value = "";
  quickChatDraft = "";
  showToast(`已发送到主群 ${mainGroup.name}`, 1800);
  closeQuickChat();
}

// --- Reply handling ---
function setReplyTo(msg) {
  replyToMsg = msg;
  replyPreviewContent.textContent = `${msg.sender_name || msg.sender}: ${msg.content.slice(0, 80)}`;
  replyPreview.classList.add("visible");
  messageInput.focus();
}

function clearReplyTo() {
  replyToMsg = null;
  replyPreview.classList.remove("visible");
  replyPreviewContent.textContent = "";
}

// --- Command palette ---
function ensureCommandPaletteElements() {
  if (!commandPalette || commandSearchInput || commandOptionsEl) return;

  const searchWrap = document.createElement("div");
  searchWrap.className = "command-search-wrap";
  commandSearchInput = document.createElement("input");
  commandSearchInput.id = "command-search-input";
  commandSearchInput.type = "text";
  commandSearchInput.placeholder = "搜索命令";
  searchWrap.appendChild(commandSearchInput);
  commandPalette.appendChild(searchWrap);

  commandOptionsEl = document.createElement("div");
  commandOptionsEl.id = "command-options";
  commandPalette.appendChild(commandOptionsEl);

  commandSearchInput.addEventListener("input", () => {
    cmdPaletteIndex = 0;
    renderCommandOptions();
  });

  commandSearchInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      navigateCommandPalette(-1);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      navigateCommandPalette(1);
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      if (commandCandidates.length > 0) {
        e.preventDefault();
        executeCommand(commandCandidates[Math.max(cmdPaletteIndex, 0)]);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      hideCommandPalette();
    }
  });
}

function getCommandCandidates(query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return commands.slice();
  return commands.filter((c) => fuzzyMatch(c.name.replace(/^\//, ""), q) || fuzzyMatch(c.desc, q));
}

function renderCommandOptions() {
  if (!commandOptionsEl || !commandSearchInput) return;
  const query = commandSearchInput.value || "";
  commandCandidates = getCommandCandidates(query);
  commandOptionsEl.innerHTML = "";

  if (commandCandidates.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mention-empty";
    empty.textContent = "没有匹配命令";
    commandOptionsEl.appendChild(empty);
    cmdPaletteIndex = -1;
    return;
  }

  if (cmdPaletteIndex < 0 || cmdPaletteIndex >= commandCandidates.length) {
    cmdPaletteIndex = 0;
  }

  commandCandidates.forEach((cmd, i) => {
    const item = document.createElement("div");
    item.className = `cmd-item${i === cmdPaletteIndex ? " active" : ""}`;
    item.innerHTML = `<span class="cmd-item-name">${escapeHtml(cmd.name)}</span><span class="cmd-item-desc">${escapeHtml(cmd.desc)}</span>`;
    item.addEventListener("click", () => executeCommand(cmd));
    commandOptionsEl.appendChild(item);
  });
}

async function executeCommand(cmd) {
  hideCommandPalette(false);
  if (!cmd) return;
  messageInput.value = cmd.name + " ";
  messageInput.focus();
  autoResizeInput();
}

function showCommandPalette(filter) {
  if (mentionPickerVisible) hideMentionPicker(false);
  if (!commandPalette) return;
  ensureCommandPaletteElements();
  commandInsertPos = messageInput.selectionStart;
  commandPickerVisible = true;
  commandPalette.classList.add("visible");
  cmdPaletteIndex = 0;
  const initial = (filter || "").replace(/^\//, "");
  if (commandSearchInput) commandSearchInput.value = initial;
  renderCommandOptions();
  commandSearchInput?.focus();
}

function hideCommandPalette(restoreFocus = true) {
  if (!commandPalette) return;
  commandPickerVisible = false;
  commandPalette.classList.remove("visible");
  cmdPaletteIndex = -1;
  commandCandidates = [];
  commandInsertPos = null;
  if (restoreFocus) messageInput.focus();
}

function loadWorkflowCreateOptions(forceReload = false) {
  if (!forceReload && workflowCreateOptionsCache) {
    return Promise.resolve(workflowCreateOptionsCache);
  }
  if (!forceReload && workflowCreateOptionsLoading) {
    return workflowCreateOptionsLoading;
  }
  workflowCreateOptionsLoading = apiFetch("/api/workflow/create-options")
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((data) => {
      workflowCreateOptionsCache = data;
      return data;
    })
    .finally(() => {
      workflowCreateOptionsLoading = null;
    });
  return workflowCreateOptionsLoading;
}

function resolveRequiredDeliverableFile(detail) {
  if (!detail?.requires_deliverable) return "";
  if (typeof detail.required_deliverable_file === "string" && detail.required_deliverable_file.trim()) {
    return detail.required_deliverable_file.trim();
  }
  if (detail.deliverable_role === "planner") return "plan.md";
  return `${detail.deliverable_role || "dev"}.md`;
}

function invalidateWorkflowCreateOptionsCache() {
  workflowCreateOptionsCache = null;
}

function warmWorkflowCreateOptions(forceReload = false) {
  if (forceReload) {
    invalidateWorkflowCreateOptionsCache();
  }
  loadWorkflowCreateOptions(forceReload).catch((err) => {
    console.error("Failed to prefetch task create options:", err);
  });
}

function renderSingleOptions(container, options, selected, onPick, variant = "") {
  container.innerHTML = "";
  if (!Array.isArray(options) || options.length === 0) {
    const empty = document.createElement("div");
    empty.className = "workflow-wizard-empty";
    empty.textContent = "暂无可选项";
    container.appendChild(empty);
    return;
  }
  if (variant === "segmented") {
    container.classList.add("workflow-wizard-segmented");
  } else {
    container.classList.remove("workflow-wizard-segmented");
  }
  options.forEach((opt) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "workflow-wizard-option" + (selected === opt.value ? " selected" : "") + (variant === "segmented" ? " workflow-wizard-option-segmented" : "");
    if (variant === "segmented") {
      btn.innerHTML = `
        <span class="workflow-wizard-option-title">${escapeHtml(opt.label || opt.value || "")}</span>
        ${opt.description ? `<span class="workflow-wizard-option-desc">${escapeHtml(opt.description)}</span>` : ""}
      `;
    } else {
      btn.textContent = opt.label;
    }
    btn.addEventListener("click", () => onPick(opt.value));
    container.appendChild(btn);
  });
}

async function openWorkflowDefinitionCreateFormPreview() {
  const selectedVersion = getSelectedWorkflowDefinitionVersion();
  if (!selectedVersion) return;

  let services = ["demo-service"];
  let requirementsByService = {};
  try {
    const optionsData = await loadWorkflowCreateOptions();
    if (Array.isArray(optionsData.services) && optionsData.services.length > 0) {
      services = optionsData.services;
    }
    requirementsByService = optionsData.requirements_by_service || {};
  } catch (err) {
    console.warn("Failed to load create form preview options:", err);
  }

  const existing = document.getElementById("workflow-definition-create-form-preview-overlay");
  if (existing) existing.remove();

  const roleChannels = Object.fromEntries(
    Object.entries(selectedVersion.roles || {}).map(([role, rc]) => [role, rc.channels || {}]),
  );
  const workflowType = {
    type: selectedVersion.key || currentWorkflowDefinitionKey || "preview",
    name: selectedVersion.name || selectedVersion.key || "预览流程",
    entry_points: Object.keys(selectedVersion.entry_points || {}),
    entry_points_detail: Object.fromEntries(
      Object.entries(selectedVersion.entry_points || {}).map(([name, ep]) => [
        name,
        {
          requires_deliverable: !!ep?.requires_deliverable,
          deliverable_role: ep?.deliverable_role,
          required_deliverable_file: resolveRequiredDeliverableFile(ep),
        },
      ]),
    ),
    role_channels: roleChannels,
    create_form: cloneJson(selectedVersion.create_form || { fields: [] }),
  };

  const state = {
    title: "",
    service: services[0] || "demo-service",
    entryPoint: workflowType.entry_points[0] || "",
    fieldSearch: {},
    formValues: {},
  };

  const overlay = document.createElement("div");
  overlay.id = "workflow-definition-create-form-preview-overlay";
  overlay.className = "workflow-wizard-overlay";
  overlay.innerHTML = `
    <div class="workflow-wizard-modal workflow-definition-create-preview-modal">
      <div class="workflow-wizard-header">
        <div>
          <div class="workflow-wizard-title">创建任务表单预览</div>
          <div class="workflow-definition-panel-note">点击按钮时才生成，基于当前选中的流程定义实时渲染。</div>
        </div>
        <button type="button" class="icon-btn" id="workflow-definition-create-form-preview-close" title="关闭">×</button>
      </div>
      <div class="workflow-wizard-body">
        <div class="workflow-wizard-section">
          <div class="workflow-wizard-label">任务名称</div>
          <div class="workflow-wizard-subsection">
            <input id="workflow-definition-create-preview-title" class="workflow-wizard-input" type="text" placeholder="输入任务名称" />
          </div>
        </div>
        <div class="workflow-wizard-section">
          <div class="workflow-wizard-label">流程类型</div>
          <div class="workflow-wizard-flow-summary">
            <div class="workflow-wizard-flow-title">${escapeHtml(workflowType.name)}</div>
            <div class="workflow-wizard-flow-caption">这是当前流程定义对应的创建任务表单实时预览，不会真正提交任务。</div>
          </div>
        </div>
        <div class="workflow-wizard-section">
          <div class="workflow-wizard-label">入口点</div>
          <div id="workflow-definition-create-preview-entry-points" class="workflow-wizard-options"></div>
        </div>
        <div class="workflow-wizard-section">
          <div class="workflow-wizard-label">服务名称</div>
          <div id="workflow-definition-create-preview-services" class="workflow-wizard-options"></div>
        </div>
        <div id="workflow-definition-create-preview-fields"></div>
        <div class="workflow-wizard-section">
          <div class="workflow-wizard-label">校验提示</div>
          <div id="workflow-definition-create-preview-hint" class="workflow-wizard-hint"></div>
        </div>
      </div>
      <div class="workflow-wizard-footer">
        <button type="button" id="workflow-definition-create-form-preview-cancel" class="btn-ghost">关闭</button>
        <button type="button" class="btn-primary" disabled>仅预览，不提交</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const entryOptionsEl = overlay.querySelector("#workflow-definition-create-preview-entry-points");
  const serviceOptionsEl = overlay.querySelector("#workflow-definition-create-preview-services");
  const fieldsEl = overlay.querySelector("#workflow-definition-create-preview-fields");
  const hintEl = overlay.querySelector("#workflow-definition-create-preview-hint");
  const titleInputEl = overlay.querySelector("#workflow-definition-create-preview-title");

  function closePreview() {
    overlay.remove();
  }

  function getRequirements() {
    const rows = requirementsByService[state.service];
    return Array.isArray(rows) ? rows : [];
  }

  function getCreateForm() {
    return workflowType.create_form || { fields: [] };
  }

  function ensureDefaults() {
    (getCreateForm().fields || []).forEach((field) => {
      if (state.formValues[field.key] !== void 0) return;
      if (field.default_value !== void 0) {
        state.formValues[field.key] = field.default_value;
      } else if (field.type === "choice" && Array.isArray(field.options) && field.options.length > 0) {
        state.formValues[field.key] = field.options[0].value;
      } else {
        state.formValues[field.key] = "";
      }
    });
  }

  function isFieldVisible(field) {
    const rule = field.visible_when;
    if (!rule) return true;
    if (Array.isArray(rule.entry_points) && rule.entry_points.length > 0 && !rule.entry_points.includes(state.entryPoint)) {
      return false;
    }
    if (rule.equals && typeof rule.equals === "object") {
      for (const [depKey, expected] of Object.entries(rule.equals)) {
        const actual = state.formValues[depKey];
        if (Array.isArray(expected)) {
          if (!expected.includes(actual)) return false;
        } else if (actual !== expected) {
          return false;
        }
      }
    }
    return true;
  }

  function getVisibleFields() {
    ensureDefaults();
    return (getCreateForm().fields || []).filter((field) => isFieldVisible(field));
  }

  function isPreviewFieldFilled(field) {
    const value = state.formValues[field.key];
    if (field.type === "file_uploads") {
      return Array.isArray(value) && value.some((item) => item && typeof item.path === "string" && item.path.trim());
    }
    if (Array.isArray(value)) return value.length > 0;
    return typeof value === "string" ? value.trim().length > 0 : value !== void 0 && value !== null;
  }

  function getMissingRequiredFields() {
    return getVisibleFields().filter((field) => field.required === true && !isPreviewFieldFilled(field));
  }

  function getTaskTitle() {
    return typeof state.title === "string" ? state.title.trim() : "";
  }

  function getRequirementDescription() {
    const visibleKeys = new Set(getVisibleFields().map((field) => field.key));
    for (const key of ["requirement_description", "requirement_custom"]) {
      if (!visibleKeys.has(key)) continue;
      const value = state.formValues[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  }

  function getSelectedRequirementName() {
    const visibleKeys = new Set(getVisibleFields().map((field) => field.key));
    for (const key of ["requirement_preset", "deliverable_source"]) {
      if (!visibleKeys.has(key)) continue;
      const value = state.formValues[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  }

  function getRequiredDeliverableFile() {
    const detail = workflowType.entry_points_detail?.[state.entryPoint];
    return resolveRequiredDeliverableFile(detail);
  }

  function getRequirementDeliverables(reqName) {
    const req = getRequirements().find((item) => item.requirement_name === reqName);
    return Array.isArray(req?.deliverables) ? req.deliverables : [];
  }

  function updateHint() {
    const taskTitle = getTaskTitle();
    const selectedRequirement = getSelectedRequirementName();
    const detail = workflowType.entry_points_detail?.[state.entryPoint];
    const deliverableRequired = !!detail?.requires_deliverable;
    const requiredFile = getRequiredDeliverableFile();
    const deliverableOk =
      !deliverableRequired || getRequirementDeliverables(selectedRequirement).includes(requiredFile);
    const missingRequiredField = getMissingRequiredFields()[0];
    if (!taskTitle) {
      hintEl.textContent = "请输入任务名称";
    } else if (missingRequiredField) {
      hintEl.textContent = `请填写${missingRequiredField.label || missingRequiredField.key}`;
    } else if (deliverableRequired && !selectedRequirement) {
      hintEl.textContent = "请选择关联需求";
    } else if (deliverableRequired) {
      hintEl.textContent = deliverableOk
        ? `已命中交付物校验：${requiredFile}`
        : `当前入口点要求存在 ${requiredFile}，示例服务下的需求暂不满足`;
    } else {
      hintEl.textContent = "当前配置下可以创建任务；这里只做 UI 预览。";
    }
  }

  function renderPreview() {
    if (titleInputEl) {
      titleInputEl.value = state.title || "";
      titleInputEl.oninput = () => {
        state.title = titleInputEl.value;
        updateHint();
      };
    }
    renderSingleOptions(
      entryOptionsEl,
      workflowType.entry_points.map((entry) => ({
        value: entry,
        label: workflowType.entry_points_detail?.[entry]?.requires_deliverable ? `${entry} (需要交付物)` : entry,
      })),
      state.entryPoint,
      (value) => {
        state.entryPoint = value;
        renderPreview();
      },
    );

    renderSingleOptions(
      serviceOptionsEl,
      services.map((service) => ({ value: service, label: service })),
      state.service,
      (value) => {
        state.service = value;
        renderPreview();
      },
    );

    const requirements = getRequirements();
    fieldsEl.innerHTML = "";
    getVisibleFields().forEach((field, idx) => {
      const section = document.createElement("div");
      section.className = "workflow-wizard-section";
      section.innerHTML = `<div class="workflow-wizard-label">${idx + 1}. ${escapeHtml(field.label || field.key)}</div>`;
      const wrap = document.createElement("div");
      wrap.className = "workflow-wizard-subsection";
      section.appendChild(wrap);

      if (field.type === "text") {
        const input = document.createElement("input");
        input.className = "workflow-wizard-input";
        input.placeholder = field.placeholder || "";
        input.value = state.formValues[field.key] || "";
        input.addEventListener("input", () => {
          state.formValues[field.key] = input.value;
          updateHint();
        });
        wrap.appendChild(input);
      } else if (field.type === "choice") {
        const opts = document.createElement("div");
        opts.className = "workflow-wizard-options compact";
        wrap.appendChild(opts);
        renderSingleOptions(opts, field.options || [], state.formValues[field.key], (value) => {
          state.formValues[field.key] = value;
          renderPreview();
        });
      } else if (field.type === "requirement_select") {
        const searchKey = `${field.key}__search`;
        if (field.searchable) {
          const search = document.createElement("input");
          search.className = "workflow-wizard-input";
          search.placeholder = "搜索已有需求";
          search.value = state.fieldSearch[searchKey] || "";
          search.addEventListener("input", () => {
            state.fieldSearch[searchKey] = search.value;
            renderPreview();
          });
          wrap.appendChild(search);
        }
        const opts = document.createElement("div");
        opts.className = "workflow-wizard-options";
        if (field.searchable) opts.style.marginTop = "8px";
        wrap.appendChild(opts);
        const keyword = (state.fieldSearch[searchKey] || "").trim();
        const filtered = requirements.filter((item) => !keyword || item.requirement_name.includes(keyword));
        if (!state.formValues[field.key] && filtered[0]) {
          state.formValues[field.key] = filtered[0].requirement_name;
        }
        renderSingleOptions(
          opts,
          filtered.map((item) => ({ value: item.requirement_name, label: item.requirement_name })),
          state.formValues[field.key],
          (value) => {
            state.formValues[field.key] = value;
            renderPreview();
          },
        );
      }

      if (field.helper_text) {
        const helper = document.createElement("div");
        helper.className = "workflow-wizard-field-help";
        helper.textContent = field.helper_text;
        section.appendChild(helper);
      }
      fieldsEl.appendChild(section);
    });

    updateHint();
  }

  overlay.querySelector("#workflow-definition-create-form-preview-close").addEventListener("click", closePreview);
  overlay.querySelector("#workflow-definition-create-form-preview-cancel").addEventListener("click", closePreview);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closePreview();
  });

  renderPreview();
}

function navigateCommandPalette(direction) {
  if (!commandOptionsEl || commandCandidates.length === 0) return;
  const items = commandOptionsEl.querySelectorAll(".cmd-item");
  items[cmdPaletteIndex]?.classList.remove("active");
  cmdPaletteIndex = (cmdPaletteIndex + direction + commandCandidates.length) % commandCandidates.length;
  items[cmdPaletteIndex]?.classList.add("active");
  items[cmdPaletteIndex]?.scrollIntoView({ block: "nearest" });
}

function selectCommandPaletteItem() {
  if (cmdPaletteIndex >= 0 && cmdPaletteIndex < commandCandidates.length) {
    executeCommand(commandCandidates[cmdPaletteIndex]);
  }
}

function fuzzyMatch(text, query) {
  const source = (text || "").toLowerCase();
  const target = (query || "").trim().toLowerCase();
  if (!target) return true;
  if (source.includes(target)) return true;
  let j = 0;
  for (let i = 0; i < source.length && j < target.length; i++) {
    if (source[i] === target[j]) j++;
  }
  return j === target.length;
}

function getMentionTargets() {
  const targets = [{ name: "Andy", kind: "assistant" }];
  const seen = new Set(["andy"]);
  const folders = groups
    .filter((g) => g && typeof g.jid === "string" && g.jid.startsWith("web:") && typeof g.folder === "string" && g.folder.trim())
    .map((g) => g.folder.trim());
  folders.sort((a, b) => a.localeCompare(b, "zh-CN"));

  for (const folder of folders) {
    const key = folder.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ name: folder, kind: "groupfolder" });
  }
  return targets;
}

function ensureMentionPickerElements() {
  if (!mentionPicker || mentionSearchInput || mentionOptionsEl) return;

  const searchWrap = document.createElement("div");
  searchWrap.className = "mention-search-wrap";
  mentionSearchInput = document.createElement("input");
  mentionSearchInput.id = "mention-search-input";
  mentionSearchInput.type = "text";
  mentionSearchInput.placeholder = "搜索 Andy 或 group folder";
  searchWrap.appendChild(mentionSearchInput);
  mentionPicker.appendChild(searchWrap);

  mentionOptionsEl = document.createElement("div");
  mentionOptionsEl.id = "mention-options";
  mentionPicker.appendChild(mentionOptionsEl);

  mentionSearchInput.addEventListener("input", () => {
    mentionPickerIndex = 0;
    renderMentionOptions();
  });

  mentionSearchInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      navigateMentionPicker(-1);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      navigateMentionPicker(1);
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      if (mentionCandidates.length > 0) {
        e.preventDefault();
        selectMention(mentionCandidates[Math.max(mentionPickerIndex, 0)].name);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      hideMentionPicker();
    }
  });
}

function renderMentionOptions() {
  if (!mentionOptionsEl || !mentionSearchInput) return;
  const query = mentionSearchInput.value || "";
  mentionCandidates = getMentionTargets().filter((item) => fuzzyMatch(item.name, query));
  mentionOptionsEl.innerHTML = "";

  if (mentionCandidates.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mention-empty";
    empty.textContent = "没有匹配项";
    mentionOptionsEl.appendChild(empty);
    mentionPickerIndex = -1;
    return;
  }

  if (mentionPickerIndex < 0 || mentionPickerIndex >= mentionCandidates.length) {
    mentionPickerIndex = 0;
  }

  mentionCandidates.forEach((item, i) => {
    const el = document.createElement("div");
    el.className = `mention-item${i === mentionPickerIndex ? " active" : ""}`;
    el.innerHTML = `<span class="mention-name">${escapeHtml("@" + item.name)}</span><span class="mention-kind">${escapeHtml(item.kind)}</span>`;
    el.addEventListener("click", () => selectMention(item.name));
    mentionOptionsEl.appendChild(el);
  });
}

function navigateMentionPicker(direction) {
  if (!mentionOptionsEl || mentionCandidates.length === 0) return;
  mentionPickerIndex = (mentionPickerIndex + direction + mentionCandidates.length) % mentionCandidates.length;
  const items = mentionOptionsEl.querySelectorAll(".mention-item");
  items.forEach((el, i) => el.classList.toggle("active", i === mentionPickerIndex));
  items[mentionPickerIndex]?.scrollIntoView({ block: "nearest" });
}

function showMentionPicker() {
  if (!mentionPicker) return;
  hideCommandPalette();
  ensureMentionPickerElements();
  mentionInsertPos = messageInput.selectionStart;
  mentionPickerVisible = true;
  mentionPicker.classList.add("visible");
  mentionPickerIndex = 0;
  if (mentionSearchInput) mentionSearchInput.value = "";
  renderMentionOptions();
  mentionSearchInput?.focus();
}

function hideMentionPicker(restoreFocus = true) {
  if (!mentionPicker) return;
  mentionPickerVisible = false;
  mentionPicker.classList.remove("visible");
  mentionCandidates = [];
  mentionPickerIndex = -1;
  mentionInsertPos = null;
  if (restoreFocus) messageInput.focus();
}

function selectMention(name) {
  const ta = messageInput;
  const pos = typeof mentionInsertPos === "number" ? mentionInsertPos : ta.selectionStart;
  const mentionText = `@${name} `;
  ta.value = ta.value.substring(0, pos) + mentionText + ta.value.substring(pos);
  ta.selectionStart = ta.selectionEnd = pos + mentionText.length;
  hideMentionPicker(false);
  ta.focus();
  autoResizeInput();
}

function insertTextIntoComposer(text) {
  const ta = messageInput;
  const pos = typeof ta.selectionStart === "number" ? ta.selectionStart : ta.value.length;
  const before = ta.value.substring(0, pos);
  const after = ta.value.substring(pos);
  let insertion = text;
  if (before && !before.endsWith("\n")) insertion = `\n${insertion}`;
  if (after && !after.startsWith("\n")) insertion = `${insertion}\n`;
  ta.value = before + insertion + after;
  const cursor = before.length + insertion.length;
  ta.selectionStart = ta.selectionEnd = cursor;
  ta.focus();
  autoResizeInput();
}

function referenceFileInComposer(containerPath) {
  insertTextIntoComposer(`文件地址: ${containerPath}`);
  showToast("已引用文件");
}

// Stage a file for upload on next send
function stageFile(file) {
  if (!currentGroupJid) return;
  pendingFiles.push(file);
  renderPendingFiles();
}

// Render the pending files preview bar
function renderPendingFiles() {
  if (pendingFiles.length === 0) {
    pendingFilesEl.classList.remove("visible");
    return;
  }
  const names = pendingFiles.map((f) => f.name).join(", ");
  pendingFilesContent.innerHTML = `${SVG.paperclip} ${pendingFiles.length} 个附件: ${names}`;
  pendingFilesEl.classList.add("visible");
}

// Remove a staged file by index
function removePendingFile(index) {
  pendingFiles.splice(index, 1);
  renderPendingFiles();
}

// Upload all pending files and return the prefix string to prepend to the message
async function uploadPendingFiles() {
  if (pendingFiles.length === 0) return "";

  const agentPaths = [];
  for (const file of pendingFiles) {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(
      `http://localhost:3000/api/upload?jid=${encodeURIComponent(currentGroupJid)}`,
      { method: "POST", body: formData }
    );
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    const data = await res.json();
    if (data.files && data.files[0]) {
      agentPaths.push(data.files[0].agentPath);
    }
  }
  pendingFiles = [];
  renderPendingFiles();

  if (agentPaths.length === 0) return "";
  return (
    "【附件】\n" +
    agentPaths.map((p) => `文件地址: ${p}`).join("\n") +
    "\n"
  );
}
function showError(msg) {
  const el = document.createElement("div");
  el.className = "message system";
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
  showToast("\u5DF2\u590D\u5236");
}

function showToast(message, duration = 1500) {
  let toast = document.getElementById("copy-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "copy-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.remove("visible");
  void toast.offsetWidth;
  toast.classList.add("visible");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove("visible"), duration);
}

// --- Multi-select ---
function enterMultiSelect() {
  multiSelectMode = true;
  messagesEl.classList.add("multi-select");
  multiSelectBar.classList.add("visible");
  selectModeBtn.classList.add("active");
  selectModeBtn.innerHTML = SVG.checkSquare;
  inputArea.style.display = "none";
  selectedMsgIds.clear();
  updateMultiSelectBar();
}

function exitMultiSelect() {
  multiSelectMode = false;
  messagesEl.classList.remove("multi-select");
  multiSelectBar.classList.remove("visible");
  selectModeBtn.classList.remove("active");
  selectModeBtn.innerHTML = originalSelectIcon;
  inputArea.style.display = "";
  messagesEl.querySelectorAll(".message.selected").forEach((el) => el.classList.remove("selected"));
  selectedMsgIds.clear();
}

function toggleMultiSelectMode() {
  if (multiSelectMode) exitMultiSelect();
  else enterMultiSelect();
}

function toggleMessageSelection(msgId, el) {
  if (selectedMsgIds.has(msgId)) {
    selectedMsgIds.delete(msgId);
    el.classList.remove("selected");
  } else {
    selectedMsgIds.add(msgId);
    el.classList.add("selected");
  }
  updateMultiSelectBar();
}

function updateMultiSelectBar() {
  const count = selectedMsgIds.size;
  selectedCountEl.textContent = "\u5DF2\u9009 " + count + " \u6761";
  copySelectedBtn.disabled = count === 0;
  deleteSelectedBtn.disabled = count === 0;
}

function copySelectedMessages() {
  const selected = messages.filter((m) => selectedMsgIds.has(m.id));
  if (selected.length === 0) return;
  const text = selected.map((m) => {
    const sender = m.sender_name || m.sender || "Unknown";
    const time = formatTime(m.timestamp);
    return `[${sender}] ${time}\n${m.content}`;
  }).join("\n\n");
  navigator.clipboard.writeText(text).then(() => {
    showCopyToast();
    exitMultiSelect();
  });
}

async function deleteSelectedMessages() {
  if (!currentGroupJid) return;
  const ids = Array.from(selectedMsgIds);
  if (ids.length === 0) return;
  if (!(await openConfirmDialog(`删除已选的 ${ids.length} 条消息？`, { title: "删除消息" }))) return;

  try {
    const res = await apiFetch("/api/messages", {
      method: "DELETE",
      body: JSON.stringify({ jid: currentGroupJid, ids }),
    });
    if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
    await res.json();
    await loadMessages();
    exitMultiSelect();
  } catch (err) {
    console.error("Failed to delete selected messages:", err);
    alert("删除失败");
  }
}

function autoResizeInput() {
  messageInput.style.height = "auto";
  messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + "px";
}

function initTakeCopterCursor() {
  // Keep the default system cursor in the web client.
  document.body.classList.remove("take-copter-cursor-on", "take-copter-cursor-text");
  document.querySelector(".take-copter-cursor")?.remove();
}

function initChatBgParticleNudge() {
  const chatAreaEl = document.getElementById("chat-area");
  const bgEl = document.getElementById("chat-animated-bg");
  if (!chatAreaEl || !bgEl) return;

  const targets = Array.from(
    bgEl.querySelectorAll(".bg-particle, .bg-star, .bg-copter, .bg-bell")
  );
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
        el.style.translate = "0 0";
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
      el.style.translate = inArea ? `${safeX}px ${safeY}px` : "0 0";
    });
  }

  chatAreaEl.addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType && e.pointerType !== "mouse") return;
      applyNudge(e.clientX, e.clientY);
    },
    { passive: true }
  );

  chatAreaEl.addEventListener("pointerleave", () => {
    targets.forEach((el) => {
      el.style.translate = "0 0";
    });
  });
}

function getTodayPlanLocalDateKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getTodayPlanDefaultAssociations() {
  return {
    workbench_task_ids: [],
    chat_selections: [],
    services: [],
  };
}

function normalizeTodayPlanAssociations(associations) {
  const source = associations && typeof associations === "object" ? associations : {};
  const workbenchTaskIds = Array.isArray(source.workbench_task_ids)
    ? Array.from(new Set(source.workbench_task_ids.filter((item) => typeof item === "string" && item.trim())))
    : [];
  const chatSelections = Array.isArray(source.chat_selections)
    ? source.chat_selections
      .filter((item) => item && typeof item.group_jid === "string" && Array.isArray(item.message_ids))
      .map((item) => ({
        group_jid: item.group_jid,
        message_ids: Array.from(new Set((Array.isArray(item.message_ids) ? item.message_ids : []).filter((entry) => typeof entry === "string" && entry.trim()))),
      }))
      .filter((item) => item.message_ids.length > 0)
    : [];
  const services = Array.isArray(source.services)
    ? source.services
      .filter((item) => item && typeof item.service === "string" && Array.isArray(item.branches))
      .map((item) => ({
        service: item.service,
        branches: Array.from(new Set(item.branches.filter((entry) => typeof entry === "string" && entry.trim()))),
      }))
    : [];
  return {
    workbench_task_ids: workbenchTaskIds,
    chat_selections: chatSelections,
    services,
  };
}

function cloneTodayPlanAssociations(associations) {
  return normalizeTodayPlanAssociations(JSON.parse(JSON.stringify(associations || getTodayPlanDefaultAssociations())));
}

function getTodayPlanAssociationChatEntry(state, groupJid) {
  return state.associations.chat_selections.find((item) => item.group_jid === groupJid) || null;
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
  return rows.filter((item, index) => rows.findIndex((entry) => entry.id === item.id) === index);
}

function getTodayPlanResolvedStatus(plan) {
  if (!plan || typeof plan !== "object") return "";
  if (plan.status === "completed" || plan.status === "continued") {
    return plan.status;
  }
  return "active";
}

function getTodayPlanPlanStatusText(plan) {
  if (!plan) return "待创建";
  const status = getTodayPlanResolvedStatus(plan);
  if (status === "completed") {
    return plan.plan_date === getTodayPlanLocalDateKey() ? "今日已完成" : "往日已完成";
  }
  if (status === "continued") {
    return "已承接";
  }
  return plan.plan_date === getTodayPlanLocalDateKey() ? "今日进行中" : "往日未完成";
}

function getTodayPlanPlanStatusClass(plan) {
  if (!plan) return "empty";
  const status = getTodayPlanResolvedStatus(plan);
  if (status === "completed") return "completed";
  if (status === "continued" || plan.plan_date !== getTodayPlanLocalDateKey()) return "history";
  return "";
}

function isTodayPlanEditableDetail(detail) {
  return Boolean(
    detail &&
    detail.plan &&
    detail.plan.plan_date === getTodayPlanLocalDateKey() &&
    getTodayPlanResolvedStatus(detail.plan) === "active"
  );
}

function getTodayPlanAggregateMetrics(detail) {
  const collections = [];
  if (detail && Array.isArray(detail.items)) {
    collections.push(detail.items);
  }
  if (detail && detail.continued_from && Array.isArray(detail.continued_from.items)) {
    collections.push(detail.continued_from.items);
  }
  let taskCount = 0;
  let chatCount = 0;
  let serviceCount = 0;
  let actionItemCount = 0;
  let itemCount = 0;

  collections.forEach((items) => {
    itemCount += items.length;
    items.forEach((item) => {
      const relatedTasks = Array.isArray(item.related_tasks) ? item.related_tasks : [];
      const relatedChats = Array.isArray(item.related_chats) ? item.related_chats : [];
      const relatedServices = Array.isArray(item.related_services) ? item.related_services : [];
      taskCount += relatedTasks.length;
      chatCount += relatedChats.reduce((sum, group) => sum + (Array.isArray(group.messages) ? group.messages.length : 0), 0);
      serviceCount += relatedServices.length;
      relatedTasks.forEach((task) => {
        actionItemCount += Array.isArray(task.action_items) ? task.action_items.length : 0;
      });
    });
  });

  return {
    itemCount,
    taskCount,
    chatCount,
    serviceCount,
    actionItemCount,
  };
}

function closeTodayPlanHistoryModal() {
  if (todayPlanHistoryModal) {
    todayPlanHistoryModal.classList.add("hidden");
  }
}

function renderTodayPlanHistoryList() {
  if (!todayPlanHistoryList) return;
  const mode = todayPlanHistoryModalMode === "continue" ? "continue" : "view";
  const rows = mode === "continue"
    ? getTodayPlanHistoryRows().filter((plan) => getTodayPlanResolvedStatus(plan) === "active")
    : getTodayPlanHistoryRows();

  if (todayPlanHistoryModalTitle) {
    todayPlanHistoryModalTitle.textContent = mode === "continue" ? "继续往日计划" : "查看往日计划";
  }
  if (todayPlanHistoryModalSubtitle) {
    todayPlanHistoryModalSubtitle.textContent = mode === "continue"
      ? "仅展示未完成态的往日计划。选择后会创建今日计划，并以只读方式展示其已关联内容。"
      : "从列表中选择一份往日计划，打开只读详情页。";
  }

  if (rows.length === 0) {
    todayPlanHistoryList.innerHTML = `<div class="today-plan-empty-inline">${mode === "continue" ? "当前没有可继续的未完成往日计划。" : "还没有任何往日计划记录。"}</div>`;
    return;
  }

  todayPlanHistoryList.innerHTML = rows.map((plan) => {
    const isActive = currentTodayPlanId === plan.id;
    const planType = getTodayPlanPlanStatusText(plan);
    return `
      <button type="button" class="today-plan-switcher-item${isActive ? " active" : ""}" data-today-plan-id="${escapeAttribute(plan.id)}">
        <div class="today-plan-switcher-item-head">
          <div class="today-plan-switcher-date">${escapeHtml(plan.plan_date || "--")}</div>
          <span class="today-plan-meta-chip">${escapeHtml(planType)}</span>
        </div>
        <div class="today-plan-switcher-title">${escapeHtml(plan.title || planType)}</div>
      </button>
    `;
  }).join("");

  Array.from(todayPlanHistoryList.querySelectorAll("[data-today-plan-id]")).forEach((button) => {
    button.addEventListener("click", async () => {
      const planId = button.getAttribute("data-today-plan-id") || "";
      if (!planId) return;
      if (mode === "continue") {
        await continueTodayPlanFromHistory(planId);
        return;
      }
      closeTodayPlanHistoryModal();
      await loadTodayPlan(planId);
    });
  });
}

function openTodayPlanHistoryModal(mode = "view") {
  todayPlanHistoryModalMode = mode === "continue" ? "continue" : "view";
  renderTodayPlanHistoryList();
  if (todayPlanHistoryModal) {
    todayPlanHistoryModal.classList.remove("hidden");
  }
}

function renderTodayPlanOverviewSummary() {
  const detail = currentTodayPlan && currentTodayPlan.plan ? currentTodayPlan : null;
  const metrics = getTodayPlanAggregateMetrics(detail);
  const hasPlan = Boolean(detail);
  const hasTodayPlan = Boolean(todayPlanOverview && todayPlanOverview.today);
  const historyRows = getTodayPlanHistoryRows();
  const planStatus = getTodayPlanPlanStatusText(hasPlan ? detail.plan : null);
  const editable = isTodayPlanEditableDetail(detail);

  if (todayPlanPlanStatus) {
    todayPlanPlanStatus.textContent = planStatus;
    todayPlanPlanStatus.className = `today-plan-status-badge${planStatus ? ` ${getTodayPlanPlanStatusClass(hasPlan ? detail.plan : null)}` : ""}`;
  }

  if (todayPlanHeroMeta) {
    const chips = [
      `<span class="today-plan-meta-chip">⌘W 快速切换</span>`,
      `<span class="today-plan-meta-chip">${hasPlan ? escapeHtml(detail.plan.plan_date || "--") : "仅展示今日入口"}</span>`,
    ];
    if (detail && detail.continued_from && detail.continued_from.plan) {
      chips.push(`<span class="today-plan-meta-chip">承接自 ${escapeHtml(detail.continued_from.plan.plan_date || "--")}</span>`);
    }
    todayPlanHeroMeta.innerHTML = chips.join("");
  }

  if (todayPlanOverviewSummary) {
    todayPlanOverviewSummary.innerHTML = `
      <div class="today-plan-overview-grid">
        <div class="today-plan-overview-card">
          <span>当前视图</span>
          <strong>${escapeHtml(planStatus)}</strong>
          <small>${escapeHtml(hasPlan ? (detail.plan.plan_date || "--") : "创建后开始维护")}</small>
        </div>
        <div class="today-plan-overview-card">
          <span>${detail && detail.continued_from ? "可见计划项" : "计划项"}</span>
          <strong>${escapeHtml(String(metrics.itemCount))}</strong>
          <small>${escapeHtml(editable ? "包含今日计划与承接内容" : "当前详情页展示条目数")}</small>
        </div>
        <div class="today-plan-overview-card">
          <span>任务 / 待处理</span>
          <strong>${escapeHtml(String(metrics.taskCount))}</strong>
          <small>待处理 ${escapeHtml(String(metrics.actionItemCount))} 项</small>
        </div>
        <div class="today-plan-overview-card">
          <span>${detail && detail.continued_from ? "承接来源" : "消息 / 服务"}</span>
          <strong>${escapeHtml(detail && detail.continued_from ? (detail.continued_from.plan.plan_date || "--") : `${metrics.chatCount} / ${metrics.serviceCount}`)}</strong>
          <small>${escapeHtml(detail && detail.continued_from ? "往日计划内容为只读展示" : "群聊消息 / 服务分支")}</small>
        </div>
      </div>
    `;
  }

  if (todayPlanViewHistoryBtn) {
    todayPlanViewHistoryBtn.disabled = false;
  }
  if (todayPlanContinuePlanBtn) {
    todayPlanContinuePlanBtn.classList.toggle("hidden", hasTodayPlan);
    todayPlanContinuePlanBtn.disabled = false;
  }
}

function renderTodayPlanMessageBody(message) {
  if (!message) return "";
  if (message.is_bot_message) {
    return renderMarkdown(message.content || "");
  }
  return escapeHtml(message.content || "").replace(/\n/g, "<br>");
}

function renderTodayPlanReplyQuote(message) {
  if (!message || !message.reply_to_id) return "";
  const preview = typeof message.reply_preview === "string" && message.reply_preview.trim()
    ? message.reply_preview.trim()
    : "原消息不可用";
  return `<div class="msg-reply-quote" data-reply-id="${escapeAttribute(message.reply_to_id)}">${escapeHtml(preview)}</div>`;
}

function renderTodayPlanTaskActions(task, options = {}) {
  if (!task || !Array.isArray(task.action_items) || task.action_items.length === 0) {
    return '<div class="today-plan-empty-inline">当前没有待处理项</div>';
  }
  const readonly = Boolean(options.readonly);
  return `
    <div class="today-plan-action-items">
      ${task.action_items.map((item) => {
        const actionButtons = [];
        if (!readonly && item.item_type === "approval") {
          const labels = getWorkbenchApprovalLabels(task.task, {
            approval_type: item.stage_key || task.task.workflow_status,
            action_mode: item.action_mode || "approve_only",
          });
          if (item.action_mode !== "input_required") {
            actionButtons.push(`<button type="button" class="btn-primary btn-soft-primary" data-today-plan-task-action="${escapeAttribute(task.task_id)}" data-today-plan-task-op="approve" data-today-plan-task-op-title="${escapeAttribute(item.title || task.title || "当前节点")}">${escapeHtml(labels.approve || "通过")}</button>`);
          }
          actionButtons.push(`<button type="button" class="btn-ghost" data-today-plan-task-action="${escapeAttribute(task.task_id)}" data-today-plan-task-op="skip" data-today-plan-task-op-title="${escapeAttribute(item.title || task.title || "当前节点")}">${escapeHtml(labels.skip || "跳过此节点")}</button>`);
          if (item.action_mode === "approve_or_revise" || item.action_mode === "input_required") {
            const actionName = item.action_mode === "input_required" ? "submit_access_token" : "revise";
            actionButtons.push(`<button type="button" class="btn-ghost" data-today-plan-task-action="${escapeAttribute(task.task_id)}" data-today-plan-task-op="${escapeAttribute(actionName)}" data-today-plan-task-op-title="${escapeAttribute(item.title || task.title || "当前节点")}">${escapeHtml(labels.revise || "驳回并修改")}</button>`);
          }
        } else if (!readonly) {
          const askQuestion = item.source_type === "ask_user_question"
            ? item.extra && (item.extra.current_question || (Array.isArray(item.extra.questions) ? item.extra.questions[0] : null))
            : null;
          const askOptions = askQuestion && Array.isArray(askQuestion.options) ? askQuestion.options : null;
          if (Array.isArray(askOptions) && askOptions.length > 0) {
            askOptions.forEach((opt) => {
              actionButtons.push(`<button type="button" class="btn-ghost" data-today-plan-action-item="${escapeAttribute(item.id)}" data-today-plan-task="${escapeAttribute(task.task_id)}" data-today-plan-action="reply" data-today-plan-prefill="${escapeAttribute(opt.label || "")}">${escapeHtml(opt.label || "回复")}</button>`);
            });
            actionButtons.push(`<button type="button" class="btn-primary btn-soft-primary" data-today-plan-action-item="${escapeAttribute(item.id)}" data-today-plan-task="${escapeAttribute(task.task_id)}" data-today-plan-action="reply">自定义回复</button>`);
            actionButtons.push(`<button type="button" class="btn-ghost" data-today-plan-action-item="${escapeAttribute(item.id)}" data-today-plan-task="${escapeAttribute(task.task_id)}" data-today-plan-action="skip">跳过</button>`);
          } else {
            if (item.replyable) {
              actionButtons.push(`<button type="button" class="btn-primary btn-soft-primary" data-today-plan-action-item="${escapeAttribute(item.id)}" data-today-plan-task="${escapeAttribute(task.task_id)}" data-today-plan-action="reply">回复</button>`);
            }
            actionButtons.push(`<button type="button" class="btn-ghost" data-today-plan-action-item="${escapeAttribute(item.id)}" data-today-plan-task="${escapeAttribute(task.task_id)}" data-today-plan-action="confirm">确认</button>`);
            actionButtons.push(`<button type="button" class="btn-ghost" data-today-plan-action-item="${escapeAttribute(item.id)}" data-today-plan-task="${escapeAttribute(task.task_id)}" data-today-plan-action="skip">跳过</button>`);
            actionButtons.push(`<button type="button" class="btn-ghost" data-today-plan-action-item="${escapeAttribute(item.id)}" data-today-plan-task="${escapeAttribute(task.task_id)}" data-today-plan-action="cancel">取消</button>`);
          }
        }
        return `
          <div class="today-plan-action-item">
            <div class="today-plan-action-item-head">
              <div class="today-plan-option-title">${escapeHtml(item.title || "待处理项")}</div>
              <div class="today-plan-meta-pill">${escapeHtml(item.status || "pending")}</div>
            </div>
            <div class="today-plan-description">${escapeHtml(item.body || "暂无描述")}</div>
            ${readonly ? "" : `<div class="today-plan-action-item-actions">${actionButtons.join("")}</div>`}
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderTodayPlanItemActionIcon(kind) {
  if (kind === "associations") {
    return `
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M10 13a5 5 0 0 0 7.54.54l2-2a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
        <path d="M14 11a5 5 0 0 0-7.54-.54l-2 2a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
      </svg>
    `;
  }
  if (kind === "delete") {
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
  return "";
}

function renderTodayPlanItemCard(item, index, options = {}) {
  const readonly = Boolean(options.readonly);
  const readonlyLabel = options.readonlyLabel || "只读";
  const taskCount = Array.isArray(item.related_tasks) ? item.related_tasks.length : 0;
  const chatCount = Array.isArray(item.related_chats)
    ? item.related_chats.reduce((sum, group) => sum + (Array.isArray(group.messages) ? group.messages.length : 0), 0)
    : 0;
  const serviceCount = Array.isArray(item.related_services) ? item.related_services.length : 0;
  const titleField = readonly
    ? `<div class="today-plan-static-title">${escapeHtml(item.title || "未命名计划")}</div>`
    : `<input class="today-plan-input" data-today-plan-field="title" value="${escapeAttribute(item.title || "")}" placeholder="例如：完成支付链路自测与联调安排" />`;
  const detailField = readonly
    ? `<div class="today-plan-static-detail">${escapeHtml(item.detail || "暂无补充说明").replace(/\n/g, "<br>")}</div>`
    : `<textarea class="today-plan-textarea" data-today-plan-field="detail" placeholder="补充这条计划的目标、范围、交付预期和风险">${escapeHtml(item.detail || "")}</textarea>`;

  return `
    <div class="today-plan-item-card" data-today-plan-item="${escapeAttribute(item.id)}" data-today-plan-readonly="${readonly ? "1" : "0"}">
      <div class="today-plan-item-header">
        <div class="today-plan-item-header-main">
          <span class="today-plan-item-order">${escapeHtml(String(index + 1).padStart(2, "0"))}</span>
          <div class="today-plan-item-fields">
            ${titleField}
          </div>
        </div>
        <div class="today-plan-item-actions">
          ${readonly ? `<span class="today-plan-item-readonly-note">${escapeHtml(readonlyLabel)}</span>` : `
            <button type="button" class="icon-btn today-plan-item-icon-btn" data-today-plan-edit="associations" data-today-plan-item-id="${escapeAttribute(item.id)}" title="关联信息" aria-label="关联信息">
              ${renderTodayPlanItemActionIcon("associations")}
            </button>
            <button type="button" class="icon-btn today-plan-item-icon-btn danger" data-today-plan-delete="${escapeAttribute(item.id)}" title="删除计划项" aria-label="删除计划项">
              ${renderTodayPlanItemActionIcon("delete")}
            </button>
          `}
        </div>
      </div>
      ${detailField}

      <div class="today-plan-association-summary">
        <div class="today-plan-summary-pill">
          <strong>工作台任务</strong>
          <span>${escapeHtml(String(taskCount))}</span>
        </div>
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
            <div class="today-plan-section-title">关联工作台任务</div>
            <div class="today-plan-section-subtitle">${readonly ? "只读展示当前任务节点与待处理项。" : "展示当前节点，并可直接处理待处理项。"}</div>
          </div>
        </div>
        ${taskCount === 0 ? '<div class="today-plan-empty-inline">未关联工作台任务</div>' : `
          <div class="today-plan-task-block">
            ${item.related_tasks.map((task) => `
              <div class="today-plan-task-card">
                <div class="today-plan-task-head">
                  <div>
                    <div class="today-plan-task-title">${escapeHtml(task.title || task.task_id)}</div>
                    <div class="today-plan-pill-row">
                      <span class="today-plan-meta-pill">${escapeHtml(task.service || "未设置服务")}</span>
                      <span class="today-plan-meta-pill">当前节点：${escapeHtml(task.workflow_stage_label || "--")}</span>
                      <span class="today-plan-meta-pill">流程状态：${escapeHtml(task.workflow_status_label || "--")}</span>
                    </div>
                  </div>
                </div>
                <div class="today-plan-description">${escapeHtml(task.description || "暂无任务描述")}</div>
                ${renderTodayPlanTaskActions(task, { readonly })}
              </div>
            `).join("")}
          </div>
        `}
      </section>

      <section class="today-plan-section">
        <div class="today-plan-section-header">
          <div>
            <div class="today-plan-section-title">关联群聊消息</div>
            <div class="today-plan-section-subtitle">按群展示今天被选中的消息内容。</div>
          </div>
        </div>
        ${chatCount === 0 ? '<div class="today-plan-empty-inline">未关联群聊消息</div>' : `
          <div class="today-plan-chat-block">
            ${item.related_chats.map((group) => `
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
                  ${(group.messages || []).map((message) => `
                    <div class="today-plan-chat-message${message.is_from_me ? " from-me" : ""}${message.is_bot_message ? " bot" : ""}">
                      <div class="today-plan-chat-message-head">
                        <span>${escapeHtml(message.sender_name || message.sender || "未知")}</span>
                        <span>${escapeHtml(formatDateTime(message.timestamp || ""))}</span>
                      </div>
                      ${renderTodayPlanReplyQuote(message)}
                      <div class="today-plan-chat-message-body">${renderTodayPlanMessageBody(message)}</div>
                    </div>
                  `).join("")}
                </div>
              </div>
            `).join("")}
          </div>
        `}
      </section>

      <section class="today-plan-section">
        <div class="today-plan-section-header">
          <div>
            <div class="today-plan-section-title">关联服务与分支</div>
            <div class="today-plan-section-subtitle">包含手动选择的服务，以及由工作台任务自动带出的工作分支。</div>
          </div>
        </div>
        ${serviceCount === 0 ? '<div class="today-plan-empty-inline">未关联服务分支</div>' : `
          <div class="today-plan-service-block">
            ${item.related_services.map((service) => `
              <div class="today-plan-service-card">
                <div class="today-plan-service-head">
                  <div>
                    <div class="today-plan-service-title">${escapeHtml(service.service || "未命名服务")}</div>
                    <div class="today-plan-pill-row">
                      <span class="today-plan-meta-pill">${escapeHtml(service.repo_path || "未配置仓库路径")}</span>
                      <span class="today-plan-meta-pill">${service.repo_exists ? "仓库可读" : "仓库不存在"}</span>
                    </div>
                  </div>
                </div>
                <div class="today-plan-branch-list">
                  ${(service.branches || []).map((branch) => `
                    <div class="today-plan-branch-card">
                      <div class="today-plan-service-head">
                        <div>
                          <div class="today-plan-service-title">${escapeHtml(branch.name || "--")}</div>
                          <div class="today-plan-pill-row">
                            <span class="today-plan-meta-pill">来源：${escapeHtml(branch.source || "manual")}</span>
                            ${branch.ref ? `<span class="today-plan-meta-pill">${escapeHtml(branch.ref)}</span>` : ""}
                          </div>
                        </div>
                      </div>
                      ${(branch.commits || []).length === 0 ? `<div class="today-plan-empty-inline">${escapeHtml(branch.error || "当天没有 commit")}</div>` : `
                        <div class="today-plan-commit-list">
                          ${(branch.commits || []).map((commit) => `
                            <button type="button" class="today-plan-commit-card" data-today-plan-commit="${escapeAttribute(commit.hash)}" data-today-plan-service="${escapeAttribute(service.service)}">
                              <div class="today-plan-commit-subject">${escapeHtml(commit.subject || commit.short_hash)}</div>
                              <div class="today-plan-commit-meta-row">
                                <span>${escapeHtml(commit.short_hash || "")}</span>
                                <span>${escapeHtml(commit.author || "")}</span>
                                <span>${escapeHtml(formatDateTime(commit.committed_at || ""))}</span>
                              </div>
                            </button>
                          `).join("")}
                        </div>
                      `}
                    </div>
                  `).join("")}
                </div>
              </div>
            `).join("")}
          </div>
        `}
      </section>
    </div>
  `;
}

function bindEditableTodayPlanItemInteractions() {
  Array.from(todayPlanItems.querySelectorAll("[data-today-plan-add-item-trigger]")).forEach((button) => {
    button.addEventListener("click", async () => {
      await createTodayPlanItemEntry();
    });
  });

  Array.from(todayPlanItems.querySelectorAll("[data-today-plan-field]")).forEach((field) => {
    const card = field.closest("[data-today-plan-item]");
    if (!card) return;
    const itemId = card.getAttribute("data-today-plan-item") || "";
    const key = field.getAttribute("data-today-plan-field") || "";
    field.addEventListener("input", () => {
      const patch = {};
      patch[key] = field.value;
      updateTodayPlanLocalItem(itemId, patch);
      queueTodayPlanItemPatch(itemId, patch);
    });
    field.addEventListener("blur", () => {
      const patch = {};
      patch[key] = field.value;
      queueTodayPlanItemPatch(itemId, patch, true);
    });
  });

  Array.from(todayPlanItems.querySelectorAll("[data-today-plan-delete]")).forEach((button) => {
    button.addEventListener("click", async () => {
      const itemId = button.getAttribute("data-today-plan-delete") || "";
      if (!itemId) return;
      await deleteTodayPlanItemEntry(itemId);
    });
  });

  Array.from(todayPlanItems.querySelectorAll("[data-today-plan-edit='associations']")).forEach((button) => {
    button.addEventListener("click", async () => {
      const itemId = button.getAttribute("data-today-plan-item-id") || "";
      if (!itemId) return;
      await openTodayPlanAssociationDialog(itemId);
    });
  });

  Array.from(todayPlanItems.querySelectorAll("[data-today-plan-action-item]")).forEach((button) => {
    button.addEventListener("click", async () => {
      const taskId = button.getAttribute("data-today-plan-task") || "";
      const actionItemId = button.getAttribute("data-today-plan-action-item") || "";
      const action = button.getAttribute("data-today-plan-action") || "";
      const prefillText = button.getAttribute("data-today-plan-prefill") || "";
      if (!taskId || !actionItemId || !action) return;
      await triggerWorkbenchActionItem(taskId, actionItemId, action, prefillText || undefined);
      if (currentTodayPlanId) {
        await loadTodayPlan(currentTodayPlanId);
      }
    });
  });

  Array.from(todayPlanItems.querySelectorAll("[data-today-plan-task-action]")).forEach((button) => {
    button.addEventListener("click", async () => {
      const taskId = button.getAttribute("data-today-plan-task-action") || "";
      const action = button.getAttribute("data-today-plan-task-op") || "";
      const actionTitle = button.getAttribute("data-today-plan-task-op-title") || "当前节点";
      if (!taskId || !action) return;
      if (action === "skip") {
        if (!(await openConfirmDialog(`确认跳过「${actionTitle}」并进入下一步吗？`, { title: "跳过节点" }))) return;
      }
      await triggerWorkbenchAction(taskId, action);
      if (currentTodayPlanId) {
        await loadTodayPlan(currentTodayPlanId);
      }
    });
  });
}

function bindTodayPlanCommitInteractions() {
  Array.from(todayPlanItems.querySelectorAll("[data-today-plan-commit]")).forEach((button) => {
    button.addEventListener("click", async () => {
      const service = button.getAttribute("data-today-plan-service") || "";
      const commit = button.getAttribute("data-today-plan-commit") || "";
      if (!service || !commit) return;
      await openTodayPlanCommitDialog(service, commit);
    });
  });
}

function renderTodayPlanItems() {
  if (!todayPlanItems || !currentTodayPlan || !Array.isArray(currentTodayPlan.items)) return;
  const editable = isTodayPlanEditableDetail(currentTodayPlan);
  const currentItems = Array.isArray(currentTodayPlan.items) ? currentTodayPlan.items : [];
  const continuedFrom = currentTodayPlan.continued_from || null;
  const sections = [];

  if (continuedFrom) {
    sections.push(`
      <section class="today-plan-section-block">
        <div class="today-plan-section-header">
          <div>
            <div class="today-plan-section-title">承接往日计划</div>
            <div class="today-plan-section-subtitle">来源：${escapeHtml(continuedFrom.plan.plan_date || "--")} · ${escapeHtml(getTodayPlanPlanStatusText(continuedFrom.plan))} · 以下内容均为只读展示。</div>
          </div>
        </div>
        ${continuedFrom.items.length === 0
          ? '<div class="today-plan-empty-inline">该往日计划没有可展示的计划项。</div>'
          : `<div class="today-plan-section-stack">${continuedFrom.items.map((item, index) => renderTodayPlanItemCard(item, index, { readonly: true, readonlyLabel: "承接内容只读" })).join("")}</div>`}
      </section>
    `);
  }

  sections.push(`
    <section class="today-plan-section-block">
      <div class="today-plan-section-header">
        <div>
          <div class="today-plan-section-title">${editable ? "今日计划项" : "计划详情"}</div>
          <div class="today-plan-section-subtitle">${editable ? "维护今天的计划项；每条都可以继续新增、编辑、关联和发送邮件前汇总。" : "当前页面为只读详情，不可编辑、删除、关联或处理待处理项。"}</div>
        </div>
        ${editable ? `
          <div class="today-plan-section-actions">
            <button type="button" class="icon-btn today-plan-board-icon-btn" data-today-plan-add-item-trigger="1" title="新增计划项" aria-label="新增计划项">
              <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 5v14"></path>
                <path d="M5 12h14"></path>
              </svg>
            </button>
          </div>
        ` : ""}
      </div>
      ${currentItems.length === 0
        ? `<div class="today-plan-empty-inline">${editable ? "先新增一条计划项，再把工作台任务、群聊消息和服务分支挂上来。" : "当前计划没有计划项。"}</div>`
        : `<div class="today-plan-section-stack">${currentItems.map((item, index) => renderTodayPlanItemCard(item, index, { readonly: !editable, readonlyLabel: "历史计划只读" })).join("")}</div>`}
    </section>
  `);

  todayPlanItems.innerHTML = sections.join("");
  if (editable) {
    bindEditableTodayPlanItemInteractions();
  }
  bindTodayPlanCommitInteractions();
}

function renderTodayPlanScreen() {
  renderTodayPlanHistoryList();
  const detail = currentTodayPlan && currentTodayPlan.plan ? currentTodayPlan : null;
  const hasPlan = Boolean(detail);
  const hasTodayPlan = Boolean(todayPlanOverview && todayPlanOverview.today);
  const editable = isTodayPlanEditableDetail(detail);
  const currentTodayId = todayPlanOverview && todayPlanOverview.today ? todayPlanOverview.today.id : "";

  if (todayPlanContent) {
    todayPlanContent.classList.toggle("hidden", !hasPlan);
  }
  if (todayPlanEmpty) {
    todayPlanEmpty.classList.toggle("hidden", hasPlan);
  }
  if (todayPlanSendMailBtn) {
    todayPlanSendMailBtn.disabled = !editable;
  }
  if (todayPlanCompleteBtn) {
    todayPlanCompleteBtn.classList.toggle("hidden", !hasPlan || !detail || detail.plan.plan_date !== getTodayPlanLocalDateKey());
    todayPlanCompleteBtn.disabled = !editable;
    todayPlanCompleteBtn.textContent = detail && detail.plan.status === "completed" ? "今日计划已完成" : "完成今日计划";
  }
  if (todayPlanCreateTodayBtn) {
    todayPlanCreateTodayBtn.classList.toggle("hidden", hasTodayPlan && currentTodayId === currentTodayPlanId);
    if (!hasTodayPlan) {
      todayPlanCreateTodayBtn.disabled = false;
      todayPlanCreateTodayBtn.textContent = "创建今日计划";
    } else {
      todayPlanCreateTodayBtn.disabled = false;
      todayPlanCreateTodayBtn.textContent = "打开今日计划";
    }
  }
  if (todayPlanEmptyContinueBtn) {
    todayPlanEmptyContinueBtn.classList.toggle("hidden", hasTodayPlan);
    todayPlanEmptyContinueBtn.disabled = false;
  }

  renderTodayPlanOverviewSummary();
  if (!hasPlan) {
    if (todayPlanTitleEl) todayPlanTitleEl.textContent = "今日计划";
    if (todayPlanSubtitleEl) todayPlanSubtitleEl.textContent = "今天还没有创建计划。你可以直接创建今日计划，或从往日计划中查看详情、继续未完成计划。";
    if (todayPlanSectionMeta) todayPlanSectionMeta.textContent = "先创建今日计划，再把任务、群聊消息和服务分支按计划项组织起来。";
    if (todayPlanItems) todayPlanItems.innerHTML = "";
    return;
  }

  if (todayPlanTitleEl) {
    todayPlanTitleEl.textContent = detail.plan.plan_date === getTodayPlanLocalDateKey() ? "今日计划" : `${detail.plan.plan_date || ""} 计划`;
  }
  if (todayPlanSubtitleEl) {
    const currentCount = Array.isArray(detail.items) ? detail.items.length : 0;
    const linkText = detail.continued_from ? ` · 承接自 ${detail.continued_from.plan.plan_date}` : "";
    todayPlanSubtitleEl.textContent = `${detail.plan.title || "今日计划"} · 共 ${currentCount} 条当前计划项${linkText}`;
  }
  if (todayPlanSectionMeta) {
    const metrics = getTodayPlanAggregateMetrics(detail);
    todayPlanSectionMeta.textContent = `${metrics.itemCount} 条可见计划项 · ${metrics.taskCount} 个任务 · ${metrics.chatCount} 条消息 · ${metrics.serviceCount} 个服务`;
  }
  renderTodayPlanItems();
}

async function openOrCreateTodayPlanEntry() {
  const todayId = todayPlanOverview && todayPlanOverview.today ? todayPlanOverview.today.id : "";
  if (todayId) {
    await loadTodayPlan(todayId);
    return;
  }
  await createTodayPlanNow();
}

async function continueTodayPlanFromHistory(planId) {
  if (!planId) return;
  try {
    const res = await apiFetch("/api/today-plan", {
      method: "POST",
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
    currentTodayPlanId = data.plan && data.plan.id ? data.plan.id : "";
    await loadTodayPlanOverview({ forceOpenToday: true });
  } catch (err) {
    console.error("Failed to continue history today plan:", err);
    alert(err.message || "继续往日计划失败");
  }
}

async function completeCurrentTodayPlan() {
  if (!currentTodayPlanId) return;
  if (!(await openConfirmDialog("确认将这份今日计划标记为已完成吗？完成后将切换为只读状态。", { title: "完成今日计划" }))) return;
  try {
    const res = await apiFetch("/api/today-plan/complete", {
      method: "POST",
      body: JSON.stringify({ plan_id: currentTodayPlanId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    currentTodayPlan = data.detail || null;
    if (todayPlanOverview && todayPlanOverview.today && todayPlanOverview.today.id === currentTodayPlanId) {
      todayPlanOverview.today = data.plan || todayPlanOverview.today;
    }
    renderTodayPlanScreen();
  } catch (err) {
    console.error("Failed to complete today plan:", err);
    alert(err.message || "完成今日计划失败");
  }
}

async function loadTodayPlan(planId) {
  if (!planId) return;
  try {
    const res = await apiFetch(`/api/today-plan?id=${encodeURIComponent(planId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    currentTodayPlan = data;
    currentTodayPlanId = data.plan && data.plan.id ? data.plan.id : planId;
    renderTodayPlanScreen();
  } catch (err) {
    console.error("Failed to load today plan:", err);
    currentTodayPlan = null;
    currentTodayPlanId = "";
    renderTodayPlanScreen();
    alert(err.message || "加载今日计划失败");
  }
}

async function loadTodayPlanOverview(options = {}) {
  try {
    const todayKey = getTodayPlanLocalDateKey();
    const res = await apiFetch(`/api/today-plans/overview?date=${encodeURIComponent(todayKey)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    todayPlanOverview = data;
    if (data.today && options.forceOpenToday) {
      await loadTodayPlan(data.today.id);
      return;
    }
    if (options.showEmptyWhenNoToday && !data.today) {
      currentTodayPlan = null;
      currentTodayPlanId = "";
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
    console.error("Failed to load today plan overview:", err);
    todayPlanOverview = { today: null, history: [] };
    currentTodayPlan = null;
    currentTodayPlanId = "";
    renderTodayPlanScreen();
  }
}

async function createTodayPlanNow() {
  try {
    const res = await apiFetch("/api/today-plan", {
      method: "POST",
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
    console.error("Failed to create today plan:", err);
    alert(err.message || "创建今日计划失败");
  }
}

async function createTodayPlanItemEntry() {
  if (!currentTodayPlanId) {
    await createTodayPlanNow();
    if (!currentTodayPlanId) return;
  }
  try {
    const res = await apiFetch("/api/today-plan/item", {
      method: "POST",
      body: JSON.stringify({ plan_id: currentTodayPlanId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadTodayPlan(currentTodayPlanId);
  } catch (err) {
    console.error("Failed to create today plan item:", err);
    alert(err.message || "新增计划项失败");
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
    const res = await apiFetch("/api/today-plan/item", {
      method: "PATCH",
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
    console.error("Failed to save today plan item:", err);
    alert(err.message || "保存计划项失败");
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
  if (!(await openConfirmDialog(`确认删除计划项「${item?.title || "未命名计划"}」吗？`, { title: "删除计划项" }))) return;
  clearQueuedTodayPlanItemPatch(itemId);
  try {
    const res = await apiFetch("/api/today-plan/item", {
      method: "DELETE",
      body: JSON.stringify({ item_id: itemId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (currentTodayPlanId) {
      await loadTodayPlan(currentTodayPlanId);
    }
  } catch (err) {
    console.error("Failed to delete today plan item:", err);
    alert(err.message || "删除计划项失败");
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
  if (state.branchesByService[service] || state.loadingBranches[service]) return;
  state.loadingBranches[service] = true;
  renderTodayPlanAssociationDialog();
  try {
    const res = await apiFetch(`/api/today-plan/service/branches?service=${encodeURIComponent(service)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    state.branchesByService[service] = Array.isArray(data.branches) ? data.branches : [];
  } catch (err) {
    console.error("Failed to load today plan service branches:", err);
    state.branchesByService[service] = [];
  } finally {
    state.loadingBranches[service] = false;
    renderTodayPlanAssociationDialog();
  }
}

function getTodayPlanAssociationServiceEntry(state, service) {
  return state.associations.services.find((item) => item.service === service) || null;
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
  groupEntry.message_ids = Array.isArray(groupEntry.message_ids) ? groupEntry.message_ids : [];
  if (checked) {
    if (!groupEntry.message_ids.includes(messageId)) {
      groupEntry.message_ids.push(messageId);
    }
  } else {
    groupEntry.message_ids = groupEntry.message_ids.filter((id) => id !== messageId);
    if (groupEntry.message_ids.length === 0) {
      state.associations.chat_selections = state.associations.chat_selections.filter((item) => item.group_jid !== groupJid);
    }
  }
}

function renderTodayPlanAssociationDialog() {
  const state = todayPlanAssociationState;
  if (!state || !todayPlanAssociationOverlay) return;
  const dialog = todayPlanAssociationOverlay.querySelector(".today-plan-association-dialog");
  if (!dialog) return;
  const chatGroups = (state.groups || []).filter((group) => {
    const messages = state.chatMessagesByGroup[group.jid] || [];
    return Array.isArray(messages) && messages.length > 0;
  });
  if (state.activeChatGroupJid && !chatGroups.some((group) => group.jid === state.activeChatGroupJid)) {
    state.activeChatGroupJid = null;
  }
  const activeChatGroup = chatGroups.find((group) => group.jid === state.activeChatGroupJid) || null;
  const activeChatMessages = activeChatGroup ? (state.chatMessagesByGroup[activeChatGroup.jid] || []) : [];
  const activeChatSelection = activeChatGroup ? getTodayPlanAssociationChatEntry(state, activeChatGroup.jid) : null;
  const activeChatSelectedIds = new Set(activeChatSelection && Array.isArray(activeChatSelection.message_ids) ? activeChatSelection.message_ids : []);

  dialog.innerHTML = `
    <div class="today-plan-association-header">
      <div>
        <div class="today-plan-kicker">Associations</div>
        <h3>编辑关联信息</h3>
        <div class="today-plan-subtitle">勾选工作台任务、群聊消息与服务分支。工作台任务关联后会自动带出对应服务与工作分支。</div>
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
        <div class="today-plan-association-title">工作台任务</div>
        <div class="today-plan-option-desc">多选后会在计划页展示当前节点和待处理项。</div>
        <div class="today-plan-association-list">
          ${(state.workbenchTasks || []).map((task) => `
            <label class="today-plan-option-card today-plan-checkbox-row">
              <input type="checkbox" data-today-plan-association="task" value="${escapeAttribute(task.id)}" ${state.associations.workbench_task_ids.includes(task.id) ? "checked" : ""} />
              <div>
                <div class="today-plan-option-title">${escapeHtml(task.title || task.id)}</div>
                <div class="today-plan-option-desc">${escapeHtml(task.service || "--")} · ${escapeHtml(task.workflow_stage_label || task.workflow_status_label || "--")}</div>
              </div>
            </label>
          `).join("") || '<div class="today-plan-empty-inline">暂无工作台任务</div>'}
        </div>
      </section>
      <section class="today-plan-association-column">
        <div class="today-plan-association-title">群聊消息</div>
        <div class="today-plan-option-desc">仅展示每个群今天最新的 200 条消息；点击群聊后在对话框中多选消息。</div>
        <div class="today-plan-association-list">
          ${chatGroups.map((group) => {
            const selectedCount = getTodayPlanAssociationChatSelectionCount(getTodayPlanAssociationChatEntry(state, group.jid));
            const messages = state.chatMessagesByGroup[group.jid] || [];
            const active = activeChatGroup && activeChatGroup.jid === group.jid;
            const latestMessage = messages[messages.length - 1] || null;
            return `
              <button type="button" class="today-plan-option-card today-plan-chat-group-btn${active ? " active" : ""}" data-today-plan-open-chat-group="${escapeAttribute(group.jid)}">
                <div class="today-plan-option-title">${escapeHtml(group.name || group.jid)}</div>
                <div class="today-plan-option-desc">${escapeHtml(group.folder || "")}</div>
                <div class="today-plan-pill-row">
                  <span class="today-plan-meta-pill">今日 ${escapeHtml(String(messages.length))} 条</span>
                  <span class="today-plan-meta-pill">已选 ${escapeHtml(String(selectedCount))} 条</span>
                </div>
                ${latestMessage ? `<div class="today-plan-description">${escapeHtml((latestMessage.content || "").replace(/\s+/g, " ").trim() || "无内容")}</div>` : ""}
              </button>
            `;
          }).join("") || '<div class="today-plan-empty-inline">今天没有可关联的群聊消息。</div>'}
        </div>
      </section>
      <section class="today-plan-association-column">
        <div class="today-plan-association-title">服务与分支</div>
        <div class="today-plan-option-desc">先选择服务，再为每个服务勾选一个或多个分支。</div>
        <div class="today-plan-association-list">
          ${(state.serviceOptions || []).map((service) => {
            const selected = getTodayPlanAssociationServiceEntry(state, service.service);
            const branches = state.branchesByService[service.service] || [];
            const loading = Boolean(state.loadingBranches[service.service]);
            const selectedBranchCount = selected && Array.isArray(selected.branches) ? selected.branches.length : 0;
            return `
              <div class="today-plan-option-card today-plan-service-option-card${selected ? " active" : ""}">
                <label class="today-plan-checkbox-row today-plan-service-option-head">
                  <input type="checkbox" data-today-plan-association="service" value="${escapeAttribute(service.service)}" ${selected ? "checked" : ""} />
                  <div class="today-plan-service-option-main">
                    <div class="today-plan-option-title">${escapeHtml(service.service)}</div>
                    <div class="today-plan-option-desc">${escapeHtml(service.repo_path || "未配置仓库路径")}</div>
                  </div>
                  ${selected ? `<span class="today-plan-meta-pill">已选 ${escapeHtml(String(selectedBranchCount))} 个分支</span>` : ""}
                </label>
                ${selected ? `
                  <div class="today-plan-service-branch-panel">
                    <div class="today-plan-service-branch-summary">
                      <span>分支选择</span>
                      <span>${loading ? "加载中" : `共 ${escapeHtml(String(branches.length))} 个`}</span>
                    </div>
                    ${loading ? '<div class="today-plan-empty-inline">正在加载分支...</div>' : branches.length > 0 ? `
                      <div class="today-plan-service-branch-list">
                        ${branches.map((branch) => `
                      <label class="today-plan-checkbox-row today-plan-service-branch-row">
                        <input type="checkbox" data-today-plan-association="branch" data-service-name="${escapeAttribute(service.service)}" value="${escapeAttribute(branch.name)}" ${selected.branches.includes(branch.name) ? "checked" : ""} />
                        <div>
                          <div class="today-plan-option-title">${escapeHtml(branch.name)}</div>
                          <div class="today-plan-option-desc">${branch.current ? "当前分支" : branch.source === "remote" ? "远端分支" : "本地分支"}${branch.default_branch ? " · 默认分支" : ""}${branch.staging_branch ? " · 预发分支" : ""}</div>
                        </div>
                      </label>
                        `).join("")}
                      </div>
                    ` : '<div class="today-plan-empty-inline">没有可用分支</div>'}
                  </div>
                ` : ""}
              </div>
            `;
          }).join("") || '<div class="today-plan-empty-inline">暂无服务配置</div>'}
        </div>
      </section>
    </div>
    <div class="today-plan-association-footer">
      <button type="button" class="btn-ghost" data-today-plan-close-associations>取消</button>
      <button type="button" class="btn-primary" data-today-plan-save-associations>保存关联</button>
    </div>
    ${activeChatGroup ? `
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
            <button type="button" class="btn-ghost" data-today-plan-clear-chat-selection="${escapeAttribute(activeChatGroup.jid)}" ${activeChatSelectedIds.size === 0 ? "disabled" : ""}>清空已选</button>
          </div>
          <div class="today-plan-chat-picker-list">
            ${activeChatMessages.map((message) => {
              const selected = activeChatSelectedIds.has(message.id);
              return `
                <button type="button" class="today-plan-chat-picker-message${selected ? " selected" : ""}${message.is_from_me ? " from-me" : ""}${message.is_bot_message ? " bot" : ""}" data-today-plan-chat-message="${escapeAttribute(message.id)}" data-group-jid="${escapeAttribute(activeChatGroup.jid)}">
                  <span class="today-plan-chat-picker-check">${selected ? "✓" : ""}</span>
                    <div class="today-plan-chat-picker-content">
                      <div class="today-plan-chat-picker-meta">
                        <span>${escapeHtml(message.sender_name || message.sender || "未知")}</span>
                        <span>${escapeHtml(formatDateTime(message.timestamp || ""))}</span>
                      </div>
                      ${renderTodayPlanReplyQuote(message)}
                      <div class="today-plan-chat-picker-body">${renderTodayPlanMessageBody(message)}</div>
                    </div>
                </button>
              `;
            }).join("") || '<div class="today-plan-empty-inline">今天没有可选择的消息。</div>'}
          </div>
        </div>
      </div>
    ` : ""}
  `;

  Array.from(dialog.querySelectorAll("[data-today-plan-close-associations]")).forEach((button) => {
    button.addEventListener("click", () => {
      closeTodayPlanAssociationDialog();
    });
  });

  Array.from(dialog.querySelectorAll('[data-today-plan-association="task"]')).forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const taskId = checkbox.value;
      if (checkbox.checked) {
        if (!state.associations.workbench_task_ids.includes(taskId)) {
          state.associations.workbench_task_ids.push(taskId);
        }
      } else {
        state.associations.workbench_task_ids = state.associations.workbench_task_ids.filter((id) => id !== taskId);
      }
    });
  });

  Array.from(dialog.querySelectorAll("[data-today-plan-open-chat-group]")).forEach((button) => {
    button.addEventListener("click", () => {
      state.activeChatGroupJid = button.getAttribute("data-today-plan-open-chat-group") || null;
      renderTodayPlanAssociationDialog();
    });
  });

  Array.from(dialog.querySelectorAll("[data-today-plan-close-chat-picker]")).forEach((button) => {
    button.addEventListener("click", () => {
      state.activeChatGroupJid = null;
      renderTodayPlanAssociationDialog();
    });
  });

  Array.from(dialog.querySelectorAll("[data-today-plan-chat-picker-overlay]")).forEach((overlay) => {
    overlay.addEventListener("click", (event) => {
      if (event.target !== overlay) return;
      state.activeChatGroupJid = null;
      renderTodayPlanAssociationDialog();
    });
  });

  Array.from(dialog.querySelectorAll("[data-today-plan-chat-message]")).forEach((button) => {
    button.addEventListener("click", () => {
      const groupJid = button.getAttribute("data-group-jid") || "";
      const messageId = button.getAttribute("data-today-plan-chat-message") || "";
      if (!groupJid || !messageId) return;
      const selection = getTodayPlanAssociationChatEntry(state, groupJid);
      const selected = Boolean(selection && Array.isArray(selection.message_ids) && selection.message_ids.includes(messageId));
      updateTodayPlanChatSelection(state, groupJid, messageId, !selected);
      renderTodayPlanAssociationDialog();
    });
  });

  Array.from(dialog.querySelectorAll("[data-today-plan-clear-chat-selection]")).forEach((button) => {
    button.addEventListener("click", () => {
      const groupJid = button.getAttribute("data-today-plan-clear-chat-selection") || "";
      if (!groupJid) return;
      state.associations.chat_selections = state.associations.chat_selections.filter((item) => item.group_jid !== groupJid);
      renderTodayPlanAssociationDialog();
    });
  });

  Array.from(dialog.querySelectorAll('[data-today-plan-association="service"]')).forEach((checkbox) => {
    checkbox.addEventListener("change", async () => {
      const serviceName = checkbox.value;
      if (checkbox.checked) {
        if (!getTodayPlanAssociationServiceEntry(state, serviceName)) {
          state.associations.services.push({ service: serviceName, branches: [] });
        }
        renderTodayPlanAssociationDialog();
        await ensureTodayPlanServiceBranchesLoaded(state, serviceName);
      } else {
        state.associations.services = state.associations.services.filter((item) => item.service !== serviceName);
        renderTodayPlanAssociationDialog();
      }
    });
  });

  Array.from(dialog.querySelectorAll('[data-today-plan-association="branch"]')).forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const serviceName = checkbox.getAttribute("data-service-name") || "";
      const serviceEntry = getTodayPlanAssociationServiceEntry(state, serviceName);
      if (!serviceEntry) return;
      if (checkbox.checked) {
        if (!serviceEntry.branches.includes(checkbox.value)) {
          serviceEntry.branches.push(checkbox.value);
        }
      } else {
        serviceEntry.branches = serviceEntry.branches.filter((branch) => branch !== checkbox.value);
      }
      renderTodayPlanAssociationDialog();
    });
  });

  const saveBtn = dialog.querySelector("[data-today-plan-save-associations]");
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      try {
        const res = await apiFetch("/api/today-plan/item", {
          method: "PATCH",
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
        console.error("Failed to save today plan associations:", err);
        alert(err.message || "保存关联失败");
      }
    });
  }
}

async function openTodayPlanAssociationDialog(itemId) {
  const item = getTodayPlanItem(itemId);
  if (!item) return;
  closeTodayPlanAssociationDialog();
  try {
    const [taskRes, serviceRes] = await Promise.all([
      apiFetch("/api/workbench/tasks"),
      apiFetch("/api/today-plan/services"),
    ]);
    const taskData = await taskRes.json();
    const serviceData = await serviceRes.json();
    if (!taskRes.ok) throw new Error(taskData.error || `HTTP ${taskRes.status}`);
    if (!serviceRes.ok) throw new Error(serviceData.error || `HTTP ${serviceRes.status}`);

    const chatMessagesByGroup = {};
    const groupsWithMessages = [];

    await Promise.all((groups || []).map(async (group) => {
      try {
        const res = await apiFetch(`/api/today-plan/chat/options?jid=${encodeURIComponent(group.jid)}`);
        const data = await res.json();
        chatMessagesByGroup[group.jid] = Array.isArray(data.messages) ? data.messages : [];
        if (chatMessagesByGroup[group.jid].length > 0) {
          groupsWithMessages.push(group);
        }
      } catch (err) {
        console.error("Failed to load today plan chat options:", err);
        chatMessagesByGroup[group.jid] = [];
      }
    }));

    groupsWithMessages.sort((left, right) => {
      const leftMessages = chatMessagesByGroup[left.jid] || [];
      const rightMessages = chatMessagesByGroup[right.jid] || [];
      const leftLatest = leftMessages[leftMessages.length - 1];
      const rightLatest = rightMessages[rightMessages.length - 1];
      const leftRaw = (leftLatest && leftLatest.timestamp) || "";
      const rightRaw = (rightLatest && rightLatest.timestamp) || "";
      const leftNumeric = Number(leftRaw);
      const rightNumeric = Number(rightRaw);
      const leftTimestamp = Number.isFinite(leftNumeric) && leftNumeric > 0 ? leftNumeric : (Date.parse(leftRaw) || 0);
      const rightTimestamp = Number.isFinite(rightNumeric) && rightNumeric > 0 ? rightNumeric : (Date.parse(rightRaw) || 0);
      return rightTimestamp - leftTimestamp;
    });

    todayPlanAssociationState = {
      itemId,
      groups: groupsWithMessages,
      workbenchTasks: Array.isArray(taskData.tasks) ? taskData.tasks : [],
      serviceOptions: Array.isArray(serviceData.services) ? serviceData.services : [],
      chatMessagesByGroup,
      branchesByService: {},
      loadingBranches: {},
      activeChatGroupJid: null,
      associations: cloneTodayPlanAssociations(item.associations),
    };

    todayPlanAssociationOverlay = document.createElement("div");
    todayPlanAssociationOverlay.className = "today-plan-association-overlay";
    todayPlanAssociationOverlay.innerHTML = `
      <div class="today-plan-association-mask"></div>
      <div class="today-plan-association-dialog"></div>
    `;
    todayPlanAssociationOverlay.querySelector(".today-plan-association-mask").addEventListener("click", () => {
      closeTodayPlanAssociationDialog();
    });
    document.body.appendChild(todayPlanAssociationOverlay);

    const selectedServices = todayPlanAssociationState.associations.services.map((item2) => item2.service);
    await Promise.all(selectedServices.map((service) => ensureTodayPlanServiceBranchesLoaded(todayPlanAssociationState, service)));
    renderTodayPlanAssociationDialog();
  } catch (err) {
    console.error("Failed to open today plan association dialog:", err);
    alert(err.message || "加载关联信息失败");
  }
}

function closeTodayPlanCommitDialog() {
  if (todayPlanCommitModal) {
    todayPlanCommitModal.classList.add("hidden");
  }
  if (todayPlanCommitTitle) todayPlanCommitTitle.textContent = "提交详情";
  if (todayPlanCommitMeta) todayPlanCommitMeta.textContent = "";
  if (todayPlanCommitDiff) todayPlanCommitDiff.textContent = "";
}

function renderTodayPlanCommitDiff(diffText) {
  if (!todayPlanCommitDiff) return;
  const html = (diffText || "").split("\n").map((line) => {
    const klass = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") || line.startsWith("diff --git") || line.startsWith("index ") ? "meta" : "";
    return `<span class="today-plan-diff-line${klass ? ` ${klass}` : ""}">${escapeHtml(line)}</span>`;
  }).join("");
  todayPlanCommitDiff.innerHTML = html || escapeHtml("当前 commit 没有可展示的 diff。");
}

async function openTodayPlanCommitDialog(service, commit) {
  try {
    const res = await apiFetch(`/api/today-plan/service/commit?service=${encodeURIComponent(service)}&commit=${encodeURIComponent(commit)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (todayPlanCommitTitle) {
      todayPlanCommitTitle.textContent = data.commit && data.commit.subject ? data.commit.subject : commit;
    }
    if (todayPlanCommitMeta) {
      const meta = [];
      if (data.service) meta.push(data.service);
      if (data.commit && data.commit.hash) meta.push(data.commit.hash);
      if (data.commit && data.commit.author) meta.push(data.commit.author);
      if (data.commit && data.commit.committed_at) meta.push(formatDateTime(data.commit.committed_at));
      todayPlanCommitMeta.textContent = meta.join(" · ");
    }
    renderTodayPlanCommitDiff(data.diff || data.error || "");
    if (todayPlanCommitModal) {
      todayPlanCommitModal.classList.remove("hidden");
    }
  } catch (err) {
    console.error("Failed to load today plan commit diff:", err);
    alert(err.message || "加载 commit diff 失败");
  }
}

async function sendTodayPlanMail() {
  if (!currentTodayPlanId) return;
  try {
    const result = await openTodayPlanMailSendDialog({
      name: todayPlanMailSenderName || "",
      to: todayPlanMailToText || "",
      cc: todayPlanMailCcText || "",
    }, {
      prepareDraft: async (formData) => {
        const name = String(formData.name || "").trim();
        const toText = String(formData.to || "").trim();
        const ccText = String(formData.cc || "").trim();
        const to = parseTodayPlanMailRecipientsInput(toText);
        const cc = parseTodayPlanMailRecipientsInput(ccText);
        todayPlanMailSenderName = name;
        todayPlanMailToText = toText;
        todayPlanMailCcText = ccText;
        const prepareRes = await apiFetch("/api/today-plan/mail/prepare", {
          method: "POST",
          body: JSON.stringify({ plan_id: currentTodayPlanId, name, to, cc }),
        });
        const prepareData = await prepareRes.json();
        if (!prepareRes.ok) throw new Error(prepareData.error || `HTTP ${prepareRes.status}`);
        return prepareData.draft || null;
      },
      confirmDraft: async (draft) => {
        const confirmRes = await apiFetch("/api/today-plan/mail/confirm", {
          method: "POST",
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
        if (!confirmRes.ok) throw new Error(confirmData.error || `HTTP ${confirmRes.status}`);
        return confirmData.draft || draft;
      },
    });
    if (!result || !result.draft) return;
    const sentDraft = result.draft || {};
    const recipientCount = Array.isArray(sentDraft.to) ? sentDraft.to.length : 0;
    showToast(recipientCount > 0 ? `计划邮件已发送 · ${recipientCount} 位收件人` : "计划邮件已发送", 2200);
  } catch (err) {
    console.error("Failed to send today plan mail:", err);
    alert(err.message || "发送计划邮件失败");
  }
}

// Auto-start on page load
initTakeCopterCursor();
initChatBgParticleNudge();
bindNotificationClickHandler();
bindNotificationPermissionPrimer();
bindCardsRowEvents();
bindCardsDragEvents();
initStandaloneQuickChatMode();
window.addEventListener("focus", clearCurrentGroupUnreadIfForeground);
document.addEventListener("visibilitychange", clearCurrentGroupUnreadIfForeground);
connectWS();
loadGroups();
warmWorkflowCreateOptions();

// --- Event listeners ---
if (primaryNav) {
  setPrimaryNav(activePrimaryNavKey);
}
if (window.nanoclawApp && typeof window.nanoclawApp.onCyclePrimaryNav === "function") {
  window.nanoclawApp.onCyclePrimaryNav(() => {
    cyclePrimaryNav(1);
  });
}
if (window.nanoclawApp && typeof window.nanoclawApp.onToggleTodayPlan === "function") {
  window.nanoclawApp.onToggleTodayPlan(() => {
    toggleTodayPlanScreen();
  });
}
if (window.nanoclawApp && typeof window.nanoclawApp.onQuickChatOpenMainGroup === "function") {
  window.nanoclawApp.onQuickChatOpenMainGroup(async () => {
    const mainGroup = getMainGroup();
    if (!mainGroup) return;
    if (activePrimaryNavKey !== "agent-groups") {
      setPrimaryNav("agent-groups");
    }
    await selectGroup(mainGroup.jid);
  });
}
primaryNavItems.forEach((item) => {
  item.addEventListener("click", () => {
    const navKey = item.getAttribute("data-nav-key") || "";
    setPrimaryNav(navKey);
  });
});
if (todayPlanRefreshBtn) {
  todayPlanRefreshBtn.addEventListener("click", async () => {
    await loadTodayPlanOverview({ forceOpenToday: !currentTodayPlanId });
  });
}
if (todayPlanViewHistoryBtn) {
  todayPlanViewHistoryBtn.addEventListener("click", () => {
    openTodayPlanHistoryModal("view");
  });
}
if (todayPlanContinuePlanBtn) {
  todayPlanContinuePlanBtn.addEventListener("click", () => {
    openTodayPlanHistoryModal("continue");
  });
}
if (todayPlanCreateTodayBtn) {
  todayPlanCreateTodayBtn.addEventListener("click", async () => {
    await openOrCreateTodayPlanEntry();
  });
}
if (todayPlanEmptyCreateBtn) {
  todayPlanEmptyCreateBtn.addEventListener("click", async () => {
    await openOrCreateTodayPlanEntry();
  });
}
if (todayPlanEmptyContinueBtn) {
  todayPlanEmptyContinueBtn.addEventListener("click", () => {
    openTodayPlanHistoryModal("continue");
  });
}
if (todayPlanAddItemBtn) {
  todayPlanAddItemBtn.addEventListener("click", async () => {
    await createTodayPlanItemEntry();
  });
}
if (todayPlanSendMailBtn) {
  todayPlanSendMailBtn.addEventListener("click", async () => {
    await sendTodayPlanMail();
  });
}
if (todayPlanCompleteBtn) {
  todayPlanCompleteBtn.addEventListener("click", async () => {
    await completeCurrentTodayPlan();
  });
}
if (todayPlanCommitCloseBtn) {
  todayPlanCommitCloseBtn.addEventListener("click", () => {
    closeTodayPlanCommitDialog();
  });
}
if (todayPlanCommitMask) {
  todayPlanCommitMask.addEventListener("click", () => {
    closeTodayPlanCommitDialog();
  });
}
if (todayPlanHistoryCloseBtn) {
  todayPlanHistoryCloseBtn.addEventListener("click", () => {
    closeTodayPlanHistoryModal();
  });
}
if (todayPlanHistoryMask) {
  todayPlanHistoryMask.addEventListener("click", () => {
    closeTodayPlanHistoryModal();
  });
}
if (workbenchRefreshBtn) {
  workbenchRefreshBtn.addEventListener("click", async () => {
    await refreshWorkbenchView();
  });
}
if (workbenchCreateTaskBtn) {
  workbenchCreateTaskBtn.addEventListener("click", async () => {
    try {
      await openWorkbenchCreateTaskModal();
    } catch (err) {
      console.error("Failed to open workbench create dialog:", err);
      alert(err.message || "打开创建任务失败");
    }
  });
}
if (workbenchDeleteAllBtn) {
  workbenchDeleteAllBtn.addEventListener("click", () => {
    deleteAllWorkbenchTaskData();
  });
}
if (workflowDefinitionRefreshBtn) {
  workflowDefinitionRefreshBtn.addEventListener("click", async () => {
    await loadWorkflowDefinitions({ preserveSelection: true });
  });
}
if (workflowDefinitionCreateBtn) {
  workflowDefinitionCreateBtn.addEventListener("click", async () => {
    await createWorkflowDefinition();
  });
}
if (cardsManagementRefreshBtn) {
  cardsManagementRefreshBtn.addEventListener("click", async () => {
    await loadCardsRegistry({ preserveSelection: true });
  });
}
if (cardsManagementCreateBtn) {
  cardsManagementCreateBtn.addEventListener("click", async () => {
    await createCardDraft();
  });
}
if (cardsManagementSaveBtn) {
  cardsManagementSaveBtn.addEventListener("click", async () => {
    if (!cardsManagementEditMode) {
      beginCardsEditing();
      return;
    }
    await saveCurrentCard();
  });
}
if (cardsManagementCancelBtn) {
  cardsManagementCancelBtn.addEventListener("click", () => {
    cancelCardsEditing();
  });
}
if (cardsManagementActionAddBtn) {
  cardsManagementActionAddBtn.addEventListener("click", () => {
    if (!cardsManagementEditMode) return;
    addCardActionRow();
  });
}
if (cardsManagementFormToggleBtn) {
  cardsManagementFormToggleBtn.addEventListener("click", () => {
    if (!cardsManagementEditMode) return;
    toggleCardFormPanel();
  });
}
if (cardsManagementFormFieldAddBtn) {
  cardsManagementFormFieldAddBtn.addEventListener("click", () => {
    if (!cardsManagementEditMode) return;
    addCardFormFieldRow();
  });
}
if (cardsManagementSectionAddBtn) {
  cardsManagementSectionAddBtn.addEventListener("click", () => {
    if (!cardsManagementEditMode) return;
    addCardSectionRow();
  });
}
[
  cardsManagementWorkflowTypeInput,
  cardsManagementCardKeyInput,
  cardsManagementPatternInput,
  cardsManagementHeaderColorInput,
  cardsManagementHeaderTitleInput,
  cardsManagementBodyTemplateInput,
  cardsManagementFormNameInput,
  cardsManagementFormSubmitIdInput,
  cardsManagementFormSubmitLabelInput,
  cardsManagementFormSubmitTypeInput,
].forEach((input) => {
  if (!input) return;
  input.addEventListener("input", () => {
    if (!cardsManagementEditMode) return;
    clearCardsFieldErrors();
    const state = syncCurrentCardDraftFromEditor() || readCurrentCardEditorState();
    renderCardsDerivedPanels(state);
  });
  input.addEventListener("change", () => {
    if (!cardsManagementEditMode) return;
    clearCardsFieldErrors();
    const state = syncCurrentCardDraftFromEditor() || readCurrentCardEditorState();
    renderCardsDerivedPanels(state);
  });
});
if (cardsManagementPreviewPreset) {
  cardsManagementPreviewPreset.addEventListener("change", () => {
    syncCardsPreviewDataInputFromPreset();
    const state = readCurrentCardEditorState();
    renderCardsDerivedPanels(state);
  });
}
if (cardsManagementPreviewData) {
  cardsManagementPreviewData.addEventListener("input", () => {
    const state = readCurrentCardEditorState();
    renderCardsDerivedPanels(state);
  });
}
if (workflowDefinitionSaveBtn) {
  workflowDefinitionSaveBtn.addEventListener("click", async () => {
    await saveWorkflowDefinitionDraft();
  });
}
if (workflowDefinitionPublishBtn) {
  workflowDefinitionPublishBtn.addEventListener("click", async () => {
    await publishWorkflowDefinitionDraft();
  });
}
if (workflowDefinitionViewFormBtn) {
  workflowDefinitionViewFormBtn.addEventListener("click", () => {
    setWorkflowDefinitionViewMode("form");
  });
}
if (workflowDefinitionViewJsonBtn) {
  workflowDefinitionViewJsonBtn.addEventListener("click", () => {
    setWorkflowDefinitionViewMode("json");
  });
}
if (workflowDefinitionViewGraphBtn) {
  workflowDefinitionViewGraphBtn.addEventListener("click", () => {
    setWorkflowDefinitionViewMode("graph");
  });
}
if (workflowDefinitionDiffCloseBtn) {
  workflowDefinitionDiffCloseBtn.addEventListener("click", () => {
    closeWorkflowDefinitionDiffModal();
  });
}
if (workflowDefinitionDiffModal) {
  workflowDefinitionDiffModal.addEventListener("click", (event) => {
    if (event.target === workflowDefinitionDiffModal) {
      closeWorkflowDefinitionDiffModal();
    }
  });
}
if (workflowDefinitionStateAddBtn) {
  workflowDefinitionStateAddBtn.addEventListener("click", () => {
    addWorkflowDefinitionState();
  });
}
if (workflowDefinitionRoleAddBtn) {
  workflowDefinitionRoleAddBtn.addEventListener("click", () => {
    addWorkflowDefinitionRole();
  });
}
if (workflowDefinitionEntryPointAddBtn) {
  workflowDefinitionEntryPointAddBtn.addEventListener("click", () => {
    addWorkflowDefinitionEntryPoint();
  });
}
if (workflowDefinitionStatusLabelAddBtn) {
  workflowDefinitionStatusLabelAddBtn.addEventListener("click", () => {
    addWorkflowDefinitionStatusLabel();
  });
}
if (workflowDefinitionPreviewCreateFormBtn) {
  workflowDefinitionPreviewCreateFormBtn.addEventListener("click", () => {
    openWorkflowDefinitionCreateFormPreview();
  });
}
if (workflowDefinitionCreateFormFieldAddBtn) {
  workflowDefinitionCreateFormFieldAddBtn.addEventListener("click", () => {
    addWorkflowDefinitionCreateFormField();
  });
}
if (workflowDefinitionStatesInput) {
  workflowDefinitionStatesInput.addEventListener("input", () => {
    const editable = getEditableWorkflowDefinition();
    const parsedStates = (() => {
      try {
        return getStatesFromEditor();
      } catch {
        return editable?.states || {};
      }
    })();
    if (editable) {
      editable.states = parsedStates;
    }
    renderWorkflowDefinitionStateEditor(parsedStates);
    const graphSource = {
      states: parsedStates,
      entry_points: editable?.entry_points || {},
    };
    renderWorkflowDefinitionGraph(graphSource);
  });
}
if (workflowDefinitionRolesInput) {
  workflowDefinitionRolesInput.addEventListener("input", () => {
    const editable = getEditableWorkflowDefinition();
    const parsedRoles = (() => {
      try {
        return getRolesFromEditor();
      } catch {
        return editable?.roles || {};
      }
    })();
    if (editable) editable.roles = parsedRoles;
    renderWorkflowDefinitionRoleEditor(parsedRoles);
    renderWorkflowDefinitionStateEditor();
  });
}
if (workflowDefinitionEntryPointsInput) {
  workflowDefinitionEntryPointsInput.addEventListener("input", () => {
    const editable = getEditableWorkflowDefinition();
    const parsedEntryPoints = (() => {
      try {
        return getEntryPointsFromEditor();
      } catch {
        return editable?.entry_points || {};
      }
    })();
    if (editable) editable.entry_points = parsedEntryPoints;
    renderWorkflowDefinitionEntryPointEditor(parsedEntryPoints);
    const parsedStates = (() => {
      try {
        return getStatesFromEditor();
      } catch {
        return editable?.states || {};
      }
    })();
    renderWorkflowDefinitionGraph({
      states: parsedStates,
      entry_points: parsedEntryPoints,
    });
  });
}
if (workflowDefinitionStatusLabelsInput) {
  workflowDefinitionStatusLabelsInput.addEventListener("input", () => {
    const editable = getEditableWorkflowDefinition();
    const parsedStatusLabels = (() => {
      try {
        return getStatusLabelsFromEditor();
      } catch {
        return editable?.status_labels || {};
      }
    })();
    if (editable) editable.status_labels = parsedStatusLabels;
    renderWorkflowDefinitionStatusLabelEditor(parsedStatusLabels);
  });
}
if (workbenchCommentSubmit) {
  workbenchCommentSubmit.addEventListener("click", () => {
    submitWorkbenchComment();
  });
}
if (workbenchAddLinkBtn) {
  workbenchAddLinkBtn.addEventListener("click", () => {
    addWorkbenchLinkAsset();
  });
}
if (workbenchAddFileBtn) {
  workbenchAddFileBtn.addEventListener("click", () => {
    addWorkbenchFileAsset();
  });
}
if (memorySearchBtn) {
  memorySearchBtn.addEventListener("click", () => {
    loadMemories(memorySearchInput?.value || "");
  });
}
if (memoryDoctorBtn) {
  memoryDoctorBtn.addEventListener("click", () => {
    runDoctor(7);
  });
}
if (memoryMetricsBtn) {
  memoryMetricsBtn.addEventListener("click", () => {
    showMemoryMetrics(24);
  });
}
if (memoryDoctorCloseBtn) {
  memoryDoctorCloseBtn.addEventListener("click", () => {
    closeDoctorPanel();
  });
}
if (memoryMetricsCloseBtn) {
  memoryMetricsCloseBtn.addEventListener("click", () => {
    closeMemoryMetricsModal();
  });
}
if (memoryCreateBtn) {
  memoryCreateBtn.addEventListener("click", () => {
    openCreateMemoryEditor();
  });
}
if (traceMonitorRefreshBtn) {
  traceMonitorRefreshBtn.addEventListener("click", () => {
    loadTraceMonitorData({ force: true });
  });
}
if (traceMonitorClearHistoryBtn) {
  traceMonitorClearHistoryBtn.addEventListener("click", () => {
    clearAllTraceHistory();
  });
}
if (traceMonitorList) {
  traceMonitorList.addEventListener("scroll", () => {
    if (activePrimaryNavKey !== "trace-monitor" || activeTraceMonitorScope !== "history") return;
    if (traceMonitorHistoryLoading || !traceMonitorHistoryHasMore) return;
    const threshold = 80;
    const distanceToBottom =
      traceMonitorList.scrollHeight - traceMonitorList.scrollTop - traceMonitorList.clientHeight;
    if (distanceToBottom <= threshold) {
      loadMoreTraceHistory();
    }
  });
}
traceMonitorScopeBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const scope = btn.getAttribute("data-trace-scope") || "active";
    setTraceMonitorScope(scope);
  });
});
if (memoryRefreshBtn) {
  memoryRefreshBtn.addEventListener("click", () => {
    loadMemories(memorySearchInput?.value || "");
  });
}
if (memorySaveBtn) {
  memorySaveBtn.addEventListener("click", () => {
    saveMemoryEditor();
  });
}
if (memoryCancelBtn) {
  memoryCancelBtn.addEventListener("click", () => {
    closeMemoryEditor();
  });
}
if (memorySearchInput) {
  memorySearchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      loadMemories(memorySearchInput.value || "");
    }
  });
}
if (memoryStatusFilter) {
  memoryStatusFilter.addEventListener("change", () => {
    memoryStatusFilterValue = memoryStatusFilter.value || "all";
    renderMemoryList();
  });
}
if (memoryGcDuplicatesBtn) {
  memoryGcDuplicatesBtn.addEventListener("click", () => {
    runGcByMode("duplicates");
  });
}
if (memoryGcStaleBtn) {
  memoryGcStaleBtn.addEventListener("click", () => {
    runGcByMode("stale");
  });
}
if (memoryModalMask) {
  memoryModalMask.addEventListener("click", () => {
    closeMemoryEditor();
    closeDoctorPanel();
    closeMemoryMetricsModal();
  });
}

sidebarCollapse.addEventListener("click", () => {
  sidebar.classList.toggle("collapsed");
});
if (workbenchSidebarCollapse && workbenchSidebar) {
  workbenchSidebarCollapse.addEventListener("click", () => {
    workbenchSidebar.classList.toggle("collapsed");
  });
}
refreshGroupsBtn.addEventListener("click", () => {
  refreshGroupsBtn.classList.add("spinning");
  setTimeout(() => refreshGroupsBtn.classList.remove("spinning"), 700);
  loadGroups();
  warmWorkflowCreateOptions(true);
  if (currentGroupJid) loadMessages();
});
if (resetAllSessionsBtn) {
  resetAllSessionsBtn.addEventListener("click", () => {
    resetAllSessions();
  });
}
openSchedulersBtn.addEventListener("click", () => {
  if (schedulersPanel.classList.contains("open")) {
    schedulersPanel.classList.remove("open");
    return;
  }
  openSchedulersPanel();
});
deleteAllSchedulersBtn.addEventListener("click", deleteAllSchedulers);
closeSchedulersBtn.addEventListener("click", () => {
  schedulersPanel.classList.remove("open");
});
if (openKnowledgeJobsBtn) {
  openKnowledgeJobsBtn.addEventListener("click", () => {
    if (knowledgeJobsPanel?.classList.contains("open")) {
      knowledgeJobsPanel.classList.remove("open");
      return;
    }
    openKnowledgeJobsPanel();
  });
}
if (knowledgeJobsDeleteFinishedBtn) {
  knowledgeJobsDeleteFinishedBtn.addEventListener("click", () => {
    void deleteFinishedKnowledgeJobs();
  });
}
if (closeKnowledgeJobsBtn) {
  closeKnowledgeJobsBtn.addEventListener("click", () => {
    knowledgeJobsPanel?.classList.remove("open");
  });
}
openAgentStatusBtn.addEventListener("click", () => {
  if (agentStatusPanel.classList.contains("open")) {
    agentStatusPanel.classList.remove("open");
    if (agentStatusInterval) {
      clearInterval(agentStatusInterval);
      agentStatusInterval = null;
    }
    return;
  }
  openAgentStatusPanel();
});
closeAgentStatusBtn.addEventListener("click", () => {
  agentStatusPanel.classList.remove("open");
  if (agentStatusInterval) {
    clearInterval(agentStatusInterval);
    agentStatusInterval = null;
  }
});
sendBtn.addEventListener("click", () => {
  sendMessage(messageInput.value);
});
if (quickChatCloseBtn) {
  quickChatCloseBtn.addEventListener("click", () => {
    closeQuickChat();
  });
}
if (quickChatSendBtn) {
  quickChatSendBtn.addEventListener("click", () => {
    sendQuickChatMessage();
  });
}
if (quickChatOpenMainBtn) {
  quickChatOpenMainBtn.addEventListener("click", async () => {
    const mainGroup = getMainGroup();
    if (!mainGroup) {
      showToast("未找到主群", 2200);
      return;
    }
    if (isStandaloneQuickChat) {
      window.nanoclawApp?.openMainGroupFromQuickChat?.();
      return;
    }
    closeQuickChat();
    await selectGroup(mainGroup.jid);
  });
}
if (quickChatOverlay) {
  quickChatOverlay.addEventListener("mousedown", (e) => {
    if (e.target === quickChatOverlay) {
      closeQuickChat();
    }
  });
}
if (quickChatInput) {
  quickChatInput.addEventListener("input", () => {
    quickChatDraft = quickChatInput.value;
  });
  quickChatInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeQuickChat();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendQuickChatMessage();
    }
  });
}
messageInput.addEventListener("keydown", (e) => {
  // Command palette navigation
  if (commandPalette.classList.contains("visible")) {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      navigateCommandPalette(-1);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      navigateCommandPalette(1);
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      if (cmdPaletteIndex >= 0) {
        e.preventDefault();
        selectCommandPaletteItem();
        return;
      }
    }
    if (e.key === "Escape") {
      hideCommandPalette();
      return;
    }
  }

  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage(messageInput.value);
  }

  // Shift+Enter: insert newline, auto-continue list if current line is a list
  if (e.key === "Enter" && e.shiftKey) {
    e.preventDefault();
    const ta = messageInput;
    const pos = ta.selectionStart;
    const before = ta.value.substring(0, pos);
    const after = ta.value.substring(pos);
    const lineStart = before.lastIndexOf("\n") + 1;
    const lineContent = before.substring(lineStart);

    const olMatch = lineContent.match(/^(\d+)\.\s/);
    const ulMatch = lineContent.match(/^-\s/);

    if (olMatch) {
      const nextNum = parseInt(olMatch[1]) + 1;
      ta.value = before + "\n" + nextNum + ". " + after;
      ta.selectionStart = ta.selectionEnd = pos + 1 + String(nextNum).length + 2;
      autoResizeInput();
    } else if (ulMatch) {
      ta.value = before + "\n- " + after;
      ta.selectionStart = ta.selectionEnd = pos + 3;
      autoResizeInput();
    } else {
      ta.value = before + "\n" + after;
      ta.selectionStart = ta.selectionEnd = pos + 1;
      autoResizeInput();
    }
  }

  if (e.key === "@") {
    e.preventDefault();
    showMentionPicker();
    return;
  }

  if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    showCommandPalette("");
    return;
  }

  // Cmd+Shift+7 = ordered list, Cmd+Shift+8 = unordered list
  if (e.metaKey && e.shiftKey) {
    if (e.key === "7") {
      e.preventDefault();
      insertListPrefix("1. ");
    } else if (e.key === "8") {
      e.preventDefault();
      insertListPrefix("- ");
    }
  }
});

messageInput.addEventListener("input", () => {
  autoResizeInput();
  if (mentionPickerVisible) hideMentionPicker(false);
  // Command palette trigger
  const val = messageInput.value;
  if (val.startsWith("/") && !val.includes(" ")) {
    showCommandPalette(val);
  } else {
    hideCommandPalette();
  }
});

// Reply preview close
replyPreviewClose.addEventListener("click", clearReplyTo);
pendingFilesClose.addEventListener("click", () => {
  pendingFiles = [];
  renderPendingFiles();
});

attachBtn.addEventListener("click", () => {
  fileInput.click();
});
document.getElementById("at-btn").addEventListener("click", () => {
  showMentionPicker();
});

document.addEventListener("mousedown", (e) => {
  if (commandPickerVisible && commandPalette) {
    const target = e.target;
    if (!(commandPalette.contains(target) || (target && target.closest && target.closest("#message-input")))) {
      hideCommandPalette(false);
    }
  }

  if (!mentionPickerVisible || !mentionPicker) return;
  const target = e.target;
  if (mentionPicker.contains(target)) return;
  if (target && target.closest && target.closest("#at-btn")) return;
  hideMentionPicker(false);
});

// Format toolbar - insert list prefix at beginning of current line
function insertListPrefix(prefix) {
  const ta = messageInput;
  const pos = ta.selectionStart;
  const before = ta.value.substring(0, pos);
  const after = ta.value.substring(pos);
  // Find start of current line
  const lineStart = before.lastIndexOf("\n") + 1;
  ta.value = before.substring(0, lineStart) + prefix + before.substring(lineStart) + after;
  ta.selectionStart = ta.selectionEnd = lineStart + prefix.length;
  ta.focus();
  autoResizeInput();
}

document.getElementById("format-toggle-btn").addEventListener("click", () => {
  document.getElementById("format-sub-btns").classList.toggle("hidden");
});
document.getElementById("fmt-ol-btn").addEventListener("click", () => insertListPrefix("1. "));
document.getElementById("fmt-ul-btn").addEventListener("click", () => insertListPrefix("- "));

fileInput.addEventListener("change", () => {
  for (const file of fileInput.files || []) {
    stageFile(file);
  }
  fileInput.value = "";
});
if (knowledgeRefreshBtn) {
  knowledgeRefreshBtn.addEventListener("click", () => {
    loadKnowledgeBaseData({ preserveDetail: true });
  });
}
if (knowledgeClearBtn) {
  knowledgeClearBtn.addEventListener("click", () => {
    void clearKnowledgeWiki();
  });
}
if (knowledgeImportBtn) {
  knowledgeImportBtn.addEventListener("click", () => {
    showKnowledgeImportMenu();
  });
}
if (knowledgeFileInput) {
  knowledgeFileInput.addEventListener("change", () => {
    const files = knowledgeFileInput.files;
    if (files && files.length > 0) {
      void importKnowledgeFiles(files);
    }
    knowledgeFileInput.value = "";
  });
}
if (knowledgeSearchBtn) {
  knowledgeSearchBtn.addEventListener("click", () => {
    void runKnowledgeSearch();
  });
}
if (knowledgeSearchInput) {
  knowledgeSearchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void runKnowledgeSearch();
    }
  });
}
if (knowledgeMaterialFilter) {
  knowledgeMaterialFilter.value = knowledgeMaterialFilterValue;
  knowledgeMaterialFilter.addEventListener("change", () => {
    knowledgeMaterialFilterValue = knowledgeMaterialFilter.value || "all";
    renderKnowledgeMaterials();
  });
}
if (knowledgeDraftStatusFilter) {
  knowledgeDraftStatusFilter.value = knowledgeDraftStatusFilterValue;
  knowledgeDraftStatusFilter.addEventListener("change", () => {
    knowledgeDraftStatusFilterValue = knowledgeDraftStatusFilter.value || "all";
    renderKnowledgeDrafts();
  });
}
if (knowledgeDraftSelectVisibleBtn) {
  knowledgeDraftSelectVisibleBtn.addEventListener("click", () => {
    selectVisibleKnowledgeDrafts();
  });
}
if (knowledgeDraftClearSelectionBtn) {
  knowledgeDraftClearSelectionBtn.addEventListener("click", () => {
    clearKnowledgeDraftSelection();
  });
}
if (knowledgeDraftBulkDeleteBtn) {
  knowledgeDraftBulkDeleteBtn.addEventListener("click", () => {
    void bulkDeleteSelectedKnowledgeDrafts();
  });
}
if (knowledgePageKindFilter) {
  knowledgePageKindFilter.value = knowledgePageKindFilterValue;
  knowledgePageKindFilter.addEventListener("change", () => {
    knowledgePageKindFilterValue = knowledgePageKindFilter.value || "all";
    renderKnowledgePages();
  });
}
document.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (currentGroupJid) fileDropZone.classList.remove("hidden");
});
document.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) fileDropZone.classList.add("hidden");
});
document.addEventListener("drop", (e) => {
  e.preventDefault();
  fileDropZone.classList.add("hidden");
  if (!currentGroupJid) return;
  for (const file of e.dataTransfer?.files || []) {
    stageFile(file);
  }
});

// Infinite scroll
messagesEl.addEventListener("scroll", () => {
  if (messagesEl.scrollTop < 100 && hasMoreHistory && !loadingHistory) {
    loadMoreHistory();
  }
});

// Multi-select
selectModeBtn.addEventListener("click", toggleMultiSelectMode);
copySelectedBtn.addEventListener("click", copySelectedMessages);
deleteSelectedBtn.addEventListener("click", deleteSelectedMessages);
cancelSelectBtn.addEventListener("click", exitMultiSelect);
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && String(e.key || "").toLowerCase() === "w") {
    e.preventDefault();
    toggleTodayPlanScreen();
    return;
  }
  if (e.key === "Escape" && isQuickChatOpen()) {
    e.preventDefault();
    closeQuickChat();
    return;
  }
  if (e.key === "Escape" && todayPlanHistoryModal && !todayPlanHistoryModal.classList.contains("hidden")) {
    e.preventDefault();
    closeTodayPlanHistoryModal();
    return;
  }
  if (e.key === "Escape" && todayPlanAssociationOverlay) {
    e.preventDefault();
    closeTodayPlanAssociationDialog();
    return;
  }
  if (e.key === "Escape" && todayPlanCommitModal && !todayPlanCommitModal.classList.contains("hidden")) {
    e.preventDefault();
    closeTodayPlanCommitDialog();
    return;
  }
  if (e.key === "Escape" && mentionPickerVisible) {
    hideMentionPicker();
    return;
  }
  if (e.key === "Escape" && multiSelectMode) {
    exitMultiSelect();
  }
  // Cmd/Ctrl+1 — toggle schedulers
  if ((e.metaKey || e.ctrlKey) && e.key === "1") {
    e.preventDefault();
    if (schedulersPanel.classList.contains("open")) {
      schedulersPanel.classList.remove("open");
    } else {
      openSchedulersPanel();
    }
    return;
  }
  // Cmd/Ctrl+2 — toggle agent status
  if ((e.metaKey || e.ctrlKey) && e.key === "2") {
    e.preventDefault();
    if (agentStatusPanel.classList.contains("open")) {
      agentStatusPanel.classList.remove("open");
      if (agentStatusInterval) {
        clearInterval(agentStatusInterval);
        agentStatusInterval = null;
      }
    } else {
      openAgentStatusPanel();
    }
    return;
  }
});

//# sourceMappingURL=app.js.map
