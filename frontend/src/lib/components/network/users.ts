// Other water users (WP-1.33) in the Network tab: their monthly demand as
// the form edits it, and the one-line description the users panel shows.
import type { NetworkNode } from '@water-management/engine';
import { fmtNum } from '$lib/format/number';

/** A user's 12 monthly demands (m³/day, water-year months); zeros when it has none yet. */
export function userDemandOf(n: Pick<NetworkNode, 'userDemandM3Day'>): number[] {
	const d = n.userDemandM3Day;
	return Array.from({ length: 12 }, (_, i) => (d && Number.isFinite(d[i]) ? d[i]! : 0));
}

/** "senior · 1 200 m³/day on average · 40 % returned", or a hint when it has no demand. */
export function describeUser(n: Pick<NetworkNode, 'userDemandM3Day' | 'userReturnPct' | 'userPriority'>): string {
	const d = userDemandOf(n);
	const mean = d.reduce((a, b) => a + b, 0) / 12;
	const priority = n.userPriority ?? 'senior';
	if (!(mean > 0)) return `${priority} · no demand yet: enter it by month`;
	const ret = n.userReturnPct ?? 0;
	return `${priority} · ${fmtNum(mean, 0)} m³/day on average${ret > 0 ? ` · ${fmtNum(ret * 100, 0)} % returned` : ''}`;
}
