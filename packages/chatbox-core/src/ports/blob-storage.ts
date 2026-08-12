export interface BlobStoragePort {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  /** Marks a key as recently used so orphan cleanup treats it as in-flight. */
  touch(key: string): void
  remove(key: string): Promise<void>
  keys(): Promise<string[]>
}
