import { v4 as uuidv4 } from 'uuid'
import {
  type Message,
  type MessageRole,
  MessageRoleEnum,
  type Session,
  type SessionThread,
  type TokenCountMap,
} from './types/session'
import type { DocumentParserConfig, DocumentParserType } from './types/settings'

export type Updater<T extends object> = Partial<T> | UpdaterFn<T>
export type UpdaterFn<T extends object> = (data: T | null | undefined) => T

export type MessageTokenCountResult = { id: string; tokenCountMap: TokenCountMap; reused: boolean }

export type SettingWindowTab = 'ai' | 'display' | 'chat' | 'advanced' | 'extension' | 'mcp'

export type ExportChatScope = 'all_threads' | 'current_thread'

export type ExportChatFormat = 'Markdown' | 'TXT' | 'HTML'

export function isChatSession(session: Session) {
  return session.type === 'chat' || !session.type
}
export function isPictureSession(session: Session) {
  return session.type === 'picture'
}

export function createMessage(role: MessageRole = MessageRoleEnum.User, content: string = ''): Message {
  return {
    id: uuidv4(),
    contentParts: content ? [{ type: 'text', text: content }] : [],
    role: role,
    timestamp: Date.now(),
  }
}

export type Language =
  | 'en'
  | 'zh-Hans'
  | 'zh-Hant'
  | 'ja'
  | 'ko'
  | 'ru'
  | 'de'
  | 'fr'
  | 'pt-PT'
  | 'es'
  | 'ar'
  | 'it-IT'
  | 'sv'
  | 'nb-NO'

export interface Config {
  uuid: string
}

export interface SponsorAd {
  text: string
  url: string
}

export interface SponsorAboutBanner {
  type: 'picture' | 'picture-text'
  name: string
  pictureUrl: string
  link: string
  title: string
  description: string
}

export interface CopilotDetail {
  id: string
  name: string
  picUrl?: string
  prompt: string
  demoQuestion?: string
  demoAnswer?: string
  starred?: boolean
  usedCount: number
  shared?: boolean
}

export interface Toast {
  id: string
  content: string
  duration?: number
}

export interface RemoteConfig {
  setting_chatboxai_first: boolean
  product_ids: number[]
  knowledge_base_models?: {
    embedding: string
    vision: string
    rerank: string
  }
}

export type ChatboxAIModel = 'chatboxai-3.5' | 'chatboxai-4' | string

export function copyMessage(source: Message): Message {
  return {
    ...source,
    cancel: undefined,
    id: uuidv4(),
  }
}

export function copyThreads(source?: SessionThread[]): SessionThread[] | undefined {
  if (!source) {
    return undefined
  }
  return source.map((thread) => ({
    ...thread,
    messages: thread.messages.map(copyMessage),
    createdAt: Date.now(),
    id: uuidv4(),
  }))
}

// RAG related types
export type KnowledgeBaseProviderMode = 'chatbox-ai' | 'custom'

export interface KnowledgeBase {
  id: number
  name: string
  embeddingModel: string
  rerankModel: string
  visionModel?: string
  providerMode?: KnowledgeBaseProviderMode
  documentParser?: DocumentParserConfig
  createdAt: number
}

export interface KnowledgeBaseFile {
  id: number
  kb_id: number
  filename: string
  filepath: string
  mime_type: string
  file_size: number
  chunk_count: number
  total_chunks: number
  status: string
  error: string
  createdAt: number
  parsed_remotely: number
  parser_type?: DocumentParserType
}

export interface KnowledgeBaseSearchResult {
  id: number
  score: number
  text: string
  fileId: number
  filename: string
  mimeType: string
  chunkIndex: number
}

export type FileMeta = {
  name: string
  path: string
  type: string
  size: number
}

export * from './types/image-generation'
export * from './types/session'
export * from './types/settings'
