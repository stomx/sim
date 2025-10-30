import { create } from 'zustand'
import { createLogger } from '@/lib/logs/console/logger'
import { updateOllamaProviderModels, updateOpenRouterProviderModels } from '@/providers/utils'
import type { ProviderConfig, ProviderName, ProvidersStore } from './types'

const logger = createLogger('ProvidersStore')

const PROVIDER_CONFIGS: Record<ProviderName, ProviderConfig> = {
  base: {
    apiEndpoint: '/api/providers/base/models',
    dedupeModels: true,
    updateFunction: () => {},
  },
  ollama: {
    apiEndpoint: '/api/providers/ollama/models',
    updateFunction: updateOllamaProviderModels,
  },
  openrouter: {
    apiEndpoint: '/api/providers/openrouter/models',
    dedupeModels: true,
    updateFunction: updateOpenRouterProviderModels,
  },
}

const fetchProviderModels = async (provider: ProviderName): Promise<string[]> => {
  try {
    const config = PROVIDER_CONFIGS[provider]
    const response = await fetch(config.apiEndpoint)

    if (!response.ok) {
      logger.warn(`Failed to fetch ${provider} models from API`, {
        status: response.status,
        statusText: response.statusText,
      })
      return []
    }

    const data = await response.json()
    return data.models || []
  } catch (error) {
    logger.error(`Error fetching ${provider} models`, {
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    return []
  }
}

export const useProvidersStore = create<ProvidersStore>((set, get) => ({
  providers: {
    base: { models: [], isLoading: false },
    ollama: { models: [], isLoading: false },
    openrouter: { models: [], isLoading: false },
  },

  setModels: (provider, models) => {
    const config = PROVIDER_CONFIGS[provider]

    const processedModels = config.dedupeModels ? Array.from(new Set(models)) : models

    set((state) => ({
      providers: {
        ...state.providers,
        [provider]: {
          ...state.providers[provider],
          models: processedModels,
        },
      },
    }))

    config.updateFunction(models)
  },

  fetchModels: async (provider) => {
    if (typeof window === 'undefined') {
      logger.info(`Skipping client-side ${provider} model fetch on server`)
      return
    }

    const currentState = get().providers[provider]
    if (currentState.isLoading) {
      logger.info(`${provider} model fetch already in progress`)
      return
    }

    logger.info(`Fetching ${provider} models from API`)

    set((state) => ({
      providers: {
        ...state.providers,
        [provider]: {
          ...state.providers[provider],
          isLoading: true,
        },
      },
    }))

    try {
      const models = await fetchProviderModels(provider)
      logger.info(`Successfully fetched ${provider} models`, {
        count: models.length,
        ...(provider === 'ollama' ? { models } : {}),
      })
      get().setModels(provider, models)
    } catch (error) {
      logger.error(`Failed to fetch ${provider} models`, {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    } finally {
      set((state) => ({
        providers: {
          ...state.providers,
          [provider]: {
            ...state.providers[provider],
            isLoading: false,
          },
        },
      }))
    }
  },

  getProvider: (provider) => {
    return get().providers[provider]
  },
}))

// Fetch all provider models in parallel on client initialization
if (typeof window !== 'undefined') {
  setTimeout(() => {
    const store = useProvidersStore.getState()
    // Use Promise.allSettled to fetch all providers in parallel
    // This prevents slow providers from blocking others
    Promise.allSettled([
      store.fetchModels('base'),
      store.fetchModels('ollama'),
      store.fetchModels('openrouter'),
    ]).then((results) => {
      results.forEach((result, index) => {
        const providerName = ['base', 'ollama', 'openrouter'][index] as ProviderName
        if (result.status === 'rejected') {
          logger.warn(`Failed to load ${providerName} models`, { error: result.reason })
        }
      })
    })
  }, 1000)
}
