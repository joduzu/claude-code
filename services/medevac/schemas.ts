/**
 * Zod schemas for medevac IPC simulation events.
 *
 * The event model treats the evacuation state as the primary axis, supporting
 * partial-input tolerance: every nullable field is explicitly nullable so the
 * rule engine can reason about "missingness" as a signal (e.g., absent LIS data
 * → elevated uncertainty → conservative precaution).
 *
 * Schema structure mirrors the JSON schema published in the operational annex
 * of the medevac IPC adaptation document, with TypeScript-safe discriminated
 * unions for the two record types.
 */

import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  ALERT_TYPES,
  EVAC_STATES,
  PRECAUTION_TYPES,
  RECORD_TYPES,
  ROLES,
  SYNDROME_CATEGORIES,
} from './constants.js'

// ---------------------------------------------------------------------------
// Shared sub-schemas
// ---------------------------------------------------------------------------

/** UTC datetime string (ISO 8601). Accepts null for optional timestamps. */
const NullableDatetime = lazySchema(() =>
  z
    .string()
    .datetime({ offset: true })
    .nullable()
    .describe('UTC datetime in ISO 8601 format, or null if unknown'),
)

/** Confidence score [0, 1] for rule/model outputs. Null when not computed. */
const NullableConfidence = lazySchema(() =>
  z
    .number()
    .min(0)
    .max(1)
    .nullable()
    .describe('Rule/model confidence in [0, 1], or null when not computed'),
)

// ---------------------------------------------------------------------------
// Alert sub-schema (shared between patient and ops events)
// ---------------------------------------------------------------------------

export const AlertSchema = lazySchema(() =>
  z.object({
    alert_generated: z
      .boolean()
      .describe('Whether the IPC rule engine generated an alert for this event'),
    alert_type: z
      .enum(ALERT_TYPES)
      .nullable()
      .describe('Category of IPC alert, or null when no alert was generated'),
    alert_confidence: NullableConfidence(),
    alert_ack_by_role: z
      .enum(ROLES)
      .nullable()
      .describe('Role of the person who acknowledged the alert, or null'),
    alert_ack_time_utc: NullableDatetime(),
  }),
)

export type Alert = z.infer<ReturnType<typeof AlertSchema>>

// ---------------------------------------------------------------------------
// Patient event schema
// ---------------------------------------------------------------------------

/**
 * Records a state transition or clinical update for a single evacuated patient.
 * Used to trigger IPC flags (isolation, cohorting, PROA continuity) and feed
 * contact-tracing logs.
 */
export const PatientEventSchema = lazySchema(() =>
  z.object({
    record_type: z.literal('patient_event'),
    simulation_id: z.string().min(1).describe('Unique identifier for the simulation run'),
    timestamp_utc: z
      .string()
      .datetime({ offset: true })
      .describe('UTC timestamp of this event'),
    site_id: z.string().min(1).describe('Site or node where the event occurred'),
    patient_pseudo_id: z
      .string()
      .nullable()
      .describe('Pseudonymised patient identifier (null for aggregated events)'),

    // Evacuation workflow state
    evac_state: z
      .enum(EVAC_STATES)
      .describe('Current phase in the evacuation/IPC workflow'),

    // Syndromic / microbiological risk
    syndrome_category: z
      .enum(SYNDROME_CATEGORIES)
      .nullable()
      .describe(
        'Syndromic screening category for pre-microbiological triage, or null if unknown',
      ),
    known_pathogen_or_mdro: z
      .string()
      .nullable()
      .describe(
        'Confirmed or suspected pathogen / MDRO designation (e.g., "CPE-NDM", "MRSA"), or null',
      ),
    precaution_recommended: z
      .enum(PRECAUTION_TYPES)
      .nullable()
      .describe(
        'Transmission-based precaution level derived by the rule engine, or null if insufficient data',
      ),

    // Cohorting / transport logistics
    cohort_group_id: z
      .string()
      .nullable()
      .describe('Cohorting group assignment, or null if not yet assigned'),
    vehicle_id: z
      .string()
      .nullable()
      .describe('Transport vehicle identifier, or null if not assigned'),
    origin_facility: z
      .string()
      .nullable()
      .describe('Identifier of the sending facility or pick-up site'),
    destination_facility: z
      .string()
      .nullable()
      .describe('Identifier of the receiving facility'),

    // Antimicrobial stewardship (PROA)
    antibiotic_regimen: z
      .string()
      .nullable()
      .describe(
        'Current antibiotic regimen (free text / normalised), or null if none/unknown',
      ),
    next_dose_due_utc: NullableDatetime(),

    // Alert output
    ...AlertSchema().shape,

    // Operational action taken in response
    action_taken: z
      .string()
      .nullable()
      .describe('Action taken after the alert was acknowledged, or null'),
    action_time_utc: NullableDatetime(),
    notes: z.string().nullable().describe('Free-text notes, or null'),
  }),
)

export type PatientEvent = z.infer<ReturnType<typeof PatientEventSchema>>

// ---------------------------------------------------------------------------
// Ops event schema
// ---------------------------------------------------------------------------

/**
 * Records an operational task event (vehicle decontamination, zone change,
 * cleaning worklist closure) that is not tied to a specific patient.
 */
export const OpsEventSchema = lazySchema(() =>
  z.object({
    record_type: z.literal('ops_event'),
    simulation_id: z.string().min(1).describe('Unique identifier for the simulation run'),
    timestamp_utc: z
      .string()
      .datetime({ offset: true })
      .describe('UTC timestamp of this event'),
    site_id: z.string().min(1).describe('Site or node where the event occurred'),
    patient_pseudo_id: z
      .string()
      .nullable()
      .describe('Related patient pseudo-ID, or null for environment-only tasks'),

    // Operational context
    evac_state: z
      .enum(EVAC_STATES)
      .describe('Workflow phase at the time this ops event was recorded'),
    vehicle_id: z
      .string()
      .nullable()
      .describe('Vehicle undergoing decon or involved in the ops event'),

    // Decontamination details
    decon_agent: z
      .string()
      .nullable()
      .describe(
        'Chemical agent used (e.g., "sodium hypochlorite 0.1%"), or null',
      ),
    decon_contact_minutes: z
      .number()
      .positive()
      .nullable()
      .describe('Required chemical contact time in minutes, or null'),
    decon_completed: z
      .boolean()
      .nullable()
      .describe('Whether decontamination was confirmed complete, or null if in progress'),

    // Alert output
    ...AlertSchema().shape,

    // Operational action taken
    action_taken: z
      .string()
      .nullable()
      .describe('Operational action taken (e.g., "vehicle_decon_start"), or null'),
    action_time_utc: NullableDatetime(),
    notes: z.string().nullable().describe('Free-text notes including decon details, or null'),
  }),
)

export type OpsEvent = z.infer<ReturnType<typeof OpsEventSchema>>

// ---------------------------------------------------------------------------
// Discriminated union — main entry point
// ---------------------------------------------------------------------------

/**
 * Top-level simulation event schema. Discriminates on `record_type`.
 * Accepts partial inputs: nullable fields are intentionally nullable so the
 * processor can apply uncertainty-aware logic when data is missing.
 */
export const MedevacSimulationEventSchema = lazySchema(() =>
  z.discriminatedUnion('record_type', [PatientEventSchema(), OpsEventSchema()]),
)

export type MedevacSimulationEvent = z.infer<
  ReturnType<typeof MedevacSimulationEventSchema>
>

// ---------------------------------------------------------------------------
// Aggregate metrics schema (output of simulation run analysis)
// ---------------------------------------------------------------------------

/**
 * Aggregated metrics from a complete simulation run.
 * Covers the mandatory measurement set: alert latency, alert load, PPV,
 * PROA continuity, and decontamination task closure.
 */
export const SimulationMetricsSchema = lazySchema(() =>
  z.object({
    simulation_id: z.string().describe('Simulation run this report covers'),
    generated_at_utc: z
      .string()
      .datetime({ offset: true })
      .describe('When the metrics were computed'),

    // Volume & flow
    total_evacuees: z.number().int().nonnegative(),
    total_ops_events: z.number().int().nonnegative(),

    // Alert load
    alerts_per_100_evacuees: z
      .number()
      .nonnegative()
      .describe(
        'Total IPC alerts generated per 100 patient events (fatigue metric)',
      ),
    critical_alerts_count: z.number().int().nonnegative(),

    // Latency (seconds) — P50 and P90
    time_to_alert_p50_seconds: z.number().nonnegative().nullable(),
    time_to_alert_p90_seconds: z.number().nonnegative().nullable(),

    // Accuracy (requires ground-truth labels from simulation design)
    ppv_critical_flags: z
      .number()
      .min(0)
      .max(1)
      .nullable()
      .describe('Positive predictive value for critical flags (isolation/cohort/route)'),
    sensitivity_critical_flags: z
      .number()
      .min(0)
      .max(1)
      .nullable()
      .describe('Sensitivity for critical flags against ground-truth simulation cases'),

    // PROA continuity
    proa_doses_in_window_pct: z
      .number()
      .min(0)
      .max(100)
      .nullable()
      .describe('Percentage of critical antibiotic doses administered within the dose window'),
    proa_interruptions_count: z.number().int().nonnegative().nullable(),

    // Decontamination tasks
    decon_tasks_closed_pct: z
      .number()
      .min(0)
      .max(100)
      .nullable()
      .describe('Percentage of cleaning/decon worklist tasks marked complete'),

    // Data quality
    pct_key_fields_complete: z
      .number()
      .min(0)
      .max(100)
      .nullable()
      .describe(
        'Percentage of patient events with all key fields present (evac_state, syndrome_category, destination_facility)',
      ),

    // Human factors
    human_override_pct: z
      .number()
      .min(0)
      .max(100)
      .nullable()
      .describe(
        'Percentage of critical alerts where operator overrode the recommended action',
      ),
  }),
)

export type SimulationMetrics = z.infer<ReturnType<typeof SimulationMetricsSchema>>

// ---------------------------------------------------------------------------
// Re-export record type enum for convenience
// ---------------------------------------------------------------------------
export { RECORD_TYPES }
