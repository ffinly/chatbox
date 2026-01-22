/**
 * Built-in model context window data.
 *
 * This file contains fallback context window data for common models.
 * It's used when the runtime fetch from models.dev fails or is cached out.
 *
 * Format: { [modelId]: contextWindow }
 * Context window is the maximum number of tokens the model can process.
 *
 * To update this data:
 * 1. Fetch from https://models.dev/api.json
 * 2. Extract model IDs and their limit.context values
 * 3. Update this map
 *
 * Last updated: 2026-01-20
 */
export const BUILTIN_MODEL_CONTEXT: Record<string, number> = {
  // OpenAI
  'gpt-5.1': 400_000,
  'gpt-5': 400_000,
  'gpt-5-mini': 128_000,
  'gpt-5-nano': 128_000,
  'gpt-5-chat-latest': 400_000,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4': 8_192,
  'gpt-3.5-turbo': 16_385,
  'o4-mini': 200_000,
  'o3-mini': 200_000,
  o3: 200_000,
  'o3-pro': 200_000,
  o1: 200_000,
  'o1-mini': 128_000,
  'o1-preview': 128_000,

  // Anthropic Claude
  'claude-opus-4-1': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-haiku-4-5': 200_000,
  'claude-4-opus': 200_000,
  'claude-4-sonnet': 200_000,
  'claude-3-7-sonnet': 200_000,
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-sonnet-20241022': 200_000,
  'claude-3-5-haiku': 200_000,
  'claude-3-opus': 200_000,
  'claude-3-sonnet': 200_000,
  'claude-3-haiku': 200_000,

  // Google Gemini
  'gemini-3-pro-preview': 1_000_000,
  'gemini-2.5-pro': 1_000_000,
  'gemini-2.5-flash': 1_000_000,
  'gemini-2.0-flash': 1_000_000,
  'gemini-1.5-pro': 2_000_000,
  'gemini-1.5-flash': 1_000_000,

  // DeepSeek
  'deepseek-chat': 128_000,
  'deepseek-coder': 128_000,
  'deepseek-reasoner': 128_000,
  'deepseek-v3': 128_000,
  'deepseek-r1': 128_000,

  // xAI Grok
  'grok-4-1-fast-reasoning': 2_000_000,
  'grok-4-1-fast-non-reasoning': 2_000_000,
  'grok-3': 131_072,
  'grok-3-mini': 131_072,
  'grok-2': 131_072,
  'grok-beta': 131_072,

  // Mistral
  'mistral-large-latest': 32_000,
  'mistral-medium-latest': 32_000,
  'mistral-small-latest': 32_000,
  'pixtral-large-latest': 128_000,
  'codestral-latest': 32_000,
  'magistral-medium-latest': 32_000,
  'magistral-small-latest': 32_000,

  // Meta Llama
  'llama-3.3-70b-versatile': 131_072,
  'llama-3.2-90b-vision': 128_000,
  'llama-3.1-405b': 128_000,
  'llama-3.1-70b': 128_000,
  'llama-3.1-8b': 128_000,

  // Qwen
  'qwen-2.5-72b': 128_000,
  'qwen-2.5-32b': 32_000,
  'qwen-2.5-14b': 32_000,
  'qwen-2.5-7b': 32_000,
  'qwq-32b': 32_000,

  // Cohere
  'command-r-plus': 128_000,
  'command-r': 128_000,
}
