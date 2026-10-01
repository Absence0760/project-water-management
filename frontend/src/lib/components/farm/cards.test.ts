// The main page's strings, pinned to the design's boards
// (docs/design/farmer-view-prototype/Main.dc.html, Farms.dc.html) with the
// Vaalbank fixture, plus the rules the design states for the other cases.
import { afterEach, describe, expect, it } from 'vitest';
import { IRRIGATION_SYSTEMS, NEW_FARM_IRRIGATION, type FarmProjection, type FarmView } from '@water-management/engine';
import {
	compareCard,
	damCard,
	datesLine,
	farmSummaryLine,
	lastsFor,
	lookingBack,
	lookingBackFolds,
	noticeCard,
	outletLine,
	positionLine,
	privacy,
	previewBanner,
	savedStrip,
	shortLine,
	stillFailing,
	splitNotice,
	staleUntil,
	supplyCard,
	systemName,
	accessLine,
	bandChip,
	contactText,
	levelWord,
	registeredCard,
	registeredNote,
	stateText
} from './cards';
import { vaalbankFixture } from './fixture';
import { plainText, type Rich } from '$lib/i18n/rich';
import { setLocale } from '$lib/i18n/locale.svelte';
import { markedCatalogue } from '$lib/i18n/fixtureCatalogue';

const sp = (s: string | null | undefined) => s?.replace(/[\u00a0\u202f]/g, ' ');
const txt = (r: Rich | null | undefined) => (r ? sp(plainText(r)) : r);

function withFarm(patch: (f: FarmProjection) => void, v: FarmView = vaalbankFixture()): FarmView {
	patch(v.farm);
	return v;
}

describe('the dates line', () => {
	it('reads as on every board', () => {
		expect(datesLine(vaalbankFixture(), '2024-01-12')).toEqual({
			text: 'Published by the WUA on 12 Jan 2024. Data up to 10 Jan 2024.',
			stale: false
		});
	});

	it('turns stale with its age once the data is older than a week, even if the server said fresh (a saved copy ages)', () => {
		const d = datesLine(vaalbankFixture(), '2024-01-19');
		expect(d.stale).toBe(true);
		expect(sp(d.text)).toBe('Published by the WUA on 12 Jan 2024. Data up to 10 Jan 2024 (9 days ago). Ask your WUA if newer figures are coming.');
	});

	it('says when the next update is expected (E10)', () => {
		const v = vaalbankFixture();
		v.publication.nextExpectedOn = '2024-01-26';
		expect(datesLine(v, '2024-01-12').text).toBe('Published by the WUA on 12 Jan 2024. Data up to 10 Jan 2024. Next update expected around 26 Jan 2024.');
	});
});

describe('the notice', () => {
	it('shows the WUA’s own title and text under the level in words', () => {
		const n = noticeCard(vaalbankFixture())!;
		expect(n.label).toBe('Notice from the WUA · Advisory');
		expect(n.heading).toBe('Please cut back where you can');
		expect(n.body).toBe('The river at the outlet is below its reserve. Irrigate at night and cut back where you can. The board meets on 20 Jan to decide on restrictions.');
		expect(n.byline).toBe('Example WUA, 12 Jan 2024');
	});

	it('shows the WUA’s percentage beside its own words, as the alert email does (operator, 2026-10-01)', () => {
		const v = vaalbankFixture();
		v.publication.restriction = { ...v.publication.restriction, level: 'restricted', pct: 20 };
		const n = noticeCard(v)!;
		expect(n.heading).toBe('Please cut back where you can');
		expect(n.body).toMatch(/^The river at the outlet/);
		expect(sp(n.pctLine)).toBe('Set by the WUA: a 20 % cut in registered water use.');
		// No percentage published: no line, words or not.
		v.publication.restriction = { ...v.publication.restriction, pct: null };
		expect(noticeCard(v)!.pctLine).toBeNull();
	});

	// Issue #51: the API sent English "a former member", which leaked into the Afrikaans byline.
	it('words a deleted publisher from the catalogue', async () => {
		const v = vaalbankFixture();
		v.publication.publishedBy = null;
		expect(noticeCard(v)!.byline).toBe('A former member, 12 Jan 2024');
		await setLocale('af', await markedCatalogue());
		expect(noticeCard(v)!.byline).toMatch(/^\[af\] A former member, /);
		await setLocale('en');
	});

	it('is null with no restriction (the page says "No restriction from the WUA")', () => {
		const v = vaalbankFixture();
		v.publication.restriction = { level: 'none', pct: null, notice: {} };
		expect(noticeCard(v)).toBeNull();
	});

	it('names a restriction and, with no text, carries only the published percentage', () => {
		const v = vaalbankFixture();
		v.publication.restriction = { level: 'restricted', pct: 20, notice: {} };
		const n = noticeCard(v)!;
		expect(n.heading).toBe('Notice from the WUA · Restriction');
		expect(n.label).toBeNull();
		expect(sp(n.pctLine)).toBe('Set by the WUA: a 20 % cut in registered water use.');
	});

	describe('in the language the reader chose (design §7)', () => {
		afterEach(() => setLocale('en'));
		const both = () => {
			const v = vaalbankFixture();
			v.publication.restriction = { level: 'advisory', pct: null, notice: { en: 'Irrigate at night', af: '[af] Irrigate at night' } };
			return v;
		};

		it('reads the English to an English reader, with no line about it', () => {
			expect(noticeCard(both())).toMatchObject({ heading: 'Irrigate at night', lang: 'en', langNote: null });
		});

		it('reads the WUA’s Afrikaans to someone who chose Afrikaans, though our own words are still English', async () => {
			await setLocale('af', {});
			expect(noticeCard(both())).toMatchObject({ heading: '[af] Irrigate at night', lang: 'af', langNote: null, label: 'Notice from the WUA · Advisory' });
		});

		it('falls back to the language the WUA wrote, and says so', async () => {
			const enOnly = both();
			delete enOnly.publication.restriction.notice.af;
			await setLocale('af', {});
			expect(noticeCard(enOnly)).toMatchObject({ heading: 'Irrigate at night', lang: 'en', langNote: 'The WUA wrote this notice in English only.' });
			await setLocale('en');
			const afOnly = both();
			afOnly.publication.restriction.notice.en = '  ';
			expect(noticeCard(afOnly)).toMatchObject({ heading: '[af] Irrigate at night', lang: 'af', langNote: 'The WUA wrote this notice in Afrikaans only.' });
		});

		it('has no language without words (the percentage alone)', () => {
			const v = vaalbankFixture();
			v.publication.restriction = { level: 'restricted', pct: 20, notice: {} };
			expect(noticeCard(v)).toMatchObject({ lang: null, langNote: null });
		});
	});

	it('splits a notice into title and text', () => {
		expect(splitNotice(null)).toEqual({ title: null, body: null });
		expect(splitNotice('Irrigation cut by 20 % from 15 Jan\n\nEvery hydrological unit takes 20 % less.')).toEqual({
			title: 'Irrigation cut by 20 % from 15 Jan',
			body: 'Every hydrological unit takes 20 % less.'
		});
		const long = 'x'.repeat(81);
		expect(splitNotice(long)).toEqual({ title: null, body: long });
	});
});

describe('Water you received this season', () => {
	it('matches board 1 in ML', () => {
		const s = supplyCard(vaalbankFixture().farm, 'ML');
		expect(sp(s.pct)).toBe('86 %');
		expect(s.barPct).toBe(86);
		expect(sp(s.volumes)).toBe('324.2 ML of 376.5 ML since 1 Oct');
		expect(s.short).toBe('Short on 16 days in Nov and Dec, all when your dam was down to its stop level.');
		expect(txt(s.last30)).toBe('Last 30 days: >99 % · 113.3 ML of 113.8 ML');
		expect(sp(s.efficiency)).toBe(
			'Worked out by the model, not read from your meter. It assumes 75 % of the water you pump reaches the crop (sprinklers). Wrong? Tell your WUA.'
		);
	});

	it('matches board 1 in m³', () => {
		const s = supplyCard(vaalbankFixture().farm, 'm3');
		expect(sp(s.volumes)).toBe('324 247 m³ of 376 466 m³ since 1 Oct');
		expect(txt(s.last30)).toBe('Last 30 days: >99 % · 113 283 m³ of 113 810 m³');
	});

	it('gives no % under the demand floor', () => {
		const v = withFarm((f) => {
			f.season.fraction = null;
			f.last30.fraction = null;
		});
		const s = supplyCard(v.farm, 'm3');
		expect(s.pct).toBeNull();
		expect(txt(s.last30)).toBe('Last 30 days: very little water needed');
		expect(txt(supplyCard(v.farm, 'm3', '2024-01-10').last30)).toBe('30 days to 10 Jan 2024: very little water needed');
	});

	it('names the day its 30 days end on once the figures are stale, not "Last 30 days" (issue #162)', () => {
		const v = vaalbankFixture();
		// Data up to 10 Jan 2024: a week later is still current, 8 days is stale.
		expect(staleUntil(v, '2024-01-17')).toBeNull();
		expect(staleUntil(v, '2024-01-18')).toBe('2024-01-10');
		expect(staleUntil({ ...v, stale: true }, '2024-01-10')).toBe('2024-01-10');
		expect(txt(supplyCard(v.farm, 'ML', staleUntil(v, '2024-01-18')).last30)).toBe('30 days to 10 Jan 2024: >99 % · 113.3 ML of 113.8 ML');
		expect(txt(outletLine(v, '2024-01-10'))).toBe('River at Sandspruit Outlet: below its reserve on all of the 30 days to 10 Jan 2024.');
		v.outlet30 = { name: 'Outlet', daysNotMet: 12, days: 30 };
		expect(txt(outletLine(v, '2024-01-10'))).toBe('River at Outlet: below its reserve on 12 of the 30 days to 10 Jan 2024.');
		v.outlet30 = { name: 'Outlet', daysNotMet: 0, days: 30 };
		expect(txt(outletLine(v, '2024-01-10'))).toBe('River at Outlet: kept its reserve on every one of the 30 days to 10 Jan 2024.');
	});

	it('names the SABI 2021 irrigation system nearest the efficiency (the table the node form sets)', () => {
		expect(systemName(0.9)).toBe('drip');
		expect(systemName(0.95)).toBe('drip');
		expect(systemName(0.85)).toBe('micro or centre pivot'); // centre pivot
		expect(systemName(0.82)).toBe('micro or centre pivot'); // micro-sprinkler
		expect(systemName(0.8)).toBe('sprinklers'); // permanent
		expect(systemName(0.75)).toBe('sprinklers'); // movable
		expect(systemName(0.7)).toBe('flood'); // surface
		expect(systemName(0.65)).toBe('flood');
		expect(systemName(0.5)).toBe('flood');
	});

	it('names every engine system in a farmer’s word, and drip for a new farm', () => {
		expect(IRRIGATION_SYSTEMS.map((s) => systemName(s.efficiency))).toEqual(['drip', 'micro or centre pivot', 'micro or centre pivot', 'sprinklers', 'sprinklers', 'flood']);
		expect(systemName(NEW_FARM_IRRIGATION.irrigationEfficiency)).toBe('drip');
	});

	it('words the short days for each kind of hydrological unit', () => {
		const f = vaalbankFixture().farm;
		expect(sp(shortLine({ ...f, season: { ...f.season, shortDays: 0 } }))).toBe("You weren't short of water on any day this season.");
		expect(sp(shortLine({ ...f, season: { ...f.season, shortDays: 1, shortMonths: ['2023-11'], shortDaysAtStopLevel: 1 } }))).toBe(
			'Short on 1 day in Nov, when your dam was down to its stop level.'
		);
		expect(sp(shortLine({ ...f, damMinPct: 0 }))).toBe('Short on 16 days in Nov and Dec, all when your dam was empty.');
		expect(sp(shortLine({ ...f, damCapacityM3: 0, dam: null, season: { ...f.season, shortDaysAtStopLevel: 0 } }))).toBe(
			'Short on 16 days in Nov and Dec, all when the river was too low to take from.'
		);
		expect(sp(shortLine({ ...f, season: { ...f.season, shortMonths: ['2023-10', '2023-11', '2023-12'], shortDaysAtStopLevel: 4 } }))).toBe(
			'Short on 16 days in Oct, Nov and Dec, 4 of them when your dam was down to its stop level.'
		);
	});
});

describe('Your dam', () => {
	it('matches board 1', () => {
		const d = damCard(vaalbankFixture().farm, 'ML')!;
		expect(sp(d.pct)).toBe('24 %');
		expect(d.barPct).toBe(24);
		expect(d.stopPct).toBe(15);
		expect(sp(d.stopLabel)).toBe('irrigation stops at 15 %');
		expect(sp(d.volumes)).toBe('83.6 ML of 350 ML');
		expect(sp(d.trend.text)).toBe('Up 9 points in 30 days (was 15 %)');
		expect(d.trend.dir).toBe('up');
		expect(txt(d.daysLeft)).toBe(
			'At your use over the last 14 days (about 5.1 ML a day), the water above the stop level lasts about 6 days if nothing flows in. A rough guide.'
		);
		expect(d.noStop).toBeNull();
		expect(sp(damCard(vaalbankFixture().farm, 'm3')!.volumes)).toBe('83 640 m³ of 350 000 m³');
	});

	it('is null for a hydrological unit with no dam', () => {
		expect(damCard(withFarm((f) => ((f.damCapacityM3 = 0), (f.dam = null))).farm, 'm3')).toBeNull();
	});

	it('replaces the stop mark and the days-left line when no stop level is set (every imported dam)', () => {
		const d = damCard(withFarm((f) => ((f.damMinPct = 0), (f.dam!.usableM3 = null), (f.dam!.usableDays = null))).farm, 'm3')!;
		expect(d.stopPct).toBeNull();
		expect(d.stopLabel).toBeNull();
		expect(d.daysLeft).toBeNull();
		expect(d.noStop).toBe('The model assumes your pump can empty the dam. Tell your WUA the level your pump stops at.');
	});

	it('leaves the days-left line out when nothing was used in 14 days, and says so at the stop level', () => {
		expect(damCard(withFarm((f) => ((f.dam!.use14M3Day = 0), (f.dam!.usableDays = null))).farm, 'm3')!.daysLeft).toBeNull();
		expect(txt(damCard(withFarm((f) => ((f.dam!.usableM3 = 0), (f.dam!.usableDays = 0))).farm, 'm3')!.daysLeft)).toMatch(/^Your dam is down to the level where irrigation stops/);
	});

	it('counts days under 14, then weeks', () => {
		expect(sp(lastsFor(0.4))).toBe('less than a day');
		expect(sp(lastsFor(1.2))).toBe('about 1 day');
		expect(sp(lastsFor(6.39))).toBe('about 6 days');
		expect(sp(lastsFor(13.4))).toBe('about 13 days');
		expect(sp(lastsFor(20))).toBe('about 3 weeks');
	});

	it('words a fall and no change', () => {
		const down = damCard(withFarm((f) => (f.dam!.pct30dAgo = 0.3)).farm, 'm3')!;
		expect(sp(down.trend.text)).toBe('Down 6 points in 30 days (was 30 %)');
		expect(down.trend.dir).toBe('down');
		const flat = damCard(withFarm((f) => (f.dam!.pct30dAgo = 0.244)).farm, 'm3')!;
		expect(sp(flat.trend.text)).toBe('About the same as 30 days ago (24 %)');
	});
});

describe('Your registered water (issue #72)', () => {
	it('lists the farm’s own registered volumes and storage beside the season’s modelled supply and dam', () => {
		const v = vaalbankFixture();
		v.registered = { asOf: '2024-01-12', surfaceM3PerYear: 400_000, groundwaterM3PerYear: 25_000, storageM3: 300_000 };
		const r = registeredCard(v, 'ML')!;
		expect(r.lines.map(sp)).toEqual(['Surface water: 400 ML a year', 'Groundwater: 25 ML a year', 'Dam storage: 300 ML']);
		expect(sp(r.use)).toBe('The model supplied 324.2 ML since 1 Oct. The volume registered for the whole year is 425 ML.');
		expect(sp(r.dam)).toBe('Your dam in the model holds 350 ML when full.');
		expect(sp(registeredCard(v, 'm3')!.lines[0])).toBe('Surface water: 400 000 m³ a year');
	});

	it('is null with nothing registered, and leaves out what isn’t', () => {
		const v = vaalbankFixture();
		expect(registeredCard(v, 'ML')).toBeNull();
		v.registered = null;
		expect(registeredCard(v, 'ML')).toBeNull();
		// Storage only (a 21(b) row, no take): no supply line, and the dam beside it.
		v.registered = { asOf: '2024-01-12', surfaceM3PerYear: null, groundwaterM3PerYear: null, storageM3: 300_000 };
		expect(registeredCard(v, 'ML')).toEqual({ lines: [expect.stringMatching(/^Dam storage: 300\sML$/)], use: null, dam: expect.stringMatching(/^Your dam in the model/) });
		// A take, no storage registered: no dam line.
		v.registered = { asOf: '2024-01-12', surfaceM3PerYear: 1000, groundwaterM3PerYear: null, storageM3: null };
		expect(registeredCard(v, 'ML')!.dam).toBeNull();
	});

	it('says a registered volume is not an entitlement, and never says lawful or unlawful of the farm', () => {
		expect(registeredNote()).toContain('A registered volume is not an entitlement');
		expect(registeredNote()).not.toMatch(/\b(unlawful|illegal|compliant)\b/i);
	});
});

describe('Looking back (the model card)', () => {
	it('matches board 1', () => {
		const l = lookingBack(vaalbankFixture().farm);
		expect(l.heading).toBe('Looking back: 1 Oct to 10 Jan');
		expect(l.chip).toBe('Model: watch');
		expect(txt(l.text)).toBe('If you had pumped less on the days the river needed it, you would have had about 83 % of the water you needed.');
		expect(sp(l.link)).toBe('Why 83 %? What can I do?');
	});

	it('has no chip and no % under the demand floor', () => {
		const l = lookingBack(withFarm((f) => ((f.river.headline = null), (f.river.band = null))).farm);
		expect(l.chip).toBeNull();
		expect(txt(l.text)).toBe('Your hydrological unit needed very little water this season.');
	});

	it('folds to its link line under a restriction, and when the river asked for no cut (issue #177)', () => {
		const asked = vaalbankFixture().farm;
		// Positive control: the river asked Vaalbank to pump less, so the card shows under no notice or an advisory.
		expect(lookingBackFolds(asked, 'none')).toBe(false);
		expect(lookingBackFolds(asked, 'advisory')).toBe(false);
		expect(lookingBackFolds(asked, 'restricted')).toBe(true);
		// No cut: its % would only repeat the Supply card's.
		const noCut = withFarm((f) => ((f.river.chargedDays = 0), (f.river.supplyCutM3Day = 0), (f.river.headline = 0.86), (f.river.band = 'watch'))).farm;
		expect(lookingBackFolds(noCut, 'none')).toBe(true);
		// A cut under the 1 m³/day floor asks nothing either.
		const tiny = withFarm((f) => ((f.river.chargedDays = 3), (f.river.supplyCutM3Day = 0.5))).farm;
		expect(lookingBackFolds(tiny, 'advisory')).toBe(true);
	});
});

describe('Compared with last season', () => {
	it('matches board 1', () => {
		expect(compareCard(vaalbankFixture().farm)).toEqual({
			available: true,
			span: '1 Oct – 10 Jan',
			now: '2023–24',
			then: '2022–23',
			rows: [
				{ label: 'Water received', now: '86 %', then: '65 %' },
				{ label: 'Dam on 10 Jan', now: '24 %', then: '17 %' }
			]
		});
	});

	it('names the day the model’s data starts when it doesn’t reach back (design §6.5)', () => {
		const c = compareCard(withFarm((f) => (f.lastSeason = null)).farm);
		expect(c).toEqual({ available: false, text: 'Not available: the model’s data starts on 1 Oct 2014.' });
	});

	it('says only that it doesn’t reach back on a copy saved before dataFrom existed', () => {
		const c = compareCard(
			withFarm((f) => {
				f.lastSeason = null;
				delete (f as Partial<FarmProjection>).dataFrom;
			}).farm
		);
		expect(c).toEqual({ available: false, text: 'Not available: the model’s data doesn’t reach back to the same dates last season.' });
	});
});

describe('Your hydrological unit on the river', () => {
	it('matches board 1', () => {
		const v = vaalbankFixture();
		expect(sp(positionLine(v))).toBe('1 hydrological unit is upstream of you and 2 are downstream, of 8 hydrological units in the catchment. The same rules apply to every hydrological unit.');
		expect(txt(outletLine(v))).toBe('River at Sandspruit Outlet: below its reserve on all of the last 30 days.');
		expect(privacy()).toBe(
			'Your hydrological unit’s figures are seen by you, anyone else linked to this hydrological unit, and the WUA’s staff and modeller. Other farmers can’t see them, and you can’t see theirs.'
		);
	});

	it('uses the plural rules', () => {
		const v = vaalbankFixture();
		v.context = { farmsUpstream: 0, farmsDownstream: 1, farmCount: 2 };
		expect(sp(positionLine(v))).toMatch(/^No hydrological unit is upstream of you and 1 is downstream, of 2 hydrological units in the catchment\./);
		v.context = { farmsUpstream: 3, farmsDownstream: 0, farmCount: 1 };
		expect(sp(positionLine(v))).toMatch(/^3 hydrological units are upstream of you and none is downstream, of 1 hydrological unit in the catchment\./);
		v.outlet30 = { name: 'Outlet', daysNotMet: 12, days: 30 };
		expect(txt(outletLine(v))).toBe('River at Outlet: below its reserve on 12 of the last 30 days.');
		v.outlet30 = { name: 'Outlet', daysNotMet: 0, days: 30 };
		expect(txt(outletLine(v))).toBe('River at Outlet: kept its reserve on every one of the last 30 days.');
	});
});

describe('the hydrological units list (board 9)', () => {
	it('sums a hydrological unit up in one line', () => {
		expect(sp(farmSummaryLine(vaalbankFixture().farm))).toBe('86 % of water needed · dam 24 %');
		expect(sp(farmSummaryLine(withFarm((f) => ((f.damCapacityM3 = 0), (f.dam = null))).farm))).toBe('86 % of water needed · no dam');
	});
});

describe('the states', () => {
	it('word the offline strip and the update failure with when the copy was saved (skewed TZ)', () => {
		const tz = process.env.TZ;
		try {
			process.env.TZ = 'Africa/Johannesburg';
			const at = Date.UTC(2024, 0, 19, 5, 42);
			expect(savedStrip(at, 'offline')).toBe(
				'No signal. These are the figures saved on this phone at 07:42 on 19 Jan 2024. We’ll update them when you’re back online.'
			);
			expect(savedStrip(at, 'failed')).toBe('We couldn’t update your figures. These are the figures saved on this phone at 07:42 on 19 Jan 2024.');
			process.env.TZ = 'Pacific/Kiritimati';
			expect(savedStrip(at, 'failed')).toContain('at 19:42 on 19 Jan 2024');
		} finally {
			process.env.TZ = tz;
		}
	});

	it('adds a contact line after a second failure', () => {
		expect(stillFailing(true)).toBe('Still no connection. If this keeps happening, contact your WUA.');
		expect(stillFailing(false)).toBe('Still not working. If this keeps happening, contact your WUA.');
		expect(stillFailing(true, 'Vaalbank WUA')).toBe('Still no connection. If this keeps happening, contact Vaalbank WUA.');
		expect(stillFailing(false, 'Vaalbank WUA')).toBe('Still not working. If this keeps happening, contact Vaalbank WUA.');
		expect(previewBanner('Vaalbank (example)')).toBe('You’re previewing Vaalbank (example) as its farmer sees it');
	});
});

describe('Who can see my hydrological unit', () => {
	it('names each person with what they can do, and marks the caller', () => {
		expect(accessLine({ displayName: 'Demo Farmer', role: 'farmer', you: true })).toBe('Demo Farmer (you) · linked to this hydrological unit');
		expect(accessLine({ displayName: 'Demo Analyst', role: 'owner', you: false })).toBe('Demo Analyst · WUA, manages who has access');
		expect(accessLine({ displayName: 'Clerk', role: 'viewer', you: false })).toBe('Clerk · WUA, can read');
		expect(accessLine({ displayName: 'Modeller', role: 'editor', you: false })).toBe('Modeller · WUA, can change the model');
		expect(accessLine({ displayName: 'Someone', role: 'auditor', you: false })).toBe('Someone · WUA');
	});
});

// Words picked from a table by a value rather than written at the call: every
// value's English, so a change to how the words are looked up can't lose one.
describe('words picked by value', () => {
	it('names every restriction level, model band and irrigation system', () => {
		expect((['none', 'advisory', 'restricted'] as const).map(levelWord)).toEqual(['No restriction', 'Advisory', 'Restriction']);
		expect((['ok', 'watch', 'short'] as const).map(bandChip)).toEqual(['Model: OK', 'Model: watch', 'Model: short']);
		expect([0.9, 0.85, 0.75, 0.65, 0.5].map(systemName)).toEqual(['drip', 'micro or centre pivot', 'sprinklers', 'flood', 'flood']);
	});

	it('words every hydrological unit page state', () => {
		const states = ['loading', 'slow', 'errorTitle', 'errorText', 'noPublication', 'noPublicationText', 'contact', 'removed', 'needsConnection', 'updating'] as const;
		expect(states.map(stateText)).toEqual([
			'Loading your hydrological unit…',
			'Slow signal? This can take a moment.',
			'We couldn’t load your hydrological unit',
			'Check your signal and try again. Your figures are safe; nothing was changed.',
			'Your WUA hasn’t published figures yet',
			'When they do, you’ll see the water you received, how your dam is doing, and any restrictions, here.',
			'Questions? Contact your WUA.',
			'You no longer have access to this hydrological unit. Contact your WUA.',
			'Charts, “Why?” and downloads need a connection.',
			'Updating…'
		]);
	});

	it('names the WUA in the contact lines when the project has its name, else “your WUA”', () => {
		expect(contactText('contact', 'Vaalbank WUA')).toBe('Questions? Contact Vaalbank WUA.');
		expect(contactText('removed', 'Vaalbank WUA')).toBe('You no longer have access to this hydrological unit. Contact Vaalbank WUA.');
		expect(contactText('contact', null)).toBe('Questions? Contact your WUA.');
		expect(contactText('removed', '')).toBe('You no longer have access to this hydrological unit. Contact your WUA.');
	});
});
