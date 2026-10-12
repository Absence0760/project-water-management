// A cap or full-allocation run published or outlooked before 213 (issue #523
// finding I, round 4): a viewer kept from each registered volume previewing a
// farm, or reading the outlook, gets none of its figures; the linked farmer
// keeps their own farm, the editor reads everything (positive controls). New
// ones can't be made: the outlook is refused as publishing is
// (publish/publication.db.test.ts). Synthetic data only: such a run is made
// by marking a compare-only run's summary as the engine recorded a cap.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { buildLadder, clearLadderJobs, SAMPLE, type LadderCtx } from '../__tests__/routeSamples.js';
import { OUTLOOK_ALLOCATION_MODE_REFUSED } from '../outlooks/store.js';
import { publishOutlook } from '../outlooks/publication.js';
import { ALLOCATION_MODE_NOT_PUBLISHABLE } from '../publish/publish.js';

const ctx = {} as LadderCtx;
let at: string;
let later: string;

/** Mark a run as one that ran in `mode` (only a run from before 213 can be a published cap or full allocation). */
const markMode = (runId: string, mode: string) =>
	asOwner(`UPDATE model_run SET summary = jsonb_set(summary, '{allocations}', $2::jsonb) WHERE id = $1`, [
		runId,
		JSON.stringify({ mode, tolerance: 0.1, used: 1, notMatched: 0, nodes: [] })
	]);

beforeAll(async () => {
	Object.assign(ctx, await buildLadder('River'));
	at = `/projects/${ctx.projectId}`;
	// A farm outlook publication of the ladder's outlook (on the ladder run), current until 2100.
	await withUser(ctx.owner.id, async (db) => {
		const { rows } = await db.query<{ id: string }>(
			`INSERT INTO outlook_publication (project_id, outlook_id, level_id, level_label, decision_date, season_end, engine_version)
			 VALUES ($1, $2, '0', '85 %', '2099-10-01', '2100-04-30', 'x') RETURNING id`,
			[ctx.projectId, ctx.ids.outlookId]
		);
		await db.query(`INSERT INTO outlook_publication_farm (publication_id, project_id, node_id, view) VALUES ($1, $2, $3, '{"demandMet": 0.8}'), ($1, $2, $4, '{"demandMet": 0.7}')`, [
			rows[0]!.id,
			ctx.projectId,
			ctx.farmId,
			ctx.otherFarmId
		]);
	});
	// The published ladder run ran in cap mode (before 213); its outlook's base is that run.
	await markMode(ctx.runId, 'cap');
	// A later compare-only run, for the history once a publication supersedes the cap one.
	later = (await ctx.owner.call('POST', `${at}/runs`, { label: 'Compare only' })).body.run.id as string;
}, 300_000);
afterAll(() => clearLadderJobs(ctx));

describe('the farm view of a published cap or full-allocation run (#523 I)', () => {
	it('is refused to a viewer kept from the volumes previewing a farm, with the reason, on every farm route', async () => {
		for (const path of ['', '/series?key=supplied', '/export.csv', '/history', '/map']) {
			const r = await ctx.viewer.call('GET', `${at}/farm/${ctx.otherFarmId}${path}`);
			expect([path, r.status, r.body?.code]).toEqual([path, 403, 'allocation_series_withheld']);
		}
	});

	it('positive controls: the linked farmer reads their own farm and its outlook; the editor previews it; the switch on lets the viewer', async () => {
		const own = await ctx.farmer.call('GET', `${at}/farm/${ctx.farmId}`);
		expect(own.status).toBe(200);
		expect(own.body.outlook).not.toBeNull();
		expect((await ctx.editor.call('GET', `${at}/farm/${ctx.otherFarmId}`)).status).toBe(200);
		expect((await ctx.owner.call('PUT', `${at}/allocations/viewer-units`, { on: true })).status).toBe(200);
		try {
			expect((await ctx.viewer.call('GET', `${at}/farm/${ctx.otherFarmId}`)).status).toBe(200);
		} finally {
			expect((await ctx.owner.call('PUT', `${at}/allocations/viewer-units`, { on: false })).status).toBe(200);
		}
	});

	it('once a compare-only run is published: the preview opens, without the cap publication in its history or the cap-based outlook', async () => {
		expect((await ctx.owner.call('POST', `${at}/publication`, { runId: later })).status).toBe(201);
		const view = await ctx.viewer.call('GET', `${at}/farm/${ctx.otherFarmId}`);
		expect(view.status).toBe(200);
		expect(view.body.outlook).toBeNull();
		const history = (await ctx.viewer.call('GET', `${at}/farm/${ctx.otherFarmId}/history`)).body.publications as unknown[];
		const editors = (await ctx.editor.call('GET', `${at}/farm/${ctx.otherFarmId}/history`)).body.publications as unknown[];
		expect([history.length, editors.length]).toEqual([1, 2]);
		expect((await ctx.editor.call('GET', `${at}/farm/${ctx.otherFarmId}`)).body.outlook).not.toBeNull();
	});
});

describe('an outlook on a cap or full-allocation base (#523 I)', () => {
	it('is withheld from that viewer, and said; the editor reads its result (positive control)', async () => {
		const mine = (await ctx.viewer.call('GET', `${at}/outlooks/${ctx.ids.outlookId}`)).body.outlook;
		expect([mine.result, mine.triggers, mine.withheld]).toEqual([null, null, ['result', 'triggers']]);
		const theirs = (await ctx.editor.call('GET', `${at}/outlooks/${ctx.ids.outlookId}`)).body.outlook;
		expect(theirs.result).not.toBeNull();
		expect(theirs.withheld).toBeUndefined();
	});

	it('can’t be made from such a run, nor published to farmers; a compare-only base is made (positive control)', async () => {
		const body = SAMPLE['POST /projects/:id/outlooks']!(ctx).body as Record<string, unknown>;
		for (const mode of ['cap', 'fullAllocation']) {
			await markMode(ctx.runId, mode);
			const refused = await ctx.editor.call('POST', `${at}/outlooks`, { ...body, baseRunId: ctx.runId });
			expect([refused.status, refused.body.error]).toEqual([409, OUTLOOK_ALLOCATION_MODE_REFUSED]);
		}
		const made = await ctx.editor.call('POST', `${at}/outlooks`, { ...body, baseRunId: later });
		expect(made.status, JSON.stringify(made.body)).toBe(202);
		// Publishing to farmers (the route asks a fresh second factor first, so the store's function is called as the editor).
		await expect(withUser(ctx.editor.id, (db) => publishOutlook(db, ctx.projectId, ctx.ids.outlookId!, '0'))).rejects.toThrow(ALLOCATION_MODE_NOT_PUBLISHABLE);
	});
});

// Round 5 (I): a yield computed on a cap or full-allocation run carries the capped use of the units above the dam.
describe('a yield on a cap or full-allocation run (#523 I)', () => {
	let yieldId: string;
	beforeAll(async () => {
		await markMode(ctx.runId, 'cap');
		yieldId = await withUser(ctx.owner.id, async (db) => {
			const { rows } = await db.query<{ id: string }>(
				`INSERT INTO yield_result (project_id, run_id, node_id, kind, params, points, engine_version) VALUES ($1, $2, $3, 'firm', '{}', '{"point": {"boundM3Day": 4321}}', '1.0.0') RETURNING id`,
				[ctx.projectId, ctx.runId, ctx.farmId]
			);
			return rows[0]!.id;
		});
	});

	it('is listed to that viewer without its points, and said; the editor and a viewer the switch lets read them (positive controls)', async () => {
		const find = async (u: LadderCtx['viewer']) => ((await u.call('GET', `${at}/yield?runId=${ctx.runId}`)).body.results as { id: string; points: unknown; withheld?: string[] }[]).find((r) => r.id === yieldId)!;
		expect(await find(ctx.viewer)).toMatchObject({ points: null, withheld: ['points'] });
		expect((await find(ctx.editor)).points).toEqual({ point: { boundM3Day: 4321 } });
		expect((await ctx.owner.call('PUT', `${at}/allocations/viewer-units`, { on: true })).status).toBe(200);
		try {
			expect((await find(ctx.viewer)).points).toEqual({ point: { boundM3Day: 4321 } });
		} finally {
			expect((await ctx.owner.call('PUT', `${at}/allocations/viewer-units`, { on: false })).status).toBe(200);
		}
		// A compare-only run's yield: served whole (the positive control for the rule).
		await markMode(ctx.runId, 'none');
		try {
			expect((await find(ctx.viewer)).points).toEqual({ point: { boundM3Day: 4321 } });
		} finally {
			await markMode(ctx.runId, 'cap');
		}
	});
});

// #523 G1c: a scenario's yield is judged by the mode it recorded it ran with (221), not by the scenario's current state.
describe('a yield on a scenario, by the allocation mode it ran with (#523 G1c)', () => {
	const ids = {} as Record<'cap' | 'none' | 'unknown', string>;
	beforeAll(async () => {
		await withUser(ctx.owner.id, async (db) => {
			for (const [key, mode] of [['cap', 'cap'], ['none', 'none'], ['unknown', null]] as const) {
				const { rows } = await db.query<{ id: string }>(
					`INSERT INTO yield_result (project_id, scenario_id, node_id, kind, params, points, engine_version, allocation_mode)
					 VALUES ($1, $2, $3, 'firm', '{}', '{"point": {"boundM3Day": 4321}}', '1.0.0', $4) RETURNING id`,
					[ctx.projectId, ctx.ids.sid, ctx.farmId, mode]
				);
				ids[key] = rows[0]!.id;
			}
		});
	});

	const points = async (u: LadderCtx['viewer']) => {
		const res = await u.call('GET', `${at}/yield?scenarioId=${ctx.ids.sid}`);
		expect(res.status).toBe(200);
		const byId = new Map((res.body.results as { id: string; points: unknown; withheld?: string[] }[]).map((r) => [r.id, r]));
		return { cap: byId.get(ids.cap)!, none: byId.get(ids.none)!, unknown: byId.get(ids.unknown)! };
	};
	const served = { point: { boundM3Day: 4321 } };
	const withheld = { points: null, withheld: ['points'] };

	it('withholds one that ran capped, and one from before 221, though the scenario now compares only; serves one that compared (positive control)', async () => {
		await markMode(ctx.runId, 'none');
		try {
			const v = await points(ctx.viewer);
			expect(v.cap).toMatchObject(withheld);
			expect(v.unknown).toMatchObject(withheld);
			expect(v.none.points).toEqual(served);
			expect(v.none.withheld).toBeUndefined();
			// The editor reads every one (positive control).
			const e = await points(ctx.editor);
			expect([e.cap.points, e.none.points, e.unknown.points]).toEqual([served, served, served]);
		} finally {
			await markMode(ctx.runId, 'cap');
		}
	});

	it('serves one that ran compare-only though the scenario’s base now caps', async () => {
		const v = await points(ctx.viewer);
		expect(v.none.points).toEqual(served);
		expect(v.cap).toMatchObject(withheld);
	});

	it('the column takes only an allocation mode', async () => {
		await expect(
			withUser(ctx.owner.id, (db) =>
				db.query(
					`INSERT INTO yield_result (project_id, scenario_id, node_id, kind, params, points, engine_version, allocation_mode) VALUES ($1, $2, $3, 'firm', '{}', '{}', '1.0.0', 'capped')`,
					[ctx.projectId, ctx.ids.sid, ctx.farmId]
				)
			)
		).rejects.toThrow(/check constraint/);
	});
});
