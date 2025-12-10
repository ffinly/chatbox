import { Flex, Progress, Stack, Text } from '@mantine/core'
import { IconExternalLink } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import type { ChatboxAILicenseDetail } from 'src/shared/types'
import { ScalableIcon } from '@/components/ScalableIcon'
import platform from '@/platform'
import { formatUsage } from '@/utils/format'

interface LicenseDetailCardProps {
  licenseDetail: ChatboxAILicenseDetail
  language: string
  utmContent: string
}

export function LicenseDetailCard({ licenseDetail, language, utmContent }: LicenseDetailCardProps) {
  const { t } = useTranslation()

  return (
    <Stack gap="lg">
      {/* Plan Quota */}
      <Stack gap="xxs">
        <Flex align="center" justify="space-between">
          <Text>{t('Plan Quota')}</Text>
          <Flex gap="xxs" align="center">
            <Text fw="600" size="md">
              {formatUsage(
                (licenseDetail.unified_token_limit || 0) - (licenseDetail.unified_token_usage || 0),
                licenseDetail.unified_token_usage_details.find((detail) => detail.type === 'plan')?.token_limit || 0,
                2
              )}
            </Text>
            <Text
              size="xs"
              c="chatbox-brand"
              fw="400"
              className="cursor-pointer whitespace-nowrap"
              onClick={() =>
                platform.openLink(
                  `https://chatboxai.app/redirect_app/manage_license/${language}/?utm_source=app&utm_content=${utmContent}`
                )
              }
            >
              {t('View Details')}
              <ScalableIcon icon={IconExternalLink} size={12} />
            </Text>
          </Flex>
        </Flex>
        <Progress value={licenseDetail.remaining_quota_unified * 100} />
      </Stack>

      {/* Expansion Pack Quota & Image Quota */}
      <Flex gap="lg">
        {licenseDetail.expansion_pack_limit && (
          <Stack flex={1} gap="xxs">
            <Text size="xs" c="dimmed">
              {t('Expansion Pack Quota')}
            </Text>
            <Text size="md" fw="600">
              {formatUsage(
                licenseDetail.expansion_pack_limit - (licenseDetail.expansion_pack_usage || 0),
                licenseDetail.expansion_pack_limit,
                2
              )}
            </Text>
          </Stack>
        )}
        <Stack flex={1} gap="xxs">
          <Text size="xs" c="dimmed">
            {t('Image Quota')}
          </Text>
          <Text size="md" fw="600">
            {`${licenseDetail.image_total_quota - licenseDetail.image_used_count}/${licenseDetail.plan_image_limit}`}
          </Text>
        </Stack>
      </Flex>

      {/* Quota Reset & License Expiry */}
      <Flex gap="lg">
        <Stack flex={1} gap="xxs">
          <Text size="xs" c="dimmed">
            {t('Quota Reset')}
          </Text>
          <Text size="md" fw="600">
            {new Date(licenseDetail.token_next_refresh_time!).toLocaleDateString()}
          </Text>
        </Stack>
        <Stack flex={1} gap="xxs">
          <Text size="xs" c="dimmed">
            {t('License Expiry')}
          </Text>
          <Text size="md" fw="600">
            {licenseDetail.token_expire_time ? new Date(licenseDetail.token_expire_time).toLocaleDateString() : ''}
          </Text>
        </Stack>
      </Flex>

      {/* License Plan Overview */}
      <Stack flex={1} gap="xxs">
        <Text size="xs" c="dimmed">
          {t('License Plan Overview')}
        </Text>
        <Text size="md" fw="600">
          {licenseDetail.name}
        </Text>
      </Stack>
    </Stack>
  )
}
