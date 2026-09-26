// Guard (WP-2.4): every write route under /projects/:id records what it did
// in the change history, a model_revision or an audit_event of the listed
// kind, or is listed as exempt with the reason. A new write route fails the
// inventory test below until it is added to WRITE_ROUTES.
//
// How to add a route:
//   1. Record it in the handler, in the same transaction: recordModelRevision
//      for a change to the settings or the model, recordAudit(db, projectId,
//      '<noun>.<verb>', subject) for anything else (history/record.ts; add the
//      kind to AuditKind and to docs/data-model.md § Change history).
//   2. Add an entry here, in an order where what it needs exists (entries run
//      top to bottom and share `ctx`): `records` lists what must appear, and
//      `call` makes one real request and returns its response. Keep what a
//      later entry needs in `ctx`. Or, for a route that changes nothing the
//      history covers, `exempt: '<why>'`.
import { beforeAll, describe, expect, it } from 'vitest';
import { app, asOwner, monthly, node, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;
type Res = { status: number; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Ctx {
	owner: User;
	member: User;
	farmer: User;
	projectId: string;
	farmId: string;
	otherFarmId: string;
	[key: string]: unknown;
}

type Entry =
	| {
			route: string;
			/** 'revision' (a model_revision row) and/or audit_event kinds. */
			records: string[];
			call: (c: Ctx) => Promise<Res>;
			/** The project the history goes to, when it isn't ctx.projectId (a copy's). */
			projectOf?: (c: Ctx, res: Res) => string;
	  }
	| { route: string; exempt: string };

const P = '/projects/:id';
const at = (c: Ctx) => `/projects/${c.projectId}`;

const WRITE_ROUTES: Entry[] = [
	// --- settings and model -------------------------------------------------------
	{
		route: `PATCH ${P}`,
		records: ['revision', 'project.changed'],
		call: (c) => c.owner.call('PATCH', at(c), { name: 'Guarded', settings: { lakeEvapFactor: 0.7 }, reason: 'guard' })
	},
	{
		route: `PUT ${P}/model`,
		records: ['revision'],
		call: async (c) => {
			const m = (await c.owner.call('GET', `${at(c)}/model`)).body;
			m.nodes = m.nodes.map((n: { id: string; damCapacityM3: number }) => (n.id === c.farmId ? { ...n, damCapacityM3: n.damCapacityM3 + 1 } : n));
			return c.owner.call('PUT', `${at(c)}/model`, { ...m, reason: 'guard' });
		}
	},
	{
		route: `POST ${P}/history/revisions/:revId/restore`,
		records: ['revision'],
		call: async (c) => {
			// The revision before the last: undoes the entry above, keeps the settings a run needs.
			const [prev] = await asOwner('SELECT id FROM model_revision WHERE project_id = $1 ORDER BY id DESC OFFSET 1 LIMIT 1', [c.projectId]);
			return c.owner.call('POST', `${at(c)}/history/revisions/${prev.id}/restore`, {});
		}
	},
	{
		route: `POST ${P}/copy`,
		records: ['revision'],
		call: (c) => c.owner.call('POST', `${at(c)}/copy`, { name: 'Guard copy' }),
		projectOf: (_c, res) => res.body.project.id
	},
	// --- series -------------------------------------------------------------------
	{
		route: `PUT ${P}/series`,
		records: ['series.created'],
		call: async (c) => {
			const r = await c.owner.call('PUT', `${at(c)}/series`, { kind: 'flow_observed_m3s', name: 'guard', unit: 'm3/s', startDate: '2022-01-01', values: [1, 2] });
			c.seriesId = r.body.id;
			return r;
		}
	},
	{
		route: `POST ${P}/series/merge`,
		records: ['series.merged'],
		call: (c) => c.owner.call('POST', `${at(c)}/series/merge`, { kind: 'flow_observed_m3s', name: 'guard', unit: 'm3/s', startDate: '2022-01-02', values: [5, 6] })
	},
	{
		route: `POST ${P}/series/:seriesId/revisions/:revId/restore`,
		records: ['restore'],
		call: async (c) => {
			const [rev] = await asOwner('SELECT id FROM series_revision WHERE project_id = $1 AND series_id = $2 ORDER BY id DESC LIMIT 1', [c.projectId, c.seriesId]);
			return c.owner.call('POST', `${at(c)}/series/${c.seriesId}/revisions/${rev.id}/restore`, {});
		}
	},
	{
		route: `PATCH ${P}/series/:seriesId`,
		records: ['series.labelled'],
		call: (c) => c.owner.call('PATCH', `${at(c)}/series/${c.seriesId}`, { product: 'Guard gauge', productVersion: '1' })
	},
	{
		route: `DELETE ${P}/series/:seriesId`,
		records: ['series.deleted'],
		call: (c) => c.owner.call('DELETE', `${at(c)}/series/${c.seriesId}`)
	},
	// --- members, farmers, invites -------------------------------------------------
	{
		route: `POST ${P}/members`,
		records: ['member.added'],
		call: (c) => c.owner.call('POST', `${at(c)}/members`, { email: c.member.email, role: 'viewer' })
	},
	{
		route: `PATCH ${P}/members/:userId`,
		records: ['member.role'],
		call: (c) => c.owner.call('PATCH', `${at(c)}/members/${c.member.id}`, { role: 'editor' })
	},
	{
		route: `DELETE ${P}/members/:userId`,
		records: ['member.removed'],
		call: (c) => c.owner.call('DELETE', `${at(c)}/members/${c.member.id}`)
	},
	{
		route: `POST ${P}/farmers`,
		records: ['member.added', 'farmer.linked'],
		call: (c) => c.owner.call('POST', `${at(c)}/farmers`, { email: c.farmer.email, nodeIds: [c.farmId] })
	},
	{
		route: `PUT ${P}/farmers/:userId`,
		records: ['farmer.linked', 'farmer.unlinked'],
		call: (c) => c.owner.call('PUT', `${at(c)}/farmers/${c.farmer.id}`, { nodeIds: [c.otherFarmId] })
	},
	{
		route: `POST ${P}/farmers/bulk`,
		records: ['member.added', 'farmer.linked', 'invite.sent'],
		call: async (c) => {
			// One verified account (added and linked) and one address with none (invited).
			const added = await signUp('Guardbulk');
			const rows = [
				{ email: added.email, farm: 'Farm A' },
				{ email: `guard-bulk-${crypto.randomUUID()}@example.com`, farm: 'Farm A' }
			];
			const res = await c.owner.call('POST', `${at(c)}/farmers/bulk`, { rows });
			expect(res.body.results.map((r: { status: string }) => r.status)).toEqual(['added', 'invited']);
			return res;
		}
	},
	{
		route: `DELETE ${P}/invites/:inviteId`,
		records: ['invite.revoked'],
		call: async (c) => {
			// The invite itself (POST /members for an address with no account) records invite.sent.
			const sent = await c.owner.call('POST', `${at(c)}/members`, { email: `guard-${crypto.randomUUID()}@example.com`, role: 'viewer' });
			expect(sent.body.invited).toBe(true);
			expect((await asOwner(`SELECT 1 FROM audit_event WHERE project_id = $1 AND kind = 'invite.sent' AND subject->>'inviteId' = $2`, [c.projectId, sent.body.invite.id])).length).toBe(1);
			return c.owner.call('DELETE', `${at(c)}/invites/${sent.body.invite.id}`);
		}
	},
	// --- runs and publication --------------------------------------------------------
	{
		route: `POST ${P}/runs`,
		records: ['run.created'],
		call: async (c) => {
			const r = await c.owner.call('POST', `${at(c)}/runs`, { label: 'guard' });
			c.runId = r.body.run?.id;
			return r;
		}
	},
	{
		route: `PATCH ${P}/runs/:runId`,
		records: ['run.changed'],
		call: (c) => c.owner.call('PATCH', `${at(c)}/runs/${c.runId}`, { pinned: true })
	},
	{
		route: `POST ${P}/runs/:runId/restore-inputs`,
		records: ['revision'],
		call: async (c) => {
			// Change something first, so the run's inputs differ from the project's.
			expect((await c.owner.call('PATCH', at(c), { settings: { lakeEvapFactor: 0.5 } })).status).toBe(200);
			return c.owner.call('POST', `${at(c)}/runs/${c.runId}/restore-inputs`, {});
		}
	},
	{
		route: `POST ${P}/publication`,
		records: ['publication.published'],
		call: async (c) => {
			const r = await c.owner.call('POST', `${at(c)}/publication`, { runId: c.runId });
			c.pubId = r.body.publication?.id;
			return r;
		}
	},
	{
		route: `PATCH ${P}/publication/:pubId`,
		records: ['publication.notice_changed'],
		call: (c) => c.owner.call('PATCH', `${at(c)}/publication/${c.pubId}`, { restriction: { level: 'advisory', noticeEn: 'Use water sparingly' } })
	},
	{
		route: `POST ${P}/share-links`,
		records: ['share_link.created'],
		call: async (c) => {
			const r = await c.owner.call('POST', `${at(c)}/share-links`, { label: 'Guard link', expiresInDays: 7 });
			c.shareLinkId = r.body.link?.id;
			return r;
		}
	},
	{
		route: `DELETE ${P}/share-links/:linkId`,
		records: ['share_link.revoked'],
		call: (c) => c.owner.call('DELETE', `${at(c)}/share-links/${c.shareLinkId}`)
	},
	{
		route: `DELETE ${P}/runs/:runId`,
		records: ['run.deleted'],
		call: async (c) => {
			const r = await c.owner.call('POST', `${at(c)}/runs`, { label: 'to delete' });
			return c.owner.call('DELETE', `${at(c)}/runs/${r.body.run.id}`);
		}
	},
	// --- scenarios ---------------------------------------------------------------
	{
		route: `POST ${P}/scenarios`,
		records: ['scenario.created'],
		call: async (c) => {
			const r = await c.owner.call('POST', `${at(c)}/scenarios`, {
				name: 'Guard scenario',
				baseRunId: c.runId,
				ops: [{ op: 'node.set', nodeId: c.farmId, field: 'damCapacityM3', value: 150_000 }]
			});
			c.scenarioId = r.body.scenario?.id;
			return r;
		}
	},
	{
		route: `PATCH ${P}/scenarios/:sid`,
		records: ['scenario.changed'],
		call: (c) => c.owner.call('PATCH', `${at(c)}/scenarios/${c.scenarioId}`, { description: 'guarded' })
	},
	{
		route: `POST ${P}/scenarios/:sid/rebase`,
		records: ['scenario.changed'],
		call: (c) => c.owner.call('POST', `${at(c)}/scenarios/${c.scenarioId}/rebase`, { baseRunId: c.runId })
	},
	{
		route: `POST ${P}/scenarios/:sid/runs`,
		records: ['run.created'],
		call: async (c) => {
			const r = await c.owner.call('POST', `${at(c)}/scenarios/${c.scenarioId}/runs`, {});
			c.scenarioRunId = r.body.run?.id;
			return r;
		}
	},
	{
		route: `POST ${P}/runs/:runId/signoffs`,
		records: ['signoff.created'],
		call: async (c) => {
			const path = `${at(c)}/runs/${c.scenarioRunId}/signoffs`;
			const { statement, statementSha256 } = (await c.owner.call('GET', path)).body;
			return c.owner.call('POST', path, {
				fullName: 'Guard Signer',
				registrationBody: 'SACNASP',
				registrationNo: '1',
				scope: 'guard',
				confirmed: statement.confirmations.map((k: { id: string }) => k.id),
				statementSha256
			});
		}
	},
	{
		route: `DELETE ${P}/scenarios/:sid`,
		records: ['scenario.deleted'],
		call: async (c) => {
			const r = await c.owner.call('POST', `${at(c)}/scenarios`, { name: 'Guard scenario two', baseRunId: c.runId, ops: [] });
			return c.owner.call('DELETE', `${at(c)}/scenarios/${r.body.scenario.id}`);
		}
	},
	// --- allocations (WP-3.10) ------------------------------------------------------
	{
		route: `POST ${P}/allocations`,
		records: ['allocation.created'],
		call: async (c) => {
			const r = await c.owner.call('POST', `${at(c)}/allocations`, { nodeId: c.farmId, authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: 1000 });
			c.allocationId = r.body.allocation?.id;
			return r;
		}
	},
	{
		route: `PATCH ${P}/allocations/:aid`,
		records: ['allocation.changed'],
		call: (c) => c.owner.call('PATCH', `${at(c)}/allocations/${c.allocationId}`, { volumeM3PerYear: 2000 })
	},
	{
		route: `DELETE ${P}/allocations/:aid`,
		records: ['allocation.deleted'],
		call: (c) => c.owner.call('DELETE', `${at(c)}/allocations/${c.allocationId}`)
	},
	{
		route: `POST ${P}/allocations/import/commit`,
		records: ['allocation.imported'],
		call: async (c) => {
			const text = 'registration_no,farm,authorisation,water_source,volume_m3_year\nG-1,Farm A,licence,surface,500\n';
			const r = await c.owner.call('POST', `${at(c)}/allocations/import/commit`, { kind: 'csv', fileName: 'guard.csv', text });
			c.allocationSourceId = r.body.source?.id;
			return r;
		}
	},
	{
		route: `DELETE ${P}/allocations/sources/:sourceId`,
		records: ['allocation.import_deleted'],
		call: (c) => c.owner.call('DELETE', `${at(c)}/allocations/sources/${c.allocationSourceId}`)
	},
	// --- feeds and report schedules ------------------------------------------------------
	{
		route: `POST ${P}/feeds`,
		records: ['feed.configured'],
		call: async (c) => {
			const r = await c.owner.call('POST', `${at(c)}/feeds`, { source: 'dws', config: { station: 'X0H000' } });
			c.feedId = r.body.feed?.id;
			return r;
		}
	},
	{
		route: `PATCH ${P}/feeds/:feedId`,
		records: ['feed.configured'],
		call: (c) => c.owner.call('PATCH', `${at(c)}/feeds/${c.feedId}`, { enabled: false })
	},
	{
		route: `DELETE ${P}/feeds/:feedId`,
		records: ['feed.configured'],
		call: (c) => c.owner.call('DELETE', `${at(c)}/feeds/${c.feedId}`)
	},
	{
		route: `POST ${P}/report-schedules`,
		records: ['report_schedule.configured'],
		call: async (c) => {
			const r = await c.owner.call('POST', `${at(c)}/report-schedules`, { frequency: 'weekly', weekday: 1, hour: 7, timezone: 'UTC', recipients: [c.owner.id] });
			c.scheduleId = r.body.schedule?.id;
			return r;
		}
	},
	{
		route: `PATCH ${P}/report-schedules/:scheduleId`,
		records: ['report_schedule.configured'],
		call: (c) => c.owner.call('PATCH', `${at(c)}/report-schedules/${c.scheduleId}`, { hour: 9 })
	},
	{
		route: `DELETE ${P}/report-schedules/:scheduleId`,
		records: ['report_schedule.configured'],
		call: (c) => c.owner.call('DELETE', `${at(c)}/report-schedules/${c.scheduleId}`)
	},
	// --- exempt: they change nothing the history covers ----------------------------------
	{ route: `DELETE ${P}`, exempt: 'the project goes, and its history with it (cascade)' },
	{ route: `POST ${P}/jobs`, exempt: 'queues a model run; the run records run.created when it runs (runs/execute.ts runAndStore)' },
	{ route: `POST ${P}/feeds/:feedId/run-now`, exempt: 'queues a fetch; the fetch records series.merged or feed.failed (feeds/ingest.ts)' },
	{ route: `POST ${P}/evidence`, exempt: 'run_nomination is itself an append-only history of who nominated which run and why (010_run_nomination.sql)' },
	{ route: `POST ${P}/runs/:runId/uncertainty`, exempt: 'an ensemble is kept forever with its seed and changes no input (014_run_uncertainty.sql)' },
	{ route: `POST ${P}/runs/:runId/uncertainty/:uid/result`, exempt: 'completes a kept ensemble; changes no input (014_run_uncertainty.sql)' },
	{ route: `POST ${P}/allocations/import`, exempt: 'the import preview parses and matches a file and writes nothing; the commit records allocation.imported' },
	{ route: `POST ${P}/reports`, exempt: 'renders a PDF of a run; the report row records who asked (023_reports.sql) and nothing changes' }
];

/** Every write route (not GET) under /projects/:id, as Hono lists them. */
const writeRoutes = [
	...new Set(
		app.routes
			.filter((r) => !['GET', 'HEAD', 'ALL', 'OPTIONS'].includes(r.method) && (r.path === P || r.path.startsWith(`${P}/`)))
			.map((r) => `${r.method} ${r.path}`)
	)
].sort();

describe('the write-route history inventory', () => {
	it('lists every write route under /projects/:id, and nothing that no longer exists', () => {
		const listed = WRITE_ROUTES.map((e) => e.route);
		expect(new Set(listed).size, 'a route listed twice').toBe(listed.length);
		expect(writeRoutes.filter((r) => !listed.includes(r)), 'write routes missing from WRITE_ROUTES (see the header for how to add one)').toEqual([]);
		expect(listed.filter((r) => !writeRoutes.includes(r)), 'listed routes that no longer exist').toEqual([]);
	});
});

describe('every write route records its change', () => {
	const ctx = {} as Ctx;

	beforeAll(async () => {
		const [owner, member, farmer] = await Promise.all(['Gowner', 'Gmember', 'Gfarmer'].map((n) => signUp(n)));
		ctx.owner = owner!;
		ctx.member = member!;
		ctx.farmer = farmer!;
		ctx.projectId = (await owner!.call('POST', '/projects', { name: 'Guard' })).body.project.id;
		const outlet = node('Weir', null);
		const a = node('Farm A', outlet.id);
		const b = node('Farm B', outlet.id);
		ctx.farmId = a.id;
		ctx.otherFarmId = b.id;
		const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
		const model = {
			nodes: [outlet, a, b],
			crops: [crop],
			cropAreas: [
				{ nodeId: a.id, cropId: crop.id, areaM2: 100_000 },
				{ nodeId: b.id, cropId: crop.id, areaM2: 80_000 }
			],
			transfers: []
		};
		expect((await owner!.call('PUT', `/projects/${ctx.projectId}/model`, model)).status).toBe(200);
		expect((await owner!.call('PATCH', `/projects/${ctx.projectId}`, { settings: { apanMm: monthly(200), ewrPragmaticM3PerDay: monthly(4000) } })).status).toBe(200);
		const rain = Array.from({ length: 400 }, (_, i) => (i % 9 === 0 ? 25 : i % 4 === 0 ? 3 : 0));
		expect((await owner!.call('PUT', `/projects/${ctx.projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: rain })).status).toBe(200);
	}, 60_000);

	const recorded = WRITE_ROUTES.filter((e): e is Extract<Entry, { records: string[] }> => 'records' in e);
	for (const e of recorded) {
		it(`${e.route} records ${e.records.join(' + ')}`, async () => {
			const [{ rev, ev }] = await asOwner(
				'SELECT (SELECT coalesce(max(id), 0) FROM model_revision) AS rev, (SELECT coalesce(max(id), 0) FROM audit_event) AS ev'
			);
			const res = await e.call(ctx);
			expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(200);
			expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
			const pid = e.projectOf ? e.projectOf(ctx, res) : ctx.projectId;
			const revs = await asOwner('SELECT 1 FROM model_revision WHERE project_id = $1 AND id > $2', [pid, rev]);
			const kinds = (await asOwner('SELECT kind FROM audit_event WHERE project_id = $1 AND id > $2', [pid, ev])).map((r) => r.kind);
			for (const want of e.records) {
				if (want === 'revision') expect(revs.length, `${e.route}: a model_revision`).toBeGreaterThan(0);
				else expect(kinds, `${e.route}: an audit_event ${want}`).toContain(want);
			}
		});
	}

	it("refuses to restore a scenario run's inputs into the project", async () => {
		const res = await ctx.owner.call('POST', `${at(ctx)}/runs/${ctx.scenarioRunId}/restore-inputs`, {});
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/scenario run/);
	});

	it('gives every exemption a reason', () => {
		for (const e of WRITE_ROUTES) if ('exempt' in e) expect(e.exempt.length, e.route).toBeGreaterThan(20);
	});
});
