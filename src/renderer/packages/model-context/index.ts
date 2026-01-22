import { BUILTIN_MODEL_CONTEXT } from './builtin-data'

const CACHE_KEY = 'model-context-cache'
const CACHE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000
const API_URL = 'https://models.dev/api.json'
const DEFAULT_CONTEXT_WINDOW = 96_000

interface CacheEntry {
  data: Record<string, number>
  timestamp: number
}

interface ModelsDevResponse {
  [providerId: string]: {
    models: {
      [modelId: string]: {
        limit?: {
          context?: number
        }
      }
    }
  }
}

let runtimeCache: Record<string, number> | null = null
let fetchPromise: Promise<Record<string, number>> | null = null

function getCache(): CacheEntry | null {
  try {
    const cached = localStorage.getItem(CACHE_KEY)
    if (!cached) return null
    return JSON.parse(cached) as CacheEntry
  } catch {
    return null
  }
}

function setCache(data: Record<string, number>): void {
  try {
    const entry: CacheEntry = {
      data,
      timestamp: Date.now(),
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry))
  } catch {
    // localStorage might be unavailable or full
  }
}

function isCacheValid(entry: CacheEntry): boolean {
  return Date.now() - entry.timestamp < CACHE_EXPIRY_MS
}

function parseModelsDevResponse(response: ModelsDevResponse): Record<string, number> {
  const result: Record<string, number> = {}

  for (const providerId of Object.keys(response)) {
    const provider = response[providerId]
    if (!provider.models) continue

    for (const modelId of Object.keys(provider.models)) {
      const model = provider.models[modelId]
      const contextWindow = model.limit?.context
      if (typeof contextWindow === 'number' && contextWindow > 0) {
        result[modelId] = contextWindow
      }
    }
  }

  return result
}

async function fetchModelContextData(): Promise<Record<string, number>> {
  const response = await fetch(API_URL)
  if (!response.ok) {
    throw new Error(`Failed to fetch models.dev: ${response.status}`)
  }
  const data = (await response.json()) as ModelsDevResponse
  return parseModelsDevResponse(data)
}

function getModelContextData(): Promise<Record<string, number>> {
  if (runtimeCache) {
    return Promise.resolve(runtimeCache)
  }

  const cached = getCache()
  if (cached && isCacheValid(cached)) {
    runtimeCache = cached.data
    return Promise.resolve(cached.data)
  }

  if (fetchPromise) {
    return fetchPromise
  }

  fetchPromise = fetchModelContextData()
    .then((data) => {
      runtimeCache = data
      setCache(data)
      fetchPromise = null
      return data
    })
    .catch(() => {
      fetchPromise = null
      return BUILTIN_MODEL_CONTEXT
    })

  return fetchPromise
}

function findExactMatch(modelId: string, data: Record<string, number>): number | null {
  const normalized = modelId.toLowerCase()
  for (const key of Object.keys(data)) {
    if (key.toLowerCase() === normalized) {
      return data[key]
    }
  }
  return null
}

function findPrefixMatch(modelId: string, data: Record<string, number>): number | null {
  const normalized = modelId.toLowerCase()

  let bestMatch: { key: string; value: number } | null = null
  for (const key of Object.keys(data)) {
    const keyLower = key.toLowerCase()
    if (normalized.startsWith(keyLower) || keyLower.startsWith(normalized)) {
      if (!bestMatch || key.length > bestMatch.key.length) {
        bestMatch = { key, value: data[key] }
      }
    }
  }

  return bestMatch?.value ?? null
}

export async function getModelContextWindow(modelId: string): Promise<number | null> {
  if (!modelId) return null

  const data = await getModelContextData()

  const exactMatch = findExactMatch(modelId, data)
  if (exactMatch !== null) return exactMatch

  const prefixMatch = findPrefixMatch(modelId, data)
  if (prefixMatch !== null) return prefixMatch

  const builtinExact = findExactMatch(modelId, BUILTIN_MODEL_CONTEXT)
  if (builtinExact !== null) return builtinExact

  const builtinPrefix = findPrefixMatch(modelId, BUILTIN_MODEL_CONTEXT)
  if (builtinPrefix !== null) return builtinPrefix

  return null
}

export function getModelContextWindowSync(modelId: string): number | null {
  if (!modelId) return null

  const cacheData = runtimeCache ?? getCache()?.data

  if (cacheData) {
    const exactMatch = findExactMatch(modelId, cacheData)
    if (exactMatch !== null) return exactMatch

    const prefixMatch = findPrefixMatch(modelId, cacheData)
    if (prefixMatch !== null) return prefixMatch
  }

  const builtinExact = findExactMatch(modelId, BUILTIN_MODEL_CONTEXT)
  if (builtinExact !== null) return builtinExact

  const builtinPrefix = findPrefixMatch(modelId, BUILTIN_MODEL_CONTEXT)
  if (builtinPrefix !== null) return builtinPrefix

  return null
}

export function getModelContextWindowWithDefault(modelId: string): number {
  return getModelContextWindowSync(modelId) ?? DEFAULT_CONTEXT_WINDOW
}

export function prefetchModelContextData(): void {
  getModelContextData().catch(() => {})
}

export { DEFAULT_CONTEXT_WINDOW, BUILTIN_MODEL_CONTEXT }
