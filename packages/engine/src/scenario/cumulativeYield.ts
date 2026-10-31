// Yield and reliability per dam in a cumulative assessment (roadmap WP-3.11
// with WP-3.6, docs/scenarios.md § Cumulative impact): for each dam the
// applications touch, its firm yield (network/yield.ts firmYield, the yield
// job's defaults: a constant draft, assurance 1) and its unit's annual
// assurance of supply, on the baseline, each application alone and all
// together, as rows of the cumulative report with the same change and
// interaction arithmetic as cumulativeImpact's. Pure: no I/O; the caller
// runs one input at a time (damFirmYields) and reports progress between.
import type { ModelInput, RunSummary } from '../project';
import { firmYield, prepareYield } from '../network/yield';
import { scenarioNodeIds } from './combine';
import type { ScenarioOp } from './ops';
import { CUMULATIVE_HIGHER_IS_WORSE, CUMULATIVE_METRIC_UNIT, type CumulativeRow } from './cumulative';

/**
 * Most firm-yield searches one assessment runs: each dam costs one per run
 * (the baseline, each application alone, all together), so it takes
 * floor(this ÷ (applications + 2)) dams: 5 with two applications, 2 with
 * eight. Measured on the 30-year, 16-node catchment of yield.perf.test.ts
 * (M3 Pro): a search about 3.9 s, a run 1.7 s, so 20 searches and 10 runs
 * about 95 s, inside the job's 300 s Lambda and 360 s lease with room for a
 * slower CPU. The rest are named in the report's warnings, never silently
 * dropped.
 */
export const CUMULATIVE_YIELD_SEARCHES_MAX = 20;

/** Most dams an assessment of `scenarios` applications works out a yield for (at least 1). */
export const cumulativeYieldDamsMax = (scenarios: number): number => Math.max(1, Math.floor(CUMULATIVE_YIELD_SEARCHES_MAX / (scenarios + 2)));

/** A dam the report has rows for. */
export interface CumulativeDam {
	nodeId: string;
	name: string;
}

const isDam = (input: ModelInput, id: string) => {
	const n = input.model.nodes.find((x) => x.id === id);
	return !!n && n.kind === 'farm' && n.damCapacityM3 > 0;
};
const nameIn = (inputs: readonly ModelInput[], id: string) => {
	for (const i of inputs) {
		const n = i.model.nodes.find((x) => x.id === id);
		if (n) return n.name;
	}
	return id;
};

/**
 * The dams the scenarios' ops touch (scenarioNodeIds: a dam an op changes,
 * adds, or adds or moves a unit above it, …): a unit with land and a dam of
 * capacity above 0 in the baseline or the combination, by name then id, at
 * most cumulativeYieldDamsMax(scenarios); `left` are the rest. A node keeps the id its op gives it (an
 * applicant's mask re-identifies crops, transfers and the like, never a node).
 */
export function touchedDams(
	base: ModelInput,
	scenarios: readonly { ops: readonly ScenarioOp[] }[],
	combined: ModelInput
): { dams: CumulativeDam[]; left: CumulativeDam[] } {
	const ids = new Set<string>();
	for (const s of scenarios) for (const id of scenarioNodeIds(base, s.ops)) ids.add(id);
	const all = [...ids]
		.filter((id) => isDam(base, id) || isDam(combined, id))
		.map((nodeId) => ({ nodeId, name: nameIn([combined, base], nodeId) }))
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
	const max = cumulativeYieldDamsMax(scenarios.length);
	return { dams: all.slice(0, max), left: all.slice(max) };
}

/** One run's firm yields (m³/year) of the dams it has (null for one it lacks, or has without a dam), and why any couldn't be found. */
export interface DamYields {
	yields: (number | null)[];
	warnings: string[];
}

/** The firm yield of each of `dams` on one input: the problem built once, one search per dam it has. */
export function damFirmYields(input: ModelInput, dams: readonly CumulativeDam[], what: string): DamYields {
	const present = dams.map((d) => isDam(input, d.nodeId));
	if (!present.some(Boolean)) return { yields: dams.map(() => null), warnings: [] };
	let problem: ReturnType<typeof prepareYield>;
	try {
		problem = prepareYield(input);
	} catch (e) {
		return { yields: dams.map(() => null), warnings: [`${what}: no firm yield (${e instanceof Error ? e.message : String(e)})`] };
	}
	const warnings: string[] = [];
	const yields = dams.map((d, i) => {
		if (!present[i]) return null;
		try {
			return firmYield(problem, d.nodeId).yieldM3Year;
		} catch (e) {
			warnings.push(`${what}: the firm yield of "${d.name}" couldn't be found (${e instanceof Error ? e.message : String(e)})`);
			return null;
		}
	});
	return { yields, warnings };
}

/** One run for the dam rows: its summary and its dams' firm yields (damFirmYields). */
export interface CumulativeDamRun {
	summary: RunSummary;
	yields: readonly (number | null)[];
}

const fin = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The dam's unit's annual assurance of supply in a run: water years met ÷ water years (§2.11a); null without the unit or a year with demand. */
const assuranceOf = (s: RunSummary, nodeId: string) => fin(s.supplyAssurance?.reliability.find((r) => r.nodeId === nodeId)?.annualReliability);

/**
 * Two rows per dam, in `dams` order: `dam_firm_yield` and `dam_reliability`,
 * each across the baseline, each single and the combination, with
 * cumulativeImpact's change, sum and interaction. `siteNodeId` is the dam's
 * unit, `site` its name.
 */
export function cumulativeDamRows(dams: readonly CumulativeDam[], baseline: CumulativeDamRun, singles: readonly CumulativeDamRun[], combined: CumulativeDamRun): CumulativeRow[] {
	return dams.flatMap((d, i) =>
		(
			[
				['dam_firm_yield', (r: CumulativeDamRun) => fin(r.yields[i])],
				['dam_reliability', (r: CumulativeDamRun) => assuranceOf(r.summary, d.nodeId)]
			] as const
		).map(([metric, get]): CumulativeRow => {
			const b = get(baseline);
			const one = singles.map(get);
			const c = get(combined);
			const change = (v: number | null) => (v === null || b === null ? null : v - b);
			const singleChanges = one.map(change);
			const sumOfSingles = singleChanges.some((v) => v === null) ? null : singleChanges.reduce<number>((t, v) => t + v!, 0);
			const combinedChange = change(c);
			return {
				metric,
				siteNodeId: d.nodeId,
				site: d.name,
				isOutlet: false,
				unit: CUMULATIVE_METRIC_UNIT[metric],
				higherIsWorse: CUMULATIVE_HIGHER_IS_WORSE[metric],
				baseline: b,
				singles: one,
				combined: c,
				singleChanges,
				sumOfSingles,
				combinedChange,
				interaction: combinedChange === null || sumOfSingles === null ? null : combinedChange - sumOfSingles
			};
		})
	);
}
