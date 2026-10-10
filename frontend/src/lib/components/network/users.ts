// Other water users (WP-1.33) in the Network tab: their monthly demand as
// the form edits it, and the one-line description the users panel shows.
import { userPriorityWord, type NetworkNode } from '@water-management/engine';
import { fmtNum } from '$lib/format/number';

/** A user's 12 monthly demands (m³/day, water-year months); zeros when it has none yet. */
export function userDemandOf(n: Pick<NetworkNode, 'userDemandM3Day'>): number[] {
	const d = n.userDemandM3Day;
	return Array.from({ length: 12 }, (_, i) => (d && Number.isFinite(d[i]) ? d[i]! : 0));
}

/** "priority · 1 200 m³/day on average · 40 % returned · pump 800 m³/day", or a hint when it has no demand. */
export function describeUser(n: Pick<NetworkNode, 'userDemandM3Day' | 'userReturnPct' | 'userPriority'> & Partial<Pick<NetworkNode, 'pumpCapacityM3Day'>>): string {
	const d = userDemandOf(n);
	const mean = d.reduce((a, b) => a + b, 0) / 12;
	const priority = userPriorityWord(n.userPriority);
	if (!(mean > 0)) return `${priority} · no demand yet: enter it by month`;
	const ret = n.userReturnPct ?? 0;
	// Its pump capacity (engine ≥ 1.58.0), when set.
	const pump = typeof n.pumpCapacityM3Day === 'number' ? ` · pump ${fmtNum(n.pumpCapacityM3Day, 0)} m³/day` : '';
	return `${priority} · ${fmtNum(mean, 0)} m³/day on average${ret > 0 ? ` · ${fmtNum(ret * 100, 0)} % returned` : ''}${pump}`;
}

/**
 * The line under an other water user's pump capacity (engine ≥ 1.58.0,
 * docs/model.md §2.7c): what blank, 0 and a capacity mean, and for a priority
 * user that the units upstream then pass only what the pump can take.
 */
export function userPumpNote(n: Pick<NetworkNode, 'pumpCapacityM3Day' | 'userPriority'>, readonly = false): string {
	const pump = n.pumpCapacityM3Day ?? null;
	if (pump === null) return 'Blank is no limit: it takes its demand from whatever reaches it.';
	if (pump === 0) return 'No pump: it takes nothing from the river (boreholes still pump).';
	const senior = (n.userPriority ?? 'senior') !== 'junior';
	const calc = readonly ? '' : ' Or enter the pumps and their rate to work it out.';
	return `It takes at most ${fmtNum(pump, 0)} m³/day from the river${senior ? '; units upstream pass no more than that for it' : ''}.${calc}`;
}

/**
 * The line under an other water user's priority (docs/model.md §2.7c, issue
 * #507): a priority user, the default, is a claim on every hydrological unit
 * upstream, so adding one changes what those farms get.
 */
export function userPriorityNote(priority: NetworkNode['userPriority']): string {
	if (priority === 'junior') return 'It takes only what reaches it; the hydrological units upstream are not held back for it.';
	return 'Priority is the default. Every hydrological unit upstream passes its demand before filling its dam or irrigating, so adding a priority user changes what the farms upstream get.';
}
