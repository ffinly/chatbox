export const COMMAND_APPROVAL_MODES = ['always_ask', 'smart', 'full_access'] as const

export type CommandApprovalMode = (typeof COMMAND_APPROVAL_MODES)[number]

export type RunCommandShell = 'bash' | 'powershell'

export interface RunCommandFailureReference {
  retryOf: string
  command: string
  cwd: string
  shell: RunCommandShell
}

export function resolveCommandApprovalMode(settings: {
  commandApprovalMode?: CommandApprovalMode
  agentFullAccess?: boolean
}): CommandApprovalMode {
  return settings.commandApprovalMode ?? (settings.agentFullAccess === true ? 'full_access' : 'smart')
}
