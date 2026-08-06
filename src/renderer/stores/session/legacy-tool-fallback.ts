import { applyLegacyToolFallback as applySharedLegacyToolFallback } from '@shared/generation/legacy-tool-fallback'
import { uniqueId } from 'lodash'
import {
  combinedSearchByPromptEngineering,
  constructMessagesWithKnowledgeBaseResults,
  constructMessagesWithSearchResults,
  knowledgeBaseSearchByPromptEngineering,
  searchByPromptEngineering,
} from '@/packages/model-calls/tools'

export type {
  LegacyCombinedSearchResult,
  LegacyKnowledgeBaseSearchResult,
  LegacyToolFallbackDependencies,
  LegacyToolFallbackOptions,
  LegacyToolFallbackResult,
  LegacyWebSearchResult,
} from '@shared/generation/legacy-tool-fallback'

export function applyLegacyToolFallback(
  options: Parameters<typeof applySharedLegacyToolFallback>[0]
): ReturnType<typeof applySharedLegacyToolFallback> {
  return applySharedLegacyToolFallback(options, {
    combinedSearchByPromptEngineering,
    constructMessagesWithKnowledgeBaseResults,
    constructMessagesWithSearchResults,
    knowledgeBaseSearchByPromptEngineering,
    searchByPromptEngineering,
    createUniqueId: uniqueId,
  })
}
