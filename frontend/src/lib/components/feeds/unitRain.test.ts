// Settings → Data feeds → Rain for each unit (issue #482): the proposal in
// words, the button, the product and start-date checks, and the calls. The
// browser flow is pinned by e2e/tests/unit-rain.spec.ts.
import { describe, expect, it, vi } from 'vitest';
import type { UnitRainProposal, UnitRainProposalUnit } from '$lib/api/types';
import { feedsApi, type FeedHealth } from './feeds';
import { appliedWords, feedLimitNote, MAX_FEEDS, sortUnitRows, UNIT_RAIN_DEFAULT_PRODUCT, unitRainAction, unitRainBody, unitRainRows, unitRainUpToDate } from './unitRain';

const unit = (over: Partial<UnitRainProposalUnit> = {}): UnitRainProposalUnit => ({
	nodeId: 'u1',
	name: 'Upper unit',
	featureId: 'f1',
	areaKm2: 12.5,
	cells: [
		{ lat: -20.125, lon: 25.125, share: 1, weight: 0.5 },
		{ lat: -20.175, lon: 25.125, share: 0.5, weight: 0.25 }
	],
	feedId: null,
	seriesDays: 0,
	action: over.feedId ? 'update' : 'create',
	...over
});
const proposal = (units: UnitRainProposalUnit[], product: UnitRainProposal['product'] = 'rnl'): UnitRainProposal => ({ product, units, withoutPolygon: [], refused: [], canApply: true });
const ok: FeedHealth = { state: 'ok', stale: false, staleAfterDays: 7, reason: { code: 'ok', newest: '2026-09-30', checked: '2026-10-01' } };

describe('unitRainRows', () => {
	it('counts each unit’s cells and how much of their area lies inside the parcel, area weighted', () => {
		const [r] = unitRainRows(proposal([unit()]), []);
		expect(r!.cells).toBe(2);
		// cos −20.125° ≈ cos −20.175°: the mean of 100 % and 50 %, to the percent.
		expect(r!.cellsText).toBe('2 cells, 75 % of their area inside');
		expect(r!.feed).toBeNull();
		expect(unitRainRows(proposal([unit({ cells: [{ lat: -20.1, lon: 25.1, share: 0.4, weight: 1 }] })]), [])[0]!.cellsText).toBe('1 cell, 40 % of their area inside');
		expect(unitRainRows(proposal([unit({ cells: [] })]), [])[0]!.cellsText).toBe('0 cells');
	});

	it('reads each unit feed’s state from the feeds list, and says when the list doesn’t hold it yet', () => {
		const rows = unitRainRows(proposal([unit({ feedId: 'a', seriesDays: 30 }), unit({ nodeId: 'u2', feedId: 'gone' })]), [{ id: 'a', health: ok }]);
		expect(rows[0]!.feed).toEqual({ id: 'a', state: 'ok', label: 'OK', health: 'OK; newest data 30 Sep 2026, checked 1 Oct 2026.' });
		expect(rows[0]!.seriesDays).toBe(30);
		expect(rows[1]!.feed).toMatchObject({ id: 'gone', state: 'pending', label: 'Waiting' });
		expect(rows[1]!.feed!.health).toMatch(/refresh the status/);
	});
});

describe('sortUnitRows', () => {
	it('puts the units without a feed first, then failing and stale feeds, keeping the server’s order otherwise', () => {
		const health = (state: FeedHealth['state']): FeedHealth => ({ ...ok, state });
		const rows = unitRainRows(
			proposal([
				unit({ nodeId: 'a', name: 'A', feedId: 'fa' }),
				unit({ nodeId: 'b', name: 'B', feedId: 'fb' }),
				unit({ nodeId: 'c', name: 'C' }),
				unit({ nodeId: 'd', name: 'D', feedId: 'fd' })
			]),
			[
				{ id: 'fa', health: health('ok') },
				{ id: 'fb', health: health('stale') },
				{ id: 'fd', health: health('failing') }
			]
		);
		expect(sortUnitRows(rows).map((r) => r.name)).toEqual(['C', 'D', 'B', 'A']);
	});
});

describe('unitRainAction', () => {
	it('creates the missing feeds, updates the empty ones, or both, from each unit’s action', () => {
		expect(unitRainAction(proposal([]))).toBeNull();
		expect(unitRainAction(proposal([unit()]))!.label).toBe('Create the feed');
		expect(unitRainAction(proposal([unit(), unit({ nodeId: 'u2' })]))).toEqual({ label: 'Create 2 feeds', words: 'Creates 2 CHIRPS feeds, one into each unit’s own rain series.' });
		expect(unitRainAction(proposal([unit({ feedId: 'a' })]))!.label).toBe('Update the feed');
		expect(unitRainAction(proposal([unit({ feedId: 'a' })]))!.words).toMatch(/^Gives the unit’s feed the cells of its parcel as it is now, and the product; .* nothing is spliced\.$/);
		expect(unitRainAction(proposal([unit({ feedId: 'a' }), unit({ nodeId: 'u2', feedId: 'b' })]))!.label).toBe('Update 2 feeds');
		const both = unitRainAction(proposal([unit({ feedId: 'a' }), unit({ nodeId: 'u2' }), unit({ nodeId: 'u3' })]))!;
		expect(both.label).toBe('Create 2, update 1');
		expect(both.words).toBe('Creates 2 CHIRPS feeds for the units without one, and gives 1 empty feed the cells of their parcels as they are now, and the product.');
	});

	it('offers nothing when every unit’s feed already reads its parcel, and says it is up to date', () => {
		const p = proposal([unit({ feedId: 'a', action: 'none' }), unit({ nodeId: 'u2', feedId: 'b', action: 'none' })]);
		expect(unitRainAction(p)).toBeNull();
		expect(unitRainUpToDate(p)).toBe(true);
		expect(unitRainUpToDate(proposal([]))).toBe(false);
		expect(unitRainAction(proposal([unit({ feedId: 'a', action: 'none' }), unit({ nodeId: 'u2' })]))!.label).toBe('Create the feed');
	});
});

describe('unitRainBody', () => {
	it('defaults to rnl, and sends the start date and units only when given', () => {
		expect(UNIT_RAIN_DEFAULT_PRODUCT).toBe('rnl');
		expect(unitRainBody('rnl', '')).toEqual({ body: { product: 'rnl' } });
		expect(unitRainBody('sat', ' 2001-01-01 ', ['u1'])).toEqual({ body: { product: 'sat', startDate: '2001-01-01', nodeIds: ['u1'] } });
	});

	it('refuses a start date that isn’t a day or comes before the product’s first day', () => {
		expect(unitRainBody('rnl', '2001-13-45')).toEqual({ error: 'The start date should be a day, YYYY-MM-DD.' });
		expect(unitRainBody('rnl', '1/1/2001')).toEqual({ error: 'The start date should be a day, YYYY-MM-DD.' });
		expect(unitRainBody('rnl', '2001-02-30')).toEqual({ error: 'The start date should be a day, YYYY-MM-DD.' });
		expect(unitRainBody('sat', '1990-01-01')).toEqual({ error: 'The sat product begins on 1998-01-01. For earlier days choose rnl, which reads 1981 onwards.' });
		expect(unitRainBody('rnl', '1980-12-31')).toEqual({ error: 'CHIRPS begins on 1981-01-01.' });
		expect(unitRainBody('rnl', '1981-01-01')).toEqual({ body: { product: 'rnl', startDate: '1981-01-01' } });
	});
});

describe('unitRainBody under a skewed time zone (CLAUDE.md rule 7)', () => {
	it('takes the same days far east and far west of UTC', () => {
		const tz = process.env.TZ;
		try {
			for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
				process.env.TZ = zone;
				expect(unitRainBody('rnl', '1981-01-01')).toEqual({ body: { product: 'rnl', startDate: '1981-01-01' } });
				expect(unitRainBody('sat', '1998-01-01')).toEqual({ body: { product: 'sat', startDate: '1998-01-01' } });
				expect(unitRainBody('rnl', '2024-02-29')).toEqual({ body: { product: 'rnl', startDate: '2024-02-29' } });
				expect('error' in unitRainBody('rnl', '2023-02-29')).toBe(true);
			}
		} finally {
			process.env.TZ = tz;
		}
	});
});

describe('feedLimitNote', () => {
	it('says plainly when the new unit feeds would pass the 20-feed cap, and is silent within it', () => {
		const three = proposal([unit(), unit({ nodeId: 'u2' }), unit({ nodeId: 'u3', feedId: 'x', action: 'none' })]);
		expect(MAX_FEEDS).toBe(20);
		expect(feedLimitNote(three, 18)).toBeNull();
		expect(feedLimitNote(three, 19)).toBe(
			'A project can have at most 20 feeds, the catchment’s included. It has 19 feeds, and this would add 2, so it is refused as it stands: there is room for 1 more. Remove feeds the project no longer needs first.'
		);
		expect(feedLimitNote(proposal([unit({ feedId: 'x', action: 'update' })]), 20)).toBeNull();
	});
});

describe('appliedWords', () => {
	it('says what the POST did', () => {
		expect(appliedWords({ created: 3, updated: 1 })).toBe('Created 3 feeds and updated 1 feed. They run on the next schedule, or now with “Run now” on each feed.');
		expect(appliedWords({ created: 0, updated: 2 })).toMatch(/^Updated 2 feeds\./);
		expect(appliedWords({ created: 0, updated: 0 })).toBe('Nothing to change: every unit’s feed already reads its parcel.');
		expect(appliedWords({ created: 1, updated: 0, skipped: [{ nodeId: 'x', name: 'X', reason: 'no parcel' }, { nodeId: 'y', name: 'Y', reason: 'no parcel' }] })).toMatch(/^Created 1 feed\. .* 2 units left out: see below\.$/);
	});
});

describe('feedsApi from-units calls', () => {
	it('reads the proposal and posts the body to …/feeds/chirps/from-units', async () => {
		const request = vi.fn().mockResolvedValue({});
		const f = feedsApi({ request } as never, 'p/1');
		await f.unitsProposal();
		await f.unitsProposal('sat');
		await f.applyUnits({ product: 'rnl', nodeIds: ['u1'] });
		expect(request.mock.calls).toEqual([
			['GET', '/projects/p%2F1/feeds/chirps/from-units'],
			['GET', '/projects/p%2F1/feeds/chirps/from-units?product=sat'],
			['POST', '/projects/p%2F1/feeds/chirps/from-units', { product: 'rnl', nodeIds: ['u1'] }]
		]);
	});
});
