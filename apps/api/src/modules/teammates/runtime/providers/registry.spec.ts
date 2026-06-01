import { describe, expect, it } from 'vitest';
import { createProvider } from './registry';
import { AnthropicProvider } from './anthropic.provider';
import { OpenAIProvider } from './openai.provider';
import { LlmProviderError, type ProviderName } from '../llm-types';

/**
 * Registry tests (LLM provider abstraction — plan P2).
 *
 * The registry is a thin, exhaustive switch from `ProviderName` to a
 * key-bound provider instance. Cover the configured cases (each provider
 * builds via its factory) and the unconfigured/unknown case (clear throw).
 */

describe('createProvider — configured providers', () => {
  it('builds an AnthropicProvider for "anthropic"', () => {
    const provider = createProvider('anthropic', 'sk-ant-test');
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.name).toBe('anthropic');
  });

  it('builds an OpenAIProvider for "openai"', () => {
    const provider = createProvider('openai', 'sk-openai-test');
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(provider.name).toBe('openai');
  });

  it('propagates the factory throw on a missing key', () => {
    expect(() => createProvider('anthropic', '')).toThrow(
      'ANTHROPIC_API_KEY is not set',
    );
    expect(() => createProvider('openai', '')).toThrow(
      'OPENAI_API_KEY is not set',
    );
  });
});

describe('createProvider — unknown provider', () => {
  it('throws a neutral LlmProviderError for an unmapped provider value', () => {
    // Simulate a value that slipped past the type system (e.g. an unmapped DB
    // enum from P3): cast through unknown to bypass the compile-time guard.
    const bogus = 'gemini' as unknown as ProviderName;
    const err = (() => {
      try {
        createProvider(bogus, 'key');
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(LlmProviderError);
    expect((err as LlmProviderError).message).toContain('gemini');
    expect((err as LlmProviderError).provider).toBe('gemini');
  });
});
