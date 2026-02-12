import NiceModal from '@ebay/nice-modal-react'
import { Tooltip, Typography } from '@mui/material'
import { AlertCircle, CheckCircle, Eye, Link, Link2, Loader2, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ChatboxAIAPIError } from '@shared/models/errors'
import FileIcon from './FileIcon'
import { ImageInStorage } from './Image'
import MiniButton from './MiniButton'

// 根据错误码获取翻译后的错误消息
function getTranslatedErrorMessage(errorCode: string | undefined, t: (key: string) => string): string | undefined {
  if (!errorCode) return undefined
  const errorDetail = ChatboxAIAPIError.codeNameMap[errorCode]
  if (errorDetail) {
    // 使用 i18nKey 进行翻译，去掉其中的 HTML 标签以便在 Tooltip 中显示纯文本
    const translated = t(errorDetail.i18nKey)
    // 移除 HTML/JSX 标签，只保留纯文本
    return translated.replace(/<[^>]*>/g, '')
  }
  return t('Processing failed')
}

export function ImageMiniCard(props: { storageKey: string; onDelete: () => void }) {
  const { storageKey, onDelete } = props
  return (
    <div
      key={storageKey}
      className="w-[100px] h-[100px] p-1 m-1 inline-flex items-center justify-center
                                bg-white shadow-sm rounded-md border-solid border-gray-400/20
                                hover:shadow-lg hover:cursor-pointer hover:scale-105 transition-all duration-200
                                group/image-mini-card"
    >
      <ImageInStorage storageKey={storageKey} />
      {onDelete && (
        <MiniButton
          className="hidden group-hover/image-mini-card:inline-block 
                    absolute top-0 right-0 m-1 p-1 rounded-full shadow-lg text-red-500"
          onClick={onDelete}
        >
          <Trash2 size="22" strokeWidth={2} />
        </MiniButton>
      )}
    </div>
  )
}

export function FileMiniCard(props: {
  name: string
  fileType: string
  onDelete: () => void
  status?: 'processing' | 'completed' | 'error'
  errorMessage?: string
  onErrorClick?: () => void
}) {
  const { name, onDelete, status, errorMessage, onErrorClick } = props
  const { t } = useTranslation()

  const handleClick = () => {
    if (status === 'error' && onErrorClick) {
      onErrorClick()
    }
  }

  // 获取翻译后的错误消息
  const translatedError = getTranslatedErrorMessage(errorMessage, t)

  return (
    <div
      className="w-[100px] h-[100px] p-1 m-1 inline-flex items-center justify-center
                                bg-white shadow-sm rounded-md border-solid border-gray-400/20
                                hover:shadow-lg hover:cursor-pointer hover:scale-105 transition-all duration-200
                                group/file-mini-card relative"
      onClick={handleClick}
    >
      <Tooltip title={status === 'error' && translatedError ? translatedError : name}>
        <div className="flex flex-col justify-center items-center">
          <FileIcon filename={name} className="w-8 h-8 text-black" />
          <Typography className="w-20 pt-1 text-black text-center" noWrap sx={{ fontSize: '12px' }}>
            {name}
          </Typography>
        </div>
      </Tooltip>

      {/* Status indicator */}
      {status && (
        <div className="absolute bottom-1 left-1">
          {status === 'processing' && <Loader2 size="16" className="animate-spin text-blue-500" />}
          {status === 'completed' && <CheckCircle size="16" className="text-green-500" />}
          {status === 'error' && <AlertCircle size="16" className="text-red-500" />}
        </div>
      )}

      {onDelete && (
        <MiniButton
          className="hidden group-hover/file-mini-card:inline-block 
                    absolute top-0 right-0 m-1 p-1 rounded-full shadow-lg text-red-500"
          onClick={onDelete}
        >
          <Trash2 size="18" strokeWidth={2} />
        </MiniButton>
      )}
    </div>
  )
}

export function MessageAttachment(props: { label: string; filename?: string; url?: string; storageKey?: string }) {
  const { label, filename, url, storageKey } = props
  const { t } = useTranslation()

  const handleClick = async () => {
    if (storageKey) {
      let title: string
      if (filename) {
        title = `${t('File Content')}: ${filename}`
      } else if (url) {
        const truncatedUrl = url.length > 50 ? `${url.slice(0, 50)}...` : url
        title = `${t('Link Content')}: ${truncatedUrl}`
      } else {
        title = t('Content')
      }
      await NiceModal.show('content-viewer', { title, storageKey })
    }
  }

  const isClickable = !!storageKey

  return (
    <Tooltip title={isClickable ? t('Click to view parsed content') : ''}>
      <div
        className={`flex justify-start items-center mb-2 p-1.5
            border-solid border-slate-400/20 rounded 
            bg-white dark:bg-slate-800
            ${isClickable ? 'cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors' : ''}`}
        onClick={handleClick}
      >
        {filename && <FileIcon filename={filename} className="w-6 h-6 ml-1 mr-2 text-black dark:text-white" />}
        {url && <Link2 className="w-6 h-6 ml-1 mr-2 text-black dark:text-white" strokeWidth={1} />}
        <Typography className="w-32" noWrap>
          {label}
        </Typography>
        {isClickable && <Eye className="w-4 h-4 ml-1 text-gray-500 dark:text-gray-400" strokeWidth={1.5} />}
      </div>
    </Tooltip>
  )
}

export function LinkMiniCard(props: {
  url: string
  onDelete: () => void
  status?: 'processing' | 'completed' | 'error'
  errorMessage?: string
  onErrorClick?: () => void
}) {
  const { url, onDelete, status, errorMessage, onErrorClick } = props
  const { t } = useTranslation()
  const label = url.replace(/^https?:\/\//, '')

  const handleClick = () => {
    if (status === 'error' && onErrorClick) {
      onErrorClick()
    }
  }

  // 获取翻译后的错误消息
  const translatedError = getTranslatedErrorMessage(errorMessage, t)

  return (
    <div
      className="w-[100px] h-[100px] p-1 m-1 inline-flex items-center justify-center
                                bg-white shadow-sm rounded-md border-solid border-gray-400/20
                                hover:shadow-lg hover:cursor-pointer hover:scale-105 transition-all duration-200
                                group/file-mini-card relative"
      onClick={handleClick}
    >
      <Tooltip title={status === 'error' && translatedError ? translatedError : url}>
        <div className="flex flex-col justify-center items-center">
          <Link className="w-8 h-8 text-black" strokeWidth={1} />
          <Typography className="w-20 pt-1 text-black text-center" noWrap sx={{ fontSize: '10px' }}>
            {label}
          </Typography>
        </div>
      </Tooltip>
      {onDelete && (
        <MiniButton
          className="hidden group-hover/file-mini-card:inline-block 
                    absolute top-0 right-0 m-1 p-1 rounded-full shadow-lg text-red-500"
          onClick={onDelete}
        >
          <Trash2 size="18" strokeWidth={2} />
        </MiniButton>
      )}
    </div>
  )
}
