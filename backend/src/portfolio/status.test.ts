// The portfolio's traffic light (D11), its unknown reasons, and how a row is
// shaped from what the query read (WP-2.14, docs/api.md § Portfolio).
import { afterEach, describe, expect, it } from 'vitest';
import { toPortfolioProject, type PortfolioRow } from './portfolio.js';
import { ageDays, EWR_THRESHOLDS, ewrFigure, ewrStatus, isStale } from './status.js';

// Rule 7: dates judged in a zone far from UTC must still count UTC days.
const tz = process.env.TZ;
afterEach(() => {
	process.env.TZ = tz;
});

describe('ewrStatus', () => {
	it('green below 5 %, amber below 20 %, red from 20 % (of 30 days: 1 green, 2–5 amber, 6+ red)', () => {
		expect(EWR_THRESHOLDS).toEqual({ amber: 0.05, red: 0.2 });
		expect(ewrStatus(0, 30)).toBe('green');
		expect(ewrStatus(1, 30)).toBe('green'); // 3.3 %
		expect(ewrStatus(2, 30)).toBe('amber'); // 6.7 %
		expect(ewrStatus(5, 30)).toBe('amber'); // 16.7 %
		expect(ewrStatus(6, 30)).toBe('red'); // exactly 20 %
		expect(ewrStatus(30, 30)).toBe('red');
	});
	it('the boundaries are exclusive below: exactly 5 % is amber', () => {
		expect(ewrStatus(1, 20)).toBe('amber');
		expect(ewrStatus(4, 20)).toBe('red');
	});
	it('an empty or impossible window has no status, never green', () => {
		expect(ewrStatus(0, 0)).toBeNull();
		expect(ewrStatus(-1, 30)).toBeNull();
		expect(ewrStatus(31, 30)).toBeNull();
		expect(ewrStatus(Number.NaN, 30)).toBeNull();
	});
	it('takes other thresholds', () => {
		expect(ewrStatus(3, 30, { amber: 0.2, red: 0.5 })).toBe('green');
	});
});

describe('ewrFigure', () => {
	it('says why it is unknown, in order: no figures, no EWR set, no series', () => {
		expect(ewrFigure({ hasFigures: false, ewrSet: true, daysNotMet: 0, days: 30 })).toMatchObject({ status: 'unknown', reason: 'no-figures' });
		expect(ewrFigure({ hasFigures: true, ewrSet: false, daysNotMet: 0, days: 30 })).toMatchObject({ status: 'unknown', reason: 'no-ewr' });
		expect(ewrFigure({ hasFigures: true, ewrSet: true, daysNotMet: null, days: 30 })).toMatchObject({ status: 'unknown', reason: 'no-series' });
		expect(ewrFigure({ hasFigures: true, ewrSet: true, daysNotMet: 0, days: 0 })).toMatchObject({ status: 'unknown', reason: 'no-series' });
	});
	it('a known figure carries its counts and fraction, and no reason', () => {
		expect(ewrFigure({ hasFigures: true, ewrSet: true, daysNotMet: 9, days: 30 })).toEqual({ status: 'red', daysNotMet30: 9, days30: 30, fraction30: 0.3 });
	});
});

describe('age and staleness', () => {
	it.each(['UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'])('counts whole UTC days (TZ %s)', (zone) => {
		process.env.TZ = zone;
		expect(ageDays('2026-09-19', '2026-09-26')).toBe(7);
		expect(isStale('2026-09-19', '2026-09-26')).toBe(false);
		expect(isStale('2026-09-18', '2026-09-26')).toBe(true);
		expect(isStale(null, '2026-09-26')).toBe(false);
	});
});

const row = (over: Partial<PortfolioRow> = {}): PortfolioRow => ({
	id: 'p1',
	name: 'Alpha',
	role: 'viewer',
	data_until: '2026-09-24',
	last_run_at: new Date('2026-09-25T06:00:00Z'),
	newer_run: false,
	published_at: new Date('2026-09-25T07:00:00Z'),
	restriction_level: 'advisory',
	restriction_pct: '12.50',
	pub_until: '2026-09-24',
	pub_days30: 30,
	pub_not_met30: 3,
	pub_ewr_set: true,
	pub_farm_count: 12,
	pub_recent: { to: '2026-09-24', from7: '2026-09-18', from30: '2026-08-26', farmsShort7: 2, farmsShort30: 5 },
	dam_name: 'Kareebos',
	dam_pct: 0.18,
	run_until: '2026-09-24',
	run_ewr_set: true,
	run_days30: null,
	run_not_met30: null,
	live_farm_count: 13,
	feeds: [],
	...over
});

describe('toPortfolioProject', () => {
	const today = '2026-09-26';

	it('a published project reads everything from the publication', () => {
		expect(toPortfolioProject(row(), today)).toEqual({
			id: 'p1',
			name: 'Alpha',
			role: 'viewer',
			dataUntil: '2026-09-24',
			lastRunAt: '2026-09-25T06:00:00.000Z',
			publishedAt: '2026-09-25T07:00:00.000Z',
			source: 'published',
			figuresUntil: '2026-09-24',
			figuresAgeDays: 2,
			stale: false,
			behindData: false,
			newerRun: false,
			ewr: { status: 'amber', daysNotMet30: 3, days30: 30, fraction30: 0.1 },
			farmsShort7: 2,
			farmsShort30: 5,
			farmCount: 12,
			lowestDamPct: { nodeName: 'Kareebos', pct: 0.18 },
			damsKnown: true,
			feeds: { total: 0, ok: 0, failing: 0 },
			alertsFiring: null,
			restriction: { level: 'advisory', pct: 12.5 }
		});
	});

	it('a publication from before the farm counts existed leaves them unknown, not zero', () => {
		const p = toPortfolioProject(row({ pub_recent: null }), today);
		expect(p.farmsShort7).toBeNull();
		expect(p.farmsShort30).toBeNull();
	});

	it('a published project with no dams knows it has none', () => {
		const p = toPortfolioProject(row({ dam_name: null, dam_pct: null }), today);
		expect(p).toMatchObject({ lowestDamPct: null, damsKnown: true });
	});

	it('without a publication, the run gives the EWR only; farms and dams stay unknown', () => {
		const p = toPortfolioProject(
			row({ published_at: null, restriction_level: null, restriction_pct: null, pub_until: null, pub_recent: null, dam_name: null, dam_pct: null, run_days30: 30, run_not_met30: 0, run_until: '2026-09-10' }),
			today
		);
		expect(p).toMatchObject({
			source: 'run',
			figuresUntil: '2026-09-10',
			figuresAgeDays: 16,
			stale: true,
			behindData: true,
			ewr: { status: 'green', daysNotMet30: 0, days30: 30, fraction30: 0 },
			farmsShort7: null,
			farmsShort30: null,
			farmCount: 13,
			lowestDamPct: null,
			damsKnown: false,
			restriction: null,
			newerRun: false
		});
	});

	it('a run whose outlet series is missing is unknown (no-series)', () => {
		const p = toPortfolioProject(row({ published_at: null, run_days30: 0, run_not_met30: 0 }), today);
		expect(p.ewr).toMatchObject({ status: 'unknown', reason: 'no-series' });
	});

	it('newerRun only means something beside a publication', () => {
		expect(toPortfolioProject(row({ newer_run: true }), today).newerRun).toBe(true);
		expect(toPortfolioProject(row({ newer_run: true, published_at: null }), today).newerRun).toBe(false);
	});

	it('feeds: ok counts as healthy, failing and stale as failing, pending and disabled as neither', () => {
		const feed = { source: 'dws' as const, config: { station: 'X0H000' }, enabled: true, createdAt: '2026-09-01T00:00:00', updatedAt: '2026-09-01T00:00:00', lastError: null };
		const p = toPortfolioProject(
			row({
				feeds: [
					{ ...feed, lastAttemptAt: '2026-09-26T01:00:00', lastSuccessAt: '2026-09-26T01:00:00', lastDataDate: '2026-09-25', consecutiveFailures: 0 },
					{ ...feed, lastAttemptAt: '2026-09-26T01:00:00', lastSuccessAt: null, lastDataDate: null, consecutiveFailures: 2 },
					{ ...feed, lastAttemptAt: '2026-09-26T01:00:00', lastSuccessAt: '2026-09-26T01:00:00', lastDataDate: '2026-01-01', consecutiveFailures: 0 },
					{ ...feed, enabled: false, lastAttemptAt: null, lastSuccessAt: null, lastDataDate: null, consecutiveFailures: 0 }
				]
			}),
			today
		);
		expect(p.feeds).toEqual({ total: 4, ok: 1, failing: 2 });
	});
});
