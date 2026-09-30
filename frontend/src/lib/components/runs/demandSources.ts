// How solid a run's non-crop demand is, by rule (engine ≥ 1.56.0, issue #54
// Q11, docs/model.md §2.7f): each source's share of the demand objects'
// whole-run demand, best source first (meter records, a strategy's AADD, a
// per-capita norm, other), then what isn't recorded. Pure, so it is
// unit-tested without Svelte; the demand-objects table draws it.
import { DEMAND_OBJECT_SOURCE_LABEL, DEMAND_OBJECT_SOURCES, type DemandObjectSource, type DemandObjectSummary } from '@water-management/engine';
import { fmtPct } from '$lib/format/number';

export interface SourceShare {
	source: DemandObjectSource | null;
	/** Mean demand from it, m³/day. */
	demandM3Day: number;
	/** Of the objects' whole demand, 0–1. */
	share: number;
	objects: number;
}

/** The sources a run's objects have, in the rule's order, not recorded last; none when no object records one (a run before engine 1.56.0, or no sources entered). */
export function demandBySource(objects: readonly Pick<DemandObjectSummary, 'source' | 'avgDemandM3Day'>[]): SourceShare[] {
	if (!objects.some((o) => o.source !== undefined)) return [];
	const total = objects.reduce((s, o) => s + o.avgDemandM3Day, 0);
	return [...DEMAND_OBJECT_SOURCES, null].flatMap((source) => {
		const mine = objects.filter((o) => (o.source ?? null) === source);
		if (!mine.length) return [];
		const demandM3Day = mine.reduce((s, o) => s + o.avgDemandM3Day, 0);
		return [{ source, demandM3Day, share: total > 0 ? demandM3Day / total : 0, objects: mine.length }];
	});
}

/** A source in the table's words: its label, or "not recorded". */
export const sourceLabel = (source: DemandObjectSource | null | undefined) => (source ? DEMAND_OBJECT_SOURCE_LABEL[source] : 'not recorded');

const FROM: Record<DemandObjectSource, string> = { meter: 'meter records', aadd: 'a strategy’s AADD', perCapita: 'a per-capita norm', other: 'another source' };

/** The line above the table: "Of their demand, 62% is from meter records, 30% from a per-capita norm and 8% not recorded." */
export function sourceLine(shares: readonly SourceShare[]): string | null {
	if (!shares.length) return null;
	const parts = shares.map((s, i) => `${fmtPct(s.share, 0)}${i === 0 ? ' is' : ''} ${s.source ? `from ${FROM[s.source]}` : 'not recorded'}`);
	return `Of their demand, ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]}.`;
}
