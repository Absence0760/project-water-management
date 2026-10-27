import { describe, expect, it } from 'vitest';
import { checkDamObservations, CLEAR_MIN_PCT, damObservationsSection, DAM_OBSERVATIONS_VERSION, WOFS_CITATION, type EvidenceDamObservationInput } from './damObservations';

// Invented dams and dates (no real place or measurement).
const DAMS: EvidenceDamObservationInput[] = [
	{
		featureId: '00000000-0000-4000-8000-000000000002',
		name: '',
		nodeId: 'F2',
		rows: [
			{ date: '2019-12-31', wetAreaM2: 500, pctObserved: 100 }, // before the period
			{ date: '2020-02-01', wetAreaM2: 0, pctObserved: 100 },
			{ date: '2020-01-01', wetAreaM2: 1200, pctObserved: CLEAR_MIN_PCT }, // exactly the threshold: clear
			{ date: '2020-01-09', wetAreaM2: 900, pctObserved: CLEAR_MIN_PCT - 0.001 }, // just under: observed only
			{ date: '2021-01-01', wetAreaM2: 700, pctObserved: 100 } // after the period
		]
	},
	{ featureId: '00000000-0000-4000-8000-000000000001', name: 'Upper dam', nodeId: 'F1', rows: [{ date: '2020-03-01', wetAreaM2: 10, pctObserved: 99 }] },
	{ featureId: '00000000-0000-4000-8000-000000000003', name: 'Neighbour’s dam', nodeId: 'F3', rows: [{ date: '2020-03-01', wetAreaM2: 10, pctObserved: 99 }] },
	{ featureId: '00000000-0000-4000-8000-000000000004', name: 'Loose dam', nodeId: null, rows: [] }
];
const MODEL = { nodes: [{ id: 'F2', name: 'Farm two' }] } as never;
const CTX = { applicant: true, ownNodeIds: ['F1', 'F2'], startDate: '2020-01-01', endDate: '2020-12-31', models: [MODEL] };

describe('damObservationsSection', () => {
	it('counts each own dam’s clear and wet dates in the period, and freezes the clear ones', () => {
		const s = damObservationsSection(DAMS, CTX)!;
		expect(s).toMatchObject({ version: DAM_OBSERVATIONS_VERSION, source: 'wofs', citation: WOFS_CITATION, startDate: '2020-01-01', endDate: '2020-12-31', clearMinPct: CLEAR_MIN_PCT });
		// Named by the feature, else its unit; ordered by name.
		expect(s.dams.map((d) => d.name)).toEqual(['Farm two', 'Upper dam']);
		expect(s.dams[0]).toEqual({
			featureId: '00000000-0000-4000-8000-000000000002',
			name: 'Farm two',
			nodeId: 'F2',
			observedDates: 3,
			clearDates: 2,
			wetDates: 1,
			clear: [
				['2020-01-01', 1200],
				['2020-02-01', 0]
			]
		});
		expect(checkDamObservations(s)).toEqual([]);
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
});

describe('checkDamObservations', () => {
	const fresh = () => damObservationsSection(DAMS, CTX)!;
	it.each([
		['a wet count the dates don’t give', (s: ReturnType<typeof fresh>) => void (s.dams[0]!.wetDates = 2), /2 wet dates named, 1 counted/],
		['a clear count the list doesn’t give', (s: ReturnType<typeof fresh>) => void (s.dams[0]!.clearDates = 5), /5 clear dates named, 2 listed/],
		['dates out of order', (s: ReturnType<typeof fresh>) => void s.dams[0]!.clear.reverse(), /not in order/],
		['a date outside the period', (s: ReturnType<typeof fresh>) => void (s.dams[0]!.clear[0]![0] = '2019-01-01'), /outside 2020-01-01–2020-12-31/],
		['a negative wet area', (s: ReturnType<typeof fresh>) => void (s.dams[0]!.clear[0]![1] = -1), /not a number of square metres/],
		['another threshold', (s: ReturnType<typeof fresh>) => void (s.clearMinPct = 50), /threshold is 50 %/],
		['another counting version', (s: ReturnType<typeof fresh>) => void ((s as { version: string }).version = 'dam-obs-0'), /counted by dam-obs-0/]
	])('finds %s', (_l, tamper, message) => {
		const s = fresh();
		tamper(s);
		expect(checkDamObservations(s).join('; ')).toMatch(message);
	});
});
