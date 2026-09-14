import {
  pgTable,
  text,
  timestamp,
  integer,
  bigint,
  boolean,
  jsonb,
  uniqueIndex,
  index,
  pgEnum,
  doublePrecision,
  customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

const vector1536 = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector(1536)",
  toDriver: (value) => `[${value.join(",")}]`,
  fromDriver: (value) => String(value).slice(1, -1).split(",").filter(Boolean).map(Number),
});

/* ------------------------------------------------------------------ enums */

export const roleEnum = pgEnum("member_role", ["OWNER", "ADMIN", "DEVELOPER", "VIEWER"]);

export const deploymentStatusEnum = pgEnum("deployment_status", [
  "QUEUED",
  "CLONING",
  "BUILDING",
  "TESTING",
  "BUILT",
  "STARTING",
  "HEALTH_CHECKING",
  "HEALTHY",
  "PROMOTING",
  "PROMOTED",
  "DRAINING",
  "STOPPED",
  "FAILED",
  "CANCELED",
  "OBSOLETE",
  "ROLLED_BACK",
]);

export const deploymentTargetEnum = pgEnum("deployment_target", ["PRODUCTION", "PREVIEW"]);

export const jobStatusEnum = pgEnum("job_status", [
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "DEAD",
  "CANCELED",
]);

export const domainStatusEnum = pgEnum("domain_status", [
  "PENDING",
  "DNS_VERIFICATION",
  "VERIFIED",
  "CERTIFICATE_REQUESTED",
  "ACTIVE",
  "FAILED",
  "REMOVING",
  "REMOVED",
]);

export const envScopeEnum = pgEnum("env_scope", ["DEVELOPMENT", "PREVIEW", "PRODUCTION"]);

export const aiPermissionEnum = pgEnum("ai_permission", [
  "READ_ONLY",
  "DEVELOPER",
  "AUTO_FIX",
  "AUTO_DEPLOY",
]);

export const artifactTypeEnum = pgEnum("artifact_type", [
  "IMAGE",
  "BUNDLE",
  "STATIC",
  "LOG",
  "CACHE",
  "REPORT",
]);

/* ------------------------------------------------------------- identities */

export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
    githubLogin: text("github_login"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_uq").on(t.email)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    csrfToken: text("csrf_token").notNull(),
    userAgent: text("user_agent"),
    ip: text("ip"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("sessions_token_uq").on(t.tokenHash), index("sessions_user_idx").on(t.userId)],
);

export const organizations = pgTable(
  "organizations",
  {
    id: id(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    storageBudgetBytes: bigint("storage_budget_bytes", { mode: "number" })
      .notNull()
      .default(50 * 1024 * 1024 * 1024),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("orgs_slug_uq").on(t.slug)],
);

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull().default("DEVELOPER"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("membership_uq").on(t.orgId, t.userId)],
);

/* ----------------------------------------------------------------- github */

export const githubInstallations = pgTable(
  "github_installations",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    installationId: text("installation_id").notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull().default("User"),
    tokenCipher: jsonb("token_cipher"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("gh_installation_uq").on(t.installationId)],
);

export const githubRepositories = pgTable(
  "github_repositories",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    installationId: text("installation_id").references(() => githubInstallations.id, {
      onDelete: "set null",
    }),
    fullName: text("full_name").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    isPrivate: boolean("is_private").notNull().default(false),
    htmlUrl: text("html_url").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("gh_repo_uq").on(t.orgId, t.fullName)],
);

export const githubWebhookDeliveries = pgTable(
  "github_webhook_deliveries",
  {
    id: id(),
    deliveryId: text("delivery_id").notNull(),
    event: text("event").notNull(),
    projectId: text("project_id"),
    repoFullName: text("repo_full_name"),
    signatureValid: boolean("signature_valid").notNull().default(false),
    processed: boolean("processed").notNull().default(false),
    duplicate: boolean("duplicate").notNull().default(false),
    result: text("result"),
    payloadDigest: text("payload_digest").notNull(),
    receivedAt: createdAt(),
  },
  (t) => [uniqueIndex("gh_delivery_uq").on(t.deliveryId)],
);

/* --------------------------------------------------------------- projects */

export const projects = pgTable(
  "projects",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    repoFullName: text("repo_full_name").notNull(),
    repoUrl: text("repo_url").notNull(),
    productionBranch: text("production_branch").notNull().default("main"),
    enabled: boolean("enabled").notNull().default(true),
    previewsEnabled: boolean("previews_enabled").notNull().default(true),
    desiredCommitSha: text("desired_commit_sha"),
    desiredDeploymentId: text("desired_deployment_id"),
    currentHealthyDeploymentId: text("current_healthy_deployment_id"),
    lastSuccessfulCommitSha: text("last_successful_commit_sha"),
    lastFailedCommitSha: text("last_failed_commit_sha"),
    deploymentGeneration: integer("deployment_generation").notNull().default(0),
    deploymentCounter: integer("deployment_counter").notNull().default(0),
    rootDirectory: text("root_directory").notNull().default("."),
    packageManager: text("package_manager"),
    installCommand: text("install_command"),
    buildCommand: text("build_command"),
    startCommand: text("start_command"),
    testCommand: text("test_command"),
    outputDirectory: text("output_directory"),
    framework: text("framework"),
    nodeVersion: text("node_version").notNull().default("22"),
    runtimePort: integer("runtime_port").notNull().default(3000),
    configVersion: integer("config_version").notNull().default(1),
    healthPath: text("health_path").notNull().default("/"),
    healthExpectedStatus: integer("health_expected_status").notNull().default(200),
    healthTimeoutMs: integer("health_timeout_ms").notNull().default(5000),
    healthInitialDelayMs: integer("health_initial_delay_ms").notNull().default(1500),
    healthIntervalMs: integer("health_interval_ms").notNull().default(2000),
    healthRetries: integer("health_retries").notNull().default(20),
    postPromotionWindowMs: integer("post_promotion_window_ms").notNull().default(120000),
    autoRollback: boolean("auto_rollback").notNull().default(true),
    memoryLimitMb: integer("memory_limit_mb").notNull().default(512),
    cpuLimit: doublePrecision("cpu_limit").notNull().default(1),
    pidsLimit: integer("pids_limit").notNull().default(256),
    buildTimeoutMs: integer("build_timeout_ms").notNull().default(15 * 60 * 1000),
    retainProductionDeployments: integer("retain_production_deployments").notNull().default(10),
    previewRetentionDays: integer("preview_retention_days").notNull().default(7),
    cacheRetentionDays: integer("cache_retention_days").notNull().default(30),
    logRetentionDays: integer("log_retention_days").notNull().default(90),
    aiPermission: aiPermissionEnum("ai_permission").notNull().default("READ_ONLY"),
    aiAutoDiagnose: boolean("ai_auto_diagnose").notNull().default(true),
    aiMaxFixAttempts: integer("ai_max_fix_attempts").notNull().default(3),
    aiDailyBudgetCents: integer("ai_daily_budget_cents").notNull().default(200),
    webhookSecretCipher: jsonb("webhook_secret_cipher"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("projects_slug_uq").on(t.slug),
    index("projects_org_idx").on(t.orgId),
    index("projects_repo_idx").on(t.repoFullName),
  ],
);

export const projectConfigVersions = pgTable("project_config_versions", {
  id: id(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  config: jsonb("config").notNull(),
  changedBy: text("changed_by"),
  reason: text("reason"),
  createdAt: createdAt(),
});

/* ------------------------------------------------------------ deployments */

export const deployments = pgTable(
  "deployments",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    target: deploymentTargetEnum("target").notNull().default("PRODUCTION"),
    status: deploymentStatusEnum("status").notNull().default("QUEUED"),
    generation: integer("generation").notNull().default(0),
    branch: text("branch").notNull(),
    commitSha: text("commit_sha").notNull(),
    commitMessage: text("commit_message"),
    commitAuthor: text("commit_author"),
    commitTimestamp: timestamp("commit_timestamp", { withTimezone: true }),
    prNumber: integer("pr_number"),
    artifactRef: text("artifact_ref"),
    imageRef: text("image_ref"),
    runtimeDriver: text("runtime_driver"),
    hostId: text("host_id").notNull().default("local"),
    port: integer("port"),
    url: text("url"),
    triggeredBy: text("triggered_by").notNull().default("system"),
    triggerSource: text("trigger_source").notNull().default("manual"),
    correlationId: text("correlation_id"),
    configSnapshot: jsonb("config_snapshot"),
    errorReason: text("error_reason"),
    aiFixOfDeploymentId: text("ai_fix_of_deployment_id"),
    queuedAt: createdAt(),
    buildStartedAt: timestamp("build_started_at", { withTimezone: true }),
    buildEndedAt: timestamp("build_ended_at", { withTimezone: true }),
    healthyAt: timestamp("healthy_at", { withTimezone: true }),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("deployment_identity_uq").on(t.projectId, t.commitSha, t.generation),
    index("deployment_project_idx").on(t.projectId, t.queuedAt),
    index("deployment_status_idx").on(t.status),
  ],
);

export const deploymentEvents = pgTable(
  "deployment_events",
  {
    id: id(),
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    projectId: text("project_id").notNull(),
    type: text("type").notNull(),
    message: text("message"),
    data: jsonb("data"),
    correlationId: text("correlation_id"),
    createdAt: createdAt(),
  },
  (t) => [index("deployment_events_idx").on(t.deploymentId, t.createdAt)],
);

export const deploymentLogChunks = pgTable(
  "deployment_log_chunks",
  {
    id: id(),
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    stream: text("stream").notNull().default("build"),
    level: text("level").notNull().default("info"),
    content: text("content").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("log_chunk_idx").on(t.deploymentId, t.seq)],
);

export const deploymentArtifacts = pgTable(
  "deployment_artifacts",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    deploymentId: text("deployment_id").references(() => deployments.id, { onDelete: "cascade" }),
    type: artifactTypeEnum("type").notNull(),
    storageKey: text("storage_key").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    checksum: text("checksum"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  [
    uniqueIndex("artifact_key_uq").on(/** @type {any} */ (undefined as any).storageKey),
  ],
);

export const containerInstances = pgTable(
  "container_instances",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    driver: text("driver").notNull(),
    hostId: text("host_id").notNull().default("local"),
    externalId: text("external_id").notNull(),
    port: integer("port").notNull(),
    status: text("status").notNull().default("running"),
    pid: integer("pid"),
    startedAt: createdAt(),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (t) => [index("container_project_idx").on(t.projectId, t.status)],
);

export const hosts = pgTable(
  "hosts",
  {
    id: text("id").primaryKey(),
    region: text("region").notNull().default("local"),
    driver: text("driver").notNull().default("local"),
    cpuCapacity: doublePrecision("cpu_capacity").notNull().default(4),
    memoryCapacityMb: integer("memory_capacity_mb").notNull().default(8192),
    healthy: boolean("healthy").notNull().default(true),
    labels: jsonb("labels"),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
);

export const healthCheckResults = pgTable(
  "health_check_results",
  {
    id: id(),
    projectId: text("project_id").notNull(),
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("readiness"),
    ok: boolean("ok").notNull(),
    statusCode: integer("status_code"),
    latencyMs: integer("latency_ms"),
    error: text("error"),
    checkedAt: createdAt(),
  },
  (t) => [index("health_result_idx").on(t.deploymentId, t.checkedAt)],
);

export const resourceMetrics = pgTable(
  "resource_metrics",
  {
    id: id(),
    projectId: text("project_id").notNull(),
    deploymentId: text("deployment_id"),
    window: text("window").notNull().default("1m"),
    cpuPercent: doublePrecision("cpu_percent"),
    memoryMb: doublePrecision("memory_mb"),
    rssMb: doublePrecision("rss_mb"),
    requests: integer("requests"),
    errors: integer("errors"),
    p95LatencyMs: integer("p95_latency_ms"),
    recordedAt: createdAt(),
  },
  (t) => [index("metrics_idx").on(t.projectId, t.recordedAt)],
);

export const domains = pgTable(
  "domains",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    kind: text("kind").notNull().default("custom"),
    status: domainStatusEnum("status").notNull().default("PENDING"),
    verificationToken: text("verification_token"),
    verificationMethod: text("verification_method").notNull().default("CNAME"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastError: text("last_error"),
    certificateStatus: text("certificate_status").notNull().default("NONE"),
    certificateExpiresAt: timestamp("certificate_expires_at", { withTimezone: true }),
    deploymentId: text("deployment_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("domain_uq").on(t.domain), index("domain_project_idx").on(t.projectId)],
);

export const envVars = pgTable(
  "env_vars",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    scope: envScopeEnum("scope").notNull().default("PRODUCTION"),
    cipher: jsonb("cipher").notNull(),
    lastFour: text("last_four"),
    version: integer("version").notNull().default(1),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("env_var_uq").on(t.projectId, t.scope, t.key)],
);

export const secretVersions = pgTable("secret_versions", {
  id: id(),
  envVarId: text("env_var_id")
    .notNull()
    .references(() => envVars.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  cipher: jsonb("cipher").notNull(),
  createdBy: text("created_by"),
  createdAt: createdAt(),
});

export const aiConfigs = pgTable(
  "ai_configs",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("anthropic"),
    model: text("model").notNull().default("claude-sonnet-4-5"),
    baseUrl: text("base_url"),
    apiKeyCipher: jsonb("api_key_cipher"),
    temperature: doublePrecision("temperature").notNull().default(0.1),
    maxTokens: integer("max_tokens").notNull().default(4096),
    dailyBudgetCents: integer("daily_budget_cents").notNull().default(500),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("ai_config_org_uq").on(t.orgId)],
);

export const aiConversations = pgTable("ai_conversations", {
  id: id(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  deploymentId: text("deployment_id"),
  title: text("title").notNull().default("Session"),
  permission: aiPermissionEnum("permission").notNull().default("READ_ONLY"),
  status: text("status").notNull().default("open"),
  createdBy: text("created_by"),
  createdAt: createdAt(),
});

export const garvexMemories = pgTable(
  "garvex_memories",
  {
    id: id(),
    orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    embedding: vector1536("embedding").notNull(),
    sourceConversationId: text("source_conversation_id").references(() => aiConversations.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    useCount: integer("use_count").notNull().default(0),
  },
  (t) => [
    index("garvex_memories_scope_idx").on(t.orgId, t.projectId),
    index("garvex_memories_last_used_idx").on(t.lastUsedAt),
  ],
);

export const aiMessages = pgTable(
  "ai_messages",
  {
    id: id(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => aiConversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    costCents: doublePrecision("cost_cents").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("ai_msg_idx").on(t.conversationId, t.createdAt)],
);

export const aiToolCalls = pgTable("ai_tool_calls", {
  id: id(),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => aiConversations.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull(),
  tool: text("tool").notNull(),
  args: jsonb("args"),
  allowed: boolean("allowed").notNull(),
  denyReason: text("deny_reason"),
  result: jsonb("result"),
  durationMs: integer("duration_ms"),
  createdAt: createdAt(),
});

export const aiActions = pgTable("ai_actions", {
  id: id(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  deploymentId: text("deployment_id"),
  conversationId: text("conversation_id"),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("running"),
  provider: text("provider"),
  model: text("model"),
  summary: text("summary"),
  detail: jsonb("detail"),
  costCents: doublePrecision("cost_cents").notNull().default(0),
  createdBy: text("created_by").notNull().default("system"),
  createdAt: createdAt(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const aiFixAttempts = pgTable("ai_fix_attempts", {
  id: id(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  deploymentId: text("deployment_id"),
  actionId: text("action_id"),
  attempt: integer("attempt").notNull().default(1),
  branch: text("branch"),
  diff: text("diff"),
  filesChanged: jsonb("files_changed"),
  testsPassed: boolean("tests_passed"),
  buildPassed: boolean("build_passed"),
  previewDeploymentId: text("preview_deployment_id"),
  outcome: text("outcome").notNull().default("pending"),
  stopReason: text("stop_reason"),
  workspacePath: text("workspace_path"),
  createdAt: createdAt(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    type: text("type").notNull(),
    queue: text("queue").notNull().default("default"),
    dedupeKey: text("dedupe_key"),
    payload: jsonb("payload").notNull(),
    status: jobStatusEnum("status").notNull().default("QUEUED"),
    priority: integer("priority").notNull().default(100),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    projectId: text("project_id"),
    correlationId: text("correlation_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("job_dedupe_uq").on(t.dedupeKey),
    index("job_poll_idx").on(t.status, t.runAt),
  ],
);

export const jobRuns = pgTable("job_runs", {
  id: id(),
  jobId: text("job_id")
    .notNull()
    .references(() => jobs.id, { onDelete: "cascade" }),
  attempt: integer("attempt").notNull(),
  ok: boolean("ok").notNull(),
  error: text("error"),
  durationMs: integer("duration_ms"),
  workerId: text("worker_id"),
  createdAt: createdAt(),
});

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    orgId: text("org_id"),
    projectId: text("project_id"),
    actorId: text("actor_id"),
    actorType: text("actor_type").notNull().default("user"),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    oldState: jsonb("old_state"),
    newState: jsonb("new_state"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_project_idx").on(t.projectId, t.createdAt)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    projectId: text("project_id"),
    type: text("type").notNull(),
    severity: text("severity").notNull().default("info"),
    title: text("title").notNull(),
    body: text("body"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("notification_org_idx").on(t.orgId, t.createdAt)],
);

export const cleanupRuns = pgTable("cleanup_runs", {
  id: id(),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("running"),
  itemsScanned: integer("items_scanned").notNull().default(0),
  itemsDeleted: integer("items_deleted").notNull().default(0),
  itemsSkipped: integer("items_skipped").notNull().default(0),
  bytesReclaimed: bigint("bytes_reclaimed", { mode: "number" }).notNull().default(0),
  detail: jsonb("detail"),
  error: text("error"),
  startedAt: createdAt(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const incidents = pgTable("incidents", {
  id: id(),
  projectId: text("project_id"),
  severity: text("severity").notNull().default("major"),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  cause: text("cause"),
  actions: jsonb("actions"),
  startedAt: createdAt(),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

export const schemaSql = sql;
