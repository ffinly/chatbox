import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

function readRendererSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), 'src/renderer', relativePath), 'utf8')
}

describe('global scrollbar defaults', () => {
  test('leaves global scrollbars to the browser and operating system', () => {
    const entrySource = readRendererSource('index.tsx')
    const indexStyles = readRendererSource('static/index.css')
    const globalStyles = readRendererSource('static/globals.css')
    const unscopedScrollbarSelector = /^\s*(?:(?:\*|html|body)\s*)?::(?:-webkit-)?scrollbar/m

    expect(entrySource).not.toContain("import './setup/scrollbar_visibility'")
    expect(indexStyles).not.toContain('scrollbar-scrolling')
    expect(indexStyles).not.toMatch(unscopedScrollbarSelector)
    expect(globalStyles).not.toMatch(unscopedScrollbarSelector)
  })

  test('keeps explicitly scoped scrollbar behavior', () => {
    const globalStyles = readRendererSource('static/globals.css')

    expect(globalStyles).toContain('.katex-display::-webkit-scrollbar')
    expect(globalStyles).toContain('.scrollbar-custom::-webkit-scrollbar')
  })
})
