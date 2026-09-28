// The "Why about 83 %?" page (board 4: docs/design/farmer-view-prototype/Why.dc.html)
// with the Vaalbank fixture, and the design's rules for the other cases.
import { describe, expect, it } from 'vitest';
import type { FarmProjection } from '@water-management/engine';
import { vaalbankFixture } from './fixture';
import { plainText, type Rich } from '$lib/i18n/rich';
import { kHidden, shareComparison, step1, step2, step3, whatThisIsNot, whyIntro, whyTitle, wuaDecided } from './why';

const sp = (s: string | null | undefined) => s?.replace(/[\u00a0\u202f]/g, ' ');
const txt = (r: Rich | null | undefined) => (r ? sp(plainText(r)) : r);
const farm = (patch: (f: FarmProjection) => void = () => {}) => {
	const f = vaalbankFixture().farm;
	patch(f);
	return f;
};

describe('the title and intro', () => {
	it('match board 4', () => {
		expect(sp(whyTitle(farm()))).toBe('Why about 83 %?');
		expect(whyIntro(farm())).toBe(
			'Looking back over 1 Oct 2023 to 10 Jan 2024, the model checks two things: was water shared fairly between hydrological units, and did the river keep enough water flowing?'
		);
		expect(whyTitle(farm((f) => (f.river.headline = null)))).toBe('What the model found');
	});
});

describe('step 1: was water shared fairly?', () => {
	it('matches board 4', () => {
		const s = step1(farm());
		if (!s.shown) throw new Error('hidden');
		expect(txt(s.catchment)).toBe('Across the catchment, hydrological units received 89 % of what they needed. We call that the even share.');
		expect(sp(s.shareLabel)).toBe('even share 89 %');
		expect(sp(s.youLabel)).toBe('you 86 %');
		expect([s.sharePct, s.youPct]).toEqual([89, 86]);
		expect(txt(s.you)).toBe('You received 86 %: a little less than an even share (about 118 m³ a day).');
		expect(txt(s.check)).toBe(
			'This is a fairness check, not extra water for you. Whether more water can reach your hydrological unit depends on where you are on the river and what is in your dam. It isn’t part of the 83 %.'
		);
	});

	it('is hidden below k other holders, with the reason', () => {
		expect(step1(farm((f) => ((f.river.equitableFraction = null), (f.river.aboveBelowShareM3Day = null))))).toEqual({ shown: false, text: kHidden() });
		expect(kHidden()).toBe('Not shown: with so few hydrological units in the catchment, it could reveal a neighbour’s figures.');
	});

	it('never words the share as water to take', () => {
		expect(sp(shareComparison(-118))).toBe('a little more than an even share (about 118 m³ a day)');
		expect(shareComparison(0.4)).toBe('about an even share');
	});
});

describe('step 2: did the river keep flowing?', () => {
	it('matches board 4', () => {
		const s = step2(farm());
		expect(txt(s.intro)).toBe('The law keeps some water in the river so it stays healthy for everyone downstream. This is the river’s reserve.');
		expect(txt(s.sites)).toBe('The river was below its reserve at Sandspruit Outlet on 52 days and at Melkhout Gauge on 44 days.');
		expect(s.reason).toBe('On every one of those days, water taken upstream was part of the reason, not only low rain.');
		expect(s.rule).toBe(
			'Hydrological units upstream are asked to make that up in proportion to the water each one used up or stored. Water that flows back to the river doesn’t count against you.'
		);
		expect(sp(s.asked)).toBe('You were asked to help on 56 of the 102 days. On those days:');
		expect(txt(s.pump)).toBe('Pump about 220 m³ a day less (2.6 l/s). Averaged over all 102 days that is 121 m³ a day.');
		expect(txt(s.dam)).toBe(
			'Your dam also held back about 120 m³ a day the river needed. If your dam has an outlet or a bypass, letting that through helps. If it doesn’t, the WUA may talk to you about it.'
		);
		expect(s.beyondShare).toBeNull();
	});

	it('splits out the days that were only low rain', () => {
		const s = step2(farm((f) => (f.river.sites[1]!.daysOnlyNatural = 10)));
		expect(sp(s.reason)).toBe('Water taken upstream was part of the reason on the other days; on 10 days at Melkhout Gauge it was only because of low rain.');
		const all = step2(farm((f) => f.river.sites.forEach((x) => (x.daysOnlyNatural = x.daysNotMet))));
		expect(all.reason).toBe('It was only because of low rain: water taken upstream wasn’t part of the reason.');
	});

	it('leaves out the l/s under 1 l/s, and the dam line under the 1 m³/day floor', () => {
		const s = step2(
			farm((f) => {
				f.river.supplyCutM3Day = 20;
				f.river.perChargedDaySupplyCutM3 = (20 * 102) / 56;
				f.river.storageM3Day = 0.5;
				f.river.perChargedDayStorageM3 = (0.5 * 102) / 56;
			})
		);
		expect(txt(s.pump)).toBe('Pump about 36 m³ a day less. Averaged over all 102 days that is 20 m³ a day.');
		expect(s.dam).toBeNull();
	});

	it('speaks of the dam alone when there was no pump cut', () => {
		const s = step2(farm((f) => (f.river.supplyCutM3Day = 0)));
		expect(s.pump).toBeNull();
		expect(txt(s.dam)).toMatch(/^Your dam held back about 120 m³ a day the river needed\./);
	});

	it('says so when the hydrological unit was never asked, and when the reserve was always kept', () => {
		const s = step2(
			farm((f) => {
				f.river.chargedDays = 0;
				f.river.perChargedDaySupplyCutM3 = null;
				f.river.perChargedDayStorageM3 = null;
				f.river.sites = [];
			})
		);
		expect(s.asked).toBe('You weren’t asked to help on any day this season.');
		expect(s.pump).toBeNull();
		expect(s.dam).toBeNull();
		expect(s.rule).toBeNull();
		expect(s.reason).toBeNull();
		expect(txt(s.sites)).toBe('The river kept its reserve every day this season, at every point below your hydrological unit.');
	});

	it('flags a river share beyond an even share only when it applies', () => {
		expect(step2(farm((f) => (f.river.cutBeyondShare = true))).beyondShare).toBe(
			'The river’s share of your water is more than an even share of the catchment’s supply. The WUA may need to look at this.'
		);
	});
});

describe('step 3: where 83 % comes from', () => {
	it('matches board 4, so a farmer can check it by hand', () => {
		const s = step3(farm())!;
		expect(sp(s.heading)).toBe('3. Where 83 % comes from');
		expect(s.caption).toBe('Daily averages over 1 Oct to 10 Jan');
		expect(s.rows.map((r) => [r.label, sp(r.value)])).toEqual([
			['You received', '3 179 m³ a day'],
			['Pump less for the river', '− 121 m³ a day'],
			['Leaves', '3 058 m³ a day'],
			['You needed', '3 691 m³ a day']
		]);
		expect(txt(s.sum)).toBe('3 058 is about 83 % of the 3 691 you needed.');
		expect(s.damNote).toBe(
			'Holding back less in the dam doesn’t come off today’s pumping, so it isn’t in this sum. But it leaves less in your dam for later in the season.'
		);
	});

	it('is left out with no headline', () => {
		expect(step3(farm((f) => (f.river.headline = null)))).toBeNull();
	});
});

describe('what the WUA decided; what this is not', () => {
	it('match board 4', () => {
		expect(txt(wuaDecided(vaalbankFixture()))).toBe('Only a notice from your WUA or from DWS is a restriction. Right now: Advisory. Please cut back where you can.');
		const v = vaalbankFixture();
		v.publication.restriction = { level: 'none', pct: null, notice: {} };
		expect(txt(wuaDecided(v))).toBe('Only a notice from your WUA or from DWS is a restriction. Right now: no restriction.');
		expect(whatThisIsNot(farm())).toEqual([
			'Not your allocation or licence. It doesn’t know your registered water use.',
			'Not a forecast. It looks back over 1 Oct to 10 Jan.',
			'Not measured. It comes from a model of the catchment, which can be wrong.'
		]);
	});
});
