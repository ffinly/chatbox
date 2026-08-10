import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { formatTooLargeFileRead, readRegularFileBytesBounded } from '../bounded-file-read'

export interface ReadSandboxFileBase64Params {
  filePath: string
  maxBytes?: number
}

/** Read a regular, non-symlink file only after proving it belongs to an allowed sandbox root. */
export async function readSandboxFileBase64(
  params: ReadSandboxFileBase64Params,
  sandboxRoots: string[]
): Promise<{ success: true; base64: string } | { success: false; error: string }> {
  const fileStat = await lstat(params.filePath)
  if (fileStat.isSymbolicLink()) {
    return { success: false, error: 'Access denied: symlinks not allowed' }
  }
  const resolved = await realpath(params.filePath)
  const isInsideSandbox = sandboxRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep))
  if (!isInsideSandbox) {
    return { success: false, error: 'Access denied: path outside sandbox directory' }
  }
  const result = await readRegularFileBytesBounded(resolved, params.maxBytes)
  if (result.success) return { success: true, base64: result.bytes.toString('base64') }
  if (result.reason === 'not-regular-file') {
    return { success: false, error: 'Access denied: path is not a regular file' }
  }
  return { success: false, error: formatTooLargeFileRead(result, 'File') }
}
