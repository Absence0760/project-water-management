// Settings → the daily EWR at the outlet (engine ≥ 1.77.0, issue #455): pure
// helpers for EwrDailySourceFields.svelte. The checks are the engine's own
// (ewrDailySourceIssues), so the form, the save and the run agree.
import { DEFAULT_ASSURANCE_POINTS, ewrDailySourceIssues, reserveTableOf, type EwrDailySource, type EwrReserveTable, type OutletEwrInfo } from '@water-management/engine';

/** What blocks Save, or null: the first of the engine's issues (a pragmatic source with tables half entered saves). */
export function dailySourceError(v: EwrDailySource | null | undefined): string | null {
	if (!v) return null;
	const issues = ewrDailySourceIssues(v);
	return issues.length ? `Daily EWR at the outlet: ${issues[0]!.message}` : null;
}

/**
 * The model's natural MAR a run worked out, for the MAR ratio's factor in the
 * form: the last run's own (its summary's outletEwr, when it used the tables),
 * else its mean natural flow × 365.25 ÷ 10⁶ (the catchment's, before any bed
 * losses: an estimate until a run uses the tables).
 */
export interface LastRunScale {
	modelMarMm3: number;
	/** Read off the run's outletEwr (exact), not estimated from its mean natural flow. */
	exact: boolean;
}

/** The last run's natural MAR for the form, from its summary; null without one. */
export function lastRunScale(summary: { catchment?: { meanNaturalFlowM3Day?: number; outletEwr?: OutletEwrInfo } } | null | undefined): LastRunScale | null {
	const c = summary?.catchment;
	if (!c) return null;
	if (c.outletEwr?.modelMarMm3 !== undefined) return { modelMarMm3: c.outletEwr.modelMarMm3, exact: true };
	return typeof c.meanNaturalFlowM3Day === 'number' ? { modelMarMm3: (c.meanNaturalFlowM3Day * 365.25) / 1e6, exact: false } : null;
}

const n3 = (v: number) => String(Number(v.toPrecision(5)));

/** The scale factor's line in the form: its value and inputs, or what it still needs. */
export function scaleFactor(src: EwrDailySource, modelAreaKm2: number, lastRun: LastRunScale | null): string {
	if (src.scaling === 'area') {
		if (!(src.tableAreaKm2 && src.tableAreaKm2 > 0)) return 'Scale factor: enter the table’s catchment area.';
		if (!(modelAreaKm2 > 0)) return 'Scale factor: 0, since no hydrological unit has an area yet.';
		return `Scale factor s = ${n3(modelAreaKm2)} km² ÷ ${n3(src.tableAreaKm2)} km² = ${String(Number((modelAreaKm2 / src.tableAreaKm2).toPrecision(4)))}.`;
	}
	if (!(src.tableMarMm3 && src.tableMarMm3 > 0)) return 'Scale factor: enter the table’s MAR.';
	const base = `Scale factor s = the model’s natural MAR at the outlet ÷ ${n3(src.tableMarMm3)} Mm³/a, worked out by each run from its own natural flow`;
	if (!lastRun) return `${base}. Run the model to see it.`;
	return `${base}: ${lastRun.exact ? 'the last run’s' : 'about, from the last run’s mean natural flow,'} ${n3(lastRun.modelMarMm3)} ÷ ${n3(src.tableMarMm3)} = ${String(Number((lastRun.modelMarMm3 / src.tableMarMm3).toPrecision(4)))}.`;
}

/**
 * The scale factor s where the form can know it: the area ratio from the
 * modelled and table areas, the MAR ratio from the last run's natural MAR
 * (exact or estimated, as the factor line says); null when an input is
 * missing (no table area or MAR, no area yet, no run yet).
 */
export function knownScale(src: EwrDailySource, modelAreaKm2: number, lastRun: LastRunScale | null): number | null {
	if (src.scaling === 'area') return src.tableAreaKm2 && src.tableAreaKm2 > 0 && modelAreaKm2 > 0 ? modelAreaKm2 / src.tableAreaKm2 : null;
	return src.tableMarMm3 && src.tableMarMm3 > 0 && lastRun ? lastRun.modelMarMm3 / src.tableMarMm3 : null;
}

/** The percentile tables' one set of names (issue #552): the form's captions and paste choices, and the scaled view. */
export const DAILY_TABLE_LABELS = {
	naturalPctM3s: 'Natural flow percentile table',
	reservePctM3s: 'Total Reserve flow percentile table',
	lowFlowPctM3s: 'Reserve flow without high flows percentile table'
} as const;

/** What the form says of a Reserve grid: the one the daily EWR reads, or one shown only; null for the natural table. */
export function reserveGridRole(which: keyof typeof DAILY_TABLE_LABELS, reserveTable: EwrReserveTable): 'the daily EWR' | 'not used by the daily EWR' | null {
	if (which === 'naturalPctM3s') return null;
	return (which === 'lowFlowPctM3s') === (reserveTable === 'withoutHighFlows') ? 'the daily EWR' : 'not used by the daily EWR';
}

/** A source's tables as the run reads them: each value × s (issue #90 B1 gap a); a blank stays blank. */
export interface ScaledEwrTables {
	method: 'tab' | 'percentile';
	scale: number;
	/** The TAB flows × s, m³/s, Oct … Sep ('tab'). */
	tabM3s: (number | null)[] | null;
	/** The natural flow percentile table × s, m³/s, 12 rows × the 10 points ('percentile'). */
	naturalPctM3s: (number | null)[][] | null;
	/** The total Reserve flow percentile table × s ('percentile'). */
	reservePctM3s: (number | null)[][] | null;
	/** The Reserve flows without high flows × s ('percentile', issue #552); null when not entered. */
	lowFlowPctM3s: (number | null)[][] | null;
	/** Which Reserve table is the daily EWR ('percentile'; 'total' under 'tab'). */
	reserveTable: EwrReserveTable;
}

const times = (v: number | null | undefined, s: number): number | null => (typeof v === 'number' && Number.isFinite(v) ? v * s : null);

/**
 * The method's tables × s, for showing beside the entered ones in Settings
 * and with a run (its own settings snapshot and summary s). Null for the
 * pragmatic EWR, an unknown or non-finite s, or a method whose tables
 * haven't been entered. Only the tables the method reads: the TAB flows
 * under 'tab'; under 'percentile' the natural flow and both Reserve tables
 * (the total and the flows without high flows, issue #552), `reserveTable`
 * saying which one is the EWR. The natural
 * rows are the entered values × s; a rising row the run reads as its
 * running minimum, which the run's warnings say (ewrDailySourceNotes).
 */
export function scaledEwrTables(src: EwrDailySource | null | undefined, scale: number | null | undefined): ScaledEwrTables | null {
	if (!src || src.method === 'pragmatic' || typeof scale !== 'number' || !Number.isFinite(scale)) return null;
	const grid = (g: number[][] | null) => (g ? g.map((row) => row.map((v) => times(v, scale))) : null);
	if (src.method === 'tab') return src.tabM3s ? { method: 'tab', scale, tabM3s: src.tabM3s.map((v) => times(v, scale)), naturalPctM3s: null, reservePctM3s: null, lowFlowPctM3s: null, reserveTable: 'total' } : null;
	if (!src.naturalPctM3s && !src.reservePctM3s && !src.lowFlowPctM3s) return null;
	return { method: 'percentile', scale, tabM3s: null, naturalPctM3s: grid(src.naturalPctM3s), reservePctM3s: grid(src.reservePctM3s), lowFlowPctM3s: grid(src.lowFlowPctM3s ?? null), reserveTable: reserveTableOf(src) };
}

/**
 * Twelve monthly flows pasted in a row (spaces, tabs, commas or semicolons
 * between them) or a column, optionally with month names before them; in a
 * tab- or semicolon-separated paste "1,25" is a decimal comma.
 */
export function parseMonthlyRow(text: string): { values: number[] } | { error: string } {
	const decimalComma = /[\t;]/.test(text);
	const named = text.replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi, ' ');
	const cleaned = decimalComma ? named.replace(/(\d),(\d)/g, '$1.$2') : named;
	const parts = cleaned.split(decimalComma ? /[\s;]+/ : /[\s,;]+/).filter(Boolean);
	if (!parts.length) return { error: 'Paste the 12 flows first.' };
	const values = parts.map(Number);
	if (values.some((v) => !Number.isFinite(v))) return { error: `“${parts[values.findIndex((v) => !Number.isFinite(v))]}” isn't a number.` };
	if (values.length !== 12) return { error: `Expected 12 flows, Oct … Sep; the paste has ${values.length}.` };
	return { values };
}

/** A synthetic CSV of a percentile table (m³/s, month rows, the ten points), for the layout only. */
export function exampleDailyCsv(): string {
	const season = [0.9, 0.5, 0.2, 0.1, 0.1, 0.15, 0.4, 1.3, 2.4, 2.8, 2.1, 1.5];
	const wy = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
	const rows = wy.map((m, i) => [m, ...DEFAULT_ASSURANCE_POINTS.map((p) => (season[i]! * (1.6 - (1.5 * p) / 100)).toFixed(3))].join(','));
	return `${['Month', ...DEFAULT_ASSURANCE_POINTS.map((p) => `${p}%`)].join(',')}\n${rows.join('\n')}\n`;
}

/** The method's name in a sentence ("The daily EWR still comes from the DRM TAB file."). */
const METHOD_NAME: Record<EwrDailySource['method'], string> = {
	pragmatic: 'the pragmatic EWR',
	tab: 'the DRM TAB file',
	percentile: 'the DRM percentile tables'
};

/**
 * What a .rul loaded into the daily EWR does (issues #455, #552): it fills the
 * three percentile tables (the natural duration curves, the total Reserve and
 * the Reserve flows without high flows; a file without the last block clears
 * it, so no table from an older file is left beside the new ones) and nothing
 * else. The method and the Reserve table the person picked stay: a .rul
 * loaded under the TAB file fills the tables for later, says the TAB file is
 * still in use, and offers the switch (`offerPercentile`) as a choice. A file
 * without the block the chosen Reserve table needs says so.
 */
export function rulLoad(
	method: EwrDailySource['method'],
	tables: Pick<EwrDailySource, 'naturalPctM3s' | 'reservePctM3s' | 'lowFlowPctM3s'>,
	fileName: string,
	unit: 'm3s' | 'mcm',
	reserveTable: EwrReserveTable = 'total'
): { patch: Pick<EwrDailySource, 'naturalPctM3s' | 'reservePctM3s' | 'lowFlowPctM3s'>; text: string; offerPercentile: boolean } {
	const read = `Read ${fileName} (DRM rule curves${unit === 'mcm' ? ', converted from Mm³ a month to m³/s, February 28 days' : ', m³/s'})`;
	const lowFlowPctM3s = tables.lowFlowPctM3s ?? null;
	const patch = { naturalPctM3s: tables.naturalPctM3s, reservePctM3s: tables.reservePctM3s, lowFlowPctM3s };
	const filled = lowFlowPctM3s ? 'the natural duration curves, the total Reserve and the Reserve flows without high flows fill the three tables' : 'the natural duration curves and the total Reserve fill two tables; the file has no Reserve Flows without High Flows block, so that table is empty';
	const missing = !lowFlowPctM3s && reserveTable === 'withoutHighFlows' ? ' The daily EWR reads the Reserve flows without high flows, which this file lacks: pick the total Reserve flows, or load a file with that block.' : '';
	if (method === 'percentile') return { patch, text: `${read}: ${filled}.${missing}`, offerPercentile: false };
	return {
		patch,
		text: `${read}: ${filled}. The daily EWR still comes from ${METHOD_NAME[method]}; the tables are used only once you pick them.`,
		offerPercentile: true
	};
}
