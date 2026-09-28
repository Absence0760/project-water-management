// The summary CSV's assurance-of-supply blocks (engine ≥ 0.32.0, WP-3.4,
// docs/model.md §2.11a–b): reliability per farm and user over the reporting
// window, stress classes per water-year month, and the water account. Kept
// apart from run-tables.ts so the three blocks stay one unit. Unrounded.
import { STRESS_LABEL, type RunSummary, type WaterAccountRow } from '@water-management/engine';
import { csvRow } from './csv.js';

type Cell = string | number | null;

type SupplyAssurance = NonNullable<RunSummary['supplyAssurance']>;

/** Block titles, as splitSummary (frontend spreadsheet/export/summary.ts) matches them. */
export const RELIABILITY_TITLE = 'Assurance of supply (reporting window)';
export const STRESS_TITLE = 'Stress classes by month (supplied ÷ demand)';
export const ACCOUNT_TITLE = 'Water account by water year (Oct–Sep)';

const WY_MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
const pct = (v: number | null): Cell => (v === null ? null : Number((v * 100).toPrecision(12)));
const waterYearText = (y: number | null) => (y === null ? 'Whole run' : `${y}/${String((y + 1) % 100).padStart(2, '0')}`);

const NOT_COMPUTED = 'Not computed: run made before engine 0.32.0. Run it again to see it.';

export function* supplyAssuranceLines(a: RunSummary['supplyAssurance']): Generator<string> {
	yield* reliabilityLines(a);
	yield '';
	yield* stressLines(a);
	yield '';
	yield* waterAccountLines(a);
}

function* reliabilityLines(a: SupplyAssurance | undefined): Generator<string> {
	yield csvRow([RELIABILITY_TITLE]);
	if (!a) {
		yield csvRow([NOT_COMPUTED]);
		return;
	}
	yield csvRow(['Window', a.reportStart, a.reportEnd, `${a.days} days`]);
	yield csvRow(['Annual threshold (supplied ÷ demand in a water year)', pct(a.annualThreshold), '%', 'a project setting, not a standard']);
	yield csvRow([
		'Farm or user',
		'Kind',
		'Demand (m³)',
		'Supplied (m³)',
		'Demand days',
		'Days fully met',
		'Time-based (% of demand days met)',
		'Volumetric (% of demand supplied)',
		'Complete water years',
		'Part water years left out',
		'Water years met',
		'Annual (% of complete water years met)',
		'Failure runs',
		'Mean failure length (days)',
		'Longest failure (days)',
		'Mean deficit per failure (m³)',
		'Largest deficit of a failure (m³)'
	]);
	for (const r of a.reliability) {
		yield csvRow([
			r.name,
			r.kind === 'farm' ? 'farm' : 'other water user',
			r.demandM3,
			r.suppliedM3,
			r.demandDays,
			r.metDays,
			pct(r.timeReliability),
			pct(r.volumetricReliability),
			r.waterYears,
			// Engine ≥ 1.11.0: the annual measure leaves part years out; blank on an earlier run, which counted them.
			r.partWaterYears ?? null,
			r.waterYearsMet,
			pct(r.annualReliability),
			r.failureRuns,
			r.meanFailureDays,
			r.longestFailureDays,
			r.meanFailureDeficitM3,
			r.maxFailureDeficitM3
		]);
	}
	yield '';
	yield csvRow(['Time-based reliability by month (% of demand days met, reporting window)']);
	yield csvRow(['Farm or user', ...WY_MONTHS]);
	for (const r of a.reliability) yield csvRow([r.name, ...r.months.map((m) => pct(m.timeReliability))]);
	yield '';
	yield csvRow(['Volumetric reliability by month (% of demand supplied, reporting window)']);
	yield csvRow(['Farm or user', ...WY_MONTHS]);
	for (const r of a.reliability) yield csvRow([r.name, ...r.months.map((m) => pct(m.volumetricReliability))]);
}

function* stressLines(a: SupplyAssurance | undefined): Generator<string> {
	yield csvRow([STRESS_TITLE]);
	if (!a) {
		yield csvRow([NOT_COMPUTED]);
		return;
	}
	const s = a.stress;
	yield csvRow(['Classes', ...s.thresholds.map((t) => `${STRESS_LABEL[t.cls]} ≥ ${pct(t.min)} %`), `${STRESS_LABEL.critical} below`]);
	yield csvRow(['Whole run; an empty cell had no demand']);
	for (const g of [s.system, ...s.nodes]) {
		yield '';
		yield csvRow(['Stress', g.kind === 'system' ? 'All farms and users' : g.name]);
		yield csvRow(['Water year', ...WY_MONTHS.flatMap((m) => [m, `${m} (%)`])]);
		for (const [i, wy] of s.waterYears.entries()) {
			yield csvRow([
				waterYearText(wy),
				...g.stressClass[i]!.flatMap((c, j) => [c ? STRESS_LABEL[c] : '', pct(g.ratio[i]![j]!)])
			]);
		}
	}
}

/** The account's columns: in, out, storage, residual; memo columns at the end. */
const ACCOUNT_COLUMNS: [header: string, value: (r: WaterAccountRow) => Cell][] = [
	['Days', (r) => r.days],
	['IN natural flow (m³)', (r) => r.naturalFlowM3],
	['IN rain on dams (m³)', (r) => r.rainOnDamsM3],
	['IN groundwater pumped (m³)', (r) => r.groundwaterM3],
	['IN net transfers (m³)', (r) => r.transfersM3],
	['Total in (m³)', (r) => r.inM3],
	['OUT removed by land cover (m³)', (r) => r.landCoverM3],
	['OUT natural flow not allocated to a farm (m³)', (r) => r.unallocatedM3],
	['OUT consumptive irrigation (m³)', (r) => r.consumptiveIrrigationM3],
	['OUT other users: taken − returned (m³)', (r) => r.otherUseM3],
	['OUT dam evaporation (m³)', (r) => r.damEvaporationM3],
	['OUT dam seepage lost from the catchment (m³)', (r) => r.damSeepageLostM3 ?? null],
	['OUT stream depletion from pumping (m³)', (r) => r.streamDepletionM3],
	['OUT outflow at the outlet (m³)', (r) => r.outflowM3],
	['Total out (m³)', (r) => r.outM3],
	['Dam storage at start (m³)', (r) => r.openingStorageM3],
	['Dam storage at end (m³)', (r) => r.closingStorageM3],
	['Change in storage (m³)', (r) => r.storageChangeM3],
	['Residual: in − out − change in storage (m³)', (r) => r.residualM3],
	['Memo: catchment rain (m³)', (r) => r.rainM3],
	['Memo: rain not reaching the river (m³)', (r) => r.catchmentLossM3],
	['Memo: irrigation supplied (m³)', (r) => r.irrigationSuppliedM3],
	['Memo: dam seepage, rejoins the river (m³)', (r) => r.damSeepageM3],
	['Memo: released below the dams (m³)', (r) => r.damReleaseM3 ?? null]
];

function* waterAccountLines(a: SupplyAssurance | undefined): Generator<string> {
	yield csvRow([ACCOUNT_TITLE]);
	if (!a) {
		yield csvRow([NOT_COMPUTED]);
		return;
	}
	const w = a.waterAccount;
	yield csvRow(['In − out − change in storage = residual; the residual is float noise. Dam releases are not modelled yet.']);
	const rows = [...w.years, w.total];
	yield csvRow(['Water year', ...ACCOUNT_COLUMNS.map(([h]) => h)]);
	for (const r of rows) yield csvRow([waterYearText(r.waterYear), ...ACCOUNT_COLUMNS.map(([, f]) => f(r))]);
	const sites = w.total.ewr;
	if (!sites.length) return;
	yield '';
	yield csvRow(['EWR required vs met by water year (m³)']);
	yield csvRow(['Water year', ...sites.flatMap((s) => [`${s.name} required`, `${s.name} met`, `${s.name} met (%)`, `${s.name} days not met`])]);
	for (const r of rows) {
		yield csvRow([
			waterYearText(r.waterYear),
			...r.ewr.flatMap((e) => [e.requiredM3, e.metM3, pct(e.requiredM3 > 0 ? e.metM3 / e.requiredM3 : null), e.daysNotMet])
		]);
	}
}
