// The drought restriction rule's results (engine ≥ 1.54.0, WP-3.8, docs/ui.md
// § Drought restrictions, RunSummary.droughtRestriction): what the tables on
// Units & supply show. The days at each level per water year (October to
// September) and over the run, and per unit its mean demand before and after
// the cut and what it was supplied. The rule is a model rule, not the
// restriction notice farmers see.
import { describeDroughtRestriction, waterYearLabel, type RunSummary } from '@water-management/engine';

/** Its own chunk (RestrictionTables.svelte), drawn on Units & supply and in the printable report. */
export const loadRestrictionTables = () => import('./RestrictionTables.svelte');

type Summary = NonNullable<RunSummary['droughtRestriction']>;

export interface RestrictionView {
	/** The rule in words, as the run comparison and the summary CSV give it. */
	rule: string;
	source: string | null;
	/** Column headings: "No restriction", then each level's name and threshold. */
	levels: string[];
	years: { label: string; days: number; byLevel: number[]; restricted: number }[];
	total: { days: number; byLevel: number[]; restricted: number };
	reviews: number;
	/** With an EWR trigger (engine ≥ 1.54.0): the reviews that followed a day its site's EWR wasn't met. */
	ewrReviews: number | null;
	/**
	 * Per unit, the most cut first: its means over the run (demand, after the
	 * restriction, the cut and its share of demand, supplied), and the mean cut
	 * over the restricted days only (null when no day was), which the run
	 * means dilute with every unrestricted day.
	 */
	units: { nodeId: string; name: string; demand: number; restricted: number; cut: number; cutShare: number | null; supplied: number; cutOnRestrictedDays: number | null; daysRestricted: number | null }[];
}

const pct = (x: number) => `${Math.round(x * 1000) / 10} %`;

export function restrictionView(s: Summary | undefined, nodeName: (id: string) => string = (id) => id): RestrictionView | null {
	if (!s) return null;
	const restricted = (byLevel: readonly number[]) => byLevel.slice(1).reduce((a, b) => a + b, 0);
	return {
		rule: describeDroughtRestriction(s.rule, nodeName),
		source: s.rule.source?.trim() || null,
		levels: ['No restriction', ...s.rule.levels.map((l, i) => `${l.label?.trim() || `Level ${i + 1}`} (below ${pct(l.belowPct)})`)],
		years: s.years.map((y) => ({ label: waterYearLabel(y.waterYear), days: y.days, byLevel: y.daysByLevel, restricted: restricted(y.daysByLevel) })),
		total: { days: s.daysByLevel.reduce((a, b) => a + b, 0), byLevel: s.daysByLevel, restricted: restricted(s.daysByLevel) },
		reviews: s.reviews,
		ewrReviews: s.ewrReviews ?? null,
		units: s.units
			.map((u) => {
				const cut = Math.max(0, u.avgDemandM3Day - u.avgRestrictedDemandM3Day);
				return {
					nodeId: u.nodeId,
					name: u.name,
					demand: u.avgDemandM3Day,
					restricted: u.avgRestrictedDemandM3Day,
					cut,
					cutShare: u.avgDemandM3Day > 0 ? cut / u.avgDemandM3Day : null,
					supplied: u.avgSuppliedM3Day,
					cutOnRestrictedDays: u.avgCutOnRestrictedDaysM3Day ?? null,
					daysRestricted: u.daysByLevel ? restricted(u.daysByLevel) : null
				};
			})
			.sort((a, b) => b.cut - a.cut || a.name.localeCompare(b.name))
	};
}
