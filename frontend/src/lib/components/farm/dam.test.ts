// The dam page (board 3: docs/design/farmer-view-prototype/Dam.dc.html).
import { describe, expect, it } from 'vitest';
import { damPage, lastSpillText, storageChange } from './dam';
import { vaalbankFixture } from './fixture';
import { plainText } from '$lib/i18n/rich';

const sp = (s: string | null | undefined) => s?.replace(/[\u00a0\u202f]/g, ' ');

describe('the dam page', () => {
	it('names the 30 days by their last day once the figures are stale (issue #162)', () => {
		const d = damPage(vaalbankFixture().farm, 'ML', '2024-01-10')!;
		expect(d.facts.find((f) => f.value.includes('32.4') && f.label !== 'You can still use')?.label).toBe('30 days to 10 Jan 2024');
	});

	it('matches board 3', () => {
		const d = damPage(vaalbankFixture().farm, 'ML')!;
		expect(sp(d.pct)).toBe('24 %');
		expect(d.asOf).toBe('full on 10 Jan');
		expect(sp(d.stopLabel)).toBe('irrigation stops at 15 %');
		expect(d.facts.map((f) => [f.label, sp(f.value)])).toEqual([
			['Water in the dam', '83.6 ML'],
			['Full', '350 ML'],
			['You can still use', '32.4 ML'],
			['Last 30 days', 'up 32.4 ML'],
			['Same day last season', '17 %'],
			['Last full and spilling', '27 Jul 2023']
		]);
		expect(d.usableNote).toBe('“You can still use” is the water above the level where irrigation stops (your pump intake or reserve).');
		expect(sp(plainText(d.daysLeft!))).toBe(
			'At your use over the last 14 days (about 5.1 ML a day), that lasts about 6 days if nothing flows in. A rough guide: rain and river flow into the dam make it last longer.'
		);
		expect(sp(d.chartCaption)).toBe(
			'Feb 2023 to Jan 2024, end of each month. Dashed line: irrigation stops (15 %). You were short on 16 days in Nov and Dec, while the dam sat at that line.'
		);
	});

	it('drops "You can still use" and gives the zero-stop wording without a stop level', () => {
		const f = vaalbankFixture().farm;
		f.damMinPct = 0;
		f.dam!.usableM3 = null;
		f.dam!.usableDays = null;
		const d = damPage(f, 'm3')!;
		expect(d.facts.map((x) => x.label)).not.toContain('You can still use');
		expect(d.usableNote).toBeNull();
		expect(d.daysLeft).toBeNull();
		expect(d.noStop).toBe('The model assumes your pump can empty the dam. Tell your WUA the level your pump stops at.');
		expect(sp(d.chartCaption)).toBe('Feb 2023 to Jan 2024, end of each month. You were short on 16 days in Nov and Dec.');
	});

	it('is null without a dam', () => {
		const f = vaalbankFixture().farm;
		f.damCapacityM3 = 0;
		f.dam = null;
		expect(damPage(f, 'm3')).toBeNull();
	});

	it('words the 30-day change and an old or missing spill', () => {
		const f = vaalbankFixture().farm;
		expect(sp(storageChange(f, 'm3'))).toBe('up 32 410 m³');
		f.dam!.pct30dAgo = 0.3;
		expect(sp(storageChange(f, 'ML'))).toBe('down 20.1 ML');
		f.dam!.pct30dAgo = f.dam!.pct;
		expect(storageChange(f, 'ML')).toBe('no change');
		// A view with both storages (engine ≥ 1.27.0) reads the change from them: exact when the capacity changed.
		f.dam!.storage30dAgoM3 = f.dam!.storageM3 - 5_000;
		expect(sp(storageChange(f, 'm3'))).toBe('up 5 000 m³');
		delete f.dam!.storage30dAgoM3;
		f.dam!.lastSpill = '2022-12-01';
		expect(lastSpillText(f)).toBe('not in the last 12 months');
		f.dam!.lastSpill = null;
		expect(lastSpillText(f)).toBe('not in the last 12 months');
	});

	it('says "not available" for last season when the run doesn’t reach back', () => {
		const f = vaalbankFixture().farm;
		f.lastSeason = null;
		expect(damPage(f, 'm3')!.facts.find((x) => x.label === 'Same day last season')!.value).toBe('not available');
	});
});
