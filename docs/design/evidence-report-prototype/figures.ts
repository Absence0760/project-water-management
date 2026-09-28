// Prints the figures the evidence-report mock-up shows, from real engine runs
// of the synthetic Sandspruit example (backend/scripts/examples), so the
// mock-up never tells a story the engine can't (docs/design/evidence-report.md
// § 2; the farmer view's finding F3 is the reason). Design aid only: not part
// of any build or test.
//
//   pnpm -C backend exec tsx ../docs/design/evidence-report-prototype/figures.ts [members] [seed]
//
// What it does:
//   1. builds Sandspruit and gives its outlet a SYNTHETIC Reserve rule table
//      (the example has none): each EWR point is a fixed share of the
//      baseline's own natural flow at that point, so the table is plausible
//      and invented. It stands in for the published baseline.
//   2. the application: Vaalbank raises its dam 350 000 → 600 000 m³ and
//      adds 40 ha of maize (two proposal ops, no baseline assumption).
//   3. runs both, a behavioural ensemble on the baseline (default 300
//      members, seed 4242) and the paired band (application − baseline).
//   4. prints JSON: the headline figures, the checklist items and the bands.
import { createHash } from 'node:crypto';
import { buildExamples } from '../../../backend/scripts/examples/catchments.ts';
import {
	applyScenario,
	canonicalJson,
	classifyOp,
	ensembleDecisionRule,
	resolveEnsembleOptions,
	runEnsemble,
	runModel,
	runPairedEnsemble,
	seriesDigest,
	summariseEnsemble,
	summarisePaired,
	ENGINE_VERSION,
	type ModelInput,
	type ScenarioOp
} from '../../../packages/engine/src/index.ts';

const members = Number(process.argv[2] ?? 300);
const seed = Number(process.argv[3] ?? 4242);

const ex = buildExamples({ fit: false }).find((e) => e.name.includes('Sandspruit'));
if (!ex) throw new Error('no Sandspruit example');
const series: ModelInput['series'] = {};
for (const s of ex.series) series[s.kind] ??= { startDate: s.startDate, values: s.values };
const plain: ModelInput = { settings: ex.settings, model: ex.model, series };

// 1. A synthetic rule table at the outlet, from the plain run's natural flow.
const first = runModel(plain);
const natural = first.series.find((s) => s.nodeId === null && s.key === 'natural_flow')!.values;
const start = ex.series[0]!.startDate;
const dayMs = 86_400_000;
const t0 = Date.parse(`${start}T00:00:00Z`);
const POINTS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 99];
// Monthly mean flow (m³/s) per calendar month and year, complete months only.
const monthly = new Map<string, { sum: number; n: number; days: number }>();
natural.forEach((q, i) => {
	const d = new Date(t0 + i * dayMs);
	const key = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`;
	const m = monthly.get(key) ?? { sum: 0, n: 0, days: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate() };
	m.sum += q;
	m.n++;
	monthly.set(key, m);
});
const byCal = Array.from({ length: 12 }, () => [] as number[]);
for (const [k, m] of monthly) if (m.n === m.days) byCal[Number(k.split('-')[1]) - 1]!.push(m.sum / m.n / 86_400);
// Share of natural flow the "Reserve" asks for: more in the drought points.
const share = (p: number) => 0.12 + 0.18 * (p / 100);
const wyCal = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const ewr = wyCal.map((cal) => {
	const xs = [...byCal[cal - 1]!].sort((a, b) => b - a);
	const n = xs.length;
	let prev = Infinity;
	return POINTS.map((p) => {
		const r = (p / 100) * (n + 1);
		const lo = Math.min(Math.max(Math.floor(r), 1), n);
		const hi = Math.min(lo + 1, n);
		const v = xs[lo - 1]! + (r - lo) * (xs[hi - 1]! - xs[lo - 1]!);
		// A requirement can't rise towards the drought points: running minimum.
		prev = Math.min(prev, Math.round(Math.max(v, 0) * share(p) * 1000) / 1000);
		return prev;
	});
});
const baseInput: ModelInput = {
	...plain,
	settings: {
		...plain.settings,
		ewrRules: [
			{
				siteNodeId: null,
				source: 'Synthetic desktop table (design mock-up only)',
				component: 'lowFlow',
				unit: 'm3s',
				points: POINTS,
				ewr,
				naturalSource: 'run',
				natural: null,
				scale: 1
			}
		]
	}
};

// 2. The application.
const vaalbank = ex.model.nodes.find((n) => n.name === 'Vaalbank')!;
const maize = ex.model.crops.find((c) => c.name === 'Maize')!;
const ops: ScenarioOp[] = [
	{ op: 'node.set', nodeId: vaalbank.id, field: 'damCapacityM3', value: 600_000 },
	{ op: 'cropArea.set', nodeId: vaalbank.id, cropId: maize.id, areaM2: 400_000 }
];
const applied = applyScenario(baseInput, ops);
if (applied.problems.length) throw new Error(applied.problems.join('; '));
const appInput = applied.input;

// 3. Runs and bands.
const base = runModel(baseInput);
const app = runModel(appInput);
const { options } = resolveEnsembleOptions(baseInput, { members, seed });
const ens = runEnsemble(baseInput, options);
const sum = summariseEnsemble(ens);
const paired = runPairedEnsemble(appInput, ens);
const psum = summarisePaired(ens, paired);

// 4. Print.
const r = (x: number | null | undefined, d = 2) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
const b = (x: { p5: number | null; p50: number | null; p95: number | null } | undefined, d = 2) =>
	x ? { p5: r(x.p5, d), p50: r(x.p50, d), p95: r(x.p95, d) } : null;
const site = (o: typeof base) => {
	const s = o.summary.ewrAssurance?.[0];
	return s
		? {
				name: s.name,
				rate: r(s.overall.rate, 3),
				months: s.overall.months,
				met: s.overall.met,
				longestNotMetRun: s.overall.longestNotMetRun,
				deficitMm3: r(s.overall.deficitM3 / 1e6, 3),
				fdcRate: r(s.fdc.rate, 3),
				byMonth: s.byMonth.map((m) => ({ month: m.month, years: m.years, met: m.met }))
			}
		: null;
};
const farm = (o: typeof base, id: string) => o.summary.farms.find((f) => f.nodeId === id);
const cal = base.summary.calibration;
const days = natural.length;
const outlet = (o: typeof base) => ({
	ewrDaysNotMet: o.summary.catchment.ewrDaysNotMet,
	ewrPctDaysNotMet: r(100 * o.summary.catchment.ewrFractionDaysNotMet, 1),
	marOutflowMm3: r((o.summary.catchment.meanSimulatedOutflowM3Day * 365.25) / 1e6, 3),
	marNaturalMm3: r((o.summary.catchment.meanNaturalFlowM3Day * 365.25) / 1e6, 3)
});
console.log(
	JSON.stringify(
		{
			engineVersion: ENGINE_VERSION,
			period: { start, days, end: new Date(t0 + (days - 1) * dayMs).toISOString().slice(0, 10) },
			ops: ops.map((op) => ({ op: op.op, class: classifyOp(op, [vaalbank.id], baseInput) })),
			calibration: cal && {
				window: [cal.windowStart, cal.windowEnd],
				days: cal.days,
				kge: r(cal.kge),
				nse: r(cal.nse),
				logNse: r(cal.logNse),
				pbias: r(cal.pbias, 1)
			},
			wr2012: base.summary.wr2012 && {
				quaternary: base.summary.wr2012.quaternary,
				scaledMarMm3: r(base.summary.wr2012.scaledMarMm3, 3),
				overlapRatio: r(base.summary.wr2012.overlap?.ratio, 3),
				flag: (base.summary.wr2012 as unknown as { flag?: { level: string } }).flag?.level ?? null
			},
			dataQuality: {
				zeroRainInfill: base.summary.zeroRainInfill ?? null,
				rainAccumulation: base.summary.rainAccumulation ? 'present' : null,
				chirpsDays: (base.summary.chirpsCorrection as unknown as { daysFilled?: number } | null)?.daysFilled ?? null,
				warnings: base.summary.warnings
			},
			baseline: { outlet: outlet(base), reserve: site(base) },
			application: { outlet: outlet(app), reserve: site(app) },
			vaalbank: {
				base: farm(base, vaalbank.id) && { fractionSupplied: r(farm(base, vaalbank.id)!.fractionSupplied, 3) },
				app: farm(app, vaalbank.id) && { fractionSupplied: r(farm(app, vaalbank.id)!.fractionSupplied, 3) }
			},
			farmsDownstream: base.summary.farms
				.filter((f) => ['Lemoenkraal', 'Uitkyk'].includes(f.name))
				.map((f) => ({ name: f.name, base: r(f.fractionSupplied, 3), app: r(farm(app, f.nodeId)?.fractionSupplied, 3) })),
			ensemble: {
				total: sum.total,
				accepted: sum.accepted,
				rejected: sum.rejected,
				gated: sum.gated,
				referenceAccepted: sum.referenceAccepted,
				coverage: sum.coverage.map((c) => ({ record: c.record, heldOutDays: c.heldOutDays, fraction: r(c.fraction, 3) })),
				ewrDaysNotMet: b(sum.bands.ewrDaysNotMet, 0),
				marOutflowMm3: b(sum.bands.marOutflowMm3, 3),
				reserve: sum.bands.reserve.map((x) => ({ name: x.name, band: b(x.band, 3) })),
				decisionRule: ensembleDecisionRule(options, ens.header)
			},
			paired: {
				members: psum.members,
				ewrDaysNotMet: b(psum.ewrDaysNotMet, 0),
				ewrDaysNotMetWorse: r(psum.ewrDaysNotMetWorse, 3),
				ewrDaysNotMetByMonth: psum.ewrDaysNotMetByMonth.map((x) => b(x, 1)),
				marOutflowMm3: b(psum.marOutflowMm3, 4),
				shortfallMm3: b(psum.shortfallMm3, 4),
				shortfallWorse: r(psum.shortfallWorse, 3),
				reserve: psum.reserve.map((x) => ({ name: x.name, band: b(x.band, 4) })),
				decisionRule: psum.decisionRule
			},
			// Month × water-year grids of "met" (1) / "not met" (0), for the heat maps.
			heatmap: (() => {
				const grid = (o: typeof base) => {
					const rows = new Map<number, (number | null)[]>();
					for (const m of o.summary.ewrAssurance?.[0]?.months ?? []) {
						const row = rows.get(m.waterYear) ?? Array<number | null>(12).fill(null);
						row[(m.month + 2) % 12] = m.met ? 1 : 0;
						rows.set(m.waterYear, row);
					}
					return rows;
				};
				const a = grid(base);
				const c = grid(app);
				const years = [...a.keys()].sort((x, y) => x - y);
				return { years, base: years.map((y) => a.get(y)), app: years.map((y) => c.get(y)) };
			})(),
			// One month's duration curves against the EWR curve (the month with the largest paired change).
			fdc: (() => {
				const byMonth = psum.ewrDaysNotMetByMonth.map((x) => x.p50 ?? 0);
				const wy = byMonth.indexOf(Math.max(...byMonth));
				const cal = wyCal[wy]!;
				const pick = (o: typeof base) => o.summary.ewrAssurance?.[0]?.byMonth.find((m) => m.month === cal)?.fdc ?? [];
				return {
					month: cal,
					points: pick(base).map((p) => p.point),
					required: pick(base).map((p) => r(p.required, 4)),
					base: pick(base).map((p) => r(p.impacted, 4)),
					app: pick(app).map((p) => r(p.impacted, 4))
				};
			})(),
			// The run's own values (member 0) against its bands.
			reference: {
				base: sum.reference && { shortfallMm3: r(sum.reference.shortfallMm3, 3), ewrDaysNotMet: sum.reference.ewrDaysNotMet },
				app: (() => {
					const m = paired.members.find((p) => p.index === 0)?.metrics;
					return m ? { shortfallMm3: r(m.shortfallMm3, 3), ewrDaysNotMet: m.ewrDaysNotMet } : null;
				})()
			},
			rainAccumulation: base.summary.rainAccumulation && {
				mode: base.summary.rainAccumulation.mode,
				windows: base.summary.rainAccumulation.windows.length,
				spreadDays: base.summary.rainAccumulation.spreadDays
			},
			// SHA-256 of each input series, as a run snapshot stores it (valuesSha256).
			seriesHashes: Object.entries(baseInput.series).map(([kind, s]) => ({
				kind,
				startDate: s!.startDate,
				days: s!.values.length,
				sha256: createHash('sha256').update(seriesDigest(s!.values)).digest('hex')
			})),
			opsSha256: createHash('sha256').update(canonicalJson(ops)).digest('hex'),
			ewrTableOct: ewr[0]
		},
		null,
		1
	)
);
