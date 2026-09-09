import { randomUUID } from "node:crypto";

/**
 * Identifies this API process so durable leases can distinguish a slow live
 * operation from one whose in-process owner disappeared during a restart.
 */
export const VIDEO_PROCESS_INSTANCE_ID = randomUUID();