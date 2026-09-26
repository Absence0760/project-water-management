// A team's settings (055_team_settings): the portfolio thresholds' validation,
// the defaults when unset, and how a change merges (WP-2.14, D11).
import { describe, expect, it } from 'vitest';
import { EWR_THRESHOLDS } from '../portfolio/status.js';
import { applySettingsPatch, appliedThresholds, PortfolioThresholds, TeamSettings, TeamSettingsPatch, teamThresholds } from './settings.js';

describe('PortfolioThresholds', () => {
	it('takes 0–100 % with green below amber, decimals included', () => {
		for (const t of [
			{ green: 5, amber: 20 },
			{ green: 0, amber: 100 },
			{ green: 2.5, amber: 7.5 }
		]) {
			expect(PortfolioThresholds.parse(t)).toEqual(t);
		}
	});
	it('rejects out of range, green not below amber, missing, extra and non-number values', () => {
		for (const t of [
			{ green: -1, amber: 20 },
			{ green: 5, amber: 101 },
			{ green: 20, amber: 20 },
			{ green: 30, amber: 20 },
			{ green: 5 },
			{ amber: 20 },
			{ green: 5, amber: 20, red: 50 },
			{ green: '5', amber: 20 },
			{ green: Number.NaN, amber: 20 },
			{ green: 5, amber: Number.POSITIVE_INFINITY },
			null
		]) {
			expect(PortfolioThresholds.safeParse(t).success, JSON.stringify(t)).toBe(false);
		}
	});
	it('says what is wrong when green is not below amber', () => {
		const r = PortfolioThresholds.safeParse({ green: 20, amber: 10 });
		expect(r.success).toBe(false);
		expect(r.error!.issues[0]).toMatchObject({ path: ['green'], message: 'the green cut-off must be below the amber one' });
	});
});

describe('TeamSettings and the patch', () => {
	it('stores only known keys', () => {
		expect(TeamSettings.safeParse({}).success).toBe(true);
		expect(TeamSettings.safeParse({ portfolio: {} }).success).toBe(true);
		expect(TeamSettings.safeParse({ colour: 'blue' }).success).toBe(false);
		expect(TeamSettings.safeParse({ portfolio: { thresholds: { green: 5, amber: 20 }, other: 1 } }).success).toBe(false);
	});
	it('a patch names the thresholds, or null for the defaults', () => {
		expect(TeamSettingsPatch.safeParse({ portfolio: { thresholds: null } }).success).toBe(true);
		expect(TeamSettingsPatch.safeParse({ portfolio: { thresholds: { green: 5, amber: 20 } } }).success).toBe(true);
		expect(TeamSettingsPatch.safeParse({ portfolio: {} }).success).toBe(false);
		expect(TeamSettingsPatch.safeParse({}).success).toBe(false);
	});
});

describe('the thresholds that apply', () => {
	it('are the defaults (5 %, 20 %) when the team set none', () => {
		for (const s of [{}, { portfolio: {} }, null, undefined]) {
			expect(teamThresholds(s)).toBeNull();
			expect(appliedThresholds(s)).toEqual({ ...EWR_THRESHOLDS, source: 'default' });
		}
		expect(appliedThresholds({})).toEqual({ green: 5, amber: 20, source: 'default' });
	});
	it('are the team’s when set', () => {
		expect(appliedThresholds({ portfolio: { thresholds: { green: 10, amber: 30 } } })).toEqual({ green: 10, amber: 30, source: 'team' });
	});
	it('fall back to the defaults, never a guess, for a document that does not parse', () => {
		expect(appliedThresholds({ portfolio: { thresholds: { green: 50, amber: 10 } } })).toEqual({ green: 5, amber: 20, source: 'default' });
	});
});

describe('applySettingsPatch', () => {
	it('sets, replaces and removes the thresholds, dropping an empty section', () => {
		const set = applySettingsPatch({}, { portfolio: { thresholds: { green: 10, amber: 30 } } });
		expect(set).toEqual({ portfolio: { thresholds: { green: 10, amber: 30 } } });
		const replaced = applySettingsPatch(set, { portfolio: { thresholds: { green: 2, amber: 8 } } });
		expect(replaced).toEqual({ portfolio: { thresholds: { green: 2, amber: 8 } } });
		expect(applySettingsPatch(replaced, { portfolio: { thresholds: null } })).toEqual({});
	});
	it('never changes the document it was given', () => {
		const current = { portfolio: { thresholds: { green: 10, amber: 30 } } };
		applySettingsPatch(current, { portfolio: { thresholds: null } });
		expect(current).toEqual({ portfolio: { thresholds: { green: 10, amber: 30 } } });
	});
});
