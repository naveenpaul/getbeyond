-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('self_host', 'solo', 'team', 'growth', 'enterprise');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('owner', 'member');

-- CreateEnum
CREATE TYPE "VoiceChannel" AS ENUM ('email', 'linkedin_dm', 'linkedin_post', 'twitter_post');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('running', 'completed', 'failed', 'abstained');

-- CreateEnum
CREATE TYPE "DraftType" AS ENUM ('email', 'linkedin_dm', 'linkedin_post', 'twitter_post', 'research_brief');

-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('pending', 'approved', 'rejected', 'edited', 'sent', 'partial', 'failed');

-- CreateEnum
CREATE TYPE "ApprovalPolicy" AS ENUM ('draft_only', 'auto_above_confidence', 'autonomous');

-- CreateEnum
CREATE TYPE "ConnectorKind" AS ENUM ('hubspot', 'salesforce', 'apollo', 'zoominfo', 'csv');

-- CreateEnum
CREATE TYPE "AuthMode" AS ENUM ('oauth', 'byo_key', 'upload');

-- CreateEnum
CREATE TYPE "ConnectorStatus" AS ENUM ('active', 'expired', 'revoked', 'error', 'circuit_broken');

-- CreateEnum
CREATE TYPE "SyncDirection" AS ENUM ('pull', 'push');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('running', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "DraftActionKind" AS ENUM ('send_email', 'post_linkedin', 'post_twitter', 'crm_log_activity', 'crm_update_field', 'archive');

-- CreateEnum
CREATE TYPE "DraftActionStatus" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'dead_lettered');

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "plan" "Plan" NOT NULL DEFAULT 'self_host',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "email" CITEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_brains" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "icp" JSONB NOT NULL DEFAULT '{}',
    "offer" JSONB NOT NULL DEFAULT '{}',
    "productInfo" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_brains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voices" (
    "id" TEXT NOT NULL,
    "brainId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" "VoiceChannel" NOT NULL,
    "signature" JSONB NOT NULL DEFAULT '{}',
    "bestPosts" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "teammate" TEXT NOT NULL,
    "triggeredBy" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'running',
    "reason" TEXT,
    "inputContext" JSONB NOT NULL DEFAULT '{}',
    "outputDraftId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "lastBeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "costCents" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_calls" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_calls" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "modelCallId" TEXT,
    "toolSeq" INTEGER NOT NULL,
    "toolName" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tool_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "citations" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "excerpt" TEXT,
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "citations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drafts" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "teammate" TEXT NOT NULL,
    "runId" TEXT,
    "type" "DraftType" NOT NULL,
    "recipient" JSONB,
    "content" JSONB NOT NULL,
    "status" "DraftStatus" NOT NULL DEFAULT 'pending',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "editLog" JSONB NOT NULL DEFAULT '[]',
    "scheduledFor" TIMESTAMP(3),
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claims" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "citationId" TEXT,
    "confidence" DOUBLE PRECISION,
    "abstained" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teammate_configs" (
    "teammate" TEXT NOT NULL,
    "toolAllowlist" TEXT[],
    "approvalPolicy" "ApprovalPolicy" NOT NULL DEFAULT 'draft_only',
    "modelPrimary" TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
    "modelFast" TEXT NOT NULL DEFAULT 'claude-haiku-4-5-20251001',
    "defaultBudgetCents" INTEGER NOT NULL DEFAULT 100,
    "maxToolCalls" INTEGER NOT NULL DEFAULT 25,
    "maxWallSecs" INTEGER NOT NULL DEFAULT 180,
    "maxParallelCalls" INTEGER NOT NULL DEFAULT 3,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teammate_configs_pkey" PRIMARY KEY ("teammate")
);

-- CreateTable
CREATE TABLE "connector_accounts" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" "ConnectorKind" NOT NULL,
    "authMode" "AuthMode" NOT NULL,
    "credentials" BYTEA NOT NULL,
    "credentialsVersion" INTEGER NOT NULL DEFAULT 1,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "ConnectorStatus" NOT NULL DEFAULT 'active',
    "dailyBudgetCents" INTEGER,
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "circuitOpenedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connector_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "title" TEXT,
    "company" TEXT,
    "linkedinUrl" TEXT,
    "normalizedEmail" CITEXT,
    "fieldProvenance" JSONB NOT NULL DEFAULT '{}',
    "lastEditedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_emails" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "normalizedEmail" CITEXT NOT NULL,
    "rawEmail" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "sourceAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_sources" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "sourceAccountId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "externalUrl" TEXT,
    "rawPayload" JSONB NOT NULL,
    "rawPayloadVersion" INTEGER NOT NULL DEFAULT 1,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_lists" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactCount" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_list_members" (
    "listId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_list_members_pkey" PRIMARY KEY ("listId","contactId")
);

-- CreateTable
CREATE TABLE "sync_runs" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "connectorAccountId" TEXT NOT NULL,
    "direction" "SyncDirection" NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "recordsIn" INTEGER NOT NULL DEFAULT 0,
    "recordsOut" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "cursor" TEXT,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "costCents" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draft_actions" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "kind" "DraftActionKind" NOT NULL,
    "targetAccountId" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "payloadSchemaVersion" INTEGER NOT NULL DEFAULT 1,
    "dependsOnId" TEXT,
    "status" "DraftActionStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT NOT NULL,
    "responsePayload" JSONB,
    "executedAt" TIMESTAMP(3),
    "executedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "draft_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_orgId_email_key" ON "users"("orgId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "company_brains_orgId_key" ON "company_brains"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "voices_brainId_userId_channel_key" ON "voices"("brainId", "userId", "channel");

-- CreateIndex
CREATE INDEX "agent_runs_orgId_startedAt_idx" ON "agent_runs"("orgId", "startedAt");

-- CreateIndex
CREATE INDEX "agent_runs_status_lastBeatAt_idx" ON "agent_runs"("status", "lastBeatAt");

-- CreateIndex
CREATE INDEX "model_calls_runId_idx" ON "model_calls"("runId");

-- CreateIndex
CREATE INDEX "tool_calls_runId_idx" ON "tool_calls"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "tool_calls_runId_toolSeq_key" ON "tool_calls"("runId", "toolSeq");

-- CreateIndex
CREATE INDEX "citations_runId_idx" ON "citations"("runId");

-- CreateIndex
CREATE INDEX "citations_url_idx" ON "citations"("url");

-- CreateIndex
CREATE INDEX "drafts_orgId_status_idx" ON "drafts"("orgId", "status");

-- CreateIndex
CREATE INDEX "drafts_orgId_createdAt_idx" ON "drafts"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "claims_draftId_idx" ON "claims"("draftId");

-- CreateIndex
CREATE UNIQUE INDEX "connector_accounts_orgId_kind_key" ON "connector_accounts"("orgId", "kind");

-- CreateIndex
CREATE INDEX "contacts_orgId_linkedinUrl_idx" ON "contacts"("orgId", "linkedinUrl");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_orgId_normalizedEmail_key" ON "contacts"("orgId", "normalizedEmail");

-- CreateIndex
CREATE INDEX "contact_emails_normalizedEmail_idx" ON "contact_emails"("normalizedEmail");

-- CreateIndex
CREATE UNIQUE INDEX "contact_emails_contactId_normalizedEmail_key" ON "contact_emails"("contactId", "normalizedEmail");

-- CreateIndex
CREATE INDEX "contact_sources_contactId_idx" ON "contact_sources"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "contact_sources_sourceAccountId_externalId_key" ON "contact_sources"("sourceAccountId", "externalId");

-- CreateIndex
CREATE INDEX "contact_lists_orgId_idx" ON "contact_lists"("orgId");

-- CreateIndex
CREATE INDEX "contact_list_members_contactId_idx" ON "contact_list_members"("contactId");

-- CreateIndex
CREATE INDEX "sync_runs_orgId_startedAt_idx" ON "sync_runs"("orgId", "startedAt");

-- CreateIndex
CREATE INDEX "sync_runs_connectorAccountId_startedAt_idx" ON "sync_runs"("connectorAccountId", "startedAt");

-- CreateIndex
CREATE INDEX "draft_actions_status_dependsOnId_idx" ON "draft_actions"("status", "dependsOnId");

-- CreateIndex
CREATE INDEX "draft_actions_draftId_idx" ON "draft_actions"("draftId");

-- CreateIndex
CREATE INDEX "draft_actions_idempotencyKey_idx" ON "draft_actions"("idempotencyKey");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_brains" ADD CONSTRAINT "company_brains_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voices" ADD CONSTRAINT "voices_brainId_fkey" FOREIGN KEY ("brainId") REFERENCES "company_brains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voices" ADD CONSTRAINT "voices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_modelCallId_fkey" FOREIGN KEY ("modelCallId") REFERENCES "model_calls"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citations" ADD CONSTRAINT "citations_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_citationId_fkey" FOREIGN KEY ("citationId") REFERENCES "citations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_accounts" ADD CONSTRAINT "connector_accounts_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_emails" ADD CONSTRAINT "contact_emails_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_emails" ADD CONSTRAINT "contact_emails_sourceAccountId_fkey" FOREIGN KEY ("sourceAccountId") REFERENCES "connector_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_sources" ADD CONSTRAINT "contact_sources_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_sources" ADD CONSTRAINT "contact_sources_sourceAccountId_fkey" FOREIGN KEY ("sourceAccountId") REFERENCES "connector_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_lists" ADD CONSTRAINT "contact_lists_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_list_members" ADD CONSTRAINT "contact_list_members_listId_fkey" FOREIGN KEY ("listId") REFERENCES "contact_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_list_members" ADD CONSTRAINT "contact_list_members_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_connectorAccountId_fkey" FOREIGN KEY ("connectorAccountId") REFERENCES "connector_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_actions" ADD CONSTRAINT "draft_actions_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_actions" ADD CONSTRAINT "draft_actions_targetAccountId_fkey" FOREIGN KEY ("targetAccountId") REFERENCES "connector_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_actions" ADD CONSTRAINT "draft_actions_dependsOnId_fkey" FOREIGN KEY ("dependsOnId") REFERENCES "draft_actions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
