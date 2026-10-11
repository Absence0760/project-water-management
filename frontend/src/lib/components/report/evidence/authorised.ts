// Page 1's board against full authorised use (licensing build item 8;
// evidence-14; engine evidence/authorised.ts; docs/ui.md § Evidence report):
// the words for its fixed row and the authorised volume's mix.
import { isMixShares, type AuthorisedMix, type AuthorisedMixShares, type EvidenceAuthorisedImpact } from '@water-management/engine';
import { AUTHORISATION_LABEL } from '$lib/components/allocations/allocations';
import { fmtNum } from '$lib/format/number';

/** The headline board's heading, and the modelled-use board's when both show. */
export const AUTHORISED_HEADING = 'Against full authorised use';
export const MODELLED_HEADING = 'Against modelled current use';

/** Why there is no board: a fixed row, never left out (G6). Null when there is a board. */
export function authorisedRow(a: EvidenceAuthorisedImpact): string | null {
	switch (a.status) {
		case 'ok':
			return null;
		case 'notBuilt':
			return 'Not assessed: the baseline and the application haven’t been run with every holder at their registered volume for this application run. An editor runs them from the evidence report (Run at full authorised use).';
		case 'noAllocations':
			return 'Not assessed: the baseline ran with no registered or licensed volumes, so there is no authorised use to hold holders to (Allocations).';
		case 'stale':
			return `Not assessed: the run at full authorised use is out of date${a.detail ? `: ${a.detail}` : ''}.`;
	}
}

/** One line of the mix: how a volume is held, m³ a year (or a share, on a folded one), and whether it is an entitlement. */
export interface MixLine {
	label: string;
	volume: string;
	entitlement: boolean;
}

/**
 * The mix's lines in its order (entitlements first), and the totals line. A
 * folded mix (a viewer kept from each registered volume, evidence-18) is in
 * whole-percent shares with no m³ (#523 H/J): each line is its share, the
 * total "100 %".
 */
export function mixLines(mix: AuthorisedMix | AuthorisedMixShares): { lines: MixLine[]; total: string; entitlement: string; leftOut: string | null; shares: boolean } {
	const m3 = (v: number) => `${fmtNum(Math.round(v))} m³/a`;
	const pct = (v: number) => `${fmtNum(v, 0)} %`;
	const label = (r: { authorisation: AuthorisedMix['rows'][number]['authorisation']; withOthers?: true }) => {
		const k = r.authorisation;
		const base = k === 'unknown' ? 'Not recorded (the volume’s row is gone)' : k === 'other' ? 'Other ways of holding (each held by fewer than 5 registered users)' : AUTHORISATION_LABEL[k];
		return r.withOthers ? `${base}, with the ways of holding too few hold to show` : base;
	};
	// Folded (evidence-17, #523 G1, D3): who is in no line, counted only at 5 or more.
	const n = mix.leftOutHolders ?? 0;
	const leftOut =
		n > 0
			? `${n} registered users’ volumes are left out: no line gives fewer than 5 registered users’ volume.`
			: mix.someLeftOut
				? 'Some registered users’ volumes are left out: no line gives fewer than 5 registered users’ volume.'
				: null;
	if (isMixShares(mix))
		return {
			lines: mix.rows.map((r) => ({ label: label(r), volume: pct(r.sharePct), entitlement: r.entitlement })),
			total: mix.rows.length ? pct(100) : pct(0),
			entitlement: pct(mix.entitlementPct),
			leftOut,
			shares: true
		};
	return {
		lines: mix.rows.map((r) => ({ label: label(r), volume: m3(r.volumeM3PerYear), entitlement: r.entitlement })),
		total: m3(mix.totalM3PerYear),
		entitlement: m3(mix.entitlementM3PerYear),
		leftOut,
		shares: false
	};
}
