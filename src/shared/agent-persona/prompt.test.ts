import { MEMORY_PROMPT_MAX_CHARS, SOUL_MAX_CHARS, SOUL_VIRTUAL_PATH } from '@shared/types/agent-persona'
import { describe, expect, test } from 'vitest'
import {
  buildAgentIdentityPrompt,
  buildAgentPersonaPrompt,
  buildMemoriesSection,
  buildSoulSection,
  DEFAULT_SOUL_PERSONA,
  extractSoulContent,
} from './prompt'

describe('buildAgentIdentityPrompt', () => {
  test('formats desktop macOS', () => {
    const prompt = buildAgentIdentityPrompt({ platformType: 'desktop', os: 'Mac' })
    expect(prompt).toContain('You are Chatbox agent, running inside the Chatbox client.')
    expect(prompt).toContain('Current platform: Desktop (macOS)')
  })

  test('omits unknown OS', () => {
    const prompt = buildAgentIdentityPrompt({ platformType: 'web', os: 'Unknown' })
    expect(prompt).toContain('Current platform: Web')
    expect(prompt).not.toContain('Unknown')
  })
})

describe('extractSoulContent', () => {
  test('treats an unedited template as empty', () => {
    const template = `# Soul

> This file defines who your Chatbox agent is.
> Keep it short and sharp.

## Personality & Tone

<!-- e.g. Concise and direct. -->

## Boundaries

<!-- e.g. Private things stay private. -->
`
    expect(extractSoulContent(template)).toBe('')
  })

  test('keeps user content while preserving structure', () => {
    const soul = `# Soul

## Personality & Tone

Direct, dry humor, no filler.

<!-- guidance comment -->
`
    const extracted = extractSoulContent(soul)
    expect(extracted).toContain('Direct, dry humor, no filler.')
    expect(extracted).not.toContain('guidance comment')
  })
})

describe('buildSoulSection', () => {
  test('falls back to the default persona for empty content', () => {
    expect(buildSoulSection('')).toContain(DEFAULT_SOUL_PERSONA)
  })

  test('references the virtual path for self-editing', () => {
    expect(buildSoulSection('')).toContain(SOUL_VIRTUAL_PATH)
  })

  test('truncates oversized souls with a marker', () => {
    const section = buildSoulSection(`custom persona ${'x'.repeat(SOUL_MAX_CHARS + 100)}`)
    expect(section).toContain('[Soul truncated for context safety]')
    expect(section.length).toBeLessThan(SOUL_MAX_CHARS + 500)
  })
})

describe('buildMemoriesSection', () => {
  test('empty memories produce no section', () => {
    expect(buildMemoriesSection([])).toBe('')
  })

  test('renders entries with ids for delete_memory', () => {
    const section = buildMemoriesSection([{ id: 'm1', content: 'User prefers pnpm', createdAt: 1 }])
    expect(section).toContain('- [m1] User prefers pnpm')
  })

  test('keeps newest entries when over budget and notes omissions', () => {
    const bigEntry = 'y'.repeat(900)
    const memories = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`,
      content: `${i}-${bigEntry}`,
      createdAt: i,
    }))
    const section = buildMemoriesSection(memories)
    expect(section.length).toBeLessThan(MEMORY_PROMPT_MAX_CHARS + 800)
    // Newest survives, oldest is dropped.
    expect(section).toContain('[m19]')
    expect(section).not.toContain('[m0]')
    expect(section).toContain('older memories omitted')
  })
})

describe('buildAgentPersonaPrompt', () => {
  test('orders identity, soul, then memories', () => {
    const prompt = buildAgentPersonaPrompt({
      platformType: 'desktop',
      os: 'Windows',
      soul: 'Persona body text.',
      memories: [{ id: 'm1', content: 'A fact', createdAt: 1 }],
    })
    const identityIx = prompt.indexOf('You are Chatbox agent')
    const soulIx = prompt.indexOf('## Soul')
    const memoriesIx = prompt.indexOf('## Memories')
    expect(identityIx).toBeGreaterThanOrEqual(0)
    expect(soulIx).toBeGreaterThan(identityIx)
    expect(memoriesIx).toBeGreaterThan(soulIx)
  })
})
