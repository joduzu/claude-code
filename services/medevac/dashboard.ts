/**
 * Medevac IPC — Terminal Dashboard
 *
 * Real-time metrics display for terminal/edge-node environments.
 * Polls the local HTTP server and renders a text dashboard using ANSI codes.
 * No external dependencies — pure Node.js.
 *
 * Usage (standalone):
 *   node --import tsx services/medevac/dashboard.ts --url http://localhost:3737
 *
 * Usage (programmatic):
 *   import { startDashboard } from './services/medevac/dashboard.js'
 *   startDashboard({ serverUrl: 'http://localhost:3737', intervalMs: 5000 })
 */

import type { SimulationMetrics } from './schemas.js'

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const ANSI = {
  clear: '\x1b[2J\x1b[H',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  dim: '\x1b[2m',
}

function c(color: keyof typeof ANSI, text: string): string {
  return `${ANSI[color]}${text}${ANSI.reset}`
}

function bold(text: string): string {
  return `${ANSI.bold}${text}${ANSI.reset}`
}

// ---------------------------------------------------------------------------
// Health / metrics fetching
// ---------------------------------------------------------------------------

interface HealthResponse {
  status: string
  simulation_id: string
  events_stored: number
  started_at: string
  uptime_seconds: number
}

async function fetchHealth(serverUrl: string): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`${serverUrl}/health`)
    if (!res.ok) return null
    return (await res.json()) as HealthResponse
  } catch {
    return null
  }
}

async function fetchMetrics(serverUrl: string): Promise<SimulationMetrics | null> {
  try {
    const res = await fetch(`${serverUrl}/metrics`)
    if (!res.ok) return null
    return (await res.json()) as SimulationMetrics
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function formatPct(v: number | null | undefined, warn = 80, ok = 95): string {
  if (v === null || v === undefined) return c('dim', 'N/A')
  const s = `${v.toFixed(1)}%`
  if (v >= ok) return c('green', s)
  if (v >= warn) return c('yellow', s)
  return c('red', s)
}

function formatSeconds(v: number | null | undefined): string {
  if (v === null || v === undefined) return c('dim', 'N/A')
  const s = `${v}s`
  return v <= 120 ? c('green', s) : v <= 300 ? c('yellow', s) : c('red', s)
}

function formatCount(v: number | null | undefined): string {
  if (v === null || v === undefined) return c('dim', 'N/A')
  return String(v)
}

function formatAlertsPerHundred(v: number | null | undefined): string {
  if (v === null || v === undefined) return c('dim', 'N/A')
  const s = `${v.toFixed(1)}`
  // Target: < 50 alerts/100 evacuees to avoid fatigue
  return v < 50 ? c('green', s) : v < 100 ? c('yellow', s) : c('red', s)
}

function bar(value: number | null | undefined, max = 100, width = 20): string {
  if (value === null || value === undefined) return c('dim', '[' + ' '.repeat(width) + ']')
  const filled = Math.round(((value ?? 0) / max) * width)
  const empty = width - filled
  const pct = value ?? 0
  const color: keyof typeof ANSI =
    pct >= 95 ? 'green' : pct >= 75 ? 'yellow' : 'red'
  return `[${ANSI[color]}${'█'.repeat(filled)}${ANSI.reset}${' '.repeat(empty)}]`
}

function separator(char = '─', width = 60): string {
  return c('dim', char.repeat(width))
}

function renderDashboard(
  health: HealthResponse | null,
  metrics: SimulationMetrics | null,
  lastUpdate: Date,
): string {
  const lines: string[] = []
  const W = 60

  lines.push('')
  lines.push(bold(c('cyan', '  MEDEVAC IPC DASHBOARD'.padEnd(W))))
  lines.push(separator('═', W))

  if (!health) {
    lines.push(c('red', '  ✗ Server unreachable — waiting for connection...'))
    lines.push(c('dim', `  Last attempt: ${lastUpdate.toISOString()}`))
    lines.push(separator('─', W))
    return lines.join('\n')
  }

  // Server info
  lines.push(
    `  ${bold('Simulation')}  ${c('cyan', health.simulation_id)}  ` +
    `${c('green', '● online')}  uptime ${health.uptime_seconds}s`,
  )
  lines.push(
    `  ${bold('Events stored')}  ${health.events_stored}   ` +
    `${c('dim', `started ${health.started_at.slice(0, 19).replace('T', ' ')} UTC`)}`,
  )
  lines.push(separator('─', W))

  if (!metrics || metrics.total_evacuees === 0) {
    lines.push(c('dim', '  Waiting for events...'))
    lines.push(c('dim', `  POST events to http://localhost:3737/events`))
    lines.push(separator('─', W))
    lines.push(c('dim', `  Updated: ${lastUpdate.toISOString()}`))
    return lines.join('\n')
  }

  // Volume
  lines.push(bold('  VOLUME & ALERTS'))
  lines.push(
    `  Evacuees          ${bold(formatCount(metrics.total_evacuees))}` +
    `   Ops events  ${formatCount(metrics.total_ops_events)}`,
  )
  lines.push(
    `  Critical alerts   ${bold(formatCount(metrics.critical_alerts_count))}` +
    `   Alerts/100  ${formatAlertsPerHundred(metrics.alerts_per_100_evacuees)}`,
  )
  lines.push(separator('─', W))

  // Alert latency
  lines.push(bold('  ALERT LATENCY  ') + c('dim', '(SLO: critical ≤ 120s)'))
  lines.push(
    `  P50  ${formatSeconds(metrics.time_to_alert_p50_seconds)}   ` +
    `P90  ${formatSeconds(metrics.time_to_alert_p90_seconds)}`,
  )
  lines.push(separator('─', W))

  // PROA continuity
  lines.push(bold('  PROA — ANTIMICROBIAL CONTINUITY'))
  lines.push(
    `  Doses in window  ${formatPct(metrics.proa_doses_in_window_pct)}  ` +
    `${bar(metrics.proa_doses_in_window_pct)}`,
  )
  lines.push(
    `  Interruptions    ${formatCount(metrics.proa_interruptions_count)}`,
  )
  lines.push(separator('─', W))

  // Decontamination
  lines.push(bold('  DECONTAMINATION TASKS'))
  lines.push(
    `  Closed           ${formatPct(metrics.decon_tasks_closed_pct)}  ` +
    `${bar(metrics.decon_tasks_closed_pct)}`,
  )
  lines.push(separator('─', W))

  // Data quality
  lines.push(bold('  DATA QUALITY'))
  lines.push(
    `  Key fields complete  ${formatPct(metrics.pct_key_fields_complete)}  ` +
    `${bar(metrics.pct_key_fields_complete, 100, 16)}`,
  )
  lines.push(
    `  Human overrides      ${formatPct(metrics.human_override_pct, 20, 10)}`,
  )
  lines.push(separator('═', W))
  lines.push(c('dim', `  Updated: ${lastUpdate.toISOString()}`))
  lines.push(c('dim', `  Ctrl+C to exit  ·  GET /metrics.csv for export`))
  lines.push('')

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Dashboard loop
// ---------------------------------------------------------------------------

export interface DashboardConfig {
  serverUrl?: string
  intervalMs?: number
}

/**
 * Start the terminal dashboard loop.
 * Polls the server every `intervalMs` ms (default 5000) and redraws.
 */
export async function startDashboard(config: DashboardConfig = {}): Promise<void> {
  const serverUrl = config.serverUrl ?? 'http://localhost:3737'
  const intervalMs = config.intervalMs ?? 5000

  console.log(ANSI.clear)
  console.log(`Starting medevac IPC dashboard — polling ${serverUrl} every ${intervalMs / 1000}s`)

  async function refresh(): Promise<void> {
    const [health, metrics] = await Promise.all([
      fetchHealth(serverUrl),
      fetchMetrics(serverUrl),
    ])
    process.stdout.write(ANSI.clear)
    process.stdout.write(renderDashboard(health, metrics, new Date()))
  }

  await refresh()
  const timer = setInterval(refresh, intervalMs)

  process.on('SIGINT', () => {
    clearInterval(timer)
    console.log('\n[Dashboard] Stopped.')
    process.exit(0)
  })
}
