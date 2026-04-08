/**
 * Medevac IPC (Infection Prevention & Control) Simulation Module — Public API
 *
 * Provides a deterministic, offline-capable rule engine for AI-supported IPC
 * decision support in medical evacuation contexts. Designed for:
 *
 *  - Partial-input tolerance: operates with incomplete data and reports uncertainty
 *  - Human-in-the-loop: all critical flags require operator acknowledgement
 *  - Offline-first: pure synchronous logic, no network I/O
 *  - Audit-ready: CSV/JSON export of all events, decisions, and metrics
 *
 * Quick-start example:
 *
 *   import { processBatch, computeMetrics, eventsToCSV } from './services/medevac/index.js'
 *
 *   const { results, errors } = processBatch(rawEvents)
 *   const validEvents = results.map(r => r.event)
 *   const metrics = computeMetrics(validEvents, 'SIM-2026-01')
 *   const csv = eventsToCSV(validEvents)
 */

// Schemas & types
export {
  AlertSchema,
  MedevacSimulationEventSchema,
  OpsEventSchema,
  PatientEventSchema,
  SimulationMetricsSchema,
  type Alert,
  type MedevacSimulationEvent,
  type OpsEvent,
  type PatientEvent,
  type SimulationMetrics,
} from './schemas.js'

// Constants & enums
export {
  ALERT_PRIORITY,
  ALERT_SLO_SECONDS,
  ALERT_TYPES,
  DEFAULT_PRECAUTION_BY_SYNDROME,
  DECON_CONTACT_TIME_MINUTES,
  EVAC_STATES,
  PRECAUTION_TYPES,
  RECORD_TYPES,
  ROLES,
  SYNDROME_CATEGORIES,
  type AlertType,
  type EvacState,
  type PrecautionType,
  type RecordType,
  type Role,
  type SyndromeCategory,
} from './constants.js'

// Processor — validation, rule engine, metrics, CSV export
export {
  checkProaContinuity,
  computeMetrics,
  deriveDeconSpec,
  deriveIPCDecision,
  eventsToCSV,
  metricsToCSV,
  processBatch,
  validateEvent,
  type DeconSpec,
  type IPCDecision,
  type ProcessedEvent,
  type ProaStatus,
  type ValidationFailure,
  type ValidationResult,
  type ValidationSuccess,
} from './processor.js'
