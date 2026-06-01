import type { ProviderName } from './llm-types';

/**
 * LLM resolution chain (provider abstraction — plan P4).
 *
 * Decides which provider + model + API key a given (org, teammate) run uses,
 * via one chain that serves both audiences:
 *
 *   1. Org BYO — the org routed this teammate to a provider (OrgTeammateConfig)
 *      and stored a key for it (OrgLlmCredential). Use the org's key.
 *   2. Env fallback — SELF-HOST: LLM_ALLOW_ENV_FALLBACK=true + a provider key in
 *      env. The key is the operator's own, so "we never pay" is not violated.
 *   3. Block — HOSTED default with no BYO: the run cannot start; tell the user
 *      to add a key.
 *
 * Pure + deps-injected (no Nest, no DB, no process.env reads) so every branch is
 * unit-testable. The Nest `LlmResolver` service (P5) wires the real deps:
 * LlmCredentialManager.load, an OrgTeammateConfig read, and a process.env
 * snapshot — then hands the result to the registry to build the provider.
 */

export interface ResolvedLlm {
  providerName: ProviderName;
  modelPrimary: string;
  modelFast: string;
  apiKey: string;
  /** Where the key came from — surfaced in the audit log / settings UI. */
  source: 'byo' | 'env';
}

/** Per-(org, teammate) routing, from OrgTeammateConfig. */
export interface TeammateRouting {
  provider: ProviderName;
  modelPrimary: string;
  modelFast: string;
}

/** Env snapshot for the self-host fallback (read once by the Nest service). */
export interface ResolveLlmEnv {
  /** LLM_ALLOW_ENV_FALLBACK === 'true'. */
  allowFallback: boolean;
  /** LLM_PROVIDER (null → default). */
  provider: ProviderName | null;
  /** LLM_MODEL (null → keep the teammate/default model). */
  modelPrimary: string | null;
  /** LLM_MODEL_FAST (optional). */
  modelFast: string | null;
  /** `<PROVIDER>_API_KEY` lookup, e.g. OPENAI_API_KEY. Null if unset. */
  apiKeyFor: (provider: ProviderName) => string | null;
}

export interface ResolveLlmDeps {
  /** Org BYO key for a provider, or null. Wired to LlmCredentialManager.load. */
  loadCredential: (
    orgId: string,
    provider: ProviderName,
  ) => Promise<string | null>;
  /** Per-(org, teammate) routing, or null when unset. */
  loadTeammateRouting: (
    orgId: string,
    teammate: string,
  ) => Promise<TeammateRouting | null>;
  env: ResolveLlmEnv;
}

/** Reasons a run is blocked — distinct codes so callers/tests can assert. */
export type LlmNotConfiguredReason =
  | 'byo_key_missing'
  | 'env_key_missing'
  | 'no_credentials';

export class LlmNotConfiguredError extends Error {
  constructor(
    public readonly reason: LlmNotConfiguredReason,
    message: string,
  ) {
    super(message);
    this.name = 'LlmNotConfiguredError';
  }
}

/** Platform defaults when an org hasn't routed a teammate. */
const DEFAULTS = {
  provider: 'anthropic' as ProviderName,
  modelPrimary: 'claude-sonnet-4-6',
  modelFast: 'claude-haiku-4-5-20251001',
} as const;

export async function resolveLlm(
  deps: ResolveLlmDeps,
  orgId: string,
  teammate: string,
): Promise<ResolvedLlm> {
  const routing = await deps.loadTeammateRouting(orgId, teammate);
  const desired: TeammateRouting = routing ?? {
    provider: DEFAULTS.provider,
    modelPrimary: DEFAULTS.modelPrimary,
    modelFast: DEFAULTS.modelFast,
  };

  // 1. Org BYO key for the desired provider.
  const byoKey = await deps.loadCredential(orgId, desired.provider);
  if (byoKey) {
    return {
      providerName: desired.provider,
      modelPrimary: desired.modelPrimary,
      modelFast: desired.modelFast,
      apiKey: byoKey,
      source: 'byo',
    };
  }

  // The org EXPLICITLY routed this teammate to a provider but stored no key for
  // it — a misconfiguration. Block with a precise message rather than silently
  // falling back to env or a different provider (which would bill/behave
  // unexpectedly).
  if (routing) {
    throw new LlmNotConfiguredError(
      'byo_key_missing',
      `No ${desired.provider} API key is configured for this org. Add it in ` +
        `Settings → AI, or change this teammate's provider.`,
    );
  }

  // 2. Env fallback (self-host).
  if (deps.env.allowFallback) {
    const envProvider = deps.env.provider ?? DEFAULTS.provider;
    const envKey = deps.env.apiKeyFor(envProvider);
    if (envKey) {
      return {
        providerName: envProvider,
        modelPrimary: deps.env.modelPrimary ?? desired.modelPrimary,
        modelFast: deps.env.modelFast ?? desired.modelFast,
        apiKey: envKey,
        source: 'env',
      };
    }
    throw new LlmNotConfiguredError(
      'env_key_missing',
      `LLM_ALLOW_ENV_FALLBACK is on but no key for ${envProvider} is set ` +
        `(expected ${envProvider.toUpperCase()}_API_KEY).`,
    );
  }

  // 3. Block — hosted default with no BYO key.
  throw new LlmNotConfiguredError(
    'no_credentials',
    'No LLM credentials configured. Add an API key in Settings → AI, or set ' +
      'LLM_ALLOW_ENV_FALLBACK=true with a provider key (self-host).',
  );
}
