// "How much irrigation can this catchment support?" (issue #53, design
// planning-outputs.md §3.8, docs/ui.md § Irrigation the catchment supports):
// for each level of a demand sweep, the annual natural water availability
// below which the river's requirement starts to fail, read from the outcome
// matrix's own years (views/outcomeMatrix.ts: each classed water year's
// natural flow at the outlet and whether it met the requirement in full, by
// the matrix's measure). A view over the matrix, so the two never disagree.
// Pure; it reports what past years did and never picks a level.
//
// The threshold (model.md §2.14b): per level, the natural annual volume of the
// wettest water year that failed. Every wetter year met the requirement, so
// above it the record holds no breach; at or below it at least one year
// failed. It is a fact about the record, not a fitted curve: the "about" is the
// gap up to the next wetter year (which met it) and any drier years that met
// it anyway (timing within a year matters, so failing and passing years can
// mix below it). No marker when no year failed, when the wettest year failed
// (nothing above it to show where breaches stop), or with fewer than
// IRRIGATION_SUPPORT_MIN_YEARS years. Levels are worked out independently and
// never smoothed: a lower level whose threshold is higher (return flows reach
// the river on dry days, help 'seasonal-outlook') gets a note saying so.
import type { OutcomeMatrix, WaterYearClasses } from '@water-management/engine';
import { fmtNum } from '#lib/format/number.js';

/** The board's heading, and its entry in the EWR page's menu (river.ts riverNavGroups). */
export const IRRIGATION_SUPPORT_HEADING = 'How much irrigation can the catchment support?';

/**
 * Fewest complete water years for a threshold (**judgement**, pending the
 * hydrologist): as many as the outcome matrix needs to fill every tercile
 * class with its OUTCOME_MIN_YEARS (3 × 3).
 */
export const IRRIGATION_SUPPORT_MIN_YEARS = 9;

const M3_PER_MILLION = 1e6;

/** One classed water year at one level. */
export interface SupportYear {
	waterYear: number;
	/** "2016/17". */
	label: string;
	/** Natural flow at the outlet over the year, m³ (the year classes' total). */
	naturalM3: number;
	/** The requirement met in full that year (OutcomeYear.met). */
	met: boolean;
}

export type SupportResult =
	| {
			kind: 'threshold';
			/** The wettest failing year's natural volume, m³: the marker. */
			thresholdM3: number;
			wettestFailed: SupportYear;
			/** The driest year wetter than it (it met the requirement, as every wetter year did). */
			nextMet: SupportYear;
			failed: number;
			met: number;
			/** Years at or below the threshold that met the requirement anyway. */
			metAtOrBelow: number;
	  }
	| { kind: 'neverFailed'; driest: SupportYear; met: number }
	| { kind: 'wettestFailed'; wettest: SupportYear; failed: number; met: number }
	| { kind: 'tooFewYears'; nYears: number };

/** Where breaches start in these years (see the header). Ties: years with equal volumes are never split, the passing one counts as "met at or below". */
export function supportThreshold(years: readonly SupportYear[]): SupportResult {
	if (years.length < IRRIGATION_SUPPORT_MIN_YEARS) return { kind: 'tooFewYears', nYears: years.length };
	// Stable: the volume, then the water year, so the result never hangs on input order.
	const sorted = [...years].sort((a, b) => a.naturalM3 - b.naturalM3 || a.waterYear - b.waterYear);
	const failed = sorted.filter((y) => !y.met).length;
	const met = sorted.length - failed;
	if (!failed) return { kind: 'neverFailed', driest: sorted[0]!, met };
	let wettestFailed = sorted[0]!;
	for (const y of sorted) if (!y.met) wettestFailed = y;
	const thresholdM3 = wettestFailed.naturalM3;
	const nextMet = sorted.find((y) => y.naturalM3 > thresholdM3);
	if (!nextMet) return { kind: 'wettestFailed', wettest: sorted[sorted.length - 1]!, failed, met };
	const metAtOrBelow = sorted.filter((y) => y.met && y.naturalM3 <= thresholdM3).length;
	return { kind: 'threshold', thresholdM3, wettestFailed, nextMet, failed, met, metAtOrBelow };
}

/** m³ → million m³ to two significant figures ("about"): 12 345 678 → "12", 1 234 567 → "1.2", 456 789 → "0.46". */
export function aboutMillion(m3: number): string {
	const v = m3 / M3_PER_MILLION;
	if (!(v > 0)) return '0';
	const digits = Math.max(0, 1 - Math.floor(Math.log10(v)));
	const r = Number(v.toPrecision(2));
	return fmtNum(r, digits, true);
}

/** m³ → million m³ for a table, three significant figures at most two decimals: "12.3", "1.23", "0.46". */
export function millionM3(m3: number): string {
	const v = m3 / M3_PER_MILLION;
	const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
	return fmtNum(v, digits);
}

/** A level's name: 100 → "Today’s irrigation", 85 → "15 % less irrigation", 120 → "20 % more irrigation". */
export function levelName(pct: number): string {
	const d = Math.round((pct - 100) * 10) / 10;
	if (d === 0) return 'Today’s irrigation';
	return `${fmtNum(Math.abs(d), 1, true)} % ${d < 0 ? 'less' : 'more'} irrigation`;
}

/** The planted area a level is equivalent to, ha (demand is scaled, not area, so "≈"): null without an area. */
export const equivalentHa = (pct: number, plantedHa: number | null) => (plantedHa && plantedHa > 0 ? (plantedHa * pct) / 100 : null);

/** The planted area of a run's model (Run.model, GET …/runs/:runId), ha: the area its demand was scaled from; null without one. */
export function plantedHaOf(model: Record<string, unknown> | null | undefined): number | null {
	const areas = model?.cropAreas;
	if (!Array.isArray(areas)) return null;
	const m2 = areas.reduce((s: number, a: { areaM2?: unknown }) => s + (typeof a?.areaM2 === 'number' && Number.isFinite(a.areaM2) ? a.areaM2 : 0), 0);
	return m2 > 0 ? m2 / 10_000 : null;
}

export const haText =(ha: number) => `≈ ${fmtNum(ha, ha >= 100 ? 0 : 1, true)} ha`;

export interface SupportLevel {
	id: string;
	/** % of today's demand. */
	pct: number;
	/** levelName. */
	name: string;
	/** "≈ 1 020 ha", or null without a planted area (or on a full-allocation run). */
	haLabel: string | null;
	years: SupportYear[];
	result: SupportResult;
}

export interface SupportAxis {
	/** The axis' end, m³: a round number at or above the wettest year. */
	maxM3: number;
	/** Tick values, m³, from 0. */
	ticks: number[];
	/** The mean of the classed years' natural volume (the MAR over the record), m³. */
	meanM3: number;
}

export interface SupportView {
	levels: SupportLevel[];
	/** Members that didn't run: named, not drawn. */
	notRun: { id: string; name: string }[];
	nYears: number;
	axis: SupportAxis | null;
	keyMessage: string;
	/** Lower levels with a higher threshold, said, not smoothed. */
	notes: string[];
}

/** A round axis end and 4–8 ticks for 0 … max. */
export function supportAxis(maxM3: number, meanM3: number): SupportAxis {
	const top = maxM3 > 0 ? maxM3 : 1;
	const raw = top / 5;
	const mag = 10 ** Math.floor(Math.log10(raw));
	const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => top / s <= 8)!;
	const end = Math.ceil(top / step - 1e-9) * step;
	const ticks: number[] = [];
	for (let i = 0; i * step <= end + step * 1e-9; i++) ticks.push(Number((i * step).toPrecision(12)));
	return { maxM3: end, ticks, meanM3 };
}

export interface SupportInput {
	/** The matrix built from the sweep (MatrixView.outcome). */
	matrix: Pick<OutcomeMatrix, 'levels' | 'cells'>;
	/** Its year classes (MatrixView.classes): each year's natural volume. */
	classes: Pick<WaterYearClasses, 'years'>;
	/** The sweep's members in order: id, level % (demandLevelOf), whether it ran. */
	members: readonly { id: string; pct: number; done: boolean }[];
	/** The base run's planted area, ha; null when unknown. */
	plantedHa: number | null;
	/** A full-allocation run: a level is a share of registered volume, not of the planted area's demand. */
	fullAllocation?: boolean;
}

const levelPhrase = (l: SupportLevel) => (l.pct === 100 ? `today’s irrigation demand${l.haLabel ? ` (${l.haLabel} planted)` : ''}` : `${l.name.charAt(0).toLowerCase()}${l.name.slice(1)}${l.haLabel ? ` (${l.haLabel})` : ''}`);

function firstSentence(l: SupportLevel): string {
	const r = l.result;
	const at = `At ${levelPhrase(l)}`;
	switch (r.kind) {
		case 'threshold':
			return `${at}, the river’s requirement was not met in some years with about ${aboutMillion(r.thresholdM3)} million m³ of natural water or less, and was met in every wetter year.`;
		case 'neverFailed':
			return `${at}, the river’s requirement was met in every year of the record, the driest (${r.driest.label}) included.`;
		case 'wettestFailed':
			return `${at}, the river’s requirement was not met even in the wettest year (${r.wettest.label}), so the record shows no level of water above which it holds.`;
		case 'tooFewYears':
			return `${at}, there are too few years to say.`;
	}
}

const lower = (t: string) => `${t.charAt(0).toLowerCase()}${t.slice(1)}`;

/** What a level did against the reference, as a predicate ("it falls to about 9.8 million m³"), so levels that did the same can share it. */
function laterPredicate(l: SupportLevel, ref: SupportLevel): string {
	const r = l.result;
	if (r.kind === 'neverFailed') return 'it was met in every year';
	if (r.kind === 'wettestFailed') return 'it was not met even in the wettest year';
	if (r.kind === 'tooFewYears') return 'there are too few years to say';
	const x = aboutMillion(r.thresholdM3);
	if (ref.result.kind !== 'threshold') return `breaches start at about ${x} million m³`;
	const before = aboutMillion(ref.result.thresholdM3);
	if (x === before) return `it stays at about ${x} million m³`;
	return `it ${r.thresholdM3 < ref.result.thresholdM3 ? 'falls' : 'rises'} to about ${x} million m³`;
}

const andList = (xs: readonly string[]) => (xs.length === 1 ? xs[0]! : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** More levels than this in one group are named by their range, not one by one. */
const GROUP_LIST_MAX = 3;

/** The levels that did the same, named: one with its area, a few by name, many by their range. */
function groupClause(group: readonly SupportLevel[], predicate: string, all: number): string {
	if (group.length === 1) {
		const l = group[0]!;
		return `at ${lower(l.name)}${l.haLabel ? ` (${l.haLabel})` : ''} ${predicate}`;
	}
	if (group.length <= GROUP_LIST_MAX) return `at ${andList(group.map((l) => lower(l.name)))} ${predicate}`;
	const byPct = [...group].sort((a, b) => b.pct - a.pct);
	const span = `from ${lower(byPct[0]!.name)} to ${lower(byPct[byPct.length - 1]!.name)}`;
	return `at ${group.length === all ? `every other level (${group.length}, ${span})` : `${group.length} levels ${span}`} ${predicate}`;
}

/**
 * The Key message, from the numbers: the reference level (100 %, else the
 * first) in a sentence, then the other levels against it, those that did the
 * same sharing one clause (in the order each outcome first appears), so a
 * 12-level sweep still reads as a sentence or two.
 */
export function keyMessage(levels: readonly SupportLevel[], nYears: number): string {
	if (!levels.length) return 'No demand level of this sweep ran, so there is nothing to compare.';
	if (nYears < IRRIGATION_SUPPORT_MIN_YEARS) {
		return `Only ${nYears} complete water ${nYears === 1 ? 'year' : 'years'} in the record: too few to say where breaches begin (it takes ${IRRIGATION_SUPPORT_MIN_YEARS}).`;
	}
	const ref = levels.find((l) => l.pct === 100) ?? levels[0]!;
	const rest = levels.filter((l) => l !== ref);
	const first = firstSentence(ref);
	if (!rest.length) return first;
	const groups = new Map<string, SupportLevel[]>();
	for (const l of rest) {
		const p = laterPredicate(l, ref);
		groups.set(p, [...(groups.get(p) ?? []), l]);
	}
	const joined = andList([...groups].map(([p, g]) => groupClause(g, p, rest.length)));
	return `${first} ${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`;
}

/** The board: one level per member that ran, in sweep order, the shared axis and the Key message. */
export function buildSupportView(input: SupportInput): SupportView {
	const naturalOf = new Map(input.classes.years.map((y) => [y.waterYear, y] as const));
	const cellsOf = new Map(input.matrix.levels.map((l, i) => [l.id, input.matrix.cells[i]!] as const));
	const levels: SupportLevel[] = [];
	const notRun: { id: string; name: string }[] = [];
	for (const m of input.members) {
		const cells = cellsOf.get(m.id);
		if (!m.done || !cells) {
			notRun.push({ id: m.id, name: levelName(m.pct) });
			continue;
		}
		const years = cells
			.flatMap((c) => c.years)
			.flatMap((y): SupportYear[] => {
				const c = naturalOf.get(y.waterYear);
				return c && Number.isFinite(c.naturalM3) ? [{ waterYear: y.waterYear, label: c.label, naturalM3: c.naturalM3, met: y.met }] : [];
			})
			.sort((a, b) => a.waterYear - b.waterYear);
		const ha = input.fullAllocation ? null : equivalentHa(m.pct, input.plantedHa);
		levels.push({ id: m.id, pct: m.pct, name: levelName(m.pct), haLabel: ha === null ? null : haText(ha), years, result: supportThreshold(years) });
	}
	const all = input.classes.years.filter((y) => Number.isFinite(y.naturalM3));
	const nYears = Math.max(0, ...levels.map((l) => l.years.length));
	const axis = all.length ? supportAxis(Math.max(...all.map((y) => y.naturalM3)), all.reduce((s, y) => s + y.naturalM3, 0) / all.length) : null;

	const notes: string[] = [];
	const byPct = levels.filter((l) => l.result.kind === 'threshold').sort((a, b) => b.pct - a.pct);
	for (let i = 1; i < byPct.length; i++) {
		const hi = byPct[i - 1]!;
		const lo = byPct[i]!;
		if (lo.result.kind === 'threshold' && hi.result.kind === 'threshold' && lo.result.thresholdM3 > hi.result.thresholdM3) {
			notes.push(
				`${lo.name} breaches start in wetter years than at ${hi.name.charAt(0).toLowerCase()}${hi.name.slice(1)} (${lo.result.wettestFailed.label} failed at ${lo.pct} % but not at ${hi.pct} %): less irrigation can mean less water draining back to the river on dry days. Shown as run, not smoothed.`
			);
		}
	}
	return { levels, notRun, nYears, axis, keyMessage: keyMessage(levels, nYears), notes };
}

/** A position on the axis, % of its width. */
export const axisPct = (m3: number, axis: Pick<SupportAxis, 'maxM3'>) => Math.min(100, Math.max(0, (m3 / axis.maxM3) * 100));

/** The marker's words: "Breaches start at about 12 million m³", or why there is no marker. */
export function markerText(r: SupportResult): string {
	switch (r.kind) {
		case 'threshold':
			return `Breaches start at about ${aboutMillion(r.thresholdM3)} million m³`;
		case 'neverFailed':
			return 'Met in every year: no breach to mark';
		case 'wettestFailed':
			return 'Not met even in the wettest year: no marker';
		case 'tooFewYears':
			return `Too few years (${r.nYears}) to mark`;
	}
}

/** The "about" in words: the gap to the next wetter year and any drier years that met it. */
export function spreadText(r: SupportResult): string {
	if (r.kind !== 'threshold') return '–';
	const gap = `between ${r.wettestFailed.label} (${millionM3(r.wettestFailed.naturalM3)}, not met) and ${r.nextMet.label} (${millionM3(r.nextMet.naturalM3)}, met)`;
	return r.metAtOrBelow ? `${gap}; ${r.metAtOrBelow} drier or equal ${r.metAtOrBelow === 1 ? 'year' : 'years'} met it anyway` : gap;
}
