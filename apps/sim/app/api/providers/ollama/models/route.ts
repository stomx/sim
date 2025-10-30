import { type NextRequest, NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { createLogger } from '@/lib/logs/console/logger'
import type { ModelsObject } from '@/providers/ollama/types'

const logger = createLogger('OllamaModelsAPI')
const OLLAMA_HOST = env.OLLAMA_URL || 'http://localhost:11434'

export const dynamic = 'force-dynamic'

// Cache for 2 minutes
export const revalidate = 120

/**
 * Get available Ollama models
 */
export async function GET(request: NextRequest) {
  // Early return if Ollama is disabled
  if (!env.OLLAMA_ENABLED) {
    logger.info('Ollama provider disabled via environment variable')
    return NextResponse.json({ models: [] })
  }

  try {
    logger.info('Fetching Ollama models', {
      host: OLLAMA_HOST,
    })

    // Add timeout to prevent hanging if Ollama is not running
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 2000) // 2 second timeout

    const response = await fetch(`${OLLAMA_HOST}/api/tags`, {
      headers: {
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      logger.warn('Ollama service is not available', {
        status: response.status,
        statusText: response.statusText,
      })
      return NextResponse.json({ models: [] })
    }

    const data = (await response.json()) as ModelsObject
    const models = data.models.map((model) => model.name)

    logger.info('Successfully fetched Ollama models', {
      count: models.length,
      models,
    })

    return NextResponse.json({ models })
  } catch (error) {
    // Handle timeout and other errors gracefully
    if (error instanceof Error && error.name === 'AbortError') {
      logger.warn('Ollama API request timed out after 2 seconds - service may not be running', {
        host: OLLAMA_HOST,
      })
    } else {
      logger.error('Failed to fetch Ollama models', {
        error: error instanceof Error ? error.message : 'Unknown error',
        host: OLLAMA_HOST,
      })
    }

    // Return empty array instead of error to avoid breaking the UI
    return NextResponse.json({ models: [] })
  }
}
