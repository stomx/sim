import { type NextRequest, NextResponse } from 'next/server'
import { createLogger } from '@/lib/logs/console/logger'
import { filterBlacklistedModels } from '@/providers/utils'

const logger = createLogger('OpenRouterModelsAPI')

export const dynamic = 'force-dynamic'

// Cache for 1 hour to avoid repeated external API calls (models don't change frequently)
export const revalidate = 3600

interface OpenRouterModel {
  id: string
}

interface OpenRouterResponse {
  data: OpenRouterModel[]
}

export async function GET(_request: NextRequest) {
  try {
    // Add timeout to prevent hanging indefinitely
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 5000) // 5 second timeout

    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      // Cache for 1 hour (models don't change frequently)
      next: { revalidate: 3600 },
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      logger.warn('Failed to fetch OpenRouter models', {
        status: response.status,
        statusText: response.statusText,
      })
      return NextResponse.json({ models: [] })
    }

    const data = (await response.json()) as OpenRouterResponse
    const allModels = Array.from(new Set(data.data?.map((model) => `openrouter/${model.id}`) ?? []))
    const models = filterBlacklistedModels(allModels)

    logger.info('Successfully fetched OpenRouter models', {
      count: models.length,
      filtered: allModels.length - models.length,
    })

    return NextResponse.json({ models })
  } catch (error) {
    // Handle timeout and other errors gracefully
    if (error instanceof Error && error.name === 'AbortError') {
      logger.warn('OpenRouter API request timed out after 5 seconds')
    } else {
      logger.error('Error fetching OpenRouter models', {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
    // Return empty array to avoid breaking the UI
    return NextResponse.json({ models: [] })
  }
}
