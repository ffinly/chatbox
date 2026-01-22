import { Box, Button, Flex, Text } from '@mantine/core'
import { IconAlertCircle, IconLoader2 } from '@tabler/icons-react'
import { useAtomValue } from 'jotai'
import { memo, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { runCompactionWithUIState } from '@/packages/context-management'
import { compactionUIStateMapAtom } from '@/stores/atoms'
import { ScalableIcon } from './ScalableIcon'

interface CompactionStatusProps {
  sessionId: string
}

export const CompactionStatus = memo(function CompactionStatus({ sessionId }: CompactionStatusProps) {
  const { t } = useTranslation()
  const compactionStateMap = useAtomValue(compactionUIStateMapAtom)

  const compactionState = useMemo(() => {
    return compactionStateMap[sessionId] ?? { status: 'idle', error: null, streamingText: '' }
  }, [compactionStateMap, sessionId])

  const lastLine = useMemo(() => {
    const lines = compactionState.streamingText.split('\n').filter((line) => line.trim() !== '')
    return lines[lines.length - 1] || ''
  }, [compactionState.streamingText])

  const handleRetry = useCallback(() => {
    void runCompactionWithUIState(sessionId)
  }, [sessionId])

  if (compactionState.status === 'idle') {
    return null
  }

  if (compactionState.status === 'failed') {
    return (
      <Box className="rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 shadow-sm p-3">
        <Flex align="center" justify="center" gap="xs">
          <ScalableIcon icon={IconAlertCircle} size={16} className="text-red-500" />
          <Text size="sm" c="red">
            {compactionState.error ?? t('Compaction failed')}
          </Text>
          <Button size="xs" variant="light" color="red" onClick={handleRetry}>
            {t('Retry')}
          </Button>
        </Flex>
      </Box>
    )
  }

  return (
    <Box className="rounded-xl bg-chatbox-background-tertiary border border-chatbox-border-primary shadow-sm p-3">
      <Flex align="center" gap="xs" justify="center">
        <ScalableIcon icon={IconLoader2} size={16} className="animate-spin text-chatbox-tertiary" />
        <Text size="sm" c="chatbox-tertiary">
          {t('Compacting conversation...')}
        </Text>
      </Flex>
      {lastLine && (
        <Text size="xs" c="dimmed" className="text-center mt-1 truncate">
          {lastLine}
        </Text>
      )}
    </Box>
  )
})
