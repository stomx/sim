import { useShallow } from 'zustand/react/shallow'
import { BlockPathCalculator } from '@/lib/block-path-calculator'
import { createLogger } from '@/lib/logs/console/logger'
import { getBlockOutputs } from '@/lib/workflows/block-outputs'
import { useWorkflowRegistry } from '@/stores/workflows/registry/store'
import { useSubBlockStore } from '@/stores/workflows/subblock/store'
import { useWorkflowStore } from '@/stores/workflows/workflow/store'

const logger = createLogger('useBlockConnections')

interface Field {
  name: string
  type: string
  description?: string
}

export interface ConnectedBlock {
  id: string
  type: string
  outputType: string | string[]
  name: string
  responseFormat?: {
    // Support both formats
    fields?: Field[]
    name?: string
    schema?: {
      type: string
      properties: Record<string, any>
      required?: string[]
    }
  }
}

function parseResponseFormatSafely(responseFormatValue: any, blockId: string): any {
  if (!responseFormatValue) {
    return undefined
  }

  if (typeof responseFormatValue === 'object' && responseFormatValue !== null) {
    return responseFormatValue
  }

  if (typeof responseFormatValue === 'string') {
    const trimmedValue = responseFormatValue.trim()

    if (trimmedValue.startsWith('<') && trimmedValue.includes('>')) {
      return trimmedValue
    }

    if (trimmedValue === '') {
      return undefined
    }

    try {
      return JSON.parse(trimmedValue)
    } catch (error) {
      return undefined
    }
  }
  return undefined
}

// Helper function to extract fields from JSON Schema
function extractFieldsFromSchema(schema: any): Field[] {
  if (!schema || typeof schema !== 'object') {
    return []
  }

  // Handle legacy format with fields array
  if (Array.isArray(schema.fields)) {
    return schema.fields
  }

  // Handle new JSON Schema format
  const schemaObj = schema.schema || schema
  if (!schemaObj || !schemaObj.properties || typeof schemaObj.properties !== 'object') {
    return []
  }

  // Extract fields from schema properties
  return Object.entries(schemaObj.properties).map(([name, prop]: [string, any]) => ({
    name,
    type: prop.type || 'string',
    description: prop.description,
  }))
}

export function useBlockConnections(blockId: string) {
  const { edges, blocks } = useWorkflowStore(
    useShallow((state) => ({
      edges: state.edges,
      blocks: state.blocks,
    }))
  )

  const workflowId = useWorkflowRegistry((state) => state.activeWorkflowId)
  const workflowSubBlockValues = useSubBlockStore((state) =>
    workflowId ? (state.workflowValues[workflowId] ?? {}) : {}
  )

  // Helper function to merge block subBlocks with live values from subblock store
  const getMergedSubBlocks = (sourceBlockId: string): Record<string, any> => {
    const base = blocks[sourceBlockId]?.subBlocks || {}
    const live = workflowSubBlockValues?.[sourceBlockId] || {}
    const merged: Record<string, any> = { ...base }
    for (const [subId, liveVal] of Object.entries(live)) {
      merged[subId] = { ...(base[subId] || {}), value: liveVal }
    }
    return merged
  }

  // Find all blocks along paths leading to this block
  const allPathNodeIds = BlockPathCalculator.findAllPathNodes(edges, blockId)

  // Map each path node to a ConnectedBlock structure
  const allPathConnections = allPathNodeIds
    .map((sourceId) => {
      const sourceBlock = blocks[sourceId]
      if (!sourceBlock) return null

      // Get merged subblocks for this source block
      const mergedSubBlocks = getMergedSubBlocks(sourceId)

      // Get the response format from the subblock store
      const responseFormatValue = useSubBlockStore.getState().getValue(sourceId, 'responseFormat')

      // Safely parse response format with proper error handling
      const responseFormat = parseResponseFormatSafely(responseFormatValue, sourceId)

      // Use getBlockOutputs to properly handle dynamic outputs from inputFormat
      const blockOutputs = getBlockOutputs(
        sourceBlock.type,
        mergedSubBlocks,
        sourceBlock.triggerMode
      )

      // Extract fields from the response format if available, otherwise use block outputs
      let outputFields: Field[]
      if (responseFormat) {
        outputFields = extractFieldsFromSchema(responseFormat)
      } else {
        // Convert block outputs to field format
        outputFields = Object.entries(blockOutputs).map(([key, value]: [string, any]) => ({
          name: key,
          type: value && typeof value === 'object' && 'type' in value ? value.type : 'string',
          description:
            value && typeof value === 'object' && 'description' in value
              ? value.description
              : undefined,
        }))
      }

      return {
        id: sourceBlock.id,
        type: sourceBlock.type,
        outputType: outputFields.map((field: Field) => field.name),
        name: sourceBlock.name,
        responseFormat,
      }
    })
    .filter(Boolean) as ConnectedBlock[]

  // Keep the original incoming connections for compatibility
  const directIncomingConnections = edges
    .filter((edge) => edge.target === blockId)
    .map((edge) => {
      const sourceBlock = blocks[edge.source]
      if (!sourceBlock) return null

      // Get merged subblocks for this source block
      const mergedSubBlocks = getMergedSubBlocks(edge.source)

      // Get the response format from the subblock store instead
      const responseFormatValue = useSubBlockStore
        .getState()
        .getValue(edge.source, 'responseFormat')

      // Safely parse response format with proper error handling
      const responseFormat = parseResponseFormatSafely(responseFormatValue, edge.source)

      // Use getBlockOutputs to properly handle dynamic outputs from inputFormat
      const blockOutputs = getBlockOutputs(
        sourceBlock.type,
        mergedSubBlocks,
        sourceBlock.triggerMode
      )

      // Extract fields from the response format if available, otherwise use block outputs
      let outputFields: Field[]
      if (responseFormat) {
        outputFields = extractFieldsFromSchema(responseFormat)
      } else {
        // Convert block outputs to field format
        outputFields = Object.entries(blockOutputs).map(([key, value]: [string, any]) => ({
          name: key,
          type: value && typeof value === 'object' && 'type' in value ? value.type : 'string',
          description:
            value && typeof value === 'object' && 'description' in value
              ? value.description
              : undefined,
        }))
      }

      return {
        id: sourceBlock.id,
        type: sourceBlock.type,
        outputType: outputFields.map((field: Field) => field.name),
        name: sourceBlock.name,
        responseFormat,
      }
    })
    .filter(Boolean) as ConnectedBlock[]

  return {
    incomingConnections: allPathConnections,
    directIncomingConnections,
    hasIncomingConnections: allPathConnections.length > 0,
  }
}
