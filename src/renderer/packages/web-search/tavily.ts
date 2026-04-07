import { ChatboxAIAPIError } from '@shared/models/errors'
import type { SearchResult } from '@shared/types'
import { ofetch } from 'ofetch'
import WebSearch, { type ParseLinkResult } from './base'

export class TavilySearch extends WebSearch {
  private apiKey: string

  override supportsParseLink = true

  constructor(apiKey: string) {
    super()
    this.apiKey = apiKey
  }

  async search(query: string, signal?: AbortSignal): Promise<SearchResult> {
    try {
      const response = await ofetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: {
          query,
          search_depth: 'basic',
          include_domains: [],
          exclude_domains: [],
        },
        signal,
      })

      const items = (response.results || []).map(
        (result: { title: string; url: string; content: string }) => ({
          title: result.title,
          link: result.url,
          snippet: result.content,
        })
      )

      return { items }
    } catch (error) {
      console.error('Tavily search error:', error)
      throw error
    }
  }

  async parseLink(url: string, signal?: AbortSignal): Promise<ParseLinkResult> {
    const response = await ofetch('https://api.tavily.com/extract', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: {
        urls: [url],
      },
      signal,
    })

    const result = response.results?.[0]
    if (!result) {
      const failedUrl = response.failed_results?.[0]?.url ?? url
      const technical = `Tavily extract API returned no results for ${failedUrl}`
      throw ChatboxAIAPIError.fromCodeName(technical, 'parse_link_failed') ?? new Error(technical)
    }

    return {
      url: result.url,
      title: result.title || '',
      content: result.raw_content || '',
    }
  }
}
