// C3S's seasonal forecast credit (issue #620): Copernicus's notice, the
// dataset's citation and the contributing centres, word for word as
// docs/data-sources.md § c3s-seasonal quotes them and as the ingest writes
// them into the copy's arrays (ingest/c3s_seasonal.py, ingest/c3srequest.py).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	AGERA5_CITATION,
	C3S_CENTRES,
	C3S_SEASONAL_CITATION,
	c3sSeasonalCredit,
	copernicusAgera5Notice,
	copernicusC3sNotice,
	copernicusEra5lNotice,
	et0ProductsOf,
	et0ProductsRead,
	NASA_POWER_ET0_CREDIT,
	rainCredits,
	runRainCredits
} from './rainCredits';

const read = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');
const flat = (s: string) => s.replace(/\s+/g, ' ').replace(/ ?> /g, ' ');

describe('the C3S seasonal forecast credit (issue #620)', () => {
	it('quotes docs/data-sources.md word for word', () => {
		const sources = flat(read('docs/data-sources.md'));
		expect(sources).toContain(`"${C3S_SEASONAL_CITATION}"`);
		expect(sources).toContain(copernicusC3sNotice('[year]'));
		for (const name of Object.values(C3S_CENTRES)) expect(sources, name).toContain(name);
	});

	it('says what the ingest writes into the arrays', () => {
		const job = flat(read('ingest/c3s_seasonal.py')).replace(/" "/g, '');
		expect(job).toContain(C3S_SEASONAL_CITATION);
		expect(job).toContain(copernicusC3sNotice('[year]'));
		const req = read('ingest/c3srequest.py');
		for (const [id, name] of Object.entries(C3S_CENTRES)) expect(req, id).toContain(`"${id}": "${name}"`);
	});

	it('is Copernicus’s notice with the year read, the citation, then each centre once in the systems’ order', () => {
		expect(copernicusC3sNotice(2026)).toBe(copernicusEra5lNotice(2026));
		const lines = c3sSeasonalCredit(['ecmwf-51', 'eccc-4', 'eccc-5', 'jma-3'], '2026-10-28');
		expect(lines).toEqual([
			copernicusEra5lNotice('2026'),
			C3S_SEASONAL_CITATION,
			'Contributing centres: European Centre for Medium-Range Weather Forecasts (ECMWF); Environment and Climate Change Canada (ECCC); Japan Meteorological Agency (JMA).'
		]);
		// A centre the table doesn't know yet is still credited, by its id; no systems, no centres line.
		expect(c3sSeasonalCredit(['kma-1'], '2027-01-01')[2]).toBe('Contributing centres: kma.');
		expect(c3sSeasonalCredit(['toString-1'], '2027-01-01')[2]).toBe('Contributing centres: toString.');
		expect(c3sSeasonalCredit([], '2027-01-01')).toHaveLength(2);
	});
});

describe('the reference ET credits (issue #604 R5-E)', () => {
	it('quote docs/data-sources.md § agera5 and § nasa-power word for word, and match what the ingest writes into the arrays', () => {
		const sources = flat(read('docs/data-sources.md'));
		expect(sources).toContain(copernicusAgera5Notice('[year]'));
		expect(sources).toContain(`"${AGERA5_CITATION}"`);
		expect(sources).toContain(`"${NASA_POWER_ET0_CREDIT}"`);
		const agera5 = flat(read('ingest/agera5.py')).replace(/" "/g, '');
		expect(agera5).toContain(`${copernicusAgera5Notice('[year]')} ${AGERA5_CITATION}`);
		expect(read('ingest/nasapower.py')).toContain(`ATTRIBUTION = "${NASA_POWER_ET0_CREDIT}"`);
	});

	it('come after the rain products’, each once, with the year read in Copernicus’s line', () => {
		const c = rainCredits({ power: true, agera5: true, era5l: true }, '2026-10-30');
		expect(c.map((x) => x.product)).toEqual(['era5l', 'agera5_et0', 'power_et0']);
		expect(c[1]!.lines).toEqual([copernicusAgera5Notice('2026'), AGERA5_CITATION]);
		expect(c[2]!.lines).toEqual([NASA_POWER_ET0_CREDIT]);
	});

	it('take a stored run’s et0Products, ignoring anything else stored there', () => {
		expect(runRainCredits({ summary: {}, et0Products: ['power_et0'] }, '2026-10-30').map((c) => c.product)).toEqual(['power_et0']);
		expect(et0ProductsOf(['power_et0', 'x', 'agera5_et0', 'power_et0'])).toEqual(['agera5_et0', 'power_et0']);
		for (const bad of [null, 'agera5_et0', { agera5_et0: true }, undefined]) expect(et0ProductsOf(bad)).toEqual([]);
		expect(runRainCredits({ summary: {}, et0Products: 'agera5_et0' }, '2026-10-30')).toEqual([]);
	});

	describe('et0ProductsRead: the feed’s days the run read, split where AgERA5’s copy ends', () => {
		const used = (first: string, last: string) => ({ used: true, dailyDays: 10, first, last });
		const feed = { days: [['2026-01-01', '2026-09-30'], ['2026-10-05', '2026-10-25']] as [string, string][], agera5Through: '2026-09-30' };

		it('credits AgERA5 for days on or before agera5Through and NASA POWER for days after', () => {
			expect(et0ProductsRead(feed, used('2025-01-01', '2026-10-28'))).toEqual(['agera5_et0', 'power_et0']);
			expect(et0ProductsRead(feed, used('2025-01-01', '2026-09-30'))).toEqual(['agera5_et0']);
			expect(et0ProductsRead(feed, used('2026-10-01', '2026-10-28'))).toEqual(['power_et0']);
			// The boundary day itself is AgERA5's.
			expect(et0ProductsRead({ ...feed, agera5Through: '2026-10-05' }, used('2026-10-05', '2026-10-05'))).toEqual(['agera5_et0']);
		});

		it('credits nothing for run days the feed didn’t write (a person’s edit, the gap between ranges, outside the series)', () => {
			expect(et0ProductsRead(feed, used('2026-10-01', '2026-10-04'))).toEqual([]);
			expect(et0ProductsRead(feed, used('2024-01-01', '2025-12-31'))).toEqual([]);
			expect(et0ProductsRead({ days: [], agera5Through: '2026-09-30' }, used('2025-01-01', '2026-10-28'))).toEqual([]);
		});

		it('credits NASA POWER alone when the copy held no AgERA5, and both when where it reached is unknown', () => {
			expect(et0ProductsRead({ ...feed, agera5Through: null }, used('2025-01-01', '2026-10-28'))).toEqual(['power_et0']);
			expect(et0ProductsRead({ days: feed.days }, used('2026-02-01', '2026-02-02'))).toEqual(['agera5_et0', 'power_et0']);
		});

		it('credits nothing when GR4J didn’t read the series, or it supplied no day, or no feed wrote it', () => {
			expect(et0ProductsRead(feed, { used: false, dailyDays: 0, first: null, last: null })).toEqual([]);
			expect(et0ProductsRead(feed, { used: true, dailyDays: 0, first: null, last: null })).toEqual([]);
			expect(et0ProductsRead(feed, null)).toEqual([]);
			expect(et0ProductsRead(null, used('2025-01-01', '2026-10-28'))).toEqual([]);
		});
	});
});
