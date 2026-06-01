import type { LlmProvider } from '../llm-provider';
import { LlmProviderError, type ProviderName } from '../llm-types';
import { createAnthropicProvider } from './anthropic.provider';
import { createOpenAIProvider } from './openai.provider';

/**
 * Provider registry (LLM provider abstraction — plan P2).
 *
 * Maps a `ProviderName` to a concrete `LlmProvider` instance bound to a
 * resolved API key. This is the single switch the resolver (P4) calls once at
 * run start, after it has decided which provider + key a given run uses.
 *
 * It mirrors the P1 factory style — each provider is built via its
 * `create<Provider>Provider(apiKey)` factory (NOT `@Injectable`); the factories
 * own key validation and SDK construction, so the registry stays a thin,
 * exhaustive switch. Adding a provider = adding a case here + its factory; the
 * `never` exhaustiveness check makes a forgotten case a compile error.
 */

/** Construct the provider for `name`, bound to `apiKey`. */
export function createProvider(
  name: ProviderName,
  apiKey: string,
): LlmProvider {
  switch (name) {
    case 'anthropic':
      return createAnthropicProvider(apiKey);
    case 'openai':
      return createOpenAIProvider(apiKey);
    default:
      // Exhaustive over ProviderName: a new union member without a case here
      // is a compile error. The runtime throw guards a value that slipped past
      // the type system (e.g. an unmapped DB enum value from P3).
      return assertUnknownProvider(name);
  }
}

function assertUnknownProvider(name: never): never {
  throw new LlmProviderError(
    `Unknown or unconfigured LLM provider: "${String(name)}"`,
    String(name),
  );
}
