import { afterEach, describe, expect, it } from 'vitest';
import type { EwrAssuranceSite, FarmSummary, RunSummary } from '@water-management/engine';
import type { RunMeta } from '$lib/api/types';
import { LOW_PCT } from './damLevels';
import { fmtNum } from '$lib/format/number';
import { damsHeadline, headlines, historyDays, historyEnd, pickRuns, ranAgo, runDays, supplyFraction, type Headline } from './latestRun';

const meta = (id: string, createdAt: string, over: Partial<RunMeta> = {}): RunMeta => ({
	id,
	label: id,
	engineVersion: '0.30.0',
	startDate: '2021-10-01',
	endDate: '2022-01-28',
	createdAt,
	createdBy: null,
	legacy: false,
	...over
});

const farm = (name: string, demand: number, supplied: number): FarmSummary => ({
	nodeId: name,
	name,
	avgDemandM3Day: demand,
	avgSuppliedM3Day: supplied,
	avgDeficitM3Day: demand - supplied,
	fractionSupplied: demand > 0 ? supplied / demand : 1,
	avgEwrShortfallM3Day: 0,
	daysEwrNotMet: 0
});

const summary = (over: Partial<RunSummary> = {}): RunSummary =>
	({
		farms: [farm('Upper', 100, 100), farm('Lower', 100, 60)],
		catchment: {
			meanNaturalFlowM3Day: 86_400,
			meanSimulatedOutflowM3Day: 43_200,
			ewrDaysNotMet: 12,
			ewrFractionDaysNotMet: 0.1
		},
		calibration: { days: 90, nse: 0.62, pbias: 4, rmseM3s: 0.1, meanObservedM3s: 0.2, meanSimulatedM3s: 0.21, fitStatus: 'fitted' },
		warnings: [],
		...over
	}) as RunSummary;

const site = (nodeId: string | null, met: number, months: number, longest = 1): EwrAssuranceSite =>
	({
		nodeId,
		name: nodeId ?? 'Outflow gauge',
		isOutlet: nodeId === null,
		overall: { months, met, rate: months ? met / months : null, deficitM3: 0, longestNotMetRun: longest, meanShortfallPct: null }
	}) as EwrAssuranceSite;

const card = (hs: Headline[], id: Headline['id']) => {
	const h = hs.find((x) => x.id === id);
	if (!h) throw new Error(`no ${id} card`);
	return h;
};

describe('pickRuns', () => {
	it('is null without runs', () => {
		expect(pickRuns(null)).toBeNull();
		expect(pickRuns([])).toBeNull();
	});
	it('shows the newest run by createdAt and compares it with the one before, whatever the list order', () => {
		const a = meta('a', '2026-09-01T10:00:00Z');
		const b = meta('b', '2026-09-03T10:00:00Z');
		const c = meta('c', '2026-09-02T10:00:00Z');
		expect(pickRuns([a, b, c])).toEqual({ latest: b, previous: c, evidence: null });
		expect(pickRuns([a])).toEqual({ latest: a, previous: null, evidence: null });
	});
	it('keeps the newest run even when an older one is the nominated evidence, and names that one', () => {
		const old = meta('old', '2026-09-01T10:00:00Z', { evidence: 'current' });
		const past = meta('past', '2026-08-01T10:00:00Z', { evidence: 'past' });
		const now = meta('now', '2026-09-05T10:00:00Z');
		expect(pickRuns([now, old, past])).toEqual({ latest: now, previous: old, evidence: old });
		// The evidence run is the latest: no separate note.
		expect(pickRuns([old, past])?.evidence).toBeNull();
	});
	it('breaks a createdAt tie by list order (the API lists newest first)', () => {
		const x = meta('x', '2026-09-01T10:00:00Z');
		const y = meta('y', '2026-09-01T10:00:00Z');
		expect(pickRuns([x, y])?.latest.id).toBe('x');
	});
});

describe('ranAgo', () => {
	const tz = process.env.TZ;
	afterEach(() => {
		process.env.TZ = tz;
	});
	it('counts calendar days in the viewer’s time zone, not UTC', () => {
		// UTC+14: 23:30 UTC on the 22nd and 02:00 UTC on the 23rd are both the 23rd locally.
		process.env.TZ = 'Pacific/Kiritimati';
		expect(ranAgo('2026-09-22T23:30:00Z', new Date('2026-09-23T02:00:00Z'))).toBe('today');
		// UTC−11: 10:30 UTC on the 23rd is 23:30 on the 22nd locally, and 12:00 UTC is 01:00 on the 23rd.
		process.env.TZ = 'Pacific/Pago_Pago';
		expect(ranAgo('2026-09-23T10:30:00Z', new Date('2026-09-23T12:00:00Z'))).toBe('yesterday');
		expect(ranAgo('2026-09-23T10:30:00Z', new Date('2026-09-23T10:45:00Z'))).toBe('today');
	});
	it('reads longer gaps and never says "in the future"', () => {
		process.env.TZ = 'UTC';
		expect(ranAgo('2026-09-01T10:00:00Z', new Date('2026-09-13T10:00:00Z'))).toBe('12 days ago');
		expect(ranAgo('2026-09-02T10:00:00Z', new Date('2026-09-01T10:00:00Z'))).toBe('today');
		expect(ranAgo('not a date')).toBe('');
	});
});

describe('runDays', () => {
	it('counts both ends', () => {
		expect(runDays({ startDate: '2021-10-01', endDate: '2022-01-28' })).toBe(120);
		expect(runDays({ startDate: '2024-02-28', endDate: '2024-03-01' })).toBe(3);
	});
});

describe('historyDays and historyEnd (issue #51)', () => {
	it('count a forecast run’s days before its forecast, the days its summary covers; an ordinary run’s all', () => {
		const forecast = { startDate: '2016-10-01', endDate: '2022-10-19', forecastFrom: '2022-10-06' };
		expect(runDays(forecast)).toBe(2210);
		expect(historyDays(forecast)).toBe(2196);
		expect(historyEnd(forecast)).toBe('2022-10-05');
		const ordinary = { startDate: '2016-10-01', endDate: '2022-10-05', forecastFrom: null };
		expect(historyDays(ordinary)).toBe(2196);
		expect(historyEnd(ordinary)).toBe('2022-10-05');
	});

	it('give the EWR card’s denominator: X of the history’s days, not of the run to the forecast’s end', () => {
		const forecast = { startDate: '2016-10-01', endDate: '2022-10-19', forecastFrom: '2022-10-06' };
		const s = { catchment: { ewrDaysNotMet: 100, ewrFractionDaysNotMet: 100 / 2196 }, farms: [] } as unknown as RunSummary;
		expect(headlines(s, historyDays(forecast), null).find((h) => h.id === 'ewr')!.sub[0]).toBe(`100 of ${fmtNum(2196)} days at the outflow gauge`);
	});
});

describe('supplyFraction', () => {
	it('is supplied over demand across all farms, null without demand', () => {
		expect(supplyFraction(summary())).toBeCloseTo(0.8);
		expect(supplyFraction({ farms: [] })).toBeNull();
		expect(supplyFraction({ farms: [farm('Dry', 0, 0)] })).toBeNull();
	});
});

describe('headlines', () => {
	it('shows four cards: pragmatic EWR, supply, NSE and outflow, without changes when there is no previous run', () => {
		const hs = headlines(summary(), 120, null);
		expect(hs.map((h) => h.id)).toEqual(['ewr', 'supply', 'nse', 'outflow']);
		expect(card(hs, 'ewr')).toMatchObject({
			term: 'EWR not met',
			value: '10.0%',
			unit: 'of days',
			sub: ['12 of 120 days at the outflow gauge'],
			flagged: true,
			delta: null
		});
		expect(card(hs, 'supply')).toMatchObject({ value: '80.0%', sub: ['1 of 2 hydrological units below 95%'], flagged: true });
		expect(card(hs, 'nse')).toMatchObject({ term: 'Calibration NSE', value: '0.62', sub: ['90 days observed', 'calibration period (in-sample)'] });
		// In-sample only when the parameters were fitted on these days (issue #45).
		const handSet = headlines(summary({ calibration: { ...summary().calibration!, fitStatus: 'notFitted' } }), 120, null);
		expect(card(handSet, 'nse').sub).toEqual(['90 days observed', 'calibration period (parameters not fitted)']);
		expect(card(hs, 'outflow')).toMatchObject({ value: '0.500', unit: 'm³/s', sub: ['50% of natural'] });
		expect(hs.every((h) => h.delta === null)).toBe(true);
	});

	it('shows a small mean outflow to two significant figures, not 0.000 (issue #45)', () => {
		const s = summary();
		const hs = headlines({ ...s, catchment: { ...s.catchment, meanSimulatedOutflowM3Day: 36.288 } }, 120, null);
		expect(card(hs, 'outflow')).toMatchObject({ value: '0.00042', unit: 'm³/s' });
	});

	it('headlines the Reserve rule table when the run has one, as the Runs tab does', () => {
		const hs = headlines(summary({ ewrAssurance: [site('g2', 3, 4), site(null, 18, 24, 3)] }), 120, null);
		expect(hs.map((h) => h.id)).toEqual(['reserve', 'supply', 'nse', 'outflow']);
		expect(card(hs, 'reserve')).toMatchObject({
			term: 'Reserve rules met',
			value: '75.0%',
			unit: 'of months',
			sub: ['18 of 24 months at the outlet', 'up to 3 in a row not met'],
			flagged: true
		});
	});

	it('gives each card its change from the previous run, with the direction that counts as better', () => {
		const prev = summary({
			farms: [farm('Upper', 100, 100), farm('Lower', 100, 40)],
			catchment: { meanNaturalFlowM3Day: 86_400, meanSimulatedOutflowM3Day: 86_400, ewrDaysNotMet: 24, ewrFractionDaysNotMet: 0.2 },
			calibration: { days: 90, nse: 0.5, pbias: 4, rmseM3s: 0.1, meanObservedM3s: 0.2, meanSimulatedM3s: 0.21 }
		});
		const hs = headlines(summary(), 120, prev);
		expect(card(hs, 'ewr').delta?.delta).toBeCloseTo(-0.1);
		expect(card(hs, 'ewr').spec.better).toBe('lower');
		expect(card(hs, 'supply').delta?.delta).toBeCloseTo(0.1);
		expect(card(hs, 'supply').spec.better).toBe('higher');
		expect(card(hs, 'nse').delta?.delta).toBeCloseTo(0.12);
		expect(card(hs, 'outflow').delta?.delta).toBeCloseTo(-0.5);
		expect(card(hs, 'outflow').spec.better).toBe('neutral');
	});

	it('leaves a change out when the two runs don’t both have the figure', () => {
		const uncalibrated = summary({ calibration: null, farms: [] });
		// Current run without calibration or farms: no NSE or supply change.
		const hs = headlines(uncalibrated, 120, summary());
		expect(card(hs, 'nse')).toMatchObject({ term: 'Calibration', value: '–', sub: ['no observed flow in the run'], delta: null });
		expect(card(hs, 'supply')).toMatchObject({ value: '–', sub: ['no hydrological units in the run'], delta: null });
		// Previous run without calibration: none either.
		expect(card(headlines(summary(), 120, summary({ calibration: { days: 0 } as RunSummary['calibration'] })), 'nse').delta).toBeNull();
	});

	it('compares the Reserve only at the same site, and the pragmatic EWR only between two pragmatic headlines', () => {
		const here = summary({ ewrAssurance: [site(null, 18, 24)] });
		expect(card(headlines(here, 120, summary({ ewrAssurance: [site(null, 12, 24)] })), 'reserve').delta?.delta).toBeCloseTo(0.25);
		expect(card(headlines(here, 120, summary({ ewrAssurance: [site('g2', 12, 24)] })), 'reserve').delta).toBeNull();
		expect(card(headlines(here, 120, summary()), 'reserve').delta).toBeNull();
		expect(card(headlines(summary(), 120, here), 'ewr').delta).toBeNull();
	});

	it('does not flag a clean run', () => {
		const clean = summary({
			farms: [farm('Upper', 100, 100)],
			catchment: { meanNaturalFlowM3Day: 0, meanSimulatedOutflowM3Day: 0, ewrDaysNotMet: 0, ewrFractionDaysNotMet: 0 }
		});
		const hs = headlines(clean, 120, null);
		expect(hs.some((h) => h.flagged)).toBe(false);
		expect(card(hs, 'supply').sub).toEqual(['all hydrological units ≥ 95%']);
		expect(card(hs, 'outflow').sub).toEqual([]);
	});
});

describe('damsHeadline', () => {
	const today = (pct: number, change: number | null, dams = 2) => ({ state: 'ready' as const, today: { pct, change, dams, endDate: '2022-01-28' } });

	it('shows all dams’ fill at the end of the run and its change over the last 30 days', () => {
		const h = damsHeadline(today(64, -11));
		expect(h).toMatchObject({ id: 'dams', term: 'Dams today', value: '64%', unit: 'full', sub: ['2 dams on 28 Jan 2022'], flagged: false, deltaLabel: 'in 30 days' });
		expect(h.delta?.delta).toBeCloseTo(-0.11);
		expect(h.spec).toMatchObject({ format: 'fraction', better: 'higher' });
	});

	it('flags dams below the low line, and has no change when the run is too short', () => {
		const h = damsHeadline(today(LOW_PCT - 5, null, 1));
		expect(h).toMatchObject({ flagged: true, sub: [`1 dam on 28 Jan 2022, below ${LOW_PCT}%`], delta: null });
	});

	it('says so while loading, on an error, and without dams', () => {
		expect(damsHeadline({ state: 'loading' })).toMatchObject({ value: '…', sub: ['loading dam levels'], delta: null });
		expect(damsHeadline({ state: 'error' })).toMatchObject({ value: '–', sub: ['dam levels couldn’t be loaded'] });
		expect(damsHeadline({ state: 'none' })).toMatchObject({ value: '–', sub: ['no dams in the run'], flagged: false });
		// In every state the card leads to the Dams page.
		for (const d of [{ state: 'loading' }, { state: 'none' }, today(64, -11)] as const) expect(damsHeadline(d).href).toBe('?tab=dams');
	});
});
