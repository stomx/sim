import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export * from './schema'

const connectionString = process.env.DATABASE_URL!
if (!connectionString) {
  throw new Error('Missing DATABASE_URL environment variable')
}

const postgresClient = postgres(connectionString, {
  prepare: false,
  idle_timeout: 20,
  connect_timeout: 60, // Increased from 30 to handle slow network/remote DB
  max: 30,
  max_lifetime: 60 * 30, // 30 minutes - close connections that are open too long
  onnotice: () => {},
})

export const db = drizzle(postgresClient, { schema })
