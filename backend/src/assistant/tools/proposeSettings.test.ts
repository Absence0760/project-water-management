// propose_settings without a database (issues #610, #640): the arguments, the
// goal's rule (a calibrated parameter is a recalibration's only, an outcome
// changes management levers only), the patch and the scenario ops it builds,
// the save's refusals that need no query, the engine resolver's objections,
// and the card: a title built from the accepted changes, never the model's.
// The DB test (proposeSettings.db.test.ts) runs it against a real project
// under RLS. Synthetic names and values only.
import { defaultProjectSettings, type ModelInput, type ProjectModel, type ProjectSettings } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { node } from '../../__tests__/helpers.js';
import type { Db } from '../../db/tx.js';
import { mergeSettings } from '../../projects/settings.js';
import { SETTING_KINDS } from '../settingKinds.js';
import type { AssistantProposal, ToolContext, ToolResult } from '../types.js';
import {
	buildPatch,
	MANAGEMENT_NODE_FIELDS,
	MANAGEMENT_TRANSFER_FIELDS,
	NOT_PROPOSED,
	proposalTitle,
	proposeSettings,
	proposeSettingsTool,
	resolverObjections,
	SETTING_KEYS,
	TITLE_MAX,
	type LoadBase
} from './proposeSettings.js';

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

// The run an outcome proposal builds its scenario on: an outlet gauge, unit Hill Dam with a dam taking 40 % of its
// own runoff, unit Valley below it, a transfer from Hill Dam to Valley, and an other water user.
const outlet = node('Outlet', null);
const hill = node('Hill Dam', outlet.id, { pctRunoffToDam: 0.4, damCapacityM3: 400_000 });
const valley = node('Valley', outlet.id, { damCapacityM3: 0, pctRunoffToDam: 0 });
const town = node('Town', outlet.id, { kind: 'user', damCapacityM3: 0, userDemandM3Day: new Array(12).fill(100), userReturnPct: 0, userPriority: 'priority' });
const TRANSFER_ID = '00000000-0000-4000-8000-0000000000aa';
const RUN_ID = '00000000-0000-4000-8000-0000000000bb';
const BASE: ModelInput = {
	settings: mergeSettings({}) as unknown as ModelInput['settings'],
	model: {
		nodes: [outlet, hill, valley, town],
		crops: [],
		cropAreas: [],
		transfers: [{ id: TRANSFER_ID, fromNodeId: hill.id, toNodeId: valley.id, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], maxRateM3s: 0.05, dailyCapM3: null, minStoragePct: 0.1, enabled: true, priority: 0 }]
	} as unknown as ProjectModel,
	series: {}
};
const loadBase: LoadBase = async () => ({ runId: RUN_ID, input: structuredClone(BASE) });

const run = (args: unknown, stored: unknown = {}, sql: string[] = []) => proposeSettings(ctx(stored, sql), args, loadBase);
const errorOf = (r: ToolResult) => (r.ok ? null : r.error);
const proposalOf = (r: ToolResult): AssistantProposal => {
	if (!r.ok || !r.proposal) throw new Error(`no proposal: ${JSON.stringify(r)}`);
	return r.proposal;
};
const recal = (changes: unknown[]) => ({ goal: 'recalibration', changes });
const outcome = (changes: unknown[]) => ({ goal: 'outcome', changes });

describe('propose_settings: a recalibration or correction is a settings patch', () => {
	it('returns the patch, each change with its own lines and reason, and a title built from the changes', async () => {
		const p = proposalOf(
			await run(
				recal([
					{ key: 'lakeEvapFactor', value: 0.8, reason: 'The dams lose too little water in summer.' },
					{ key: 'gr4j.x1', value: 420, reason: 'Peaks are too high.' },
					{ key: 'gr4j.x3', value: 120, reason: 'Recessions fall too fast.' }
				])
			)
		);
		expect(p.goal).toBe('recalibration');
		expect(p.apply).toEqual({ kind: 'settings', patch: { lakeEvapFactor: 0.8, gr4j: { x1: 420, x3: 120 } } });
		const d = defaultProjectSettings();
		expect(p.changes).toHaveLength(3);
		expect(p.changes[0]).toEqual({ label: 'Dam evaporation factor (× A-pan)', lines: [`Dam evaporation factor (× A-pan): ${d.lakeEvapFactor} → 0.8`], reason: 'The dams lose too little water in summer.' });
		// Each GR4J field's lines are its own: X1's change shows X1 alone, with its own reason.
		expect(p.changes[1]!.lines).toHaveLength(1);
		expect(p.changes[1]!.lines[0]).toMatch(/X1.*350.*420/);
		expect(p.changes[1]!.reason).toBe('Peaks are too high.');
		expect(p.changes[2]!.lines[0]).toMatch(/X3/);
		// The title names exactly the accepted changes, under the goal.
		expect(p.title).toBe(`Recalibration: ${p.changes.map((c) => c.label).join('; ')}`);
	});

	it('refuses a setting that doesn’t exist, and one the assistant never proposes', async () => {
		expect(errorOf(await run(recal([{ key: 'turboMode', value: true, reason: 'r' }])))).toContain('turboMode: not a setting');
		for (const key of Object.keys(NOT_PROPOSED)) {
			expect(SETTING_KEYS).toContain(key);
			for (const goal of ['recalibration', 'correction', 'outcome'])
				expect(errorOf(await run({ goal, changes: [{ key, value: null, reason: 'r' }] }))).toBe(`${key}: ${NOT_PROPOSED[key]}`);
		}
		// A field a group doesn't have is refused by the group's strict schema.
		expect(errorOf(await run(recal([{ key: 'gr4j.x9', value: 1, reason: 'r' }])))).toContain('the save would refuse this');
	});

	it('refuses a value out of range, with the setting it was for', async () => {
		const err = errorOf(await run(recal([{ key: 'lakeEvapFactor', value: 5, reason: 'r' }])));
		expect(err).toMatch(/^the save would refuse this: lakeEvapFactor: /);
	});

	it('refuses what the save itself refuses: a flat-line cap below its floor', async () => {
		const err = errorOf(
			await run(recal([{ key: 'dataQuality.flatlineFlowMaxDays', value: 2 }, { key: 'dataQuality.flatlineFlowMinDays', value: 30 }].map((c) => ({ ...c, reason: 'r' }))))
		);
		expect(err).toContain("the flow flat-line cap (2 days) can't be below its floor (30 days)");
	});

	it('refuses a proposal that changes nothing', async () => {
		const d = defaultProjectSettings();
		expect(errorOf(await run(recal([{ key: 'lakeEvapFactor', value: d.lakeEvapFactor, reason: 'r' }])))).toContain('this changes nothing');
	});

	it('refuses arguments that aren’t the tool’s shape, or aren’t JSON', async () => {
		expect(errorOf(await run('{"changes": ['))).toContain('not valid JSON');
		expect(errorOf(await run(recal([])))).toContain('the arguments don’t fit');
		expect(errorOf(await run({ changes: [{ key: 'lakeEvapFactor', value: 0.8, reason: 'r' }] }))).toContain('goal');
		expect(errorOf(await run(recal([{ key: 'lakeEvapFactor', value: 0.8, reason: 'r', extra: 1 }])))).toContain('the arguments don’t fit');
		expect(errorOf(await run(recal([{ key: 'lakeEvapFactor', reason: 'r' }])))).toContain('lakeEvapFactor: no value given');
		expect(errorOf(await run(recal([{ key: 'lakeEvapFactor', node: 'Hill Dam', value: 1, reason: 'r' }])))).toContain('name exactly one of key, node, transfer or demand');
	});

	it('takes no title from the model: a summary is refused with why, so the card can’t claim a change it doesn’t make', async () => {
		const err = errorOf(
			await run({ goal: 'outcome', summary: 'reduce the dam’s runoff capture and cap the transfer', changes: [{ key: 'gr4j.x1', value: 1200, reason: 'r' }] })
		);
		expect(err).toMatch(/^summary: there is no summary to write: the card’s title is built from the changes you make/);
	});

	it('never writes: it only reads the project and its network', async () => {
		const sql: string[] = [];
		await run(recal([{ key: 'lakeEvapFactor', value: 0.8, reason: 'r' }]), {}, sql);
		expect(sql.length).toBeGreaterThan(0);
		for (const s of sql) expect(s.trim()).toMatch(/^SELECT/i);
	});

	it('offers a JSON Schema the model can follow, with no title or summary field', () => {
		expect(proposeSettingsTool.spec.name).toBe('propose_settings');
		expect(proposeSettingsTool.spec.parameters).toMatchObject({ type: 'object', required: ['goal', 'changes'] });
		expect(Object.keys((proposeSettingsTool.spec.parameters as { properties: object }).properties)).toEqual(['goal', 'changes']);
	});
});

describe('propose_settings: what each goal may change (issue #640)', () => {
	it('refuses a calibrated parameter changed for an outcome, saying why and what to use instead', async () => {
		const err = errorOf(await run(outcome([{ key: 'gr4j.x1', value: 1200, reason: 'A smaller store lets more rain run off in dry years.' }])));
		expect(err).toMatch(/^gr4j\.x1: a calibrated parameter \(fitted to the observed flow\) is never changed to improve an outcome/);
		expect(err).toContain('management lever');
		// The whole group, a pan coefficient, the CHIRPS bias settings and the calibration zones' own X1–X4 are calibrated too.
		for (const key of ['gr4j', 'panCoefficient', 'pe', 'chirpsBiasCorrection', 'chirpsQuantileMap', 'calibrationZones'])
			expect(errorOf(await run(outcome([{ key, value: null, reason: 'r' }])))).toContain('a calibrated parameter');
	});

	it('allows the same change framed as a recalibration (the positive control)', async () => {
		const p = proposalOf(await run(recal([{ key: 'gr4j.x1', value: 1200, reason: 'Simulated flow is too low against the observed record.' }])));
		expect(p.apply).toEqual({ kind: 'settings', patch: { gr4j: { x1: 1200 } } });
		expect(p.title).toMatch(/^Recalibration: .*X1/);
	});

	it('refuses a calibrated parameter in a correction, and moving the goalposts (the EWR) for an outcome or a recalibration', async () => {
		expect(errorOf(await run({ goal: 'correction', changes: [{ key: 'gr4j.x2', value: 0, reason: 'r' }] }))).toContain('changes only in a recalibration');
		expect(errorOf(await run(outcome([{ key: 'ewrPragmaticM3PerDay', value: new Array(12).fill(1), reason: 'r' }])))).toContain('moves the goalposts');
		expect(errorOf(await run(recal([{ key: 'ewrPragmaticM3PerDay', value: new Array(12).fill(1), reason: 'r' }])))).toContain('only as a correction');
		expect(errorOf(await run(outcome([{ key: 'apanMm', value: new Array(12).fill(100), reason: 'r' }])))).toContain('describes the catchment or its data');
		// Positive control: a correction may set the EWR it is judged by.
		expect((await run({ goal: 'correction', changes: [{ key: 'ewrPragmaticM3PerDay', value: new Array(12).fill(1), reason: 'r' }] })).ok).toBe(true);
	});

	it('refuses a management lever outside an outcome: it is tried as a scenario', async () => {
		expect(errorOf(await run(recal([{ node: 'Hill Dam', field: 'pctRunoffToDam', value: 0.2, reason: 'r' }])))).toContain('a management lever is changed to improve an outcome');
		expect(errorOf(await run({ goal: 'correction', changes: [{ demand: { factor: 0.9 }, reason: 'r' }] }))).toContain('a management lever');
	});

	it('classes every setting a save accepts, or never proposes it', () => {
		expect(SETTING_KEYS.filter((k) => !SETTING_KINDS[k] && !NOT_PROPOSED[k])).toEqual([]);
		expect(Object.keys(SETTING_KINDS).filter((k) => !SETTING_KEYS.includes(k))).toEqual([]);
	});
});

describe('propose_settings: an outcome is management levers, tried as a scenario on the run', () => {
	it('a unit’s dam runoff capture: a node.set op on the run, with the engine’s diff line and its reason', async () => {
		const p = proposalOf(await run(outcome([{ node: 'hill dam', field: 'pctRunoffToDam', value: 0.2, reason: 'The dam holds back dry-year runoff.' }])));
		expect(p.goal).toBe('outcome');
		expect(p.apply).toEqual({ kind: 'scenario', baseRunId: RUN_ID, ops: [{ op: 'node.set', nodeId: hill.id, field: 'pctRunoffToDam', value: 0.2 }] });
		expect(p.changes).toEqual([{ label: 'Hill Dam: own runoff to dam', lines: ['Hill Dam: own runoff to dam 40% → 20%'], reason: 'The dam holds back dry-year runoff.' }]);
		expect(p.title).toBe('Management change: Hill Dam: own runoff to dam');
	});

	it('a transfer’s rule, by its id or by "From → To"', async () => {
		for (const ref of [TRANSFER_ID, 'Hill Dam → Valley', 'hill dam -> valley']) {
			const p = proposalOf(await run(outcome([{ transfer: ref, field: 'minStoragePct', value: 0.5, reason: 'Move water only when the dam is fuller.' }])));
			expect(p.apply).toEqual({ kind: 'scenario', baseRunId: RUN_ID, ops: [{ op: 'transfer.set', transferId: TRANSFER_ID, field: 'minStoragePct', value: 0.5 }] });
			expect(p.changes[0]!.label).toBe('transfer Hill Dam → Valley: minimum dam storage to transfer');
			expect(p.changes[0]!.lines.length).toBeGreaterThan(0);
		}
		expect(errorOf(await run(outcome([{ transfer: 'Valley → Hill Dam', field: 'months', value: [1], reason: 'r' }])))).toContain('not found');
	});

	it('each lever validates and round-trips: hands-off flow, release, supply, months, demand, the drought restriction', async () => {
		const handsOff = new Array(12).fill(500);
		const drought = { reviewDates: ['10-01'], levels: [{ label: 'Level 1', belowPct: 0.6, cuts: { crops: 0.3 } }] };
		const changes = [
			{ node: hill.id, field: 'handsOffM3Day', value: handsOff, reason: 'Keep a low flow past the dam.' },
			{ node: 'Hill Dam', field: 'damReleaseRule', value: 'passInflow', reason: 'Pass the inflow in the dry months.' },
			{ transfer: TRANSFER_ID, field: 'months', value: [1, 2, 3, 4, 5, 6], reason: 'Not in the dry season.' },
			{ node: 'Town', field: 'userRestrictionPct', value: 0.1, reason: 'A standing restriction.' },
			{ demand: { factor: 0.9, nodes: ['Valley'], months: [7, 8, 9] }, reason: 'Less irrigation in late winter.' },
			{ key: 'droughtRestriction', value: drought, reason: 'Restrict as the dams empty.' }
		];
		const p = proposalOf(await run(outcome(changes)));
		if (p.apply.kind !== 'scenario') throw new Error('not a scenario');
		expect(p.apply.ops).toEqual([
			// A unit's ops side by side (one edit group), in the order its first change came.
			{ op: 'node.set', nodeId: hill.id, field: 'handsOffM3Day', value: handsOff },
			{ op: 'node.set', nodeId: hill.id, field: 'damReleaseRule', value: 'passInflow' },
			{ op: 'transfer.set', transferId: TRANSFER_ID, field: 'months', value: [1, 2, 3, 4, 5, 6] },
			{ op: 'node.set', nodeId: town.id, field: 'userRestrictionPct', value: 0.1 },
			{ op: 'demand.scale', factor: 0.9, nodeIds: [valley.id], months: [7, 8, 9] },
			{ op: 'settings.set', path: 'droughtRestriction', value: drought }
		]);
		expect(p.changes.map((c) => c.reason)).toEqual(changes.map((c) => c.reason));
		for (const c of p.changes) expect(c.lines.length, c.label).toBeGreaterThan(0);
		expect(p.changes.map((c) => c.label)).toEqual([
			'Hill Dam: hands-off flow by month',
			'Hill Dam: dam release rule',
			'transfer Hill Dam → Valley: months',
			'Town: fixed restriction',
			'demand × 0.9 (Valley, months 7 8 9)',
			'drought restriction rule'
		]);
	});

	it('refuses a field that describes the catchment, not how it is managed, and a value the scenario refuses', async () => {
		for (const field of ['areaKm2', 'damCapacityM3', 'reachLossFrac', 'name'])
			expect(errorOf(await run(outcome([{ node: 'Hill Dam', field, value: 1, reason: 'r' }])))).toContain(`${field} is not a management lever`);
		expect(errorOf(await run(outcome([{ transfer: TRANSFER_ID, field: 'toNodeId', value: null, reason: 'r' }])))).toContain('toNodeId is not a transfer rule');
		expect(errorOf(await run(outcome([{ node: 'Hill Dam', field: 'pctRunoffToDam', value: 2, reason: 'r' }])))).toMatch(/^the scenario would refuse this: /);
		// A farm's field on an other water user: the engine's own check.
		expect(errorOf(await run(outcome([{ node: 'Town', field: 'handsOffEwr', value: true, reason: 'r' }])))).toMatch(/^the scenario would not apply: /);
		expect(errorOf(await run(outcome([{ node: 'Nowhere', field: 'pctRunoffToDam', value: 0.1, reason: 'r' }])))).toContain('Nowhere: no unit or water user');
		expect(errorOf(await run(outcome([{ node: 'Hill Dam', field: 'pctRunoffToDam', value: 0.4, reason: 'r' }])))).toContain('this changes nothing');
		expect(errorOf(await run(outcome([1, 2].map(() => ({ node: 'Hill Dam', field: 'pctRunoffToDam', value: 0.2, reason: 'r' })))))).toContain('named twice');
	});

	it('answers the run’s refusal in its words (no run, a scenario run)', async () => {
		const r = await proposeSettings(ctx(), outcome([{ node: 'Hill Dam', field: 'pctRunoffToDam', value: 0.2, reason: 'r' }]), async () => ({ error: 'this project has no run yet' }));
		expect(r).toEqual({ ok: false, error: 'this project has no run yet' });
	});

	it('names only what it lets an outcome change', () => {
		expect(Object.keys(MANAGEMENT_NODE_FIELDS)).toContain('pctRunoffToDam');
		expect(Object.keys(MANAGEMENT_NODE_FIELDS)).not.toContain('areaKm2');
		expect(Object.keys(MANAGEMENT_TRANSFER_FIELDS)).not.toContain('fromNodeId');
	});
});

describe('proposalTitle', () => {
	it('lists the labels once each under the goal, and says how many more past its length', () => {
		expect(proposalTitle('outcome', ['A', 'B', 'A'])).toBe('Management change: A; B');
		const long = Array.from({ length: 30 }, (_, i) => `Unit number ${i}: own runoff to dam`);
		const t = proposalTitle('outcome', long);
		expect(t.length).toBeLessThanOrEqual(TITLE_MAX);
		expect(t).toMatch(/ and \d+ more$/);
	});
});

describe('buildPatch', () => {
	const current = mergeSettings({}) as unknown as Record<string, unknown>;
	const c = (key: string, value: unknown) => ({ key, value, reason: 'r' });

	it('puts group fields under their group and whole values under their key', () => {
		expect(buildPatch([c('gr4j.x1', 400), c('calibration.rainThresholdMm', 2), c('februaryDays', 29)], current)).toEqual({
			patch: { gr4j: { x1: 400 }, calibration: { rainThresholdMm: 2 }, februaryDays: 29 },
			reasons: { 'gr4j.x1': 'r', 'calibration.rainThresholdMm': 'r', februaryDays: 'r' }
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
