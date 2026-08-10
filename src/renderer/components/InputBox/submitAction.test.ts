import { describe, expect, it } from 'vitest'
import { getSubmitAction, getSubmitControl } from './submitAction'

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

  it('keeps legacy picture sessions read-only', () => {
    expect(getSubmitAction({ ...base, sessionType: 'picture' })).toBe('block')
    expect(getSubmitAction({ ...base, generating: true, sessionType: 'picture' })).toBe('block')
    expect(getSubmitAction({ ...base, needGenerating: false, sessionType: 'picture' })).toBe('block')
  })

  it('queues behind pending items when idle so send order is preserved', () => {
    expect(getSubmitAction({ ...base, queueLength: 2 })).toBe('queue-resume')
  })

  it('sends directly when idle with an empty queue even without needGenerating', () => {
    expect(getSubmitAction({ ...base, needGenerating: false })).toBe('send')
    expect(getSubmitAction({ ...base, needGenerating: false, queueLength: 1 })).toBe('send')
  })
})

describe('getSubmitControl', () => {
  const controlBase = {
    generating: true,
    hasDraft: true,
    canQueueDraft: true,
    sessionType: 'chat' as const,
    hasModel: true,
  }

  it('shows the normal send control while idle', () => {
    expect(getSubmitControl({ ...controlBase, generating: false, hasDraft: false, canQueueDraft: false })).toBe('send')
    expect(getSubmitControl({ ...controlBase, generating: false })).toBe('send')
  })

  it('shows stop for an empty draft while generating', () => {
    expect(getSubmitControl({ ...controlBase, hasDraft: false })).toBe('stop')
  })

  it('replaces stop with the queue send control when the draft can be queued', () => {
    expect(getSubmitControl(controlBase)).toBe('queue')
  })

  it('keeps stop available when a non-empty draft cannot be queued', () => {
    expect(getSubmitControl({ ...controlBase, canQueueDraft: false })).toBe('stop')
  })

  it('keeps stop available when generating sessions do not support queueing', () => {
    expect(getSubmitControl({ ...controlBase, sessionType: 'picture' })).toBe('stop')
    expect(getSubmitControl({ ...controlBase, hasModel: false })).toBe('stop')
  })
})
