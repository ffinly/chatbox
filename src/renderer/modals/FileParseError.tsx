import NiceModal, { useModal } from '@ebay/nice-modal-react'
import { Alert, Button, Flex, Stack, Text } from '@mantine/core'
import { IconAlertCircle } from '@tabler/icons-react'
import { Trans, useTranslation } from 'react-i18next'
import { ChatboxAIAPIError } from '@shared/models/errors'
import LinkTargetBlank from '@/components/Link'
import { Modal } from '@/components/Overlay'
import { ScalableIcon } from '@/components/ScalableIcon'
import { trackingEvent } from '@/packages/event'
import platform from '@/platform'

interface FileParseErrorProps {
  errorCode: string
  fileName?: string
}

const FileParseError = NiceModal.create(({ errorCode, fileName }: FileParseErrorProps) => {
  const modal = useModal()
  const { t } = useTranslation()

  const onClose = () => {
    modal.resolve()
    modal.hide()
  }

  // 根据错误码获取错误详情
  const errorDetail = ChatboxAIAPIError.codeNameMap[errorCode]

  // 错误提示内容
  const renderErrorTips = () => {
    if (!errorDetail) {
      // 未知错误
      return <Text>{t('Failed to parse file. Please try again or use a different file format.')}</Text>
    }

    return (
      <Trans
        i18nKey={errorDetail.i18nKey}
        values={{
          model: t('current model'),
        }}
        components={{
          OpenSettingButton: <span />,
          OpenExtensionSettingButton: <span />,
          OpenMorePlanButton: (
            <a
              className="cursor-pointer underline font-semibold text-blue-600 hover:text-blue-700"
              onClick={() => {
                platform.openLink(
                  'https://chatboxai.app/redirect_app/view_more_plans?utm_source=app&utm_content=file_parse_error'
                )
                trackingEvent('click_view_more_plans_button_from_file_parse_error', {
                  event_category: 'user',
                })
              }}
            />
          ),
          LinkToHomePage: <LinkTargetBlank href="https://chatboxai.app" />,
          LinkToAdvancedFileProcessing: (
            <LinkTargetBlank href="https://chatboxai.app/redirect_app/advanced_file_processing?utm_source=app&utm_content=file_parse_error" />
          ),
          LinkToAdvancedUrlProcessing: (
            <LinkTargetBlank href="https://chatboxai.app/redirect_app/advanced_url_processing?utm_source=app&utm_content=file_parse_error" />
          ),
        }}
      />
    )
  }

  return (
    <Modal opened={modal.visible} onClose={onClose} size="md" centered title={t('File Processing Error')}>
      <Stack gap="md">
        {fileName && (
          <Text size="sm" c="chatbox-secondary">
            {t('File')}: {fileName}
          </Text>
        )}

        <Alert icon={<ScalableIcon size={20} icon={IconAlertCircle} />} color="orange" variant="light">
          {renderErrorTips()}
        </Alert>

        <Flex gap="md" mt="sm" justify="flex-end" align="center">
          <Button onClick={onClose} color="chatbox-gray" variant="light">
            {t('close')}
          </Button>
        </Flex>
      </Stack>
    </Modal>
  )
})

export default FileParseError
