/**
 * Medevac IPC — HTTP REST server
 *
 * Lightweight Node.js HTTP server (no framework dependencies) that exposes
 * the IPC rule engine as a REST API. Designed for:
 *  - Edge-node deployment (runs on a ruggedised laptop/mini-PC)
 *  - Consumption by mobile capture apps (KoBoToolbox webhooks, custom apps)
 *  - Dashboard polling for real-time metrics
 *
 * Endpoints:
 *   POST /events          — validate + process one or many events, return IPC decisions
 *   GET  /events          — return stored events for this session
 *   GET  /metrics         — return aggregate simulation metrics
 *   GET  /metrics.csv     — metrics as CSV (for spreadsheet import)
 *   GET  /events.csv      — all events as CSV (for audit)
 *   POST /reset           — clear in-memory store (start new simulation)
 *   GET  /health          — liveness check
 *
 * Usage:
 *   import { createMedevacServer } from './services/medevac/server.js'
 *   const server = createMedevacServer({ port: 3737, simulationId: 'SIM-2026-01' })
 *   server.start()
 */

import { createServer, IncomingMessage, ServerResponse } from 'http'
import {
  computeMetrics,
  eventsToCSV,
  metricsToCSV,
  processBatch,
  type ProcessedEvent,
} from './processor.js'
import type { MedevacSimulationEvent } from './schemas.js'

// ---------------------------------------------------------------------------
// In-memory event store (session-scoped)
// ---------------------------------------------------------------------------

interface EventStore {
  simulationId: string
  events: MedevacSimulationEvent[]
  processed: ProcessedEvent[]
  startedAt: string
}

function createStore(simulationId: string): EventStore {
  return {
    simulationId,
    events: [],
    processed: [],
    startedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
  })
  res.end(payload)
}

function csv(res: ServerResponse, filename: string, body: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  })
  res.end(body)
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function parseUrl(req: IncomingMessage): { path: string; query: URLSearchParams } {
  const base = `http://localhost${req.url ?? '/'}`
  const u = new URL(base)
  return { path: u.pathname, query: u.searchParams }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handlePostEvents(
  req: IncomingMessage,
  res: ServerResponse,
  store: EventStore,
): Promise<void> {
  let body: string
  try {
    body = await readBody(req)
  } catch {
    return json(res, 400, { error: 'Failed to read request body' })
  }

  let rawInputs: unknown[]
  try {
    const parsed = JSON.parse(body)
    rawInputs = Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return json(res, 400, { error: 'Invalid JSON' })
  }

  const { results, errors } = processBatch(rawInputs)

  // Persist valid events
  for (const r of results) {
    store.events.push(r.event)
    store.processed.push(r)
  }

  // Build response: one entry per input with IPC decision
  const response = results.map(r => ({
    event_id:
      r.event.record_type === 'patient_event'
        ? r.event.patient_pseudo_id
        : r.event.vehicle_id ?? 'ops',
    record_type: r.event.record_type,
    evac_state: r.event.evac_state,
    ipc_decision: r.ipcDecision,
    proa_status: r.proaStatus,
    decon_spec: r.deconSpec,
  }))

  return json(res, 200, {
    accepted: results.length,
    rejected: errors.length,
    errors,
    results: response,
  })
}

function handleGetEvents(
  _req: IncomingMessage,
  res: ServerResponse,
  store: EventStore,
): void {
  json(res, 200, {
    simulation_id: store.simulationId,
    total: store.events.length,
    events: store.events,
  })
}

function handleGetMetrics(
  _req: IncomingMessage,
  res: ServerResponse,
  store: EventStore,
): void {
  const metrics = computeMetrics(store.events, store.simulationId)
  json(res, 200, metrics)
}

function handleGetMetricsCsv(
  _req: IncomingMessage,
  res: ServerResponse,
  store: EventStore,
): void {
  const metrics = computeMetrics(store.events, store.simulationId)
  csv(res, `metrics_${store.simulationId}.csv`, metricsToCSV(metrics))
}

function handleGetEventsCsv(
  _req: IncomingMessage,
  res: ServerResponse,
  store: EventStore,
): void {
  csv(res, `events_${store.simulationId}.csv`, eventsToCSV(store.events))
}

function handleReset(
  _req: IncomingMessage,
  res: ServerResponse,
  store: EventStore,
  simulationId: string,
): void {
  store.simulationId = simulationId ?? `SIM-${Date.now()}`
  store.events = []
  store.processed = []
  store.startedAt = new Date().toISOString()
  json(res, 200, { reset: true, simulation_id: store.simulationId })
}

function handleHealth(
  _req: IncomingMessage,
  res: ServerResponse,
  store: EventStore,
): void {
  json(res, 200, {
    status: 'ok',
    simulation_id: store.simulationId,
    events_stored: store.events.length,
    started_at: store.startedAt,
    uptime_seconds: Math.floor(process.uptime()),
  })
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export interface MedevacServerConfig {
  port?: number
  host?: string
  simulationId?: string
}

export interface MedevacServer {
  start(): void
  stop(): void
  getStore(): EventStore
}

/**
 * Create a medevac IPC HTTP server.
 *
 * @example
 * const server = createMedevacServer({ port: 3737, simulationId: 'SIM-2026-01' })
 * server.start()
 */
export function createMedevacServer(
  config: MedevacServerConfig = {},
): MedevacServer {
  const port = config.port ?? 3737
  const host = config.host ?? '0.0.0.0'
  const store = createStore(config.simulationId ?? `SIM-${Date.now()}`)

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const { path, query } = parseUrl(req)
    const method = req.method?.toUpperCase() ?? 'GET'

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' })
      res.end()
      return
    }

    try {
      if (method === 'POST' && path === '/events') {
        return await handlePostEvents(req, res, store)
      }
      if (method === 'GET' && path === '/events') {
        return handleGetEvents(req, res, store)
      }
      if (method === 'GET' && path === '/events.csv') {
        return handleGetEventsCsv(req, res, store)
      }
      if (method === 'GET' && path === '/metrics') {
        return handleGetMetrics(req, res, store)
      }
      if (method === 'GET' && path === '/metrics.csv') {
        return handleGetMetricsCsv(req, res, store)
      }
      if (method === 'POST' && path === '/reset') {
        const newSimId = query.get('simulation_id') ?? undefined
        return handleReset(req, res, store, newSimId ?? `SIM-${Date.now()}`)
      }
      if (method === 'GET' && path === '/health') {
        return handleHealth(req, res, store)
      }

      json(res, 404, {
        error: 'Not found',
        available_endpoints: [
          'POST /events',
          'GET  /events',
          'GET  /events.csv',
          'GET  /metrics',
          'GET  /metrics.csv',
          'POST /reset?simulation_id=SIM-xxx',
          'GET  /health',
        ],
      })
    } catch (err) {
      json(res, 500, {
        error: 'Internal server error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  })

  return {
    start() {
      httpServer.listen(port, host, () => {
        console.log(`[MedevacServer] Listening on http://${host}:${port}`)
        console.log(`[MedevacServer] Simulation: ${store.simulationId}`)
        console.log(`[MedevacServer] POST /events to submit patient/ops events`)
        console.log(`[MedevacServer] GET  /metrics for live aggregates`)
      })
    },
    stop() {
      httpServer.close()
    },
    getStore() {
      return store
    },
  }
}
