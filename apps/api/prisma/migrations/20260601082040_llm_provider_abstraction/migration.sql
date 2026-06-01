-- CreateEnum
CREATE TYPE "Provider" AS ENUM ('anthropic', 'openai');

-- DropIndex
DROP INDEX "users_email_idx";

-- AlterTable
ALTER TABLE "model_calls" ADD COLUMN     "provider" "Provider";

-- CreateTable
CREATE TABLE "org_llm_credentials" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "apiKey" BYTEA NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_llm_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_teammate_configs" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "teammate" TEXT NOT NULL,
    "provider" "Provider" NOT NULL DEFAULT 'anthropic',
    "modelPrimary" TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
    "modelFast" TEXT NOT NULL DEFAULT 'claude-haiku-4-5-20251001',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_teammate_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "org_llm_credentials_orgId_provider_key" ON "org_llm_credentials"("orgId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "org_teammate_configs_orgId_teammate_key" ON "org_teammate_configs"("orgId", "teammate");

-- AddForeignKey
ALTER TABLE "org_llm_credentials" ADD CONSTRAINT "org_llm_credentials_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_teammate_configs" ADD CONSTRAINT "org_teammate_configs_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
