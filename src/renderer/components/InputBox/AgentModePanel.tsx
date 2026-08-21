import { ActionIcon, Badge, Button, Divider, Flex, Group, Loader, Stack, Switch, Text } from '@mantine/core'
import { TestId } from '@shared/automation/testids'
import type { AgentModeValue, KnowledgeBase } from '@shared/types'
import { hasConversationStarted, resolveSessionMode } from '@chatbox/core/session/mode-policy'
import {
  IconCheck,
  IconChevronRight,
  IconCode,
  IconFile,
  IconFolderCog,
  IconHammer,
  IconNotes,
  IconSettings2,
  IconVocabulary,
  IconWand,
  IconWorldWww,
} from '@tabler/icons-react'
import { Link } from '@tanstack/react-router'
import { PlusIcon } from 'lucide-react'
import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  trackAgentModeSelect,
  trackMemoryClick,
  trackSmartSwitchingClick,
  trackWebSearchClick,
} from '@/analytics/agent-mode'
import { rendererApplication } from '@/app/renderer-application'
import { AppTooltip as Tooltip } from '@/components/ui/tooltip'
import { useKnowledgeBases } from '@/hooks/knowledge-base'
import { useMCPServerStatus, useToggleMCPServer } from '@/hooks/mcp'
import { navigateToSettings } from '@/modals/settings-navigation'
import { BUILTIN_MCP_SERVERS } from '@/packages/mcp/builtin'
import { skillsController, subscribeSkillsChanged } from '@/packages/skills/controller'
import { WEB_SEARCH_PROVIDERS, type WebSearchProviderValue } from '@/packages/web-search/constants'
import { listMemories } from '@/stores/agentPersonaStore'
import { useAutoValidate } from '@/stores/premiumActions'
import { setSessionAgentMode, useSessionAgentMode } from '@/stores/session/agent-mode'
import { useMcpSettings, useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import { ScalableIcon } from '../common/ScalableIcon'
import MCPStatus from '../mcp/MCPStatus'
import { CommandApprovalOptions, WorkingDirectoryContent } from './AgentModeSettingsContent'
import AgentModeStatusIcon from './AgentModeStatusIcon'
import { getAgentModeUIState } from './agentModeState'
import {
  supportsWorkingDirectories,
  useCommandApprovalModeState,
  useWorkingDirectoriesState,
} from './useAgentModeSettingsState'

const useSession = (sessionId: string | null) => rendererApplication.sessionHooks.useSession(sessionId)

type PanelPage =
  | 'main'
  | 'web-search'
  | 'memory'
  | 'code-execution'
  | 'skills'
  | 'mcp'
  | 'knowledge-base'
  | 'working-directory'

export interface AgentModePanelProps {
  sessionId: string
  providerId?: string
  modelId?: string
  modelSupportsAgentMode?: boolean
  webBrowsingMode: boolean
  onWebBrowsingChange: (enabled: boolean) => void
  currentKnowledgeBaseId?: number
  onKnowledgeBaseSelect: (kb: KnowledgeBase | null) => void
  onSkillSelect: (skillName: string) => void
  onClose: () => void
}

// --- Sub-components ---

const MCPServerItem: FC<{
  id: string
  name: string
  enabled: boolean
  disabled?: boolean
  onEnabledChange: (id: string, enabled: boolean) => void
}> = ({ id, name, enabled, disabled = false, onEnabledChange }) => {
  const status = useMCPServerStatus(id)
  return (
    <Flex
      justify="space-between"
      align="center"
      px="sm"
      py={6}
      className={`rounded ${
        disabled ? 'opacity-50' : 'hover:bg-[var(--mantine-color-gray-0)] dark:hover:bg-[var(--mantine-color-dark-5)]'
      }`}
    >
      <Flex gap="xs" align="center">
        <MCPStatus status={status} />
        <Text size="sm">{name}</Text>
      </Flex>
      <Switch
        checked={enabled}
        size="xs"
        disabled={disabled || status?.state === 'starting' || status?.state === 'stopping'}
        onChange={(e) => onEnabledChange(id, e.currentTarget.checked)}
      />
    </Flex>
  )
}

// --- Main component ---

const AgentModePanel: FC<AgentModePanelProps> = ({
  sessionId,
  providerId,
  modelId,
  modelSupportsAgentMode = true,
  webBrowsingMode,
  onWebBrowsingChange,
  currentKnowledgeBaseId,
  onKnowledgeBaseSelect,
  onSkillSelect,
  onClose,
}) => {
  const { t } = useTranslation()
  const [page, setPage] = useState<PanelPage>('main')
  const closeTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const openTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const panelRef = useRef<HTMLDivElement>(null)
  const subPanelRef = useRef<HTMLDivElement>(null)
  const [subPanelAlign, setSubPanelAlign] = useState<'top' | 'bottom'>('bottom')
  const [subPanelTop, setSubPanelTop] = useState<number>(0)
  const isNewSession = sessionId === 'new'
  const { session: currentSession } = useSession(isNewSession ? null : sessionId)

  // Agent mode state
  const setAgentModeSmartSwitchingDefault = useUIStore((s) => s.setAgentModeSmartSwitchingDefault)
  const setAgentModeLastSelected = useUIStore((s) => s.setAgentModeLastSelected)
  const entry = useSessionAgentMode(sessionId)
  const agentModeUIState = useMemo(
    () => getAgentModeUIState(entry, modelSupportsAgentMode),
    [entry, modelSupportsAgentMode]
  )
  const workModeCapabilitiesDisabled = agentModeUIState.capabilitiesDisabled

  // Web Search state
  const webSearchProvider = useSettingsStore((s) => s.extension.webSearch.provider)
  const setSettings = useSettingsStore((s) => s.setSettings)
  const licenseKey = useSettingsStore((s) => s.licenseKey)
  const tavilyApiKey = useSettingsStore((s) => s.extension.webSearch.tavilyApiKey)
  const bochaApiKey = useSettingsStore((s) => s.extension.webSearch.bochaApiKey)
  const queritApiKey = useSettingsStore((s) => s.extension.webSearch.queritApiKey)
  const webSearchProviderLabel =
    WEB_SEARCH_PROVIDERS.find((p) => p.value === webSearchProvider)?.label ?? webSearchProvider

  // Memory is a global preference (all chats), not a per-session capability.
  const memoryEnabled = useSettingsStore((s) => s.memoryEnabled !== false)
  const [memoryCount, setMemoryCount] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    void listMemories()
      .then((entries) => {
        if (!cancelled) setMemoryCount(entries.length)
      })
      .catch(() => {
        if (!cancelled) setMemoryCount(0)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const isProviderAvailable = useCallback(
    (provider: WebSearchProviderValue) => {
      if (provider === 'build-in') return !!licenseKey
      if (provider === 'tavily') return !!tavilyApiKey
      if (provider === 'bocha') return !!bochaApiKey
      if (provider === 'querit') return !!queritApiKey
      return true
    },
    [bochaApiKey, licenseKey, queritApiKey, tavilyApiKey]
  )

  // MCP state
  const mcp = useMcpSettings()
  const isPremium = useAutoValidate()
  const onMCPEnabledChange = useToggleMCPServer()
  const enabledMCPCount = mcp.servers.filter((s) => s.enabled).length + mcp.enabledBuiltinServers.length

  // Knowledge Base state
  const { data: knowledgeBases } = useKnowledgeBases()

  // Skills state
  const [skills, setSkills] = useState<Array<{ name: string; description: string }>>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillsVersion, setSkillsVersion] = useState(0)
  const enabledSkillNames = useSettingsStore((s) => s.skills.enabledSkillNames)

  const loadSkills = useCallback(async () => {
    setSkillsLoading(true)
    try {
      const allSkills = await skillsController.discoverSkills()
      setSkills(allSkills.map((s) => ({ name: s.name, description: s.description })))
    } catch {
      setSkills([])
    } finally {
      setSkillsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (page === 'skills') {
      void loadSkills()
    }
  }, [page, loadSkills, skillsVersion])

  useEffect(() => {
    return subscribeSkillsChanged(() => {
      setSkillsVersion((version) => version + 1)
    })
  }, [])

  const enabledSkills = useMemo(
    () => skills.filter((s) => enabledSkillNames.includes(s.name)),
    [skills, enabledSkillNames]
  )

  const handleModeChange = useCallback(
    (value: AgentModeValue) => {
      if (entry.value === value) return
      trackAgentModeSelect({
        sessionId,
        mode: value === 'on' ? 'work_mode' : 'chat_mode',
        provider: providerId,
        model: modelId,
      })
      // Remember the explicit choice so new chats start in the same mode.
      if (value !== 'auto') {
        setAgentModeLastSelected(value)
      }
      void setSessionAgentMode(sessionId, value)
    },
    [entry.value, modelId, providerId, sessionId, setAgentModeLastSelected]
  )
  const handleSmartSwitchingChange = useCallback(
    (enabled: boolean) => {
      trackSmartSwitchingClick(
        {
          sessionId,
          mode: 'chat_mode',
          provider: providerId,
          model: modelId,
        },
        enabled
      )
      setAgentModeSmartSwitchingDefault(enabled)
      void setSessionAgentMode(sessionId, enabled ? 'auto' : 'off')
    },
    [modelId, providerId, sessionId, setAgentModeSmartSwitchingDefault]
  )

  // Command approval + working directories are shared with the composer status row
  // (WorkModeStatusRow): one store, two entry points, so both stay in sync.
  const { commandApprovalMode, updateCommandApprovalMode } = useCommandApprovalModeState(sessionId, {
    providerId,
    modelId,
  })
  const {
    workingDirectories,
    availableRecentDirectories,
    addWorkingDirectory: handleAddWorkingDirectory,
    selectRecentDirectory: handleSelectRecentDirectory,
    removeWorkingDirectory: handleRemoveWorkingDirectory,
  } = useWorkingDirectoriesState(sessionId)

  const selectedKB = useMemo(
    () => knowledgeBases?.find((kb) => kb.id === currentKnowledgeBaseId),
    [knowledgeBases, currentKnowledgeBaseId]
  )

  // Hover handlers for sub-panel with delay to prevent flicker
  const clearSubPanelCloseTimer = useCallback(() => {
    clearTimeout(closeTimerRef.current)
    closeTimerRef.current = undefined
  }, [])

  const clearSubPanelOpenTimer = useCallback(() => {
    clearTimeout(openTimerRef.current)
    openTimerRef.current = undefined
  }, [])

  const scheduleSubPanelClose = useCallback(
    (delay: number) => {
      clearSubPanelCloseTimer()
      clearSubPanelOpenTimer()
      closeTimerRef.current = setTimeout(() => {
        setPage('main')
        closeTimerRef.current = undefined
      }, delay)
    },
    [clearSubPanelCloseTimer, clearSubPanelOpenTimer]
  )

  const handleExtensionHover = useCallback(
    (target: PanelPage, e?: React.MouseEvent, align: 'top' | 'bottom' = 'bottom') => {
      clearSubPanelCloseTimer()
      clearSubPanelOpenTimer()

      let nextSubPanelTop = 0
      if (align === 'top' && e && panelRef.current) {
        const row = e.currentTarget as HTMLElement
        const panelRect = panelRef.current.getBoundingClientRect()
        const rowRect = row.getBoundingClientRect()
        nextSubPanelTop = rowRect.top - panelRect.top
      }

      const openTarget = () => {
        setPage(target)
        setSubPanelAlign(align)
        if (align === 'top') {
          setSubPanelTop(nextSubPanelTop)
        }
      }

      if (page === 'main' || page === target) {
        openTarget()
        return
      }

      openTimerRef.current = setTimeout(openTarget, 180)
    },
    [clearSubPanelCloseTimer, clearSubPanelOpenTimer, page]
  )

  const handleSubPanelEnter = useCallback(() => {
    clearSubPanelCloseTimer()
    clearSubPanelOpenTimer()
  }, [clearSubPanelCloseTimer, clearSubPanelOpenTimer])

  const handleSubPanelLeave = useCallback(() => {
    scheduleSubPanelClose(300)
  }, [scheduleSubPanelClose])

  const handleNonExtensionHover = useCallback(() => {
    scheduleSubPanelClose(200)
  }, [scheduleSubPanelClose])

  const resetSubPanel = useCallback(() => {
    clearSubPanelCloseTimer()
    clearSubPanelOpenTimer()
    setPage('main')
  }, [clearSubPanelCloseTimer, clearSubPanelOpenTimer])

  useEffect(() => {
    return () => {
      clearTimeout(closeTimerRef.current)
      clearTimeout(openTimerRef.current)
    }
  }, [])

  useEffect(() => {
    subPanelRef.current?.scrollTo({ top: 0 })
  }, [page])

  // Manual cross-mode switching (chat ↔ work) is only offered before the
  // conversation starts — mirroring the work-side `entry.locked` in the other
  // direction. Same-mode toggles are unaffected; the store enforces the same
  // rule in setSessionAgentMode.
  const conversationStarted = useMemo(
    () => (currentSession ? hasConversationStarted(currentSession) : false),
    [currentSession]
  )

  // --- Mode button ---
  const ModeButton: FC<{ value: Extract<AgentModeValue, 'on' | 'off'>; label: string }> = ({ value, label }) => {
    const isActive = agentModeUIState.displayValue === value
    const isLockedDisabled = entry.locked && value !== 'on'
    const isSwitchFrozen = conversationStarted && resolveSessionMode(value) !== resolveSessionMode(entry.value)
    const isModelDisabled = !modelSupportsAgentMode && value !== 'off'
    const isDisabled = isLockedDisabled || isSwitchFrozen || isModelDisabled
    const tooltipLabel = isModelDisabled
      ? t('This model does not support Agent Mode')
      : t('Locked after the chat starts to keep tools and context consistent — start a new chat to change')
    return (
      <Tooltip label={tooltipLabel} disabled={!isDisabled} withArrow zIndex={3000}>
        <span className="flex min-w-0 flex-1">
          <Button
            data-testid={value === 'off' ? TestId.agent.modeChat : TestId.agent.modeWork}
            size="xs"
            variant={isActive ? 'filled' : 'default'}
            color={isActive ? 'chatbox-brand' : undefined}
            fullWidth
            disabled={isDisabled}
            leftSection={<AgentModeStatusIcon mode={value} size={14} />}
            // Long locales (fr/pt/ru) wrap onto a second line instead of being clipped mid-word
            styles={{ root: { height: 'auto', minHeight: 26 }, label: { whiteSpace: 'normal', paddingBlock: 4 } }}
            onClick={() => handleModeChange(value)}
          >
            {label}
          </Button>
        </span>
      </Tooltip>
    )
  }

  const isChatModeSelected = agentModeUIState.displayValue === 'off'
  const smartSwitchingEnabled = entry.value === 'auto' && isChatModeSelected
  const smartSwitchingExpired =
    !isNewSession && Boolean(currentSession?.messages.some((message) => message.role === 'user'))
  const isSmartSwitchingDisabled = entry.locked || !modelSupportsAgentMode || smartSwitchingExpired
  const modeDescription = agentModeUIState.isActive
    ? t('Best for multi-step tasks with files, code execution, tools, MCP, skills, or knowledge bases.')
    : t('Best for quick Q&A, writing, translation, explanations, and web search.')
  const smartSwitchingDescription = smartSwitchingExpired
    ? t('Only available before the first message.')
    : t('Suggest Work Mode on the first message.')

  // --- Extension row ---
  const ExtensionRow: FC<{
    icon: React.ReactNode
    label: string
    badge?: string | number
    subtitle?: string
    active?: boolean
    page: PanelPage
    rightContent?: React.ReactNode
    subPanelAlign?: 'top' | 'bottom'
    disabled?: boolean
  }> = ({
    icon,
    label,
    badge,
    subtitle,
    active,
    page: targetPage,
    rightContent,
    subPanelAlign = 'bottom',
    disabled = false,
  }) => (
    <Flex
      justify="space-between"
      align="center"
      px="sm"
      py={6}
      tabIndex={0}
      role="button"
      aria-expanded={active}
      aria-disabled={disabled}
      className={`rounded outline-none focus-visible:ring-2 focus-visible:ring-[var(--chatbox-tint-brand)] ${
        active
          ? 'bg-[var(--mantine-color-gray-1)] dark:bg-[var(--mantine-color-dark-5)]'
          : disabled
            ? ''
            : 'hover:bg-[var(--mantine-color-gray-0)] dark:hover:bg-[var(--mantine-color-dark-5)]'
      } ${disabled ? 'cursor-default opacity-50' : 'cursor-pointer'}`}
      onMouseEnter={(e) => handleExtensionHover(targetPage, e, subPanelAlign)}
      onMouseLeave={clearSubPanelOpenTimer}
      onFocus={(e) => handleExtensionHover(targetPage, e as unknown as React.MouseEvent, subPanelAlign)}
      onBlur={handleSubPanelLeave}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleExtensionHover(targetPage, e as unknown as React.MouseEvent, subPanelAlign)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          resetSubPanel()
        }
      }}
    >
      <Flex gap="xs" align="center" className="min-w-0">
        {icon}
        <Text size="sm">{label}</Text>
        {badge !== undefined && (
          <Badge size="xs" variant="light">
            {badge}
          </Badge>
        )}
        {subtitle && (
          <Text size="xs" c="dimmed" truncate className="max-w-[100px]">
            {subtitle}
          </Text>
        )}
      </Flex>
      {rightContent ?? <IconChevronRight size={14} className="text-[var(--chatbox-tint-tertiary)] shrink-0" />}
    </Flex>
  )

  // --- Sub-panel header ---
  const SubPanelHeader: FC<{ title: string; settingsPath?: string; disabled?: boolean }> = ({
    title,
    settingsPath,
    disabled = false,
  }) => (
    <Flex justify="space-between" align="center" px="sm" py="xs">
      <Text fw={600} size="sm">
        {title}
      </Text>
      {settingsPath && (
        <ActionIcon
          variant="subtle"
          size={20}
          disabled={disabled}
          onClick={() => {
            if (disabled) return
            onClose()
            navigateToSettings(settingsPath)
          }}
        >
          <ScalableIcon icon={IconSettings2} size={16} color="var(--chatbox-tint-tertiary)" />
        </ActionIcon>
      )}
    </Flex>
  )

  const handleWebSearchProviderChange = useCallback(
    (provider: WebSearchProviderValue) => {
      setSettings((draft) => {
        draft.extension.webSearch.provider = provider
      })
    },
    [setSettings]
  )

  const handleMemoryEnabledChange = useCallback(
    (enabled: boolean) => {
      trackMemoryClick(
        {
          sessionId,
          mode: agentModeUIState.isActive ? 'work_mode' : 'chat_mode',
          provider: providerId,
          model: modelId,
        },
        enabled
      )
      setSettings({ memoryEnabled: enabled })
    },
    [agentModeUIState.isActive, modelId, providerId, sessionId, setSettings]
  )

  // --- Sub-panel content ---
  const renderSubPanel = () => {
    if (page === 'web-search') {
      return (
        <>
          <SubPanelHeader title={t('Web Search')} settingsPath="/web-search" />
          <Divider my={4} />
          {WEB_SEARCH_PROVIDERS.map((provider) => {
            const available = isProviderAvailable(provider.value)
            const isSelected = webSearchProvider === provider.value
            return (
              <Tooltip
                key={provider.value}
                label={t('Configure in Settings')}
                disabled={available}
                withArrow
                position="right"
              >
                <Flex
                  justify="space-between"
                  align="center"
                  px="sm"
                  py={6}
                  className={`rounded ${
                    available
                      ? 'cursor-pointer hover:bg-[var(--mantine-color-gray-0)] dark:hover:bg-[var(--mantine-color-dark-5)]'
                      : 'cursor-default opacity-50'
                  }`}
                  onClick={() => {
                    if (available) {
                      handleWebSearchProviderChange(provider.value)
                    } else {
                      onClose()
                      navigateToSettings('/web-search')
                    }
                  }}
                >
                  <Text size="sm" c={isSelected ? 'chatbox-brand' : available ? '' : 'dimmed'}>
                    {provider.label}
                  </Text>
                  {isSelected && <IconCheck size={14} color="var(--chatbox-tint-brand)" />}
                </Flex>
              </Tooltip>
            )
          })}
        </>
      )
    }

    if (page === 'memory') {
      return (
        <>
          <SubPanelHeader title={t('Global Memory')} settingsPath="/agent" />
          <Divider my={4} />
          <Text size="xs" c="chatbox-secondary" px="sm" py={6} className="leading-snug">
            {memoryEnabled
              ? t('Applies to every chat. This conversation can read and write new long-term memories.')
              : t('Off for every chat. Nothing new is saved, and existing memories are not used.')}
          </Text>
          <Divider my={4} />
          {memoryCount === null ? (
            <Flex justify="center" py="md">
              <Loader size="sm" />
            </Flex>
          ) : (
            <Group justify="space-between" align="center" px="sm" py="xs">
              <Text size="xs" c="dimmed">
                {memoryCount === 0 ? t('No memories saved yet.') : t('{{count}} saved', { count: memoryCount })}
              </Text>
              <Button
                size="xs"
                variant="light"
                onClick={() => {
                  onClose()
                  navigateToSettings('/agent')
                }}
              >
                {t('Manage memories')}
              </Button>
            </Group>
          )}
        </>
      )
    }

    if (page === 'code-execution') {
      return (
        <>
          <SubPanelHeader title={t('Code Execution')} disabled={workModeCapabilitiesDisabled} />
          <Divider my={4} />
          <CommandApprovalOptions
            mode={commandApprovalMode}
            disabled={workModeCapabilitiesDisabled}
            onSelect={(mode) => void updateCommandApprovalMode(mode)}
          />
        </>
      )
    }

    if (page === 'skills') {
      return (
        <>
          <SubPanelHeader title="Skills" settingsPath="/skills" disabled={workModeCapabilitiesDisabled} />
          <Divider my={4} />
          {skillsLoading ? (
            <Flex justify="center" py="md">
              <Loader size="sm" />
            </Flex>
          ) : enabledSkills.length > 0 ? (
            enabledSkills.map((skill) => (
              <Flex
                key={skill.name}
                px="sm"
                py={6}
                className={`rounded ${
                  workModeCapabilitiesDisabled
                    ? 'cursor-default opacity-50'
                    : 'cursor-pointer hover:bg-[var(--mantine-color-gray-0)] dark:hover:bg-[var(--mantine-color-dark-5)]'
                }`}
                gap="xs"
                align="center"
                onClick={() => {
                  if (workModeCapabilitiesDisabled) return
                  onSkillSelect(skill.name)
                  onClose()
                }}
              >
                <IconWand size={14} className="text-[var(--chatbox-tint-tertiary)] shrink-0" />
                <Stack gap={0} className="min-w-0">
                  <Text size="sm" truncate>
                    /{skill.name}
                  </Text>
                  {skill.description && (
                    <Text size="xs" c="dimmed" truncate>
                      {skill.description}
                    </Text>
                  )}
                </Stack>
              </Flex>
            ))
          ) : (
            <Group justify="center" py="md">
              <Button
                size="xs"
                variant="light"
                disabled={workModeCapabilitiesDisabled}
                onClick={() => {
                  if (workModeCapabilitiesDisabled) return
                  onClose()
                  navigateToSettings('/skills')
                }}
              >
                <PlusIcon size={14} className="mr-1" />
                {t('Add Skills')}
              </Button>
            </Group>
          )}
        </>
      )
    }

    if (page === 'mcp') {
      return (
        <>
          <SubPanelHeader title="MCP" settingsPath="/mcp" disabled={workModeCapabilitiesDisabled} />
          <Divider my={4} />
          {isPremium && (
            <>
              {BUILTIN_MCP_SERVERS.map((server) => (
                <MCPServerItem
                  key={server.id}
                  id={server.id}
                  name={server.name}
                  enabled={mcp.enabledBuiltinServers.includes(server.id)}
                  disabled={workModeCapabilitiesDisabled}
                  onEnabledChange={onMCPEnabledChange}
                />
              ))}
              {mcp.servers.length > 0 && <Divider my={4} />}
            </>
          )}
          {mcp.servers.map((server) => (
            <MCPServerItem
              key={server.id}
              id={server.id}
              name={server.name}
              enabled={server.enabled}
              disabled={workModeCapabilitiesDisabled}
              onEnabledChange={onMCPEnabledChange}
            />
          ))}
          {!mcp.servers.length && !mcp.enabledBuiltinServers.length && (
            <Group justify="center" py="md">
              <Button
                size="xs"
                variant="light"
                disabled={workModeCapabilitiesDisabled}
                onClick={() => {
                  if (workModeCapabilitiesDisabled) return
                  onClose()
                  navigateToSettings('/mcp')
                }}
              >
                <PlusIcon size={14} className="mr-1" />
                {t('Add your first MCP server')}
              </Button>
            </Group>
          )}
        </>
      )
    }

    if (page === 'knowledge-base') {
      return (
        <>
          <SubPanelHeader title={t('Knowledge Base')} settingsPath="/knowledge-base" />
          <Divider my={4} />
          {knowledgeBases && knowledgeBases.length > 0 ? (
            knowledgeBases.map((kb) => (
              <Flex
                key={kb.id}
                justify="space-between"
                align="center"
                px="sm"
                py={6}
                className="rounded cursor-pointer hover:bg-[var(--mantine-color-gray-0)] dark:hover:bg-[var(--mantine-color-dark-5)]"
                onClick={() => {
                  onKnowledgeBaseSelect(kb.id === currentKnowledgeBaseId ? null : kb)
                  onClose()
                }}
              >
                <Flex gap="xs" align="center">
                  <IconFile size={14} />
                  <Text size="sm" c={kb.id === currentKnowledgeBaseId ? 'chatbox-brand' : ''}>
                    {kb.name}
                  </Text>
                </Flex>
                {kb.id === currentKnowledgeBaseId && <IconCheck size={14} color="var(--chatbox-tint-brand)" />}
              </Flex>
            ))
          ) : (
            <Group justify="center" py="md">
              <Link to="/settings/knowledge-base">
                <Button
                  size="xs"
                  variant="light"
                  onClick={() => {
                    onClose()
                  }}
                >
                  <PlusIcon size={14} className="mr-1" />
                  {t('Create')}
                </Button>
              </Link>
            </Group>
          )}
        </>
      )
    }

    if (page === 'working-directory') {
      return (
        <>
          <SubPanelHeader title={t('Working Directory')} disabled={workModeCapabilitiesDisabled} />
          <Divider my={4} />
          <WorkingDirectoryContent
            workingDirectories={workingDirectories}
            availableRecentDirectories={availableRecentDirectories}
            disabled={workModeCapabilitiesDisabled}
            onRemove={(dir) => void handleRemoveWorkingDirectory(dir)}
            onSelectRecent={(dir) => void handleSelectRecentDirectory(dir)}
            onAdd={() => void handleAddWorkingDirectory()}
          />
        </>
      )
    }

    return null
  }

  // ==================== RENDER ====================
  return (
    <div
      data-testid={TestId.agent.modePanel}
      className="relative"
      ref={panelRef}
      onMouseLeave={handleSubPanelLeave}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && page === 'main') {
          e.preventDefault()
          onClose()
        }
      }}
    >
      {/* Main panel - always visible */}
      {/* Width follows the mode labels (localized text can be much wider than English) within a clamp.
          The clamp also tracks the viewport: the window can be resized down to 280px (see window_state.ts). */}
      <Stack gap={0} py="xs" className="w-max min-w-[min(240px,calc(100vw-24px))] max-w-[min(340px,calc(100vw-24px))]">
        {/* Header: mode switcher */}
        <Stack gap="xs" px="sm" py="xs" onMouseEnter={handleNonExtensionHover}>
          <Text fw={600} size="sm" c="chatbox-primary">
            {t('Mode')}
          </Text>
          <Flex gap={6}>
            <ModeButton value="off" label={t('Chat Mode')} />
            <ModeButton value="on" label={t('Work Mode')} />
          </Flex>
          <Text size="xs" c="chatbox-secondary" className="leading-snug max-w-[244px]">
            {modeDescription}
          </Text>
          {isChatModeSelected && (
            <Flex
              justify="space-between"
              align="center"
              gap="sm"
              className="rounded-lg bg-chatbox-background-secondary px-2 py-1.5"
            >
              <Stack gap={0} className="min-w-0">
                <Text size="xs" fw={500} c="chatbox-primary">
                  {t('Smart Switching')}
                </Text>
                <Text size="xs" c="chatbox-secondary" className="leading-snug max-w-[196px]">
                  {smartSwitchingDescription}
                </Text>
              </Stack>
              <Switch
                size="xs"
                checked={smartSwitchingEnabled}
                disabled={isSmartSwitchingDisabled}
                onChange={(e) => handleSmartSwitchingChange(e.currentTarget.checked)}
              />
            </Flex>
          )}
        </Stack>

        {/* Independent capabilities stay available in Chat Mode; agent capabilities require Work Mode. */}
        <div>
          {/* Built-in capabilities */}
          <Divider my={4} mx="sm" label={t('Built-in')} labelPosition="left" />

          <ExtensionRow
            icon={<IconWorldWww size={16} className="text-[var(--chatbox-tint-secondary)]" />}
            label={t('Web Search')}
            subtitle={webBrowsingMode ? webSearchProviderLabel : undefined}
            active={page === 'web-search'}
            page="web-search"
            subPanelAlign="top"
            rightContent={
              <Flex gap="xs" align="center" className="shrink-0">
                <Switch
                  checked={webBrowsingMode}
                  size="xs"
                  onChange={(e) => {
                    e.stopPropagation()
                    const enabled = e.currentTarget.checked
                    trackWebSearchClick(
                      {
                        sessionId,
                        mode: agentModeUIState.isActive ? 'work_mode' : 'chat_mode',
                        provider: providerId,
                        model: modelId,
                      },
                      enabled,
                      webSearchProvider
                    )
                    onWebBrowsingChange(enabled)
                  }}
                />
                <IconChevronRight size={14} className="text-[var(--chatbox-tint-tertiary)]" />
              </Flex>
            }
          />

          <ExtensionRow
            icon={<IconNotes size={16} className="text-[var(--chatbox-tint-secondary)]" />}
            label={t('Global Memory')}
            badge={memoryCount && memoryCount > 0 ? memoryCount : undefined}
            active={page === 'memory'}
            page="memory"
            subPanelAlign="top"
            rightContent={
              <Flex gap="xs" align="center" className="shrink-0">
                <Switch
                  checked={memoryEnabled}
                  size="xs"
                  onChange={(e) => {
                    e.stopPropagation()
                    handleMemoryEnabledChange(e.currentTarget.checked)
                  }}
                />
                <IconChevronRight size={14} className="text-[var(--chatbox-tint-tertiary)]" />
              </Flex>
            }
          />

          <ExtensionRow
            icon={<IconCode size={16} className="text-[var(--chatbox-tint-secondary)]" />}
            label={t('Code Execution')}
            active={page === 'code-execution'}
            page="code-execution"
            disabled={workModeCapabilitiesDisabled}
            subPanelAlign="top"
            rightContent={
              <Flex gap="xs" align="center" className="shrink-0">
                {commandApprovalMode === 'full_access' ? (
                  <Badge size="xs" variant="light" color="red">
                    {t('Full Access')}
                  </Badge>
                ) : (
                  <Badge size="xs" variant="light">
                    {commandApprovalMode === 'always_ask' ? t('Always Ask') : t('Smart Approval')}
                  </Badge>
                )}
                <IconChevronRight size={14} className="text-[var(--chatbox-tint-tertiary)]" />
              </Flex>
            }
          />

          {/* Extensions */}
          <Divider my={4} mx="sm" label={t('Extensions')} labelPosition="left" />

          <ExtensionRow
            icon={<IconWand size={16} className="text-[var(--chatbox-tint-secondary)]" />}
            label="Skills"
            badge={enabledSkillNames.length > 0 ? enabledSkillNames.length : undefined}
            active={page === 'skills'}
            page="skills"
            disabled={workModeCapabilitiesDisabled}
          />

          <ExtensionRow
            icon={<IconHammer size={16} className="text-[var(--chatbox-tint-secondary)]" />}
            label="MCP"
            badge={enabledMCPCount > 0 ? enabledMCPCount : undefined}
            active={page === 'mcp'}
            page="mcp"
            disabled={workModeCapabilitiesDisabled}
          />

          <ExtensionRow
            icon={<IconVocabulary size={16} className="text-[var(--chatbox-tint-secondary)]" />}
            label={t('Knowledge Base')}
            subtitle={selectedKB?.name}
            active={page === 'knowledge-base'}
            page="knowledge-base"
          />

          {supportsWorkingDirectories && (
            <ExtensionRow
              icon={<IconFolderCog size={16} className="text-[var(--chatbox-tint-secondary)]" />}
              label={t('Working Directory')}
              badge={workingDirectories.length > 0 ? workingDirectories.length : undefined}
              active={page === 'working-directory'}
              page="working-directory"
              disabled={workModeCapabilitiesDisabled}
            />
          )}
        </div>
      </Stack>

      {/* Sub panel - absolutely positioned to the right */}
      {page !== 'main' && (
        <Stack
          key={page}
          ref={subPanelRef}
          gap={0}
          py="xs"
          className="absolute left-full w-[240px] max-h-[360px] overflow-y-auto bg-[var(--mantine-color-body)] rounded-r-lg shadow-lg border-l border-[var(--mantine-color-default-border)]"
          style={subPanelAlign === 'top' ? { top: subPanelTop } : { bottom: 0 }}
          onMouseEnter={handleSubPanelEnter}
        >
          {renderSubPanel()}
        </Stack>
      )}
    </div>
  )
}

export default AgentModePanel
