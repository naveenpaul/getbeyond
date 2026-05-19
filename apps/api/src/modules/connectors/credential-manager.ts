import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AuthMode, ConnectorAccount, ConnectorKind } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  CIRCUIT_COOLDOWN_MS,
  CircuitBreaker,
} from './circuit-breaker';
import {
  CredentialEncryptionError,
  decryptCredentials,
  encryptCredentials,
  loadMasterKey,
} from './credential-encryption';
import { SingleflightRegistry } from './singleflight';
import type {
  CredentialUpdate,
  DecryptedCredentials,
} from '@getbeyond/shared';

/**
 * CredentialManager (eng-review pass-2 D4 + codex T5; T3c.2).
 *
 * Owns the lifecycle of `ConnectorAccount.credentials`:
 *   - Loads + decrypts at the adapter boundary; refuses to load when the
 *     account is `expired` or in an open circuit.
 *   - Refreshes via singleflight (per accountId) with compare-and-swap on
 *     `credentialsVersion` so two parallel refresh attempts can't clobber
 *     each other across worker processes.
 *   - Tracks vendor 5xx via an in-memory sliding-window CircuitBreaker;
 *     persists `status='circuit_broken'` + `circuitOpenedAt` when the
 *     breaker opens so the state survives process restart.
 *   - Auto-recovers via half-open probe: when cooldown elapses, the next
 *     load() flips status back to `active` and lets the call through.
 *     A failed probe re-opens the circuit immediately.
 *   - Hard rule: errors thrown from this module never include plaintext
 *     credentials or vendor secrets. Adapter authors who catch errors
 *     here should re-throw without enriching with creds.
 *
 * Pre-conditions:
 *   - `CREDENTIAL_MASTER_KEY` env var is a base64-encoded 32-byte key.
 *     Loaded once at instantiation; reload requires a process restart.
 */

export type CredentialManagerErrorCode =
  | 'not_found'
  | 'expired'
  | 'circuit_broken'
  | 'refresh_rejected'
  | 'master_key_missing';

export class CredentialManagerError extends Error {
  constructor(
    public readonly code: CredentialManagerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CredentialManagerError';
  }
}

/**
 * Thrown by an adapter's `refresher` callback when the vendor rejects the
 * refresh token (HTTP 400 from /oauth/v1/token, typically). CredentialManager
 * catches this and transitions the account to `status='expired'`.
 */
export class RefreshRejectedError extends Error {
  constructor(message: string = 'refresh token rejected by vendor') {
    super(message);
    this.name = 'RefreshRejectedError';
  }
}

@Injectable()
export class CredentialManager {
  private readonly logger = new Logger(CredentialManager.name);
  private readonly prisma: PrismaService;
  private readonly masterKey: Buffer;
  private readonly refreshSingleflight = new SingleflightRegistry<
    string,
    DecryptedCredentials
  >();
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.prisma = prisma;
    const base64Key = process.env.CREDENTIAL_MASTER_KEY ?? '';
    if (!base64Key || base64Key === 'change-me-in-production') {
      throw new CredentialManagerError(
        'master_key_missing',
        'CREDENTIAL_MASTER_KEY is not set or still at the placeholder value',
      );
    }
    this.masterKey = loadMasterKey(base64Key);
  }

  /**
   * Load + decrypt credentials for a ConnectorAccount.
   *
   * Throws:
   *   - `not_found` if no account row exists
   *   - `expired` if status='expired' (user must reconnect)
   *   - `circuit_broken` if the circuit is open AND cooldown has not elapsed
   *
   * Side effect: when the circuit's cooldown has elapsed, this call performs
   * the half-open transition — status flips to `active`, the in-memory
   * breaker is cleared. The caller's vendor request becomes the probe. If
   * that request fails with 5xx, the next reportVendorFailure() call may
   * re-open the circuit immediately.
   */
  async load(
    accountId: string,
    now: Date = new Date(),
  ): Promise<DecryptedCredentials> {
    const account = await this.prisma.connectorAccount.findUnique({
      where: { id: accountId },
    });
    if (!account) {
      throw new CredentialManagerError(
        'not_found',
        `ConnectorAccount ${accountId} not found`,
      );
    }
    if (account.status === 'expired' || account.status === 'revoked') {
      throw new CredentialManagerError(
        'expired',
        `ConnectorAccount ${accountId} status=${account.status} — user must reconnect`,
      );
    }
    if (account.status === 'circuit_broken') {
      const elapsed = account.circuitOpenedAt
        ? now.getTime() - account.circuitOpenedAt.getTime()
        : Infinity;
      if (elapsed < CIRCUIT_COOLDOWN_MS) {
        throw new CredentialManagerError(
          'circuit_broken',
          `ConnectorAccount ${accountId} circuit open; cooldown ${Math.round((CIRCUIT_COOLDOWN_MS - elapsed) / 1000)}s remaining`,
        );
      }
      // Half-open transition. Clear persistent + in-memory state. The next
      // vendor call is the probe.
      await this.prisma.connectorAccount.update({
        where: { id: accountId },
        data: { status: 'active', circuitOpenedAt: null, lastError: null },
      });
      this.breakers.delete(accountId);
      this.logger.log(
        `circuit half-open for account=${accountId}; next call is the probe`,
      );
    }
    return this.decryptOrFail(account.credentials);
  }

  /**
   * Trigger a credential refresh. Singleflight per accountId — concurrent
   * callers share one in-flight refresh. CAS update on `credentialsVersion`
   * provides cross-process safety: if another process refreshed first, the
   * CAS update finds 0 rows, we re-read, and return the newer credentials.
   *
   * `refresher` must throw `RefreshRejectedError` when the vendor rejects
   * the refresh token (typically HTTP 400 on /oauth/v1/token). Other errors
   * bubble out unchanged.
   */
  async refresh(
    accountId: string,
    refresher: (current: DecryptedCredentials) => Promise<CredentialUpdate>,
  ): Promise<DecryptedCredentials> {
    return this.refreshSingleflight.run(accountId, async () => {
      const account = await this.prisma.connectorAccount.findUnique({
        where: { id: accountId },
      });
      if (!account) {
        throw new CredentialManagerError(
          'not_found',
          `ConnectorAccount ${accountId} not found`,
        );
      }
      const current = this.decryptOrFail(account.credentials);
      let update: CredentialUpdate;
      try {
        update = await refresher(current);
      } catch (err) {
        if (err instanceof RefreshRejectedError) {
          await this.prisma.connectorAccount.update({
            where: { id: accountId },
            data: { status: 'expired', lastError: 'refresh token rejected' },
          });
          throw new CredentialManagerError(
            'refresh_rejected',
            `refresh token rejected for account ${accountId} — user must reconnect`,
          );
        }
        throw err;
      }

      // CAS update — succeeds only if credentialsVersion is still what we read.
      const sealed = encryptCredentials(
        update.next as Record<string, unknown>,
        this.masterKey,
      );
      const result = await this.prisma.connectorAccount.updateMany({
        where: {
          id: accountId,
          credentialsVersion: account.credentialsVersion,
        },
        data: {
          credentials: sealed,
          credentialsVersion: account.credentialsVersion + 1,
          status: 'active',
          lastError: null,
        },
      });

      if (result.count === 0) {
        // Another process won the race. Re-read and return their result.
        const winner = await this.prisma.connectorAccount.findUnique({
          where: { id: accountId },
        });
        if (!winner) {
          throw new CredentialManagerError(
            'not_found',
            `ConnectorAccount ${accountId} disappeared during refresh`,
          );
        }
        return this.decryptOrFail(winner.credentials);
      }

      return update.next;
    });
  }

  /**
   * Adapters call this after every vendor response that is either a 5xx
   * (transient server error → feeds the breaker) or a 401-after-refresh-failed
   * (auth invalid → mark account expired immediately, no breaker waiting).
   *
   * 4xx user errors (400 bad request, 403 forbidden, 404 missing object)
   * should NOT be reported here — they're per-call problems, not signals
   * about the account's overall health.
   */
  async reportVendorFailure(
    accountId: string,
    kind: 'server_5xx' | 'auth_invalid',
    now: Date = new Date(),
  ): Promise<void> {
    if (kind === 'auth_invalid') {
      await this.prisma.connectorAccount.update({
        where: { id: accountId },
        data: { status: 'expired', lastError: 'vendor reported auth invalid' },
      });
      return;
    }
    let breaker = this.breakers.get(accountId);
    if (!breaker) {
      breaker = new CircuitBreaker();
      this.breakers.set(accountId, breaker);
    }
    const shouldOpen = breaker.recordFailure(now.getTime());
    if (shouldOpen) {
      await this.prisma.connectorAccount.update({
        where: { id: accountId },
        data: {
          status: 'circuit_broken',
          circuitOpenedAt: now,
          lastError: '5xx storm: circuit opened',
        },
      });
      this.logger.warn(`circuit opened for account=${accountId}`);
    }
  }

  /**
   * Adapters call this after a successful vendor response. Lets the half-open
   * probe close the circuit explicitly (without it, the breaker would only
   * close once the next 60s of 5xx-free traffic naturally drained the window).
   */
  reportVendorSuccess(accountId: string): void {
    this.breakers.get(accountId)?.reset();
  }

  /**
   * Persist credentials for a newly-connected account (post-OAuth-callback or
   * BYO-key entry). Encrypts at this boundary so the OAuth controller never
   * touches the master key. Upserts on (orgId, kind) — reconnecting an
   * already-connected account rotates the credentials and resets status.
   *
   * Returns the `ConnectorAccount.id`.
   */
  async persistInitialCredentials(params: {
    orgId: string;
    kind: ConnectorKind;
    authMode: AuthMode;
    creds: DecryptedCredentials;
    scopes?: string[];
  }): Promise<string> {
    const sealed = encryptCredentials(
      params.creds as Record<string, unknown>,
      this.masterKey,
    );
    const result = await this.prisma.connectorAccount.upsert({
      where: { orgId_kind: { orgId: params.orgId, kind: params.kind } },
      create: {
        orgId: params.orgId,
        kind: params.kind,
        authMode: params.authMode,
        credentials: sealed,
        credentialsVersion: 1,
        status: 'active',
        scopes: params.scopes ?? [],
      },
      update: {
        credentials: sealed,
        credentialsVersion: { increment: 1 },
        authMode: params.authMode,
        status: 'active',
        lastError: null,
        circuitOpenedAt: null,
        scopes: params.scopes ?? [],
      },
    });
    // Drop any stale in-memory breaker for this account on reconnect.
    this.breakers.delete(result.id);
    return result.id;
  }

  /** Test-only: drop all in-memory circuit state. Never call in production. */
  resetForTests(): void {
    this.breakers.clear();
    this.refreshSingleflight.clear();
  }

  private decryptOrFail(
    sealed: ConnectorAccount['credentials'],
  ): DecryptedCredentials {
    try {
      return decryptCredentials<DecryptedCredentials>(
        sealed as Buffer,
        this.masterKey,
      );
    } catch (err) {
      if (err instanceof CredentialEncryptionError) {
        // Re-throw — the encryption module already strips credential material
        // from the message, so propagation is safe.
        throw err;
      }
      throw err;
    }
  }
}
