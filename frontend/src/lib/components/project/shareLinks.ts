// View helpers for ShareLinksPanel (WP-2.3 phase 2): a link's state, what it
// opens (the owner's inventory of every link) and the words for its row. Pure, so they are unit-tested (shareLinks.test.ts).
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
	/** What it opens: "The published baseline", "Application “Raise my dam”" (the owner's inventory). */
	opens: string;
	/** Why a live link opens nothing just now (its application withdrawn, or no longer readable); null when it opens. */
	opensNothing: string | null;
	canRevoke: boolean;
}

/** What a link opens, in words, and why it opens nothing just now if it doesn't. */
export function linkTarget(link: Pick<ShareLink, 'targetKind' | 'target'>): { opens: string; opensNothing: string | null } {
	if (link.targetKind === null) return { opens: 'The published baseline', opensNothing: null };
	const t = link.target;
	if (!t) return { opens: 'An application you can’t open', opensNothing: 'Its application is a draft again or was deleted: the link opens nothing.' };
	const opens = `Application “${t.name}”`;
	if (t.status === 'submitted' || t.status === 'decided') return { opens, opensNothing: null };
	return { opens, opensNothing: 'The application is withdrawn: the link opens nothing until it is submitted again.' };
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
		...linkTarget(link),
		canRevoke: state === 'live'
	};
}

/** Live links first (newest first, as the API lists them), then the rest. */
export function sortLinks(links: readonly ShareLink[], now: number = Date.now()): ShareLink[] {
	const live = links.filter((l) => linkState(l, now) === 'live');
	return [...live, ...links.filter((l) => linkState(l, now) !== 'live')];
}

/** The confirm before a revoke; `opens` names its target in the owner's inventory. */
export const revokeQuestion = (label: string, opens?: string) =>
	`Withdraw the link “${label}”${opens ? ` (${opens.charAt(0).toLowerCase()}${opens.slice(1)})` : ''}? Anyone who has it will see “This link has expired or was withdrawn” from now on. This can’t be undone.`;
