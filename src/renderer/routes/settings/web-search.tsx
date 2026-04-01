import { Button, Flex, PasswordInput, Stack, Text, Title, Tooltip } from '@mantine/core'
import { createFileRoute } from '@tanstack/react-router'
import { ofetch } from 'ofetch'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AdaptiveSelect } from '@/components/AdaptiveSelect'
import platform from '@/platform'
import { trackJkClickEvent } from '@/analytics/jk'
import { JK_EVENTS, JK_PAGE_NAMES } from '@/analytics/jk-events'
import { useSettingsStore } from '@/stores/settingsStore'

export const Route = createFileRoute('/settings/web-search')({
  component: RouteComponent,
})

export function RouteComponent() {
  const { t } = useTranslation()
  const setSettings = useSettingsStore((state) => state.setSettings)
  const extension = useSettingsStore((state) => state.extension)
  const licenseKey = useSettingsStore((state) => state.licenseKey)

  const [checkingBocha, setCheckingBocha] = useState(false)
  const [bochaAvailable, setBochaAvailable] = useState<boolean>()
  const checkBocha = async () => {
    if (extension.webSearch.bochaApiKey) {
      setCheckingBocha(true)
      setBochaAvailable(undefined)
      try {
        await ofetch('https://api.bochaai.com/v1/web-search', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${extension.webSearch.bochaApiKey}`,
          },
          body: { query: 'Chatbox' },
        })
        setBochaAvailable(true)
      } catch (e) {
        setBochaAvailable(false)
      } finally {
        setCheckingBocha(false)
      }
    }
  }

  const [checkingTavily, setCheckingTavily] = useState(false)
  const [tavilyAvaliable, setTavilyAvaliable] = useState<boolean>()
  const checkTavily = async () => {
    if (extension.webSearch.tavilyApiKey) {
      setCheckingTavily(true)
      setTavilyAvaliable(undefined)
      try {
        await ofetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${extension.webSearch.tavilyApiKey}`,
          },
          body: {
            query: 'Chatbox',
            search_depth: 'basic',
            include_domains: [],
            exclude_domains: [],
          },
        })
        setTavilyAvaliable(true)
      } catch (e) {
        setTavilyAvaliable(false)
      } finally {
        setCheckingTavily(false)
      }
    }
  }

  return (
    <Stack p="md" gap="xxl">
      <Title order={5}>{t('Web Search')}</Title>

      <AdaptiveSelect
        comboboxProps={{ withinPortal: true, withArrow: true }}
        data={[
          { value: 'build-in', label: 'Chatbox AI' },
          { value: 'bing', label: 'Bing Search (Free)' },
          { value: 'tavily', label: 'Tavily' },
          { value: 'bocha', label: 'BoCha' },
        ]}
        value={extension.webSearch.provider}
        onChange={(e) =>
          e &&
          setSettings({
            extension: {
              ...extension,
              webSearch: {
                ...extension.webSearch,
                provider: e as 'build-in' | 'bing' | 'tavily' | 'bocha',
              },
            },
          })
        }
        label={t('Search Provider')}
        maw={320}
      />
      {extension.webSearch.provider === 'build-in' && (
        <Text size="xs" c="chatbox-gray">
          {t('Chatbox Search is a paid feature with advanced capabilities and better performance.')}
        </Text>
      )}
      {extension.webSearch.provider === 'bing' && (
        <Text size="xs" c="chatbox-gray">
          {t(
            'Bing Search is provided for free use, but it may have limitations and is subject to change by Microsoft.'
          )}
        </Text>
      )}
      {/* Tavily API Key */}
      {extension.webSearch.provider === 'tavily' && (
        <Stack gap="xs">
          <Text fw="600">{t('Tavily API Key')}</Text>
          <Flex align="center" gap="xs">
            <PasswordInput
              flex={1}
              maw={320}
              value={extension.webSearch.tavilyApiKey}
              onChange={(e) => {
                setTavilyAvaliable(undefined)
                setSettings({
                  extension: {
                    ...extension,
                    webSearch: {
                      ...extension.webSearch,
                      tavilyApiKey: e.currentTarget.value,
                    },
                  },
                })
              }}
              error={tavilyAvaliable === false}
            />
            <Button
              color="blue"
              variant="light"
              onClick={checkTavily}
              loading={checkingTavily}
              disabled={!extension.webSearch.tavilyApiKey?.trim()}
            >
              {t('Check')}
            </Button>
          </Flex>

          {typeof tavilyAvaliable === 'boolean' ? (
            tavilyAvaliable ? (
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
            onClick={() => platform.openLink('https://app.tavily.com?utm_source=chatbox')}
          >
            {t('Get API Key')}
          </Button>
        </Stack>
      )}
      {/* BoCha API Key */}
      {extension.webSearch.provider === 'bocha' && (
        <Stack gap="xs">
          <Text fw="600">{t('BoCha API Key')}</Text>
          <Flex align="center" gap="xs">
            <PasswordInput
              flex={1}
              maw={320}
              value={extension.webSearch.bochaApiKey}
              onChange={(e) => {
                setBochaAvailable(undefined)
                setSettings({
                  extension: {
                    ...extension,
                    webSearch: {
                      ...extension.webSearch,
                      bochaApiKey: e.currentTarget.value,
                    },
                  },
                })
              }}
              error={bochaAvailable === false}
            />
            <Button
              color="blue"
              variant="light"
              onClick={checkBocha}
              loading={checkingBocha}
              disabled={!extension.webSearch.bochaApiKey?.trim()}
            >
              {t('Check')}
            </Button>
          </Flex>

          {typeof bochaAvailable === 'boolean' ? (
            bochaAvailable ? (
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
            onClick={() => platform.openLink('https://open.bochaai.com')}
          >
            {t('Get API Key')}
          </Button>
        </Stack>
      )}
      {extension.webSearch.provider !== 'build-in' && !licenseKey && (
        <Tooltip
          label={t(
            'Note: If you have never had a license before, you can claim it after logging in on the official website. Quota refreshed daily.'
          )}
          withArrow
          multiline
          maw={280}
          position="bottom-start"
          styles={{
            tooltip: {
              backgroundColor: 'rgba(0, 0, 0, 0.75)',
              backdropFilter: 'blur(4px)',
            },
          }}
        >
          <Text
            size="xs"
            className="cursor-pointer"
            onClick={() => {
              trackJkClickEvent(JK_EVENTS.FREE_LICENSE_CLAIM_CLICK, {
                pageName: JK_PAGE_NAMES.SETTING_PAGE,
                content: 'settings_websearch',
              })
              platform.openLink('https://chatboxai.app/login')
            }}
          >
            {t('You can ')}
            <span className="text-blue-500 underline decoration-dotted">{t('try Chatbox AI')}</span>
            {t(' for free now!')}
          </Text>
        </Tooltip>
      )}
    </Stack>
  )
}
