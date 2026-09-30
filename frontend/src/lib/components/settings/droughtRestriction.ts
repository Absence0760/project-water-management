// Settings → Drought restrictions (engine ≥ 1.46.0, WP-3.8, docs/ui.md §
// Drought restrictions, docs/model.md §2.7i): the model's drought
// restriction rule, settings.droughtRestriction. The rule's own checks are
// the engine's (droughtRestrictionIssues), so the form, the save and the run
// agree; this module holds the form's starting rule, its wording and the
// edits the editor makes. The scenario form's "Change a setting" edits the
// same rule with the same editor.
import {
	DEMAND_OBJECT_CATEGORY_LABEL,
	droughtRestrictionIssues,
	RESTRICTION_DATES_MAX,
	RESTRICTION_LEVELS_MAX,
	type DemandPart,
	type DroughtRestrictionLevel,
	type DroughtRestrictionRule
} from '@water-management/engine';

/** Each part of demand as the editor's row names it. */
export const PART_LABEL: Record<DemandPart, string> = {
	crops: 'Crops (irrigation of the crop areas)',
	...(Object.fromEntries(Object.entries(DEMAND_OBJECT_CATEGORY_LABEL).map(([k, v]) => [k, `${v} demand objects`])) as Record<Exclude<DemandPart, 'crops'>, string>)
};


/**
 * The rule a project starts from when it switches restrictions on: reviewed
 * on 1 October and 1 January (the outlook's default decision and review
 * dates), lifted on 1 May (the day after its default season end), and three
 * levels in the shape of DWS restriction schedules, irrigation cut hardest
 * and people's water least. A starting point to edit, not a recommendation:
 * the levels and cuts are the WUA's, pending the hydrologist.
 */
export function startingRule(): DroughtRestrictionRule {
	return {
		reviewDates: ['10-01', '01-01'],
		liftDates: ['05-01'],
		levels: [
			{ label: 'Level 1', belowPct: 0.6, cuts: { crops: 0.2, irrigation: 0.2, domestic: 0.1, municipal: 0.1 } },
			{ label: 'Level 2', belowPct: 0.4, cuts: { crops: 0.4, irrigation: 0.4, domestic: 0.2, municipal: 0.2 } },
			{ label: 'Level 3', belowPct: 0.25, cuts: { crops: 0.6, irrigation: 0.6, domestic: 0.3, municipal: 0.3 } }
		]
	};
}

/** The rule's first problem as a sentence for the form, or null when it can be saved (null = off, fine). */
export function restrictionFormError(rule: DroughtRestrictionRule | null | undefined): string | null {
	if (!rule) return null;
	const i = droughtRestrictionIssues(rule)[0];
	if (!i) return null;
	const where = /^levels\[(\d+)\]/.exec(i.field);
	if (where) return `Level ${Number(where[1]) + 1}: ${i.message}.`;
	if (i.field.startsWith('reviewDates')) return `Review dates: ${i.message}.`;
	if (i.field.startsWith('liftDates')) return `Lift dates: ${i.message}.`;
	if (i.field === 'source') return `Source: ${i.message}.`;
	return `${i.message.charAt(0).toUpperCase()}${i.message.slice(1)}.`;
}

/** "MM-DD" ↔ month and day, for the date pickers. */
export const splitMonthDay = (md: string): { month: number; day: number } => ({ month: Number(md.slice(0, 2)) || 1, day: Number(md.slice(3, 5)) || 1 });
export const joinMonthDay = (month: number, day: number): string => `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

/** A date list with one more date: the day after the last one, or 1 January. At most RESTRICTION_DATES_MAX. */
export function withDateAdded(dates: readonly string[]): string[] {
	if (dates.length >= RESTRICTION_DATES_MAX) return [...dates];
	const taken = new Set(dates);
	for (let m = 1; m <= 12; m++) {
		const d = joinMonthDay(m, 1);
		if (!taken.has(d)) return [...dates, d];
	}
	return [...dates];
}

/** One more level, deeper than the last: its threshold half the last one's, each part's cut as the last level's. */
export function withLevelAdded(levels: readonly DroughtRestrictionLevel[]): DroughtRestrictionLevel[] {
	if (levels.length >= RESTRICTION_LEVELS_MAX) return [...levels];
	const last = levels.at(-1);
	const below = last ? Math.round(last.belowPct * 50) / 100 : 0.5;
	return [...levels, { label: `Level ${levels.length + 1}`, belowPct: below > 0 ? below : 0.01, cuts: last ? { ...last.cuts } : {} }];
}

/** A level's cut on a part set (a share 0–1) or cleared (null: not cut). */
export function withCut(level: DroughtRestrictionLevel, part: DemandPart, cut: number | null): DroughtRestrictionLevel {
	const cuts = { ...level.cuts };
	if (cut === null) delete cuts[part];
	else cuts[part] = cut;
	return { ...level, cuts };
}
