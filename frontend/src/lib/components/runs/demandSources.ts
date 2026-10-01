// How solid a run's non-crop demand is, by rule (engine ≥ 1.56.0, issue #54
// Q11, docs/model.md §2.7f): each source's share of the demand objects'
// whole-run demand (the engine's demandBySource, which the evidence report's
// § 6 shares too), in words. Pure, so it is unit-tested without Svelte; the
// demand-objects table and the evidence report draw it.
import { DEMAND_OBJECT_SOURCE_LABEL, type DemandObjectSource, type DemandSourceShare } from '@water-management/engine';
import { fmtPct } from '$lib/format/number';

export { demandBySource } from '@water-management/engine';
export type SourceShare = DemandSourceShare;

/** A source in the table's words: its label, or "not recorded". */
export const sourceLabel = (source: DemandObjectSource | null | undefined) => (source ? DEMAND_OBJECT_SOURCE_LABEL[source] : 'not recorded');

const FROM: Record<DemandObjectSource, string> = { meter: 'meter records', aadd: 'a strategy’s AADD', perCapita: 'a per-capita norm', other: 'another source' };

/** The line above the table: "Of their demand, 62% is from meter records, 30% from a per-capita norm and 8% not recorded." */
export function sourceLine(shares: readonly SourceShare[]): string | null {
	if (!shares.length) return null;
	const parts = shares.map((s, i) => `${fmtPct(s.share, 0)}${i === 0 ? ' is' : ''} ${s.source ? `from ${FROM[s.source]}` : 'not recorded'}`);
	return `Of their demand, ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]}.`;
}
