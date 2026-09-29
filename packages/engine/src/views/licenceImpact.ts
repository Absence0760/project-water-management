// Licence impact by year class (issue #53 R7, docs/design/planning-outputs.md
// §3.7, docs/model.md §2.14a): the evidence report's page-1 board. For each
// water-year class (./yearClasses.ts) it sets a *background* run (what the
// impact is judged against: today's baseline, later a full-allocation run)
// beside the *application* run, as an annual waterfall (natural flow →
// existing use → the proposed extra use → other → flow left) and the months
// below the Reserve in each.
//
// A view over saved runs: not part of runModel, so ENGINE_VERSION doesn't
// move. Pure: no I/O.
//
// Decisions (model.md §2.14a):
// - **Classes from the background run's natural flow**, so both runs are
//   judged over the same years. Only years both runs cover in full count.
// - **The verdict comes from the months**, never from the annual totals: a
//   waterfall can close with water to spare in a year that failed every
//   summer month (design §2 finding 5). Months below the Reserve are counted
//   as outcomeMatrix counts them (reserveMonthsMet, from
//   summary.ewrAssurance at the site); without a rule table in both runs,
//   days below the pragmatic EWR at the outlet (daysBelowEwr), the same
//   fallback.
// - **Use** is the water account's consumptive use (§2.11b): irrigation
//   supplied less its return flow, plus other water users' take less what
//   they return. It is what the river loses to the users; the gross
//   abstraction is larger by the return flows.
// - **Other** closes the waterfall: natural − existing − proposed − left.
//   It is the rest of the application run's water account (dam evaporation
//   and seepage lost, storage change, land cover, groundwater, transfers,
//   the natural flow's difference between the runs), broken down in
//   `otherParts`, so a reader sees what it is.
// - **Not enough years**: fewer than OUTCOME_MIN_YEARS years in a class →
//   no waterfall, no counts, verdict `notEnoughYears`.
// - The words report data ("not met in 4 more months over 7 dry years"),
//   never a recommendation in the app's voice.
import { toEpochDay } from '../calendar';
import type { WaterAccountRow } from '../network/reliability';
import type { ModelOutput } from '../project';
import { OUTCOME_MIN_YEARS, outcomeMatrix, type OutcomeCell, type OutcomeMetric } from './outcomeMatrix';
import { classifyRunWaterYears, type WaterYearClasses, type YearClassId, type YearClassMethod } from './yearClasses';

/** What a run must carry: its start, its natural flow (and ewr_shortfall for the days fallback) at the outlet, its summary. */
export type LicenceImpactRun = Pick<ModelOutput, 'startDate' | 'series' | 'summary'>;

export interface LicenceImpactInput {
	/** The run the impact is judged against (a baseline, or a full-allocation run). Its natural flow sets the classes. */
	background: LicenceImpactRun;
	/** The run with the proposed use. */
	application: LicenceImpactRun;
	/** The Reserve site: null (default) = the outlet, else a gauge with a rule table in both runs (the metric is then forced to Reserve months). */
	siteNodeId?: string | null;
	/** Defaults to `auto` (./yearClasses.ts). */
	yearClassMethod?: YearClassMethod;
}

/** Changed / unchanged months (or days) below the requirement: application against background. */
export type LicenceImpactVerdict = 'noChange' | 'moreBelow' | 'fewerBelow' | 'notEnoughYears';

/** What makes up `otherM3`, mean m³ a year; Σ = otherM3 up to float noise. */
export interface LicenceImpactOtherParts {
	/** Dam evaporation + dam seepage lost from the catchment + off-takes' conveyance losses − rain on the dams. */
	damLossesM3: number;
	/** Dam storage at the end − at the start of the year, less storage set by a reset. */
	storageChangeM3: number;
	/** Natural flow removed by land cover, and natural flow no farm received. */
	landCoverM3: number;
	/** Stream depletion − groundwater pumped (use counts pumped water; the river loses the depletion). */
	groundwaterM3: number;
	/** − net transfers (0 up to float noise). */
	transfersM3: number;
	/** The background run's natural flow − the application's (0 when the proposal leaves the rain-runoff alone). */
	naturalDifferenceM3: number;
	/** The application's water-account residual (float noise). */
	residualM3: number;
}

/** A class's annual waterfall, mean m³ a year over its years. natural − existing − proposed − other = left. */
export interface LicenceImpactWaterfall {
	/** Natural flow at the outlet, the background run's. */
	naturalM3: number;
	/** Consumptive use in the background run. */
	existingUseM3: number;
	/** The application's consumptive use − the background's (negative when it uses less). */
	proposedM3: number;
	/** What closes the waterfall (see LicenceImpactOtherParts). */
	otherM3: number;
	otherParts: LicenceImpactOtherParts;
	/** Outflow at the outlet in the application run. */
	leftM3: number;
	/** Memo: outflow at the outlet in the background run. */
	backgroundLeftM3: number;
}

/** Months (or days) below the requirement over a class's years. */
export interface LicenceImpactBelow {
	/** Months (Reserve) or days assessed, in the background run. */
	units: number;
	background: number;
	application: number;
	/** application − background. */
	change: number;
}

export interface LicenceImpactClass {
	classId: YearClassId;
	label: string;
	lowerM3: number | null;
	upperM3: number | null;
	/** Years compared: in the class, and covered in full by both runs. */
	nYears: number;
	enoughYears: boolean;
	/** Oldest first. */
	waterYears: number[];
	/** Null when !enoughYears. */
	waterfall: LicenceImpactWaterfall | null;
	/** Null when !enoughYears. */
	below: LicenceImpactBelow | null;
	verdict: LicenceImpactVerdict;
}

export interface LicenceImpact {
	metric: OutcomeMetric;
	/** The Reserve site (reserveMonthsMet), null = outlet; always null for daysBelowEwr. The waterfall is always at the outlet. */
	siteNodeId: string | null;
	method: WaterYearClasses['method'];
	/** Driest first. */
	classes: LicenceImpactClass[];
	/** Water years the background run touches but that aren't classed. */
	excluded: WaterYearClasses['excluded'];
	warnings: string[];
}

const wyLength = (wy: number) => toEpochDay(`${wy + 1}-10-01`) - toEpochDay(`${wy}-10-01`);

/** A run's water-account rows for its complete water years, by water year. Throws without an account. */
function accountYears(run: LicenceImpactRun, which: string): Map<number, WaterAccountRow> {
	const account = run.summary.supplyAssurance?.waterAccount;
	if (!account) throw new Error(`the ${which} run has no water account (summary.supplyAssurance, engine ≥ 0.32.0): run the model again`);
	const out = new Map<number, WaterAccountRow>();
	for (const r of account.years) if (r.waterYear !== null && r.days === wyLength(r.waterYear)) out.set(r.waterYear, r);
	return out;
}

const use = (r: WaterAccountRow) => r.consumptiveIrrigationM3 + r.otherUseM3;
const hasSite = (run: LicenceImpactRun, siteNodeId: string | null) => !!run.summary.ewrAssurance?.some((s) => (siteNodeId === null ? s.isOutlet : s.nodeId === siteNodeId));

/** Build the board: one entry per class of the background run's natural flow, driest first. */
export function licenceImpactByYearClass(input: LicenceImpactInput): LicenceImpact {
	const { background, application } = input;
	const siteNodeId = input.siteNodeId ?? null;
	const classes = classifyRunWaterYears(background, { method: input.yearClassMethod ?? 'auto' });
	const bgYears = accountYears(background, 'background');
	const appYears = accountYears(application, 'application');
	// At a gauge only Reserve months can be read (days below the EWR are stored at the outlet only).
	const matrix = outcomeMatrix(
		[
			{ id: 'background', label: 'Background', run: background },
			{ id: 'application', label: 'Application', run: application }
		],
		classes,
		{ siteNodeId, metric: siteNodeId === null ? 'auto' : 'reserveMonthsMet' }
	);
	const warnings: string[] = [];
	if (matrix.metric === 'daysBelowEwr' && (hasSite(background, siteNodeId) || hasSite(application, siteNodeId))) {
		warnings.push('Only one of the two runs has a Reserve rule table at the site, so both are judged by days below the pragmatic EWR at the outlet.');
	}

	const yearsOf = (cell: OutcomeCell) => new Map(cell.years.map((y) => [y.waterYear, y] as const));
	let dropped = 0;
	const out = classes.classes.map((band, ci): LicenceImpactClass => {
		const bgCell = yearsOf(matrix.cells[0]![ci]!);
		const appCell = yearsOf(matrix.cells[1]![ci]!);
		const waterYears = band.waterYears.filter((wy) => bgYears.has(wy) && appYears.has(wy) && bgCell.has(wy) && appCell.has(wy));
		dropped += band.waterYears.length - waterYears.length;
		const nYears = waterYears.length;
		const enoughYears = nYears >= OUTCOME_MIN_YEARS;
		const common = { classId: band.id, label: band.label, lowerM3: band.lowerM3, upperM3: band.upperM3, nYears, enoughYears, waterYears };
		if (!enoughYears) return { ...common, waterfall: null, below: null, verdict: 'notEnoughYears' };

		const mean = (f: (wy: number) => number) => waterYears.reduce((s, wy) => s + f(wy), 0) / nYears;
		const bg = (wy: number) => bgYears.get(wy)!;
		const app = (wy: number) => appYears.get(wy)!;
		const naturalM3 = mean((wy) => bg(wy).naturalFlowM3);
		const existingUseM3 = mean((wy) => use(bg(wy)));
		const proposedM3 = mean((wy) => use(app(wy))) - existingUseM3;
		const leftM3 = mean((wy) => app(wy).outflowM3);
		const otherParts: LicenceImpactOtherParts = {
			damLossesM3: mean((wy) => {
				const r = app(wy);
				return r.damEvaporationM3 + (r.damSeepageLostM3 ?? 0) + (r.conveyanceLossM3 ?? 0) - r.rainOnDamsM3;
			}),
			storageChangeM3: mean((wy) => app(wy).storageChangeM3 - (app(wy).storageSetM3 ?? 0)),
			landCoverM3: mean((wy) => app(wy).landCoverM3 + app(wy).unallocatedM3),
			groundwaterM3: mean((wy) => app(wy).streamDepletionM3 - app(wy).groundwaterM3),
			transfersM3: mean((wy) => -app(wy).transfersM3),
			naturalDifferenceM3: mean((wy) => bg(wy).naturalFlowM3 - app(wy).naturalFlowM3),
			residualM3: mean((wy) => app(wy).residualM3)
		};
		const waterfall: LicenceImpactWaterfall = {
			naturalM3,
			existingUseM3,
			proposedM3,
			otherM3: naturalM3 - existingUseM3 - proposedM3 - leftM3,
			otherParts,
			leftM3,
			backgroundLeftM3: mean((wy) => bg(wy).outflowM3)
		};

		// Reserve: months not met = assessed − met; days: the count is already the days below.
		const belowOf = (cell: Map<number, OutcomeCell['years'][number]>) =>
			waterYears.reduce(
				(s, wy) => {
					const y = cell.get(wy)!;
					return { units: s.units + y.units, below: s.below + (matrix.metric === 'reserveMonthsMet' ? y.units - y.count : y.count) };
				},
				{ units: 0, below: 0 }
			);
		const b = belowOf(bgCell);
		const a = belowOf(appCell);
		const change = a.below - b.below;
		return {
			...common,
			waterfall,
			below: { units: b.units, background: b.below, application: a.below, change },
			verdict: change > 0 ? 'moreBelow' : change < 0 ? 'fewerBelow' : 'noChange'
		};
	});
	if (dropped) warnings.push(`${dropped} classed water year(s) are not covered in full by both runs, so they are left out.`);

	return { metric: matrix.metric, siteNodeId: matrix.siteNodeId, method: classes.method, classes: out, excluded: classes.excluded, warnings };
}

const count = (n: number, one: string, other: string) => `${n} ${n === 1 ? one : other}`;

/** Labels for the two runs in the words; the defaults suit any surface. */
export interface LicenceImpactNames {
	background: string;
	application: string;
}

const DEFAULT_NAMES: LicenceImpactNames = { background: 'the background run', application: 'the application' };

/**
 * One sentence for a class, reporting what the runs did, never advice:
 * "The Reserve was not met in 4 more months over 7 dry years (9 in the
 * background run, 13 with the application)."
 */
export function describeLicenceImpact(metric: OutcomeMetric, c: LicenceImpactClass, names: LicenceImpactNames = DEFAULT_NAMES): string {
	const cls = c.label.toLowerCase();
	const years = `${count(c.nYears, `${cls} year`, `${cls} years`)}`;
	if (!c.enoughYears || !c.below) {
		return c.nYears === 0 ? `No ${cls} years both runs cover: not enough years to judge.` : `Only ${years} both runs cover: not enough years to judge.`;
	}
	const what = metric === 'reserveMonthsMet' ? 'The Reserve was' : 'The pragmatic EWR was';
	const [one, other, prep] = metric === 'reserveMonthsMet' ? ['month', 'months', 'in'] : ['day', 'days', 'on'];
	const { background: bg, application: app, change } = c.below;
	if (change === 0) {
		return bg === 0
			? `${what} met ${metric === 'reserveMonthsMet' ? 'in every month' : 'on every day'} over ${years} in both runs.`
			: `${what} not met ${prep} ${count(bg, one, other)} over ${years} in both runs.`;
	}
	const more = change > 0 ? 'more' : 'fewer';
	return `${what} not met ${prep} ${Math.abs(change)} ${more} ${Math.abs(change) === 1 ? one : other} over ${years} (${bg} in ${names.background}, ${app} in ${names.application}).`;
}
