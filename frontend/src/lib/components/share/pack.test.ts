// The words of the /share page's evidence pack view (./pack.ts, 128_pack_share_notes).
import { describe, expect, it } from 'vitest';
import type { SharePack, SharedPackSite } from '$lib/api/types';
import { bandLine, monthRows, packSiteRows, packStatusLine, rowChange, rowLabel, rowValue, signerLine, standingNote, successorCode } from './pack';

const sp = (s: string) => s.replace(/ /g, ' ');

const verify = (over: Partial<SharePack['verify']> = {}): SharePack['verify'] => ({
	status: 'issued',
	version: 2,
	issuedAt: '2026-09-28T10:00:00Z',
	catchment: 'Sandspruit',
	engineVersion: '1.50.0',
	reportVersion: 'evidence-5',
	manifestSha256: 'ab'.repeat(32),
	shortCode: 'abab-abab-abab',
	pdfSha256: null,
	bundleSha256: null,
	successorSha256: null,
	withdrawnReason: null,
	methodology: { version: 'm1', sha256: null },
	errata: [],
	errataFoundSince: [],
	signers: [],
	...over
});

const site = (over: Partial<SharedPackSite> = {}): SharedPackSite => ({
	name: null,
	isOutlet: true,
	category: 'C',
	monthsA: 240,
	rateA: 0.9,
	rateB: 0.85,
	longestA: 2,
	longestB: 3,
	lost: 12,
	gained: 0,
	...over
});

describe('the pack’s standing', () => {
	it('says when it was issued, and why a withdrawn or replaced pack shows no figures', () => {
		expect(packStatusLine(verify())).toMatch(/^Issued on .*2026\.$/);
		expect(packStatusLine(verify({ status: 'withdrawn' }))).toMatch(/^Withdrawn\. It was issued on/);
		expect(packStatusLine(verify({ status: 'superseded' }))).toMatch(/^Replaced by a newer version\./);
		expect(standingNote(verify())).toBeNull();
		expect(standingNote(verify({ status: 'withdrawn' }))).toMatch(/withdrawn, so it no longer stands/);
		expect(standingNote(verify({ status: 'superseded' }))).toMatch(/newer version .* replaced it/);
	});

	it('gives the replacing version’s short code from its hash', () => {
		expect(successorCode(verify())).toBeNull();
		expect(successorCode(verify({ successorSha256: 'cd'.repeat(32) }))).toBe('cdcd-cdcd-cdcd');
		expect(successorCode(verify({ successorSha256: 'not a hash' }))).toBeNull();
	});

	it('names a signer with their body and number', () => {
		expect(signerLine({ fullName: 'Dr A Signer', registrationBody: 'sacnasp', registrationCategory: null, registrationField: null, registrationNo: '400123/10', signedAt: '' })).toBe(
			'Dr A Signer, SACNASP 400123/10'
		);
	});
});

describe('the Reserve at each site', () => {
	it('sets the application beside the baseline, and says which way it moves', () => {
		const [outlet, gauge] = packSiteRows([site(), site({ name: 'Sandspruit weir', isOutlet: false, lost: 0, gained: 3, rateB: 0.95 })], true);
		expect(outlet).toMatchObject({ place: 'At the catchment outlet', trend: 'worse' });
		expect(sp(outlet!.base)).toBe('Met in 90 % of 240 months');
		expect(sp(outlet!.withApp!)).toBe('Met in 85 % of 240 months');
		expect(sp(outlet!.change!)).toBe('12 months more below the Reserve with this application.');
		expect(gauge).toMatchObject({ place: 'At Sandspruit weir', trend: 'better' });
		expect(sp(gauge!.change!)).toBe('3 months fewer below the Reserve with this application.');
	});

	it('shows the baseline alone for baseline evidence, and an unassessed site as such', () => {
		const [row] = packSiteRows([site({ rateA: null })], false);
		expect(row).toMatchObject({ base: 'Not assessed', withApp: null, change: null, trend: 'same' });
	});
});

describe('the river’s rows', () => {
	it('words each row by its id, a gauge’s reserve row by its place', () => {
		expect(rowLabel({ id: 'reserve', subject: null })).toBe('Reserve months met at the catchment outlet');
		expect(rowLabel({ id: 'reserve', subject: 'Sandspruit weir' })).toBe('Reserve months met at Sandspruit weir');
		expect(rowLabel({ id: 'ewrDays', subject: null })).toBe('Days below the EWR at the outlet');
		expect(rowLabel({ id: 'outflowMar', subject: null })).toBe('Mean yearly flow out of the catchment');
	});

	it('puts each value in its unit, and a change with its sign', () => {
		expect(sp(rowValue('reserve', 90))).toBe('90 %');
		expect(rowValue('ewrDays', 12)).toBe('12 days');
		expect(sp(rowValue('shortfall', 1.5))).toBe('1.5 million m³');
		expect(rowValue('ewrDays', null)).toBe('–');
		expect(rowChange('ewrDays', 2)).toBe('+2 days');
		expect(rowChange('ewrDays', -3)).toBe('−3 days');
		expect(rowChange('reserve', -5)).toBe('−5 points');
		expect(rowChange('reserve', null)).toBe('–');
	});

	it('gives a band’s likely range only with its percentiles', () => {
		expect(bandLine('ewrDays', { n: 30, p5: -1, p50: 2, p95: 4 })).toBe('Likely range −1 days to +4 days (30 model sets)');
		expect(bandLine('ewrDays', { n: 3, p5: null, p50: null, p95: null })).toBeNull();
		expect(bandLine('ewrDays', null)).toBeNull();
	});

	it('names each month of the paired change', () => {
		const rows = monthRows([{ month: 10, run: 3, band: null }]);
		expect(rows).toEqual([{ month: 'October', change: '+3 days', range: '' }]);
		expect(monthRows(null)).toEqual([]);
	});
});
