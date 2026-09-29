// The compare summary (issue #17, board A4): a baseline and up to two
// what-ifs side by side. The backend compares two runs, so each what-if comes
// as its own RunComparison against the baseline (`comparisons[i]` = baseline
// vs what-if i + 1); this module turns those into the outcomes table's rows,
// the plain-language takeaways under it, and the one-line "what changed" of
// each run card. Pure: no I/O, no Svelte.
import { EWR_NOT_MET } from '$lib/components/ewr/notMet';
import { SUPPLY_TARGET, type FarmSummary, type InputChange, type InputChangeArea, type MetricDelta, type RunComparison } from '@water-management/engine';
import { fmtNum, fmtPct } from '$lib/format/number';
import type { MetricSpec } from './delta';

/** Days in an average year, for the takeaways' "days a year below the EWR" from the share of days. */
export const DAYS_PER_YEAR = 365.25;

export interface OutcomeRow {
	id: string;
	label: string;
	unit: string;
	spec: MetricSpec;
	/** The baseline's value. */
	base: number | null;
	/** Per what-if: its value (`b`) and the change from the baseline (`delta`). */
	whatIfs: MetricDelta[];
}

const NONE: MetricDelta = { a: null, b: null, delta: null };

/** Farms whose supply moves at least this much in some what-if get a row of their own (fraction points). */
export const FARM_ROW_MIN_CHANGE = 0.01;
/** At most this many farm rows, the largest changes first. */
export const FARM_ROWS_MAX = 2;

function row(id: string, label: string, unit: string, spec: MetricSpec, pick: (c: RunComparison, i: number) => MetricDelta | null, comparisons: readonly RunComparison[]): OutcomeRow {
	const ms = comparisons.map((c, i) => pick(c, i) ?? NONE);
	return { id, label, unit, spec, base: ms.find((m) => m.a !== null)?.a ?? null, whatIfs: ms };
}

/** The farms most changed by any what-if, matched on the baseline's node. */
function farmRows(comparisons: readonly RunComparison[]): OutcomeRow[] {
	const byNode = new Map<string, { name: string; ms: MetricDelta[]; biggest: number }>();
	comparisons.forEach((c, i) => {
		for (const f of c.farms) {
			let e = byNode.get(f.nodeIdA);
			if (!e) {
				e = { name: f.nameA ?? f.name, ms: comparisons.map(() => NONE), biggest: 0 };
				byNode.set(f.nodeIdA, e);
			}
			e.ms[i] = f.fractionSupplied;
			e.biggest = Math.max(e.biggest, Math.abs(f.fractionSupplied.delta ?? 0));
		}
	});
	return [...byNode.entries()]
		.filter(([, e]) => e.biggest >= FARM_ROW_MIN_CHANGE)
		.sort(([, x], [, y]) => y.biggest - x.biggest || x.name.localeCompare(y.name))
		.slice(0, FARM_ROWS_MAX)
		.map(([node, e]) => ({
			id: `farm:${node}`,
			label: `${e.name} supplied`,
			unit: '% of demand',
			spec: { format: 'fraction', better: 'higher' } as MetricSpec,
			base: e.ms.find((m) => m.a !== null)?.a ?? null,
			whatIfs: e.ms
		}));
}

/** A run's own model nodes, as far as the dam figures need them. */
type DamNode = { id: string; damCapacityM3?: unknown };

/**
 * All of a run's farm dams at the end of the run, as a share of their
 * capacity (0–1), weighted by capacity: the Summary's "Dams today" figure
 * (overview/damLevels.ts damsToday), from the run summary's dam figures
 * (FarmSummary.damEndM3, engine ≥ 1.2.0, issue #55) and the capacities in the
 * run's own model. null when the run has no dam, or was saved before the
 * figures (a dam without them): unknown, never 0.
 */
export function damStorageShare(farms: readonly FarmSummary[] | undefined, nodes: readonly DamNode[] | undefined): number | null {
	const cap = new Map((nodes ?? []).map((n) => [n.id, typeof n.damCapacityM3 === 'number' && Number.isFinite(n.damCapacityM3) ? n.damCapacityM3 : 0]));
	let stored = 0;
	let capacity = 0;
	for (const f of farms ?? []) {
		const c = cap.get(f.nodeId) ?? 0;
		if (!(c >= 1)) continue;
		if (f.damEndM3 === undefined) return null;
		stored += f.damEndM3;
		capacity += c;
	}
	return capacity > 0 ? stored / capacity : null;
}

/** One side of GET /compare/runs, as far as the dam figures need it. */
type DamSide = { run: { summary: { farms?: readonly FarmSummary[] }; inputs?: { model?: { nodes?: readonly DamNode[] } } } };

/** The dam storage at the end of the run of the baseline (`a`) and a what-if (`b`), each from its own summary and model. */
export function compareDamStorage(d: { a: DamSide; b: DamSide }): MetricDelta {
	const share = (s: DamSide) => damStorageShare(s.run.summary.farms, s.run.inputs?.model?.nodes);
	const a = share(d.a);
	const b = share(d.b);
	return { a, b, delta: a === null || b === null ? null : b - a };
}

/**
 * The outcomes table: the headline outcomes, each for the baseline and every
 * what-if. It took in the Full comparison's Headline results water balance
 * (issue #175): four of its nine rows were these rows, and of the rest only
 * the irrigation deficit, the mean natural flow and the runoff coefficient
 * said something new (its supplied m³/day is the share and the deficit
 * again, its days EWR not met the share of days again). `dams[i]` is the dam storage at the end of the run for
 * comparison i (damStorageShare of each side); its row shows when either
 * side of any comparison has one.
 */
export function outcomeRows(comparisons: readonly RunComparison[], dams: readonly MetricDelta[] = []): OutcomeRow[] {
	return [
		// Framed as the Summary's card and River & reserve's tile (ewr/notMet.ts, issue #162): the share not met, lower is better.
		row('ewrNotMet', EWR_NOT_MET, '% of days', { format: 'fraction', better: 'lower' }, (c) => c.catchment.ewrFractionDaysNotMet, comparisons),
		row('supplied', 'Irrigation supplied', '% of demand', { format: 'fraction', better: 'higher' }, (c) => c.totals.fractionSupplied, comparisons),
		// The volume behind that share (the Headline results water balance's row until issue #175 merged it in here).
		row('deficit', 'Irrigation deficit', 'm³/day', { format: 'volume', better: 'lower' }, (c) => c.totals.deficitM3Day, comparisons),
		row('farmsBelow', `Hydrological units below ${fmtPct(SUPPLY_TARGET, 0)} supplied`, 'hydrological units', { format: 'count', better: 'lower' }, (c) => c.totals.farmsBelowTarget, comparisons),
		...farmRows(comparisons),
		...(dams.some((m) => m.a !== null || m.b !== null)
			? [
					row(
						'dams',
						'Dam storage, end of run',
						'% of capacity',
						// Neutral: a bigger dam can end emptier as a share yet hold more; the change is shown, not judged.
						{ format: 'fraction', better: 'neutral' },
						(_c, i) => dams[i] ?? null,
						comparisons
					)
				]
			: []),
		row('outflow', 'Mean outflow', 'm³/day', { format: 'volume', better: 'neutral' }, (c) => c.catchment.meanSimulatedOutflowM3Day, comparisons),
		// What the catchment itself makes: a land-cover or runoff what-if moves these.
		row('natural', 'Mean natural flow', 'm³/day', { format: 'volume', better: 'neutral' }, (c) => c.catchment.meanNaturalFlowM3Day, comparisons),
		row('runoffCoefficient', 'Runoff coefficient (flow ÷ rain)', '', { format: 'ratio', better: 'neutral' }, (c) => c.catchment.runoffCoefficient, comparisons)
	];
}

// ---------------------------------------------------------------------------
// Takeaways
// ---------------------------------------------------------------------------

export interface Takeaway {
	tone: 'better' | 'worse' | 'neutral';
	text: string;
}

/**
 * What counts as material, so a takeaway never reports noise: a whole day a
 * year below the EWR, a percentage point of the demand supplied, one farm
 * crossing the supply target, five points of one farm's supply, 5 % of the
 * mean outflow. The dam storage row has no takeaway: a what-if that raises
 * a dam ends emptier as a share of the bigger dam while holding more, so the
 * row shows the change without a verdict.
 */
export const MATERIAL = { ewrDays: 1, suppliedPp: 1, farmPp: 5, outflowShare: 0.05 } as const;

const plural = (n: number, one: string, many = `${one}s`) => `${fmtNum(n, 0)} ${n === 1 ? one : many}`;

export interface TakeawayContext {
	/** Per what-if: it covers the baseline's dates. */
	samePeriod: readonly boolean[];
	/** Per what-if: it ran on another engine version than the baseline. */
	engineChanged: readonly boolean[];
}

/**
 * Plain-language takeaways from the outcomes table, what-if by what-if, each
 * only when the change is material (MATERIAL). The wording says what the
 * change does ("What-if 1 puts the river below the EWR on 13 more days a
 * year", from the EWR-not-met share × DAYS_PER_YEAR); the words
 * carry the direction, so tone (colour) is never the only cue.
 */
export function takeaways(rows: readonly OutcomeRow[], names: readonly string[], ctx: TakeawayContext): Takeaway[] {
	const out: Takeaway[] = [];
	const get = (id: string) => rows.find((r) => r.id === id);
	const notMet = get('ewrNotMet');
	// The pragmatic EWR's days not met (ewrFractionDaysNotMet), not the Reserve's rule months: say "EWR", never "reserve".
	const ewrDaysDelta = (i: number) => {
		const d = notMet?.whatIfs[i]?.delta;
		return d === null || d === undefined ? null : Math.round(d * DAYS_PER_YEAR);
	};
	names.forEach((name, i) => {
		const before = out.length;
		const rd = ewrDaysDelta(i);
		if (rd !== null && Math.abs(rd) >= MATERIAL.ewrDays) {
			out.push(
				rd > 0
					? { tone: 'worse', text: `${name} puts the river below the EWR on ${plural(rd, 'more day')} a year` }
					: { tone: 'better', text: `${name} puts the river below the EWR on ${plural(-rd, 'fewer day')} a year` }
			);
		}
		const sd = get('supplied')?.whatIfs[i]?.delta;
		if (sd !== null && sd !== undefined) {
			const pp = Number((sd * 100).toFixed(1));
			if (Math.abs(pp) >= MATERIAL.suppliedPp) {
				out.push({ tone: pp > 0 ? 'better' : 'worse', text: `${name} supplies ${fmtNum(Math.abs(pp), 1)} pp ${pp > 0 ? 'more' : 'less'} of the hydrological units' demand` });
			}
		}
		const fd = get('farmsBelow')?.whatIfs[i]?.delta;
		if (fd !== null && fd !== undefined && Math.round(fd) !== 0) {
			const n = Math.round(fd);
			const target = fmtPct(SUPPLY_TARGET, 0);
			out.push(
				n > 0
					? { tone: 'worse', text: `${name} leaves ${plural(n, 'more hydrological unit')} below ${target} supplied` }
					: { tone: 'better', text: `${name} brings ${plural(-n, 'hydrological unit')} up to ${target} supplied` }
			);
		}
		for (const r of rows.filter((x) => x.id.startsWith('farm:'))) {
			const d = r.whatIfs[i]?.delta;
			if (d === null || d === undefined) continue;
			const pp = Math.round(d * 100);
			if (Math.abs(pp) < MATERIAL.farmPp) continue;
			const farm = r.label.replace(/ supplied$/, '');
			out.push({ tone: pp > 0 ? 'better' : 'worse', text: `Under ${name}, ${farm} gets ${pp > 0 ? '+' : '−'}${Math.abs(pp)} pp of its demand` });
		}
		const flow = get('outflow')?.whatIfs[i];
		if (flow && flow.a && flow.delta !== null && Math.abs(flow.delta / flow.a) >= MATERIAL.outflowShare) {
			const share = Math.round((Math.abs(flow.delta) / flow.a) * 100);
			out.push({ tone: 'neutral', text: `${name} ${flow.delta > 0 ? 'raises' : 'lowers'} the mean outflow by ${share}%` });
		}
		if (out.length === before) out.push({ tone: 'neutral', text: `${name} makes no material change to these outcomes` });
		if (ctx.samePeriod[i] === false) out.push({ tone: 'neutral', text: `${name} covers other dates than the baseline, so part of its change comes from the period` });
		if (ctx.engineChanged[i]) out.push({ tone: 'neutral', text: `${name} ran on another engine version, so part of its change may come from the model itself` });
	});
	// Two what-ifs that both cost the EWR days: say which costs less, and by how much.
	const r1 = ewrDaysDelta(0);
	const r2 = ewrDaysDelta(1);
	if (names.length === 2 && r1 !== null && r2 !== null && r1 >= MATERIAL.ewrDays && r2 >= MATERIAL.ewrDays && r1 !== r2) {
		const [less, more, a, b] = r1 < r2 ? [names[0]!, names[1]!, r1, r2] : [names[1]!, names[0]!, r2, r1];
		out.push({ tone: 'neutral', text: `${less} costs the EWR less than ${more}: ${fmtNum(a, 0)} against ${fmtNum(b, 0)} more days a year below it` });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Run cards
// ---------------------------------------------------------------------------

/** Which area's change best says what a what-if is: the model before the data it ran on. */
const AREA_ORDER: readonly InputChangeArea[] = ['network', 'crops', 'transfers', 'settings', 'series'];

/** The change a run card leads with: the first change of the most telling area; null for none. */
export function leadChange(changes: readonly InputChange[]): InputChange | null {
	for (const area of AREA_ORDER) {
		const c = changes.find((x) => x.area === area);
		if (c) return c;
	}
	return changes[0] ?? null;
}
