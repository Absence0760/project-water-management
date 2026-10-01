// The review triggers' view model (issue #53 R6, docs/ui.md § Seasonal
// outlook, docs/model.md §2.15a): an outlook's stored trigger table in the
// screen's words. The table is the engine's (reviewTriggerTable, run by the
// backend's outlook job on the latest review date the base run's record
// holds, as a rule by storage band for that day of the year) and each row's
// sentence its describeTriggerRow; this module only formats them. It counts
// years; it never picks a level.
import { describeDroughtRestriction, describeTriggerRow, restrictionRuleFromTriggers, type DroughtRestrictionRule } from '@water-management/engine';
import type { Outlook, OutlookTriggerTable } from '$lib/api/types';
import { fmtDay, fmtNum } from '$lib/format/number';
import { waterYearLabel } from './view';

export interface TriggerRowView {
	/** "At or above 53 333 m³" / "Below 26 667 m³"; the fullest band first. */
	band: string;
	/** The band's lower edge as a share of the dams' capacity, "67 %"; "0 %" for the lowest. */
	fromShare: string;
	/** The level picked, or null (no level met the rule, or too few years). */
	level: string | null;
	/** "10 of 12 years", or "–". */
	met: string;
	/** The engine's sentence for the row. */
	words: string;
	/** Every level, highest demand first: its label and years met. */
	perLevel: { label: string; met: string; meets: boolean }[];
}

export type TriggersView =
	| { kind: 'none' }
	| { kind: 'notDrawn'; reviewDate: string; problem: string }
	| {
			kind: 'table';
			/** The season's review date, long ("1 Jan 2014"): when the WUA reads its dams. */
			reviewDate: string;
			/** The day the table ran on (the latest review date the base run's record holds), long. */
			ranOn: string;
			bandsFrom: string;
			rows: TriggerRowView[];
			notes: string[];
			warnings: string[];
			excluded: string[];
			failures: string[];
			monotone: boolean;
	  };

const m3 = (v: number) => `${fmtNum(v)} m³`;
/** The engine groups thousands with a plain space; the app with a narrow no-break one (D10), as fmtNum does. */
const grouped = (text: string) => text.replace(/(\d) (?=\d{3}(?!\d))/g, '$1\u202f');
const pct = (v: number) => `${fmtNum(v * 100, 0)} %`;

const BAND_SOURCE: Record<OutlookTriggerTable['bandSource'], string> = {
	historicalTerciles: 'Bands: the thirds of the record’s dam storage on that day of the year.',
	explicit: 'Bands: the edges set for the table.',
	wholeRange: 'One band: the record holds too few years of storage on that day for thirds.'
};

/** An outlook's trigger table in words; `none` for an outlook without a review date (or an older one). */
export function buildTriggersView(outlook: Pick<Outlook, 'triggers'>): TriggersView {
	const t = outlook.triggers;
	if (!t) return { kind: 'none' };
	const reviewDate = fmtDay(t.reviewDate);
	if (!t.table) return { kind: 'notDrawn', reviewDate, problem: t.problem ?? 'The trigger table could not be drawn.' };
	const table = t.table;
	const cap = table.capacityM3;
	return {
		kind: 'table',
		reviewDate,
		ranOn: fmtDay(table.reviewDate),
		bandsFrom: BAND_SOURCE[table.bandSource],
		rows: table.rows.map((r) => ({
			band: r.band.fromM3 > 0 ? `At or above ${m3(r.band.fromM3)}` : `Below ${m3(r.band.toM3)}`,
			fromShare: cap > 0 ? pct(r.band.fromM3 / cap) : '–',
			level: r.level?.label ?? null,
			met: r.metYears !== null ? `${r.metYears} of ${r.nYears} years` : '–',
			words: grouped(describeTriggerRow(table, r)),
			perLevel: r.perLevel.map((l) => ({ label: l.label, met: `${l.yearsMet} of ${l.nYears}`, meets: l.meets }))
		})),
		notes: table.notes,
		warnings: table.warnings,
		excluded: t.excluded.filter((e) => e.reason !== 'theSeason' && e.reason !== 'outsideRecord').map((e) => `${waterYearLabel(e.waterYear)} (${e.reason})`),
		failures: t.failures.map((f) => `${f.label}, ${waterYearLabel(f.waterYear)}, from ${m3(f.bandFromM3)}: ${f.message}`),
		monotone: table.monotone
	};
}

/**
 * An outlook's trigger table as the drought restriction rule (engine ≥
 * 1.54.0, WP-3.8, docs/model.md §2.15a, §2.7i): the engine's
 * restrictionRuleFromTriggers over the outlook's own levels, in words, with
 * what it couldn't carry. null without a table, or when no band's level cuts
 * demand (then `notes` says so and there is nothing to save).
 */
export function triggerRuleView(outlook: Pick<Outlook, 'triggers' | 'levels'>): { rule: DroughtRestrictionRule | null; words: string | null; notes: string[] } | null {
	const table = outlook.triggers?.table;
	if (!table) return null;
	const { rule, notes } = restrictionRuleFromTriggers(table, outlook.levels);
	return { rule, words: rule ? grouped(describeDroughtRestriction(rule)) : null, notes };
}
