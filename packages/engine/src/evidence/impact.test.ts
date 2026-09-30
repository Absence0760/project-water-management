import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import type { WaterAccountRow } from '../network/reliability';
import type { EwrAssuranceMonth, EwrAssuranceSite } from '../reserve/assurance';
import { licenceImpactSection } from './impact';
import type { EvidenceImpactInput, EvidenceRunInput } from './types';

// Synthetic record: nine complete water years 2000/01 … 2008/09, annual
// natural totals 900 … 8100 m³ (terciles: 2000–02 dry), as in
// views/licenceImpact.test.ts. Invented numbers.
const START = '2000-10-01';
const YEARS = 9;
const wyDays = (wy: number) => toEpochDay(`${wy + 1}-10-01`) - toEpochDay(`${wy}-10-01`);
const natTotal = (wy: number) => (wy - 1999) * 900;
const dry = (wy: number) => wy <= 2002;

const account = (irrigation: number) => {
	const years: Partial<WaterAccountRow>[] = [];
	for (let i = 0; i < YEARS; i++) {
		const wy = 2000 + i;
		years.push({
			waterYear: wy,
			days: wyDays(wy),
			naturalFlowM3: natTotal(wy),
			consumptiveIrrigationM3: irrigation,
			otherUseM3: 0,
			outflowM3: natTotal(wy) - irrigation,
			rainOnDamsM3: 0,
			damEvaporationM3: 0,
			storageChangeM3: 0,
			landCoverM3: 0,
			unallocatedM3: 0,
			streamDepletionM3: 0,
			groundwaterM3: 0,
			transfersM3: 0,
			residualM3: 0
		});
	}
	return { areaKm2: null, years, total: { ...years[0], waterYear: null } };
};

/** Reserve months at each site: `notMet(wy)` months missed in a water year. */
const site = (nodeId: string | null, notMet: (wy: number) => number) => {
	const months: EwrAssuranceMonth[] = [];
	for (let i = 0; i < YEARS; i++) {
		const wy = 2000 + i;
		for (let m = 0; m < 12; m++) {
			months.push({ year: m < 3 ? wy : wy + 1, month: ((m + 9) % 12) + 1, waterYear: wy, days: 30, natural: 1, percentile: 50, beyond: null, required: 1, actual: 1, met: m >= notMet(wy), deficitM3: 0 });
		}
	}
	return { nodeId, isOutlet: nodeId === null, months } as unknown as EwrAssuranceSite;
};

function run(irrigation: number, sites: EwrAssuranceSite[], opts: { account?: boolean } = {}): EvidenceRunInput {
	return {
		id: `run-${irrigation}`,
		label: '',
		startDate: START,
		summary: { ...(opts.account === false ? {} : { supplyAssurance: { waterAccount: account(irrigation) } }), ewrAssurance: sites },
		inputs: { settings: {}, model: { nodes: [{ id: 'g1', name: 'Upper gauge' }] }, series: {} }
	} as unknown as EvidenceRunInput;
}

/** The three stored series, with a JSON null (a gap) in the application's shortfall. */
function input(over: Partial<EvidenceImpactInput> = {}): EvidenceImpactInput {
	const natural: (number | null)[] = [];
	const short: (number | null)[] = [];
	for (let i = 0; i < YEARS; i++) {
		const wy = 2000 + i;
		const n = wyDays(wy);
		for (let d = 0; d < n; d++) {
			natural.push(natTotal(wy) / n);
			short.push(0);
		}
	}
	const gap = [...short];
	gap[10] = null;
	return { yearClassMethod: 'terciles', siteNodeId: null, series: { backgroundNatural: natural, backgroundEwrShortfall: short, applicationEwrShortfall: gap }, ...over };
}

const baseline = run(100, [site(null, (wy) => (dry(wy) ? 2 : 0)), site('g1', () => 0)]);
const application = run(150, [site(null, (wy) => (dry(wy) ? 4 : 0)), site('g1', (wy) => (dry(wy) ? 1 : 0))]);

describe('licenceImpactSection (evidence-5, issue #53 R7)', () => {
	it('is null for baseline evidence', () => {
		expect(licenceImpactSection(baseline, null, input())).toBeNull();
	});

	it('gives the engine’s own licence impact for the two runs, at the outlet by default', () => {
		const s = licenceImpactSection(baseline, application, input())!;
		expect(s).toMatchObject({ yearClassMethod: 'terciles', requestedSite: null, site: null, siteFellBack: false });
		expect(s.result.status).toBe('ok');
		if (s.result.status !== 'ok') return;
		expect(s.result.impact.method).toBe('terciles');
		expect(s.result.impact.classes.map((c) => [c.classId, c.waterYears])).toEqual([
			['dry', [2000, 2001, 2002]],
			['normal', [2003, 2004, 2005]],
			['wet', [2006, 2007, 2008]]
		]);
		expect(s.result.impact.classes[0]).toMatchObject({ classId: 'dry', below: { background: 6, application: 12, change: 6 }, verdict: 'moreBelow' });
		expect(s.result.impact.classes[0]!.waterfall!.proposedM3).toBeCloseTo(50, 9);
	});

	it('survives a JSON round trip unchanged (a pack stores it as jsonb, and JSON has no NaN)', () => {
		const s = licenceImpactSection(baseline, application, input());
		expect(JSON.parse(JSON.stringify(s))).toEqual(s);
	});

	it('reads a gauge with Reserve results in both runs, named from the baseline’s model', () => {
		const s = licenceImpactSection(baseline, application, input({ siteNodeId: 'g1' }))!;
		expect(s).toMatchObject({ requestedSite: { nodeId: 'g1', name: 'Upper gauge' }, site: { nodeId: 'g1', name: 'Upper gauge' }, siteFellBack: false });
		expect(s.result.status === 'ok' && s.result.impact.siteNodeId).toBe('g1');
		expect(s.result.status === 'ok' && s.result.impact.classes[0]!.below).toEqual({ units: 36, background: 0, application: 3, change: 3 });
	});

	it('falls back to the outlet, and says so, when one run has no Reserve results at the gauge', () => {
		const noGauge = run(150, [site(null, (wy) => (dry(wy) ? 4 : 0))]);
		const s = licenceImpactSection(baseline, noGauge, input({ siteNodeId: 'g1' }))!;
		expect(s).toMatchObject({ requestedSite: { nodeId: 'g1', name: 'Upper gauge' }, site: null, siteFellBack: true });
		expect(s.result.status === 'ok' && s.result.impact.siteNodeId).toBeNull();
	});

	it('says why it could not be built', () => {
		expect(licenceImpactSection(baseline, application, null)!.result).toEqual({ status: 'unavailable', reason: 'notBuilt', detail: null });
		const noNatural = input();
		noNatural.series.backgroundNatural = null;
		expect(licenceImpactSection(baseline, application, noNatural)!.result).toEqual({ status: 'unavailable', reason: 'noNaturalFlow', detail: null });
		const old = run(150, [site(null, () => 0)], { account: false });
		expect(licenceImpactSection(baseline, old, input())!.result).toEqual({ status: 'unavailable', reason: 'noWaterAccount', detail: null });
	});

	it('names the missing shortfall series when the days fallback needs it', () => {
		// No Reserve rule table in either run: days below the EWR, which read ewr_shortfall.
		const b = run(100, []);
		const a = run(150, []);
		const noShort = input();
		noShort.series.applicationEwrShortfall = null;
		expect(licenceImpactSection(b, a, noShort)!.result).toMatchObject({ status: 'unavailable', reason: 'noEwrShortfall' });
		expect(licenceImpactSection(b, a, input())!.result.status).toBe('ok');
	});
});
