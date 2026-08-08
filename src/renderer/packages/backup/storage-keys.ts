export const BackupStorageKey = {
  Settings: 'settings',
  MyCopilots: 'myCopilots',
  ConfigVersion: 'configVersion',
  ChatSessionsList: 'chat-sessions-list',
  ChatSessionSettings: 'chat-session-settings',
  PictureSessionSettings: 'picture-session-settings',
  AgentSoul: 'agent-soul',
  AgentMemories: 'agent-memories',
} as const

/** Storage keys bundled into the agent-persona.json backup entry. */
export const AGENT_PERSONA_BACKUP_KEYS = [BackupStorageKey.AgentSoul, BackupStorageKey.AgentMemories] as const

export function backupSessionStorageKey(sessionId: string): string {
  return `session:${sessionId}`
}
