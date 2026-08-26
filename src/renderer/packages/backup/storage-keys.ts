export const BackupStorageKey = {
  Settings: 'settings',
  MyCopilots: 'myCopilots',
  ConfigVersion: 'configVersion',
  ChatSessionsList: 'chat-sessions-list',
  ChatSessionSettings: 'chat-session-settings',
  PictureSessionSettings: 'picture-session-settings',
  AgentSoul: 'agent-soul',
  AgentMemories: 'agent-memories',
  CopilotMemories: 'copilot-memories',
  CopilotMemoryOwners: 'copilot-memory-owners',
} as const

/** Storage keys bundled into the agent-persona.json backup entry. */
export const AGENT_PERSONA_BACKUP_KEYS = [BackupStorageKey.AgentSoul, BackupStorageKey.AgentMemories] as const

/** Storage keys exported alongside copilots through the generic key-value entry. */
export const COPILOT_BACKUP_KEYS = [BackupStorageKey.CopilotMemories, BackupStorageKey.CopilotMemoryOwners] as const

export function backupSessionStorageKey(sessionId: string): string {
  return `session:${sessionId}`
}
