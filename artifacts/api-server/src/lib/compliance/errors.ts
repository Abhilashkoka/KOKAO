/** Compliance errors always stop generation, approval or publishing. */
export class ComplianceUnavailableError extends Error {
  readonly status = 503;
  readonly code = "compliance_unavailable";
  constructor(message = "Compliance checks are temporarily unavailable, so nothing was generated. Please try again in a minute.") {
    super(message);
    this.name = "ComplianceUnavailableError";
  }
}

/** Unknown pinned rules or a corrupt snapshot. */
export class ComplianceConfigError extends Error {
  readonly status = 409;
  readonly code = "compliance_config";
  constructor(message: string) {
    super(message);
    this.name = "ComplianceConfigError";
  }
}