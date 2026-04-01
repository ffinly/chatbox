import type { SearchResult } from '@shared/types'
import { ofetch } from 'ofetch'
import WebSearch from './base'

export class BochaSearch extends WebSearch {
  private apiKey: string

  constructor(apiKey: string) {
    super()
    this.apiKey = apiKey
  }

  async search(query: string, signal?: AbortSignal): Promise<SearchResult> {
    try {
      const response = await ofetch('https://api.bochaai.com/v1/web-search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: { query },
        signal,
      })

      const results = response.webPages?.value || []
      const items = results.map(
        (result: { name: string; url: string; summary?: string; snippet?: string }) => ({
          title: result.name,
          link: result.url,
          snippet: result.summary || result.snippet || '',
        })
      )

      return { items }
    } catch (error) {
      console.error('BoCha search error:', error)
      throw error
    }
  }
}
