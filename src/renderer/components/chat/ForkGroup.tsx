import { ActionIcon, Box, Button, Flex, Stack, Text, Tooltip } from '@mantine/core'
import { TestId } from '@shared/automation/testids'
import { getSessionActionGate, type SessionLockState } from '@shared/session/action-gates'
import type { Session, SessionType } from '@shared/types'
import { IconAlignRight, IconChevronLeft, IconChevronRight, IconFold, IconTrash } from '@tabler/icons-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useIsSmallScreen } from '@/hooks/useScreenChange'
import { deleteFork, switchFork, switchForkTo } from '@/stores/sessionActions'
import { getSessionLockNotice, notifySessionLockBlocked } from '@/utils/session-lock-copy'
import ActionMenu from '../ActionMenu'
import Message from './Message'

type ForkGroupProps = {
  sessionId: string
  sessionType: SessionType
  msgId: string
  forks: NonNullable<Session['messageForksHash']>[string]
  sessionLocks: SessionLockState
  assistantAvatarKey?: string
  sessionPicUrl?: string
}

export default function ForkGroup(props: ForkGroupProps) {
  const { sessionId, sessionType, msgId, forks, sessionLocks, assistantAvatarKey, sessionPicUrl } = props
  const [flash, setFlash] = useState(false)
  const prevLength = useRef(forks.lists.length)
  const previousPosition = useRef(forks.position)
  const previousListIds = useRef(new Set(forks.lists.map((list) => list.id)))
  const [expanded, setExpanded] = useState(false)
  const [revealedBranchIds, setRevealedBranchIds] = useState<Set<string>>(
    () =>
      new Set(
        forks.lists
          .filter(
            (list, index) => index !== forks.position && list.messages.some((message) => message.generating === true)
          )
          .map((list) => list.id)
      )
  )
  const { t } = useTranslation()
  const isSmallScreen = useIsSmallScreen()

  // The shared gate locks fork controls while replies stream or a compaction
  // summary runs (see getSessionActionGate for the rationale).
  const forkGate = getSessionActionGate('switch-fork', sessionLocks)
  const forkControlsLocked = !forkGate.allowed
  const lockReason = forkGate.allowed ? '' : getSessionLockNotice(forkGate.reason, t)

  useEffect(() => {
    if (forks.lists.length > prevLength.current) {
      prevLength.current = forks.lists.length
      setFlash(true)
      const timer = setTimeout(() => setFlash(false), 2000)
      return () => clearTimeout(timer)
    }
    prevLength.current = forks.lists.length
  }, [forks.lists.length])

  useEffect(() => {
    if (forks.position !== previousPosition.current) {
      setExpanded(false)
      setRevealedBranchIds(new Set())
    } else {
      const addedInactiveBranchIds = forks.lists
        .filter((list, index) => index !== forks.position && !previousListIds.current.has(list.id))
        .map((list) => list.id)
      if (addedInactiveBranchIds.length > 0) {
        setRevealedBranchIds((current) => new Set([...current, ...addedInactiveBranchIds]))
      }
    }

    previousPosition.current = forks.position
    previousListIds.current = new Set(forks.lists.map((list) => list.id))
  }, [forks.lists, forks.position])

  // lists append newest branches at the end; show newest-first so a Reply Again
  // Below that is still streaming appears directly under the prompt instead of
  // below every finished alternative.
  const alternativeBranches = forks.lists.flatMap((list, index) => {
    if (index === forks.position) {
      return []
    }

    const firstReplyIndex = list.messages.findIndex(
      (message) => message.role === 'assistant' && !message.isSummary && !message.isForkMarker
    )
    const firstReply = list.messages[firstReplyIndex]
    if (!firstReply) {
      return []
    }

    return [
      {
        list,
        index,
        firstReply,
        followupCount: Math.max(0, list.messages.length - firstReplyIndex - 1),
      },
    ]
  })
  const visibleBranches = [
    ...alternativeBranches.filter(({ list }) => expanded || revealedBranchIds.has(list.id)),
  ].reverse()

  const notifyControlsLocked = useCallback(() => {
    if (!forkGate.allowed) {
      void notifySessionLockBlocked(forkGate.reason, t)
    }
  }, [forkGate, t])

  const handleSwitch = useCallback(
    (direction: 'next' | 'prev') => {
      if (forkControlsLocked) {
        notifyControlsLocked()
        return
      }
      void switchFork(sessionId, msgId, direction)
    },
    [forkControlsLocked, msgId, notifyControlsLocked, sessionId]
  )

  // delete-fork shares the switch-fork policy by design (one fallthrough case
  // in action-gates), so the menu item's disabled state and this handler stay
  // on the same component-level gate; the store-side deleteFork guard is the
  // per-action backstop.
  const handleDelete = useCallback(() => {
    if (forkControlsLocked) {
      notifyControlsLocked()
      return
    }
    void deleteFork(sessionId, msgId)
  }, [forkControlsLocked, msgId, notifyControlsLocked, sessionId])

  const handleSwitchTo = useCallback(
    (position: number) => {
      if (forkControlsLocked) {
        notifyControlsLocked()
        return
      }
      void switchForkTo(sessionId, msgId, position)
    },
    [forkControlsLocked, msgId, notifyControlsLocked, sessionId]
  )

  const navigation = (
    <Flex gap="xs" align="center">
      <ActionIcon
        data-testid={TestId.message.forkPrevious}
        variant="subtle"
        size={20}
        radius="lg"
        color={flash ? 'chatbox-secondary' : 'chatbox-tertiary'}
        aria-label={forkControlsLocked ? lockReason : t('Previous reply')}
        aria-disabled={forkControlsLocked}
        data-disabled={forkControlsLocked || undefined}
        onClick={() => handleSwitch('prev')}
      >
        <IconChevronLeft />
      </ActionIcon>
      <ActionMenu
        position="bottom"
        items={[
          ...(!expanded
            ? [
                {
                  text: t('Expand view'),
                  icon: IconAlignRight,
                  onClick: () => setExpanded(true),
                },
              ]
            : []),
          ...(expanded || revealedBranchIds.size > 0
            ? [
                {
                  text: t('Collapse other branches'),
                  icon: IconFold,
                  onClick: () => {
                    setExpanded(false)
                    setRevealedBranchIds(new Set())
                  },
                },
              ]
            : []),
          {
            divider: true,
          },
          {
            doubleCheck: !forkControlsLocked,
            text: t('delete'),
            icon: IconTrash,
            disabled: forkControlsLocked && !isSmallScreen,
            onClick: handleDelete,
          },
        ]}
      >
        <Text
          data-testid={TestId.message.forkCounter}
          c={flash ? 'chatbox-secondary' : 'chatbox-tertiary'}
          size="xs"
          className="cursor-pointer"
        >
          {forks.position + 1} / {forks.lists.length}
        </Text>
      </ActionMenu>
      <ActionIcon
        data-testid={TestId.message.forkNext}
        variant="subtle"
        size={20}
        radius="lg"
        color={flash ? 'chatbox-secondary' : 'chatbox-tertiary'}
        aria-label={forkControlsLocked ? lockReason : t('Next reply')}
        aria-disabled={forkControlsLocked}
        data-disabled={forkControlsLocked || undefined}
        onClick={() => handleSwitch('next')}
      >
        <IconChevronRight />
      </ActionIcon>
    </Flex>
  )

  return (
    <Stack data-testid={TestId.message.forkGroup} data-message-id={msgId} gap="xs">
      <Flex justify="flex-end" pr="md" mr="md" className="self-end">
        {forkControlsLocked && !isSmallScreen ? (
          <Tooltip label={lockReason} withArrow>
            <Box className="inline-flex">{navigation}</Box>
          </Tooltip>
        ) : (
          navigation
        )}
      </Flex>
      {visibleBranches.map(({ list, index, firstReply, followupCount }) => {
        const switchButton = (
          <Button
            variant="subtle"
            color="chatbox-brand"
            size="compact-xs"
            disabled={forkControlsLocked && !isSmallScreen}
            aria-disabled={forkControlsLocked}
            onClick={() => handleSwitchTo(index)}
          >
            {t('Switch to this branch')}
          </Button>
        )

        return (
          <Stack
            key={list.id}
            gap={0}
            mx="md"
            p="xs"
            className="rounded-lg border border-solid border-chatbox-border-primary bg-chatbox-background-primary shadow-sm"
          >
            <Flex justify="space-between" align="center" gap="xs" wrap="wrap" px="xs" pb="xxs">
              <Text size="xs" c="chatbox-tertiary">
                {t('Reply {{index}}', { index: index + 1 })}
              </Text>
              <Flex gap="xs" align="center" justify="flex-end" wrap="wrap">
                {followupCount > 0 && (
                  <Text size="xs" c="chatbox-tertiary">
                    {followupCount === 1
                      ? t('1 follow-up message')
                      : t('{{count}} follow-up messages', { count: followupCount })}
                  </Text>
                )}
                {forkControlsLocked && !isSmallScreen ? (
                  <Tooltip label={lockReason} withArrow>
                    <span>{switchButton}</span>
                  </Tooltip>
                ) : (
                  switchButton
                )}
              </Flex>
            </Flex>
            <Message
              id={firstReply.id}
              msg={firstReply}
              sessionId={sessionId}
              sessionType={sessionType}
              buttonGroup="none"
              readOnly
              allowGeneratingStop
              sessionLocks={sessionLocks}
              assistantAvatarKey={assistantAvatarKey}
              sessionPicUrl={sessionPicUrl}
            />
          </Stack>
        )
      })}
      {visibleBranches.length > 0 && visibleBranches.length < alternativeBranches.length && (
        <Flex justify="flex-end" pr="md" mr="md">
          <Text size="xs" c="chatbox-tertiary">
            {t('Showing {{shown}} of {{total}} other replies', {
              shown: visibleBranches.length,
              total: alternativeBranches.length,
            })}
          </Text>
        </Flex>
      )}
    </Stack>
  )
}
