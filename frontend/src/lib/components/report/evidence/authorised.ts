// Page 1's board against full authorised use (licensing build item 8;
// evidence-14; engine evidence/authorised.ts; docs/ui.md § Evidence report):
// the words for its fixed row and the authorised volume's mix.
import type { AuthorisedMix, EvidenceAuthorisedImpact } from '@water-management/engine';
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

/** One line of the mix: how a volume is held, m³ a year, and whether it is an entitlement. */
export interface MixLine {
	label: string;
	volume: string;
	entitlement: boolean;
}

/** The mix's lines in its order (entitlements first), and the totals line. */
export function mixLines(mix: AuthorisedMix): { lines: MixLine[]; total: string; entitlement: string } {
	const m3 = (v: number) => `${fmtNum(Math.round(v))} m³/a`;
	return {
		lines: mix.rows.map((r) => ({ label: r.authorisation === 'unknown' ? 'Not recorded (the volume’s row is gone)' : AUTHORISATION_LABEL[r.authorisation], volume: m3(r.volumeM3PerYear), entitlement: r.entitlement })),
		total: m3(mix.totalM3PerYear),
		entitlement: m3(mix.entitlementM3PerYear)
	};
}
