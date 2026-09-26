// View helpers for ShareLinksPanel (WP-2.3 phase 2): a link's state and the
// words for its row. Pure, so they are unit-tested (shareLinks.test.ts).
import type { ShareLink } from '$lib/api/types';
import { fmtDate } from '$lib/format/number';

/** How long a new link lives: the choices offered (the API takes any 1–365). */
export const EXPIRY_CHOICES = [
	{ days: 7, label: '1 week' },
	{ days: 30, label: '30 days' },
	{ days: 90, label: '90 days' },
	{ days: 365, label: '1 year' }
] as const;
export const DEFAULT_EXPIRY_DAYS = 30;

export type LinkState = 'live' | 'expired' | 'revoked';

export function linkState(link: Pick<ShareLink, 'expiresAt' | 'revokedAt'>, now: number = Date.now()): LinkState {
	if (link.revokedAt) return 'revoked';
	return Date.parse(link.expiresAt) <= now ? 'expired' : 'live';
}

export const STATE_WORD: Record<LinkState, string> = { live: 'Live', expired: 'Expired', revoked: 'Withdrawn' };

export interface LinkRow {
	id: string;
	label: string;
	state: LinkState;
	/** "2026-09-25 by Jo Owner". */
	created: string;
	/** "2026-10-25", or "Withdrawn 2026-09-26 by Jo Owner". */
	ends: string;
	/** "2026-09-25 14:05", or "Never". */
	lastUsed: string;
	canRevoke: boolean;
}

/** One row of the list, in the viewer's own time zone. */
export function linkRow(link: ShareLink, now: number = Date.now()): LinkRow {
	const state = linkState(link, now);
	const by = (name: string | null) => (name ? ` by ${name}` : '');
	return {
		id: link.id,
		label: link.label,
		state,
		created: `${fmtDate(link.createdAt)}${by(link.createdBy)}`,
		ends: state === 'revoked' ? `Withdrawn ${fmtDate(link.revokedAt)}${by(link.revokedBy)}` : fmtDate(link.expiresAt),
		lastUsed: link.lastUsedAt ? fmtDate(link.lastUsedAt, true) : 'Never',
		canRevoke: state === 'live'
	};
}

/** Live links first (newest first, as the API lists them), then the rest. */
export function sortLinks(links: readonly ShareLink[], now: number = Date.now()): ShareLink[] {
	const live = links.filter((l) => linkState(l, now) === 'live');
	return [...live, ...links.filter((l) => linkState(l, now) !== 'live')];
}

/** The confirm before a revoke. */
export const revokeQuestion = (label: string) => `Withdraw the link “${label}”? Anyone who has it will see “This link has expired or was withdrawn” from now on. This can’t be undone.`;
