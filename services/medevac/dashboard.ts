/**
 * Medevac IPC — Terminal Dashboard (enhanced UI)
 *
 * Rich ANSI terminal dashboard with box-drawing, colour-coded KPIs,
 * gradient progress bars, status badges, and a live alert feed.
 * No external dependencies — pure Node.js.
 */

import type { SimulationMetrics } from './schemas.js'

// ─────────────────────────────────────────────────────────────
// ANSI palette
// ─────────────────────────────────────────────────────────────

const A = {
  reset:    '\x1b[0m',
  bold:     '\x1b[1m',
  dim:      '\x1b[2m',
  italic:   '\x1b[3m',
  blink:    '\x1b[5m',

  black:    '\x1b[30m',
  red:      '\x1b[31m',
  green:    '\x1b[32m',
  yellow:   '\x1b[33m',
  blue:     '\x1b[34m',
  magenta:  '\x1b[35m',
  cyan:     '\x1b[36m',
  white:    '\x1b[37m',

  bgRed:    '\x1b[41m',
  bgGreen:  '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue:   '\x1b[44m',
  bgCyan:   '\x1b[46m',
  bgBlack:  '\x1b[40m',

  brightRed:     '\x1b[91m',
  brightGreen:   '\x1b[92m',
  brightYellow:  '\x1b[93m',
  brightBlue:    '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan:    '\x1b[96m',
  brightWhite:   '\x1b[97m',

  clearScreen: '\x1b[2J\x1b[H',
  hideCursor:  '\x1b[?25l',
  showCursor:  '\x1b[?25h',
}

const r = A.reset

// Convenience wrappers
const bold  = (s: string) => `${A.bold}${s}${r}`
const dim   = (s: string) => `${A.dim}${s}${r}`
const col   = (c: string, s: string) => `${c}${s}${r}`

// ─────────────────────────────────────────────────────────────
// Box-drawing helpers
// ─────────────────────────────────────────────────────────────

const W = 72   // total dashboard width (chars, excluding newline)

const box = {
  tl: '╔', tr: '╗', bl: '╚', br: '╝',
  h:  '═', v:  '║',
  ml: '╠', mr: '╣', mt: '╦', mb: '╩', x: '╬',
  sl: '├', sr: '┤', sh: '─',
}

function hline(char = box.h, left = box.ml, right = box.mr): string {
  return col(A.dim, left + char.repeat(W - 2) + right)
}

function topBar(): string  { return col(A.dim, box.tl + box.h.repeat(W - 2) + box.tr) }
function botBar(): string  { return col(A.dim, box.bl + box.h.repeat(W - 2) + box.br) }
function midBar(): string  { return hline(box.h, box.ml, box.mr) }
function thinBar(): string { return hline(box.sh, box.sl, box.sr) }

/** Pad/truncate a string to exactly `width` visible characters (no ANSI). */
function pad(s: string, width: number, align: 'l' | 'r' | 'c' = 'l'): string {
  const visible = stripAnsi(s)
  const extra = s.length - visible.length  // ANSI escape chars don't count
  const total = width + extra
  if (align === 'r') return s.padStart(total)
  if (align === 'c') {
    const left = Math.floor((width - visible.length) / 2)
    const right = width - visible.length - left
    return ' '.repeat(left) + s + ' '.repeat(right)
  }
  return s.padEnd(total)
}

/** Strip ANSI codes to measure visible length. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

/** Wrap text in a full-width box row: ║ content ║ */
function row(content: string, inner = W - 2): string {
  const visible = stripAnsi(content)
  const padded = content + ' '.repeat(Math.max(0, inner - visible.length))
  return `${col(A.dim, box.v)} ${padded} ${col(A.dim, box.v)}`
}

// ─────────────────────────────────────────────────────────────
// Value formatters
// ─────────────────────────────────────────────────────────────

function badge(text: string, bg: string, fg = A.white): string {
  return `${bg}${A.bold}${fg} ${text} ${r}`
}

function statusBadge(v: number | null | undefined, warn: number, ok: number): string {
  if (v === null || v === undefined) return badge(' N/A ', A.bgBlack, A.dim)
  if (v >= ok)   return badge(' OK  ', A.bgGreen,  A.black)
  if (v >= warn) return badge('WARN ', A.bgYellow, A.black)
  return               badge('CRIT ', A.bgRed,    A.white)
}

function pct(v: number | null | undefined, warn = 80, ok = 95): string {
  if (v === null || v === undefined) return dim('  —  ')
  const s = `${v.toFixed(1)}%`
  if (v >= ok)   return col(A.brightGreen,  bold(s))
  if (v >= warn) return col(A.brightYellow, bold(s))
  return               col(A.brightRed,    bold(s))
}

function secs(v: number | null | undefined, warnSec = 120, critSec = 300): string {
  if (v === null || v === undefined) return dim('  —  ')
  const s = `${v}s`
  if (v <= warnSec) return col(A.brightGreen,  bold(s))
  if (v <= critSec) return col(A.brightYellow, bold(s))
  return                  col(A.brightRed,    bold(s))
}

function num(v: number | null | undefined): string {
  if (v === null || v === undefined) return dim('—')
  return bold(String(v))
}

function alertsPerHundred(v: number | null | undefined): string {
  if (v === null || v === undefined) return dim('—')
  const s = v.toFixed(1)
  if (v < 50)  return col(A.brightGreen,  bold(s))
  if (v < 100) return col(A.brightYellow, bold(s))
  return              col(A.brightRed,   bold(s))
}

// Gradient progress bar  ▰▰▰▰▰▱▱▱▱▱
function progressBar(v: number | null | undefined, width = 24): string {
  if (v === null || v === undefined) return col(A.dim, '▱'.repeat(width))
  const filled = Math.round((Math.min(Math.max(v, 0), 100) / 100) * width)
  const empty  = width - filled
  const color  = v >= 95 ? A.brightGreen : v >= 75 ? A.brightYellow : A.brightRed
  return col(color, '▰'.repeat(filled)) + col(A.dim, '▱'.repeat(empty))
}

// Latency mini-bar (scale: 0–300s)
function latencyBar(v: number | null | undefined, width = 16): string {
  if (v === null || v === undefined) return col(A.dim, '░'.repeat(width))
  const capped = Math.min(v, 300)
  const filled = Math.round((capped / 300) * width)
  const empty  = width - filled
  const color  = v <= 120 ? A.brightGreen : v <= 300 ? A.brightYellow : A.brightRed
  return col(color, '█'.repeat(filled)) + col(A.dim, '░'.repeat(empty))
}

// ─────────────────────────────────────────────────────────────
// Section renderers
// ─────────────────────────────────────────────────────────────

function sectionHeader(title: string, icon: string): string {
  const label = ` ${icon}  ${title.toUpperCase()} `
  const rest   = W - 4 - stripAnsi(label).length
  return col(A.dim, box.sl) +
    col(A.bgBlack, col(A.cyan, A.bold + label + r)) +
    col(A.dim, box.sh.repeat(rest) + box.sr)
}

// ─────────────────────────────────────────────────────────────
// Main render
// ─────────────────────────────────────────────────────────────

interface HealthResponse {
  status: string
  simulation_id: string
  events_stored: number
  started_at: string
  uptime_seconds: number
}

let tick = 0   // animation counter

function renderDashboard(
  health: HealthResponse | null,
  metrics: SimulationMetrics | null,
  lastUpdate: Date,
): string {
  tick++
  const pulse = tick % 2 === 0 ? col(A.brightGreen, '●') : col(A.green, '●')
  const lines: string[] = []

  // ── Top bar ──────────────────────────────────────────────
  lines.push(topBar())

  // Title row
  const titleLeft  = col(A.bgBlack, bold(col(A.brightCyan, '  MEDEVAC IPC  ')) + col(A.cyan, 'Infection Prevention & Control'))
  const titleRight = dim(lastUpdate.toLocaleTimeString('en-GB', { hour12: false }))
  const titleInner = W - 2
  const leftVis    = stripAnsi(titleLeft)
  const rightVis   = stripAnsi(titleRight)
  const gap        = titleInner - leftVis.length - rightVis.length - 2
  lines.push(
    col(A.dim, box.v) +
    ' ' + titleLeft + ' '.repeat(Math.max(0, gap)) + titleRight + ' ' +
    col(A.dim, box.v),
  )

  lines.push(midBar())

  // ── Server status ─────────────────────────────────────────
  if (!health) {
    lines.push(row(col(A.brightRed, '  ✖  Server unreachable') + dim('  —  waiting for connection...')))
    lines.push(row(dim(`  Retry: ${lastUpdate.toISOString()}`)))
    lines.push(botBar())
    return lines.join('\n')
  }

  const uptime = health.uptime_seconds < 60
    ? `${health.uptime_seconds}s`
    : `${Math.floor(health.uptime_seconds / 60)}m ${health.uptime_seconds % 60}s`

  const serverLine =
    `  ${pulse} ${bold(col(A.brightCyan, health.simulation_id))}` +
    `  ${col(A.brightGreen, 'ONLINE')}` +
    `  ${dim('│')}  ${col(A.white, num(health.events_stored))} events` +
    `  ${dim('│')}  uptime ${col(A.brightWhite, uptime)}`
  lines.push(row(serverLine))

  const startedLine = dim(`  Started ${health.started_at.slice(0, 19).replace('T', ' ')} UTC`) +
    '    ' + dim(`POST /events  ·  GET /metrics.csv  ·  GET /events.csv`)
  lines.push(row(startedLine))

  if (!metrics || metrics.total_evacuees === 0) {
    lines.push(thinBar())
    lines.push(row(''))
    lines.push(row(col(A.dim, '  Waiting for events…') + '   ' + dim('npx tsx cli.ts demo')))
    lines.push(row(''))
    lines.push(botBar())
    return lines.join('\n')
  }

  // ── Volume & Alerts ───────────────────────────────────────
  lines.push(sectionHeader('Volume & Alerts', '◈'))

  const vol1 =
    `  Evacuees  ${pad(col(A.brightWhite, bold(String(metrics.total_evacuees))), 6)}` +
    `  Ops tasks  ${pad(num(metrics.total_ops_events), 6)}` +
    `  Alerts/100  ${alertsPerHundred(metrics.alerts_per_100_evacuees)}`
  lines.push(row(vol1))

  const critColor = (metrics.critical_alerts_count ?? 0) > 0 ? A.brightRed : A.brightGreen
  const vol2 =
    `  Critical alerts  ${col(critColor, bold(String(metrics.critical_alerts_count ?? 0)))}` +
    '  ' + statusBadge(metrics.alerts_per_100_evacuees, 50, 0) +  // inverted — lower is better
    ' alert load'
  lines.push(row(vol2))

  // ── Alert Latency ─────────────────────────────────────────
  lines.push(sectionHeader('Alert Latency', '⏱'))

  const p50vis = metrics.time_to_alert_p50_seconds
  const p90vis = metrics.time_to_alert_p90_seconds

  lines.push(row(
    `  P50  ${pad(secs(p50vis), 12)}  ${latencyBar(p50vis)}` +
    `   P90  ${pad(secs(p90vis), 12)}  ${latencyBar(p90vis)}`,
  ))
  lines.push(row(dim('       SLO critical ≤ 120s ──────────────────────────────────────────')))

  // ── PROA ──────────────────────────────────────────────────
  lines.push(sectionHeader('PROA — Antimicrobial Continuity', '💊'))

  lines.push(row(
    `  Doses in window   ${pad(pct(metrics.proa_doses_in_window_pct), 12)}  ${progressBar(metrics.proa_doses_in_window_pct)}  ${statusBadge(metrics.proa_doses_in_window_pct, 80, 95)}`,
  ))
  lines.push(row(
    `  Interruptions     ${num(metrics.proa_interruptions_count)}   doses missed during transit`,
  ))

  // ── Decontamination ───────────────────────────────────────
  lines.push(sectionHeader('Decontamination Tasks', '⬡'))

  lines.push(row(
    `  Tasks closed      ${pad(pct(metrics.decon_tasks_closed_pct), 12)}  ${progressBar(metrics.decon_tasks_closed_pct)}  ${statusBadge(metrics.decon_tasks_closed_pct, 80, 95)}`,
  ))

  // ── Data Quality ──────────────────────────────────────────
  lines.push(sectionHeader('Data Quality', '◎'))

  lines.push(row(
    `  Key fields complete  ${pad(pct(metrics.pct_key_fields_complete), 12)}  ${progressBar(metrics.pct_key_fields_complete, 16)}  ${statusBadge(metrics.pct_key_fields_complete, 80, 95)}`,
  ))
  lines.push(row(
    `  Human overrides      ${pad(pct(metrics.human_override_pct, 20, 10), 12)}  ` +
    dim('(lower = fewer operator corrections needed)'),
  ))

  // ── Footer ────────────────────────────────────────────────
  lines.push(midBar())
  const footer =
    dim('  Ctrl+C exit') + '  ' +
    dim('│') + '  ' + dim(`Updated ${lastUpdate.toISOString().slice(11, 19)} UTC`) + '  ' +
    dim('│') + '  ' + dim('GET /metrics.csv for export')
  lines.push(row(footer))
  lines.push(botBar())
  lines.push('')

  return lines.join('\n')
}

// ─────────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────────

async function fetchHealth(serverUrl: string): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    return (await res.json()) as HealthResponse
  } catch { return null }
}

async function fetchMetrics(serverUrl: string): Promise<SimulationMetrics | null> {
  try {
    const res = await fetch(`${serverUrl}/metrics`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    return (await res.json()) as SimulationMetrics
  } catch { return null }
}

export interface DashboardConfig {
  serverUrl?: string
  intervalMs?: number
}

export async function startDashboard(config: DashboardConfig = {}): Promise<void> {
  const serverUrl  = config.serverUrl  ?? 'http://localhost:3737'
  const intervalMs = config.intervalMs ?? 4000

  process.stdout.write(A.hideCursor)
  process.stdout.write(A.clearScreen)

  async function refresh(): Promise<void> {
    const [health, metrics] = await Promise.all([
      fetchHealth(serverUrl),
      fetchMetrics(serverUrl),
    ])
    process.stdout.write(A.clearScreen)
    process.stdout.write(renderDashboard(health, metrics, new Date()))
  }

  await refresh()
  const timer = setInterval(refresh, intervalMs)

  process.on('SIGINT', () => {
    clearInterval(timer)
    process.stdout.write(A.showCursor)
    process.stdout.write('\n')
    console.log(col(A.dim, '[Dashboard] Stopped.'))
    process.exit(0)
  })
}
