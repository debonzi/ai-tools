export type StateErrorCode =
  | "admission_capacity"
  | "admission_duplicate"
  | "bootstrap_expired"
  | "bootstrap_invalid"
  | "bootstrap_used"
  | "capability_conflict"
  | "capability_exhausted"
  | "capability_expired"
  | "capability_invalid"
  | "capability_revoked"
  | "claim_conflict"
  | "claim_invalid"
  | "containment_violation"
  | "epoch_conflict"
  | "foreign_state"
  | "idempotency_conflict"
  | "invalid_actor"
  | "invalid_binding"
  | "invalid_record"
  | "invalid_transition"
  | "lease_busy"
  | "lease_expired"
  | "lease_invalid"
  | "lock_busy"
  | "not_found"
  | "oversized"
  | "rate_limited"
  | "replay_conflict"
  | "revision_conflict"
  | "stale_sequence"
  | "terminal_immutable"
  | "transaction_conflict"
  | "unsafe_path";

const SAFE_MESSAGES: Record<StateErrorCode, string> = {
  admission_capacity: "The requested admission exceeds a configured capacity limit.",
  admission_duplicate: "The requested delegation duplicates active intent.",
  bootstrap_expired: "The one-time bootstrap has expired.",
  bootstrap_invalid: "The one-time bootstrap could not be authenticated.",
  bootstrap_used: "The one-time bootstrap is no longer available.",
  capability_conflict: "Active capabilities already exist for this binding.",
  capability_exhausted: "The capability receipt limit has been reached.",
  capability_expired: "The capability has expired.",
  capability_invalid: "The capability could not be authenticated.",
  capability_revoked: "The capability has been revoked.",
  claim_conflict: "The durable item is already claimed or settled.",
  claim_invalid: "The durable claim could not be authenticated.",
  containment_violation: "A state path failed containment validation.",
  epoch_conflict: "The fencing epoch is stale or inconsistent.",
  foreign_state: "The private state path contains unrecognized or unsafe state.",
  idempotency_conflict: "The idempotency identifier was reused with different content.",
  invalid_actor: "The actor is not authorized for this lifecycle operation.",
  invalid_binding: "The exact run binding was rejected.",
  invalid_record: "A strict durable record was rejected.",
  invalid_transition: "The requested lifecycle transition is not permitted.",
  lease_busy: "The fenced lease is currently held.",
  lease_expired: "The fenced lease has expired.",
  lease_invalid: "The fenced lease could not be authenticated.",
  lock_busy: "The private state store is currently locked.",
  not_found: "The requested durable record does not exist.",
  oversized: "The bounded durable record is too large.",
  rate_limited: "The bounded capability message rate was exceeded.",
  replay_conflict: "The message identifier was replayed with different content.",
  revision_conflict: "The expected durable revision is stale.",
  stale_sequence: "The capability message sequence is stale or discontinuous.",
  terminal_immutable: "The terminal run outcome is immutable.",
  transaction_conflict: "An incomplete transaction conflicts with durable state.",
  unsafe_path: "A state path failed ownership, type, link, or mode validation.",
};

/** An intentionally path- and secret-free error suitable for bounded diagnostics. */
export class StateSecurityError extends Error {
  readonly code: StateErrorCode;

  constructor(code: StateErrorCode, options?: ErrorOptions) {
    super(SAFE_MESSAGES[code], options);
    this.name = "StateSecurityError";
    this.code = code;
  }
}

export function stateError(code: StateErrorCode, cause?: unknown): StateSecurityError {
  return new StateSecurityError(code, cause === undefined ? undefined : { cause });
}
