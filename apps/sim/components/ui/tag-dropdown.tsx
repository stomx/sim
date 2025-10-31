import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { extractFieldsFromSchema, parseResponseFormatSafely } from '@/lib/response-format'
import { cn } from '@/lib/utils'
import { getBlockOutputPaths, getBlockOutputType } from '@/lib/workflows/block-outputs'
import { useAccessibleReferencePrefixes } from '@/app/workspace/[workspaceId]/w/[workflowId]/hooks/use-accessible-reference-prefixes'
import { getBlock } from '@/blocks'
import type { BlockConfig } from '@/blocks/types'
import { useVariablesStore } from '@/stores/panel/variables/store'
import type { Variable } from '@/stores/panel/variables/types'
import { useWorkflowRegistry } from '@/stores/workflows/registry/store'
import { useSubBlockStore } from '@/stores/workflows/subblock/store'
import { useWorkflowStore } from '@/stores/workflows/workflow/store'
import type { BlockState } from '@/stores/workflows/workflow/types'
import { getTool } from '@/tools/utils'

interface BlockTagGroup {
  blockName: string
  blockId: string
  blockType: string
  tags: string[]
  distance: number
}

interface NestedBlockTagGroup extends BlockTagGroup {
  nestedTags: Array<{
    key: string
    display: string
    fullTag?: string
    children?: Array<{ key: string; display: string; fullTag: string }>
  }>
}

interface TagDropdownProps {
  visible: boolean
  onSelect: (newValue: string) => void
  blockId: string
  activeSourceBlockId: string | null
  className?: string
  inputValue: string
  cursorPosition: number
  onClose?: () => void
  style?: React.CSSProperties
}

export const checkTagTrigger = (text: string, cursorPosition: number): { show: boolean } => {
  if (cursorPosition >= 1) {
    const textBeforeCursor = text.slice(0, cursorPosition)
    const lastOpenBracket = textBeforeCursor.lastIndexOf('<')
    const lastCloseBracket = textBeforeCursor.lastIndexOf('>')

    // Show if we have an unclosed '<' that's not part of a completed tag
    if (lastOpenBracket !== -1 && (lastCloseBracket === -1 || lastCloseBracket < lastOpenBracket)) {
      return { show: true }
    }
  }
  return { show: false }
}

const BLOCK_COLORS = {
  VARIABLE: '#2F8BFF',
  DEFAULT: '#2F55FF',
  LOOP: '#2FB3FF',
  PARALLEL: '#FEE12B',
} as const

const TAG_PREFIXES = {
  VARIABLE: 'variable.',
} as const

const normalizeBlockName = (blockName: string): string => {
  return blockName.replace(/\s+/g, '').toLowerCase()
}

const normalizeVariableName = (variableName: string): string => {
  return variableName.replace(/\s+/g, '')
}

const ensureRootTag = (tags: string[], rootTag: string): string[] => {
  if (!rootTag) {
    return tags
  }

  if (tags.includes(rootTag)) {
    return tags
  }

  return [rootTag, ...tags]
}

const getSubBlockValue = (blockId: string, property: string): any => {
  return useSubBlockStore.getState().getValue(blockId, property)
}

const createTagEventHandlers = (
  tag: string,
  group: BlockTagGroup | undefined,
  tagIndex: number,
  handleTagSelect: (tag: string, group?: BlockTagGroup) => void,
  setSelectedIndex: (index: number) => void,
  setHoveredNested: (value: { tag: string; index: number } | null) => void
) => ({
  onMouseEnter: () => {
    setSelectedIndex(tagIndex >= 0 ? tagIndex : 0)
    setHoveredNested(null)
  },
  onMouseDown: (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    handleTagSelect(tag, group)
  },
  onClick: (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    handleTagSelect(tag, group)
  },
})

const getOutputTypeForPath = (
  block: BlockState,
  blockConfig: BlockConfig | null,
  blockId: string,
  outputPath: string,
  mergedSubBlocksOverride?: Record<string, any>
): string => {
  if (block?.triggerMode && blockConfig?.triggers?.enabled) {
    // When in trigger mode, derive types from the selected trigger's outputs
    return getBlockOutputType(block.type, outputPath, mergedSubBlocksOverride, true)
  }
  if (block?.type === 'starter') {
    // Handle starter block specific outputs
    const startWorkflowValue =
      mergedSubBlocksOverride?.startWorkflow?.value ?? getSubBlockValue(blockId, 'startWorkflow')

    if (startWorkflowValue === 'chat') {
      // Define types for chat mode outputs
      const chatModeTypes: Record<string, string> = {
        input: 'string',
        conversationId: 'string',
        files: 'files',
      }
      return chatModeTypes[outputPath] || 'any'
    }
    // For API mode, check inputFormat for custom field types
    const inputFormatValue =
      mergedSubBlocksOverride?.inputFormat?.value ?? getSubBlockValue(blockId, 'inputFormat')
    if (inputFormatValue && Array.isArray(inputFormatValue)) {
      const field = inputFormatValue.find(
        (f: { name?: string; type?: string }) => f.name === outputPath
      )
      if (field?.type) {
        return field.type
      }
    }
  } else if (blockConfig?.category === 'triggers') {
    // For trigger blocks, use the dynamic output helper
    const blockState = useWorkflowStore.getState().blocks[blockId]
    const subBlocks = mergedSubBlocksOverride ?? (blockState?.subBlocks || {})
    return getBlockOutputType(block.type, outputPath, subBlocks)
  } else {
    const operationValue = getSubBlockValue(blockId, 'operation')
    if (blockConfig && operationValue) {
      return getToolOutputType(blockConfig, operationValue, outputPath)
    }
  }

  return 'any'
}

const generateOutputPaths = (outputs: Record<string, any>, prefix = ''): string[] => {
  const paths: string[] = []

  for (const [key, value] of Object.entries(outputs)) {
    const currentPath = prefix ? `${prefix}.${key}` : key

    if (typeof value === 'string') {
      // Simple type like 'string', 'number', 'json', 'any'
      paths.push(currentPath)
    } else if (typeof value === 'object' && value !== null) {
      // Check if this is our new format with type and description
      if ('type' in value && typeof value.type === 'string') {
        // New format: { type: 'string', description: '...' } - treat as leaf node
        paths.push(currentPath)
      } else {
        // Nested object - recurse to get all child paths
        const subPaths = generateOutputPaths(value, currentPath)
        paths.push(...subPaths)
      }
    } else {
      // Fallback - add the path
      paths.push(currentPath)
    }
  }

  return paths
}

const generateOutputPathsWithTypes = (
  outputs: Record<string, any>,
  prefix = ''
): Array<{ path: string; type: string }> => {
  const paths: Array<{ path: string; type: string }> = []

  for (const [key, value] of Object.entries(outputs)) {
    const currentPath = prefix ? `${prefix}.${key}` : key

    if (typeof value === 'string') {
      // Simple type like 'string', 'number', 'json', 'any'
      paths.push({ path: currentPath, type: value })
    } else if (typeof value === 'object' && value !== null) {
      // Check if this is our new format with type and description
      if ('type' in value && typeof value.type === 'string') {
        // Handle nested properties for arrays and objects
        if (value.type === 'array' && value.items?.properties) {
          // For arrays with properties, add the array itself and recurse into items
          paths.push({ path: currentPath, type: 'array' })
          const subPaths = generateOutputPathsWithTypes(value.items.properties, currentPath)
          paths.push(...subPaths)
        } else if (value.type === 'object' && value.properties) {
          // For objects with properties, add the object itself and recurse into properties
          paths.push({ path: currentPath, type: 'object' })
          const subPaths = generateOutputPathsWithTypes(value.properties, currentPath)
          paths.push(...subPaths)
        } else {
          // Leaf node - just add the type
          paths.push({ path: currentPath, type: value.type })
        }
      } else {
        // Legacy nested object - recurse and assume 'object' type
        const subPaths = generateOutputPathsWithTypes(value, currentPath)
        paths.push(...subPaths)
      }
    } else {
      // Fallback - add with 'any' type
      paths.push({ path: currentPath, type: 'any' })
    }
  }

  return paths
}

const generateToolOutputPaths = (blockConfig: BlockConfig, operation: string): string[] => {
  if (!blockConfig?.tools?.config?.tool) return []

  try {
    // Get the tool ID for this operation
    const toolId = blockConfig.tools.config.tool({ operation })
    if (!toolId) return []

    // Get the tool configuration
    const toolConfig = getTool(toolId)
    if (!toolConfig?.outputs) return []

    // Generate paths from tool outputs
    return generateOutputPaths(toolConfig.outputs)
  } catch (error) {
    console.warn('Failed to get tool outputs for operation:', operation, error)
    return []
  }
}

const getToolOutputType = (blockConfig: BlockConfig, operation: string, path: string): string => {
  if (!blockConfig?.tools?.config?.tool) return 'any'

  try {
    // Get the tool ID for this operation
    const toolId = blockConfig.tools.config.tool({ operation })
    if (!toolId) return 'any'

    // Get the tool configuration
    const toolConfig = getTool(toolId)
    if (!toolConfig?.outputs) return 'any'

    // Generate paths with types from tool outputs
    const pathsWithTypes = generateOutputPathsWithTypes(toolConfig.outputs)

    // Find the matching path and return its type
    const matchingPath = pathsWithTypes.find((p) => p.path === path)
    return matchingPath?.type || 'any'
  } catch (error) {
    console.warn('Failed to get tool output type for path:', path, error)
    return 'any'
  }
}

export const TagDropdown: React.FC<TagDropdownProps> = ({
  visible,
  onSelect,
  blockId,
  activeSourceBlockId,
  className,
  inputValue,
  cursorPosition,
  onClose,
  style,
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [hoveredNested, setHoveredNested] = useState<{ tag: string; index: number } | null>(null)
  const [inSubmenu, setInSubmenu] = useState(false)
  const [submenuIndex, setSubmenuIndex] = useState(0)
  const [parentHovered, setParentHovered] = useState<string | null>(null)
  const [submenuHovered, setSubmenuHovered] = useState(false)

  const { blocks, edges, loops, parallels } = useWorkflowStore(
    useShallow((state) => ({
      blocks: state.blocks,
      edges: state.edges,
      loops: state.loops || {},
      parallels: state.parallels || {},
    }))
  )

  const workflowId = useWorkflowRegistry((state) => state.activeWorkflowId)

  const rawAccessiblePrefixes = useAccessibleReferencePrefixes(blockId)

  const combinedAccessiblePrefixes = useMemo(() => {
    if (!rawAccessiblePrefixes) return new Set<string>()
    return new Set<string>(rawAccessiblePrefixes)
  }, [rawAccessiblePrefixes])

  // Subscribe to live subblock values for the active workflow to react to input format changes
  const workflowSubBlockValues = useSubBlockStore((state) =>
    workflowId ? (state.workflowValues[workflowId] ?? {}) : {}
  )

  const getMergedSubBlocks = useCallback(
    (targetBlockId: string): Record<string, any> => {
      const base = blocks[targetBlockId]?.subBlocks || {}
      const live = workflowSubBlockValues?.[targetBlockId] || {}
      const merged: Record<string, any> = { ...base }
      for (const [subId, liveVal] of Object.entries(live)) {
        merged[subId] = { ...(base[subId] || {}), value: liveVal }
      }
      return merged
    },
    [blocks, workflowSubBlockValues]
  )

  const getVariablesByWorkflowId = useVariablesStore((state) => state.getVariablesByWorkflowId)
  const workflowVariables = workflowId ? getVariablesByWorkflowId(workflowId) : []

  const searchTerm = useMemo(() => {
    const textBeforeCursor = inputValue.slice(0, cursorPosition)
    const match = textBeforeCursor.match(/<([^>]*)$/)
    return match ? match[1].toLowerCase() : ''
  }, [inputValue, cursorPosition])

  const {
    tags,
    variableInfoMap,
    blockTagGroups: computedBlockTagGroups,
  }: {
    tags: string[]
    variableInfoMap: Record<string, { type: string; id: string }>
    blockTagGroups: BlockTagGroup[]
  } = useMemo(() => {
    if (activeSourceBlockId) {
      const sourceBlock = blocks[activeSourceBlockId]
      if (!sourceBlock) {
        return { tags: [], variableInfoMap: {}, blockTagGroups: [] }
      }

      const blockConfig = getBlock(sourceBlock.type)

      if (!blockConfig) {
        if (sourceBlock.type === 'loop' || sourceBlock.type === 'parallel') {
          const mockConfig = {
            outputs: {
              results: 'array',
            },
          }
          const blockName = sourceBlock.name || sourceBlock.type
          const normalizedBlockName = normalizeBlockName(blockName)

          const outputPaths = generateOutputPaths(mockConfig.outputs)
          const blockTags = outputPaths.map((path) => `${normalizedBlockName}.${path}`)

          const blockTagGroups: BlockTagGroup[] = [
            {
              blockName,
              blockId: activeSourceBlockId,
              blockType: sourceBlock.type,
              tags: blockTags,
              distance: 0,
            },
          ]

          return {
            tags: blockTags,
            variableInfoMap: {},
            blockTagGroups,
          }
        }
        return { tags: [], variableInfoMap: {}, blockTagGroups: [] }
      }

      const blockName = sourceBlock.name || sourceBlock.type
      const normalizedBlockName = normalizeBlockName(blockName)

      const mergedSubBlocks = getMergedSubBlocks(activeSourceBlockId)
      const responseFormatValue = mergedSubBlocks?.responseFormat?.value
      const responseFormat = parseResponseFormatSafely(responseFormatValue, activeSourceBlockId)

      let blockTags: string[]

      if (sourceBlock.type === 'evaluator') {
        const metricsValue = getSubBlockValue(activeSourceBlockId, 'metrics')

        if (metricsValue && Array.isArray(metricsValue) && metricsValue.length > 0) {
          const validMetrics = metricsValue.filter((metric: { name?: string }) => metric?.name)
          blockTags = validMetrics.map(
            (metric: { name: string }) => `${normalizedBlockName}.${metric.name.toLowerCase()}`
          )
        } else {
          const outputPaths = generateOutputPaths(blockConfig.outputs)
          blockTags = outputPaths.map((path) => `${normalizedBlockName}.${path}`)
        }
      } else if (sourceBlock.type === 'variables') {
        // For variables block, show assigned variable names as outputs
        const variablesValue = getSubBlockValue(activeSourceBlockId, 'variables')

        if (variablesValue && Array.isArray(variablesValue) && variablesValue.length > 0) {
          const validAssignments = variablesValue.filter((assignment: { variableName?: string }) =>
            assignment?.variableName?.trim()
          )
          blockTags = validAssignments.map(
            (assignment: { variableName: string }) =>
              `${normalizedBlockName}.${assignment.variableName.trim()}`
          )
        } else {
          blockTags = [normalizedBlockName]
        }
      } else if (responseFormat) {
        const schemaFields = extractFieldsFromSchema(responseFormat)
        if (schemaFields.length > 0) {
          blockTags = schemaFields.map((field) => `${normalizedBlockName}.${field.name}`)
        } else {
          const outputPaths = generateOutputPaths(blockConfig.outputs || {})
          blockTags = outputPaths.map((path) => `${normalizedBlockName}.${path}`)
        }
      } else if (!blockConfig.outputs || Object.keys(blockConfig.outputs).length === 0) {
        if (sourceBlock.type === 'starter') {
          const startWorkflowValue = mergedSubBlocks?.startWorkflow?.value

          if (startWorkflowValue === 'chat') {
            // For chat mode, provide input, conversationId, and files
            blockTags = [
              `${normalizedBlockName}.input`,
              `${normalizedBlockName}.conversationId`,
              `${normalizedBlockName}.files`,
            ]
          } else {
            const inputFormatValue = mergedSubBlocks?.inputFormat?.value

            if (
              inputFormatValue &&
              Array.isArray(inputFormatValue) &&
              inputFormatValue.length > 0
            ) {
              blockTags = inputFormatValue
                .filter((field: { name?: string }) => field.name && field.name.trim() !== '')
                .map((field: { name: string }) => `${normalizedBlockName}.${field.name}`)
            } else {
              blockTags = [normalizedBlockName]
            }
          }
        } else if (sourceBlock.type === 'api_trigger' || sourceBlock.type === 'input_trigger') {
          // Handle API trigger and Input Form trigger with inputFormat
          const inputFormatValue = mergedSubBlocks?.inputFormat?.value

          if (inputFormatValue && Array.isArray(inputFormatValue) && inputFormatValue.length > 0) {
            blockTags = inputFormatValue
              .filter((field: { name?: string }) => field.name && field.name.trim() !== '')
              .map((field: { name: string }) => `${normalizedBlockName}.${field.name}`)
          } else {
            blockTags = []
          }
        } else {
          blockTags = [normalizedBlockName]
        }
      } else {
        // For triggers and starter blocks, use dynamic outputs based on live subblock values
        if (blockConfig.category === 'triggers' || sourceBlock.type === 'starter') {
          const dynamicOutputs = getBlockOutputPaths(sourceBlock.type, mergedSubBlocks)
          if (dynamicOutputs.length > 0) {
            blockTags = dynamicOutputs.map((path) => `${normalizedBlockName}.${path}`)
          } else if (sourceBlock.type === 'starter') {
            blockTags = [normalizedBlockName]
          } else if (sourceBlock.type === 'generic_webhook') {
            blockTags = [normalizedBlockName]
          } else {
            blockTags = []
          }
        } else if (sourceBlock?.triggerMode && blockConfig.triggers?.enabled) {
          // Use selected trigger from subblocks to determine outputs
          const dynamicOutputs = getBlockOutputPaths(sourceBlock.type, mergedSubBlocks, true)
          if (dynamicOutputs.length > 0) {
            blockTags = dynamicOutputs.map((path) => `${normalizedBlockName}.${path}`)
          } else {
            const outputPaths = generateOutputPaths(blockConfig.outputs || {})
            blockTags = outputPaths.map((path) => `${normalizedBlockName}.${path}`)
          }
        } else {
          // Check for tool-specific outputs first
          const operationValue =
            mergedSubBlocks?.operation?.value ?? getSubBlockValue(activeSourceBlockId, 'operation')
          const toolOutputPaths = operationValue
            ? generateToolOutputPaths(blockConfig, operationValue)
            : []

          if (toolOutputPaths.length > 0) {
            blockTags = toolOutputPaths.map((path) => `${normalizedBlockName}.${path}`)
          } else {
            const outputPaths = generateOutputPaths(blockConfig.outputs || {})
            blockTags = outputPaths.map((path) => `${normalizedBlockName}.${path}`)
          }
        }
      }

      blockTags = ensureRootTag(blockTags, normalizedBlockName)
      const shouldShowRootTag = sourceBlock.type === 'generic_webhook'
      if (!shouldShowRootTag) {
        blockTags = blockTags.filter((tag) => tag !== normalizedBlockName)
      }

      const blockTagGroups: BlockTagGroup[] = [
        {
          blockName,
          blockId: activeSourceBlockId,
          blockType: sourceBlock.type,
          tags: blockTags,
          distance: 0,
        },
      ]

      return {
        tags: blockTags,
        variableInfoMap: {},
        blockTagGroups,
      }
    }

    const hasInvalidBlocks = Object.values(blocks).some((block) => !block || !block.type)
    if (hasInvalidBlocks) {
      return {
        tags: [],
        variableInfoMap: {},
        blockTagGroups: [],
      }
    }

    const starterBlock = Object.values(blocks).find((block) => block.type === 'starter')

    const blockDistances: Record<string, number> = {}
    if (starterBlock) {
      const adjList: Record<string, string[]> = {}
      for (const edge of edges) {
        if (!adjList[edge.source]) adjList[edge.source] = []
        adjList[edge.source].push(edge.target)
      }

      const visited = new Set<string>()
      const queue: [string, number][] = [[starterBlock.id, 0]]

      while (queue.length > 0) {
        const [currentNodeId, distance] = queue.shift()!
        if (visited.has(currentNodeId)) continue
        visited.add(currentNodeId)
        blockDistances[currentNodeId] = distance

        const outgoingNodeIds = adjList[currentNodeId] || []
        for (const targetId of outgoingNodeIds) {
          queue.push([targetId, distance + 1])
        }
      }
    }

    const validVariables = workflowVariables.filter(
      (variable: Variable) => variable.name.trim() !== ''
    )

    const variableTags = validVariables.map(
      (variable: Variable) => `${TAG_PREFIXES.VARIABLE}${normalizeVariableName(variable.name)}`
    )

    const variableInfoMap = validVariables.reduce(
      (acc, variable) => {
        const tagName = `${TAG_PREFIXES.VARIABLE}${normalizeVariableName(variable.name)}`
        acc[tagName] = {
          type: variable.type,
          id: variable.id,
        }
        return acc
      },
      {} as Record<string, { type: string; id: string }>
    )

    let loopBlockGroup: BlockTagGroup | null = null

    // Check if blockId IS a loop block (for editing loop config like while condition)
    const isLoopBlock = blocks[blockId]?.type === 'loop'
    const currentLoop = isLoopBlock ? loops[blockId] : null

    // Check if blockId is INSIDE a loop
    const containingLoop = Object.entries(loops).find(([_, loop]) => loop.nodes.includes(blockId))

    let containingLoopBlockId: string | null = null

    // Prioritize current loop if editing the loop block itself
    if (currentLoop && isLoopBlock) {
      containingLoopBlockId = blockId
      const loopType = currentLoop.loopType || 'for'
      const contextualTags: string[] = ['index', 'currentIteration']
      if (loopType === 'forEach') {
        contextualTags.push('currentItem')
        contextualTags.push('items')
      }

      const loopBlock = blocks[blockId]
      if (loopBlock) {
        const loopBlockName = loopBlock.name || loopBlock.type

        loopBlockGroup = {
          blockName: loopBlockName,
          blockId: blockId,
          blockType: 'loop',
          tags: contextualTags,
          distance: 0,
        }
      }
    } else if (containingLoop) {
      const [loopId, loop] = containingLoop
      containingLoopBlockId = loopId
      const loopType = loop.loopType || 'for'
      const contextualTags: string[] = ['index', 'currentIteration']
      if (loopType === 'forEach') {
        contextualTags.push('currentItem')
        contextualTags.push('items')
      }

      const containingLoopBlock = blocks[loopId]
      if (containingLoopBlock) {
        const loopBlockName = containingLoopBlock.name || containingLoopBlock.type

        loopBlockGroup = {
          blockName: loopBlockName,
          blockId: loopId,
          blockType: 'loop',
          tags: contextualTags,
          distance: 0,
        }
      }
    }

    let parallelBlockGroup: BlockTagGroup | null = null
    const containingParallel = Object.entries(parallels || {}).find(([_, parallel]) =>
      parallel.nodes.includes(blockId)
    )
    let containingParallelBlockId: string | null = null
    if (containingParallel) {
      const [parallelId, parallel] = containingParallel
      containingParallelBlockId = parallelId
      const parallelType = parallel.parallelType || 'count'
      const contextualTags: string[] = ['index']
      if (parallelType === 'collection') {
        contextualTags.push('currentItem')
        contextualTags.push('items')
      }

      const containingParallelBlock = blocks[parallelId]
      if (containingParallelBlock) {
        const parallelBlockName = containingParallelBlock.name || containingParallelBlock.type

        parallelBlockGroup = {
          blockName: parallelBlockName,
          blockId: parallelId,
          blockType: 'parallel',
          tags: contextualTags,
          distance: 0,
        }
      }
    }

    const blockTagGroups: BlockTagGroup[] = []
    const allBlockTags: string[] = []

    // Use the combinedAccessiblePrefixes to iterate through accessible blocks
    const accessibleBlockIds = combinedAccessiblePrefixes
      ? Array.from(combinedAccessiblePrefixes)
      : []
    for (const accessibleBlockId of accessibleBlockIds) {
      const accessibleBlock = blocks[accessibleBlockId]
      if (!accessibleBlock) continue

      // Skip the current block - blocks cannot reference their own outputs
      if (accessibleBlockId === blockId) continue

      const blockConfig = getBlock(accessibleBlock.type)

      if (!blockConfig) {
        if (accessibleBlock.type === 'loop' || accessibleBlock.type === 'parallel') {
          // Skip this block if it's the containing loop/parallel block - we'll handle it with contextual tags
          if (
            accessibleBlockId === containingLoopBlockId ||
            accessibleBlockId === containingParallelBlockId
          ) {
            continue
          }

          const mockConfig = {
            outputs: {
              results: 'array',
            },
          }
          const blockName = accessibleBlock.name || accessibleBlock.type
          const normalizedBlockName = normalizeBlockName(blockName)

          const outputPaths = generateOutputPaths(mockConfig.outputs)
          let blockTags = outputPaths.map((path) => `${normalizedBlockName}.${path}`)
          blockTags = ensureRootTag(blockTags, normalizedBlockName)

          blockTagGroups.push({
            blockName,
            blockId: accessibleBlockId,
            blockType: accessibleBlock.type,
            tags: blockTags,
            distance: blockDistances[accessibleBlockId] || 0,
          })

          allBlockTags.push(...blockTags)
        }
        continue
      }

      const blockName = accessibleBlock.name || accessibleBlock.type
      const normalizedBlockName = normalizeBlockName(blockName)

      const mergedSubBlocks = getMergedSubBlocks(accessibleBlockId)
      const responseFormatValue = mergedSubBlocks?.responseFormat?.value
      const responseFormat = parseResponseFormatSafely(responseFormatValue, accessibleBlockId)

      let blockTags: string[]

      // For trigger blocks, use the dynamic output helper
      if (blockConfig.category === 'triggers' || accessibleBlock.type === 'starter') {
        const dynamicOutputs = getBlockOutputPaths(accessibleBlock.type, mergedSubBlocks)

        if (dynamicOutputs.length > 0) {
          blockTags = dynamicOutputs.map((path) => `${normalizedBlockName}.${path}`)
        } else if (accessibleBlock.type === 'starter') {
          // Legacy starter block fallback
          const startWorkflowValue = mergedSubBlocks?.startWorkflow?.value
          if (startWorkflowValue === 'chat') {
            blockTags = [
              `${normalizedBlockName}.input`,
              `${normalizedBlockName}.conversationId`,
              `${normalizedBlockName}.files`,
            ]
          } else {
            blockTags = [normalizedBlockName]
          }
        } else if (accessibleBlock.type === 'generic_webhook') {
          blockTags = [normalizedBlockName]
        } else {
          blockTags = []
        }
      } else if (accessibleBlock.type === 'evaluator') {
        const metricsValue = getSubBlockValue(accessibleBlockId, 'metrics')

        if (metricsValue && Array.isArray(metricsValue) && metricsValue.length > 0) {
          const validMetrics = metricsValue.filter((metric: { name?: string }) => metric?.name)
          blockTags = validMetrics.map(
            (metric: { name: string }) => `${normalizedBlockName}.${metric.name.toLowerCase()}`
          )
        } else {
          const outputPaths = generateOutputPaths(blockConfig.outputs)
          blockTags = outputPaths.map((path) => `${normalizedBlockName}.${path}`)
        }
      } else if (accessibleBlock.type === 'variables') {
        // For variables block, show assigned variable names as outputs
        const variablesValue = getSubBlockValue(accessibleBlockId, 'variables')

        if (variablesValue && Array.isArray(variablesValue) && variablesValue.length > 0) {
          const validAssignments = variablesValue.filter((assignment: { variableName?: string }) =>
            assignment?.variableName?.trim()
          )
          blockTags = validAssignments.map(
            (assignment: { variableName: string }) =>
              `${normalizedBlockName}.${assignment.variableName.trim()}`
          )
        } else {
          blockTags = [normalizedBlockName]
        }
      } else if (responseFormat) {
        const schemaFields = extractFieldsFromSchema(responseFormat)
        if (schemaFields.length > 0) {
          blockTags = schemaFields.map((field) => `${normalizedBlockName}.${field.name}`)
        } else {
          const outputPaths = generateOutputPaths(blockConfig.outputs || {})
          blockTags = outputPaths.map((path) => `${normalizedBlockName}.${path}`)
        }
      } else if (!blockConfig.outputs || Object.keys(blockConfig.outputs).length === 0) {
        blockTags = [normalizedBlockName]
      } else {
        const blockState = blocks[accessibleBlockId]
        if (blockState?.triggerMode && blockConfig.triggers?.enabled) {
          // Use selected trigger (from subblocks) rather than defaulting to the first one
          const dynamicOutputs = getBlockOutputPaths(accessibleBlock.type, mergedSubBlocks, true)
          if (dynamicOutputs.length > 0) {
            blockTags = dynamicOutputs.map((path) => `${normalizedBlockName}.${path}`)
          } else {
            const outputPaths = generateOutputPaths(blockConfig.outputs || {})
            blockTags = outputPaths.map((path) => `${normalizedBlockName}.${path}`)
          }
        } else {
          // Check for tool-specific outputs first
          const operationValue =
            mergedSubBlocks?.operation?.value ?? getSubBlockValue(accessibleBlockId, 'operation')
          const toolOutputPaths = operationValue
            ? generateToolOutputPaths(blockConfig, operationValue)
            : []

          if (toolOutputPaths.length > 0) {
            blockTags = toolOutputPaths.map((path) => `${normalizedBlockName}.${path}`)
          } else {
            const outputPaths = generateOutputPaths(blockConfig.outputs || {})
            blockTags = outputPaths.map((path) => `${normalizedBlockName}.${path}`)
          }
        }
      }

      blockTags = ensureRootTag(blockTags, normalizedBlockName)
      const shouldShowRootTag = accessibleBlock.type === 'generic_webhook'
      if (!shouldShowRootTag) {
        blockTags = blockTags.filter((tag) => tag !== normalizedBlockName)
      }

      blockTagGroups.push({
        blockName,
        blockId: accessibleBlockId,
        blockType: accessibleBlock.type,
        tags: blockTags,
        distance: blockDistances[accessibleBlockId] || 0,
      })

      allBlockTags.push(...blockTags)
    }

    const finalBlockTagGroups: BlockTagGroup[] = []
    if (loopBlockGroup) {
      finalBlockTagGroups.push(loopBlockGroup)
    }
    if (parallelBlockGroup) {
      finalBlockTagGroups.push(parallelBlockGroup)
    }

    blockTagGroups.sort((a, b) => a.distance - b.distance)
    finalBlockTagGroups.push(...blockTagGroups)

    const contextualTags: string[] = []
    if (loopBlockGroup) {
      contextualTags.push(...loopBlockGroup.tags)
    }
    if (parallelBlockGroup) {
      contextualTags.push(...parallelBlockGroup.tags)
    }

    return {
      tags: [...allBlockTags, ...variableTags, ...contextualTags],
      variableInfoMap,
      blockTagGroups: finalBlockTagGroups,
    }
  }, [
    activeSourceBlockId,
    combinedAccessiblePrefixes,
    blockId,
    blocks,
    edges,
    getMergedSubBlocks,
    loops,
    parallels,
    workflowVariables,
    workflowId,
  ])

  const filteredTags = useMemo(() => {
    if (!searchTerm) return tags
    return tags.filter((tag) => tag.toLowerCase().includes(searchTerm))
  }, [tags, searchTerm])

  const { variableTags, filteredBlockTagGroups } = useMemo(() => {
    const varTags: string[] = []

    filteredTags.forEach((tag: string) => {
      if (tag.startsWith(TAG_PREFIXES.VARIABLE)) {
        varTags.push(tag)
      }
    })

    const filteredBlockTagGroups = computedBlockTagGroups
      .map((group: BlockTagGroup) => ({
        ...group,
        tags: group.tags.filter(
          (tag: string) => !searchTerm || tag.toLowerCase().includes(searchTerm)
        ),
      }))
      .filter((group: BlockTagGroup) => group.tags.length > 0)

    return {
      variableTags: varTags,
      filteredBlockTagGroups,
    }
  }, [filteredTags, computedBlockTagGroups, searchTerm])

  const nestedBlockTagGroups: NestedBlockTagGroup[] = useMemo(() => {
    return filteredBlockTagGroups.map((group: BlockTagGroup) => {
      const nestedTags: Array<{
        key: string
        display: string
        fullTag?: string
        children?: Array<{ key: string; display: string; fullTag: string }>
      }> = []

      const groupedTags: Record<
        string,
        Array<{ key: string; display: string; fullTag: string }>
      > = {}
      const directTags: Array<{ key: string; display: string; fullTag: string }> = []

      group.tags.forEach((tag: string) => {
        const tagParts = tag.split('.')
        if (tagParts.length >= 3) {
          const parent = tagParts[1]
          const child = tagParts.slice(2).join('.')

          if (!groupedTags[parent]) {
            groupedTags[parent] = []
          }
          groupedTags[parent].push({
            key: `${parent}.${child}`,
            display: child,
            fullTag: tag,
          })
        } else {
          const path = tagParts.slice(1).join('.')
          // Handle contextual tags for loop/parallel blocks (single words like 'index', 'currentItem')
          if (
            (group.blockType === 'loop' || group.blockType === 'parallel') &&
            tagParts.length === 1
          ) {
            directTags.push({
              key: tag,
              display: tag,
              fullTag: tag,
            })
          } else {
            directTags.push({
              key: path || group.blockName,
              display: path || group.blockName,
              fullTag: tag,
            })
          }
        }
      })

      Object.entries(groupedTags).forEach(([parent, children]) => {
        nestedTags.push({
          key: parent,
          display: parent,
          children: children,
        })
      })

      directTags.forEach((directTag) => {
        nestedTags.push(directTag)
      })

      return {
        ...group,
        nestedTags,
      }
    })
  }, [filteredBlockTagGroups])

  const orderedTags = useMemo(() => {
    const visualTags: string[] = []

    visualTags.push(...variableTags)

    nestedBlockTagGroups.forEach((group: NestedBlockTagGroup) => {
      group.nestedTags.forEach((nestedTag: any) => {
        if (nestedTag.children && nestedTag.children.length > 0) {
          const firstChild = nestedTag.children[0]
          if (firstChild.fullTag) {
            visualTags.push(firstChild.fullTag)
          }
        } else if (nestedTag.fullTag) {
          visualTags.push(nestedTag.fullTag)
        }
      })
    })

    return visualTags
  }, [variableTags, nestedBlockTagGroups])

  const tagIndexMap = useMemo(() => {
    const map = new Map<string, number>()
    orderedTags.forEach((tag, index) => {
      map.set(tag, index)
    })
    return map
  }, [orderedTags])

  const handleTagSelect = useCallback(
    (tag: string, blockGroup?: BlockTagGroup) => {
      // Use the live DOM selection/value if available to avoid off-by-one state
      // when users type and immediately confirm a selection.
      let liveCursor = cursorPosition
      let liveValue = inputValue

      if (typeof window !== 'undefined' && document?.activeElement) {
        const activeEl = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null
        if (activeEl && typeof activeEl.selectionStart === 'number') {
          liveCursor = activeEl.selectionStart ?? cursorPosition
          // Prefer the active element value if present. This ensures we include the most
          // recently typed character(s) that might not yet be reflected in React state.
          if ('value' in activeEl && typeof activeEl.value === 'string') {
            liveValue = activeEl.value
          }
        }
      }

      const textBeforeCursor = liveValue.slice(0, liveCursor)
      const textAfterCursor = liveValue.slice(liveCursor)

      const lastOpenBracket = textBeforeCursor.lastIndexOf('<')
      if (lastOpenBracket === -1) return

      let processedTag = tag

      // Check if this is a file property and add [0] automatically
      const fileProperties = ['url', 'name', 'size', 'type', 'key', 'uploadedAt', 'expiresAt']
      const parts = tag.split('.')
      if (parts.length >= 2 && fileProperties.includes(parts[parts.length - 1])) {
        const fieldName = parts[parts.length - 2]

        if (blockGroup) {
          const block = useWorkflowStore.getState().blocks[blockGroup.blockId]
          const blockConfig = block ? (getBlock(block.type) ?? null) : null
          const mergedSubBlocks = getMergedSubBlocks(blockGroup.blockId)

          const fieldType = getOutputTypeForPath(
            block,
            blockConfig,
            blockGroup.blockId,
            fieldName,
            mergedSubBlocks
          )

          if (fieldType === 'files') {
            const blockAndField = parts.slice(0, -1).join('.')
            const property = parts[parts.length - 1]
            processedTag = `${blockAndField}[0].${property}`
          }
        }
      }

      if (tag.startsWith(TAG_PREFIXES.VARIABLE)) {
        const variableName = tag.substring(TAG_PREFIXES.VARIABLE.length)
        const variableObj = workflowVariables.find(
          (v: Variable) => v.name.replace(/\s+/g, '') === variableName
        )

        if (variableObj) {
          processedTag = tag
        }
      } else if (
        blockGroup &&
        (blockGroup.blockType === 'loop' || blockGroup.blockType === 'parallel')
      ) {
        if (!tag.includes('.') && ['index', 'currentItem', 'items'].includes(tag)) {
          processedTag = `${blockGroup.blockType}.${tag}`
        } else {
          processedTag = tag
        }
      }

      const nextCloseBracket = textAfterCursor.indexOf('>')
      let remainingTextAfterCursor = textAfterCursor

      if (nextCloseBracket !== -1) {
        const textBetween = textAfterCursor.slice(0, nextCloseBracket)
        if (/^[a-zA-Z0-9._]*$/.test(textBetween)) {
          remainingTextAfterCursor = textAfterCursor.slice(nextCloseBracket + 1)
        }
      }

      const newValue = `${textBeforeCursor.slice(0, lastOpenBracket)}<${processedTag}>${remainingTextAfterCursor}`

      onSelect(newValue)
      onClose?.()
    },
    [inputValue, cursorPosition, workflowVariables, onSelect, onClose]
  )

  useEffect(() => setSelectedIndex(0), [searchTerm])

  useEffect(() => {
    if (selectedIndex >= orderedTags.length) {
      setSelectedIndex(Math.max(0, orderedTags.length - 1))
    }
  }, [orderedTags.length, selectedIndex])

  // Close on outside click/touch when dropdown is visible
  useEffect(() => {
    if (!visible) return

    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      const el = containerRef.current
      if (!el) return
      const target = e.target as Node
      if (!el.contains(target)) {
        onClose?.()
      }
    }

    // Use capture phase to detect before child handlers potentially stop propagation
    document.addEventListener('mousedown', handlePointerDown, true)
    document.addEventListener('touchstart', handlePointerDown, true)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true)
      document.removeEventListener('touchstart', handlePointerDown, true)
    }
  }, [visible, onClose])

  useEffect(() => {
    if (visible) {
      const handleKeyboardEvent = (e: KeyboardEvent) => {
        if (!orderedTags.length) return

        const canEnterSubmenuForSelected = (): {
          groupIndex: number
          nestedTagIndex: number
        } | null => {
          if (selectedIndex < 0 || selectedIndex >= orderedTags.length) return null
          const selectedTag = orderedTags[selectedIndex]
          for (let gi = 0; gi < nestedBlockTagGroups.length; gi++) {
            const group = nestedBlockTagGroups[gi]!
            for (let ni = 0; ni < group.nestedTags.length; ni++) {
              const nestedTag = group.nestedTags[ni]
              if (nestedTag.children && nestedTag.children.length > 0) {
                const firstChild = nestedTag.children[0]
                if (firstChild.fullTag === selectedTag) {
                  return { groupIndex: gi, nestedTagIndex: ni }
                }
              }
            }
          }
          return null
        }

        if (inSubmenu) {
          const currentHovered = hoveredNested
          if (!currentHovered) {
            setInSubmenu(false)
            return
          }

          const currentGroup = nestedBlockTagGroups.find((group: NestedBlockTagGroup) => {
            return group.nestedTags.some(
              (tag: any, index: number) =>
                `${group.blockId}-${tag.key}` === currentHovered.tag &&
                index === currentHovered.index
            )
          })

          const currentNestedTag = currentGroup?.nestedTags.find(
            (tag: any, index: number) =>
              `${currentGroup.blockId}-${tag.key}` === currentHovered.tag &&
              index === currentHovered.index
          )

          const children = currentNestedTag?.children || []

          switch (e.key) {
            case 'ArrowDown':
              e.preventDefault()
              e.stopPropagation()
              setSubmenuIndex((prev) => Math.min(prev + 1, children.length - 1))
              break
            case 'ArrowUp':
              e.preventDefault()
              e.stopPropagation()
              setSubmenuIndex((prev) => Math.max(prev - 1, 0))
              break
            case 'ArrowLeft':
              e.preventDefault()
              e.stopPropagation()
              setInSubmenu(false)
              setHoveredNested(null)
              setSubmenuIndex(0)
              break
            case 'Enter':
              e.preventDefault()
              e.stopPropagation()
              if (submenuIndex >= 0 && submenuIndex < children.length) {
                const selectedChild = children[submenuIndex] as any
                handleTagSelect(selectedChild.fullTag, currentGroup as BlockTagGroup | undefined)
              }
              break
            case 'Escape':
              e.preventDefault()
              e.stopPropagation()
              setInSubmenu(false)
              setHoveredNested(null)
              setSubmenuIndex(0)
              break
          }
        } else {
          switch (e.key) {
            case 'ArrowDown':
              e.preventDefault()
              e.stopPropagation()
              setSelectedIndex((prev) => {
                const newIndex = Math.min(prev + 1, orderedTags.length - 1)
                const newSelectedTag = orderedTags[newIndex]
                let foundParent = false
                for (const group of nestedBlockTagGroups) {
                  for (
                    let nestedTagIndex = 0;
                    nestedTagIndex < group.nestedTags.length;
                    nestedTagIndex++
                  ) {
                    const nestedTag = group.nestedTags[nestedTagIndex]
                    if (nestedTag.children && nestedTag.children.length > 0) {
                      const firstChild = nestedTag.children[0]
                      if (firstChild.fullTag === newSelectedTag) {
                        setHoveredNested({
                          tag: `${group.blockId}-${nestedTag.key}`,
                          index: nestedTagIndex,
                        })
                        foundParent = true
                        break
                      }
                    }
                  }
                  if (foundParent) break
                }
                if (!foundParent && !inSubmenu) {
                  setHoveredNested(null)
                }
                return newIndex
              })
              break
            case 'ArrowUp':
              e.preventDefault()
              e.stopPropagation()
              setSelectedIndex((prev) => {
                const newIndex = Math.max(prev - 1, 0)
                const newSelectedTag = orderedTags[newIndex]
                let foundParent = false
                for (const group of nestedBlockTagGroups) {
                  for (
                    let nestedTagIndex = 0;
                    nestedTagIndex < group.nestedTags.length;
                    nestedTagIndex++
                  ) {
                    const nestedTag = group.nestedTags[nestedTagIndex]
                    if (nestedTag.children && nestedTag.children.length > 0) {
                      const firstChild = nestedTag.children[0]
                      if (firstChild.fullTag === newSelectedTag) {
                        setHoveredNested({
                          tag: `${group.blockId}-${nestedTag.key}`,
                          index: nestedTagIndex,
                        })
                        foundParent = true
                        break
                      }
                    }
                  }
                  if (foundParent) break
                }
                if (!foundParent && !inSubmenu) {
                  setHoveredNested(null)
                }
                return newIndex
              })
              break
            case 'ArrowRight':
              {
                const targetLocation = canEnterSubmenuForSelected()
                if (!targetLocation) {
                  // No submenu action for current selection; allow caret move
                  return
                }
                e.preventDefault()
                e.stopPropagation()
                const group = nestedBlockTagGroups[targetLocation.groupIndex]
                const nestedTag = group.nestedTags[targetLocation.nestedTagIndex]
                setInSubmenu(true)
                setSubmenuIndex(0)
                setHoveredNested({
                  tag: `${group.blockId}-${nestedTag.key}`,
                  index: targetLocation.nestedTagIndex,
                })
              }
              break
            case 'Enter':
              e.preventDefault()
              e.stopPropagation()
              if (selectedIndex >= 0 && selectedIndex < orderedTags.length) {
                const selectedTag = orderedTags[selectedIndex]

                let isParentItem = false
                let parentTag = ''
                let parentGroup: BlockTagGroup | undefined

                for (const group of nestedBlockTagGroups) {
                  for (const nestedTag of group.nestedTags) {
                    if (nestedTag.children && nestedTag.children.length > 0) {
                      const firstChild = nestedTag.children[0]
                      if (firstChild.fullTag === selectedTag) {
                        isParentItem = true
                        parentTag = `${normalizeBlockName(group.blockName)}.${nestedTag.key}`
                        parentGroup = group
                        break
                      }
                    }
                  }
                  if (isParentItem) break
                }

                if (isParentItem && parentTag) {
                  handleTagSelect(parentTag, parentGroup)
                } else {
                  const belongsToGroup = filteredBlockTagGroups.find((group) =>
                    group.tags.includes(selectedTag)
                  )
                  handleTagSelect(selectedTag, belongsToGroup)
                }
              }
              break
            case 'Escape':
              e.preventDefault()
              e.stopPropagation()
              onClose?.()
              break
          }
        }
      }

      window.addEventListener('keydown', handleKeyboardEvent, true)
      return () => window.removeEventListener('keydown', handleKeyboardEvent, true)
    }
  }, [
    visible,
    selectedIndex,
    orderedTags,
    filteredBlockTagGroups,
    nestedBlockTagGroups,
    handleTagSelect,
    onClose,
    inSubmenu,
    submenuIndex,
    hoveredNested,
  ])

  if (!visible || tags.length === 0 || orderedTags.length === 0) return null

  return (
    <div
      ref={containerRef}
      className={cn(
        'absolute z-[9999] mt-1 w-full overflow-visible rounded-md border bg-popover shadow-md',
        className
      )}
      style={style}
    >
      <div className='py-1'>
        {orderedTags.length === 0 ? (
          <div className='px-3 py-2 text-muted-foreground text-sm'>No matching tags found</div>
        ) : (
          <>
            {/* Variables section */}
            {variableTags.length > 0 && (
              <>
                <div className='px-2 pt-2.5 pb-0.5 font-medium text-muted-foreground text-xs'>
                  Variables
                </div>
                <div className='-mx-1 -px-1'>
                  {variableTags.map((tag: string) => {
                    const variableInfo = variableInfoMap?.[tag] || null
                    const tagIndex = tagIndexMap.get(tag) ?? -1

                    return (
                      <button
                        key={tag}
                        className={cn(
                          'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm',
                          'hover:bg-accent hover:text-accent-foreground',
                          'focus:bg-accent focus:text-accent-foreground focus:outline-none',
                          tagIndex === selectedIndex &&
                            tagIndex >= 0 &&
                            'bg-accent text-accent-foreground'
                        )}
                        {...createTagEventHandlers(
                          tag,
                          undefined,
                          tagIndex,
                          handleTagSelect,
                          setSelectedIndex,
                          setHoveredNested
                        )}
                      >
                        <div
                          className='flex h-5 w-5 items-center justify-center rounded'
                          style={{ backgroundColor: BLOCK_COLORS.VARIABLE }}
                        >
                          <span className='h-3 w-3 font-bold text-white text-xs'>V</span>
                        </div>
                        <span className='flex-1 truncate'>
                          {tag.startsWith(TAG_PREFIXES.VARIABLE)
                            ? tag.substring(TAG_PREFIXES.VARIABLE.length)
                            : tag}
                        </span>
                        {variableInfo && (
                          <span className='ml-auto text-muted-foreground text-xs'>
                            {variableInfo.type}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              </>
            )}

            {/* Block sections with nested structure */}
            {nestedBlockTagGroups.length > 0 && (
              <>
                {variableTags.length > 0 && <div className='my-0' />}
                {nestedBlockTagGroups.map((group: NestedBlockTagGroup) => {
                  const blockConfig = getBlock(group.blockType)
                  let blockColor = blockConfig?.bgColor || BLOCK_COLORS.DEFAULT

                  if (group.blockType === 'loop') {
                    blockColor = BLOCK_COLORS.LOOP
                  } else if (group.blockType === 'parallel') {
                    blockColor = BLOCK_COLORS.PARALLEL
                  }

                  return (
                    <div key={group.blockId} className='relative'>
                      <div className='border-t px-2 pt-1.5 pb-0.5 font-medium text-muted-foreground text-xs first:border-t-0'>
                        {group.blockName}
                      </div>
                      <div>
                        {group.nestedTags.map((nestedTag: any, index: number) => {
                          const tagIndex = nestedTag.fullTag
                            ? (tagIndexMap.get(nestedTag.fullTag) ?? -1)
                            : -1
                          const hasChildren = nestedTag.children && nestedTag.children.length > 0
                          const isHovered =
                            hoveredNested?.tag === `${group.blockId}-${nestedTag.key}` &&
                            hoveredNested?.index === index

                          const displayText = nestedTag.display
                          let tagDescription = ''
                          let tagIcon = group.blockName.charAt(0).toUpperCase()

                          if (
                            (group.blockType === 'loop' || group.blockType === 'parallel') &&
                            !nestedTag.key.includes('.')
                          ) {
                            if (nestedTag.key === 'index') {
                              tagIcon = '#'
                              tagDescription = 'number'
                            } else if (nestedTag.key === 'currentItem') {
                              tagIcon = 'i'
                              tagDescription = 'any'
                            } else if (nestedTag.key === 'items') {
                              tagIcon = 'I'
                              tagDescription = 'array'
                            }
                          } else {
                            if (nestedTag.fullTag) {
                              const tagParts = nestedTag.fullTag.split('.')
                              const outputPath = tagParts.slice(1).join('.')

                              const block = Object.values(blocks).find(
                                (b) => b.id === group.blockId
                              )
                              if (block) {
                                const blockConfig = getBlock(block.type)
                                const mergedSubBlocks = getMergedSubBlocks(group.blockId)

                                tagDescription = getOutputTypeForPath(
                                  block,
                                  blockConfig || null,
                                  group.blockId,
                                  outputPath,
                                  mergedSubBlocks
                                )
                              }
                            }
                          }

                          const isKeyboardSelected = (() => {
                            if (
                              hasChildren &&
                              selectedIndex >= 0 &&
                              selectedIndex < orderedTags.length
                            ) {
                              const selectedTag = orderedTags[selectedIndex]
                              const firstChild = nestedTag.children?.[0]
                              return firstChild?.fullTag === selectedTag
                            }
                            return tagIndex === selectedIndex && tagIndex >= 0
                          })()

                          return (
                            <div
                              key={`${group.blockId}-${nestedTag.key}-${index}`}
                              className='relative'
                            >
                              <button
                                className={cn(
                                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm',
                                  'hover:bg-accent hover:text-accent-foreground',
                                  'focus:bg-accent focus:text-accent-foreground focus:outline-none',
                                  isKeyboardSelected && 'bg-accent text-accent-foreground'
                                )}
                                onMouseEnter={() => {
                                  if (tagIndex >= 0) {
                                    setSelectedIndex(tagIndex)
                                  }

                                  if (hasChildren) {
                                    const parentKey = `${group.blockId}-${nestedTag.key}`
                                    setParentHovered(parentKey)
                                    setHoveredNested({
                                      tag: parentKey,
                                      index,
                                    })
                                  }
                                }}
                                onMouseLeave={() => {
                                  if (hasChildren) {
                                    setParentHovered(null)
                                    // Only hide submenu if not hovering over submenu
                                    if (!submenuHovered) {
                                      setHoveredNested(null)
                                    }
                                  }
                                }}
                                onMouseDown={(e) => {
                                  if (nestedTag.fullTag) {
                                    e.preventDefault()
                                    e.stopPropagation()
                                    handleTagSelect(nestedTag.fullTag, group)
                                  } else if (hasChildren) {
                                    e.preventDefault()
                                    e.stopPropagation()
                                    const parentTag = `${normalizeBlockName(group.blockName)}.${nestedTag.key}`
                                    handleTagSelect(parentTag, group)
                                  }
                                }}
                                onClick={(e) => {
                                  if (nestedTag.fullTag) {
                                    e.preventDefault()
                                    e.stopPropagation()
                                    handleTagSelect(nestedTag.fullTag, group)
                                  } else if (hasChildren) {
                                    e.preventDefault()
                                    e.stopPropagation()
                                    const parentTag = `${normalizeBlockName(group.blockName)}.${nestedTag.key}`
                                    handleTagSelect(parentTag, group)
                                  }
                                }}
                                disabled={false}
                              >
                                <div
                                  className='flex h-5 w-5 flex-shrink-0 items-center justify-center rounded'
                                  style={{ backgroundColor: blockColor }}
                                >
                                  <span className='h-3 w-3 font-bold text-white text-xs'>
                                    {tagIcon}
                                  </span>
                                </div>
                                <span className='flex-1 truncate'>{displayText}</span>
                                {hasChildren && (
                                  <ChevronRight className='h-4 w-4 text-muted-foreground' />
                                )}
                                {tagDescription && tagDescription !== 'any' && !hasChildren && (
                                  <span className='ml-auto text-muted-foreground text-xs'>
                                    {tagDescription}
                                  </span>
                                )}
                              </button>

                              {/* Nested submenu */}
                              {hasChildren && isHovered && (
                                <div
                                  className='absolute top-0 left-full z-[10000] ml-0.5 min-w-[200px] max-w-[300px] rounded-md border border-border bg-background shadow-lg'
                                  onMouseEnter={() => {
                                    setSubmenuHovered(true)
                                    const parentKey = `${group.blockId}-${nestedTag.key}`
                                    setHoveredNested({
                                      tag: parentKey,
                                      index,
                                    })
                                    setSubmenuIndex(-1)
                                  }}
                                  onMouseLeave={() => {
                                    setSubmenuHovered(false)
                                    const parentKey = `${group.blockId}-${nestedTag.key}`
                                    if (parentHovered !== parentKey) {
                                      setHoveredNested(null)
                                    }
                                  }}
                                >
                                  <div className='py-1'>
                                    {nestedTag.children!.map((child: any, childIndex: number) => {
                                      const isKeyboardSelected =
                                        inSubmenu && submenuIndex === childIndex
                                      const isSelected = isKeyboardSelected

                                      let childType = ''
                                      const childTagParts = child.fullTag.split('.')
                                      const childOutputPath = childTagParts.slice(1).join('.')

                                      const block = Object.values(blocks).find(
                                        (b) => b.id === group.blockId
                                      )
                                      if (block) {
                                        const blockConfig = getBlock(block.type)
                                        const mergedSubBlocks = getMergedSubBlocks(group.blockId)

                                        childType = getOutputTypeForPath(
                                          block,
                                          blockConfig || null,
                                          group.blockId,
                                          childOutputPath,
                                          mergedSubBlocks
                                        )
                                      }

                                      return (
                                        <button
                                          key={child.key}
                                          className={cn(
                                            'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm',
                                            'focus:bg-accent focus:text-accent-foreground focus:outline-none',
                                            'transition-colors duration-150',
                                            isSelected
                                              ? 'bg-accent text-accent-foreground'
                                              : 'hover:bg-accent hover:text-accent-foreground'
                                          )}
                                          onMouseEnter={() => {
                                            setSubmenuIndex(childIndex)
                                            setInSubmenu(true)
                                          }}
                                          onMouseDown={(e) => {
                                            e.preventDefault()
                                            e.stopPropagation()
                                            handleTagSelect(child.fullTag, group)
                                            setHoveredNested(null)
                                          }}
                                          onClick={(e) => {
                                            e.preventDefault()
                                            e.stopPropagation()
                                            handleTagSelect(child.fullTag, group)
                                            setHoveredNested(null)
                                          }}
                                        >
                                          <div
                                            className='flex h-5 w-5 flex-shrink-0 items-center justify-center rounded'
                                            style={{ backgroundColor: blockColor }}
                                          >
                                            <span className='h-3 w-3 font-bold text-white text-xs'>
                                              {group.blockName.charAt(0).toUpperCase()}
                                            </span>
                                          </div>
                                          <span className='flex-1 truncate'>{child.display}</span>
                                          {childType && childType !== 'any' && (
                                            <span className='ml-auto text-muted-foreground text-xs'>
                                              {childType}
                                            </span>
                                          )}
                                        </button>
                                      )
                                    })}
                                  </div>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
