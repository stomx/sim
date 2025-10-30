import { toNextJsHandler } from 'better-auth/next-js'
import { auth } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// Increase timeout for auth operations (database queries, OAuth, etc.)
// Default is 10s, we increase to 60s to handle slow database connections
export const maxDuration = 60

export const { GET, POST } = toNextJsHandler(auth.handler)
