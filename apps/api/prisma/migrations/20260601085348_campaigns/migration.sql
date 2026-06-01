-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('draft', 'running', 'completed', 'failed');

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'draft',
    "winsListId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaigns_orgId_status_idx" ON "campaigns"("orgId", "status");

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
