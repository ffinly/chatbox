import { ActionIcon, Box, Button, Flex, ScrollArea, Skeleton, Stack, Text, Tooltip } from '@mantine/core'
import type { ImageGeneration } from '@shared/types'
import { IconChevronRight, IconClock, IconPlus } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { HistoryItem } from './HistoryItem'

/* ============================================
   History List Content (shared between desktop/mobile)
   ============================================ */

export interface HistoryListContentProps {
  historyCache: ImageGeneration[]
  historyLoading: boolean
  currentRecordId: string | null
  hasNextPage: boolean
  isFetchingNextPage: boolean
  isMobile?: boolean
  onItemClick: (record: ImageGeneration) => void
  onLoadMore: () => void
  onDelete: (id: string) => void
}

export function HistoryListContent({
  historyCache,
  historyLoading,
  currentRecordId,
  hasNextPage,
  isFetchingNextPage,
  isMobile,
  onItemClick,
  onLoadMore,
  onDelete,
}: HistoryListContentProps) {
  const { t } = useTranslation()

  return (
    <Stack gap={2} p="xs">
      {historyLoading && historyCache.length === 0 && (
        <Stack gap="xs" p="xs">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} h={64} radius="md" />
          ))}
        </Stack>
      )}

      {historyCache.map((record) => (
        <HistoryItem
          key={record.id}
          record={record}
          isActive={currentRecordId === record.id}
          isMobile={isMobile}
          onClick={() => onItemClick(record)}
          onDelete={onDelete}
        />
      ))}

      {hasNextPage && (
        <Button
          variant="subtle"
          size="xs"
          color="gray"
          onClick={onLoadMore}
          loading={isFetchingNextPage}
          fullWidth
          mt="sm"
        >
          {t('Load More')}
        </Button>
      )}

      {historyCache.length === 0 && !historyLoading && (
        <Flex direction="column" align="center" py="xl" gap="sm" opacity={0.5}>
          <IconClock size={24} />
          <Text size="xs" ta="center">
            {t('No history yet')}
          </Text>
        </Flex>
      )}
    </Stack>
  )
}

/* ============================================
   Desktop History Panel
   ============================================ */

export interface HistoryPanelProps {
  show: boolean
  width: number
  historyCache: ImageGeneration[]
  historyLoading: boolean
  currentRecordId: string | null
  hasNextPage: boolean
  isFetchingNextPage: boolean
  onItemClick: (record: ImageGeneration) => void
  onLoadMore: () => void
  onNewCreation: () => void
  onClose: () => void
  onDelete: (id: string) => void
}

export function HistoryPanel({
  show,
  width,
  historyCache,
  historyLoading,
  currentRecordId,
  hasNextPage,
  isFetchingNextPage,
  onItemClick,
  onLoadMore,
  onNewCreation,
  onClose,
  onDelete,
}: HistoryPanelProps) {
  const { t } = useTranslation()

  return (
    <Box
      w={show ? width : 0}
      h="100%"
      className="border-l border-[var(--chatbox-border-primary)] bg-[var(--chatbox-background-primary)] transition-all duration-300 ease-in-out overflow-hidden shrink-0"
    >
      <Flex direction="column" h="100%" w={width}>
        <Flex
          align="center"
          justify="space-between"
          px="md"
          py="sm"
          className="border-b border-[var(--chatbox-border-primary)]"
        >
          <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: 0.5 }}>
            {t('History')}
          </Text>
          <Flex gap="xs">
            <Tooltip label={t('New Creation')}>
              <ActionIcon variant="subtle" color="gray" size="sm" onClick={onNewCreation}>
                <IconPlus size={16} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={t('Close')}>
              <ActionIcon variant="subtle" color="gray" size="sm" onClick={onClose}>
                <IconChevronRight size={16} />
              </ActionIcon>
            </Tooltip>
          </Flex>
        </Flex>

        <ScrollArea flex={1} type="auto" offsetScrollbars>
          <HistoryListContent
            historyCache={historyCache}
            historyLoading={historyLoading}
            currentRecordId={currentRecordId}
            hasNextPage={hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            onItemClick={onItemClick}
            onLoadMore={onLoadMore}
            onDelete={onDelete}
          />
        </ScrollArea>
      </Flex>
    </Box>
  )
}
