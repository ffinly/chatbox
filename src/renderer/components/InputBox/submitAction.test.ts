import { describe, expect, it } from 'vitest'
import { getSubmitAction } from './submitAction'

const base = {
  generating: false,
  needGenerating: true,
  sessionType: 'chat' as const,
  queueLength: 0,
  blockedForOtherReasons: false,
  hasModel: true,
}

describe('getSubmitAction', () => {
  it('sends in the normal idle case', () => {
    expect(getSubmitAction(base)).toBe('send')
  })

  it('blocks when other guards are active or there is no model', () => {
    expect(getSubmitAction({ ...base, blockedForOtherReasons: true })).toBe('block')
    expect(getSubmitAction({ ...base, hasModel: false })).toBe('block')
    expect(getSubmitAction({ ...base, generating: true, blockedForOtherReasons: true })).toBe('block')
  })

  it('queues while generating', () => {
    expect(getSubmitAction({ ...base, generating: true })).toBe('queue')
  })

  it('keeps the historical no-op for "insert without reply" during generation', () => {
    expect(getSubmitAction({ ...base, generating: true, needGenerating: false })).toBe('block')
  })

  it('does not queue for picture sessions', () => {
    expect(getSubmitAction({ ...base, generating: true, sessionType: 'picture' })).toBe('block')
  })

  it('queues behind pending items when idle so send order is preserved', () => {
    expect(getSubmitAction({ ...base, queueLength: 2 })).toBe('queue-resume')
  })

  it('sends directly when idle with an empty queue even without needGenerating', () => {
    expect(getSubmitAction({ ...base, needGenerating: false })).toBe('send')
    expect(getSubmitAction({ ...base, needGenerating: false, queueLength: 1 })).toBe('send')
  })
})
