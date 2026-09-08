import type { PreflightRefusal } from '../core/policy/fetch-policy-gate.js'
import type { ReasonCodeValue } from '../core/reason-codes/registry.js'

/**
 * A source that did not produce usable data.
 *
 * Two distinct shapes reach the caller, and conflating them would hide a real
 * signal:
 *
 *   - `refused` — the preflight said no, with its own reason code (`host_denied`,
 *     `robots_disallowed`, `terms_prohibited`, `rate_limited`,
 *     `budget_exhausted`). Nothing was fetched, and Part G requires these to be
 *     counted separately so a source disappearing behind a robots or terms change
 *     is visible rather than mistaken for absent data.
 *   - `unusable` — the request happened and the answer was not data:
 *     `source_unavailable`.
 *
 * This is an error class rather than a return type because ingestion reads several
 * things in sequence and a source that fails has nothing to continue with. The
 * *caller* converts it to a reason code and an audit row; it never escapes a job.
 */
export type SourceFailure =
  | { kind: 'refused'; reason: PreflightRefusal['reason'] }
  | { kind: 'unusable'; reason: 'source_unavailable'; detail: string }

export class SourceError extends Error {
  constructor(
    readonly failure: SourceFailure,
    readonly sourceUrl: string,
  ) {
    super(
      failure.kind === 'refused'
        ? `Fetch of ${sourceUrl} was refused: ${failure.reason}`
        : `Source ${sourceUrl} returned unusable data: ${failure.detail}`,
    )
    this.name = 'SourceError'
  }

  get reasonCode(): ReasonCodeValue {
    return this.failure.reason
  }

  static refused(sourceUrl: string, reason: PreflightRefusal['reason']): SourceError {
    return new SourceError({ kind: 'refused', reason }, sourceUrl)
  }

  static unusable(sourceUrl: string, detail: string): SourceError {
    return new SourceError({ kind: 'unusable', reason: 'source_unavailable', detail }, sourceUrl)
  }
}

export function isSourceError(err: unknown): err is SourceError {
  return err instanceof SourceError
}
