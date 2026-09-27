// The Dams page (issue #17, option A · Outcomes): a card per dam with how
// full it was at the end of the latest run, its 30-day change and a storage
// sparkline, one dam's storage chart, and the Dam levels table. The levels
// themselves come from overview/damLevels.ts (shared with the Summary's Dams
// today card and the Network's colour by dam level); this file turns them and
// the model into the page's cards, header line, sparkline and chart series.
// Pure, so the page stays markup and the numbers are unit-tested.
import type { DailySeries } from '@water-management/engine';
import type { ChartSeries } from '$lib/components/charts/series';
import type { DamLevel } from '$lib/components/overview/damLevels';
import { fmtNum } from '$lib/format/number';

type NodeLike = { id: string; name?: string; kind?: string; damCapacityM3?: unknown; damMinPct?: unknown };

export interface DamCard {
	nodeId: string;
	name: string;
	/** From the run's model when the run has the dam (so a later edit doesn't skew its %), else the live model. */
	capacityM3: number;
	minPct: number;
	/** A farm's own dam: the card links to the farm drawer. */
	farm: boolean;
	/** Its levels in the latest run; null before a run, or when the run has no storage for it. */
	level: DamLevel | null;
}

const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

/**
 * The model's dams: farms with a capacity of at least 1 m³, in node order.
 * Only a farm has a dam in the engine (a capacity on a gauge or another water
 * user is inert: no storage, no dam_storage series), so only farms count. The
 * minimum level is a % (the model keeps a fraction), as `damsInRun` gives it.
 */
export function modelDams(nodes: readonly NodeLike[]): { nodeId: string; name: string; capacityM3: number; minPct: number; farm: boolean }[] {
	return nodes
		.filter((n) => n.kind === 'farm' && num(n.damCapacityM3) >= 1)
		.map((n) => ({
			nodeId: n.id,
			name: n.name || '(unnamed)',
			capacityM3: num(n.damCapacityM3),
			minPct: n.kind === 'farm' ? num(n.damMinPct) * 100 : 0,
			farm: n.kind === 'farm'
		}));
}

/**
 * One card per dam in the model: those with levels first, in the levels'
 * order (emptiest first, `sortDamLevels`), then the rest in node order. A dam
 * the run has but the model no longer has (removed since) keeps its card, so
 * the cards always match the Dam levels table.
 */
export function damCards(nodes: readonly NodeLike[], levels: readonly DamLevel[]): DamCard[] {
	const dams = modelDams(nodes);
	const byId = new Map(dams.map((d) => [d.nodeId, d]));
	const kinds = new Map(nodes.map((n) => [n.id, n.kind]));
	const withLevel: DamCard[] = levels.map((l) => ({
		nodeId: l.nodeId,
		name: byId.get(l.nodeId)?.name ?? l.name,
		capacityM3: l.capacityM3,
		minPct: l.minPct,
		farm: kinds.get(l.nodeId) === 'farm',
		level: l
	}));
	const seen = new Set(levels.map((l) => l.nodeId));
	return [...withLevel, ...dams.filter((d) => !seen.has(d.nodeId)).map((d) => ({ ...d, level: null }))];
}

/** The dam shown in the chart: the one the URL names when it has a card, else the first (the emptiest). */
export function pickDam(cards: readonly DamCard[], param: string | null): DamCard | null {
	return (param ? cards.find((c) => c.nodeId === param) : undefined) ?? cards[0] ?? null;
}

/** "2.4 million m³", "150,000 m³": a capacity in words a header can carry. */
export function fmtVolume(m3: number): string {
	if (m3 >= 1e6) return `${fmtNum(m3 / 1e6, m3 >= 1e7 ? 1 : 2, true)} million m³`;
	return `${fmtNum(m3)} m³`;
}

/** The header's line: "3 dams · 2.4 million m³ capacity · latest run “Baseline”, ran today" (the run part from the caller). */
export function damsSummary(count: number, capacityM3: number, run: string | null): string {
	if (!count) return 'No dams in the model yet';
	const parts = [`${fmtNum(count)} dam${count === 1 ? '' : 's'}`, `${fmtVolume(capacityM3)} capacity`];
	parts.push(run ?? 'no run yet');
	return parts.join(' · ');
}

/** The change over the last 30 days in words, never colour alone: "down 11 pp in 30 days". null without a value 30 days back. */
export function changeWords(l: Pick<DamLevel, 'endPct' | 'agoPct'>, days: number): { text: string; dir: 'up' | 'down' | 'flat' } | null {
	if (l.agoPct === null) return null;
	const d = l.endPct - l.agoPct;
	if (Math.abs(d) < 0.5) return { text: `no change in ${days} days`, dir: 'flat' };
	return { text: `${d > 0 ? 'up' : 'down'} ${fmtNum(Math.abs(d))} pp in ${days} days`, dir: d > 0 ? 'up' : 'down' };
}

export const SPARK_W = 200;
export const SPARK_H = 48;

/**
 * The card's sparkline: storage as % of capacity over the last `days` days
 * of the series (the whole of a shorter one), at most `points` points (the
 * mean of each step, so a dry spell isn't skipped over), in a SPARK_W ×
 * SPARK_H box where the bottom is empty and the top full. Gaps are skipped.
 * null with fewer than two values.
 */
export function storageSpark(series: DailySeries, capacityM3: number, days = 365, points = 60): { line: string; fill: string } | null {
	if (!(capacityM3 >= 1)) return null;
	const v = series.values;
	let last = v.length - 1;
	while (last >= 0 && !(v[last] != null && Number.isFinite(v[last]))) last--;
	if (last < 1) return null;
	const from = Math.max(0, last - days + 1);
	const n = last - from + 1;
	const step = Math.max(1, n / points);
	const pts: [number, number][] = [];
	for (let s = 0; s < n; s += step) {
		let sum = 0;
		let k = 0;
		for (let i = Math.floor(s); i < Math.min(n, Math.floor(s + step)); i++) {
			const x = v[from + i];
			if (x != null && Number.isFinite(x)) {
				sum += x;
				k++;
			}
		}
		if (!k) continue;
		const pct = Math.min(100, Math.max(0, (sum / k / capacityM3) * 100));
		const t = n === 1 ? 0 : Math.min(1, s / (n - 1));
		pts.push([t * SPARK_W, SPARK_H - 2 - (pct / 100) * (SPARK_H - 4)]);
	}
	if (pts.length < 2) return null;
	const r = (x: number) => Math.round(x * 10) / 10;
	// The last step ends on the last day.
	pts[pts.length - 1]![0] = SPARK_W;
	const line = pts.map(([x, y]) => `${r(x)},${r(y)}`).join(' ');
	return { line, fill: `M${r(pts[0]![0])},${SPARK_H} L${pts.map(([x, y]) => `${r(x)},${r(y)}`).join(' L')} L${SPARK_W},${SPARK_H} Z` };
}

export type StorageUnit = 'pct' | 'm3';

/**
 * The storage chart's lines: the dam's storage, its capacity and (when it has
 * one) its minimum operating level, in m³ or as % of capacity. Every line
 * spans the storage series' days, so the window switch trims them together.
 */
export function storageChartSeries(series: DailySeries, capacityM3: number, minPct: number, unit: StorageUnit): ChartSeries[] {
	const k = unit === 'pct' ? 100 / capacityM3 : 1;
	const flat = (x: number) => series.values.map(() => x);
	const out: ChartSeries[] = [
		{ label: 'Storage', startDate: series.startDate, values: series.values.map((x) => (x != null && Number.isFinite(x) ? x * k : null)), color: '--series-1' },
		{ label: 'Capacity', startDate: series.startDate, values: flat(capacityM3 * k), style: 'dashed', color: '--text-muted' }
	];
	if (minPct > 0) out.push({ label: 'Minimum level', startDate: series.startDate, values: flat((minPct / 100) * capacityM3 * k), style: 'dashed', color: '--series-2' });
	return out;
}
