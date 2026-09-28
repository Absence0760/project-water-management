// Pure helpers for the pending-invite lists on the project Members panel and
// the team page (PendingInvites.svelte).
import type { Invite } from '$lib/api/types';

/** Put `inv` in the list (replacing the one for the same id or address), newest first. */
export function upsertInvite(list: readonly Invite[], inv: Invite): Invite[] {
	const email = inv.email.toLowerCase();
	return [inv, ...list.filter((x) => x.id !== inv.id && x.email.toLowerCase() !== email)];
}

/** Whole days until `expiresAt` (rounded up), or 0 once it has passed. */
export function daysLeft(expiresAt: string, now: number = Date.now()): number {
	const ms = new Date(expiresAt).getTime() - now;
	return ms > 0 ? Math.ceil(ms / 86_400_000) : 0;
}

/** "expires in 6 days" / "expires within a day" / "expired" for one invite. */
export function expiryText(inv: Pick<Invite, 'expiresAt' | 'expired'>, now: number = Date.now()): string {
	const d = inv.expired ? 0 : daysLeft(inv.expiresAt, now);
	if (d <= 0) return 'expired';
	if (d === 1) return 'expires within a day';
	return `expires in ${d} days`;
}

/**
 * After re-sending: the server only mails a fresh link (and pushes the expiry
 * out) when the last email is more than a minute old, so an unchanged expiry
 * means nothing new went out.
 */
export function resendWasMailed(before: Pick<Invite, 'expiresAt'>, after: Pick<Invite, 'expiresAt'>): boolean {
	return new Date(after.expiresAt).getTime() > new Date(before.expiresAt).getTime();
}
