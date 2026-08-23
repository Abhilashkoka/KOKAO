import {
  confirmWalletProviderOperationSucceeded,
  listPendingWalletProviderOperations,
  sweepWalletProviderOperations,
} from "./wallet";
import {
  findBrandVoiceTtsHistoryMatches,
  findClonedVoiceByExactName,
} from "./voiceClone";
import { logger } from "./logger";

export const BRAND_VOICE_PROVIDER_RECOVERY_STALE_MS = Number(
  process.env.BRAND_VOICE_PROVIDER_RECOVERY_STALE_MS ?? 5 * 60_000,
);
export const WALLET_PROVIDER_RECOVERY_INTERVAL_MS = Number(
  process.env.WALLET_PROVIDER_RECOVERY_INTERVAL_MS ?? 60_000,
);

/**
 * Resolve only pending voice clones old enough that their live request has
 * yielded. An exact-name match proves success. Absence and lookup errors remain
 * pending because list/search indexes cannot authoritatively prove failure.
 */
export async function recoverBrandVoiceCloneProviderOperations(
  now = new Date(),
): Promise<{ found: number; absent: number; pending: number }> {
  const rows = await listPendingWalletProviderOperations("brand_voice_clone");
  let found = 0;
  let absent = 0;
  let pending = 0;
  for (const row of rows) {
    if (
      !row.operationKey ||
      now.getTime() - row.createdAt.getTime() < BRAND_VOICE_PROVIDER_RECOVERY_STALE_MS
    ) {
      pending += 1;
      continue;
    }
    try {
      // The route records the selected provider before its external call, so a
      // later provider-selection change cannot make an old receipt look absent.
      if (!row.provider) {
        pending += 1;
        continue;
      }
      const voice = await findClonedVoiceByExactName(row.provider, row.operationKey);
      if (voice) {
        await confirmWalletProviderOperationSucceeded(row.id, {
          provider: voice.provider,
          model: "voice-clone",
          providerResultId: voice.voiceId,
        });
        found += 1;
      } else {
        absent += 1;
        pending += 1;
      }
    } catch (error) {
      pending += 1;
      logger.warn(
        { err: error, operationId: row.id },
        "Brand Voice provider-operation lookup failed; leaving pending",
      );
    }
  }
  await sweepWalletProviderOperations(now);
  return { found, absent, pending };
}

/**
 * Reconcile response-loss TTS through ElevenLabs' authoritative history. A
 * provider history item can be claimed only once by the database unique index;
 * collisions remain pending rather than guessing which tenant request won.
 */
export async function recoverBrandVoiceTtsProviderOperations(
  now = new Date(),
): Promise<{ found: number; absent: number; pending: number }> {
  const rows = await listPendingWalletProviderOperations("brand_voice_tts");
  let found = 0;
  let absent = 0;
  let pending = 0;
  for (const row of rows) {
    if (
      !row.operationKey ||
      !row.provider ||
      now.getTime() - row.createdAt.getTime() < BRAND_VOICE_PROVIDER_RECOVERY_STALE_MS
    ) {
      pending += 1;
      continue;
    }
    try {
      const matches = await findBrandVoiceTtsHistoryMatches(
        row.provider,
        row.operationKey,
        row.createdAt,
      );
      let confirmed = false;
      if (matches.length === 1) {
        try {
          await confirmWalletProviderOperationSucceeded(row.id, {
            provider: row.provider,
            model: row.model,
            providerResultId: matches[0]!.providerResultId,
          });
          confirmed = true;
          found += 1;
        } catch (error) {
          if ((error as { code?: string }).code !== "23505") throw error;
        }
      }
      if (!confirmed) {
        if (matches.length === 0) absent += 1;
        pending += 1;
      }
    } catch (error) {
      pending += 1;
      logger.warn(
        { err: error, operationId: row.id },
        "Brand Voice TTS provider-operation lookup failed; leaving pending",
      );
    }
  }
  await sweepWalletProviderOperations(now);
  return { found, absent, pending };
}

let recoveryTimer: NodeJS.Timeout | null = null;
let recoveryRunning = false;

export function startWalletProviderRecovery(
  intervalMs = WALLET_PROVIDER_RECOVERY_INTERVAL_MS,
): void {
  if (recoveryTimer) return;
  recoveryTimer = setInterval(() => {
    if (recoveryRunning) return;
    recoveryRunning = true;
    void recoverBrandVoiceCloneProviderOperations()
      .then(() => recoverBrandVoiceTtsProviderOperations())
      .catch((error) => logger.error({ err: error }, "Wallet provider recovery failed"))
      .finally(() => {
        recoveryRunning = false;
      });
  }, intervalMs);
  recoveryTimer.unref?.();
}

export function stopWalletProviderRecovery(): void {
  if (!recoveryTimer) return;
  clearInterval(recoveryTimer);
  recoveryTimer = null;
}