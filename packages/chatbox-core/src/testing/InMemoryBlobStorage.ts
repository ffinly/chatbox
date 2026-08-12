import type { BlobStoragePort } from '../ports'

export class InMemoryBlobStorage implements BlobStoragePort {
  readonly values = new Map<string, string>()

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null)
  }

  set(key: string, value: string): Promise<void> {
    this.values.set(key, value)
    return Promise.resolve()
  }

  touch(_key: string): void {
    // This adapter has no orphan cleanup clock, so every stored value remains live.
  }

  remove(key: string): Promise<void> {
    this.values.delete(key)
    return Promise.resolve()
  }

  keys(): Promise<string[]> {
    return Promise.resolve([...this.values.keys()])
  }
}
