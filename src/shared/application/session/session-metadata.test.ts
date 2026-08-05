import { describe, expect, test } from 'vitest'
import type { SessionMeta } from '../../types'
import { projectSessionMeta } from './session-metadata'

describe('projectSessionMeta', () => {
  test('preserves the previous pick semantics for absent and explicitly undefined optional fields', () => {
    const minimal: SessionMeta = {
      id: 'session-1',
      name: 'Session 1',
    }

    const withoutOptionalFields = projectSessionMeta(minimal)
    expect(withoutOptionalFields).toEqual(minimal)
    expect(Object.hasOwn(withoutOptionalFields, 'starred')).toBe(false)

    const withExplicitUndefined = projectSessionMeta({
      ...minimal,
      starred: undefined,
    })
    expect(Object.hasOwn(withExplicitUndefined, 'starred')).toBe(true)
    expect(withExplicitUndefined.starred).toBeUndefined()
  })
})
