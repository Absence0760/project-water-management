import {
	comparePlausibility,
	RECESSION_DEFAULTS,
	type PlausibilityChecks,
	type PlausibilityComparison,
	type PlausibilityMetric,
	type PlausibilitySiteDelta,
	type RecessionCheck,
	type ValidationSignatures
} from '@water-management/engine';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import PlausibilityCompare from './PlausibilityCompare.svelte';
import { plausibilityNotes, plausibilityRows, waterYear } from './plausibility';

const m = (a: number | null, b: number | null): PlausibilityMetric => ({ a, b, delta: a !== null && b !== null ? b - a : null });

function site(over: Partial<PlausibilitySiteDelta> = {}): PlausibilitySiteDelta {
	return {
		name: 'Outlet',
		nameA: null,
		isOutlet: true,
		nodeId: null,
		onlyIn: null,
		naturalised: {
			flowKindA: 'flow_observed_m3s',
			flowKindB: 'flow_observed_m3s',
			judgedYears: m(3, 3),
			failedA: [2001, 2002],
			failedB: [2002, 2003],
			newlyFailing: [2003],
			nowPassing: [2001],
			passedA: false,
			passedB: false
		},
		lowFlow: {
			flowKindA: 'flow_observed_m3s',
			flowKindB: 'flow_observed_m3s',
			days: m(900, 900),
			observedQ90M3s: m(0.1, 0.1),
			simulatedQ90M3s: m(0.03, 0.09),
			ratio: m(0.3, 0.9),
			withinA: false,
			withinB: true
		},
		...over
	};
}

describe('plausibilityRows', () => {
	it('gives each site’s failing years and Q90 ratio side by side, with what changed', () => {
		const c: PlausibilityComparison = { sites: [site()], rainSource: null, flowDoubleMass: null, recession: null, signatures: null };
		expect(plausibilityRows(c)).toEqual([
			{
				key: 'outlet|nat',
				site: 'Outlet',
				check: 'Natural ≥ observed + abstraction',
				a: 'fails 2001/02, 2002/03: 2 of 3 (gauge)',
				b: 'fails 2002/03, 2003/04: 2 of 3 (gauge)',
				okA: false,
				okB: false,
				change: 'newly fails 2003/04; now passes 2001/02'
			},
			{
				key: 'outlet|q90',
				site: 'Outlet',
				check: 'Dry-season Q90, simulated ÷ observed',
				a: '0.30× (outside the factor of 2)',
				b: '0.90× (within the factor of 2)',
				okA: false,
				okB: true,
				change: '+0.60×'
			}
		]);
	});

	it('names a gauge (and its old name), says what a side didn’t check, and passes with no failing year', () => {
		const gauge = site({
			name: 'Upper weir',
			nameA: 'Weir 1',
			isOutlet: false,
			nodeId: 'g1',
			naturalised: { ...site().naturalised!, flowKindA: null, failedA: null, judgedYears: m(null, 2), failedB: [], newlyFailing: [], nowPassing: [], passedA: null, passedB: true },
			lowFlow: null
		});
		const rows = plausibilityRows({ sites: [gauge], rainSource: null, flowDoubleMass: null, recession: null, signatures: null });
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ key: 'g1|nat', site: 'Upper weir (was Weir 1)', a: 'not checked', b: 'passes all 2 (gauge)', okA: null, okB: true, change: '–' });
	});

	it('adds the catchment-wide rain-source split and double-mass breaks', () => {
		const rows = plausibilityRows({
			sites: [],
			rainSource: {
				goodYears: m(8, 7),
				fallbackYears: m(2, 3),
				goodFractionNotMet: m(0.1, 0.1),
				fallbackFractionNotMet: m(0.15, 0.3),
				warnsA: false,
				warnsB: true,
				fallbackWaterYearsA: [2001, 2002],
				fallbackWaterYearsB: [2001, 2002, 2003]
			},
			flowDoubleMass: {
				flowKindA: 'flow_observed_m3s',
				flowKindB: 'flow_observed_m3s',
				wholeSlope: m(0.1, 0.12),
				breaksA: [{ afterWaterYear: 2005, change: -0.25, unexplained: -0.2, hint: 'newUse' }],
				breaksB: []
			},
			recession: null,
			signatures: null
		});
		expect(rows.map((r) => [r.site, r.check, r.a, r.b, r.okA, r.okB, r.change])).toEqual([
			[
				'Catchment',
				'EWR days by rain source',
				'15% of days not met in 2 fallback-rain years, 10% in good-rain years',
				'30% of days not met in 3 fallback-rain years, 10% in good-rain years (warns)',
				true,
				false,
				'+1 fallback-rain years'
			],
			['Catchment', 'Observed flow vs rain (double mass)', 'after 2005/06 (−25 %, new use)', 'no break the model doesn’t share', false, true, 'runoff ratio +0.020']
		]);
	});

	it('writes water years as the hydrological year', () => {
		expect(waterYear(1999)).toBe('1999/00');
		expect(waterYear(2009)).toBe('2009/10');
	});
});

// The recession diagnostics (engine ≥ 1.19.0) and the validation signatures (engine ≥ 1.55.0) as each run
// stored them, built through the engine's comparePlausibility from hand-made checks.
const bare: PlausibilityChecks = { drySeason: null, naturalised: null, rainSource: null, flowDoubleMass: null, lowFlow: null };
const fit = (b: number) => ({ a: 0.05, b, points: 40, segments: 10, minQM3s: 0.1, maxQM3s: 3 });
const rec = (over: Partial<RecessionCheck> = {}): RecessionCheck => ({
	flowKind: 'flow_observed_m3s',
	options: { ...RECESSION_DEFAULTS },
	segments: Array.from({ length: 10 }, (_, i) => [i * 20, i * 20 + 8] as [number, number]),
	observed: fit(1.5),
	simulated: fit(1.8),
	referenceFlowM3s: 0.5,
	observedRate: 0.04,
	simulatedRate: 0.06,
	rateRatio: 1.5,
	bDiff: 0.3,
	agrees: true,
	...over
});
const sig = (o: { hughes?: number; slope?: number | null; flv?: number; skill?: number; agrees?: boolean | null; segs?: number } & Partial<ValidationSignatures> = {}): ValidationSignatures => {
	const { hughes = 0.05, slope = 20, flv = -10, skill = 0.4, agrees = true, segs = 12, ...rest } = o;
	return {
		flowKind: 'flow_observed_m3s',
		baseflow: {
			hughesFilter: { kind: 'quickflow', alpha: 0.995, beta: 0.5, passes: 1 },
			eckhardtFilter: { kind: 'eckhardt', a: 0.98, bfiMax: 0.25 },
			days: 1000,
			runs: 2,
			hughes: { observed: 0.4, simulated: 0.4 + hughes, difference: hughes },
			eckhardt: { observed: 0.2, simulated: 0.22, difference: 0.02 },
			withinLimit: Math.abs(hughes) <= 0.15
		},
		lowFlowFdc: {
			days: 1000,
			range: [70, 95],
			observedQ70M3s: 0.5,
			observedQ95M3s: 0.1,
			simulatedQ70M3s: 0.5,
			simulatedQ95M3s: 0.08,
			observedSlope: 6.4,
			simulatedSlope: 7.3,
			slopeBiasPct: slope,
			lowVolumeBiasPct: flv,
			withinLimit: true
		},
		recessionHoldout: { every: 3, segments: segs, heldOut: [], law: null, days: 30, modelSegments: 4, modelDays: 30, modelSkill: skill, lawSkill: 0.6, modelLogRmse: 0.1, lawLogRmse: 0.08, agrees },
		...rest
	};
};
const cmp = (a: PlausibilityChecks | undefined, b: PlausibilityChecks | undefined) => comparePlausibility(a, b)!;
const newRows = (c: PlausibilityComparison) => plausibilityRows(c).filter((r) => r.key === 'outlet|recession' || r.key.startsWith('sig|'));

/** The rendered HTML as text: comments dropped, each tag a space, whitespace collapsed. */
const text = (html: string) => {
	let out = '';
	for (let i = 0; i < html.length; ) {
		if (html.startsWith('<!--', i)) {
			const end = html.indexOf('-->', i + 4);
			i = end < 0 ? html.length : end + 3;
		} else if (html[i] === '<') {
			const end = html.indexOf('>', i);
			out += ' ';
			i = end < 0 ? html.length : end + 1;
		} else out += html[i++];
	}
	return out.replace(/\s+/g, ' ');
};

describe('plausibilityRows: the recession diagnostics and the validation signatures', () => {
	it('gives each run’s recession rate ratio, b difference and verdict, and the change in each', () => {
		const c = cmp({ ...bare, recession: rec({ rateRatio: 2.6, bDiff: 0.7, agrees: false }) }, { ...bare, recession: rec() });
		expect(newRows(c)[0]).toEqual({
			key: 'outlet|recession',
			site: 'Outlet',
			check: 'Recessions, simulated vs observed (rate ratio, b difference)',
			a: 'rate 2.60×, b +0.70 (disagrees)',
			b: 'rate 1.50×, b +0.30 (agrees)',
			okA: false,
			okB: true,
			change: 'rate −1.10×; b −0.40'
		});
	});

	it('says a recession side is not judged with too few segments, or has no simulated fit', () => {
		const c = cmp(
			{ ...bare, recession: rec({ segments: [[0, 8]], agrees: null }) },
			{ ...bare, recession: rec({ simulated: null, simulatedRate: null, rateRatio: null, bDiff: null, agrees: false }) }
		);
		const [r] = newRows(c);
		expect([r!.a, r!.b, r!.okA, r!.okB, r!.change]).toEqual(['rate 1.50×, b +0.30 (not judged: 1 of 8 segments)', 'no simulated fit (disagrees)', null, false, '–']);
	});

	it('sets the BFI by both filters, the low-flow biases and the held-out skill side by side, each with pass or fail', () => {
		const c = cmp({ ...bare, signatures: sig({ hughes: 0.2, slope: 70, flv: -60, skill: -0.2, agrees: false }) }, { ...bare, signatures: sig() });
		expect(newRows(c).map((r) => [r.site, r.check, r.a, r.b, r.okA, r.okB, r.change])).toEqual([
			['Outlet', 'Base-flow index, Hughes et al. (2003)', '0.40 observed, 0.60 simulated (+0.20, outside ±0.15)', '0.40 observed, 0.45 simulated (+0.05, within ±0.15)', false, true, 'simulated −0.15'],
			['Outlet', 'Base-flow index, Eckhardt (2005)', '0.20 observed, 0.22 simulated (+0.02, within ±0.15)', '0.20 observed, 0.22 simulated (+0.02, within ±0.15)', true, true, 'simulated +0.00'],
			['Outlet', 'Low-flow FDC slope bias, Q70–Q95', '+70 % (outside ±50 %)', '+20 % (within ±50 %)', false, true, '−50 points'],
			['Outlet', 'Low-flow volume bias (%BiasFLV)', '−60 % (outside ±50 %)', '−10 % (within ±50 %)', false, true, '+50 points'],
			['Outlet', 'Skill on held-out recessions, simulated', '−0.20 (the river’s own curve 0.60)', '0.40 (the river’s own curve 0.60)', false, true, '+0.60']
		]);
		expect(plausibilityNotes(c)).toEqual([]);
	});

	it('names the scored gauge, and says an unjudged hold-out or an uncomputed slope is so, not a failure', () => {
		const at = { siteNodeId: 'w1', siteName: 'Middle weir' };
		const c = cmp({ ...bare, signatures: sig({ ...at, slope: null, agrees: null, segs: 5 }) }, { ...bare, signatures: sig(at) });
		const rows = newRows(c);
		expect(rows.every((r) => r.site === 'Middle weir')).toBe(true);
		const slope = rows.find((r) => r.key === 'sig|fdc-slope')!;
		expect([slope.a, slope.okA, slope.change]).toEqual(['not computed', null, '–']);
		const h = rows.find((r) => r.key === 'sig|holdout')!;
		expect([h.a, h.okA]).toEqual(['0.40 (the river’s own curve 0.60); not judged: 5 of 8 segments', null]);
	});

	it('says a run made before engine 1.55.0 has no signatures, with no false change', () => {
		const c = cmp({ ...bare, recession: rec() }, { ...bare, recession: rec(), signatures: sig() });
		const rows = newRows(c).filter((r) => r.key.startsWith('sig|'));
		expect(rows).toHaveLength(5);
		for (const r of rows) {
			expect(r.a).toBe('not in this run (made before engine 1.55.0)');
			expect([r.okA, r.change]).toEqual([null, '–']);
		}
		expect(plausibilityNotes(c)).toEqual(['Run A was made before engine 1.55.0, so it has no validation signatures: run the model again to compare them.']);
	});

	it('says a run with no observed record has no signatures, and a run before 1.19.0 no recession diagnostics', () => {
		const c = cmp(undefined, { ...bare, recession: rec(), signatures: null });
		expect(plausibilityNotes(c)).toEqual(['Run A was made before engine 1.19.0, so it has no recession diagnostics: run the model again to compare them.']);
		const d = cmp({ ...bare, signatures: sig() }, { ...bare, signatures: null });
		expect(newRows(d).find((r) => r.key === 'sig|bfi-hughes')!.b).toBe('not computed (no observed record)');
		expect(plausibilityNotes(d)).toEqual(['Run B has no validation signatures: it has no observed flow record to score.']);
		expect(plausibilityNotes(cmp(bare, { ...bare, drySeason: null }))).toEqual([]);
	});

	it('gives no change between two runs that scored different records, and says why', () => {
		const c = cmp({ ...bare, signatures: sig() }, { ...bare, signatures: sig({ hughes: 0.1, siteNodeId: 'w1', siteName: 'Middle weir', flowKind: 'flow_logger_m3s' }) });
		const rows = newRows(c);
		expect(rows.map((r) => r.change)).toEqual(['–', '–', '–', '–', '–']);
		expect(rows[0]!.site).toBe('Scored record');
		expect(plausibilityNotes(c)).toEqual([
			'The validation signatures score different records (run A the gauge record at the outlet, run B the logger record at gauge “Middle weir”), so no change is given.'
		]);
	});
});

describe('PlausibilityCompare', () => {
	it('renders the recession and signature rows and the note on a run without signatures', () => {
		const c = cmp({ ...bare, recession: rec(), signatures: null }, { ...bare, recession: rec(), signatures: sig() });
		const html = render(PlausibilityCompare, { props: { comparison: c } }).body;
		const t = text(html);
		expect(t).toContain('Run A has no validation signatures: it has no observed flow record to score.');
		expect(t).toContain('Recessions, simulated vs observed (rate ratio, b difference) rate 1.50×, b +0.30 (agrees) rate 1.50×, b +0.30 (agrees) rate +0.00×; b +0.00');
		expect(t).toContain('Base-flow index, Hughes et al. (2003) not computed (no observed record) 0.40 observed, 0.45 simulated (+0.05, within ±0.15) –');
		expect(t).toContain('Skill on held-out recessions, simulated not computed (no observed record) 0.40 (the river’s own curve 0.60) –');
		// Pass and fail in colour as well as words: B's signature cells are marked, A's have no mark.
		expect(html.match(/class="res good[^"]*"/g)?.length).toBe(7);
		expect(html.match(/class="res none[^"]*"/g)?.length).toBe(5);
	});

	it('shows the empty state, and no note, when neither run has any check', () => {
		const t = text(render(PlausibilityCompare, { props: { comparison: cmp(bare, bare) } }).body);
		expect(t).toContain('Neither run could make these checks');
		expect(t).not.toContain('Run A');
	});
});
