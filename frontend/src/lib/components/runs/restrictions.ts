// The drought restriction rule's results (engine ≥ 1.46.0, WP-3.8, docs/ui.md
// § Drought restrictions, RunSummary.droughtRestriction): what the tables on
// Units & supply show. The days at each level per water year (October to
// September) and over the run, and per unit its mean demand before and after
// the cut and what it was supplied. The rule is a model rule, not the
// restriction notice farmers see.
import { describeDroughtRestriction, waterYearLabel, type RunSummary } from '@water-management/engine';

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
	units: { nodeId: string; name: string; demand: number; restricted: number; cut: number; cutShare: number | null; supplied: number }[];
}

const pct = (x: number) => `${Math.round(x * 1000) / 10} %`;

export function restrictionView(s: Summary | undefined): RestrictionView | null {
	if (!s) return null;
	const restricted = (byLevel: readonly number[]) => byLevel.slice(1).reduce((a, b) => a + b, 0);
	return {
		rule: describeDroughtRestriction(s.rule),
		source: s.rule.source?.trim() || null,
		levels: ['No restriction', ...s.rule.levels.map((l, i) => `${l.label?.trim() || `Level ${i + 1}`} (below ${pct(l.belowPct)})`)],
		years: s.years.map((y) => ({ label: waterYearLabel(y.waterYear), days: y.days, byLevel: y.daysByLevel, restricted: restricted(y.daysByLevel) })),
		total: { days: s.daysByLevel.reduce((a, b) => a + b, 0), byLevel: s.daysByLevel, restricted: restricted(s.daysByLevel) },
		reviews: s.reviews,
		units: s.units.map((u) => {
			const cut = Math.max(0, u.avgDemandM3Day - u.avgRestrictedDemandM3Day);
			return { nodeId: u.nodeId, name: u.name, demand: u.avgDemandM3Day, restricted: u.avgRestrictedDemandM3Day, cut, cutShare: u.avgDemandM3Day > 0 ? cut / u.avgDemandM3Day : null, supplied: u.avgSuppliedM3Day };
		})
	};
}
