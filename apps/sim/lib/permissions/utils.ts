import { db } from '@sim/db'
import { permissions, type permissionTypeEnum, user, workspace } from '@sim/db/schema'
import { and, eq } from 'drizzle-orm'
import { getRedisClient } from '@/lib/redis'
import { createLogger } from '@/lib/logs/console/logger'

const logger = createLogger('PermissionsUtils')

export type PermissionType = (typeof permissionTypeEnum.enumValues)[number]

/**
 * Get the highest permission level a user has for a specific entity
 * Uses Redis caching with 60 second TTL to reduce database load
 *
 * @param userId - The ID of the user to check permissions for
 * @param entityType - The type of entity (e.g., 'workspace', 'workflow', etc.)
 * @param entityId - The ID of the specific entity
 * @returns Promise<PermissionType | null> - The highest permission the user has for the entity, or null if none
 */
export async function getUserEntityPermissions(
  userId: string,
  entityType: string,
  entityId: string
): Promise<PermissionType | null> {
  const cacheKey = `perm:${userId}:${entityType}:${entityId}`

  try {
    // Try to get from Redis cache first
    const redis = getRedisClient()
    if (redis) {
      const cached = await redis.get(cacheKey)
      if (cached !== null) {
        logger.debug('Permission cache hit', { userId, entityType, entityId })
        return cached === 'null' ? null : (cached as PermissionType)
      }
    }
  } catch (error) {
    // If Redis fails, continue with database query
    logger.warn('Redis cache read failed, falling back to database', { error })
  }

  // Query database
  const result = await db
    .select({ permissionType: permissions.permissionType })
    .from(permissions)
    .where(
      and(
        eq(permissions.userId, userId),
        eq(permissions.entityType, entityType),
        eq(permissions.entityId, entityId)
      )
    )

  let permission: PermissionType | null = null

  if (result.length > 0) {
    const permissionOrder: Record<PermissionType, number> = { admin: 3, write: 2, read: 1 }
    const highestPermission = result.reduce((highest, current) => {
      return permissionOrder[current.permissionType] > permissionOrder[highest.permissionType]
        ? current
        : highest
    })
    permission = highestPermission.permissionType
  }

  // Cache the result for 60 seconds
  try {
    const redis = getRedisClient()
    if (redis) {
      const cacheValue = permission === null ? 'null' : permission
      await redis.setex(cacheKey, 60, cacheValue)
      logger.debug('Permission cached', { userId, entityType, entityId, permission })
    }
  } catch (error) {
    // If Redis fails, log but don't fail the request
    logger.warn('Redis cache write failed', { error })
  }

  return permission
}

/**
 * Check if a user has admin permission for a specific workspace
 *
 * @param userId - The ID of the user to check
 * @param workspaceId - The ID of the workspace to check
 * @returns Promise<boolean> - True if the user has admin permission for the workspace, false otherwise
 */
export async function hasAdminPermission(userId: string, workspaceId: string): Promise<boolean> {
  const result = await db
    .select({ id: permissions.id })
    .from(permissions)
    .where(
      and(
        eq(permissions.userId, userId),
        eq(permissions.entityType, 'workspace'),
        eq(permissions.entityId, workspaceId),
        eq(permissions.permissionType, 'admin')
      )
    )
    .limit(1)

  return result.length > 0
}

/**
 * Retrieves a list of users with their associated permissions for a given workspace.
 *
 * @param workspaceId - The ID of the workspace to retrieve user permissions for.
 * @returns A promise that resolves to an array of user objects, each containing user details and their permission type.
 */
export async function getUsersWithPermissions(workspaceId: string): Promise<
  Array<{
    userId: string
    email: string
    name: string
    permissionType: PermissionType
  }>
> {
  const usersWithPermissions = await db
    .select({
      userId: user.id,
      email: user.email,
      name: user.name,
      permissionType: permissions.permissionType,
    })
    .from(permissions)
    .innerJoin(user, eq(permissions.userId, user.id))
    .where(and(eq(permissions.entityType, 'workspace'), eq(permissions.entityId, workspaceId)))
    .orderBy(user.email)

  return usersWithPermissions.map((row) => ({
    userId: row.userId,
    email: row.email,
    name: row.name,
    permissionType: row.permissionType,
  }))
}

/**
 * Check if a user has admin access to a specific workspace
 *
 * @param userId - The ID of the user to check
 * @param workspaceId - The ID of the workspace to check
 * @returns Promise<boolean> - True if the user has admin access to the workspace, false otherwise
 */
export async function hasWorkspaceAdminAccess(
  userId: string,
  workspaceId: string
): Promise<boolean> {
  const workspaceResult = await db
    .select({ ownerId: workspace.ownerId })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .limit(1)

  if (workspaceResult.length === 0) {
    return false
  }

  if (workspaceResult[0].ownerId === userId) {
    return true
  }

  return await hasAdminPermission(userId, workspaceId)
}

/**
 * Get a list of workspaces that the user has access to
 *
 * @param userId - The ID of the user to check
 * @returns Promise<Array<{
 *   id: string
 *   name: string
 *   ownerId: string
 *   accessType: 'direct' | 'owner'
 * }>> - A list of workspaces that the user has access to
 */
export async function getManageableWorkspaces(userId: string): Promise<
  Array<{
    id: string
    name: string
    ownerId: string
    accessType: 'direct' | 'owner'
  }>
> {
  const ownedWorkspaces = await db
    .select({
      id: workspace.id,
      name: workspace.name,
      ownerId: workspace.ownerId,
    })
    .from(workspace)
    .where(eq(workspace.ownerId, userId))

  const adminWorkspaces = await db
    .select({
      id: workspace.id,
      name: workspace.name,
      ownerId: workspace.ownerId,
    })
    .from(workspace)
    .innerJoin(permissions, eq(permissions.entityId, workspace.id))
    .where(
      and(
        eq(permissions.userId, userId),
        eq(permissions.entityType, 'workspace'),
        eq(permissions.permissionType, 'admin')
      )
    )

  const ownedSet = new Set(ownedWorkspaces.map((w) => w.id))
  const combined = [
    ...ownedWorkspaces.map((ws) => ({ ...ws, accessType: 'owner' as const })),
    ...adminWorkspaces
      .filter((ws) => !ownedSet.has(ws.id))
      .map((ws) => ({ ...ws, accessType: 'direct' as const })),
  ]

  return combined
}
