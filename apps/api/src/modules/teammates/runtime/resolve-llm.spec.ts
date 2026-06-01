import { describe, expect, it, vi } from 'vitest';
import {
  LlmNotConfiguredError,
  resolveLlm,
  type ResolveLlmDeps,
  type ResolveLlmEnv,
  type TeammateRouting,
} from './resolve-llm';

/**
 * P4 resolver — the REGRESSION-IF-BROKEN resolution chain. 100% of branches:
 * org BYO → env fallback → block, plus the explicit-routing-but-no-key
 * misconfiguration. Pure deps, no Nest/DB/process.env.
 */

const NO_ENV: ResolveLlmEnv = {
  allowFallback: false,
  provider: null,
  modelPrimary: null,
  modelFast: null,
  apiKeyFor: () => null,
};

function deps(over: Partial<ResolveLlmDeps>): ResolveLlmDeps {
  return {
    loadCredential: vi.fn(async () => null),
    loadTeammateRouting: vi.fn(async () => null),
    env: NO_ENV,
    ...over,
  };
}

const OPENAI_ROUTING: TeammateRouting = {
  provider: 'openai',
  modelPrimary: 'gpt-x',
  modelFast: 'gpt-x-mini',
};

describe('resolveLlm', () => {
  it('uses the org BYO key for the teammate-routed provider', async () => {
    const d = deps({
      loadTeammateRouting: vi.fn(async () => OPENAI_ROUTING),
      loadCredential: vi.fn(async (_org, provider) =>
        provider === 'openai' ? 'sk-org-openai' : null,
      ),
    });

    const r = await resolveLlm(d, 'org-1', 'researcher');

    expect(r).toEqual({
      providerName: 'openai',
      modelPrimary: 'gpt-x',
      modelFast: 'gpt-x-mini',
      apiKey: 'sk-org-openai',
      source: 'byo',
    });
    expect(d.loadCredential).toHaveBeenCalledWith('org-1', 'openai');
  });

  it('defaults to anthropic + default models when the org has not routed but has an anthropic key', async () => {
    const d = deps({
      loadCredential: vi.fn(async (_org, provider) =>
        provider === 'anthropic' ? 'sk-org-anthropic' : null,
      ),
    });

    const r = await resolveLlm(d, 'org-1', 'researcher');

    expect(r.providerName).toBe('anthropic');
    expect(r.modelPrimary).toBe('claude-sonnet-4-6');
    expect(r.source).toBe('byo');
  });

  it('BLOCKS when a teammate is explicitly routed to a provider with no stored key', async () => {
    const d = deps({
      loadTeammateRouting: vi.fn(async () => OPENAI_ROUTING),
      loadCredential: vi.fn(async () => null), // no openai key
      env: { ...NO_ENV, allowFallback: true, apiKeyFor: () => 'env-key' },
    });

    // Even with env fallback ON, explicit routing without a key must NOT
    // silently fall back to env — it's a misconfiguration the user must fix.
    await expect(resolveLlm(d, 'org-1', 'researcher')).rejects.toMatchObject({
      name: 'LlmNotConfiguredError',
      reason: 'byo_key_missing',
    });
  });

  it('falls back to the env provider key when no BYO and fallback is ON', async () => {
    const d = deps({
      env: {
        allowFallback: true,
        provider: 'openai',
        modelPrimary: 'gpt-env',
        modelFast: null,
        apiKeyFor: (p) => (p === 'openai' ? 'env-openai-key' : null),
      },
    });

    const r = await resolveLlm(d, 'org-1', 'sdr-drafter');

    expect(r).toEqual({
      providerName: 'openai',
      modelPrimary: 'gpt-env',
      // modelFast falls through to the default since env didn't set it.
      modelFast: 'claude-haiku-4-5-20251001',
      apiKey: 'env-openai-key',
      source: 'env',
    });
  });

  it('env fallback defaults the provider to anthropic when LLM_PROVIDER is unset', async () => {
    const d = deps({
      env: {
        allowFallback: true,
        provider: null,
        modelPrimary: null,
        modelFast: null,
        apiKeyFor: (p) => (p === 'anthropic' ? 'env-anthropic' : null),
      },
    });

    const r = await resolveLlm(d, 'org-1', 'researcher');

    expect(r.providerName).toBe('anthropic');
    expect(r.source).toBe('env');
  });

  it('BLOCKS when fallback is ON but the env provider has no key', async () => {
    const d = deps({
      env: { ...NO_ENV, allowFallback: true, provider: 'openai', apiKeyFor: () => null },
    });

    await expect(resolveLlm(d, 'org-1', 'researcher')).rejects.toMatchObject({
      reason: 'env_key_missing',
    });
  });

  it('BLOCKS with no_credentials when there is no BYO key and fallback is OFF', async () => {
    const d = deps({}); // no key, no routing, no fallback

    const err = await resolveLlm(d, 'org-1', 'researcher').catch((e) => e);
    expect(err).toBeInstanceOf(LlmNotConfiguredError);
    expect((err as LlmNotConfiguredError).reason).toBe('no_credentials');
  });
});
