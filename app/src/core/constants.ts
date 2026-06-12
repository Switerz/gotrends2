// src/core/constants.ts

/** Parity tolerance for Python ↔ TS model output comparison. */
export const PARITY_TOLERANCE = 1e-6

/** Default expiration for a pending recommendation (hours). */
export const RECOMMENDATION_TTL_HOURS = 24

/**
 * Window after which an unengaged recommendation (still in `pending` or
 * `sent_to_chat`) is auto-expired by the next `run-models` sweep. The
 * campaign's underlying signal has drifted; a fresh decision beats a stale
 * one sitting on the operator's chat.
 *
 * `approved`/`executing` states are NEVER swept — they represent human
 * intent or in-flight mutation, and expiring them would mask bugs (e.g.
 * stuck executor) rather than surface them.
 */
export const RECOMMENDATION_STALE_HOURS = 12

/** Hard limit on a single recommendation's change_percent magnitude. */
export const MAX_ABS_CHANGE_PERCENT = 0.5

/** Confidence score threshold below which a recommendation goes to human review. */
export const CONFIDENCE_REVIEW_THRESHOLD = 40

/**
 * Cumulative tROAS drift caps. Applied as soft caps — a candidate that would
 * push the rolling sum past the threshold is downgraded to
 * `needs_human_review`, never `blocked`, so a human can still override with
 * full context.
 *
 * Why on tROAS and not budget: budget changes are passive (constrain spend;
 * auction selection stays the same → ROAS drifts ~5–10%). tROAS changes are
 * active signals to Smart Bidding (different keyword/audience mix → ROAS
 * drifts 30–50%, learning phase resets). The cap is sized to keep the
 * algorithm out of re-learning, per the Google Smart Bidding guidance.
 *
 * Both are absolute (|Δ|), per-mutate pct (`|Δ_i / pre_mutate_i|`). Sum is
 * over successful executions in the window — pending or sent_to_chat recs do
 * NOT count, but they will trip the cap at refine time of the NEXT rec if
 * already executed.
 */
export const MAX_DAILY_TROAS_DRIFT = 0.40
export const MAX_TROAS_DRIFT_7D = 0.30
