// The Settings form's GR4J potential-evaporation input (settings.pe, engine ≥
// 0.31.0, issue #39, docs/model.md §2.4a): which source GR4J's PE comes from,
// switching between them, the annual total the form shows, the check that
// blocks Save, and a one-line description for the fit record and the report.
import { gr4jPeMonthlyMm, PE_SOURCE_MAX, type PeInput, type PeKind } from '@water-management/engine';
import { fmtNum } from '$lib/format/number';
import { WATER_YEAR_MONTHS } from '$lib/format/months';

/** The form's mutable copy of a `monthly` input (the engine's `Monthly` is a readonly tuple). */
export type EditablePe = { kind: 'pan' } | { kind: 'monthly'; mm: number[]; source: string };

/** Largest monthly PE the API accepts, in mm (the same bound as the A-pan row). */
export const PE_MONTH_MAX_MM = 10_000;

export const PE_KIND_OPTIONS: { value: PeKind; label: string }[] = [
	{ value: 'pan', label: 'Pan coefficient × A-pan' },
	{ value: 'monthly', label: 'Monthly PE, entered directly' }
];

type PeSettings = { apanMm: readonly number[]; panCoefficient: readonly number[]; pe?: PeInput | EditablePe | null };

/** The stored input as the engine runs it: absent (a project saved before engine 0.31.0) is pan × A-pan. */
export const peOf = (s: { pe?: PeInput | EditablePe | null }): PeInput | EditablePe => s.pe ?? { kind: 'pan' };

/** GR4J's potential evaporation over a year, in mm, under whichever input is active. */
export function annualGr4jPeMm(s: PeSettings): number {
	return gr4jPeMonthlyMm({ ...s, pe: s.pe as PeInput | null | undefined }).reduce((t, v) => t + (Number.isFinite(v) ? v : 0), 0);
}

/**
 * Switch the input's kind. A new monthly row starts from the PE GR4J runs on
 * now (pan coefficient × A-pan, to 0.1 mm), so the annual total doesn't jump,
 * with the source blank: the form won't save until it is written. `previous`
 * brings back a monthly row the form had before switching away from it.
 */
export function withPeKind(s: PeSettings, kind: PeKind, previous?: EditablePe | null): EditablePe {
	const current = peOf(s);
	if (current.kind === kind) return current as EditablePe;
	if (kind === 'pan') return { kind: 'pan' };
	if (previous?.kind === 'monthly') return { kind: 'monthly', mm: [...previous.mm], source: previous.source };
	const mm = gr4jPeMonthlyMm({ apanMm: s.apanMm, panCoefficient: s.panCoefficient }).map((v) => Math.round(v * 10) / 10);
	return { kind: 'monthly', mm, source: '' };
}

/** The first problem with the input, as the form shows it (and blocks Save on), or null. */
export function peFormError(pe: PeInput | EditablePe | null | undefined): string | null {
	if (!pe || pe.kind === 'pan') return null;
	if (pe.mm.length !== 12) return `Monthly PE needs 12 values, Oct to Sep; it has ${pe.mm.length}.`;
	const bad = pe.mm.flatMap((v, i) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= PE_MONTH_MAX_MM ? [] : [WATER_YEAR_MONTHS[i]]));
	if (bad.length) return `Monthly PE must be 0 to ${fmtNum(PE_MONTH_MAX_MM)} mm in every month: check ${bad.join(', ')}.`;
	const source = pe.source.trim();
	if (!source) return 'Say where the monthly PE comes from: its source is required.';
	if (pe.source.length > PE_SOURCE_MAX) return `The PE source is at most ${PE_SOURCE_MAX} characters; it has ${pe.source.length}.`;
	return null;
}

/**
 * One line for the fit record and the report: "pan coefficient × A-pan", or
 * "monthly, 1,200 mm a year (station FAO-56 ET₀ × 1.0, 2015–2020)".
 */
export function peText(pe: PeInput | EditablePe | null | undefined): string {
	if (!pe || pe.kind !== 'monthly') return 'pan coefficient × A-pan';
	const total = pe.mm.reduce((t, v) => t + (Number.isFinite(v) ? v : 0), 0);
	const source = pe.source.trim();
	return `monthly, entered directly: ${fmtNum(total)} mm a year${source ? ` (${source})` : ''}`;
}

/**
 * Where the model's A-pan comes from (engine ≥ 0.38.0, issue #45,
 * docs/model.md §2.3a), for the Demand section: the daily A-pan series on the
 * days it has a value with these monthly means on the rest, or the monthly
 * means every day. null while the series list is still loading.
 */
export function apanSourceNote(seriesKinds: readonly string[] | null): { daily: boolean; text: string } | null {
	if (seriesKinds === null) return null;
	return seriesKinds.includes('evap_apan_mm')
		? {
				daily: true,
				text: 'A-pan comes from the daily A-pan series (Data tab) on the days it has a value; these monthly means fill the other days, and each run says how many.'
			}
		: { daily: false, text: 'A-pan comes from these monthly means on every day. A daily A-pan record can be added on the Data tab.' };
}

/**
 * The monthly dam evaporation factors (settings.lakeEvapFactorMonthly, WP-3.5)
 * switched on or off: off is null (the one factor every month); on brings back
 * the twelve switched off (`last`, kept until the form is saved or discarded),
 * else the one factor in every month.
 */
export function withLakeMonthly(on: boolean, flat: number, last: readonly number[] | null): number[] | null {
	if (!on) return null;
	return last && last.length === 12 ? [...last] : new Array<number>(12).fill(flat);
}
