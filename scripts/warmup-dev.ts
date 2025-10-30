#!/usr/bin/env bun
/**
 * Development Server Warmup Script
 * 
 * This script triggers compilation of key routes after the dev server starts
 * to reduce first-load latency. Run this after starting `bun run dev` to
 * pre-compile frequently accessed routes.
 * 
 * Usage: bun run scripts/warmup-dev.ts
 */

const BASE_URL = process.env.WARMUP_BASE_URL || 'http://localhost:3000'
const TIMEOUT_MS = 60000 // 60 seconds per route

// Key routes to pre-compile in development mode
const ROUTES_TO_WARMUP = [
  // Auth routes
  '/api/auth/get-session',
  
  // Core API routes
  '/api/workspaces',
  '/api/environment',
  
  // Provider routes (will trigger model loading)
  '/api/providers/base/models',
  '/api/providers/ollama/models',
  '/api/providers/openrouter/models',
  
  // Main pages (will trigger page compilation)
  '/workspace',
]

interface WarmupResult {
  route: string
  status: number | 'timeout' | 'error'
  duration: number
  error?: string
}

async function warmupRoute(route: string): Promise<WarmupResult> {
  const startTime = Date.now()
  const url = `${BASE_URL}${route}`
  
  try {
    console.log(`[WARMUP] Requesting ${route}...`)
    
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS)
    
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'dev-warmup-script',
      },
    })
    
    clearTimeout(timeoutId)
    
    const duration = Date.now() - startTime
    const status = response.status
    
    console.log(`[WARMUP] ✓ ${route} - ${status} (${duration}ms)`)
    
    return { route, status, duration }
  } catch (error: any) {
    const duration = Date.now() - startTime
    
    if (error.name === 'AbortError') {
      console.log(`[WARMUP] ✗ ${route} - timeout after ${duration}ms`)
      return { route, status: 'timeout', duration, error: 'Request timeout' }
    }
    
    console.log(`[WARMUP] ✗ ${route} - error: ${error.message}`)
    return { route, status: 'error', duration, error: error.message }
  }
}

async function warmupAll() {
  console.log(`\n🔥 Starting dev server warmup for ${BASE_URL}\n`)
  console.log(`Will pre-compile ${ROUTES_TO_WARMUP.length} routes...\n`)
  
  const results: WarmupResult[] = []
  const startTime = Date.now()
  
  // Warm up routes sequentially to avoid overwhelming the server
  for (const route of ROUTES_TO_WARMUP) {
    const result = await warmupRoute(route)
    results.push(result)
    
    // Small delay between requests
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  
  const totalDuration = Date.now() - startTime
  
  // Summary
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`📊 Warmup Summary`)
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  
  const successful = results.filter(r => typeof r.status === 'number' && r.status < 400)
  const failed = results.filter(r => r.status === 'error')
  const timedOut = results.filter(r => r.status === 'timeout')
  
  console.log(`✓ Successful: ${successful.length}`)
  console.log(`✗ Failed: ${failed.length}`)
  console.log(`⏱ Timed out: ${timedOut.length}`)
  console.log(`⏰ Total time: ${(totalDuration / 1000).toFixed(2)}s`)
  
  if (failed.length > 0) {
    console.log(`\nFailed routes:`)
    for (const result of failed) {
      console.log(`  - ${result.route}: ${result.error}`)
    }
  }
  
  if (timedOut.length > 0) {
    console.log(`\nTimed out routes (may still be compiling):`)
    for (const result of timedOut) {
      console.log(`  - ${result.route}`)
    }
  }
  
  console.log(`\n✨ Warmup complete! Dev server should now be faster.\n`)
}

// Run warmup
warmupAll().catch(error => {
  console.error('Warmup script failed:', error)
  process.exit(1)
})

