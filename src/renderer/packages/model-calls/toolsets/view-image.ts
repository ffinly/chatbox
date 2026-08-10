import { readRasterImageBounds } from '@shared/image-dimensions'
import type { SandboxProvider } from '@shared/sandbox-provider'
import {
  buildViewImageToolResultContent,
  buildViewImageUserMessage,
  parseViewImageToolResult,
  VIEW_IMAGE_MAX_READ_BYTES,
  VIEW_IMAGE_MAX_SOURCE_DIMENSION,
  VIEW_IMAGE_MAX_SOURCE_PIXELS,
  VIEW_IMAGE_TOOL_NAME,
  type ViewImageInjection,
  type ViewImageToolResult,
  viewImageAttachmentNotice,
} from '@shared/tools/view-image'
import { jsonSchema, type ModelMessage, type ToolSet } from 'ai'
import { getImageBase64AndResize, MODEL_IMAGE_MAX_DIMENSION, svgToPngBase64 } from '@/packages/pic_utils'
import platform from '@/platform'
import { saveImage } from '@/utils/image'
import { isAbsolutePath, normalizeToolPathForPlatform } from './filesystem'
import { asRecord, stringField } from './model-output'
import { remapPhantomHomePathForProvider } from './sandbox-paths'

export interface ViewImageContext {
  sessionId?: string
  provider?: SandboxProvider
  /**
   * The model's wire protocol can embed images inside tool results
   * (see supportsToolResultImages). When false, the tool result is a text notice and the
   * image is injected as a follow-up user message via injectImagesIntoStepMessages —
   * the same shape as a user-uploaded image, so it works for every vision model.
   */
  toolResultImages: boolean
}

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
}

function mediaTypeFromExtension(filePath: string): string | null {
  const dotIndex = filePath.lastIndexOf('.')
  if (dotIndex < 0) return null
  return IMAGE_MEDIA_TYPES[filePath.slice(dotIndex).toLowerCase()] ?? null
}

/** Sniff common raster formats from the first bytes for files with missing/wrong extensions. */
function mediaTypeFromMagicBytes(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'
  return null
}

const MAGIC_BYTES_BASE64_PREFIX_LENGTH = 24

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function fileNameOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || 'image'
}

function parseDataUrl(dataUrl: string): { base64Data: string; mediaType: string } | null {
  const prefix = 'data:'
  const separator = ';base64,'
  if (!dataUrl.startsWith(prefix)) return null
  const separatorIndex = dataUrl.indexOf(separator, prefix.length)
  if (separatorIndex <= prefix.length) return null
  return {
    mediaType: dataUrl.slice(prefix.length, separatorIndex),
    base64Data: dataUrl.slice(separatorIndex + separator.length),
  }
}

async function readImageBase64(
  context: ViewImageContext,
  filePath: string
): Promise<{ base64: string } | { error: string }> {
  if (!isAbsolutePath(filePath)) {
    // Relative paths resolve inside the session sandbox working directory.
    if (!context.provider || !context.sessionId) {
      return { error: 'Relative paths require an active session sandbox. Use an absolute path instead.' }
    }
    if (context.provider.type !== 'local') {
      return { error: 'view_image only supports the local sandbox. Use an absolute path on the user filesystem.' }
    }
    const setup = await context.provider.init(context.sessionId)
    if (!setup.success) return { error: setup.error ?? 'Sandbox is not available' }
    const status = await context.provider.getStatus().catch(() => null)
    const workingDirectory = status?.workingDirectory
    if (!workingDirectory) return { error: 'Sandbox working directory is unavailable' }
    if (!platform.sandboxReadFileBase64) return { error: 'Image viewing is not available on this platform' }
    const joinedPath = `${workingDirectory.replace(/[\\/]+$/, '')}/${filePath}`
    return toReadOutcome(
      await platform.sandboxReadFileBase64({ filePath: joinedPath, maxBytes: VIEW_IMAGE_MAX_READ_BYTES })
    )
  }
  // Absolute paths read the host filesystem (read-only, same policy as list_files /
  // search_files). Sandbox working dirs and persisted artifacts are host paths too.
  if (platform.fsReadImage) {
    return toReadOutcome(await platform.fsReadImage({ filePath }))
  }
  if (platform.sandboxReadFileBase64) {
    return toReadOutcome(await platform.sandboxReadFileBase64({ filePath, maxBytes: VIEW_IMAGE_MAX_READ_BYTES }))
  }
  return { error: 'Image viewing is not available on this platform' }
}

function toReadOutcome(result: {
  success: boolean
  base64?: string
  error?: string
}): { base64: string } | { error: string } {
  return result.success && result.base64 ? { base64: result.base64 } : { error: result.error ?? 'Failed to read file' }
}

/** view_image is only useful when the host can read image bytes at all. */
export function isViewImageAvailable(): boolean {
  return Boolean(platform.fsReadImage || platform.sandboxReadFileBase64)
}

export interface ViewImageToolSetResult {
  tools: ToolSet
  description: string
  /**
   * Present only when the protocol cannot embed images in tool results. Rewrites the
   * step messages inside the running generation: after each tool message containing a
   * view_image result from this generation, a user message with real image parts is
   * inserted (same shape as a user-uploaded image). Wire it into prepareStep.
   */
  injectImagesIntoStepMessages?: (messages: ModelMessage[]) => Promise<ModelMessage[]>
}

async function resolveStoredImage(storageKey: string): Promise<{ base64Data: string; mediaType: string } | null> {
  const blob = await platform.getStoreBlob(storageKey).catch(() => null)
  if (!blob) return null
  return parseDataUrl(blob.startsWith('data:') ? blob : `data:image/png;base64,${blob}`)
}

export function buildViewImageToolSet(context: ViewImageContext): ViewImageToolSetResult {
  // view_image results produced by THIS generation, keyed by toolCallId. Keep the
  // downscaled data in this per-generation closure so every later step can reuse it
  // without re-reading IndexedDB and re-parsing a multi-MB data URL.
  const resultsByToolCallId = new Map<string, { result: ViewImageToolResult; image?: ViewImageInjection }>()

  const resolveToolCallImage = async (
    toolCallId: string,
    result: ViewImageToolResult
  ): Promise<ViewImageInjection | null> => {
    const cached = resultsByToolCallId.get(toolCallId)
    if (cached?.result.image_storage_key === result.image_storage_key && cached.image) {
      return cached.image
    }
    const stored = await resolveStoredImage(result.image_storage_key)
    if (!stored) return null
    const image = { filePath: result.file_path, ...stored }
    resultsByToolCallId.set(toolCallId, { result, image })
    return image
  }

  const view_image: ToolSet[string] = {
    description:
      'View an image file so you can actually see its contents (screenshots, charts, photos, generated images). ' +
      'Relative paths are resolved in the session sandbox; absolute paths read the user filesystem (read-only). ' +
      'Supported formats: png, jpg, webp, gif, bmp, svg. Large images are downscaled automatically.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path of the image file to view',
        },
      },
      required: ['file_path'],
      additionalProperties: false,
    }),
    execute: async (input, toolOptions) => {
      const viewInput = input as { file_path: string }
      let filePath = await remapPhantomHomePathForProvider(viewInput.file_path, context.provider)
      filePath = normalizeToolPathForPlatform(filePath)

      const readResult = await readImageBase64(context, filePath)
      if ('error' in readResult) return { error: readResult.error }

      let mediaType: string | null
      try {
        const magicBytes = base64ToBytes(readResult.base64.slice(0, MAGIC_BYTES_BASE64_PREFIX_LENGTH))
        mediaType = mediaTypeFromMagicBytes(magicBytes) ?? mediaTypeFromExtension(filePath)
      } catch {
        return { error: 'Failed to decode image. The file may be corrupted or not a valid image.' }
      }
      if (!mediaType) {
        return { error: 'Unsupported or unrecognized image format. Supported: png, jpg, webp, gif, bmp, svg.' }
      }
      let sourceBytes: Uint8Array | undefined
      if (mediaType !== 'image/svg+xml') {
        try {
          sourceBytes = base64ToBytes(readResult.base64)
        } catch {
          return { error: 'Failed to decode image. The file may be corrupted or not a valid image.' }
        }
        const sourceBounds = readRasterImageBounds(sourceBytes, mediaType)
        if (!sourceBounds) {
          return { error: 'Failed to inspect image dimensions safely. The file may be corrupted.' }
        }
        if (
          sourceBounds.maxWidth > VIEW_IMAGE_MAX_SOURCE_DIMENSION ||
          sourceBounds.maxHeight > VIEW_IMAGE_MAX_SOURCE_DIMENSION ||
          sourceBounds.maxPixels > VIEW_IMAGE_MAX_SOURCE_PIXELS
        ) {
          return {
            error: `Image dimensions are too large (${sourceBounds.maxWidth}x${sourceBounds.maxHeight}, up to ${sourceBounds.maxPixels} pixels)`,
          }
        }
      }

      // Downscale to mainstream vision-model limits and normalize exotic formats to
      // png/jpeg before storing — keeps blobs and request payloads bounded.
      let dataUrl: string
      try {
        let sourceBase64 = readResult.base64
        let sourceMediaType = mediaType
        if (mediaType === 'image/svg+xml') {
          const convertedSvg = await svgToPngBase64(`data:image/svg+xml;base64,${readResult.base64}`, {
            maxOutputDimension: MODEL_IMAGE_MAX_DIMENSION,
            strictResourceIsolation: true,
          })
          const convertedImage = parseDataUrl(convertedSvg)
          if (!convertedImage?.base64Data) throw new Error('SVG conversion produced an empty image')
          sourceBase64 = convertedImage.base64Data
          sourceMediaType = convertedImage.mediaType
        }
        const bytes = mediaType === 'image/svg+xml' ? base64ToBytes(sourceBase64) : sourceBytes
        if (!bytes) throw new Error('Raster image bytes are unavailable')
        const file = new File([bytes.buffer as ArrayBuffer], fileNameOf(filePath), { type: sourceMediaType })
        dataUrl = await getImageBase64AndResize(file)
      } catch {
        return { error: 'Failed to decode image. The file may be corrupted or not a valid image.' }
      }

      const parsedImage = parseDataUrl(dataUrl)
      if (!parsedImage) {
        return { error: 'Failed to process image into a model-compatible format.' }
      }
      const imageStorageKey = await saveImage(`view-image:${context.sessionId ?? 'session'}`, dataUrl)
      const result: ViewImageToolResult = {
        file_path: viewInput.file_path,
        image_storage_key: imageStorageKey,
        media_type: parsedImage.mediaType,
      }
      resultsByToolCallId.set(toolOptions.toolCallId, {
        result,
        image: { filePath: result.file_path, ...parsedImage },
      })
      return result
    },
    // Within the running generation, later steps must receive the actual image — never
    // base64-as-text. Media-capable protocols embed it in the tool result; others get a
    // text notice here and the image via injectImagesIntoStepMessages (user message).
    // History resends are handled by the shared model-message converter the same way.
    toModelOutput: async ({ toolCallId, output }: { toolCallId: string; output: unknown }) => {
      const record = asRecord(output)
      const error = stringField(record, 'error')
      if (error) return { type: 'text' as const, value: `Error: ${error}` }
      const result = parseViewImageToolResult(output)
      if (!result) return { type: 'text' as const, value: 'Error: view_image returned an unexpected result.' }
      const parsed = await resolveToolCallImage(toolCallId, result)
      if (!parsed) {
        return { type: 'text' as const, value: `Viewed image: ${result.file_path} (image data is no longer available)` }
      }
      if (!context.toolResultImages) {
        return { type: 'text' as const, value: viewImageAttachmentNotice(result.file_path) }
      }
      return buildViewImageToolResultContent(parsed)
    },
  }

  // Insert a user message with real image parts after each tool message that contains
  // view_image results from this generation. Runs per step (prepareStep), so it must be
  // pure: it never mutates the input array and re-derives all insertions each time.
  const injectImagesIntoStepMessages = async (messages: ModelMessage[]): Promise<ModelMessage[]> => {
    if (resultsByToolCallId.size === 0) return messages
    const output: ModelMessage[] = []
    for (const message of messages) {
      output.push(message)
      if (message.role !== 'tool' || !Array.isArray(message.content)) continue
      const imageInjections: ViewImageInjection[] = []
      for (const part of message.content) {
        if (part.type !== 'tool-result' || part.toolName !== VIEW_IMAGE_TOOL_NAME) continue
        const cached = resultsByToolCallId.get(part.toolCallId)
        if (!cached) continue
        const parsed = await resolveToolCallImage(part.toolCallId, cached.result)
        if (!parsed) continue
        imageInjections.push(parsed)
      }
      if (imageInjections.length > 0) {
        output.push(buildViewImageUserMessage(imageInjections))
      }
    }
    return output
  }

  return {
    tools: { [VIEW_IMAGE_TOOL_NAME]: view_image },
    description: `
## Viewing Images
Use the view_image tool to look at image files — you will see the actual image, not a text description. Use it to inspect screenshots, rendered charts, downloaded pictures, and images you generated or modified in the sandbox.
- Relative paths read from the session sandbox working directory; absolute paths read the user's filesystem (read-only).
- After generating or editing an image in the sandbox, view it to verify the result before presenting it to the user.${
      context.toolResultImages
        ? ''
        : '\n- The viewed image arrives in a user message immediately after the tool result. It is real image input, not text.'
    }
`,
    ...(context.toolResultImages ? {} : { injectImagesIntoStepMessages }),
  }
}
