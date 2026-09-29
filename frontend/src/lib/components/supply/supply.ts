// Units & supply (issue #17, option A · Outcomes): how much of each unit's
// irrigation demand one run supplied. A card per unit, worst supplied first,
// banded as the Summary's Supply by unit and the Network's supply colours
// (network/supplyColour.ts), four headline tiles, and the links into the
// page, including the old Runs & results links to the panels that moved here
// (the unit results table, curtailment, assurance of supply, unit detail).
// Pure, so the page stays markup and the numbers are unit-tested.
import { fromEpochDay, toEpochDay, type RunSummary } from '@water-management/engine';
import type { RunMeta } from '$lib/api/types';
import type { NavGroup } from '$lib/components/common/sectionNav';
import { farmSupply, LOW_SUPPLY, type SupplyBand } from '$lib/components/network/supplyColour';
import { m3DayToMm3a, SUPPLY_TARGET } from '$lib/components/runs/results';
import { resolveWindow, type WindowRun } from '$lib/components/runs/reportWindow';
import { windowText, type DataEnd } from '$lib/format/age';
import { fmtNum, fmtPct, fmtQty } from '$lib/format/number';

/** The run before `id` by createdAt (the one its changes are against); null for the oldest or an unknown id. */
export function previousRunOf(runs: readonly RunMeta[] | null, id: string | null): RunMeta | null {
	if (!runs?.length || !id) return null;
	const t = (r: RunMeta) => {
		const v = Date.parse(r.createdAt);
		return Number.isNaN(v) ? -Infinity : v;
	};
	const sorted = runs.map((r, i) => ({ r, i })).sort((a, b) => t(b.r) - t(a.r) || a.i - b.i);
	const at = sorted.findIndex((x) => x.r.id === id);
	return at >= 0 ? (sorted[at + 1]?.r ?? null) : null;
}

/** A deficit below this (m³/day) is float noise, not a short day: the publication's own rule (backend publish/recent.ts). */
export const NOISE_M3 = 1e-6;

/**
 * "This week": the reporting window's "Last 7 days" (reportWindow.ts), the 7
 * days to the run's last day of recorded rain, which on a forecast run is the
 * day before the forecast (issue #51): the publication's count, which the
 * portfolio shows and links here.
 */
export function weekWindow(run: WindowRun): { reportStart: string; reportEnd: string; from: number; to: number; days: number } {
	const r = resolveWindow({ preset: 'last7' }, run, { reportStart: run.startDate, reportEnd: run.endDate });
	if (!r.ok) throw new Error(r.error);
	return r.window;
}

/** Days in `from`…`to` (indices into the series, inclusive) with a deficit above noise. */
export function daysShort(deficit: ArrayLike<number | null>, from: number, to: number): number {
	let n = 0;
	for (let t = Math.max(0, from); t <= to && t < deficit.length; t++) {
		const v = deficit[t];
		if (typeof v === 'number' && v > NOISE_M3) n++;
	}
	return n;
}

export interface UnitCard {
	nodeId: string;
	/** Today's name when the unit is still in the model, else the run's. */
	name: string;
	/** The Summary's and the Network's band (network/supplyColour.ts). */
	band: SupplyBand;
	/** Share of demand supplied over the whole record, 0–1; null without demand. */
	fraction: number | null;
	/** Whole-record means, m³/day. */
	demandM3Day: number;
	deficitM3Day: number;
	/** Demand days in the reporting window not fully met (assurance of supply, engine ≥ 0.32.0); null on older runs. */
	daysShort: number | null;
	/** Demand days in that window; null with daysShort. */
	demandDays: number | null;
	/** The cut in supply the curtailment table asks of it over the project window (m³/day, positive); 0 when none, null without the table. */
	cutM3Day: number | null;
	/** Days short in the run's last 7 days; null until the deficit series are in, or when the run has none for it. */
	weekShort: number | null;
	/** Still a unit in the model: its name opens the farm drawer and its node is on the Network. */
	inModel: boolean;
}

type CardInput = Pick<RunSummary, 'farms' | 'supplyAssurance' | 'curtailment'>;

/**
 * A card per unit in the run, worst supplied first; units without demand
 * last (100 % of nothing isn't a result), then by name.
 */
export function unitCards(summary: CardInput, modelFarmIds: ReadonlySet<string>, names: ReadonlyMap<string, string>, week: ReadonlyMap<string, number> | null): UnitCard[] {
	const rel = new Map((summary.supplyAssurance?.reliability ?? []).filter((r) => r.kind === 'farm').map((r) => [r.nodeId, r]));
	const cut = summary.curtailment ? new Map(summary.curtailment.farms.map((f) => [f.nodeId, f])) : null;
	const cards = (summary.farms ?? []).map((f): UnitCard => {
		const s = farmSupply(f);
		const r = rel.get(f.nodeId);
		const c = cut?.get(f.nodeId);
		const inModel = modelFarmIds.has(f.nodeId);
		return {
			nodeId: f.nodeId,
			name: (inModel ? names.get(f.nodeId) : undefined) || f.name || 'Unnamed hydrological unit',
			band: s.band,
			fraction: s.fraction,
			demandM3Day: f.avgDemandM3Day,
			deficitM3Day: f.avgDeficitM3Day,
			daysShort: r ? r.demandDays - r.metDays : null,
			demandDays: r ? r.demandDays : null,
			cutM3Day: cut ? (c && c.totalChangeM3Day < 0 ? -c.totalChangeM3Day : 0) : null,
			weekShort: week?.get(f.nodeId) ?? null,
			inModel
		};
	});
	return cards.sort((a, b) => {
		if (a.fraction === null || b.fraction === null) return a.fraction === null ? (b.fraction === null ? a.name.localeCompare(b.name) : 1) : -1;
		return a.fraction - b.fraction || a.name.localeCompare(b.name);
	});
}

/** The unit `unit=` names when it has a card, else the worst supplied (the first card); null without cards. */
export function pickUnit(cards: readonly UnitCard[], param: string | null): UnitCard | null {
	return (param ? cards.find((c) => c.nodeId === param) : undefined) ?? cards[0] ?? null;
}

export interface SupplyTotals {
	units: number;
	/** Units under SUPPLY_TARGET (the Runs tab's and the Summary's count: every unit, demand or not, by its fraction). */
	below: number;
	/** Units short on at least one of the run's last 7 days; null until every unit's deficit series is in. */
	weekShort: number | null;
	/** Units the curtailment table asks to cut over the project window; null without the table. */
	mustCut: number | null;
	/** Mean demand not supplied, all units, m³/day, and the same as a yearly volume. */
	shortfallM3Day: number;
	shortfallMm3a: number;
}

export function supplyTotals(summary: CardInput, cards: readonly UnitCard[], weekLoaded: boolean): SupplyTotals {
	const farms = summary.farms ?? [];
	const shortfall = farms.reduce((s, f) => s + f.avgDeficitM3Day, 0);
	return {
		units: farms.length,
		below: farms.filter((f) => f.fractionSupplied < SUPPLY_TARGET).length,
		weekShort: weekLoaded ? cards.filter((c) => (c.weekShort ?? 0) > 0).length : null,
		mustCut: summary.curtailment ? cards.filter((c) => (c.cutM3Day ?? 0) > 0).length : null,
		shortfallM3Day: shortfall,
		shortfallMm3a: m3DayToMm3a(shortfall)
	};
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * "This week" while the week's last day (the run's last day of recorded rain)
 * is current, "in the week to 31 Dec 2024" once it is stale ($lib/format/age).
 */
export const weekText = (weekEnd: DataEnd | null): string => windowText(weekEnd, 'this week', 'in the week to {date}');

/** The section header's line: "14 units · 3 short this week · run “Baseline”, ran today" (weekText for "this week"). */
export function supplySummary(
	t: Pick<SupplyTotals, 'units' | 'weekShort'> | null,
	modelUnits: number,
	runText: string | null,
	weekEnd: DataEnd | null = null
): string {
	const parts: string[] = [];
	if (t) {
		parts.push(plural(t.units, 'hydrological unit'));
		if (t.weekShort !== null && t.units) parts.push(`${t.weekShort} short ${weekText(weekEnd)}`);
	} else parts.push(plural(modelUnits, 'hydrological unit'));
	if (runText) parts.push(runText);
	return parts.join(' · ');
}

/**
 * The runs of consecutive days a unit was short (deficit above noise), as
 * inclusive date ranges for the supply chart's shading. A gap (null) ends a run.
 */
export function shortRanges(deficit: { startDate: string; values: readonly (number | null)[] }): { start: string; end: string }[] {
	const out: { start: string; end: string }[] = [];
	const day0 = toEpochDay(deficit.startDate);
	const v = deficit.values;
	let from = -1;
	for (let i = 0; i <= v.length; i++) {
		const x = i < v.length ? v[i] : null;
		const short = typeof x === 'number' && x > NOISE_M3;
		if (short && from < 0) from = i;
		else if (!short && from >= 0) {
			out.push({ start: fromEpochDay(day0 + from), end: fromEpochDay(day0 + i - 1) });
			from = -1;
		}
	}
	return out;
}

/** The band's words beside the %, so colour is never the only cue ("" for the top band). */
export const BAND_WORDS: Record<SupplyBand, string> = {
	met: '',
	short: `below ${fmtPct(SUPPLY_TARGET, 0)}`,
	low: `below ${fmtPct(LOW_SUPPLY, 0)}`,
	none: 'no irrigation demand',
	absent: 'not in this run'
};

/**
 * A card's lines under the %: the shortfall over the whole record, the demand
 * days short in the reporting window, the days short in the run's last 7 days and the cut the
 * curtailment table asks for. Lines a run can't give are left out.
 */
export function cardFacts(c: UnitCard, weekDays: number, weekEnd: DataEnd | null = null): string[] {
	const out: string[] = [];
	if (c.fraction === null) return out;
	out.push(c.deficitM3Day > 0.5 ? `Short ${fmtNum(c.deficitM3Day)} m³/day on average (${fmtQty(m3DayToMm3a(c.deficitM3Day), 3)} Mm³/a)` : 'No shortfall on average');
	if (c.daysShort !== null && c.demandDays) out.push(`${fmtNum(c.daysShort)} of ${fmtNum(c.demandDays)} demand days short in the reporting window`);
	// Only when it was: the Short this week tile already says how many weren't.
	if (c.weekShort) out.push(`Short on ${c.weekShort} of the ${windowText(weekEnd, `last ${weekDays} days`, `${weekDays} days to {date}`)}`);
	if (c.cutM3Day) out.push(`Curtailment: cut ${fmtNum(c.cutM3Day)} m³/day`);
	return out;
}

/**
 * The page's "On this page" menu (common/SectionNav): the unit detail beside
 * the cards, then the tables for the run, each by its `#res-…` id
 * (links.ts SUPPLY_ANCHORS), in page order.
 */
export const SUPPLY_NAV: NavGroup[] = [
	{ label: 'Each hydrological unit', sections: [{ id: 'res-farm', label: 'Hydrological unit detail' }] },
	{
		label: 'Tables for this run',
		sections: [
			{ id: 'res-farms', label: 'Hydrological unit results' },
			{ id: 'res-curtailment', label: 'Curtailment' },
			{ id: 'res-assurance', label: 'Assurance of supply' }
		]
	}
];
