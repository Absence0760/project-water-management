// The portfolio's traffic light (D11), its unknown reasons, and how a row is
// shaped from what the query read (WP-2.14, docs/api.md § Portfolio).
import { afterEach, describe, expect, it } from 'vitest';
import { EWR_TRAFFIC_LIGHT } from '@water-management/engine';
import { toPortfolioProject, type PortfolioRow } from './portfolio.js';
import { ageDays, EWR_THRESHOLDS, ewrFigure, ewrStatus, isStale } from './status.js';

// Rule 7: the server's own zone never changes a day; only the zone passed in does.
const tz = process.env.TZ;
afterEach(() => {
	process.env.TZ = tz;
});

describe('ewrStatus', () => {
	it('uses the engine’s traffic light, the bands the workspace’s EWR compliance by month draws', () => {
		expect(EWR_THRESHOLDS).toBe(EWR_TRAFFIC_LIGHT);
	});

	it('green below 5 %, amber below 20 %, red from 20 % (of 30 days: 1 green, 2–5 amber, 6+ red)', () => {
		expect(EWR_THRESHOLDS).toEqual({ green: 5, amber: 20 });
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
	it('takes a team’s thresholds, in percent', () => {
		const t = { green: 20, amber: 50 };
		expect(ewrStatus(3, 30, t)).toBe('green'); // 10 %
		expect(ewrStatus(6, 30, t)).toBe('amber'); // exactly 20 %
		expect(ewrStatus(14, 30, t)).toBe('amber');
		expect(ewrStatus(15, 30, t)).toBe('red'); // exactly 50 %
	});
	it('a boundary that division would round is still exact (7 of 100 days is 7 %, not above it)', () => {
		expect(7 / 100 * 100).toBeGreaterThan(7); // the float trap the cross-multiplication avoids
		expect(ewrStatus(7, 100, { green: 7.5, amber: 8 })).toBe('green');
		expect(ewrStatus(7, 100, { green: 7, amber: 8 })).toBe('amber');
		expect(ewrStatus(7, 100, { green: 1, amber: 7 })).toBe('red');
	});
	it('the extremes: green 0 is never green, amber 100 is red only when every day failed', () => {
		const t = { green: 0, amber: 100 };
		expect(ewrStatus(0, 30, t)).toBe('amber');
		expect(ewrStatus(29, 30, t)).toBe('amber');
		expect(ewrStatus(30, 30, t)).toBe('red');
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
	it('judges by the thresholds it is given, the defaults otherwise', () => {
		const input = { hasFigures: true, ewrSet: true, daysNotMet: 9, days: 30 };
		expect(ewrFigure(input, { green: 10, amber: 40 }).status).toBe('amber');
		expect(ewrFigure(input, { green: 31, amber: 40 }).status).toBe('green');
		expect(ewrFigure(input).status).toBe('red');
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
	time_zone: 'Africa/Johannesburg',
	team_settings: null,
	data_until: '2026-09-24',
	last_run_at: new Date('2026-09-25T06:00:00Z'),
	last_run_id: 'run-latest',
	pub_run_id: 'run-published',
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
	alerts_firing: 0,
	feeds: [],
	...over
});

describe('toPortfolioProject', () => {
	// 12:00 SAST on 26 September.
	const today = new Date('2026-09-26T10:00:00Z');

	it('a published project reads everything from the publication', () => {
		expect(toPortfolioProject(row(), today)).toEqual({
			id: 'p1',
			name: 'Alpha',
			role: 'viewer',
			timeZone: 'Africa/Johannesburg',
			today: '2026-09-26',
			dataUntil: '2026-09-24',
			lastRunAt: '2026-09-25T06:00:00.000Z',
			publishedAt: '2026-09-25T07:00:00.000Z',
			source: 'published',
			sourceRunId: 'run-published',
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
			alertsFiring: 0,
			restriction: { level: 'advisory', pct: 12.5 }
		});
	});

	it('passes the team’s thresholds to the status (3 of 30 days: amber by default, green under 20 / 50)', () => {
		expect(toPortfolioProject(row(), today).ewr.status).toBe('amber');
		expect(toPortfolioProject(row(), today, { green: 20, amber: 50 }).ewr.status).toBe('green');
		expect(toPortfolioProject(row(), today, { green: 1, amber: 5 }).ewr.status).toBe('red');
		// The run-only path takes them too.
		const runOnly = row({ published_at: null, run_days30: 30, run_not_met30: 3 });
		expect(toPortfolioProject(runOnly, today, { green: 20, amber: 50 }).ewr.status).toBe('green');
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
			sourceRunId: 'run-latest',
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
		const feed = { source: 'dws' as const, config: { station: 'X0H000' }, enabled: true, createdAt: '2026-09-01T00:00:00', updatedAt: '2026-09-01T00:00:00Z', lastError: null };
		const p = toPortfolioProject(
			row({
				feeds: [
					{ ...feed, lastAttemptAt: '2026-09-26T01:00:00Z', lastSuccessAt: '2026-09-26T01:00:00Z', lastDataDate: '2026-09-25', consecutiveFailures: 0 },
					{ ...feed, lastAttemptAt: '2026-09-26T01:00:00Z', lastSuccessAt: null, lastDataDate: null, consecutiveFailures: 2 },
					{ ...feed, lastAttemptAt: '2026-09-26T01:00:00Z', lastSuccessAt: '2026-09-26T01:00:00Z', lastDataDate: '2026-01-01', consecutiveFailures: 0 },
					{ ...feed, enabled: false, lastAttemptAt: null, lastSuccessAt: null, lastDataDate: null, consecutiveFailures: 0 }
				]
			}),
			today
		);
		expect(p.feeds).toEqual({ total: 4, ok: 1, failing: 2 });
	});

	// Each row counts to its own project's today (project.time_zone, 058), never
	// UTC's or the server's: at 23:30 UTC it is already the next day in South
	// Africa. Under skewed server zones (rule 7).
	it.each(['UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'])('counts ages to the project’s own day, whatever the server’s zone (TZ %s)', (zone) => {
		process.env.TZ = zone;
		const late = new Date('2026-09-25T23:30:00Z'); // 01:30 SAST on the 26th
		const sa = toPortfolioProject(row({ pub_until: '2026-09-18' }), late);
		expect(sa).toMatchObject({ timeZone: 'Africa/Johannesburg', today: '2026-09-26', figuresAgeDays: 8, stale: true });
		// Positive control: the same row in a UTC project is still on the 25th, 7 days old, not stale.
		const utc = toPortfolioProject(row({ pub_until: '2026-09-18', time_zone: 'UTC' }), late);
		expect(utc).toMatchObject({ timeZone: 'UTC', today: '2026-09-25', figuresAgeDays: 7, stale: false });
		// A feed's newest day is judged against the same local day (a CHIRPS feed is stale past 12 days).
		const feed = { source: 'chirps' as const, config: { cells: [{ lat: -30, lon: 20, weight: 1 }] }, enabled: true, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', lastError: null, lastAttemptAt: '2026-09-25T06:00:00Z', lastSuccessAt: '2026-09-25T06:00:00Z', lastDataDate: '2026-09-13', consecutiveFailures: 0 };
		expect(toPortfolioProject(row({ feeds: [feed] }), late).feeds).toEqual({ total: 1, ok: 0, failing: 1 });
		expect(toPortfolioProject(row({ feeds: [feed], time_zone: 'UTC' }), late).feeds).toEqual({ total: 1, ok: 1, failing: 0 });
	});
});
