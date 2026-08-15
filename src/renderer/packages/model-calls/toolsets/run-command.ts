import type { SandboxProvider } from '@shared/sandbox-provider'
import type { CommandApprovalMode, RunCommandShell } from '@shared/types/command-execution'
import type { UserExecApprovalSource } from '@shared/types/user-exec'
import { jsonSchema, type ToolSet } from 'ai'
import { trackAgentModeFullAccessBypass } from '@/analytics/agent-mode'
import { skillsController } from '@/packages/skills/controller'
import { CommandEscalationApprovalPausedError, UserExecApprovalPausedError } from '@/packages/user-exec-approval'
import platform from '@/platform'
import { asRecord, numberField, stringField, toTextModelOutput } from './model-output'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 120_000
const MAX_INLINE_OUTPUT_LENGTH = 12_000
const MAX_JUSTIFICATION_LENGTH = 1_000

interface RunCommandContext {
  sessionId: string
  platform: string
  provider?: SandboxProvider
  ensureSandbox?: () => Promise<{ success: boolean; error?: string }>
  workingDirectories: string[]
  approvalMode: CommandApprovalMode
  requestSmartApproval: (
    toolCallId: string,
    command: string,
    signal?: AbortSignal,
    workdir?: string
  ) => Promise<UserExecApprovalSource>
  onUsed?: () => void
}

interface RunCommandInput {
  command: string
  workdir?: string
  shell?: RunCommandShell
  timeout?: number
  sandbox_permissions?: 'danger-full-access'
  justification?: string
  retry_of?: string
}

interface RunCommandResult {
  success: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  cwd: string
  sandboxed: boolean
  sandboxDenied?: boolean
  retryOf?: string
  cancelled?: boolean
  outputFile?: string
}

function formatRunCommandOutput(output: unknown): string {
  const record = asRecord(output)
  const stdout = stringField(record, 'stdout') ?? ''
  const stderr = stringField(record, 'stderr') ?? ''
  const cwd = stringField(record, 'cwd')
  const retryOf = stringField(record, 'retryOf')
  const outputFile = stringField(record, 'outputFile')
  const exitCode = numberField(record, 'exitCode')
  const sandboxDenied = record?.sandboxDenied === true
  const sections = [`Exit code: ${exitCode ?? 'unknown'}`]
  if (cwd) sections.push(`Working directory: ${cwd}`)
  if (stdout) sections.push(`Stdout:\n${stdout}`)
  if (stderr) sections.push(`Stderr:\n${stderr}`)
  if (!stdout && !stderr) sections.push('(no output)')
  if (outputFile) sections.push(`Output capture: ${outputFile}`)
  if (sandboxDenied) {
    sections.push('Sandbox signal: the command may have been blocked by the file sandbox.')
  }
  if (retryOf) {
    sections.push(
      `The command failed in the sandbox. If host access is genuinely required, retry this exact command, workdir, and shell once with retry_of="${retryOf}", sandbox_permissions="danger-full-access", and a one-sentence justification. Use only this explicitly returned retry reference; never infer retry_of from a tool call id or reuse it for another command. Do not escalate ordinary command errors.`
    )
  }
  return sections.join('\n\n')
}

function normalizedTimeout(timeout: number | undefined): number {
  if (timeout === undefined) return DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('timeout must be a positive number')
  return Math.min(Math.floor(timeout), MAX_TIMEOUT_MS)
}

function truncateToBudget(output: string, budget: number): string {
  if (output.length <= budget) return output
  const marker = '\n... [truncated; see full output file when available] ...\n'
  if (budget <= marker.length) return marker.slice(0, budget)
  const contentBudget = budget - marker.length
  const head = Math.ceil(contentBudget / 2)
  const tail = Math.floor(contentBudget / 2)
  return `${output.slice(0, head)}${marker}${output.slice(-tail)}`
}

function compactCommandOutput(
  stdout: string,
  stderr: string,
  existingOutputFile?: string
): { stdout: string; stderr: string; outputFile?: string } {
  if (stdout.length + stderr.length <= MAX_INLINE_OUTPUT_LENGTH) {
    return { stdout, stderr, ...(existingOutputFile ? { outputFile: existingOutputFile } : {}) }
  }

  const stdoutBudget = stderr ? Math.floor(MAX_INLINE_OUTPUT_LENGTH / 2) : MAX_INLINE_OUTPUT_LENGTH
  const stderrBudget = stdout ? MAX_INLINE_OUTPUT_LENGTH - stdoutBudget : MAX_INLINE_OUTPUT_LENGTH
  return {
    stdout: truncateToBudget(stdout, stdoutBudget),
    stderr: truncateToBudget(stderr, stderrBudget),
    ...(existingOutputFile ? { outputFile: existingOutputFile } : {}),
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
}

export function buildRunCommandTool(context: RunCommandContext): { tool: ToolSet[string]; description: string } {
  const isWindows = context.platform === 'win32'
  const shell: RunCommandShell = isWindows ? 'powershell' : 'bash'
  const sandboxProvider = context.provider
  const sandboxRunCommand = sandboxProvider?.runCommand?.bind(sandboxProvider)
  const ensureSandbox = context.ensureSandbox
  const sandboxAvailable = !isWindows && sandboxRunCommand !== undefined && ensureSandbox !== undefined
  const executionCache = new Map<string, { signature: string; promise: Promise<RunCommandResult> }>()

  const description = `
## Command Execution
Use \`run_command\` for project commands, shell commands, and Node.js scripts. The current platform shell is ${shell}.
- Commands use the selected workdir as cwd. All user-granted workdirs remain writable in the sandbox.
- On macOS/Linux, commands run in the file sandbox first. A failed call returns its retry id to the model without prompting the user.
- Request full host access only after a real failed sandbox call, by retrying the exact command/workdir/shell with \`retry_of\`, \`sandbox_permissions\`, and \`justification\`.
- Use only a \`retry_of\` value explicitly returned in the failed command result. Never infer it from a tool call id; the reference is one-time and command-specific.
- Do not append \`| head\` or \`| tail\` merely to limit output. Output is already bounded; preserve the original command for exact retry matching.
- A sandbox-denied marker is a diagnostic signal, not the only reason a host retry may be appropriate.
- Prefer writing reusable Node.js code to a file, then run it with \`node path/to/script.mjs\`.
`

  const tool: ToolSet[string] = {
    description:
      `Run a ${shell} command in the current project. ` +
      (sandboxAvailable
        ? 'Commands run in the sandbox first; an exact failed call can request a one-time host retry.'
        : 'No OS command sandbox is available on this platform, so host execution follows the session approval policy.'),
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        command: { type: 'string', description: `The ${shell} command to execute.` },
        workdir: {
          type: 'string',
          description:
            'Command working directory. Defaults to the first user-granted workdir, then the sandbox directory.',
        },
        shell: { type: 'string', enum: [shell], description: `Must be ${shell} on this platform.` },
        timeout: { type: 'number', description: `Timeout in milliseconds, capped at ${MAX_TIMEOUT_MS}.` },
        sandbox_permissions: {
          type: 'string',
          enum: ['danger-full-access'],
          description: 'Request a one-time host retry. Valid only with retry_of and justification.',
        },
        justification: {
          type: 'string',
          maxLength: MAX_JUSTIFICATION_LENGTH,
          description: 'One sentence explaining why this exact failed command needs host access.',
        },
        retry_of: {
          type: 'string',
          description: 'Opaque one-time reference explicitly returned by the exact failed sandboxed command.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    }),
    execute: (rawInput, toolOptions) => {
      const input = rawInput as RunCommandInput
      if (!input.command.trim()) return Promise.reject(new Error('command must not be empty'))
      if (input.workdir !== undefined && !input.workdir.trim()) {
        return Promise.reject(new Error('workdir must not be empty'))
      }
      if (input.shell !== undefined && input.shell !== shell) {
        return Promise.reject(new Error(`run_command uses ${shell} on this platform`))
      }
      const escalationFields = [input.sandbox_permissions, input.justification, input.retry_of]
      const escalationRequested = escalationFields.some((value) => value !== undefined)
      if (escalationRequested && escalationFields.some((value) => value === undefined)) {
        return Promise.reject(
          new Error('sandbox_permissions, justification, and retry_of must be provided together for a host retry')
        )
      }
      if (input.justification !== undefined && !input.justification.trim()) {
        return Promise.reject(new Error('justification must be a non-empty sentence'))
      }
      if (input.justification !== undefined && input.justification.length > MAX_JUSTIFICATION_LENGTH) {
        return Promise.reject(new Error(`justification must not exceed ${MAX_JUSTIFICATION_LENGTH} characters`))
      }
      if (input.retry_of !== undefined && !input.retry_of.trim()) {
        return Promise.reject(new Error('retry_of must not be empty'))
      }

      const signature = JSON.stringify(input)
      const existing = executionCache.get(toolOptions.toolCallId)
      if (existing) {
        if (existing.signature !== signature) {
          return Promise.reject(new Error(`Tool call ${toolOptions.toolCallId} was reused with different arguments`))
        }
        return existing.promise
      }

      let hostExecutionStarted = false
      const execution = Promise.resolve().then(async (): Promise<RunCommandResult> => {
        const timeout = normalizedTimeout(input.timeout)
        const approvalContext = toolOptions as typeof toolOptions & { approved?: boolean; approvalWorkdir?: string }
        const alreadyApproved = approvalContext.approved === true
        const fullAccess = context.approvalMode === 'full_access'

        let sandboxReady = false
        let sandboxWorkingDirectory: string | undefined
        if (sandboxRunCommand && ensureSandbox) {
          try {
            sandboxReady = (await ensureSandbox()).success
          } catch {
            // A runtime startup failure is recoverable through the normal host approval path below.
          }
          throwIfAborted(toolOptions.abortSignal)
          if (sandboxReady) {
            const status = await sandboxProvider?.getStatus().catch(() => undefined)
            sandboxWorkingDirectory = status?.workingDirectory ?? undefined
          }
        }

        if (!isWindows && sandboxRunCommand && sandboxReady && !fullAccess && !escalationRequested) {
          const cwd = input.workdir ?? sandboxProvider?.getAcceptedExtraWritableDirs?.()[0] ?? sandboxWorkingDirectory
          if (!cwd) throw new Error('No sandbox working directory is available')
          const cancel = () => {
            void platform.sandboxKill?.({ sessionId: context.sessionId, toolCallId: toolOptions.toolCallId })
          }
          toolOptions.abortSignal?.addEventListener('abort', cancel, { once: true })
          try {
            const result = await sandboxRunCommand({
              command: input.command,
              shell,
              workdir: cwd,
              timeout,
              toolCallId: toolOptions.toolCallId,
            })
            const executedCwd = result.cwd ?? cwd
            const output = compactCommandOutput(result.stdout, result.stderr, result.outputFile)
            context.onUsed?.()
            return {
              success: result.exitCode === 0,
              exitCode: result.exitCode,
              stdout: output.stdout,
              stderr: output.stderr,
              cwd: executedCwd,
              sandboxed: true,
              ...(output.outputFile ? { outputFile: output.outputFile } : {}),
              ...(result.sandbox?.denied ? { sandboxDenied: true } : {}),
              ...(result.retryOf ? { retryOf: result.retryOf } : {}),
            }
          } finally {
            toolOptions.abortSignal?.removeEventListener('abort', cancel)
          }
        }

        const baseCwd = context.workingDirectories[0] ?? sandboxWorkingDirectory
        const cwd = await skillsController.resolveUserExecCwd({ cwd: input.workdir, baseCwd })
        const approvalMatchesCwd = alreadyApproved && approvalContext.approvalWorkdir === cwd
        if (escalationRequested) {
          const retryOf = input.retry_of
          const justification = input.justification
          if (!retryOf || !justification || input.sandbox_permissions !== 'danger-full-access') {
            throw new Error('Invalid host retry request')
          }
          if (!cwd) throw new Error('A workdir is required to retry a sandboxed command with host access')
          const retry = await skillsController.checkCommandRetry({
            sessionId: context.sessionId,
            retryOf,
            command: input.command,
            cwd,
            shell,
          })
          if (!retry.valid) throw new Error(retry.error)
          if (!approvalMatchesCwd && !fullAccess) {
            throw new CommandEscalationApprovalPausedError(
              toolOptions.toolCallId,
              input.command,
              retryOf,
              justification,
              cwd
            )
          }
        }

        let approvalSource: UserExecApprovalSource
        if (approvalMatchesCwd) approvalSource = 'user'
        else if (fullAccess) approvalSource = 'full_access'
        else if (context.approvalMode === 'always_ask') {
          throw new UserExecApprovalPausedError(toolOptions.toolCallId, input.command, undefined, undefined, cwd)
        } else {
          approvalSource = await context.requestSmartApproval(
            toolOptions.toolCallId,
            input.command,
            toolOptions.abortSignal,
            cwd
          )
        }

        if (!alreadyApproved && fullAccess) {
          trackAgentModeFullAccessBypass({ tool: 'run_command' })
        }
        throwIfAborted(toolOptions.abortSignal)
        hostExecutionStarted = true
        const cancel = () => {
          void skillsController.cancelUserExec({ sessionId: context.sessionId, toolCallId: toolOptions.toolCallId })
        }
        toolOptions.abortSignal?.addEventListener('abort', cancel, { once: true })
        try {
          const result = await skillsController.userExec(input.command, {
            ...(cwd ? { cwd } : {}),
            timeout,
            sessionId: context.sessionId,
            toolCallId: toolOptions.toolCallId,
            approvalSource,
            ...(input.retry_of ? { retryOf: input.retry_of, shell } : {}),
            ...(baseCwd ? { baseCwd } : {}),
            injectBundledNode: true,
          })
          const output = compactCommandOutput(result.stdout, result.stderr, result.outputFile)
          context.onUsed?.()
          return {
            success: result.success,
            exitCode: result.exitCode,
            stdout: output.stdout,
            stderr: output.stderr,
            cwd: result.cwd ?? cwd ?? '(user home)',
            sandboxed: false,
            ...(output.outputFile ? { outputFile: output.outputFile } : {}),
            ...(result.cancelled ? { cancelled: true } : {}),
          }
        } finally {
          toolOptions.abortSignal?.removeEventListener('abort', cancel)
        }
      })

      executionCache.set(toolOptions.toolCallId, { signature, promise: execution })
      void execution.catch(() => {
        if (!hostExecutionStarted && executionCache.get(toolOptions.toolCallId)?.promise === execution) {
          executionCache.delete(toolOptions.toolCallId)
        }
      })
      return execution
    },
    toModelOutput: toTextModelOutput(formatRunCommandOutput),
  }

  return { tool, description }
}
