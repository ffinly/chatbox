import { Button, Flex, PasswordInput, Stack, Text, Title } from '@mantine/core'
import type { DocumentParserConfig, DocumentParserType } from '@shared/types/settings'
import { useRouterState } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { AdaptiveSelect } from '@/components/AdaptiveSelect'
import i18n from '@/i18n'
import platform from '@/platform'
import { getPlatformDefaultDocumentParser, settingsStore, useSettingsStore } from '@/stores/settingsStore'

const ALL_PARSER_OPTIONS: {
  value: DocumentParserType
  label: string
  desktopOnly?: boolean
  mobileWebOnly?: boolean
}[] = [
  { value: 'none', label: 'N/A', mobileWebOnly: true }, // Basic text file support only (mobile/web only)
  { value: 'local', label: 'Local', desktopOnly: true }, // Only available on desktop
  { value: 'chatbox-ai', label: 'Chatbox AI' },
  { value: 'mineru', label: 'MinerU', desktopOnly: true }, // Only available on desktop (requires IPC)
]

interface DocumentParserSettingsProps {
  showTitle?: boolean
}

export function DocumentParserSettings({ showTitle = true }: DocumentParserSettingsProps) {
  const { t } = useTranslation()
  const routerState = useRouterState()
  const currentPath = routerState.location.pathname

  const documentParser = useSettingsStore((state) => state.extension?.documentParser)
  const setSettings = useSettingsStore((state) => state.setSettings)

  const [mineruToken, setMineruToken] = useState(documentParser?.mineru?.apiToken || '')
  const [testingConnection, setTestingConnection] = useState(false)
  const [connectionResult, setConnectionResult] = useState<boolean | undefined>()

  // Refs to track current state for validation
  const currentParserTypeRef = useRef(documentParser?.type)
  const connectionResultRef = useRef(connectionResult)
  const prevPathRef = useRef(currentPath)
  const hasValidatedRef = useRef(false)
  // Track if user has actually visited the document-parser page in this session
  const hasVisitedDocumentParserRef = useRef(false)
  // Track if user has made any changes that require validation
  const hasPendingChangesRef = useRef(false)

  // Keep refs in sync with state
  useEffect(() => {
    currentParserTypeRef.current = documentParser?.type
  }, [documentParser?.type])

  useEffect(() => {
    connectionResultRef.current = connectionResult
  }, [connectionResult])

  // Mark as visited when on document-parser page
  useEffect(() => {
    if (currentPath.includes('/document-parser')) {
      hasVisitedDocumentParserRef.current = true
    }
  }, [currentPath])

  // Helper function to validate and reset if needed
  const validateAndResetIfNeeded = useCallback(() => {
    // Only validate if:
    // 1. Haven't validated yet
    // 2. User has actually visited the document-parser page
    // 3. User has pending changes (selected mineru but didn't verify token)
    if (hasValidatedRef.current) return
    if (!hasVisitedDocumentParserRef.current) return
    if (!hasPendingChangesRef.current) return

    if (currentParserTypeRef.current === 'mineru' && connectionResultRef.current !== true) {
      hasValidatedRef.current = true
      // Reset to platform default
      const defaultConfig = getPlatformDefaultDocumentParser()
      settingsStore.getState().setSettings((draft) => {
        if (!draft.extension) {
          draft.extension = {} as any
        }
        draft.extension.documentParser = defaultConfig
      })
      // Notify user about the reset (use setTimeout to ensure toast renders after route transition)
      setTimeout(() => {
        toast.warning(i18n.t('Document parser reset to default due to unverified MinerU token'))
      }, 100)
    }
  }, [])

  // Watch for route changes - validate when navigating away from document-parser
  useEffect(() => {
    const wasOnDocumentParser = prevPathRef.current.includes('/document-parser')
    const isOnDocumentParser = currentPath.includes('/document-parser')

    if (wasOnDocumentParser && !isOnDocumentParser) {
      validateAndResetIfNeeded()
    }

    prevPathRef.current = currentPath

    // Reset validation flag when coming back to document-parser
    if (isOnDocumentParser) {
      hasValidatedRef.current = false
    }
  }, [currentPath, validateAndResetIfNeeded])

  // Also validate on component unmount (for closing settings modal)
  useEffect(() => {
    return () => {
      validateAndResetIfNeeded()
    }
  }, [validateAndResetIfNeeded])

  // Filter options based on platform
  const parserOptions = useMemo(() => {
    const isDesktop = platform.type === 'desktop'
    return ALL_PARSER_OPTIONS.filter((opt) => {
      if (opt.desktopOnly && !isDesktop) return false
      if (opt.mobileWebOnly && isDesktop) return false
      return true
    })
  }, [])

  // Use platform-specific default if not set
  const currentParserType = documentParser?.type || getPlatformDefaultDocumentParser().type

  const handleParserTypeChange = useCallback(
    (value: string | null) => {
      if (!value) return
      const newType = value as DocumentParserType

      const newConfig: DocumentParserConfig = { type: newType }

      if (newType === 'mineru' && mineruToken) {
        newConfig.mineru = { apiToken: mineruToken }
      }

      setSettings((draft) => {
        if (!draft.extension) {
          draft.extension = {} as any
        }
        draft.extension.documentParser = newConfig
      })

      setConnectionResult(undefined)

      // Mark as pending changes if selecting mineru
      if (newType === 'mineru') {
        hasPendingChangesRef.current = true
      } else {
        // Clear pending changes if switching away from mineru
        hasPendingChangesRef.current = false
      }
    },
    [setSettings, mineruToken]
  )

  const handleMineruTokenChange = useCallback(
    (value: string) => {
      setMineruToken(value)
      setConnectionResult(undefined)
      // Token changed, mark as pending (needs re-verification)
      hasPendingChangesRef.current = true

      setSettings((draft) => {
        if (!draft.extension) {
          draft.extension = {} as any
        }
        if (!draft.extension.documentParser) {
          draft.extension.documentParser = { type: 'mineru' }
        }
        draft.extension.documentParser.mineru = { apiToken: value }
      })
    },
    [setSettings]
  )

  const handleTestConnection = useCallback(async () => {
    if (!mineruToken.trim()) return

    setTestingConnection(true)
    setConnectionResult(undefined)

    try {
      const result = await platform.getKnowledgeBaseController().testMineruConnection(mineruToken)
      setConnectionResult(result.success)
      // Clear pending changes if verification succeeded
      if (result.success) {
        hasPendingChangesRef.current = false
      }
    } catch {
      setConnectionResult(false)
    } finally {
      setTestingConnection(false)
    }
  }, [mineruToken])

  return (
    <Stack p="md" gap="xxl">
      {showTitle && <Title order={5}>{t('Document Parser')}</Title>}

      <AdaptiveSelect
        comboboxProps={{ withinPortal: true, withArrow: true }}
        data={parserOptions.map((opt) => ({
          value: opt.value,
          label: t(opt.label),
        }))}
        value={currentParserType}
        onChange={handleParserTypeChange}
        label={t('Parser Type')}
        maw={320}
      />

      {currentParserType === 'none' && (
        <Text size="xs" c="chatbox-gray">
          {t(
            'Only supports basic text files (.txt, .md, .json, code files, etc.). For PDF and Office files, please switch to Chatbox AI.'
          )}
        </Text>
      )}

      {currentParserType === 'local' && (
        <Text size="xs" c="chatbox-gray">
          {t(
            'Uses built-in document parsing feature, supports common file types. Free usage, no compute points will be consumed.'
          )}
        </Text>
      )}

      {currentParserType === 'chatbox-ai' && (
        <Text size="xs" c="chatbox-gray">
          {t(
            'Cloud-based document parsing service, supports PDF, Office files, EPUB and many other file types. Consumes compute points.'
          )}
        </Text>
      )}

      {currentParserType === 'mineru' && (
        <Text size="xs" c="chatbox-gray">
          {t('Third-party cloud parsing service, supports PDF and most Office files. Requires API token.')}
        </Text>
      )}

      {currentParserType === 'mineru' && (
        <Stack gap="xs">
          <Text fw="600">{t('MinerU API Token')}</Text>
          <Flex align="center" gap="xs">
            <PasswordInput
              flex={1}
              maw={320}
              value={mineruToken}
              onChange={(e) => handleMineruTokenChange(e.currentTarget.value)}
              error={connectionResult === false}
            />
            <Button
              color="blue"
              variant="light"
              onClick={handleTestConnection}
              loading={testingConnection}
              disabled={!mineruToken.trim()}
            >
              {t('Check')}
            </Button>
          </Flex>

          {typeof connectionResult === 'boolean' ? (
            connectionResult ? (
              <Text size="xs" c="chatbox-success">
                {t('Connection successful!')}
              </Text>
            ) : (
              <Text size="xs" c="chatbox-error">
                {t('API key invalid!')}
              </Text>
            )
          ) : null}

          <Button
            variant="transparent"
            size="compact-xs"
            px={0}
            className="self-start"
            onClick={() => platform.openLink('https://mineru.net/apiManage')}
          >
            {t('Get API Token')}
          </Button>
        </Stack>
      )}
    </Stack>
  )
}

export default DocumentParserSettings
