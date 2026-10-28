import { describe, expect, it } from 'vitest';
import {
	checkDamObservations,
	classifyDamDate,
	damObservationsSection,
	DAM_OBSERVATIONS_VERSION,
	DRY_MIN_CLEAR_PCT,
	WET_MIN_PIXELS,
	WOFS_CITATION,
	WOFS_PIXEL_AREA_M2,
	type EvidenceDamObservationInput
} from './damObservations';

// Invented dams and dates (no real place or measurement).
const PX = WOFS_PIXEL_AREA_M2;
const DAMS: EvidenceDamObservationInput[] = [
	{
		featureId: '00000000-0000-4000-8000-000000000002',
		name: '',
		nodeId: 'F2',
		rows: [
			{ date: '2019-12-31', wetAreaM2: 5 * PX, pctObserved: 100 }, // before the period
			{ date: '2020-02-01', wetAreaM2: 0, pctObserved: 100 }, // dry
			{ date: '2020-01-01', wetAreaM2: 2 * PX, pctObserved: 12 }, // wet: two pixels at any clear share
			{ date: '2020-01-09', wetAreaM2: PX, pctObserved: 100 }, // one pixel: inconclusive
			{ date: '2020-01-17', wetAreaM2: 0, pctObserved: DRY_MIN_CLEAR_PCT }, // exactly 99 %: dry
			{ date: '2020-01-25', wetAreaM2: 0, pctObserved: DRY_MIN_CLEAR_PCT - 0.001 }, // just under: inconclusive
			{ date: '2021-01-01', wetAreaM2: 7 * PX, pctObserved: 100 } // after the period
		]
	},
	{ featureId: '00000000-0000-4000-8000-000000000001', name: 'Upper dam', nodeId: 'F1', rows: [{ date: '2020-03-01', wetAreaM2: 10 * PX, pctObserved: 99 }] },
	{ featureId: '00000000-0000-4000-8000-000000000003', name: 'Neighbour’s dam', nodeId: 'F3', rows: [{ date: '2020-03-01', wetAreaM2: 10 * PX, pctObserved: 99 }] },
	{ featureId: '00000000-0000-4000-8000-000000000004', name: 'Loose dam', nodeId: null, rows: [] }
];
const MODEL = { nodes: [{ id: 'F2', name: 'Farm two' }] } as never;
const CTX = { applicant: true, ownNodeIds: ['F1', 'F2'], startDate: '2020-01-01', endDate: '2020-12-31', models: [MODEL] };

describe('classifyDamDate', () => {
	it('is wet at two pixels or more at any clear share, dry at no pixel on a 99 %-clear view, and inconclusive otherwise', () => {
		expect([WET_MIN_PIXELS, DRY_MIN_CLEAR_PCT, PX]).toEqual([2, 99, 900]);
		expect(classifyDamDate(2 * PX, 0.5)).toBe('wet');
		expect(classifyDamDate(2 * PX, 100)).toBe('wet');
		expect(classifyDamDate(PX, 100)).toBe('inconclusive');
		expect(classifyDamDate(0, 99)).toBe('dry');
		expect(classifyDamDate(0, 100)).toBe('dry');
		expect(classifyDamDate(0, 98.999)).toBe('inconclusive');
		expect(classifyDamDate(0, 0)).toBe('inconclusive');
	});

	it('counts pixels from the wet area whatever the UTM scale does to a pixel’s ground area (±0.2 %)', () => {
		// Two pixels near a zone edge (scale 1.001: 899.1 m² each), and near the central meridian (0.9996: 900.7 m²).
		expect(classifyDamDate(2 * (900 / 1.001 ** 2), 50)).toBe('wet');
		expect(classifyDamDate(2 * (900 / 0.9996 ** 2), 50)).toBe('wet');
		expect(classifyDamDate(900 / 0.9996 ** 2, 100)).toBe('inconclusive');
		// Any water at all, even under a pixel's worth, is never dry.
		expect(classifyDamDate(1, 100)).toBe('inconclusive');
	});
});

describe('damObservationsSection', () => {
	it('classifies each own dam’s dates in the period as wet, dry or inconclusive, and freezes them', () => {
		const s = damObservationsSection(DAMS, CTX)!;
		expect(s).toMatchObject({
			version: DAM_OBSERVATIONS_VERSION,
			source: 'wofs',
			citation: WOFS_CITATION,
			startDate: '2020-01-01',
			endDate: '2020-12-31',
			wetMinPixels: 2,
			dryMinClearPct: 99,
			pixelAreaM2: 900
		});
		// Named by the feature, else its unit; ordered by name.
		expect(s.dams.map((d) => d.name)).toEqual(['Farm two', 'Upper dam']);
		expect(s.dams[0]).toEqual({
			featureId: '00000000-0000-4000-8000-000000000002',
			name: 'Farm two',
			nodeId: 'F2',
			observedDates: 5,
			wetDates: 1,
			dryDates: 2,
			inconclusiveDates: 2,
			dates: [
				['2020-01-01', 2 * PX, 12],
				['2020-01-09', PX, 100],
				['2020-01-17', 0, 99],
				['2020-01-25', 0, 98.999],
				['2020-02-01', 0, 100]
			]
		});
		expect(checkDamObservations(s, { period: { startDate: '2020-01-01', endDate: '2020-12-31' } })).toEqual([]);
	});

	it('lists only the applicant’s own dams: a neighbour’s, or one on no unit, is never named', () => {
		const s = damObservationsSection(DAMS, CTX)!;
		expect(s.dams.some((d) => d.nodeId === 'F3' || d.nodeId === null)).toBe(false);
		// Positive control: the neighbour's dam is listed when it is the applicant's.
		expect(damObservationsSection(DAMS, { ...CTX, ownNodeIds: ['F3'] })!.dams.map((d) => d.name)).toEqual(['Neighbour’s dam']);
	});

	it('is absent for baseline evidence and a team scenario, and empty for an applicant with no traced dam', () => {
		expect(damObservationsSection(DAMS, { ...CTX, applicant: false })).toBeNull();
		expect(damObservationsSection(null, CTX)!.dams).toEqual([]);
		expect(damObservationsSection(DAMS, { ...CTX, ownNodeIds: [] })!.dams).toEqual([]);
	});

	it('throws on a date given twice for one dam, rather than keep the last row', () => {
		const twice: EvidenceDamObservationInput = {
			...DAMS[1]!,
			rows: [
				{ date: '2020-03-01', wetAreaM2: 0, pctObserved: 100 },
				{ date: '2020-03-01', wetAreaM2: 10 * PX, pctObserved: 100 }
			]
		};
		expect(() => damObservationsSection([twice], CTX)).toThrow(/two WOfS rows for 2020-03-01/);
		// Positive control: the same date on two dams is fine.
		expect(damObservationsSection([DAMS[1]!, { ...DAMS[0]!, rows: [{ date: '2020-03-01', wetAreaM2: 0, pctObserved: 100 }] }], CTX)!.dams).toHaveLength(2);
	});
});

describe('checkDamObservations', () => {
	type S = NonNullable<ReturnType<typeof damObservationsSection>>;
	const fresh = () => damObservationsSection(DAMS, CTX)!;
	const loose = (s: S) => s as unknown as { dams: Record<string, unknown>[] } & Record<string, unknown>;
	it.each([
		['a wet count the dates don’t give', (s: S) => void (s.dams[0]!.wetDates = 2), /2 wet dates named, 1 counted/],
		['a dry count the dates don’t give', (s: S) => void (s.dams[0]!.dryDates = 3), /3 dry dates named, 2 counted/],
		['an inconclusive count the dates don’t give', (s: S) => void (s.dams[0]!.inconclusiveDates = 0), /0 inconclusive dates named, 2 counted/],
		['an observed count the list doesn’t give', (s: S) => void (s.dams[0]!.observedDates = 9), /9 dates observed named, 5 listed/],
		['a share that turns a dry date inconclusive', (s: S) => void (s.dams[0]!.dates[2]![2] = 98), /2 dry dates named, 1 counted/],
		['dates out of order', (s: S) => void s.dams[0]!.dates.reverse(), /not in order/],
		['a date outside the period', (s: S) => void (s.dams[0]!.dates[0]![0] = '2019-01-01'), /outside 2020-01-01–2020-12-31/],
		['a malformed date', (s: S) => void (s.dams[0]!.dates[0]![0] = '2020-1-1'), /not an ISO date/],
		['a malformed period', (s: S) => void (s.startDate = '1 Jan 2020'), /period 1 Jan 2020–2020-12-31 is not two ISO dates/],
		['a negative wet area', (s: S) => void (s.dams[0]!.dates[0]![1] = -1), /not a number of square metres/],
		['a share over 100 %', (s: S) => void (s.dams[0]!.dates[0]![2] = 101), /not a percentage/],
		['a fractional count', (s: S) => void (s.dams[0]!.wetDates = 1.5), /wetDates 1.5 not a whole number/],
		['a negative count', (s: S) => void (s.dams[0]!.dryDates = -1), /dryDates -1 not a whole number/],
		['a count that isn’t a number', (s: S) => void (loose(s).dams[0]!.observedDates = '5'), /observedDates 5 not a whole number/],
		['another wet threshold', (s: S) => void (s.wetMinPixels = 1), /the rule is 1 wet pixels/],
		['another dry threshold', (s: S) => void (s.dryMinClearPct = 90), /90 % clear for dry/],
		['another counting version', (s: S) => void ((s as { version: string }).version = 'dam-obs-0'), /counted by dam-obs-0/]
	])('finds %s', (_l, tamper, message) => {
		const s = fresh();
		tamper(s);
		expect(checkDamObservations(s).join('; ')).toMatch(message);
	});

	it('finds a period other than the baseline run’s, and names the engine that built the report on another version', () => {
		const s = fresh();
		expect(checkDamObservations(s, { period: { startDate: '2020-01-01', endDate: '2021-12-31' } }).join('; ')).toMatch(
			/count 2020-01-01–2020-12-31, not the baseline run's period 2020-01-01–2021-12-31/
		);
		(s as { version: string }).version = 'dam-obs-0';
		expect(checkDamObservations(s, { builtBy: '1.99.0' })).toEqual(['the observed wet days were counted by dam-obs-0; this code counts dam-obs-1: check out the engine that built the report (1.99.0)']);
	});
});
