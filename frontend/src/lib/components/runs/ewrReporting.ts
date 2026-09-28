// Reserve compliance as the gazette and CMAs report it (engine ≥ 1.19.0,
// calibration research CR-29, docs/model.md §2.9c): % of time and volume not
// met per month from daily data, the EWR as %nMAR, and the monthly
// flow-duration curves of natural, present-day and scenario flow against the
// EWR curve. Pure helpers for EwrDailyCompliance.svelte, EwrFdcOverlay.svelte
// and EwrAssurancePanel.svelte.
import type { EwrAssuranceSite } from '@water-management/engine';
import { fmtNum, fmtPct } from '$lib/format/number';
import { monthName } from '$lib/format/months';
import { fmtFlow } from './ewrAssurance';

export interface EwrDailyRow {
	month: number;
	label: string;
	/** Monthly verdict beside it: months met ÷ complete years. */
	monthsMet: string;
	/** "3 of 62". */
	daysNotMet: string;
	timeNotMet: string;
	volumeNotMet: string;
	/** Days show a shortfall the monthly verdict doesn't: some days short in a month of the year whose every month was met. */
	hiddenByMonthly: boolean;
}

/** One row per month of the year (water-year order); null on a run from before engine 1.19.0. */
export function dailyRows(s: Pick<EwrAssuranceSite, 'byMonth'>): EwrDailyRow[] | null {
	if (!s.byMonth.some((m) => m.daily)) return null;
	return s.byMonth.map((m) => {
		const d = m.daily;
		return {
			month: m.month,
			label: monthName(m.month),
			monthsMet: m.rate === null ? '–' : fmtPct(m.rate, 0),
			daysNotMet: d && d.days ? `${fmtNum(d.daysNotMet)} of ${fmtNum(d.days)}` : '–',
			timeNotMet: d?.timeNotMet == null ? '–' : fmtPct(d.timeNotMet, 1),
			volumeNotMet: d?.volumeNotMet == null ? '–' : fmtPct(d.volumeNotMet, 1),
			hiddenByMonthly: !!d && d.daysNotMet > 0 && m.rate === 1
		};
	});
}

/** The whole run from daily data, in one sentence; null before engine 1.19.0. */
export function dailyHeadline(s: Pick<EwrAssuranceSite, 'daily'>): string | null {
	const d = s.daily;
	if (!d) return null;
	if (!d.days) return 'No complete month to assess day by day.';
	if (!d.daysNotMet) return `Every one of the ${fmtNum(d.days)} days met its day’s requirement.`;
	return `Below the day’s requirement on ${fmtNum(d.daysNotMet)} of ${fmtNum(d.days)} days (${fmtPct(d.timeNotMet, 1)} of the time); ${fmtPct(d.volumeNotMet, 1)} of the required volume was not delivered.`;
}

/** The EWR as %nMAR, for a stat tile; null when the run lacks it (before engine 1.19.0, or a calendar month missing). */
export function nmarTile(s: Pick<EwrAssuranceSite, 'ewrPctNmar'>): { value: string; sub: string } | null {
	const e = s.ewrPctNmar;
	if (!e) return null;
	const low = e.lowFlowPct != null ? `; low flows ${fmtNum(e.lowFlowPct, 1)} %` : '';
	return {
		value: e.pct === null ? '–' : fmtNum(e.pct, 1),
		sub: `${fmtFlow(e.ewrMcm)} of ${fmtFlow(e.naturalMarMcm)} Mm³/a natural MAR at the site${low}`
	};
}

export type FdcLineKey = 'natural' | 'present' | 'scenario' | 'ewr';

export interface FdcLine {
	key: FdcLineKey;
	label: string;
	/** At each of the site's % points; null where there is no complete month. */
	values: (number | null)[];
}

/**
 * The lines of one month of the year's overlay (index into byMonth,
 * water-year order): the run's natural flow, its simulated (present-day)
 * flow, another run's simulated flow when given (a scenario, or run B), and
 * the EWR curve. A line with no value is left out.
 */
export function fdcLines(site: EwrAssuranceSite, w: number, opts: { presentLabel?: string; other?: { label: string; site: EwrAssuranceSite } | null } = {}): FdcLine[] {
	const m = site.byMonth[w];
	if (!m) return [];
	const lines: FdcLine[] = [
		{ key: 'natural', label: 'Natural', values: m.fdc.map((f) => f.natural ?? null) },
		{ key: 'present', label: opts.presentLabel ?? 'Present day (this run)', values: m.fdc.map((f) => f.impacted) }
	];
	const o = opts.other?.site.byMonth[w];
	// Only on the same % points: another table's curve can't be drawn on this one's.
	if (o && samePoints(opts.other!.site.points, site.points)) lines.push({ key: 'scenario', label: opts.other!.label, values: o.fdc.map((f) => f.impacted) });
	lines.push({ key: 'ewr', label: 'EWR', values: m.fdc.map((f) => f.required) });
	return lines.filter((l) => l.values.some((v) => v !== null));
}

const samePoints = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((p, i) => p === b[i]);

export interface FdcOverlayChart {
	paths: { key: FdcLineKey; d: string }[];
	xTicks: { x: number; label: string }[];
	yTicks: { y: number; label: string }[];
	/** Some value at or below zero was drawn at the axis floor (a log axis has no zero). */
	floored: boolean;
}

/** Log-y, linear-x (exceedance %) geometry for the overlay. */
export function fdcOverlayChart(lines: readonly FdcLine[], points: readonly number[], w: number, h: number, pad = { l: 56, r: 12, t: 10, b: 26 }): FdcOverlayChart {
	const vals = lines.flatMap((l) => l.values).filter((v): v is number => v !== null);
	const positive = vals.filter((v) => v > 0);
	const lo = positive.length ? Math.min(...positive) / 1.5 : 0.1;
	const hi = positive.length ? Math.max(...positive) * 1.5 : 10;
	const ly = (v: number) => Math.log10(Math.max(v, lo));
	const y = (v: number) => pad.t + ((ly(hi) - ly(v)) / (ly(hi) - ly(lo))) * (h - pad.t - pad.b);
	const x = (p: number) => pad.l + (p / 100) * (w - pad.l - pad.r);
	const r = (n: number) => Math.round(n * 10) / 10;
	const paths = lines.map((l) => {
		let d = '';
		let pen = false;
		l.values.forEach((v, i) => {
			if (v === null) {
				pen = false;
				return;
			}
			d += `${pen ? 'L' : 'M'}${r(x(points[i]!))},${r(y(v))} `;
			pen = true;
		});
		return { key: l.key, d: d.trim() };
	});
	// Ticks at 1, 2 and 5 × 10ⁿ when the range is under two decades, else at the powers of ten.
	const steps = Math.log10(hi / lo) < 2 ? [1, 2, 5] : [1];
	const yTicks: FdcOverlayChart['yTicks'] = [];
	for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++)
		for (const k of steps) {
			const v = k * 10 ** e;
			if (v >= lo && v <= hi) yTicks.push({ y: r(y(v)), label: fmtFlow(v) });
		}
	return {
		paths,
		xTicks: [0, 20, 40, 60, 80, 100].map((p) => ({ x: r(x(p)), label: `${p} %` })),
		yTicks,
		floored: vals.some((v) => v <= 0)
	};
}

/** The same EWR site in another run: the outlet with the outlet, else by node id, else by name. */
export function matchSite(site: Pick<EwrAssuranceSite, 'isOutlet' | 'nodeId' | 'name'>, others: readonly EwrAssuranceSite[] | undefined): EwrAssuranceSite | null {
	const list = others ?? [];
	if (site.isOutlet) return list.find((o) => o.isOutlet) ?? null;
	return list.find((o) => !o.isOutlet && o.nodeId === site.nodeId) ?? list.find((o) => !o.isOutlet && o.name.trim().toLowerCase() === site.name.trim().toLowerCase()) ?? null;
}
