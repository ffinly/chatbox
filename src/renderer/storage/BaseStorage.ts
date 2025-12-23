import { getLogger } from '@/lib/utils'
import platform from '@/platform'

const log = getLogger('base-storage')

export default class BaseStorage {
  constructor() {}

  public getStorageType() {
    return platform.getStorageType()
  }

  public async setItem<T>(key: string, value: T): Promise<void> {
    return this.setItemNow(key, value)
  }

  public async setItemNow<T>(key: string, value: T): Promise<void> {
    try {
      return await platform.setStoreValue(key, value)
    } catch (error) {
      log.error(`Failed to write to storage (key: ${key}):`, error)
      throw error
    }
  }

  // getItem 需要保证如果数据不存在，返回默认值的同时，也要将默认值写入存储
  public async getItem<T>(key: string, initialValue: T): Promise<T> {
    try {
      let value: any = await platform.getStoreValue(key)
      if (value === undefined || value === null) {
        value = initialValue
        this.setItemNow(key, value)
      }
      return value
    } catch (error) {
      log.error(`Failed to read from storage (key: ${key}):`, error)
      throw error
    }
  }

  public async removeItem(key: string): Promise<void> {
    return platform.delStoreValue(key)
  }

  public async getAll(): Promise<{ [key: string]: any }> {
    try {
      return await platform.getAllStoreValues()
    } catch (error) {
      log.error('Failed to read all values from storage:', error)
      throw error
    }
  }

  public async getAllKeys(): Promise<string[]> {
    try {
      return await platform.getAllStoreKeys()
    } catch (error) {
      log.error('Failed to read all keys from storage:', error)
      throw error
    }
  }

  public async setAll(data: { [key: string]: any }) {
    return platform.setAllStoreValues(data)
  }

  // TODO: 这些数据也应该实现数据导出与导入
  public async setBlob(key: string, value: string) {
    return platform.setStoreBlob(key, value)
  }
  public async getBlob(key: string): Promise<string | null> {
    try {
      return await platform.getStoreBlob(key)
    } catch (error) {
      log.error(`Failed to read blob from storage (key: ${key}):`, error)
      throw error
    }
  }
  public async delBlob(key: string) {
    return platform.delStoreBlob(key)
  }
  public async getBlobKeys(): Promise<string[]> {
    return platform.listStoreBlobKeys()
  }
  // subscribe(key: string, callback: any, initialValue: any): Promise<void>
}
