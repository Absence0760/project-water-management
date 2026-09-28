// The landing page's figures (issue #57), from the engine: the "From rainfall
// to river" charts and the what-if grid, run on the invented Kleinberg example
// catchment (scripts/examples/catchments.ts), so the page shows real model
// output without shipping the engine. Part of `pnpm gen:landing-art`
// (bin/gen-landing-art.sh); writes the small module the landing reads:
//
//   pnpm -C backend exec tsx scripts/landing-data.ts <out.ts>
//
// Deterministic: the example and its GR4J fit are seeded, so a rerun writes
// the same file. Every number is synthetic, and the page says so.
import { writeFile } from 'node:fs/promises';
import { runModel, type ModelInput, type ModelOutput } from '@water-management/engine';
import { buildExamples, inputOf, type ExampleProject } from './examples/catchments.js';

const out = process.argv[2];
if (!out) throw new Error('usage: tsx scripts/landing-data.ts <out.ts>');

const kleinberg = buildExamples({ fit: true })[0]!;
const input = inputOf(kleinberg);
/** The farm the what-if changes: its apple orchard and its dam. */
const FARM = 'Bergwater';
/** The dam the story's storage chart follows (the largest). */
const DAM = 'Rooikloof';

const nodeId = (ex: ExampleProject, name: string) => ex.model.nodes.find((n) => n.name === name)!.id;
function values(o: ModelOutput, key: string, node: string | null = null): number[] {
	const s = o.series.find((x) => x.key === key && x.nodeId === node);
	if (!s) throw new Error(`no ${key} series for ${node ?? 'the catchment'}`);
	return s.values.map((v) => v ?? 0);
}
const years = (o: ModelOutput) => o.days / 365.25;
const round = (v: number, dp = 0) => Math.round(v * 10 ** dp) / 10 ** dp;

const base = runModel(input);
const T0 = Date.parse(`${base.startDate}T00:00:00Z`);
const dateOf = (i: number) => new Date(T0 + i * 86_400_000);

// ---- the story: one water year, by week ------------------------------------
// The year the chart shows: the one whose reserve failures are closest to the
// run's typical (median) year, so it neither hides nor exaggerates them.
const outflow = values(base, 'simulated_outflow');
const ewr = values(base, 'ewr');
const byYear = new Map<number, { first: number; last: number; below: number }>();
outflow.forEach((q, i) => {
	const d = dateOf(i);
	const wy = d.getUTCMonth() >= 9 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
	const y = byYear.get(wy) ?? { first: i, last: i, below: 0 };
	y.last = i;
	if (q < ewr[i]!) y.below++;
	byYear.set(wy, y);
});
const whole = [...byYear.entries()].filter(([, y]) => y.last - y.first >= 364);
const sortedBelow = whole.map(([, y]) => y.below).sort((a, b) => a - b);
const median = sortedBelow[Math.floor(sortedBelow.length / 2)]!;
const [storyYear, span] = whole.reduce((best, cur) => (Math.abs(cur[1].below - median) < Math.abs(best[1].below - median) ? cur : best));

/** 52 weeks of the story year: each the mean (or the total, for rain) of its 7 days. */
function weekly(v: number[], total = false): number[] {
	const w: number[] = [];
	for (let k = 0; k < 52; k++) {
		const slice = v.slice(span.first + k * 7, span.first + k * 7 + 7);
		const sum = slice.reduce((a, b) => a + b, 0);
		w.push(total ? sum : sum / slice.length);
	}
	return w;
}

const damNode = kleinberg.model.nodes.find((n) => n.name === DAM)!;
// The supply chart follows the farm that ran shortest that year.
const farms = kleinberg.model.nodes.filter((n) => n.kind === 'farm');
const yearShare = (id: string) => {
	const sum = (k: string) => values(base, k, id).slice(span.first, span.last + 1).reduce((a, b) => a + b, 0);
	return sum('supplied') / (sum('demand') || 1);
};
const shortFarm = farms.reduce((a, b) => (yearShare(b.id) < yearShare(a.id) ? b : a));
const shortNode = shortFarm.id;
const flowQ = weekly(outflow).map((v) => round(v / 86_400, 3)); // m³/day → m³/s
const ewrQ = weekly(ewr).map((v) => round(v / 86_400, 3));
const story = {
	waterYear: `${storyYear}/${String((storyYear + 1) % 100).padStart(2, '0')}`,
	// mm per week
	rain: weekly(values(base, 'rain_final'), true).map((v) => round(v, 1)),
	// m³/s, the catchment's natural runoff
	runoff: weekly(values(base, 'natural_flow')).map((v) => round(v / 86_400, 3)),
	dam: { name: DAM, pctFull: weekly(values(base, 'dam_storage', damNode.id)).map((v) => round((v / damNode.damCapacityM3) * 100, 1)) },
	farm: {
		name: shortFarm.name,
		// m³/day
		demand: weekly(values(base, 'demand', shortNode)).map((v) => round(v)),
		supplied: weekly(values(base, 'supplied', shortNode)).map((v) => round(v))
	},
	river: { flow: flowQ, reserve: ewrQ, weeksBelow: flowQ.filter((q, k) => q < ewrQ[k]!).length }
};

// ---- the what-if grid ------------------------------------------------------
// Extra orchard on Bergwater (hectares of apples) × its dam's size (× today's).
const EXTRA_HA = [0, 10, 20, 30, 40, 50, 60];
const DAM_SCALE = [1, 1.25, 1.5, 1.75, 2];
const farmId = nodeId(kleinberg, FARM);
const apples = kleinberg.model.crops.find((c) => c.name === 'Apples')!.id;

function variant(extraHa: number, damScale: number): ModelInput {
	const model = structuredClone(kleinberg.model);
	const node = model.nodes.find((n) => n.id === farmId)!;
	node.damCapacityM3 *= damScale;
	// A bigger dam of the same mean depth covers more water.
	if (node.damAreaFullM2 !== null) node.damAreaFullM2 *= damScale;
	const area = model.cropAreas.find((a) => a.nodeId === farmId && a.cropId === apples)!;
	area.areaM2 += extraHa * 10_000;
	return { ...input, model };
}

const grid = EXTRA_HA.map((ha) =>
	DAM_SCALE.map((scale) => {
		const o = runModel(variant(ha, scale));
		const farm = o.summary.farms.find((f) => f.nodeId === farmId)!;
		return {
			// Days a year the river is below the reserve, at the outlet.
			reserveDays: round(o.summary.catchment.ewrDaysNotMet / years(o), 1),
			// Share of the farm's irrigation demand the run supplied, %.
			supplied: round(farm.fractionSupplied * 100, 1),
			// Irrigation water the farm got, thousand m³ a year.
			suppliedKm3: round((farm.avgSuppliedM3Day * 365.25) / 1000)
		};
	})
);

const baseFarm = base.summary.farms.find((f) => f.nodeId === farmId)!;
// How closely the fitted model follows the example's weir record (Nash–Sutcliffe,
// 1 is a perfect match): the run's own score over its calibration window, the
// figure the app's Summary shows as "Calibration NSE".
const nse = base.summary.calibration?.nse;
if (nse == null) throw new Error('the example run has no calibration score: is its weir record missing?');
const data = {
	source: 'Invented example catchment (Kleinberg); every figure is synthetic.',
	engineVersion: base.engineVersion,
	period: { start: base.startDate, end: base.endDate },
	hero: {
		reserveMetPct: round((1 - base.summary.catchment.ewrFractionDaysNotMet) * 100, 1),
		farms: kleinberg.model.nodes.filter((n) => n.kind === 'farm').length,
		dams: kleinberg.model.nodes.filter((n) => n.damCapacityM3 > 0).length,
		years: Math.round(years(base)),
		days: base.days,
		calibrationNse: round(nse, 2)
	},
	story,
	whatIf: {
		farm: FARM,
		baseHa: round(kleinberg.model.cropAreas.find((a) => a.nodeId === farmId && a.cropId === apples)!.areaM2 / 10_000),
		baseDamM3: kleinberg.model.nodes.find((n) => n.id === farmId)!.damCapacityM3,
		baseSupplied: round(baseFarm.fractionSupplied * 100, 1),
		extraHa: EXTRA_HA,
		damScale: DAM_SCALE,
		grid
	}
};
await writeFile(
	out,
	`// Generated by \`pnpm gen:landing-art\` (backend/scripts/landing-data.ts): the engine
// run on the invented Kleinberg example catchment. Don't edit by hand; rerun it.
/* eslint-disable */
export const DATA = ${JSON.stringify(data, null, '\t')};
`
);
console.log(`landing data: ${out}, story year ${story.waterYear}, reserve met ${data.hero.reserveMetPct} %, grid ${EXTRA_HA.length} × ${DAM_SCALE.length}`);
