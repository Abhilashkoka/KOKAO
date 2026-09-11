/** A durable spend receipt already proves this logical provider operation ran. */
export class MeterDispatchReplayError extends Error {
  readonly status = 409;
  readonly code = "METER_DISPATCH_REPLAY";

  constructor() {
    super("Metered provider operation was already dispatched");
    this.name = "MeterDispatchReplayError";
  }
}

export function isMeterDispatchReplayError(
  error: unknown,
): error is MeterDispatchReplayError {
  return (
    error !== null &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "METER_DISPATCH_REPLAY"
  );
}