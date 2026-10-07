// Pure helpers for the assurance-of-supply panels (engine ≥ 0.32.0, WP-3.4,
// docs/model.md §2.11a–b): the stress heat map's cells and the water
// account's rows. Unit-tested in reliability.test.ts.
import { STRESS_LABEL, type StressClass, type StressGrid, type StressSummary, type SupplyAssurance, type WaterAccountRow } from '@water-management/engine';
import { fmtNum } from '$lib/format/number';

/** The engine version that first computed RunSummary.supplyAssurance. */
export const ASSURANCE_ENGINE = '0.32.0';

/** "Not computed by engine x.y" for a run made before the engine had it. */
export function notComputedText(engineVersion: string | null | undefined): string {
	const v = engineVersion?.split('.').slice(0, 2).join('.');
	return `Not computed by engine ${v || 'before 0.32'}: this run was made before assurance of supply existed (engine ${ASSURANCE_ENGINE}). Run the model again to see it.`;
}

/** Heat-map bin per class: the ordinal ramp, light (Low) to dark (Critical). */
export const STRESS_BIN: Record<StressClass, 0 | 1 | 2 | 3 | 4> = { low: 0, moderate: 1, high: 2, severe: 3, critical: 4 };

/** The class name as the cell shows it: short enough for 12 columns, never colour alone. */
export const STRESS_SHORT: Record<StressClass, string> = { low: 'Low', moderate: 'Mod', high: 'High', severe: 'Sev', critical: 'Crit' };

export const STRESS_ORDER: StressClass[] = ['low', 'moderate', 'high', 'severe', 'critical'];

/** Percentage text of a fraction, or "–". */
export const pctText = (v: number | null | undefined, digits = 0): string => (v == null ? '–' : `${fmtNum(v * 100, digits)}%`);

/** The legend: each class with its range, from the thresholds the run used. */
export function stressLegend(s: Pick<StressSummary, 'thresholds'>): { cls: StressClass; label: string; range: string }[] {
	const t = s.thresholds;
	return STRESS_ORDER.map((cls) => {
		const i = t.findIndex((x) => x.cls === cls);
		const min = i >= 0 ? t[i]!.min : null;
		const above = i > 0 ? t[i - 1]!.min : i === 0 ? null : (t.at(-1)?.min ?? null);
		const range =
			cls === 'critical'
				? `below ${pctText(above)}`
				: i === 0
					? `≥ ${pctText(min)}`
					: `${pctText(min)} to under ${pctText(above)}`;
		return { cls, label: STRESS_LABEL[cls], range };
	});
}

/** How many months fell in each class (the whole run), for the heat map's one-line summary. */
export function classCounts(g: StressGrid): Record<StressClass, number> {
	const n: Record<StressClass, number> = { low: 0, moderate: 0, high: 0, severe: 0, critical: 0 };
	for (const row of g.stressClass) for (const c of row) if (c) n[c]++;
	return n;
}

/** One line of the water account table: in, out, storage, residual. */
export interface AccountLine {
	key: keyof WaterAccountRow;
	label: string;
	side: 'in' | 'out' | 'storage' | 'check' | 'memo';
	/** Shown only when some row has it non-zero (a term only some networks have). */
	optional?: true;
}

export const ACCOUNT_LINES: AccountLine[] = [
	{ key: 'naturalFlowM3', label: 'Natural flow', side: 'in' },
	{ key: 'rainOnDamsM3', label: 'Rain on dams', side: 'in', optional: true },
	{ key: 'groundwaterM3', label: 'Groundwater pumped', side: 'in', optional: true },
	{ key: 'transfersM3', label: 'Transfers (net)', side: 'in', optional: true },
	{ key: 'landCoverM3', label: 'Removed by land cover', side: 'out', optional: true },
	{ key: 'unallocatedM3', label: 'Natural flow not allocated to a hydrological unit', side: 'out', optional: true },
	{ key: 'consumptiveIrrigationM3', label: 'Consumptive irrigation', side: 'out' },
	{ key: 'otherUseM3', label: 'Other users (taken − returned)', side: 'out', optional: true },
	{ key: 'damEvaporationM3', label: 'Dam evaporation', side: 'out', optional: true },
	{ key: 'poolEvaporationM3', label: 'Evaporation from river abstractions’ pools', side: 'out', optional: true },
	{ key: 'damSeepageLostM3', label: 'Dam seepage lost from the catchment', side: 'out', optional: true },
	{ key: 'streamDepletionM3', label: 'Stream depletion (boreholes)', side: 'out', optional: true },
	{ key: 'conveyanceLossM3', label: 'River off-takes: lost on the way', side: 'out', optional: true },
	{ key: 'reachLossM3', label: 'Bed losses in the reaches', side: 'out', optional: true },
	{ key: 'outflowM3', label: 'Outflow at the outlet', side: 'out' },
	{ key: 'storageChangeM3', label: 'Change in dam storage', side: 'storage' },
	{ key: 'residualM3', label: 'Residual (in − out − change in storage)', side: 'check' },
	{ key: 'damSeepageM3', label: 'Memo: dam seepage (rejoins the river)', side: 'memo', optional: true },
	{ key: 'damReleaseM3', label: 'Memo: released below the dams', side: 'memo', optional: true },
	{ key: 'rainM3', label: 'Memo: rain on the catchment', side: 'memo', optional: true }
];

/**
 * A float residue below this share of the flows is noise, not a term: the
 * optional lines drop out when every row is within it (net transfers, the
 * shares' unallocated remainder).
 */
const NOISE = 1e-9;

/** The lines to show for these rows: optional ones only when some row has a real value. */
export function accountLines(rows: readonly WaterAccountRow[]): AccountLine[] {
	return ACCOUNT_LINES.filter((l) => {
		if (!l.optional) return true;
		return rows.some((r) => {
			const v = r[l.key];
			return typeof v === 'number' && Math.abs(v) > NOISE * Math.max(r.scaleM3, 1);
		});
	});
}

/** One segment of the account chart's in or out bar: a share of the bar's total. */
export interface Segment {
	key: string;
	label: string;
	m3: number;
	/** 0–100. */
	pct: number;
}

/**
 * The chart's two bars for one row: what came in, and where it went (the
 * out terms plus water left in storage). Negative terms (a dam that ran down,
 * a net outflow through transfers) move to the other side, so each bar only
 * adds positive volumes and the two bars are the same length when the account
 * closes.
 */
export function accountBars(r: WaterAccountRow): { inBar: Segment[]; outBar: Segment[]; total: number } {
	const inTerms: [string, string, number][] = [];
	const outTerms: [string, string, number][] = [];
	for (const l of ACCOUNT_LINES) {
		if (l.side !== 'in' && l.side !== 'out' && l.side !== 'storage') continue;
		const v = r[l.key];
		if (typeof v !== 'number' || v === 0) continue;
		const label = l.side === 'storage' ? (v > 0 ? 'Into dam storage' : 'Drawn from dam storage') : l.label;
		const isIn = l.side === 'in';
		// A positive storage change is water kept (an out); a negative one supplied water (an in).
		const goesOut = l.side === 'storage' ? v > 0 : isIn ? v < 0 : v > 0;
		(goesOut ? outTerms : inTerms).push([l.key, label, Math.abs(v)]);
	}
	const total = Math.max(
		inTerms.reduce((s, t) => s + t[2], 0),
		outTerms.reduce((s, t) => s + t[2], 0)
	);
	const seg = (t: [string, string, number][]) => t.filter(([, , m3]) => total > 0 && m3 / total >= 1e-6).map(([key, label, m3]) => ({ key, label, m3, pct: (100 * m3) / total }));
	return { inBar: seg(inTerms), outBar: seg(outTerms), total };
}

/** Share of the EWR requirement met, or null without a requirement. */
export const ewrMetShare = (e: { requiredM3: number; metM3: number }): number | null => (e.requiredM3 > 0 ? e.metM3 / e.requiredM3 : null);

/**
 * Part water years the annual measure left out (engine ≥ 1.11.0, docs/model.md
 * §2.11a): the most any unit or user had, since a part year counts only for
 * one with demand in it. null on a run before 1.11.0, which counted them.
 */
export function partWaterYears(a: Pick<SupplyAssurance, 'reliability'>): number | null {
	const known = a.reliability.map((r) => r.partWaterYears).filter((n): n is number => typeof n === 'number');
	return known.length ? Math.max(...known) : null;
}
