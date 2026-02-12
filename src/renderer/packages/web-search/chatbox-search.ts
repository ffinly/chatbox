import type { SearchResult } from '@shared/types'
import { webBrowsing } from '@/packages/remote'
import WebSearch from './base'

export class ChatboxSearch extends WebSearch {
  private licenseKey: string

  constructor(licenseKey: string) {
    super()
    this.licenseKey = licenseKey
  }

  async search(query: string): Promise<SearchResult> {
    if (this.licenseKey) {
      const res = await webBrowsing({
        licenseKey: this.licenseKey,
        query,
      })

      return {
        items: res.links.map((link) => ({
          title: link.title,
          link: link.url,
          snippet: link.content,
        })),
      }
    } else {
      return {
        items: [],
      }
    }
  }
}
