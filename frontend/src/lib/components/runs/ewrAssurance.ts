// Runs & results → Reserve compliance (engine ≥ 0.21.0, docs/model.md §2.9c):
// pure helpers for EwrAssurancePanel.svelte and the headline card.
import { EWR_NATURAL_MAR_TOLERANCE, ewrSourceConfidence, naturalMarBeyondTolerance, type EwrAssuranceMonth, type EwrAssuranceSite, type EwrHighFlowReport, type RunSummary } from '@water-management/engine';
import { fmtNum, fmtPct, fmtQty } from '$lib/format/number';
import { monthName } from '$lib/format/months';

/** The site the headline reports: the outlet when it has a table, else the first site. */
export function headlineSite(summary: Pick<RunSummary, 'ewrAssurance'>): EwrAssuranceSite | null {
	const sites = summary.ewrAssurance ?? [];
	return sites.find((s) => s.isOutlet) ?? sites[0] ?? null;
}

export const UNIT_LABEL = { mcm: 'Mm³', m3s: 'm³/s' } as const;

/** A flow in the table's unit, to about three significant figures. */
export function fmtFlow(v: number | null | undefined): string {
	if (v == null || !Number.isFinite(v)) return '–';
	const a = Math.abs(v);
	return fmtNum(v, a === 0 ? 0 : a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : Math.min(6, 2 - Math.floor(Math.log10(a))));
}

/** m³ → Mm³ text. */
export const fmtMm3 = (m3: number) => fmtQty(m3 / 1e6, 3);

/** "Met in 18 of 24 months (75.0 %)", or why not assessed. */
export function verdict(s: EwrAssuranceSite): string {
	const o = s.overall;
	if (!o.months) return 'Not assessed: the run has no complete calendar month.';
	if (o.met === o.months) return `Met in every one of the ${fmtNum(o.months)} complete months.`;
	if (o.met === 0) return `Not met in any of the ${fmtNum(o.months)} complete months.`;
	return `Met in ${fmtNum(o.met)} of ${fmtNum(o.months)} months (${fmtPct(o.rate)}); not met in ${fmtNum(o.months - o.met)}.`;
}

/**
 * The table's source with its confidence (engine ≥ 1.5.0, WP-3.7): "Gazetted
 * Reserve: GN 123 of 2010", "Desktop estimate, low confidence: DRM run …", or
 * the bare source when the table doesn't say what kind it is. `low` marks a
 * desktop estimate, which the panel sets apart.
 */
export function sourceLine(s: Pick<EwrAssuranceSite, 'source' | 'sourceKind'>): { text: string; low: boolean } {
	const confidence = ewrSourceConfidence(s.sourceKind);
	return { text: confidence ? `${confidence}: ${s.source}` : `Source: ${s.source}`, low: s.sourceKind === 'desktop' };
}

/**
 * The run's natural MAR at the site against the determination's (engine ≥
 * 1.11.0, model.md §2.9c), or null when the table records none. `caution`
 * when the percentile comes from the run and the gap is beyond
 * EWR_NATURAL_MAR_TOLERANCE, the case the run warns about.
 */
export function naturalMarLine(s: Pick<EwrAssuranceSite, 'naturalMar' | 'naturalSource'>): { text: string; caution: boolean } | null {
	const m = s.naturalMar;
	if (!m) return null;
	const d = Math.round(m.differencePct);
	const gap = d === 0 ? 'the same as' : `${fmtNum(Math.abs(d))} % ${d > 0 ? 'above' : 'below'}`;
	const caution = s.naturalSource === 'run' && naturalMarBeyondTolerance(m.differencePct);
	const tail = caution ? `: beyond ±${fmtNum(100 * EWR_NATURAL_MAR_TOLERANCE)} %, so the percentiles from the run may pass or fail months the determination's own curve would not.` : '.';
	return { text: `Natural MAR at the site: ${fmtFlow(m.runMcm)} Mm³/a in this run, ${gap} the determination's ${fmtFlow(m.tableMcm)} Mm³/a${tail}`, caution };
}

/** The method in one sentence: where the percentile comes from, the unit, what the table covers, its scale. */
export function describeMethod(s: EwrAssuranceSite): string {
	const nat = s.naturalSource === 'run' ? 'the run’s own natural flow at the site' : 'the table’s natural flows';
	const covers = s.component === 'total' ? 'total flow (low and high flows)' : 'low flows only';
	const scale = s.scale === 1 ? '' : `, scaled × ${fmtNum(s.scale, 4, true)}`;
	return `Each month’s requirement is the EWR at the % point its natural flow sits at (percentile from ${nat}); table in ${s.unit === 'mcm' ? 'Mm³ per month' : 'm³/s, the month’s mean'}, ${covers}${scale}.`;
}

/** "Oct 2001". */
export const monthLabel = (m: Pick<EwrAssuranceMonth, 'year' | 'month'>) => `${monthName(m.month)} ${m.year}`;

/** The natural-flow condition: "62 %" or "wetter than 10 %" / "drier than 99 %". */
export function conditionText(m: Pick<EwrAssuranceMonth, 'percentile' | 'beyond'>): string {
	const r = Math.round(m.percentile * 10) / 10;
	const p = `${fmtNum(r, Number.isInteger(r) ? 0 : 1)} %`;
	return m.beyond === 'wetter' ? `wetter than ${p}` : m.beyond === 'drier' ? `drier than ${p}` : p;
}

/** Share of the requirement that flowed, "83%" (– when nothing was required). */
export const shareOfRequired = (m: Pick<EwrAssuranceMonth, 'required' | 'actual'>) => (m.required > 0 ? fmtPct(m.actual / m.required, 0) : '–');

/** A calendar month's FDC check in words: "8 of 10 points", or "–" without a complete year. */
export function fdcText(fdc: readonly { met: boolean | null }[]): string {
	const judged = fdc.filter((f) => f.met !== null);
	return judged.length ? `${judged.filter((f) => f.met).length} of ${judged.length}` : '–';
}

/**
 * A month in the Reserve heat map: 'met'; 'high' (the low flows were met but
 * not the total: the high flows are the part that failed; only with a
 * low-flow grid); 'low' (the low flows failed, or, without a low-flow grid,
 * the month failed).
 */
export type ReserveCellState = 'met' | 'high' | 'low';

export interface ReserveCell {
	state: ReserveCellState;
	/** Simulated ÷ required (null when nothing was required). */
	share: number | null;
	month: EwrAssuranceMonth;
}

/** The monthly results as water-year rows × Oct … Sep columns (null where the run has no complete month). */
export function reserveGrid(s: Pick<EwrAssuranceSite, 'months'>): { waterYears: number[]; cells: (ReserveCell | null)[][] } {
	const years = [...new Set(s.months.map((m) => m.waterYear))].sort((a, b) => a - b);
	const cells = years.map(() => Array.from({ length: 12 }, () => null as ReserveCell | null));
	for (const m of s.months) {
		const state: ReserveCellState = m.met ? 'met' : m.lowFlowMet ? 'high' : 'low';
		cells[years.indexOf(m.waterYear)]![(m.month + 2) % 12] = { state, share: m.required > 0 ? m.actual / m.required : null, month: m };
	}
	return { waterYears: years, cells };
}

/** A heat-map cell in words, for its title and the screen-reader text. */
export function reserveCellText(c: ReserveCell): string {
	const what = c.state === 'met' ? 'met' : c.state === 'high' ? 'low flows met, high flows not met' : c.month.lowFlowMet === false ? 'low flows not met' : 'not met';
	const share = c.share === null ? '' : `, ${fmtPct(c.share, 0)} of the requirement`;
	return `${monthLabel(c.month)}: ${what}${share}`;
}

/** A high-flow component's result in words: "Met in 7 of 9 years that had it naturally". */
export function highFlowVerdict(h: Pick<EwrHighFlowReport, 'overall'>): string {
	const o = h.overall;
	if (!o.years) return 'Not assessed: the run has no complete water year.';
	if (!o.required) return `Not required in any of the ${fmtNum(o.years)} water years: natural flow never reached it.`;
	return `Met in ${fmtNum(o.met)} of the ${fmtNum(o.required)} water year${o.required === 1 ? '' : 's'} whose natural flow had it (${fmtPct(o.met / o.required, 0)}).`;
}

/** The shortest record of any assessed calendar month, when it is under the engine's threshold (for a caution line). */
export function fewYears(s: EwrAssuranceSite, threshold: number): number | null {
	const years = s.byMonth.filter((m) => m.years > 0).map((m) => m.years);
	if (!years.length) return null;
	const few = Math.min(...years);
	return few < threshold ? few : null;
}
