// A seasonal outlook published to farmers (issue #53 R5, farmer-view ask E3;
// 106_outlook_triggers_publication.sql): an editor publishes one level, each
// farm gets its own figures, a farmer sees only their own farm's (positive
// control: they do see theirs), a new publication ends the last, the WUA can
// withdraw it, and what was published never changes. The outlooks are
// planted complete (helpers.ts plantCompleteOutlook): the job is
// outlooks.db.test.ts's.
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, plantCompleteOutlook } from '../__tests__/helpers.js';
import { buildLadder, type LadderCtx } from '../__tests__/routeSamples.js';
import { withUser } from '../db/tx.js';

let c: LadderCtx;
let at: string;
beforeAll(async () => {
	c = await buildLadder('Pub');
	at = `/projects/${c.projectId}`;
}, 120_000);

const publish = (outlookId: string, levelId = '0', as = c.owner) => as.call('POST', `${at}/outlooks/${outlookId}/publish`, { levelId });
const farmPage = (nodeId = c.farmId, as = c.farmer) => as.call('GET', `${at}/farm/${nodeId}`);

describe('publishing an outlook to farmers', () => {
	it('an editor publishes one level; each farmer’s page shows their own farm’s figures only', async () => {
		const outlookId = await plantCompleteOutlook(c.owner.id, c.projectId, c.runId, [
			{ nodeId: c.farmId, p50: 0.8 },
			{ nodeId: c.otherFarmId, p50: 0.5 }
		]);
		const res = await publish(outlookId, '0', c.editor);
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.publication).toMatchObject({ outlookId, level: { id: '0', label: '85 %' }, decisionDate: '2099-10-01', seasonEnd: '2100-04-30', farms: 2, endedAt: null, engineVersion: 'x' });
		expect(res.body.publication.publishedBy).toBe('Pubeditor');

		// The farmer's page: their farm's figures (Farm A, 0.8), never Farm B's (0.5).
		const page = await farmPage();
		expect(page.status).toBe(200);
		expect(page.body.outlook).toMatchObject({ level: { id: '0', label: '85 %' }, decisionDate: '2099-10-01', seasonEnd: '2100-04-30', nYears: 12, demandYears: 12 });
		expect(page.body.outlook.demandMet.p50).toBe(0.8);
		expect(page.body.outlook.dam.capacityM3).toBe(100_000);
		expect(page.body.outlook.dam.seasonEndShare.p50).toBeCloseTo(0.5, 12);
		expect(page.body.outlook.dam.seasonEndShare.p90).toBeCloseTo(0.6, 12);
		expect(page.body.outlook.publishedAt).toEqual(expect.any(String));
		expect(JSON.stringify(page.body.outlook)).not.toContain(c.otherFarmId);
		// Farm B's page is not theirs to open.
		expect((await farmPage(c.otherFarmId)).status).toBe(404);

		// Under RLS: the farmer reads the publication and their own farm's row (positive control), not Farm B's.
		const rows = await withUser(c.farmer.id, async (db) => (await db.query('SELECT node_id AS "nodeId", view FROM outlook_publication_farm WHERE project_id = $1', [c.projectId])).rows);
		expect(rows.map((r) => r.nodeId)).toEqual([c.farmId]);
		expect(await withUser(c.farmer.id, async (db) => (await db.query('SELECT count(*)::int AS n FROM outlook_publication WHERE project_id = $1', [c.projectId])).rows[0].n)).toBe(1);
		// A viewer (the WUA's side) reads every farm's row.
		expect(await withUser(c.viewer.id, async (db) => (await db.query('SELECT count(*)::int AS n FROM outlook_publication_farm WHERE project_id = $1', [c.projectId])).rows[0].n)).toBe(2);
		// The outlook itself stays the WUA's: a farmer reads none of it.
		expect(await withUser(c.farmer.id, async (db) => (await db.query('SELECT count(*)::int AS n FROM seasonal_outlook WHERE project_id = $1', [c.projectId])).rows[0].n)).toBe(0);

		// The audit trail says who published what.
		const [ev] = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'outlook.published' ORDER BY id DESC LIMIT 1`, [c.projectId]);
		expect(ev!.subject).toMatchObject({ outlookId, level: { id: '0', label: '85 %' }, farms: 2 });

		// A viewer reads the current publication; a farmer isn't given the WUA's list.
		expect((await c.viewer.call('GET', `${at}/outlook-publication`)).body.publication).toMatchObject({ outlookId });
		expect((await c.farmer.call('GET', `${at}/outlook-publication`)).status).toBe(403);
	});

	it('only an editor publishes or withdraws', async () => {
		const outlookId = await plantCompleteOutlook(c.owner.id, c.projectId, c.runId, [{ nodeId: c.farmId }]);
		for (const u of [c.viewer, c.farmer, c.contributor]) {
			expect((await publish(outlookId, '0', u)).status).toBe(403);
			expect((await u.call('DELETE', `${at}/outlook-publication`)).status).toBe(403);
		}
	});

	it('a new publication ends the last; withdrawing takes it off the farm page; what was published never changes', async () => {
		const first = await plantCompleteOutlook(c.owner.id, c.projectId, c.runId, [{ nodeId: c.farmId, p50: 0.9 }]);
		const second = await plantCompleteOutlook(c.owner.id, c.projectId, c.runId, [{ nodeId: c.farmId, p50: 0.6 }]);
		expect((await publish(first)).status).toBe(201);
		expect((await publish(second)).status).toBe(201);
		expect((await farmPage()).body.outlook.demandMet.p50).toBe(0.6);
		const current = await asOwner(`SELECT outlook_id AS "outlookId" FROM outlook_publication WHERE project_id = $1 AND ended_at IS NULL`, [c.projectId]);
		expect(current).toEqual([{ outlookId: second }]);
		const ended = await asOwner(`SELECT ended_by AS "endedBy" FROM outlook_publication WHERE project_id = $1 AND outlook_id = $2`, [c.projectId, first]);
		expect(ended).toEqual([{ endedBy: c.owner.id }]);

		// Nothing published changes: not a farm's figures, not an ended publication, not the level.
		await expect(withUser(c.owner.id, (db) => db.query(`UPDATE outlook_publication_farm SET view = '{}' WHERE project_id = $1`, [c.projectId]))).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(c.owner.id, (db) => db.query(`UPDATE outlook_publication SET level_label = 'x' WHERE project_id = $1`, [c.projectId]))).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(c.owner.id, (db) => db.query(`DELETE FROM outlook_publication WHERE project_id = $1`, [c.projectId]))).rejects.toMatchObject({ code: '42501' });
		// An ended one is fixed (RLS hides it from the update: nothing changes).
		await withUser(c.owner.id, (db) => db.query(`UPDATE outlook_publication SET ended_at = now() WHERE project_id = $1 AND outlook_id = $2`, [c.projectId, first]));
		expect(await asOwner(`SELECT ended_by AS "endedBy" FROM outlook_publication WHERE outlook_id = $1`, [first])).toEqual([{ endedBy: c.owner.id }]);

		const w = await c.editor.call('DELETE', `${at}/outlook-publication`);
		expect(w.status).toBe(200);
		expect(w.body.publication).toMatchObject({ outlookId: second, endedAt: expect.any(String) });
		const page = await farmPage();
		expect(page.status).toBe(200);
		expect(page.body.outlook).toBeNull();
		expect((await c.editor.call('DELETE', `${at}/outlook-publication`)).status).toBe(404);
		expect((await c.viewer.call('GET', `${at}/outlook-publication`)).body.publication).toBeNull();
	});

	it('refuses what can’t be published, in words', async () => {
		const done = await plantCompleteOutlook(c.owner.id, c.projectId, c.runId, [{ nodeId: c.farmId }]);
		const noLevel = await publish(done, '5');
		expect(noLevel.status).toBe(422);
		expect(noLevel.body.error).toMatch(/no level 5/);
		const old = await plantCompleteOutlook(c.owner.id, c.projectId, c.runId, [{ nodeId: c.farmId }], { perFarm: false });
		const oldRes = await publish(old);
		expect(oldRes.status).toBe(409);
		expect(oldRes.body.error).toMatch(/run it again/);
		const past = await plantCompleteOutlook(c.owner.id, c.projectId, c.runId, [{ nodeId: c.farmId }], { season: ['2019-10-01', '2020-04-30'] });
		const pastRes = await publish(past);
		expect(pastRes.status).toBe(409);
		expect(pastRes.body.error).toMatch(/season ended on 2020-04-30/);
		const pending = await withUser(c.owner.id, async (db) => {
			const { rows } = await db.query(
				`INSERT INTO seasonal_outlook (project_id, base_run_id, name, decision_date, season_end, levels) VALUES ($1, $2, 'Pending', '2099-10-01', '2100-04-30', '[{"id": "0", "label": "x", "ops": []}]') RETURNING id`,
				[c.projectId, c.runId]
			);
			return rows[0].id as string;
		});
		expect((await publish(pending)).status).toBe(409);
		expect((await publish('00000000-0000-4000-8000-000000000000')).status).toBe(404);
		expect((await c.owner.call('POST', `${at}/outlooks/not-a-uuid/publish`, { levelId: '0' })).status).toBe(404);
		// The database refuses a level the outlook doesn't have even without the API.
		await expect(
			withUser(c.owner.id, (db) =>
				db.query(`INSERT INTO outlook_publication (project_id, outlook_id, level_id, level_label, decision_date, season_end, engine_version) VALUES ($1, $2, '9', 'x', '2099-10-01', '2100-04-30', 'x')`, [c.projectId, done])
			)
		).rejects.toMatchObject({ code: '23514' });
	});
});
