// The over/under-use chart's shapes (UsePlot.svelte), shared by the
// Allocations tab (docs/ui.md § Allocations) and the evidence report's § 5
// (report/evidence/registeredUse.ts): one row per unit and water source, one
// mark per whole water year at modelled use ÷ the registered volume. Pure,
// unit-tested in usePlot.test.ts. The words describe arithmetic against a
// registered volume, never a finding on lawfulness.
import type { AllocationComparison } from '@water-management/engine';
import { fmtNum } from '$lib/format/number';
import { SOURCE_LABEL, type UnitRow } from './allocations';

/** The chart's axis runs to at least this share of the registered volume, and at most USE_AXIS_MAX; a year past the cap is drawn at the edge. */
export const USE_AXIS_MIN = 1.5;
export const USE_AXIS_MAX = 3;

export interface UseMark {
	waterYear: number;
	/** The tab's one run is drawn as the report's baseline (hollow). */
	run: 'baseline' | 'application';
	/** Modelled ÷ registered, 0…; drawn at min(ratio, axis max). */
	ratio: number;
	/** Past the axis: drawn at the edge as an arrowhead. */
	clipped: boolean;
	/** The engine's status for the year is "above registered" (allocationStatus), what the description counts. */
	over: boolean;
}

export interface UseRow {
	key: string;
	/** "Upper, surface water": `name` + `suffix`. */
	label: string;
	/** The unit's name ("Upper"; the applicant's says so): what a narrow chart cuts to fit. */
	name: string;
	/** ", surface water": always drawn whole, so a unit's two rows stay apart. */
	suffix: string;
	marks: UseMark[];
}

/**
 * The axis for rows of marks (0 to the largest ratio, at least USE_AXIS_MIN,
 * at most USE_AXIS_MAX), each mark flagged when it is past it, and how many are.
 */
export function useAxis(raw: readonly (Omit<UseRow, 'marks'> & { marks: readonly Omit<UseMark, 'clipped'>[] })[]): { rows: UseRow[]; axisMax: number; clipped: number } {
	const top = Math.max(0, ...raw.flatMap((r) => r.marks.map((m) => m.ratio)));
	const axisMax = Math.min(USE_AXIS_MAX, Math.max(USE_AXIS_MIN, Math.ceil(top * 10) / 10));
	let clipped = 0;
	const rows = raw.map((r) => ({
		...r,
		marks: r.marks.map((m) => {
			const c = m.ratio > axisMax;
			if (c) clipped++;
			return { ...m, clipped: c };
		})
	}));
	return { rows, axisMax, clipped };
}

/**
 * The Allocations tab's chart for one run: a row per unit and water source in
 * the list's order (the ones to look into first, `units`), one mark per whole
 * water year with a registered volume. A part year, a year with nothing
 * registered and a unit with no registered volume in any whole year have no
 * ratio: they are left out here and listed in the table.
 */
export function comparisonUseRows(c: Pick<AllocationComparison, 'nodes'>, units: readonly Pick<UnitRow, 'nodeId' | 'source'>[]): { rows: UseRow[]; axisMax: number; clipped: number } {
	const byKey = new Map<string, { n: AllocationComparison['nodes'][number]; s: AllocationComparison['nodes'][number]['surface'] }>(c.nodes.flatMap((n) => [n.surface, n.groundwater].map((s) => [`${n.nodeId}:${s.waterSource}`, { n, s }] as const)));
	const raw = units.flatMap((u) => {
		const key = `${u.nodeId}:${u.source}`;
		const hit = byKey.get(key);
		if (!hit) return [];
		const marks = hit.s.years
			.filter((y) => !y.partial && y.registeredM3 > 0 && y.ratio !== null)
			.map((y) => ({ waterYear: y.waterYear, run: 'baseline' as const, ratio: y.ratio as number, over: y.status === 'over' }));
		const suffix = `, ${SOURCE_LABEL[hit.s.waterSource].toLowerCase()}`;
		return marks.length ? [{ key, label: `${hit.n.name}${suffix}`, name: hit.n.name, suffix, marks }] : [];
	});
	return useAxis(raw);
}

/**
 * The chart's description for a screen reader: how many of the drawn water
 * years are above the band (the engine's "above registered", each mark's
 * `over`, so it agrees with the table to the last bit), per run in an
 * application, and in how many of the rows with a mark. Without a recorded
 * band, the words say above the registered volume.
 */
export function useSummary(allRows: readonly UseRow[], tolerance: number | null, application: boolean): string {
	const rows = allRows.filter((r) => r.marks.length);
	const where = tolerance === null ? 'above the registered volume' : `above the ±${fmtNum(tolerance * 100, 0)} % band (over ${fmtNum((1 + tolerance) * 100, 0)} % of the registered volume)`;
	const count = (run: UseMark['run']) => {
		const marks = rows.flatMap((r) => r.marks.filter((m) => m.run === run));
		const above = marks.filter((m) => m.over).length;
		const inRows = rows.filter((r) => r.marks.some((m) => m.run === run && m.over)).length;
		return { above, of: marks.length, inRows };
	};
	const years = (n: number) => `${fmtNum(n)} whole water year${n === 1 ? '' : 's'}`;
	const inRows = ({ above, inRows: k }: ReturnType<typeof count>) =>
		above ? `, in ${fmtNum(k)} of ${fmtNum(rows.length)} ${rows.length === 1 ? 'unit and water source' : 'units and water sources'}` : '';
	const b = count('baseline');
	if (!application) return `${fmtNum(b.above)} of ${years(b.of)} ${b.above === 1 || b.of === 1 ? 'is' : 'are'} ${where}${inRows(b)}.`;
	const a = count('application');
	return `Years ${where}: baseline ${fmtNum(b.above)} of ${years(b.of)}${inRows(b)}; application ${fmtNum(a.above)} of ${years(a.of)}${inRows(a)}.`;
}
