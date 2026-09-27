// The section header's one-line context for the tabs that don't give their
// own (headerSlot.svelte.ts): a count of what the section holds, so a
// section's header says something under its title. Network, Crops, Summary,
// Project and History fill their own.
import type { TabId } from '$lib/workspace/tabs';

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function sectionContext(
	tab: TabId,
	d: {
		runs: readonly unknown[] | null;
		seriesCount: number | null;
		behind: number;
		transfers: readonly { enabled: boolean }[];
	}
): string | null {
	switch (tab) {
		case 'overview':
			return d.runs && !d.runs.length ? 'No runs yet' : null;
		case 'runs':
		case 'compare':
			return d.runs ? (d.runs.length ? count(d.runs.length, 'run') : 'No runs yet') : null;
		case 'series':
			if (d.seriesCount === null) return null;
			if (!d.seriesCount) return 'No input series yet';
			return `${count(d.seriesCount, 'input series', 'input series')}${d.behind ? ` · ${d.behind} behind` : ''}`;
		case 'transfers': {
			const n = d.transfers.length;
			if (!n) return 'No transfer rules yet';
			return `${count(n, 'transfer rule')} · ${d.transfers.filter((t) => t.enabled).length} active`;
		}
		default:
			return null;
	}
}
