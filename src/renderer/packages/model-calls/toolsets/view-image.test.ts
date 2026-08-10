import type { SandboxProvider } from '@shared/sandbox-provider'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const fsReadImage = vi.fn(
  async (..._args: unknown[]): Promise<{ success: boolean; base64?: string; error?: string }> => ({
    success: true,
    base64: '',
  })
)
const sandboxReadFileBase64 = vi.fn(
  async (..._args: unknown[]): Promise<{ success: boolean; base64?: string; error?: string }> => ({
    success: true,
    base64: '',
  })
)
const getStoreBlob = vi.fn(async (..._args: unknown[]): Promise<string | null> => null)

vi.mock('@/platform', () => ({
  default: {
    fsReadImage: (...args: unknown[]) => fsReadImage(...args),
    sandboxReadFileBase64: (...args: unknown[]) => sandboxReadFileBase64(...args),
    getStoreBlob: (...args: unknown[]) => getStoreBlob(...args),
  },
}))

const getImageBase64AndResize = vi.fn(async (_file: File) => 'data:image/png;base64,UkVTSVpFRA==')
const svgToPngBase64 = vi.fn(
  async (_dataUrl: string, _options?: { maxOutputDimension?: number; strictResourceIsolation?: boolean }) =>
    'data:image/png;base64,U1ZHUE5H'
)
vi.mock('@/packages/pic_utils', () => ({
  MODEL_IMAGE_MAX_DIMENSION: 1568,
  getImageBase64AndResize: (file: File) => getImageBase64AndResize(file),
  svgToPngBase64: (dataUrl: string, options?: { maxOutputDimension?: number; strictResourceIsolation?: boolean }) =>
    svgToPngBase64(dataUrl, options),
}))

const saveImage = vi.fn(async (_category: string, _dataUrl: string) => 'picture:view-image:session-id:uuid')
vi.mock('@/utils/image', () => ({
  saveImage: (category: string, dataUrl: string) => saveImage(category, dataUrl),
}))

import { buildViewImageToolSet } from './view-image'

// Minimal PNG header with a readable IHDR size.
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x02, 0x80, 0, 0, 0x01,
  0xe0,
])
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString('base64')

const provider = {
  type: 'local',
  init: async () => ({ success: true }),
  getStatus: async () => ({ initialized: true, workingDirectory: '/sandbox/root' }),
} as unknown as SandboxProvider

function buildToolSet(context: Partial<Parameters<typeof buildViewImageToolSet>[0]> = {}) {
  return buildViewImageToolSet({ sessionId: 'session-id', provider, toolResultImages: true, ...context })
}

function getViewImageTool(context: Partial<Parameters<typeof buildViewImageToolSet>[0]> = {}) {
  return buildToolSet(context).tools.view_image
}

async function execute(tool: unknown, input: unknown) {
  const executable = tool as {
    execute: (input: unknown, options: { toolCallId: string; messages: [] }) => Promise<unknown>
  }
  return await executable.execute(input, { toolCallId: 'tool-call-id', messages: [] })
}

async function toModelOutput(tool: unknown, output: unknown) {
  const mapper = tool as {
    toModelOutput: (options: { toolCallId: string; input: unknown; output: unknown }) => Promise<unknown>
  }
  return await mapper.toModelOutput({ toolCallId: 'tool-call-id', input: {}, output })
}

beforeEach(() => {
  fsReadImage.mockClear()
  sandboxReadFileBase64.mockClear()
  getStoreBlob.mockReset()
  getImageBase64AndResize.mockClear()
  svgToPngBase64.mockClear()
  saveImage.mockClear()
  fsReadImage.mockResolvedValue({ success: true, base64: PNG_BASE64 })
  sandboxReadFileBase64.mockResolvedValue({ success: true, base64: PNG_BASE64 })
  getStoreBlob.mockResolvedValue(null)
  svgToPngBase64.mockResolvedValue('data:image/png;base64,U1ZHUE5H')
})

describe('view_image execute — path routing', () => {
  test('relative path resolves inside the sandbox working directory', async () => {
    const result = (await execute(getViewImageTool(), { file_path: 'charts/output.png' })) as Record<string, unknown>
    expect(sandboxReadFileBase64).toHaveBeenCalledWith({
      filePath: '/sandbox/root/charts/output.png',
      maxBytes: 50 * 1024 * 1024,
    })
    expect(fsReadImage).not.toHaveBeenCalled()
    expect(result).toEqual({
      file_path: 'charts/output.png',
      image_storage_key: 'picture:view-image:session-id:uuid',
      media_type: 'image/png',
    })
    expect(saveImage).toHaveBeenCalledWith('view-image:session-id', 'data:image/png;base64,UkVTSVpFRA==')
  })

  test('absolute path reads the host filesystem', async () => {
    await execute(getViewImageTool(), { file_path: '/Users/alice/Desktop/screenshot.png' })
    expect(fsReadImage).toHaveBeenCalledWith({ filePath: '/Users/alice/Desktop/screenshot.png' })
    expect(sandboxReadFileBase64).not.toHaveBeenCalled()
  })

  test('relative path without a sandbox provider returns an error', async () => {
    const tool = buildViewImageToolSet({ toolResultImages: true }).tools.view_image
    const result = (await execute(tool, { file_path: 'out.png' })) as Record<string, unknown>
    expect(typeof result.error).toBe('string')
  })

  test('read failure is surfaced as an error result', async () => {
    fsReadImage.mockResolvedValue({ success: false, error: 'ENOENT: no such file' })
    const result = (await execute(getViewImageTool(), { file_path: '/missing.png' })) as Record<string, unknown>
    expect(result.error).toBe('ENOENT: no such file')
  })
})

describe('view_image execute — format handling', () => {
  test('sniffs png from magic bytes even with a wrong extension', async () => {
    const result = (await execute(getViewImageTool(), { file_path: '/tmp/actually-a-png.dat' })) as Record<
      string,
      unknown
    >
    expect(result.image_storage_key).toBe('picture:view-image:session-id:uuid')
  })

  test('rejects files that are neither known-extension nor known-magic images', async () => {
    const atobSpy = vi.spyOn(globalThis, 'atob')
    try {
      fsReadImage.mockResolvedValue({ success: true, base64: Buffer.alloc(1024, 0x20).toString('base64') })
      const result = (await execute(getViewImageTool(), { file_path: '/tmp/notes.txt' })) as Record<string, unknown>
      expect(String(result.error)).toContain('Unsupported')
      expect(getImageBase64AndResize).not.toHaveBeenCalled()
      expect(atobSpy).toHaveBeenCalledOnce()
      expect(atobSpy.mock.calls[0]?.[0]).toHaveLength(24)
    } finally {
      atobSpy.mockRestore()
    }
  })

  test('rejects excessive raster dimensions before browser decoding', async () => {
    const oversizedPng = PNG_BYTES.slice()
    const dimensions = new DataView(oversizedPng.buffer)
    dimensions.setUint32(16, 20_000)
    dimensions.setUint32(20, 20_000)
    fsReadImage.mockResolvedValue({ success: true, base64: Buffer.from(oversizedPng).toString('base64') })

    const result = (await execute(getViewImageTool(), { file_path: '/tmp/oversized.png' })) as Record<string, unknown>

    expect(String(result.error)).toContain('dimensions are too large')
    expect(getImageBase64AndResize).not.toHaveBeenCalled()
  })

  test('rejects an oversized later GIF frame before browser decoding', async () => {
    const gif = Uint8Array.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 10, 0, 10, 0, 0, 0, 0,
      // First frame: 10x10.
      0x2c, 0, 0, 0, 0, 10, 0, 10, 0, 0, 2, 0,
      // Second frame: 20,000x2.
      0x2c, 0, 0, 0, 0, 0x20, 0x4e, 2, 0, 0, 2, 0, 0x3b,
    ])
    fsReadImage.mockResolvedValue({ success: true, base64: Buffer.from(gif).toString('base64') })

    const result = (await execute(getViewImageTool(), { file_path: '/tmp/oversized-frame.gif' })) as Record<
      string,
      unknown
    >

    expect(String(result.error)).toContain('dimensions are too large')
    expect(getImageBase64AndResize).not.toHaveBeenCalled()
  })

  test('svg is accepted by extension (no magic bytes)', async () => {
    const svgBase64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480"></svg>').toString(
      'base64'
    )
    fsReadImage.mockResolvedValue({
      success: true,
      base64: svgBase64,
    })
    const result = (await execute(getViewImageTool(), { file_path: '/tmp/icon.svg' })) as Record<string, unknown>
    expect(result.image_storage_key).toBe('picture:view-image:session-id:uuid')
    expect(svgToPngBase64).toHaveBeenCalledWith(`data:image/svg+xml;base64,${svgBase64}`, {
      maxOutputDimension: 1568,
      strictResourceIsolation: true,
    })
    expect(getImageBase64AndResize).toHaveBeenCalledOnce()
  })

  test('rejects an SVG conversion that produces an empty canvas data URL', async () => {
    fsReadImage.mockResolvedValue({
      success: true,
      base64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64'),
    })
    svgToPngBase64.mockResolvedValueOnce('data:,')

    const result = (await execute(getViewImageTool(), { file_path: '/tmp/empty.svg' })) as Record<string, unknown>

    expect(String(result.error)).toContain('Failed to decode')
    expect(getImageBase64AndResize).not.toHaveBeenCalled()
    expect(saveImage).not.toHaveBeenCalled()
  })

  test('decode failure returns an error instead of storing junk', async () => {
    getImageBase64AndResize.mockRejectedValueOnce(new Error('cannot decode'))
    const result = (await execute(getViewImageTool(), { file_path: '/tmp/broken.png' })) as Record<string, unknown>
    expect(String(result.error)).toContain('Failed to decode')
  })
})

describe('view_image toModelOutput', () => {
  test('reuses the image cached by execute without reading blob storage', async () => {
    const toolSet = buildToolSet()
    const result = await execute(toolSet.tools.view_image, { file_path: 'chart.png' })

    const output = await toModelOutput(toolSet.tools.view_image, result)

    expect(output).toEqual({
      type: 'content',
      value: [
        { type: 'text', text: 'Viewed image: chart.png' },
        { type: 'image-data', data: 'UkVTSVpFRA==', mediaType: 'image/png' },
      ],
    })
    expect(getStoreBlob).not.toHaveBeenCalled()
  })

  test('emits image content resolved from blob storage', async () => {
    getStoreBlob.mockResolvedValue('data:image/png;base64,UkVTSVpFRA==')
    const tool = getViewImageTool()
    const result = {
      file_path: 'chart.png',
      image_storage_key: 'picture:view-image:session-id:uuid',
      media_type: 'image/png',
    }
    const output = await toModelOutput(tool, result)
    expect(output).toEqual({
      type: 'content',
      value: [
        { type: 'text', text: 'Viewed image: chart.png' },
        { type: 'image-data', data: 'UkVTSVpFRA==', mediaType: 'image/png' },
      ],
    })
    await toModelOutput(tool, result)
    expect(getStoreBlob).toHaveBeenCalledOnce()
  })

  test('falls back to text when the blob is gone', async () => {
    getStoreBlob.mockResolvedValue(null)
    const output = (await toModelOutput(getViewImageTool(), {
      file_path: 'chart.png',
      image_storage_key: 'picture:view-image:session-id:uuid',
      media_type: 'image/png',
    })) as { type: string; value: string }
    expect(output.type).toBe('text')
    expect(output.value).toContain('no longer available')
  })

  test('renders execute errors as error text', async () => {
    const output = await toModelOutput(getViewImageTool(), { error: 'ENOENT: no such file' })
    expect(output).toEqual({ type: 'text', value: 'Error: ENOENT: no such file' })
  })
})

describe('view_image without tool-result image support (user-message injection)', () => {
  test('toModelOutput returns a text notice instead of image content', async () => {
    const toolSet = buildToolSet({ toolResultImages: false })
    const result = await execute(toolSet.tools.view_image, { file_path: 'chart.png' })
    const output = (await toModelOutput(toolSet.tools.view_image, result)) as { type: string; value: string }
    expect(output.type).toBe('text')
    expect(output.value).toContain('attached in the user message')
    expect(output.value).not.toContain('picture:view-image')
  })

  test('does not claim an attachment when image data cannot be resolved', async () => {
    const output = (await toModelOutput(getViewImageTool({ toolResultImages: false }), {
      file_path: 'chart.png',
      image_storage_key: 'picture:missing',
      media_type: 'image/png',
    })) as { type: string; value: string }

    expect(output.type).toBe('text')
    expect(output.value).toContain('no longer available')
    expect(output.value).not.toContain('attached in the user message')
    expect(getStoreBlob).toHaveBeenCalledOnce()
  })

  test('injectImagesIntoStepMessages inserts a user image message after the tool message', async () => {
    const toolSet = buildToolSet({ toolResultImages: false })
    expect(toolSet.injectImagesIntoStepMessages).toBeDefined()

    // Execute registers the result under its toolCallId.
    await execute(toolSet.tools.view_image, { file_path: 'charts/output.png' })

    const messages = [
      {
        role: 'assistant' as const,
        content: [{ type: 'tool-call' as const, toolCallId: 'tool-call-id', toolName: 'view_image', input: {} }],
      },
      {
        role: 'tool' as const,
        content: [
          {
            type: 'tool-result' as const,
            toolCallId: 'tool-call-id',
            toolName: 'view_image',
            output: { type: 'text' as const, value: 'notice' },
          },
        ],
      },
    ]
    const injected = await toolSet.injectImagesIntoStepMessages?.(messages as never)
    expect(injected).toHaveLength(3)
    expect(injected?.[2]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '[Image from view_image tool: charts/output.png]' },
        { type: 'image', image: 'UkVTSVpFRA==', mediaType: 'image/png' },
      ],
    })
    expect(getStoreBlob).not.toHaveBeenCalled()

    // prepareStep runs again for every agent step; the per-generation image remains
    // memory-backed instead of re-reading IndexedDB on each rewrite.
    await toolSet.injectImagesIntoStepMessages?.(messages as never)
    expect(getStoreBlob).not.toHaveBeenCalled()
    // Pure: input array untouched, and unrelated tool results are ignored.
    expect(messages).toHaveLength(2)
  })

  test('injectImagesIntoStepMessages leaves messages untouched for unknown tool calls', async () => {
    const toolSet = buildToolSet({ toolResultImages: false })
    const messages = [
      {
        role: 'tool' as const,
        content: [
          {
            type: 'tool-result' as const,
            toolCallId: 'from-history',
            toolName: 'view_image',
            output: { type: 'text' as const, value: 'notice' },
          },
        ],
      },
    ]
    const injected = await toolSet.injectImagesIntoStepMessages?.(messages as never)
    expect(injected).toEqual(messages)
  })

  test('toolResultImages=true does not expose the injection transform', () => {
    expect(buildToolSet({ toolResultImages: true }).injectImagesIntoStepMessages).toBeUndefined()
  })
})
