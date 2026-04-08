/**
 * KoBoToolbox / ODK integration for medevac IPC simulation data.
 *
 * Fetches submissions from a KoBoToolbox asset (form), maps the raw KoBoToolbox
 * field names to the medevac event schema, validates each record, and returns
 * processed events ready for the IPC rule engine.
 *
 * Offline-first: if fetch fails, falls back to a local JSON cache written
 * on last successful sync (store-and-forward pattern).
 *
 * Usage:
 *   const client = new KoBoClient({ apiUrl, token, assetUid })
 *   const { results, errors, cached } = await client.syncAndProcess()
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { processBatch, type ProcessedEvent } from '../processor.js'
import type { ValidationFailure } from '../processor.js'
import type {
  EvacState,
  PrecautionType,
  SyndromeCategory,
} from '../constants.js'

// ---------------------------------------------------------------------------
// KoBoToolbox API types (raw submission shape)
// ---------------------------------------------------------------------------

/** Raw submission object as returned by KoBoToolbox v2 API. */
interface KoBoSubmission {
  _id: number
  _uuid: string
  _submission_time: string                    // ISO 8601
  _geolocation?: [number, number] | null
  // Form-specific fields — names come from your XLSForm question names.
  // The mapping below assumes the Spanish field names used in medevac forms.
  site_id?: string
  estado_evacuacion?: string                  // evac_state
  sindrome?: string                           // syndrome_category
  patogeno_mdro?: string                      // known_pathogen_or_mdro
  precaucion?: string                         // precaution_recommended
  grupo_cohorte?: string                      // cohort_group_id
  vehiculo_id?: string                        // vehicle_id
  instalacion_origen?: string                 // origin_facility
  instalacion_destino?: string                // destination_facility
  regimen_antibiotico?: string                // antibiotic_regimen
  proxima_dosis_utc?: string                  // next_dose_due_utc
  id_paciente?: string                        // patient_pseudo_id
  notas?: string                              // notes
  [key: string]: unknown
}

interface KoBoListResponse {
  count: number
  next: string | null
  previous: string | null
  results: KoBoSubmission[]
}

// ---------------------------------------------------------------------------
// Field mapping helpers
// ---------------------------------------------------------------------------

const EVAC_STATE_MAP: Record<string, EvacState> = {
  triaje: 'triaged',
  triaged: 'triaged',
  esperando_transporte: 'awaiting_transport',
  awaiting_transport: 'awaiting_transport',
  en_transito: 'in_transit',
  in_transit: 'in_transit',
  entrega: 'handover',
  handover: 'handover',
  aislado: 'isolated',
  isolated: 'isolated',
  cohortado: 'cohorted',
  cohorted: 'cohorted',
  alta: 'cleared',
  cleared: 'cleared',
}

const SYNDROME_MAP: Record<string, SyndromeCategory> = {
  respiratorio: 'respiratory',
  respiratory: 'respiratory',
  diarrea: 'diarrhoea',
  diarrhoea: 'diarrhoea',
  exantema: 'rash',
  rash: 'rash',
  otro: 'other',
  other: 'other',
}

function mapEvacState(raw: string | undefined): EvacState | null {
  if (!raw) return null
  return EVAC_STATE_MAP[raw.toLowerCase().trim()] ?? null
}

function mapSyndrome(raw: string | undefined): SyndromeCategory | null {
  if (!raw) return null
  return SYNDROME_MAP[raw.toLowerCase().trim()] ?? null
}

function mapPrecaution(raw: string | undefined): PrecautionType | null {
  if (!raw) return null
  const normalized = raw.toLowerCase().replace(/\s+/g, '_')
  const valid: PrecautionType[] = [
    'standard', 'contact', 'droplet', 'airborne',
    'droplet_contact', 'contact_enhanced',
  ]
  return valid.includes(normalized as PrecautionType)
    ? (normalized as PrecautionType)
    : null
}

/** Map a raw KoBoToolbox submission to a medevac patient event record. */
function mapSubmissionToEvent(
  sub: KoBoSubmission,
  simulationId: string,
): unknown {
  const evacState = mapEvacState(sub.estado_evacuacion)

  return {
    record_type: 'patient_event',
    simulation_id: simulationId,
    timestamp_utc: sub._submission_time,
    site_id: sub.site_id ?? 'UNKNOWN',
    patient_pseudo_id: sub.id_paciente ?? sub._uuid,
    evac_state: evacState ?? 'triaged',          // fallback — logged as incomplete
    syndrome_category: mapSyndrome(sub.sindrome),
    known_pathogen_or_mdro: sub.patogeno_mdro ?? null,
    precaution_recommended: mapPrecaution(sub.precaucion),
    cohort_group_id: sub.grupo_cohorte ?? null,
    vehicle_id: sub.vehiculo_id ?? null,
    origin_facility: sub.instalacion_origen ?? null,
    destination_facility: sub.instalacion_destino ?? null,
    antibiotic_regimen: sub.regimen_antibiotico ?? null,
    next_dose_due_utc: sub.proxima_dosis_utc ?? null,
    alert_generated: false,
    alert_type: null,
    alert_confidence: null,
    alert_ack_by_role: null,
    alert_ack_time_utc: null,
    action_taken: null,
    action_time_utc: null,
    notes: sub.notas ?? null,
  }
}

// ---------------------------------------------------------------------------
// KoBoClient
// ---------------------------------------------------------------------------

export interface KoBoClientConfig {
  /** KoBoToolbox API base URL, e.g. https://kf.kobotoolbox.org */
  apiUrl: string
  /** KoBoToolbox API token (from Account Settings → Security) */
  token: string
  /** Asset UID of the form to sync (from the form URL) */
  assetUid: string
  /** Local path for offline cache file (default: /tmp/kobo_cache_<assetUid>.json) */
  cachePath?: string
  /** Max submissions per page (default 200) */
  pageSize?: number
}

export interface SyncResult {
  results: ProcessedEvent[]
  errors: Array<{ index: number; error: string }>
  totalFetched: number
  /** True if data came from local cache (offline mode) */
  cached: boolean
  simulationId: string
}

export class KoBoClient {
  private config: Required<KoBoClientConfig>

  constructor(config: KoBoClientConfig) {
    this.config = {
      cachePath:
        config.cachePath ??
        join('/tmp', `kobo_cache_${config.assetUid}.json`),
      pageSize: config.pageSize ?? 200,
      ...config,
    }
  }

  // -------------------------------------------------------------------------
  // Fetch all submissions (handles pagination)
  // -------------------------------------------------------------------------

  private async fetchAllSubmissions(): Promise<KoBoSubmission[]> {
    const submissions: KoBoSubmission[] = []
    let url: string | null =
      `${this.config.apiUrl}/api/v2/assets/${this.config.assetUid}/data/` +
      `?format=json&limit=${this.config.pageSize}`

    while (url) {
      const response = await fetch(url, {
        headers: {
          Authorization: `Token ${this.config.token}`,
          Accept: 'application/json',
        },
      })

      if (!response.ok) {
        throw new Error(
          `KoBoToolbox API error: ${response.status} ${response.statusText}`,
        )
      }

      const page = (await response.json()) as KoBoListResponse
      submissions.push(...page.results)
      url = page.next
    }

    return submissions
  }

  // -------------------------------------------------------------------------
  // Cache management (offline fallback)
  // -------------------------------------------------------------------------

  private saveCache(submissions: KoBoSubmission[]): void {
    try {
      writeFileSync(
        this.config.cachePath,
        JSON.stringify({ savedAt: new Date().toISOString(), submissions }, null, 2),
        'utf8',
      )
    } catch {
      // Non-fatal: cache write failure should not block processing
    }
  }

  private loadCache(): KoBoSubmission[] | null {
    try {
      if (!existsSync(this.config.cachePath)) return null
      const raw = readFileSync(this.config.cachePath, 'utf8')
      const parsed = JSON.parse(raw) as { submissions: KoBoSubmission[] }
      return parsed.submissions ?? null
    } catch {
      return null
    }
  }

  // -------------------------------------------------------------------------
  // Public: sync + process
  // -------------------------------------------------------------------------

  /**
   * Fetch submissions from KoBoToolbox, map them to medevac events, validate,
   * and run the IPC rule engine. Falls back to local cache on network failure.
   */
  async syncAndProcess(simulationId?: string): Promise<SyncResult> {
    const simId = simulationId ?? `KOBO-${this.config.assetUid}-${Date.now()}`
    let submissions: KoBoSubmission[]
    let cached = false

    try {
      submissions = await this.fetchAllSubmissions()
      this.saveCache(submissions)
    } catch (err) {
      const fallback = this.loadCache()
      if (!fallback) throw err
      submissions = fallback
      cached = true
      console.warn(
        `[KoBoClient] Network error — using cached data (${submissions.length} records):`,
        err instanceof Error ? err.message : err,
      )
    }

    const rawEvents = submissions.map(sub =>
      mapSubmissionToEvent(sub, simId),
    )

    const { results, errors } = processBatch(rawEvents)

    return {
      results,
      errors,
      totalFetched: submissions.length,
      cached,
      simulationId: simId,
    }
  }

  /**
   * Load and process a local JSON export from KoBoToolbox
   * (downloaded via "Export data → JSON" in the UI).
   */
  processLocalExport(
    filePath: string,
    simulationId?: string,
  ): SyncResult {
    const simId = simulationId ?? `LOCAL-${Date.now()}`
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as { results?: KoBoSubmission[] } | KoBoSubmission[]
    const submissions = Array.isArray(parsed)
      ? parsed
      : (parsed.results ?? [])

    const rawEvents = submissions.map(sub =>
      mapSubmissionToEvent(sub, simId),
    )
    const { results, errors } = processBatch(rawEvents)

    return {
      results,
      errors,
      totalFetched: submissions.length,
      cached: false,
      simulationId: simId,
    }
  }
}
