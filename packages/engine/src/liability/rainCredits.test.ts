// C3S's seasonal forecast credit (issue #620): Copernicus's notice, the
// dataset's citation and the contributing centres, word for word as
// docs/data-sources.md § c3s-seasonal quotes them and as the ingest writes
// them into the copy's arrays (ingest/c3s_seasonal.py, ingest/c3srequest.py).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { C3S_CENTRES, C3S_SEASONAL_CITATION, c3sSeasonalCredit, copernicusC3sNotice, copernicusEra5lNotice } from './rainCredits';

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
