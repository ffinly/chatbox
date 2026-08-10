import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { readSandboxFileBase64 } from './read-file-base64'

let testRoot: string
let sandboxRoot: string

beforeEach(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), 'chatbox-read-file-base64-'))
  const sandboxDirectory = path.join(testRoot, 'sandbox')
  await mkdir(sandboxDirectory)
  sandboxRoot = await realpath(sandboxDirectory)
})

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

describe('readSandboxFileBase64', () => {
  test('reads files inside an allowed root', async () => {
    const filePath = path.join(sandboxRoot, 'image.bin')
    await writeFile(filePath, 'image data')

    await expect(readSandboxFileBase64({ filePath, maxBytes: 100 }, [sandboxRoot])).resolves.toEqual({
      success: true,
      base64: Buffer.from('image data').toString('base64'),
    })
  })

  test('rejects non-regular files before attempting to read them', async () => {
    const directoryPath = path.join(sandboxRoot, 'image.png')
    await mkdir(directoryPath)

    await expect(readSandboxFileBase64({ filePath: directoryPath }, [sandboxRoot])).resolves.toEqual({
      success: false,
      error: 'Access denied: path is not a regular file',
    })
  })

  test('reports size only after the file passes sandbox containment', async () => {
    const outsidePath = path.join(testRoot, 'outside.bin')
    await writeFile(outsidePath, 'x'.repeat(32))

    const outsideResult = await readSandboxFileBase64({ filePath: outsidePath, maxBytes: 1 }, [sandboxRoot])
    expect(outsideResult).toEqual({ success: false, error: 'Access denied: path outside sandbox directory' })
    expect(JSON.stringify(outsideResult)).not.toContain('32 bytes')

    const insidePath = path.join(sandboxRoot, 'inside.bin')
    await writeFile(insidePath, 'x'.repeat(32))
    await expect(readSandboxFileBase64({ filePath: insidePath, maxBytes: 1 }, [sandboxRoot])).resolves.toEqual({
      success: false,
      error: 'File is too large (32 bytes, max 1)',
    })
  })
})
