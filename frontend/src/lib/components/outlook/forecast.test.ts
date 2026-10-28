// The forecast-conditioned outlook in words (issue #620 step 7, ./forecast.ts):
// off with the reason, the skill gate (below zero "no better than past
// weather" and past weather leads, its column first), each review date's
// chances, the systems and members used, the storage-only line and the
// Copernicus credit with the contributing centres. Invented values.
import { describe, expect, it } from 'vitest';
import type { OutlookForecast } from '#lib/api/types.js';
import { buildForecastView } from './forecast';

const sp = (s: string) => s.replace(/[  ]/g, ' ');

function forecast(over: Partial<OutlookForecast> = {}): OutlookForecast {
	const cat = (id: string, label: string, belowPct: number | null, chance: number) => ({ id, label, belowPct, fromM3: null, toM3: null, chance });
	return {
		method: 'c3s',
		status: 'ready',
		reason: null,
		message: null,
		decisionDate: '2021-06-01',
		seasonEnd: '2021-11-30',
		init: '2021-05',
		systems: [
			{ system: 'ecmwf-51', init: '2021-05', members: 3, membersDropped: 0, months: [{ month: '2021-06', lead: 1, years: Array.from({ length: 24 }, (_, i) => 1993 + i) }], used: true, weight: 0.5, reason: null },
			{ system: 'ukmo-604', init: '2021-05', members: 2, membersDropped: 0, months: [{ month: '2021-06', lead: 1, years: Array.from({ length: 21 }, (_, i) => 1993 + i) }], used: true, weight: 0.5, reason: null },
			{ system: 'dwd-22', init: '2021-05', members: 4, membersDropped: 0, months: [], used: false, weight: 0, reason: 'no hindcast for its 05 init' }
		],
		members: [],
		chances: [{ reviewDate: '2021-08-01', basis: 'rule', categories: [cat('level-0', 'No restriction', null, 0.55), cat('level-1', 'Level 1', 0.4, 0.3), cat('level-2', 'Level 2', 0.2, 0.15)] }],
		espChances: [{ reviewDate: '2021-08-01', basis: 'rule', categories: [cat('level-0', 'No restriction', null, 0.7), cat('level-1', 'Level 1', 0.4, 0.2), cat('level-2', 'Level 2', 0.2, 0.1)] }],
		skill: { metric: 'crpssSeasonEndStorage', crpss: 0.123, nYears: 22, years: [{ year: 1993 } as never, { year: 2014 } as never], reason: null },
		leads: 'forecast',
		warnings: [],
		source: {
			init: '2021-05',
			issued: [
				{ system: 'ecmwf-51', issuedOn: '2021-05-06' },
				{ system: 'ukmo-604', issuedOn: '2021-05-10' }
			],
			notIssued: [{ system: 'jma-3', issuedOn: '2021-06-10' }],
			hindcasts: [{ system: 'ecmwf-51', initMonth: 5, years: Array.from({ length: 24 }, (_, i) => 1993 + i), members: 3 }],
			centres: [],
			fetchedAt: '2026-02-09T00:00:00Z',
			notes: []
		},
		area: { source: 'boundary', cells: 1, units: [], notes: [] },
		...over
	};
}

describe('buildForecastView', () => {
	it('is null for an outlook without the forecast part', () => {
		expect(buildForecastView(undefined)).toBeNull();
		expect(buildForecastView(null)).toBeNull();
	});

	it('says why it is off, with the systems not issued by the decision date', () => {
		const v = buildForecastView(forecast({ status: 'off', reason: 'noHindcast', message: null }))!;
		expect(v).toEqual({
			kind: 'off',
			message: 'The data copy holds no hindcast to calibrate the forecasts on, so the outlook is past weather (the ESP) alone.',
			notes: ['Not issued by the decision date: jma-3 (10 Jun 2021).']
		});
		// The engine's or the backend's own message wins when there is one.
		expect(buildForecastView(forecast({ status: 'off', reason: 'noArea', message: 'No polygon.', source: null }))).toEqual({ kind: 'off', message: 'No polygon.', notes: [] });
	});

	it('above zero skill the forecasts lead: their column first, each level’s chance, the systems, the storage-only line and the credit', () => {
		const v = buildForecastView(forecast())!;
		if (v.kind !== 'ready') throw new Error('not ready');
		expect(v.leads).toBe('forecast');
		expect(sp(v.leadText)).toBe('The forecasts scored better than past weather over 22 hindcast years (CRPSS +0.12), so they lead.');
		expect(sp(v.skill)).toBe('Hindcast skill: CRPSS +0.12 for the dam storage at the season’s end, against past weather, over 22 years (1993–2014).');
		expect(v.columns.map((c) => c.key)).toEqual(['forecast', 'esp']);
		expect(v.dates).toHaveLength(1);
		expect(v.dates[0]!.reviewDate).toBe('1 Aug 2021');
		expect(v.dates[0]!.basis).toBe('Restriction levels (Settings → Drought restrictions)');
		expect(v.dates[0]!.rows.map((r) => [r.label, r.range, r.forecast, r.esp])).toEqual([
			['No restriction', null, '55%', '70%'],
			['Level 1', 'storage below 40% of capacity', '30%', '20%'],
			['Level 2', 'storage below 20% of capacity', '15%', '10%']
		]);
		expect(v.systems).toEqual([
			'ecmwf-51: 3 members, issued 6 May 2021, weight 50%, hindcast 1993–2016, each month fitted on at least 24 years',
			'ukmo-604: 2 members, issued 10 May 2021, weight 50%'
		]);
		expect(v.leftOut).toEqual(['dwd-22: no hindcast for its 05 init', 'Not issued by the decision date: jma-3 (10 Jun 2021).']);
		expect(v.init).toBe('Forecasts from 1 May 2021, the newest issued by the decision date (1 Jun 2021).');
		expect(v.storageOnly).toMatch(/^The chance is of the dam storage on the review date only, at full demand/);
		// Copernicus's notice with the year the copy read it, the citation, and the used systems' centres (not dwd's).
		expect(v.credit[0]).toMatch(/^Contains modified Copernicus Climate Change Service information 2026\./);
		expect(v.credit[1]).toMatch(/^Copernicus Climate Change Service, Climate Data Store \(2018\): Seasonal forecast/);
		expect(v.credit[2]).toBe('Contributing centres: European Centre for Medium-Range Weather Forecasts (ECMWF); Met Office.');
	});

	it('at or below zero skill says "no better than past weather" and past weather leads, its column first', () => {
		const v = buildForecastView(forecast({ leads: 'esp', skill: { metric: 'crpssSeasonEndStorage', crpss: -0.08, nYears: 22, years: [], reason: null } }))!;
		if (v.kind !== 'ready') throw new Error('not ready');
		expect(v.leads).toBe('esp');
		expect(sp(v.leadText)).toBe(
			'No better than past weather: over 22 hindcast years the forecasts scored −0.08 (CRPSS at or below 0), so past weather leads and the forecasts are shown beside it.'
		);
		expect(v.columns.map((c) => c.key)).toEqual(['esp', 'forecast']);
		// Unscored: the reason, and past weather leads all the same.
		const u = buildForecastView(forecast({ leads: 'esp', skill: { metric: 'crpssSeasonEndStorage', crpss: null, nYears: 5, years: [], reason: 'Only 5 hindcast years can be scored.' } }))!;
		if (u.kind !== 'ready') throw new Error('not ready');
		expect(u.leadText).toBe('No better than past weather can be shown: Only 5 hindcast years can be scored. Past weather leads and the forecasts are shown beside it.');
		expect(u.skill).toBe('Hindcast skill: not scored. Only 5 hindcast years can be scored.');
	});

	it('words storage bands by their range, fullest first, when no rule is set', () => {
		const band = (id: string, from: number, to: number, chance: number) => ({ id, label: 'x', belowPct: null, fromM3: from, toM3: to, chance });
		const v = buildForecastView(
			forecast({
				chances: [{ reviewDate: '2021-08-01', basis: 'bands', categories: [band('band-2', 60_000, 80_000, 0.2), band('band-1', 30_000, 60_000, 0.5), band('band-0', 0, 30_000, 0.3)] }],
				espChances: [{ reviewDate: '2021-08-01', basis: 'bands', categories: [band('band-2', 60_000, 80_000, 1 / 3), band('band-1', 30_000, 60_000, 1 / 3), band('band-0', 0, 30_000, 1 / 3)] }]
			})
		)!;
		if (v.kind !== 'ready') throw new Error('not ready');
		expect(v.dates[0]!.basis).toMatch(/^Total dam storage, in the review triggers’ bands/);
		expect(v.dates[0]!.rows.map((r) => [sp(r.label), r.range, r.forecast, r.esp])).toEqual([
			['60 000 m³ – 80 000 m³', 'fullest', '20%', '33%'],
			['30 000 m³ – 60 000 m³', null, '50%', '33%'],
			['0 m³ – 30 000 m³', 'emptiest', '30%', '33%']
		]);
	});
});
