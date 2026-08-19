import { afterEach, describe, expect, it } from 'vitest'
import { getRegistryModelMeta, setRuntimeRegistry } from './enrich'

describe('getRegistryModelMeta', () => {
  afterEach(() => {
    setRuntimeRegistry(null)
  })

  it('returns the legacy Haiku output cap when the live catalog omitted it', () => {
    setRuntimeRegistry({ claude: {} })
    expect(getRegistryModelMeta('claude', 'claude-3-haiku-20240307')?.maxOutput).toBe(4096)
  })
})
