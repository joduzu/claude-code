/**
 * Medevac IPC Simulation Processor
 *
 * Provides:
 *  1. Event validation (Zod-based, partial-input tolerant)
 *  2. Rule-based IPC flag generation (deterministic engine — auditable, offline-capable)
 *  3. Simulation metrics computation
 *  4. CSV export for audit and due-diligence reporting
 *
 * Design principles:
 *  - "Partial-input tolerant": nullable fields are treated as uncertainty signals,
 *    not errors. When key data is absent the engine defaults to the most
 *    conservative recommendation and flags for human confirmation.
 *  - "Human-in-the-loop": critical flags always require acknowledgement; the
 *    processor emits the flag but never auto-commits an action.
 *  - "Offline-first": no async I/O. All logic is pure/synchronous so it can
 *    run on an edge node without connectivity.
 */

import {
  ALERT_PRIORITY,
  ALERT_SLO_SECONDS,
  DEFAULT_PRECAUTION_BY_SYNDROME,
  DECON_CONTACT_TIME_MINUTES,
  type AlertType,
  type EvacState,
  type PrecautionType,
  type SyndromeCategory,
} from './constants.js'
import {
  MedevacSimulationEventSchema,
  OpsEventSchema,
  PatientEventSchema,
  type MedevacSimulationEvent,
  type OpsEvent,
  type PatientEvent,
  type SimulationMetrics,
} from './schemas.js'

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ValidationSuccess<T> = { ok: true; data: T }
export type ValidationFailure = { ok: false; error: string }
export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure

/**
 * Validate raw input as a {@link MedevacSimulationEvent}.
 * Returns a typed result so callers can branch without try/catch.
 */
export function validateEvent(
  input: unknown,
): ValidationResult<MedevacSimulationEvent> {
  const result = MedevacSimulationEventSchema().safeParse(input)
  if (result.success) return { ok: true, data: result.data }
  return { ok: false, error: result.error.message }
}

// ---------------------------------------------------------------------------
// IPC Rule Engine
// ---------------------------------------------------------------------------

export interface IPCDecision {
  /** Recommended transmission-based precaution level. */
  precaution: PrecautionType
  /** Whether to place the patient in isolation (single room or dedicated area). */
  requiresIsolation: boolean
  /** Whether the patient can share a cohort group with similar-syndrome patients. */
  eligibleForCohorting: boolean
  /** IPC alert type to emit, or null if no alert needed. */
  alertType: AlertType | null
  /** Confidence in [0, 1]. Reduced when key data (pathogen, LIS) is absent. */
  confidence: number
  /** Human-readable rationale for the decision (for transparency/logging). */
  rationale: string
  /** True when the decision is based on missing data — must have human confirmation. */
  requiresHumanConfirmation: boolean
}

/**
 * Derive an IPC decision for a patient event using conservative rule-based logic.
 *
 * Priority order:
 *  1. Known MDRO/pathogen → highest-specificity precaution
 *  2. Syndrome category → default precaution from WHO syndromic screening guidance
 *  3. No data → standard precautions + human confirmation required
 */
export function deriveIPCDecision(event: PatientEvent): IPCDecision {
  const { known_pathogen_or_mdro, syndrome_category, evac_state } = event
  const pathogen = known_pathogen_or_mdro?.toUpperCase() ?? null

  // --- Pathogen-specific rules (highest confidence) ---
  if (pathogen) {
    // Carbapenem-resistant Enterobacterales (CRE/CPE) — contact_enhanced
    if (/CPE|CRE|NDM|KPC|OXA-48|VIM|IMP/.test(pathogen)) {
      return {
        precaution: 'contact_enhanced',
        requiresIsolation: true,
        eligibleForCohorting: true,
        alertType: 'isolation_flag',
        confidence: 0.92,
        rationale: `Known/suspected CPE/CRE (${pathogen}): contact_enhanced precautions, single room or CPE cohort.`,
        requiresHumanConfirmation: false,
      }
    }
    // MRSA / VRE — contact_enhanced
    if (/MRSA|VRE/.test(pathogen)) {
      return {
        precaution: 'contact_enhanced',
        requiresIsolation: true,
        eligibleForCohorting: true,
        alertType: 'isolation_flag',
        confidence: 0.90,
        rationale: `Known ${pathogen}: contact_enhanced precautions required.`,
        requiresHumanConfirmation: false,
      }
    }
    // Airborne pathogens — airborne precautions
    if (/TB|TUBERCULOSIS|MEASLES|VARICELLA|SARS|COVID|INFLUENZA-A/.test(pathogen)) {
      return {
        precaution: 'airborne',
        requiresIsolation: true,
        eligibleForCohorting: true,
        alertType: 'isolation_flag',
        confidence: 0.88,
        rationale: `Known/suspected airborne pathogen (${pathogen}): airborne precautions, negative-pressure room or equivalent.`,
        requiresHumanConfirmation: false,
      }
    }
    // Known non-MDR colonisation — standard contact
    return {
      precaution: 'contact',
      requiresIsolation: false,
      eligibleForCohorting: true,
      alertType: 'cohort_flag',
      confidence: 0.80,
      rationale: `Known pathogen (${pathogen}) without MDR flag: contact precautions; cohorting eligible.`,
      requiresHumanConfirmation: false,
    }
  }

  // --- Syndromic screening rules (moderate confidence) ---
  if (syndrome_category) {
    const precaution = DEFAULT_PRECAUTION_BY_SYNDROME[syndrome_category]
    const needsIsolation =
      syndrome_category === 'respiratory' || syndrome_category === 'rash'
    return {
      precaution,
      requiresIsolation: needsIsolation,
      eligibleForCohorting: true,
      alertType: needsIsolation ? 'isolation_flag' : 'cohort_flag',
      confidence: 0.62,
      rationale: `Syndromic screening (${syndrome_category}): ${precaution} precautions. Pathogen unknown — conservative default. Human confirmation recommended.`,
      requiresHumanConfirmation: true,
    }
  }

  // --- No data — maximum uncertainty ---
  // In transit or awaiting transport: flag for pre-arrival review
  const isActiveTransit: EvacState[] = ['in_transit', 'awaiting_transport']
  if (isActiveTransit.includes(evac_state)) {
    return {
      precaution: 'standard',
      requiresIsolation: false,
      eligibleForCohorting: false,
      alertType: 'screening_required',
      confidence: 0.30,
      rationale:
        'No pathogen or syndrome data available. Standard precautions applied. MDRO screening required on arrival. Human confirmation mandatory.',
      requiresHumanConfirmation: true,
    }
  }

  return {
    precaution: 'standard',
    requiresIsolation: false,
    eligibleForCohorting: false,
    alertType: null,
    confidence: 0.30,
    rationale: 'Insufficient data for IPC classification. Standard precautions only.',
    requiresHumanConfirmation: true,
  }
}

// ---------------------------------------------------------------------------
// PROA continuity check
// ---------------------------------------------------------------------------

export interface ProaStatus {
  doseWindowBreached: boolean
  minutesUntilDue: number | null
  alertRequired: boolean
}

/**
 * Check whether a PROA continuity alert should be raised.
 * Fires when the next dose is due within the configured high-priority SLO window.
 */
export function checkProaContinuity(
  event: PatientEvent,
  nowUtc: Date = new Date(),
): ProaStatus {
  if (!event.antibiotic_regimen || !event.next_dose_due_utc) {
    return { doseWindowBreached: false, minutesUntilDue: null, alertRequired: false }
  }

  const dueMs = new Date(event.next_dose_due_utc).getTime()
  const nowMs = nowUtc.getTime()
  const minutesUntilDue = (dueMs - nowMs) / 60_000

  const windowMinutes = ALERT_SLO_SECONDS.high / 60
  const doseWindowBreached = minutesUntilDue <= windowMinutes
  const alertRequired = minutesUntilDue <= windowMinutes && minutesUntilDue >= 0

  return { doseWindowBreached, minutesUntilDue, alertRequired }
}

// ---------------------------------------------------------------------------
// Decontamination worklist derivation
// ---------------------------------------------------------------------------

export interface DeconSpec {
  agentSuggestion: string
  contactTimeMinutes: number
  alertType: AlertType
}

/**
 * Derive decontamination specification for a vehicle or area based on the
 * last-carried patient's IPC status.
 */
export function deriveDeconSpec(event: OpsEvent | PatientEvent): DeconSpec {
  const pathogen = (
    'known_pathogen_or_mdro' in event ? event.known_pathogen_or_mdro : null
  )?.toUpperCase()

  // Spore-forming organisms require sporicidal protocol
  const requiresSporicidal = pathogen
    ? /C\.DIFF|CDIFF|CLOSTRIDIUM/.test(pathogen)
    : false

  return {
    agentSuggestion: requiresSporicidal
      ? 'sodium hypochlorite 0.5% (5000 ppm)'
      : 'sodium hypochlorite 0.1% (1000 ppm)',
    contactTimeMinutes: requiresSporicidal
      ? DECON_CONTACT_TIME_MINUTES.sporicidal
      : DECON_CONTACT_TIME_MINUTES.standard,
    alertType: 'cleaning_worklist',
  }
}

// ---------------------------------------------------------------------------
// Simulation metrics computation
// ---------------------------------------------------------------------------

/**
 * Compute aggregate {@link SimulationMetrics} from a batch of simulation events.
 * Accepts mixed patient and ops events as produced by a simulation run.
 *
 * Alert latency is computed only for events where both `timestamp_utc` and
 * `alert_ack_time_utc` are present (partial-input tolerance).
 */
export function computeMetrics(
  events: MedevacSimulationEvent[],
  simulationId: string,
): SimulationMetrics {
  const patientEvents = events.filter(
    (e): e is PatientEvent => e.record_type === 'patient_event',
  )
  const opsEvents = events.filter(
    (e): e is OpsEvent => e.record_type === 'ops_event',
  )

  const totalEvacuees = patientEvents.length
  const totalOpsEvents = opsEvents.length

  // --- Alert load ---
  const alertsGenerated = patientEvents.filter(e => e.alert_generated).length
  const alertsPer100 =
    totalEvacuees > 0 ? (alertsGenerated / totalEvacuees) * 100 : 0

  const criticalAlerts = patientEvents.filter(
    e => e.alert_type && ALERT_PRIORITY[e.alert_type] === 'critical',
  ).length

  // --- Alert latency (seconds) ---
  const latencies: number[] = patientEvents
    .filter(e => e.alert_generated && e.alert_ack_time_utc)
    .map(e => {
      const generated = new Date(e.timestamp_utc).getTime()
      const acked = new Date(e.alert_ack_time_utc!).getTime()
      return Math.max(0, (acked - generated) / 1000)
    })
    .sort((a, b) => a - b)

  const p50 = percentile(latencies, 50)
  const p90 = percentile(latencies, 90)

  // --- PROA continuity ---
  const proaEvents = patientEvents.filter(e => e.antibiotic_regimen)
  const proaTotal = proaEvents.length
  // Heuristic: doses "in window" are those where next_dose_due is present and
  // alert was acknowledged before the dose was due
  const proaInWindow = proaEvents.filter(e => {
    if (!e.next_dose_due_utc || !e.alert_ack_time_utc) return false
    return new Date(e.alert_ack_time_utc) <= new Date(e.next_dose_due_utc)
  }).length
  const proaPct = proaTotal > 0 ? (proaInWindow / proaTotal) * 100 : null

  // --- Decon task closure ---
  const deconOpsEvents = opsEvents.filter(e => e.alert_type === 'cleaning_worklist')
  const deconClosed = deconOpsEvents.filter(e => e.decon_completed === true).length
  const deconPct =
    deconOpsEvents.length > 0
      ? (deconClosed / deconOpsEvents.length) * 100
      : null

  // --- Data completeness ---
  const keyFields: (keyof PatientEvent)[] = [
    'evac_state',
    'syndrome_category',
    'destination_facility',
  ]
  const completeCount = patientEvents.filter(e =>
    keyFields.every(f => e[f] !== null && e[f] !== undefined),
  ).length
  const completePct =
    totalEvacuees > 0 ? (completeCount / totalEvacuees) * 100 : null

  // --- Human overrides ---
  const overridableAlerts = patientEvents.filter(
    e => e.alert_generated && e.alert_ack_by_role,
  ).length
  // "Override" heuristic: alert acknowledged but action_taken contains "override"
  const overrides = patientEvents.filter(
    e =>
      e.alert_generated &&
      e.action_taken?.toLowerCase().includes('override'),
  ).length
  const overridePct =
    overridableAlerts > 0 ? (overrides / overridableAlerts) * 100 : null

  return {
    simulation_id: simulationId,
    generated_at_utc: new Date().toISOString(),
    total_evacuees: totalEvacuees,
    total_ops_events: totalOpsEvents,
    alerts_per_100_evacuees: Math.round(alertsPer100 * 10) / 10,
    critical_alerts_count: criticalAlerts,
    time_to_alert_p50_seconds: p50,
    time_to_alert_p90_seconds: p90,
    ppv_critical_flags: null, // requires ground-truth labels from simulation design
    sensitivity_critical_flags: null,
    proa_doses_in_window_pct: proaPct !== null ? Math.round(proaPct * 10) / 10 : null,
    proa_interruptions_count: proaTotal > 0 ? proaTotal - proaInWindow : null,
    decon_tasks_closed_pct:
      deconPct !== null ? Math.round(deconPct * 10) / 10 : null,
    pct_key_fields_complete:
      completePct !== null ? Math.round(completePct * 10) / 10 : null,
    human_override_pct:
      overridePct !== null ? Math.round(overridePct * 10) / 10 : null,
  }
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

/** CSV column order — matches the operational annex template. */
const CSV_COLUMNS: (keyof PatientEvent | keyof OpsEvent | string)[] = [
  'record_type',
  'simulation_id',
  'timestamp_utc',
  'site_id',
  'patient_pseudo_id',
  'evac_state',
  'syndrome_category',
  'known_pathogen_or_mdro',
  'precaution_recommended',
  'cohort_group_id',
  'vehicle_id',
  'origin_facility',
  'destination_facility',
  'antibiotic_regimen',
  'next_dose_due_utc',
  'decon_agent',
  'decon_contact_minutes',
  'decon_completed',
  'alert_generated',
  'alert_type',
  'alert_confidence',
  'alert_ack_by_role',
  'alert_ack_time_utc',
  'action_taken',
  'action_time_utc',
  'notes',
]

function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) return ''
  const str = String(value)
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

/**
 * Serialise a batch of simulation events to CSV format.
 * The header row follows the operational annex template column order.
 * Fields not present in a given record type are emitted as empty strings.
 */
export function eventsToCSV(events: MedevacSimulationEvent[]): string {
  const header = CSV_COLUMNS.join(',')
  const rows = events.map(event => {
    const record = event as Record<string, unknown>
    return CSV_COLUMNS.map(col => escapeCsv(record[col])).join(',')
  })
  return [header, ...rows].join('\n')
}

/**
 * Serialise {@link SimulationMetrics} to a two-column key/value CSV.
 * Suitable for appending to a metrics report or importing into a spreadsheet.
 */
export function metricsToCSV(metrics: SimulationMetrics): string {
  const rows = Object.entries(metrics).map(([key, value]) => {
    return `${escapeCsv(key)},${escapeCsv(value)}`
  })
  return ['metric,value', ...rows].join('\n')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return Math.round(sorted[Math.max(0, idx)] * 10) / 10
}

// ---------------------------------------------------------------------------
// Batch processor — convenience wrapper
// ---------------------------------------------------------------------------

export interface ProcessedEvent {
  event: MedevacSimulationEvent
  ipcDecision: IPCDecision | null
  proaStatus: ProaStatus | null
  deconSpec: DeconSpec | null
}

/**
 * Process a batch of raw inputs: validate, derive IPC decisions and operational
 * specs, and return structured results alongside any validation errors.
 */
export function processBatch(rawInputs: unknown[]): {
  results: ProcessedEvent[]
  errors: Array<{ index: number; error: string }>
} {
  const results: ProcessedEvent[] = []
  const errors: Array<{ index: number; error: string }> = []

  for (let i = 0; i < rawInputs.length; i++) {
    const validation = validateEvent(rawInputs[i])
    if (!validation.ok) {
      errors.push({ index: i, error: validation.error })
      continue
    }

    const event = validation.data
    let ipcDecision: IPCDecision | null = null
    let proaStatus: ProaStatus | null = null
    let deconSpec: DeconSpec | null = null

    if (event.record_type === 'patient_event') {
      ipcDecision = deriveIPCDecision(event)
      proaStatus = checkProaContinuity(event)
      if (event.vehicle_id) {
        deconSpec = deriveDeconSpec(event)
      }
    } else {
      // ops_event
      deconSpec = deriveDeconSpec(event)
    }

    results.push({ event, ipcDecision, proaStatus, deconSpec })
  }

  return { results, errors }
}
