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

async function cmdDemo(): Promise<void> {
  const simId = `DEMO-${Date.now()}`
  const rawEvents = buildDemoEvents(simId)
  const { results, errors } = processBatch(rawEvents)

  console.log('\n' + '═'.repeat(60))
  console.log('  MEDEVAC IPC — DEMO RUN')
  console.log('═'.repeat(60))
  console.log(`Simulation: ${simId}`)
  console.log(`Events:     ${rawEvents.length}  (valid: ${results.length}, errors: ${errors.length})`)
  console.log('')

  results.forEach(r => {
    if (r.event.record_type === 'ops_event') return
    const p = r.event as import('./schemas.js').PatientEvent
    const d = r.ipcDecision!
    const icon = d.requiresHumanConfirmation ? '⚠ ' : '✓ '
    console.log(
      `  ${icon}${(p.patient_pseudo_id ?? '???').padEnd(8)}  ` +
      `${p.evac_state.padEnd(20)}  ` +
      `${d.precaution.padEnd(18)}  ` +
      `conf:${d.confidence.toFixed(2)}`,
    )
    if (r.proaStatus?.alertRequired) {
      console.log(
        `           ⚡ PROA ALERT: next dose in ${r.proaStatus.minutesUntilDue?.toFixed(1)} min`,
      )
    }
  })

  console.log('')
  const events = results.map(r => r.event)
  const metrics = computeMetrics(events, simId)
  console.log('─'.repeat(60))
  console.log('  METRICS')
  console.log('─'.repeat(60))
  console.log(`  Evacuees:            ${metrics.total_evacuees}`)
  console.log(`  Alerts/100 evacuees: ${metrics.alerts_per_100_evacuees}`)
  console.log(`  Critical alerts:     ${metrics.critical_alerts_count}`)
  console.log(`  P50 latency:         ${metrics.time_to_alert_p50_seconds ?? 'N/A'}s`)
  console.log(`  PROA in-window:      ${metrics.proa_doses_in_window_pct ?? 'N/A'}%`)
  console.log(`  Decon closed:        ${metrics.decon_tasks_closed_pct ?? 'N/A'}%`)
  console.log('═'.repeat(60))

  writeFileSync(`demo_events_${simId}.csv`, eventsToCSV(events), 'utf8')
  writeFileSync(`demo_metrics_${simId}.csv`, metricsToCSV(metrics), 'utf8')
  console.log(`\nExported: demo_events_${simId}.csv`)
  console.log(`          demo_metrics_${simId}.csv`)
}

function cmdHelp(): void {
  console.log(`
Medevac IPC CLI

Commands:
  serve   [--port 3737] [--sim SIM-ID]
          Start HTTP server (POST /events, GET /metrics, GET /events.csv)

  dash    [--url http://localhost:3737] [--interval 5000]
          Start real-time terminal dashboard (polls HTTP server)

  process <file.json> [--out events.csv] [--sim SIM-ID]
          Validate and process a local KoBoToolbox JSON export

  kobo    --url https://kf.kobotoolbox.org --token TOKEN --asset UID [--sim SIM-ID]
          Sync directly from KoBoToolbox API

  demo    Run with built-in demo events and print IPC decisions + metrics

Examples:
  # 1. Start server in one terminal
  npx tsx services/medevac/cli.ts serve --port 3737

  # 2. Start dashboard in another terminal
  npx tsx services/medevac/cli.ts dash

  # 3. Send a test event
  curl -s -X POST http://localhost:3737/events \\
    -H "Content-Type: application/json" \\
    -d '{"record_type":"patient_event","simulation_id":"TEST","timestamp_utc":"2026-01-01T00:00:00Z","site_id":"SITE-A","evac_state":"triaged","syndrome_category":"respiratory","known_pathogen_or_mdro":null,"precaution_recommended":null,"cohort_group_id":null,"vehicle_id":"AMB-1","origin_facility":"F1","destination_facility":"H1","antibiotic_regimen":null,"next_dose_due_utc":null,"patient_pseudo_id":"P-001","alert_generated":false,"alert_type":null,"alert_confidence":null,"alert_ack_by_role":null,"alert_ack_time_utc":null,"action_taken":null,"action_time_utc":null,"notes":null}'

  # 4. Get metrics
  curl http://localhost:3737/metrics

  # 5. Download CSV audit file
  curl http://localhost:3737/events.csv -o events.csv

  # 6. Run demo
  npx tsx services/medevac/cli.ts demo
`)
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
