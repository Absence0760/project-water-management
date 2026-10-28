// propose_settings without a database (issue #610): the arguments, the
// patch it builds, the save's refusals that need no query, the engine
// resolver's objections and the diff lines. The DB test
// (proposeSettings.db.test.ts) runs it against a real project under RLS.
import { defaultProjectSettings, type ProjectModel, type ProjectSettings } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../db/tx.js';
import { mergeSettings } from '../../projects/settings.js';
import type { ToolContext, ToolResult } from '../types.js';
import { buildPatch, NOT_PROPOSED, proposalDiff, proposeSettings, proposeSettingsTool, resolverObjections, SETTING_KEYS } from './proposeSettings.js';

const MODEL: ProjectModel = { nodes: [], transfers: [], crops: [] } as unknown as ProjectModel;

/** A database that holds one project's settings and an empty network, recording every statement. */
function fakeDb(stored: unknown, sql: string[] = []): Db {
	return {
		query: async (text: string) => {
			sql.push(text);
			if (/FROM project WHERE id/.test(text)) return { rows: [{ settings: stored, time_zone: 'Africa/Johannesburg' }] };
			return { rows: [{ model: structuredClone(MODEL) }] };
		}
	} as unknown as Db;
}
const ctx = (stored: unknown = {}, sql: string[] = []): ToolContext => ({ db: fakeDb(stored, sql), userId: 'u', projectId: '00000000-0000-4000-8000-000000000001', runId: null });

const run = (args: unknown, stored: unknown = {}, sql: string[] = []) => proposeSettings(ctx(stored, sql), args);
const errorOf = (r: ToolResult) => (r.ok ? null : r.error);

describe('propose_settings', () => {
	it('returns a validated proposal: the patch, a reason per key, the summary and the engine’s diff lines', async () => {
		const r = await run({
			changes: [
				{ key: 'lakeEvapFactor', value: 0.8, reason: 'The dams lose too little water in summer.' },
				{ key: 'gr4j.x1', value: 420, reason: 'Peaks are too high.' },
				{ key: 'gr4j.x3', value: 120, reason: 'Recessions fall too fast.' }
			],
			summary: 'Tune dam evaporation and the GR4J stores'
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.proposal).toMatchObject({
			patch: { lakeEvapFactor: 0.8, gr4j: { x1: 420, x3: 120 } },
			reasons: { lakeEvapFactor: 'The dams lose too little water in summer.', gr4j: 'Peaks are too high.; Recessions fall too fast.' },
			summary: 'Tune dam evaporation and the GR4J stores'
		});
		const d = defaultProjectSettings();
		expect(r.proposal!.diff).toEqual(
			expect.arrayContaining([
				{ label: 'Dam evaporation factor (× A-pan)', before: String(d.lakeEvapFactor), after: '0.8' },
				expect.objectContaining({ label: expect.stringContaining('X1'), before: expect.stringContaining('350'), after: expect.stringContaining('420') })
			])
		);
		expect(r.data).toMatchObject({ proposed: true, changes: r.proposal!.diff.length });
	});

	it('refuses a setting that doesn’t exist, and one the assistant never proposes', async () => {
		expect(errorOf(await run({ changes: [{ key: 'turboMode', value: true, reason: 'r' }], summary: 's' }))).toContain('turboMode: not a setting');
		for (const key of Object.keys(NOT_PROPOSED)) {
			expect(SETTING_KEYS).toContain(key);
			expect(errorOf(await run({ changes: [{ key, value: null, reason: 'r' }], summary: 's' }))).toBe(`${key}: ${NOT_PROPOSED[key]}`);
		}
		// A field a group doesn't have is refused by the group's strict schema.
		expect(errorOf(await run({ changes: [{ key: 'gr4j.x9', value: 1, reason: 'r' }], summary: 's' }))).toContain('the save would refuse this');
	});

	it('refuses a value out of range, with the setting it was for', async () => {
		const err = errorOf(await run({ changes: [{ key: 'lakeEvapFactor', value: 5, reason: 'r' }], summary: 's' }));
		expect(err).toMatch(/^the save would refuse this: lakeEvapFactor: /);
	});

	it('refuses what the save itself refuses: a baseline allocation mode, a flat-line cap below its floor', async () => {
		expect(errorOf(await run({ changes: [{ key: 'allocationMode', value: 'cap', reason: 'r' }], summary: 's' }))).toContain('the baseline only compares registered volumes');
		const err = errorOf(await run({ changes: [{ key: 'dataQuality.flatlineFlowMaxDays', value: 2 }, { key: 'dataQuality.flatlineFlowMinDays', value: 30 }].map((c) => ({ ...c, reason: 'r' })), summary: 's' }));
		expect(err).toContain("the flow flat-line cap (2 days) can't be below its floor (30 days)");
	});

	it('refuses a proposal that changes nothing', async () => {
		const d = defaultProjectSettings();
		expect(errorOf(await run({ changes: [{ key: 'lakeEvapFactor', value: d.lakeEvapFactor, reason: 'r' }], summary: 's' }))).toContain('this changes nothing');
	});

	it('refuses arguments that aren’t the tool’s shape, or aren’t JSON', async () => {
		expect(errorOf(await run('{"changes": [', {}))).toContain('not valid JSON');
		expect(errorOf(await run({ changes: [], summary: 's' }))).toContain('the arguments don’t fit');
		expect(errorOf(await run({ changes: [{ key: 'lakeEvapFactor', value: 0.8, reason: 'r' }] }))).toContain('summary');
		expect(errorOf(await run({ changes: [{ key: 'lakeEvapFactor', value: 0.8, reason: 'r', extra: 1 }], summary: 's' }))).toContain('the arguments don’t fit');
		expect(errorOf(await run({ changes: [{ key: 'lakeEvapFactor', reason: 'r' }], summary: 's' }))).toContain('changes.0.value');
	});

	it('never writes: it only reads the project and its network', async () => {
		const sql: string[] = [];
		await run({ changes: [{ key: 'lakeEvapFactor', value: 0.8, reason: 'r' }], summary: 's' }, {}, sql);
		expect(sql.length).toBeGreaterThan(0);
		for (const s of sql) expect(s.trim()).toMatch(/^SELECT/i);
	});

	it('offers a JSON Schema the model can follow', () => {
		expect(proposeSettingsTool.spec.name).toBe('propose_settings');
		expect(proposeSettingsTool.spec.parameters).toMatchObject({ type: 'object', required: ['changes', 'summary'] });
	});
});

describe('buildPatch', () => {
	const current = mergeSettings({}) as unknown as Record<string, unknown>;
	const c = (key: string, value: unknown) => ({ key, value, reason: 'r' });

	it('puts group fields under their group and whole values under their key', () => {
		expect(buildPatch([c('gr4j.x1', 400), c('calibration.rainThresholdMm', 2), c('februaryDays', 29)], current)).toEqual({
			patch: { gr4j: { x1: 400 }, calibration: { rainThresholdMm: 2 }, februaryDays: 29 },
			reasons: { gr4j: 'r', calibration: 'r', februaryDays: 'r' }
		});
	});

	it('refuses a field of a setting changed whole, a key named twice, and whole and field together', () => {
		expect(buildPatch([c('pe.kind', 'pan')], current)).toEqual({ error: 'pe.kind: pe is changed whole, under the key pe' });
		expect(buildPatch([c('februaryDays.x', 1)], current)).toEqual({ error: 'februaryDays.x: februaryDays is changed whole, under the key februaryDays' });
		expect(buildPatch([c('gr4j.x1', 1), c('gr4j.x1', 2)], current)).toEqual({ error: 'gr4j.x1: named twice' });
		expect(buildPatch([c('gr4j', { x1: 1 }), c('gr4j.x2', 2)], current)).toEqual({ error: 'gr4j: changed whole and field by field in one proposal' });
		expect(buildPatch([c('gr4j.x2', 2), c('gr4j', { x1: 1 })], current)).toEqual({ error: 'gr4j: changed whole and field by field in one proposal' });
		expect(buildPatch([c('a.b.c', 1)], current)).toMatchObject({ error: expect.stringContaining('one field of a group') });
	});
});

describe('resolverObjections', () => {
	it('names what the engine’s resolver would replace with a default, and nothing the stored settings already had', () => {
		const ok = mergeSettings({});
		expect(resolverObjections(ok, mergeSettings({ lakeEvapFactor: 0.7 }))).toEqual([]);
		const bad = { ...ok, februaryDays: 31 } as ProjectSettings;
		expect(resolverObjections(ok, bad)).toEqual([expect.stringContaining('February days')]);
		expect(resolverObjections(bad, bad)).toEqual([]);
	});
});

describe('proposalDiff', () => {
	it('shows a setting the engine’s input diff has no words for as JSON before and after', () => {
		const before = mergeSettings({});
		const after = mergeSettings({ autoRun: { enabled: true } });
		expect(proposalDiff(before, after, MODEL)).toEqual([{ label: 'autoRun', before: 'null', after: '{"enabled":true}' }]);
	});
});
