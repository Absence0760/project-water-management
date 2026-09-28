import { afterEach, describe, expect, it } from 'vitest';
import type { ShareView } from '$lib/api/types';
import { setLocale } from '$lib/i18n/locale.svelte';
import { farmsLine, publishedLine, readShareToken, reserveRows, shareNotice } from './share';

/** Intl joins dates and our figures with no-break spaces; compare with plain ones. */
const sp = (s: string | null | undefined) => s?.replace(/[  ]/g, ' ');
/** A made-up token of the right shape (43 base64url characters). */
const TOKEN = `${'a'.repeat(20)}_-${'b'.repeat(21)}`;

function view(over: Partial<ShareView['publication']> = {}): ShareView {
	return {
		project: { name: 'Sandspruit' },
		publication: {
			publishedAt: '2024-01-11T23:30:00Z',
			publishedBy: 'Thandi Mokoena',
			restriction: { level: 'advisory', pct: 15, notice: { en: 'Please cut back\nIrrigate at night.', af: 'Sny asseblief terug\nBesproei snags.' } },
			nextExpectedOn: '2024-02-01',
			catchmentView: {
				runStart: '2021-10-01',
				dataUntil: '2024-01-10',
				season: { from: '2023-10-01', to: '2024-01-10', days: 102 },
				last30: { from: '2023-12-12', to: '2024-01-10', days: 30 },
				runDays: 832,
				farmCount: 6,
				sites: [
					{ name: null, isOutlet: true, daysNotMet: { run: 40, season: 12, last30: 3 } },
					{ name: 'Middle weir', isOutlet: false, daysNotMet: { run: 0, season: 0, last30: 0 } },
					{ name: 'Top weir', isOutlet: false, daysNotMet: { run: 90, season: 50, last30: 30 } }
				]
			},
			...over
		}
	};
}

describe('readShareToken', () => {
	it('reads the token from the fragment', () => {
		expect(readShareToken(`#t=${TOKEN}`)).toBe(TOKEN);
		expect(readShareToken(`t=${TOKEN}`)).toBe(TOKEN);
		expect(readShareToken(`#x=1&t=${TOKEN}`)).toBe(TOKEN);
	});

	it('refuses anything that cannot be one of ours', () => {
		for (const h of ['', '#', '#t=', '#t=short', `#t=${TOKEN}x`, `#t=${TOKEN.slice(0, 42)}+`, `#token=${TOKEN}`]) expect(readShareToken(h), h).toBeNull();
	});
});

describe('the notice', () => {
	afterEach(() => setLocale('en'));

	it('builds the notice card: title, text, the percentage and who published it', () => {
		const n = shareNotice(view())!;
		expect(n).toMatchObject({ level: 'advisory', label: 'Notice from the WUA · Advisory', heading: 'Please cut back', body: 'Irrigate at night.', lang: 'en' });
		// The WUA's own words carry the cut; the percentage stands alone only without them.
		expect(n.pctLine).toBeNull();
		expect(sp(shareNotice(view({ restriction: { level: 'restricted', pct: 15, notice: {} } }))!.pctLine)).toBe('Set by the WUA: 15 % of registered use.');
		expect(sp(n.byline)).toMatch(/^Thandi Mokoena, 1[12] Jan 2024$/);
	});

	it('reads the notice in the language the page chose, else English, with a line saying so', async () => {
		await setLocale('af', {});
		expect(shareNotice(view())).toMatchObject({ heading: 'Sny asseblief terug', lang: 'af', langNote: null });
		const enOnly = view({ restriction: { level: 'advisory', pct: null, notice: { en: 'Please cut back' } } });
		expect(shareNotice(enOnly)).toMatchObject({ heading: 'Please cut back', lang: 'en', langNote: 'The WUA wrote this notice in English only.' });
		await setLocale('en');
		expect(shareNotice(view())).toMatchObject({ heading: 'Please cut back', lang: 'en', langNote: null });
	});

	it('with no text, heads the card with the level; with none, has no card', () => {
		const n = shareNotice(view({ restriction: { level: 'restricted', pct: null, notice: {} } }))!;
		expect(n).toMatchObject({ heading: 'Notice from the WUA · Restriction', label: null, body: null, pctLine: null, lang: null });
		expect(shareNotice(view({ restriction: { level: 'none', pct: null, notice: {} } }))).toBeNull();
		expect(shareNotice(view({ publishedBy: null }))!.byline).toMatch(/^A former member, /);
	});
});

describe('the words', () => {
	const tz = process.env.TZ;
	afterEach(() => {
		process.env.TZ = tz;
	});

	it('says who published it and when, where the reader is, and never moves a calendar day', () => {
		process.env.TZ = 'Africa/Johannesburg';
		expect(sp(publishedLine(view()))).toBe('Published by Thandi Mokoena on 12 Jan 2024. Data up to 10 Jan 2024. Next update expected around 1 Feb 2024.');
		process.env.TZ = 'Pacific/Pago_Pago';
		expect(sp(publishedLine(view({ nextExpectedOn: null, publishedBy: null })))).toBe('Published by a former member on 11 Jan 2024. Data up to 10 Jan 2024.');
		process.env.TZ = 'Pacific/Kiritimati';
		expect(sp(publishedLine(view()))).toContain('Data up to 10 Jan 2024. Next update expected around 1 Feb 2024.');
	});

	it('gives the reserve at the outlet (unnamed) and each gauge, counts only', () => {
		process.env.TZ = 'Pacific/Kiritimati';
		const rows = reserveRows(view().publication.catchmentView).map((r) => ({ ...r, last30: sp(r.last30), season: sp(r.season) }));
		expect(rows).toEqual([
			{ place: 'At the catchment outlet', state: 'partly', last30: 'Below its reserve on 3 of the last 30 days.', season: '12 of 102 days below it this season (since 1 Oct 2023).' },
			{ place: 'At Middle weir', state: 'met', last30: 'Kept its reserve on every one of the last 30 days.', season: '0 of 102 days below it this season (since 1 Oct 2023).' },
			{ place: 'At Top weir', state: 'missed', last30: 'Below its reserve on all of the last 30 days.', season: '50 of 102 days below it this season (since 1 Oct 2023).' }
		]);
	});

	it('counts the farms without naming one', () => {
		expect(sp(farmsLine(view().publication.catchmentView))).toBe('6 farms in the catchment.');
		expect(sp(farmsLine({ ...view().publication.catchmentView, farmCount: 1 }))).toBe('1 farm in the catchment.');
	});
});
