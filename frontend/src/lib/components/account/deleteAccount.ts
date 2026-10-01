// "Delete my account" on the account page (issue #112; DeleteAccount.svelte;
// DELETE /auth/me, docs/api.md § Auth). The server refuses the only owner of
// a project or the only admin of a team with 409 `account_sole_holder`,
// naming them in `details`; this reads that list, and nothing else, so a
// malformed or foreign body shows the generic message instead.
import { ApiError } from '$lib/api/client';
import type { SoleHoldings } from '$lib/api/types';

const holdings = (v: unknown): { id: string; name: string }[] | null =>
	Array.isArray(v) && v.every((h) => h && typeof h === 'object' && typeof (h as { id?: unknown }).id === 'string' && typeof (h as { name?: unknown }).name === 'string')
		? (v as { id: string; name: string }[]).map(({ id, name }) => ({ id, name }))
		: null;

/** The projects and teams a refused deletion names, or null when `err` is any other failure. */
export function soleHoldingsOf(err: unknown): SoleHoldings | null {
	if (!(err instanceof ApiError) || err.status !== 409 || err.code !== 'account_sole_holder') return null;
	const d = (err.details ?? {}) as { projects?: unknown; teams?: unknown };
	const projects = holdings(d.projects);
	const teams = holdings(d.teams);
	return projects && teams && (projects.length || teams.length) ? { projects, teams } : null;
}
