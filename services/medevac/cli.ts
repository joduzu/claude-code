#!/usr/bin/env node
/**
 * Medevac IPC — CLI entry point
 *
 * Commands:
 *   serve   [--port 3737] [--sim SIM-ID]          Start HTTP server
 *   dash    [--url http://...] [--interval 5000]  Start terminal dashboard
 *   process <file.json> [--out events.csv]        Process a local JSON export
 *   kobo    --url URL --token TOKEN --asset UID   Sync from KoBoToolbox
 *   demo                                          Run with built-in demo data
 *
 * Usage:
 *   npx tsx services/medevac/cli.ts serve --port 3737
 *   npx tsx services/medevac/cli.ts demo
 */

import { writeFileSync } from 'fs'
import { KoBoClient } from './integrations/kobo.js'
import { startDashboard } from './dashboard.js'
import { createMedevacServer } from './server.js'
import { computeMetrics, eventsToCSV, metricsToCSV, processBatch } from './processor.js'

// ---------------------------------------------------------------------------
// Arg parser (no external deps)
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const args = argv.slice(2)
  const command = args[0] ?? 'help'
  const flags: Record<string, string> = {}

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = args[i + 1]
      if (next && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = 'true'
      }
    }
  }

  return { command, flags }
}

// ---------------------------------------------------------------------------
// Demo data
// ---------------------------------------------------------------------------

function buildDemoEvents(simId: string): unknown[] {
  const now = new Date()
  const plus = (m: number) =>
    new Date(now.getTime() + m * 60_000).toISOString()

  return [
    // Patient 1: respiratory — low confidence, requires human confirmation
    {
      record_type: 'patient_event',
      simulation_id: simId,
      timestamp_utc: now.toISOString(),
      site_id: 'SITE-ALPHA',
      patient_pseudo_id: 'P-001',
      evac_state: 'triaged',
      syndrome_category: 'respiratory',
      known_pathogen_or_mdro: null,
      precaution_recommended: null,
      cohort_group_id: null,
      vehicle_id: 'AMB-01',
      origin_facility: 'FIELD-A',
      destination_facility: 'HOSP-CENTRAL',
      antibiotic_regimen: 'amoxicillin',
      next_dose_due_utc: plus(8),
      alert_generated: false, alert_type: null, alert_confidence: null,
      alert_ack_by_role: null, alert_ack_time_utc: null,
      action_taken: null, action_time_utc: null, notes: null,
    },
    // Patient 2: confirmed CPE-NDM — high confidence, isolation required
    {
      record_type: 'patient_event',
      simulation_id: simId,
      timestamp_utc: plus(2).toString(),
      site_id: 'SITE-ALPHA',
      patient_pseudo_id: 'P-002',
      evac_state: 'in_transit',
      syndrome_category: null,
      known_pathogen_or_mdro: 'CPE-NDM',
      precaution_recommended: null,
      cohort_group_id: 'CPE-COHORT-01',
      vehicle_id: 'AMB-02',
      origin_facility: 'FIELD-B',
      destination_facility: 'HOSP-ISO',
      antibiotic_regimen: 'meropenem + colistin',
      next_dose_due_utc: plus(3).toString(),
      alert_generated: true,
      alert_type: 'isolation_flag',
      alert_confidence: 0.92,
      alert_ack_by_role: 'dispatch',
      alert_ack_time_utc: plus(2.3).toString(),
      action_taken: 'assigned_isolation_bed',
      action_time_utc: plus(2.8).toString(),
      notes: 'Pre-alert sent to receiving unit',
    },
    // Patient 3: diarrhoea — contact precautions
    {
      record_type: 'patient_event',
      simulation_id: simId,
      timestamp_utc: plus(5).toString(),
      site_id: 'SITE-BETA',
      patient_pseudo_id: 'P-003',
      evac_state: 'handover',
      syndrome_category: 'diarrhoea',
      known_pathogen_or_mdro: null,
      precaution_recommended: null,
      cohort_group_id: null,
      vehicle_id: 'AMB-01',
      origin_facility: 'FIELD-A',
      destination_facility: 'HOSP-CENTRAL',
      antibiotic_regimen: null,
      next_dose_due_utc: null,
      alert_generated: false, alert_type: null, alert_confidence: null,
      alert_ack_by_role: null, alert_ack_time_utc: null,
      action_taken: null, action_time_utc: null, notes: null,
    },
    // Patient 4: no data — maximum uncertainty
    {
      record_type: 'patient_event',
      simulation_id: simId,
      timestamp_utc: plus(7).toString(),
      site_id: 'SITE-BETA',
      patient_pseudo_id: 'P-004',
      evac_state: 'awaiting_transport',
      syndrome_category: null,
      known_pathogen_or_mdro: null,
      precaution_recommended: null,
      cohort_group_id: null,
      vehicle_id: null,
      origin_facility: 'FIELD-C',
      destination_facility: null,
      antibiotic_regimen: 'ceftriaxone',
      next_dose_due_utc: plus(9).toString(),
      alert_generated: false, alert_type: null, alert_confidence: null,
      alert_ack_by_role: null, alert_ack_time_utc: null,
      action_taken: null, action_time_utc: null, notes: 'No clinical record available',
    },
    // Ops event: vehicle decontamination after CPE patient
    {
      record_type: 'ops_event',
      simulation_id: simId,
      timestamp_utc: plus(12).toString(),
      site_id: 'SITE-ALPHA',
      patient_pseudo_id: 'P-002',
      evac_state: 'cleared',
      vehicle_id: 'AMB-02',
      decon_agent: 'sodium hypochlorite 0.1% (1000 ppm)',
      decon_contact_minutes: 1,
      decon_completed: true,
      alert_generated: true,
      alert_type: 'cleaning_worklist',
      alert_confidence: 0.95,
      alert_ack_by_role: 'evs',
      alert_ack_time_utc: plus(12.1).toString(),
      action_taken: 'vehicle_decon_complete',
      action_time_utc: plus(14.5).toString(),
      notes: 'Chlorine 0.1%, contact time 10 min, signed off by EVS lead',
    },
  ]
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdServe(flags: Record<string, string>): Promise<void> {
  const port = parseInt(flags['port'] ?? '3737', 10)
  const simId = flags['sim'] ?? `SIM-${new Date().toISOString().slice(0, 10)}`
  const server = createMedevacServer({ port, simulationId: simId })
  server.start()
  // Keep alive
  await new Promise(() => {})
}

async function cmdDash(flags: Record<string, string>): Promise<void> {
  const serverUrl = flags['url'] ?? 'http://localhost:3737'
  const intervalMs = parseInt(flags['interval'] ?? '5000', 10)
  await startDashboard({ serverUrl, intervalMs })
}

async function cmdProcess(flags: Record<string, string>, positional: string[]): Promise<void> {
  const filePath = positional[0]
  if (!filePath) {
    console.error('Usage: process <file.json> [--out events.csv] [--sim SIM-ID]')
    process.exit(1)
  }

  const client = new KoBoClient({
    apiUrl: '',
    token: '',
    assetUid: 'local',
  })

  const simId = flags['sim'] ?? `LOCAL-${Date.now()}`
  const result = client.processLocalExport(filePath, simId)
  const events = result.results.map(r => r.event)
  const metrics = computeMetrics(events, simId)

  console.log(`\nProcessed ${result.totalFetched} records`)
  console.log(`  Valid:   ${result.results.length}`)
  console.log(`  Errors:  ${result.errors.length}`)

  if (result.errors.length > 0) {
    console.log('\nValidation errors:')
    result.errors.forEach(e => console.log(`  [${e.index}] ${e.error}`))
  }

  console.log('\nIPC decisions:')
  result.results.forEach(r => {
    if (r.ipcDecision) {
      const id =
        r.event.record_type === 'patient_event'
          ? r.event.patient_pseudo_id ?? 'unknown'
          : 'ops'
      console.log(
        `  ${id.padEnd(10)}  ${r.ipcDecision.precaution.padEnd(20)}  ` +
        `conf: ${r.ipcDecision.confidence.toFixed(2)}  ` +
        (r.ipcDecision.requiresHumanConfirmation ? '⚠ human required' : '✓'),
      )
    }
  })

  const outPath = flags['out'] ?? `events_${simId}.csv`
  writeFileSync(outPath, eventsToCSV(events), 'utf8')
  writeFileSync(`metrics_${simId}.csv`, metricsToCSV(metrics), 'utf8')
  console.log(`\nExported:\n  ${outPath}\n  metrics_${simId}.csv`)
}

async function cmdKobo(flags: Record<string, string>): Promise<void> {
  const { url, token, asset, sim, out } = flags
  if (!url || !token || !asset) {
    console.error('Usage: kobo --url https://kf.kobotoolbox.org --token TOKEN --asset ASSET_UID')
    process.exit(1)
  }

  const client = new KoBoClient({ apiUrl: url, token, assetUid: asset })
  console.log(`Syncing from KoBoToolbox asset ${asset}...`)
  const result = await client.syncAndProcess(sim)

  console.log(`Fetched: ${result.totalFetched} ${result.cached ? '(from cache)' : ''}`)
  console.log(`Valid:   ${result.results.length}`)
  console.log(`Errors:  ${result.errors.length}`)

  const events = result.results.map(r => r.event)
  const metrics = computeMetrics(events, result.simulationId)
  const eventsFile = out ?? `events_${result.simulationId}.csv`
  writeFileSync(eventsFile, eventsToCSV(events), 'utf8')
  writeFileSync(`metrics_${result.simulationId}.csv`, metricsToCSV(metrics), 'utf8')
  console.log(`\nExported: ${eventsFile}`)
}

// ─────────────────────────────────────────────────────────────
// Shared UI helpers for CLI output
// ─────────────────────────────────────────────────────────────

const C = {
  r:  '\x1b[0m',
  b:  '\x1b[1m',
  d:  '\x1b[2m',
  red:    '\x1b[91m',
  green:  '\x1b[92m',
  yellow: '\x1b[93m',
  cyan:   '\x1b[96m',
  white:  '\x1b[97m',
  bgRed:    '\x1b[41m',
  bgGreen:  '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue:   '\x1b[44m',
  bgCyan:   '\x1b[46m',
}

const W2 = 68

function cliLine(left = '├', right = '┤', char = '─'): string {
  return `\x1b[2m${left}${char.repeat(W2 - 2)}${right}\x1b[0m`
}
function cliTop():  string { return `\x1b[2m╔${'═'.repeat(W2 - 2)}╗\x1b[0m` }
function cliBot():  string { return `\x1b[2m╚${'═'.repeat(W2 - 2)}╝\x1b[0m` }
function cliMid():  string { return `\x1b[2m╠${'═'.repeat(W2 - 2)}╣\x1b[0m` }
function cliRow(content: string): string {
  const visible = content.replace(/\x1b\[[0-9;]*m/g, '')
  const pad = Math.max(0, W2 - 2 - visible.length)
  return `\x1b[2m║\x1b[0m ${content}${' '.repeat(pad)} \x1b[2m║\x1b[0m`
}
function cliSect(label: string, icon: string): string {
  const inner = ` ${icon}  ${label} `
  const rest  = W2 - 4 - inner.length
  return `\x1b[2m├\x1b[0m\x1b[1m\x1b[96m${inner}\x1b[0m\x1b[2m${'─'.repeat(rest)}┤\x1b[0m`
}

function precautionBadge(p: string): string {
  if (p === 'contact_enhanced') return `${C.bgRed}${C.b}${C.white} CONTACT+ ${C.r}`
  if (p === 'airborne')         return `${C.bgRed}${C.b}${C.white} AIRBORNE  ${C.r}`
  if (p === 'droplet_contact')  return `${C.bgYellow}${C.b}\x1b[30m DROPLET+  ${C.r}`
  if (p === 'droplet')          return `${C.bgYellow}${C.b}\x1b[30m DROPLET   ${C.r}`
  if (p === 'contact')          return `${C.bgBlue}${C.b}${C.white} CONTACT   ${C.r}`
  return `${C.d} STANDARD  ${C.r}`
}

function confidenceBar(conf: number, width = 12): string {
  const filled = Math.round(conf * width)
  const empty  = width - filled
  const color  = conf >= 0.8 ? C.green : conf >= 0.5 ? C.yellow : C.red
  return `${color}${'▪'.repeat(filled)}\x1b[2m${'▪'.repeat(empty)}${C.r}`
}

// ─────────────────────────────────────────────────────────────

async function cmdDemo(): Promise<void> {
  const simId = `DEMO-${Date.now()}`
  const rawEvents = buildDemoEvents(simId)
  const { results, errors } = processBatch(rawEvents)
  const events  = results.map(r => r.event)
  const metrics = computeMetrics(events, simId)

  // ── Banner ────────────────────────────────────────────────
  console.log('')
  console.log(cliTop())
  console.log(cliRow(
    `${C.b}${C.cyan}  MEDEVAC IPC${C.r}  ${C.d}Infection Prevention & Control${C.r}`
    .padEnd(W2 - 2),
  ))
  console.log(cliRow(
    `${C.d}  Simulation  ${C.r}${C.white}${simId}${C.r}` +
    `   ${C.d}Events: ${results.length} valid  ${errors.length > 0 ? C.red + errors.length + ' errors' + C.r : C.green + '0 errors' + C.r}${C.r}`,
  ))
  console.log(cliMid())

  // ── IPC Decisions table ───────────────────────────────────
  console.log(cliSect('IPC Decisions', '◈'))
  console.log(cliRow(
    `${C.d}  Patient    State               Precaution         Conf  Flag${C.r}`,
  ))
  console.log(cliLine())

  results.forEach(r => {
    if (r.event.record_type === 'ops_event') return
    const p = r.event as import('./schemas.js').PatientEvent
    const d = r.ipcDecision!

    const patId   = (p.patient_pseudo_id ?? '???').padEnd(8)
    const state   = p.evac_state.padEnd(18)
    const prec    = precautionBadge(d.precaution)
    const confBar = confidenceBar(d.confidence)
    const flag    = d.requiresHumanConfirmation
      ? `${C.yellow}${C.b}⚠ HUMAN${C.r}`
      : `${C.green}${C.b}✔ AUTO ${C.r}`

    console.log(cliRow(`  ${C.white}${patId}${C.r}  ${C.d}${state}${C.r}  ${prec}  ${confBar}  ${flag}`))

    if (r.proaStatus?.alertRequired) {
      const mins = r.proaStatus.minutesUntilDue?.toFixed(1)
      console.log(cliRow(
        `  ${' '.repeat(8)}  ${C.bgYellow}\x1b[30m${C.b} PROA ${C.r} ` +
        `${C.yellow}next dose in ${C.b}${mins} min${C.r}  —  alert required`,
      ))
    }
    if (d.alertType) {
      console.log(cliRow(
        `  ${' '.repeat(8)}  ${C.d}alert → ${C.r}${C.cyan}${d.alertType}${C.r}  ` +
        `${C.d}${d.rationale.slice(0, 42)}…${C.r}`,
      ))
    }
  })

  // Ops events
  console.log(cliLine())
  results.forEach(r => {
    if (r.event.record_type !== 'ops_event') return
    const o  = r.event as import('./schemas.js').OpsEvent
    const ds = r.deconSpec!
    console.log(cliRow(
      `  ${C.d}OPS${C.r}  ${(o.vehicle_id ?? 'unknown').padEnd(8)}  ` +
      `${C.d}${o.evac_state.padEnd(18)}${C.r}  ` +
      `${C.bgGreen}\x1b[30m${C.b} DECON ${C.r}  ` +
      `${C.d}${ds.agentSuggestion.slice(0, 24)}  ${ds.contactTimeMinutes}min${C.r}`,
    ))
  })

  // ── Metrics summary ───────────────────────────────────────
  console.log(cliMid())
  console.log(cliSect('Simulation Metrics', '◎'))

  function metricRow(label: string, value: string, hint = ''): void {
    const l = label.padEnd(26)
    const h = hint ? `  ${C.d}${hint}${C.r}` : ''
    console.log(cliRow(`  ${C.d}${l}${C.r}  ${value}${h}`))
  }

  const fmtPct = (v: number | null, ok = 95, warn = 80) => {
    if (v === null) return `${C.d}N/A${C.r}`
    const s = `${v.toFixed(1)}%`
    return v >= ok ? `${C.green}${C.b}${s}${C.r}` : v >= warn ? `${C.yellow}${C.b}${s}${C.r}` : `${C.red}${C.b}${s}${C.r}`
  }
  const fmtN = (v: number | null | undefined) =>
    v === null || v === undefined ? `${C.d}—${C.r}` : `${C.white}${C.b}${v}${C.r}`

  metricRow('Evacuees',            fmtN(metrics.total_evacuees))
  metricRow('Critical alerts',     fmtN(metrics.critical_alerts_count), 'isolation / cohort / route')
  metricRow('Alerts per 100',      fmtN(metrics.alerts_per_100_evacuees), 'fatigue target < 50')
  metricRow('Latency P50 / P90',
    `${C.cyan}${C.b}${metrics.time_to_alert_p50_seconds ?? '—'}s${C.r}  /  ` +
    `${C.cyan}${C.b}${metrics.time_to_alert_p90_seconds ?? '—'}s${C.r}`,
    'SLO critical ≤ 120s')
  metricRow('PROA doses in window', fmtPct(metrics.proa_doses_in_window_pct), 'target ≥ 95%')
  metricRow('Decon tasks closed',   fmtPct(metrics.decon_tasks_closed_pct),   'target ≥ 95%')
  metricRow('Key fields complete',  fmtPct(metrics.pct_key_fields_complete),  'evac_state + syndrome + dest')

  // ── Export ────────────────────────────────────────────────
  console.log(cliMid())
  const evFile  = `demo_events_${simId}.csv`
  const metFile = `demo_metrics_${simId}.csv`
  writeFileSync(evFile,  eventsToCSV(events),   'utf8')
  writeFileSync(metFile, metricsToCSV(metrics),  'utf8')
  console.log(cliRow(`  ${C.green}✔${C.r} Exported  ${C.cyan}${evFile}${C.r}`))
  console.log(cliRow(`  ${C.green}✔${C.r} Exported  ${C.cyan}${metFile}${C.r}`))
  console.log(cliBot())
  console.log('')
}

function cmdHelp(): void {
  const W3 = 68
  const top  = `\x1b[2m╔${'═'.repeat(W3 - 2)}╗\x1b[0m`
  const bot  = `\x1b[2m╚${'═'.repeat(W3 - 2)}╝\x1b[0m`
  const mid  = `\x1b[2m╠${'═'.repeat(W3 - 2)}╣\x1b[0m`
  const thin = `\x1b[2m├${'─'.repeat(W3 - 2)}┤\x1b[0m`
  const row  = (s: string) => {
    const vis = s.replace(/\x1b\[[0-9;]*m/g, '')
    return `\x1b[2m║\x1b[0m ${s}${' '.repeat(Math.max(0, W3 - 2 - vis.length))} \x1b[2m║\x1b[0m`
  }
  const cmd  = (name: string, args: string) =>
    `  \x1b[1m\x1b[96m${name.padEnd(9)}\x1b[0m \x1b[2m${args}\x1b[0m`
  const ex   = (s: string) => `  \x1b[2m$  \x1b[0m\x1b[93m${s}\x1b[0m`

  console.log('')
  console.log(top)
  console.log(row(`\x1b[1m\x1b[96m  MEDEVAC IPC CLI\x1b[0m  \x1b[2mOffline-capable IPC rule engine for medical evacuations\x1b[0m`))
  console.log(mid)
  console.log(row(`\x1b[1m  Commands\x1b[0m`))
  console.log(thin)
  console.log(row(cmd('serve',   '[--port 3737] [--sim SIM-ID]')))
  console.log(row(`           \x1b[2mStart REST server on edge node\x1b[0m`))
  console.log(row(cmd('dash',    '[--url http://localhost:3737] [--interval 4000]')))
  console.log(row(`           \x1b[2mReal-time terminal dashboard (polls server)\x1b[0m`))
  console.log(row(cmd('demo',    '')))
  console.log(row(`           \x1b[2mRun built-in demo events and print IPC decisions\x1b[0m`))
  console.log(row(cmd('process', '<file.json> [--out events.csv] [--sim SIM-ID]')))
  console.log(row(`           \x1b[2mProcess a local KoBoToolbox JSON export\x1b[0m`))
  console.log(row(cmd('kobo',    '--url URL --token TOKEN --asset UID')))
  console.log(row(`           \x1b[2mSync directly from KoBoToolbox API (offline fallback)\x1b[0m`))
  console.log(mid)
  console.log(row(`\x1b[1m  Quick start\x1b[0m`))
  console.log(thin)
  console.log(row(ex('npx tsx cli.ts demo')))
  console.log(row(ex('npx tsx cli.ts serve --port 3737')))
  console.log(row(ex('npx tsx cli.ts dash')))
  console.log(row(ex('npx tsx cli.ts process export.json --sim SIM-2026-01')))
  console.log(bot)
  console.log('')
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const { command, flags } = parseArgs(process.argv)
const positional = process.argv.slice(3).filter(a => !a.startsWith('--'))

switch (command) {
  case 'serve':
    cmdServe(flags).catch(console.error)
    break
  case 'dash':
    cmdDash(flags).catch(console.error)
    break
  case 'process':
    cmdProcess(flags, positional).catch(console.error)
    break
  case 'kobo':
    cmdKobo(flags).catch(console.error)
    break
  case 'demo':
    cmdDemo().catch(console.error)
    break
  default:
    cmdHelp()
}
