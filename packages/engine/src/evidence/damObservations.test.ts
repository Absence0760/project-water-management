import { describe, expect, it } from 'vitest';
import {
	checkDamObservations,
	checkDamObservationsBySource,
	classifyDamDate,
	combinedDamDates,
	DAM_OBSERVATION_RULES,
	damObservationsSection,
	damObservationsSectionV1,
	DAM_OBSERVATIONS_V1,
	DAM_OBSERVATIONS_VERSION,
	DRY_MIN_CLEAR_PCT,
	sentinelCitation,
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
			{ source: 'wofs', date: '2019-12-31', wetAreaM2: 5 * PX, pctObserved: 100 }, // before the period
			{ source: 'wofs', date: '2020-02-01', wetAreaM2: 0, pctObserved: 100 }, // dry
			{ source: 'wofs', date: '2020-01-01', wetAreaM2: 2 * PX, pctObserved: 12 }, // wet: two pixels at any clear share
			{ source: 'wofs', date: '2020-01-09', wetAreaM2: PX, pctObserved: 100 }, // one pixel: inconclusive
			{ source: 'wofs', date: '2020-01-17', wetAreaM2: 0, pctObserved: DRY_MIN_CLEAR_PCT }, // exactly 99 %: dry
			{ source: 'wofs', date: '2020-01-25', wetAreaM2: 0, pctObserved: DRY_MIN_CLEAR_PCT - 0.001 }, // just under: inconclusive
			{ source: 'wofs', date: '2021-01-01', wetAreaM2: 7 * PX, pctObserved: 100 } // after the period
		]
	},
	{ featureId: '00000000-0000-4000-8000-000000000001', name: 'Upper dam', nodeId: 'F1', rows: [{ source: 'wofs', date: '2020-03-01', wetAreaM2: 10 * PX, pctObserved: 99 }] },
	{ featureId: '00000000-0000-4000-8000-000000000003', name: 'Neighbour’s dam', nodeId: 'F3', rows: [{ source: 'wofs', date: '2020-03-01', wetAreaM2: 10 * PX, pctObserved: 99 }] },
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

describe('damObservationsSectionV1 (dam-obs-1, evidence-21 to evidence-23)', () => {
	it('classifies each own dam’s dates in the period as wet, dry or inconclusive, and freezes them', () => {
		const s = damObservationsSectionV1(DAMS, CTX)!;
		expect(s).toMatchObject({
			version: DAM_OBSERVATIONS_V1,
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
		const s = damObservationsSectionV1(DAMS, CTX)!;
		expect(s.dams.some((d) => d.nodeId === 'F3' || d.nodeId === null)).toBe(false);
		// Positive control: the neighbour's dam is listed when it is the applicant's.
		expect(damObservationsSectionV1(DAMS, { ...CTX, ownNodeIds: ['F3'] })!.dams.map((d) => d.name)).toEqual(['Neighbour’s dam']);
	});

	it('is absent for baseline evidence and a team scenario, and empty for an applicant with no traced dam', () => {
		expect(damObservationsSectionV1(DAMS, { ...CTX, applicant: false })).toBeNull();
		expect(damObservationsSectionV1(null, CTX)!.dams).toEqual([]);
		expect(damObservationsSectionV1(DAMS, { ...CTX, ownNodeIds: [] })!.dams).toEqual([]);
	});

	it('throws on a date given twice for one dam, rather than keep the last row', () => {
		const twice: EvidenceDamObservationInput = {
			...DAMS[1]!,
			rows: [
				{ source: 'wofs', date: '2020-03-01', wetAreaM2: 0, pctObserved: 100 },
				{ source: 'wofs', date: '2020-03-01', wetAreaM2: 10 * PX, pctObserved: 100 }
			]
		};
		expect(() => damObservationsSectionV1([twice], CTX)).toThrow(/two WOfS rows for 2020-03-01/);
		// Positive control: the same date on two dams is fine.
		expect(damObservationsSectionV1([DAMS[1]!, { ...DAMS[0]!, rows: [{ source: 'wofs', date: '2020-03-01', wetAreaM2: 0, pctObserved: 100 }] }], CTX)!.dams).toHaveLength(2);
	});
});

describe('checkDamObservations on a dam-obs-1 section', () => {
	type S = NonNullable<ReturnType<typeof damObservationsSectionV1>>;
	const fresh = () => damObservationsSectionV1(DAMS, CTX)!;
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
		expect(checkDamObservations(s, { builtBy: '1.99.0' })).toEqual(['the observed wet days were counted by dam-obs-0; this code counts dam-obs-1 and dam-obs-2: check out the engine that built the report (1.99.0)']);
	});
});

// dam-obs-2 (evidence-24, issue #624 step 7): Sentinel-2 beside WOfS.
const S2 = DAM_OBSERVATION_RULES.s2;
const S2PX = S2.pixelAreaM2;
const BOTH: EvidenceDamObservationInput[] = [
	{
		featureId: '00000000-0000-4000-8000-000000000011',
		name: 'Small dam',
		nodeId: 'F1',
		rows: [
			// A 0.3 ha dam: WOfS sees one pixel at most, Sentinel-2 calls it.
			{ source: 'wofs', date: '2020-06-02', wetAreaM2: PX, pctObserved: 100 }, // inconclusive
			{ source: 's2', date: '2020-06-02', wetAreaM2: 25 * S2PX, pctObserved: 100 }, // wet: takes the date
			{ source: 's2', date: '2020-06-07', wetAreaM2: 8 * S2PX, pctObserved: 15 }, // exactly 8 pixels at a 15 % view: wet
			{ source: 's2', date: '2020-06-12', wetAreaM2: 7 * S2PX, pctObserved: 100 }, // 7: inconclusive
			{ source: 'wofs', date: '2020-06-10', wetAreaM2: 0, pctObserved: 100 }, // dry
			{ source: 's2', date: '2020-06-10', wetAreaM2: 7 * S2PX, pctObserved: 100 }, // inconclusive: leaves the date to WOfS's dry
			{ source: 'wofs', date: '2020-07-04', wetAreaM2: 3 * PX, pctObserved: 100 }, // wet …
			{ source: 's2', date: '2020-07-04', wetAreaM2: 0, pctObserved: 100 }, // … but Sentinel-2's clear dry view wins the date
			{ source: 's2', date: '2019-12-31', wetAreaM2: 0, pctObserved: 100 } // before the period
		]
	},
	{ featureId: '00000000-0000-4000-8000-000000000013', name: 'Neighbour’s dam', nodeId: 'F3', rows: [{ source: 's2', date: '2020-03-01', wetAreaM2: 90 * S2PX, pctObserved: 99 }] }
];

describe('classifyDamDate under Sentinel-2’s rule', () => {
	it('is wet at 8 pixels of 100 m² (two 20 m cells) at any clear share, dry at none on a 99 %-clear view', () => {
		expect(S2).toEqual({ wetMinPixels: 8, dryMinClearPct: 99, pixelAreaM2: 100 });
		expect(classifyDamDate(8 * S2PX, 1, S2)).toBe('wet');
		expect(classifyDamDate(7 * S2PX, 100, S2)).toBe('inconclusive');
		// The UTM scale's spread (±0.2 %) never moves the count.
		expect(classifyDamDate(8 * (100 / 1.001 ** 2), 50, S2)).toBe('wet');
		expect(classifyDamDate(0, 99, S2)).toBe('dry');
		expect(classifyDamDate(0, 98.9, S2)).toBe('inconclusive');
		expect(classifyDamDate(1, 100, S2)).toBe('inconclusive');
		// The same area is two WOfS pixels: the rules differ per source.
		expect(classifyDamDate(1800, 100, S2)).toBe('wet');
		expect(classifyDamDate(700, 100)).toBe('inconclusive');
	});
});

describe('combinedDamDates', () => {
	it('counts each date once, read by the sharper source that calls it', () => {
		expect(
			combinedDamDates({
				s2: [
					['2020-01-01', 0, 100], // dry, beats WOfS's wet
					['2020-01-02', 0, 50] // inconclusive: WOfS's dry stands
				],
				wofs: [
					['2020-01-01', 2 * PX, 100],
					['2020-01-02', 0, 100],
					['2020-01-03', PX, 100] // WOfS alone, inconclusive
				]
			})
		).toEqual({ observedDates: 3, wetDates: 0, dryDates: 2, inconclusiveDates: 1 });
		expect(combinedDamDates({ s2: [], wofs: [] })).toEqual({ observedDates: 0, wetDates: 0, dryDates: 0, inconclusiveDates: 0 });
	});
});

describe('sentinelCitation', () => {
	it('names the years of the dates, and nothing without one', () => {
		expect(sentinelCitation(['2020-06-02'])).toBe('Contains modified Copernicus Sentinel data 2020, processed by Digital Earth Africa');
		expect(sentinelCitation(['2021-01-01', '2019-03-01', '2020-01-01'])).toBe('Contains modified Copernicus Sentinel data 2019–2021, processed by Digital Earth Africa');
		expect(sentinelCitation([])).toBeNull();
	});
});

describe('damObservationsSection (dam-obs-2)', () => {
	it('counts each source under its rule and the dates together, with each source’s rule and credit', () => {
		const s = damObservationsSection(BOTH, CTX)!;
		expect(s.version).toBe(DAM_OBSERVATIONS_VERSION);
		expect(s.sources).toEqual([
			{ source: 's2', citation: 'Contains modified Copernicus Sentinel data 2020, processed by Digital Earth Africa', wetMinPixels: 8, dryMinClearPct: 99, pixelAreaM2: 100 },
			{ source: 'wofs', citation: WOFS_CITATION, wetMinPixels: 2, dryMinClearPct: 99, pixelAreaM2: 900 }
		]);
		expect(s.dams).toHaveLength(1);
		const d = s.dams[0]!;
		expect(d.sources.s2).toEqual({
			observedDates: 5,
			wetDates: 2,
			dryDates: 1,
			inconclusiveDates: 2,
			dates: [
				['2020-06-02', 2500, 100],
				['2020-06-07', 800, 15],
				['2020-06-10', 700, 100],
				['2020-06-12', 700, 100],
				['2020-07-04', 0, 100]
			]
		});
		expect(d.sources.wofs).toMatchObject({ observedDates: 3, wetDates: 1, dryDates: 1, inconclusiveDates: 1 });
		// Together: 06-02 wet (S2), 06-07 wet, 06-10 dry (WOfS), 06-12 inconclusive, 07-04 dry (S2 over WOfS's wet).
		expect({ observedDates: d.observedDates, wetDates: d.wetDates, dryDates: d.dryDates, inconclusiveDates: d.inconclusiveDates }).toEqual({
			observedDates: 5,
			wetDates: 2,
			dryDates: 2,
			inconclusiveDates: 1
		});
		expect(checkDamObservations(s, { period: { startDate: '2020-01-01', endDate: '2020-12-31' } })).toEqual([]);
	});

	it('gives a dam with no Sentinel-2 dates no Sentinel credit, and still counts its WOfS dates', () => {
		const s = damObservationsSection(DAMS, CTX)!;
		expect(s.sources[0]).toMatchObject({ source: 's2', citation: null });
		expect(s.dams.find((d) => d.nodeId === 'F2')).toMatchObject({ observedDates: 5, wetDates: 1, dryDates: 2, inconclusiveDates: 2, sources: { s2: { observedDates: 0, dates: [] } } });
		expect(checkDamObservations(s)).toEqual([]);
	});

	it('lists only the applicant’s own dams, and is absent for baseline evidence and a team scenario', () => {
		expect(damObservationsSection(BOTH, { ...CTX, ownNodeIds: ['F3'] })!.dams.map((d) => d.name)).toEqual(['Neighbour’s dam']);
		expect(damObservationsSection(BOTH, { ...CTX, applicant: false })).toBeNull();
		expect(damObservationsSection(BOTH, { ...CTX, ownNodeIds: [] })!.dams).toEqual([]);
	});

	it('throws on a date given twice for one dam and source, never on the same date from two sources', () => {
		const twice: EvidenceDamObservationInput = {
			...BOTH[0]!,
			rows: [
				{ source: 's2', date: '2020-03-01', wetAreaM2: 0, pctObserved: 100 },
				{ source: 's2', date: '2020-03-01', wetAreaM2: 0, pctObserved: 90 }
			]
		};
		expect(() => damObservationsSection([twice], CTX)).toThrow(/two Sentinel-2 rows for 2020-03-01/);
		expect(damObservationsSection([{ ...twice, rows: [twice.rows[0]!, { ...twice.rows[0]!, source: 'wofs' }] }], CTX)!.dams[0]!.observedDates).toBe(1);
	});
});

describe('checkDamObservationsBySource', () => {
	type S = NonNullable<ReturnType<typeof damObservationsSection>>;
	const fresh = () => damObservationsSection(BOTH, CTX)!;
	const failing = (s: S, ctx = {}) =>
		Object.entries(checkDamObservationsBySource(s, ctx))
			.filter(([, p]) => p.length)
			.map(([k]) => k)
			.sort();
	it.each([
		['a Sentinel-2 count its dates don’t give', (s: S) => void (s.dams[0]!.sources.s2.wetDates = 1), ['s2']],
		['a Sentinel-2 share that turns a dry date inconclusive', (s: S) => void (s.dams[0]!.sources.s2.dates[4]![2] = 90), ['days', 's2']],
		['a WOfS count its dates don’t give', (s: S) => void (s.dams[0]!.sources.wofs.dryDates = 0), ['wofs']],
		['a together count the dates don’t give', (s: S) => void (s.dams[0]!.wetDates = 4), ['days']],
		['another Sentinel-2 wet threshold', (s: S) => void (s.sources[0]!.wetMinPixels = 2), ['days', 's2']],
		['a Sentinel-2 credit for other years', (s: S) => void (s.sources[0]!.citation = 'Contains modified Copernicus Sentinel data 2019, processed by Digital Earth Africa'), ['s2']],
		['no Sentinel-2 credit for Sentinel-2 dates', (s: S) => void (s.sources[0]!.citation = null), ['s2']],
		['another WOfS credit', (s: S) => void (s.sources[1]!.citation = 'WOfS'), ['wofs']],
		['the sources in another order', (s: S) => void s.sources.reverse(), ['days', 's2', 'wofs']],
		['a Sentinel-2 date list missing', (s: S) => void delete (s.dams[0]!.sources as Partial<S['dams'][0]['sources']>).s2, ['days', 's2']],
		['a malformed WOfS date', (s: S) => void (s.dams[0]!.sources.wofs.dates[0]![0] = '2020-6-2'), ['days', 'wofs']],
		['another counting version', (s: S) => void ((s as { version: string }).version = 'dam-obs-9'), ['days', 's2', 'wofs']]
	])('puts %s on its own check', (_l, tamper, expected) => {
		const s = fresh();
		tamper(s);
		expect(failing(s)).toEqual(expected);
	});

	it('puts a period other than the baseline run’s on every check (positive control: the fresh section passes)', () => {
		expect(failing(fresh(), { period: { startDate: '2020-01-01', endDate: '2020-12-31' } })).toEqual([]);
		expect(failing(fresh(), { period: { startDate: '2020-01-01', endDate: '2021-12-31' } })).toEqual(['days', 's2', 'wofs']);
	});
});
