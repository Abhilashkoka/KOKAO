import {
  getWalletGetOverviewQueryKey,
  useWalletGetOverview,
} from "@workspace/api-client-react";

/**
 * Quota-exhausted copy that respects the workspace's billing mode.
 *
 * Wallet-billed (prepaid PAYG) workspaces don't have plan upgrades or credit
 * packs — telling their owners to "upgrade or buy a credit pack" is
 * misleading. These helpers mirror the mobile QuotaInfoSheet behavior: check
 * the wallet overview's `walletBilling` flag and point wallet-billed owners
 * at recharging the wallet instead.
 */

/** True when the current workspace is wallet-billed (prepaid). Falls back to false while loading or on error, which keeps the existing quota copy. */
export function useWalletBilling(): boolean {
  const wallet = useWalletGetOverview({
    query: { queryKey: getWalletGetOverviewQueryKey() },
  });
  return wallet.data?.walletBilling === true;
}

export const QUOTA_OWNER_UPGRADE_MESSAGE =
  "You've reached your monthly AI limit. Please upgrade your plan.";

export const QUOTA_OWNER_WALLET_MESSAGE =
  "You've reached your monthly AI limit. Recharge your prepaid wallet to keep generating.";

/**
 * Owner-facing description for a 402 quota toast.
 *
 * Quota-billed workspaces prefer the server's message (it explains upgrades /
 * credit packs, which the owner can act on). Wallet-billed workspaces always
 * get wallet-recharge guidance — the server text is credit-pack oriented and
 * wrong for them.
 */
export function ownerQuotaMessage(opts: {
  walletBilling: boolean;
  serverMessage?: string | null;
  upgradeFallback?: string;
}): string {
  if (opts.walletBilling) {
    // Wallet-billed workspaces never hit the plan-quota branch on the server,
    // so a wallet-flavored 402 message (e.g. "This video needs 4 generations
    // and your wallet balance can't cover it. Recharge to continue.") explains
    // the actual shortfall — prefer it over the generic recharge line.
    const msg = opts.serverMessage?.trim();
    if (msg && /wallet|recharge/i.test(msg)) return msg;
    return QUOTA_OWNER_WALLET_MESSAGE;
  }
  return opts.serverMessage || opts.upgradeFallback || QUOTA_OWNER_UPGRADE_MESSAGE;
}

/**
 * Toast title for a 402: wallet-billed workspaces ran out of prepaid balance,
 * not "quota" — calling it a quota reads like a plan limit they don't have.
 */
export function quotaToastTitle(walletBilling: boolean, quotaTitle: string): string {
  return walletBilling ? "Wallet balance too low" : quotaTitle;
}

/**
 * Member-facing description for a 402 quota toast. Members can't upgrade,
 * buy credits, or recharge the wallet themselves, so the guidance points at
 * the workspace owner — and names the action the owner can actually take
 * (recharge for wallet-billed, upgrade for quota-billed).
 */
export function memberQuotaMessage(opts: {
  walletBilling: boolean;
  canRequestUpgrade: boolean;
  quotaNoun?: string;
}): string {
  const noun = opts.quotaNoun ?? "AI quota";
  if (!opts.canRequestUpgrade) return `The workspace is out of ${noun}.`;
  return opts.walletBilling
    ? `The workspace has run out of ${noun}. Ask your workspace owner to recharge the prepaid wallet.`
    : `The workspace has run out of ${noun}. Ask your workspace owner to upgrade.`;
}

/** Inline hint under image-generation buttons when the monthly image quota (and credits) are exhausted. */
export function imageQuotaHint(walletBilling: boolean): string {
  return walletBilling
    ? "Monthly image limit reached. Recharge your prepaid wallet to keep generating images."
    : "Monthly image limit reached. Upgrade your plan or buy credits to keep generating images.";
}

/** Library "keep generating" quota description. */
export function quotaLimitDescription(walletBilling: boolean): string {
  return walletBilling
    ? "You've reached your plan's monthly AI limit. Recharge your prepaid wallet to keep generating."
    : "You've reached your plan's monthly AI limit. Upgrade your plan to keep generating.";
}
