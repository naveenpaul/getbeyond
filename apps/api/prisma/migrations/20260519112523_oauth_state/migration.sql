-- T3c.1 — OAuthState: short-lived state token bridging OAuth /start → /callback.
-- 10-min TTL; OAuthStateReaper sweeps expired rows on a 2-min cadence.

-- CreateTable
CREATE TABLE "oauth_states" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" "ConnectorKind" NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_states_state_key" ON "oauth_states"("state");

-- CreateIndex
CREATE INDEX "oauth_states_expiresAt_idx" ON "oauth_states"("expiresAt");

-- CreateIndex
CREATE INDEX "oauth_states_orgId_kind_idx" ON "oauth_states"("orgId", "kind");
