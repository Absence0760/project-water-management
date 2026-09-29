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
import { LEGAL_VERSION } from '@water-management/engine/legal';
import { beforeAll, describe, expect, it } from 'vitest';
import { anon, app, asOwner, lastMailTo, monthly, node, plantCompleteOutlook, signUp, tokenIn } from '../__tests__/helpers.js';

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
		route: `POST ${P}/outlooks/:outlookId/publish`,
		records: ['outlook.published'],
		call: async (c) => {
			// A complete outlook planted as its owner (the job isn't under test).
			c.outlookId = await plantCompleteOutlook(c.owner.id, c.projectId, c.runId as string, [{ nodeId: c.farmId }]);
			return c.owner.call('POST', `${at(c)}/outlooks/${c.outlookId}/publish`, { levelId: '0' });
		}
	},
	{
		route: `DELETE ${P}/outlook-publication`,
		records: ['outlook.unpublished'],
		call: (c) => c.owner.call('DELETE', `${at(c)}/outlook-publication`)
	},
	{
		route: `PATCH ${P}/publication/:pubId`,
		records: ['publication.notice_changed'],
		call: (c) => c.owner.call('PATCH', `${at(c)}/publication/${c.pubId}`, { restriction: { level: 'advisory', notice: { en: 'Use water sparingly' } } })
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
	// API keys (WP-2.9). What a key then writes through /ingest records series.* as the key (ingest/ingest.db.test.ts).
	{
		route: `POST ${P}/api-keys`,
		records: ['api_key.created'],
		call: async (c) => {
			const r = await c.owner.call('POST', `${at(c)}/api-keys`, { name: 'Guard key' });
			c.apiKeyId = r.body.key?.id;
			return r;
		}
	},
	{
		route: `DELETE ${P}/api-keys/:keyId`,
		records: ['api_key.revoked'],
		call: (c) => c.owner.call('DELETE', `${at(c)}/api-keys/${c.apiKeyId}`)
	},
	// Alert rules (WP-2.13). Saved switched off here, so no alert check is left queued for other files' ticks.
	{
		route: `PUT ${P}/alert-rules`,
		records: ['alert_rules.changed'],
		call: (c) => c.owner.call('PUT', `${at(c)}/alert-rules`, { rules: [{ kind: 'dam_below', nodeId: c.farmId, threshold: 0.25, enabled: false }] })
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
				registrationBody: 'sacnasp',
				registrationCategory: 'pr_sci_nat',
				registrationField: 'water_resources',
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
	// --- the submission workflow (WP-3.3) ------------------------------------------------
	{
		route: `POST ${P}/scenarios/:sid/submit`,
		records: ['scenario.submitted'],
		call: (c) => c.owner.call('POST', `${at(c)}/scenarios/${c.scenarioId}/submit`)
	},
	{
		route: `POST ${P}/scenarios/:sid/withdraw`,
		records: ['scenario.withdrawn'],
		call: (c) => c.owner.call('POST', `${at(c)}/scenarios/${c.scenarioId}/withdraw`)
	},
	{
		route: `POST ${P}/scenarios/:sid/reopen`,
		records: ['scenario.reopened'],
		call: (c) => c.owner.call('POST', `${at(c)}/scenarios/${c.scenarioId}/reopen`)
	},
	{
		route: `POST ${P}/scenarios/:sid/decide`,
		records: ['scenario.decided'],
		call: async (c) => {
			expect((await c.owner.call('POST', `${at(c)}/scenarios/${c.scenarioId}/submit`)).status).toBe(200);
			return c.owner.call('POST', `${at(c)}/scenarios/${c.scenarioId}/decide`, { outcome: 'approved' });
		}
	},
	{
		route: `POST ${P}/scenarios/:sid/members`,
		records: ['scenario.shared'],
		call: async (c) => {
			// An application: a contributor's scenario on the published run, shared with another contributor.
			const [applicant, consultant] = await Promise.all(['Gapplicant', 'Gconsultant'].map((n) => signUp(n)));
			for (const u of [applicant!, consultant!]) {
				expect((await c.owner.call('POST', `${at(c)}/members`, { email: u.email, role: 'contributor' })).status).toBe(201);
				// One applying party: whom an applicant may share with (049).
				expect((await c.owner.call('PATCH', `${at(c)}/members/${u.id}`, { party: 'Guard party' })).status).toBe(200);
			}
			expect((await c.owner.call('POST', `${at(c)}/publication`, { runId: c.runId })).status).toBe(201);
			const s = await applicant!.call('POST', `${at(c)}/scenarios`, { name: 'Guard application', baseRunId: c.runId });
			c.applicant = applicant;
			c.consultant = consultant;
			c.applicationId = s.body.scenario.id;
			return applicant!.call('POST', `${at(c)}/scenarios/${c.applicationId}/members`, { userId: consultant!.id });
		}
	},
	{
		route: `DELETE ${P}/scenarios/:sid/members/:userId`,
		records: ['scenario.unshared'],
		call: (c) => (c.applicant as User).call('DELETE', `${at(c)}/scenarios/${c.applicationId}/members/${(c.consultant as User).id}`)
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
	// --- notes ------------------------------------------------------------------------
	{
		route: `DELETE ${P}/notes/:noteId`,
		records: ['note.deleted'],
		call: async (c) => {
			const r = await c.owner.call('POST', `${at(c)}/notes`, { body: 'Guard note', nodeId: c.farmId });
			return c.owner.call('DELETE', `${at(c)}/notes/${r.body.note.id}`);
		}
	},
	// --- exempt: they change nothing the history covers ----------------------------------
	{ route: `DELETE ${P}`, exempt: 'the project goes, and its history with it (cascade)' },
	{ route: `POST ${P}/jobs`, exempt: 'queues a model run; the run records run.created when it runs (runs/execute.ts storeRun)' },
	{ route: `POST ${P}/feeds/:feedId/run-now`, exempt: 'queues a fetch; the fetch records series.merged or feed.failed (feeds/ingest.ts)' },
	{ route: `POST ${P}/evidence`, exempt: 'run_nomination is itself an append-only history of who nominated which run and why (010_run_nomination.sql)' },
	{ route: `POST ${P}/evidence/withdraw`, exempt: 'a withdrawal is a row of the same append-only run_nomination history: who withdrew it, when and why (098_nomination_withdrawal.sql)' },
	{ route: `POST ${P}/runs/:runId/uncertainty`, exempt: 'an ensemble is kept forever with its seed and changes no input (014_run_uncertainty.sql)' },
	{ route: `POST ${P}/runs/:runId/uncertainty/:uid/result`, exempt: 'completes a kept ensemble; changes no input (014_run_uncertainty.sql)' },
	{ route: `POST ${P}/allocations/import`, exempt: 'the import preview parses and matches a file and writes nothing; the commit records allocation.imported' },
	{ route: `POST ${P}/notes`, exempt: 'a note is its own record: its author and created_at are on the row, and a delete is soft (037_notes.sql)' },
	{ route: `PATCH ${P}/notes/:noteId`, exempt: 'only the author edits their own note, and the row stamps edited_at (037_notes.sql note_guard)' },
	{ route: `POST ${P}/yield`, exempt: 'queues a yield job; its yield_result row keeps who asked, the job and the engine version, and no input changes (040_yield.sql)' },
	{ route: `POST ${P}/yield/:jobId/cancel`, exempt: 'stops a queued or running yield job; the job row stamps cancel_requested_at and no input changes (040_yield.sql)' },
	{ route: `POST ${P}/sweeps`, exempt: 'queues a sweep job; the scenario_sweep row keeps who asked, its base run, its members’ ops and the engine version, and no input changes (062_scenario_sweeps.sql)' },
	{ route: `POST ${P}/outlooks`, exempt: 'queues an outlook job; the seasonal_outlook row keeps who asked, its base run, season, levels and share and the engine version, and no input changes (063_seasonal_outlook.sql)' },
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

// --- every other write route ------------------------------------------------------
// The same guard over the write routes outside /projects/:id. A team role is a
// project role on every project of the team (app_project_role), so a team
// change that alters who reaches a project is recorded on each of the team's
// projects (072_audit_trail); the rest act on an account, not a project.

interface TeamCtx {
	admin: User;
	mate: User;
	teamId: string;
	/** Two projects in the team: a team change is recorded on each. */
	teamProjects: string[];
	[key: string]: unknown;
}

type OtherEntry =
	| {
			route: string;
			records: string[];
			call: (c: TeamCtx) => Promise<Res>;
			/** The projects whose history must show it. */
			projectsOf: (c: TeamCtx, res: Res) => string[];
	  }
	| { route: string; exempt: string };

const T = '/teams/:id';
const team = (c: TeamCtx) => `/teams/${c.teamId}`;
const inTeam = (c: TeamCtx) => c.teamProjects;

const OTHER_WRITE_ROUTES: OtherEntry[] = [
	// --- teams: who reaches the team's projects ------------------------------------------
	{
		route: `POST ${T}/members`,
		records: ['team_member.added'],
		call: (c) => c.admin.call('POST', `${team(c)}/members`, { email: c.mate.email, role: 'member' }),
		projectsOf: inTeam
	},
	{
		route: `PATCH ${T}/members/:userId`,
		records: ['team_member.role'],
		call: (c) => c.admin.call('PATCH', `${team(c)}/members/${c.mate.id}`, { role: 'admin' }),
		projectsOf: inTeam
	},
	{
		route: `DELETE ${T}/members/:userId`,
		records: ['team_member.removed'],
		call: (c) => c.admin.call('DELETE', `${team(c)}/members/${c.mate.id}`),
		projectsOf: inTeam
	},
	{
		route: `PATCH ${T}`,
		records: ['team_thresholds.changed'],
		call: (c) => c.admin.call('PATCH', team(c), { settings: { portfolio: { thresholds: { green: 2, amber: 10 } } } }),
		projectsOf: inTeam
	},
	{
		route: `DELETE ${T}`,
		records: ['team.deleted'],
		call: (c) => c.admin.call('DELETE', team(c)),
		projectsOf: inTeam
	},
	// --- projects arriving whole, and keyed ingest ---------------------------------------
	{
		route: 'POST /projects/import',
		records: ['revision'],
		call: (c) =>
			c.admin.call('POST', '/projects/import', {
				format: 'water-management.project',
				version: 1,
				name: 'Guard import',
				description: '',
				settings: {},
				model: { nodes: [], crops: [], cropAreas: [], transfers: [] },
				series: []
			}),
		projectsOf: (_c, res) => [res.body.project.id]
	},
	{
		route: 'POST /ingest/v1/series/merge',
		records: ['series.created'],
		call: async (c) => {
			const pid = (await c.admin.call('POST', '/projects', { name: 'Guard ingest' })).body.project.id;
			c.ingestProjectId = pid;
			const key = await c.admin.call('POST', `/projects/${pid}/api-keys`, { name: 'Guard logger' });
			const r = await app.request('/ingest/v1/series/merge', {
				method: 'POST',
				headers: { authorization: `Bearer ${key.body.secret}`, 'content-type': 'application/json' },
				body: JSON.stringify({ kind: 'rain_catchment_mm', unit: 'mm', startDate: '2024-01-01', values: [1, 2] })
			});
			return { status: r.status, body: await r.json() };
		},
		projectsOf: (c) => [c.ingestProjectId as string]
	},
	// --- exempt: they change no project's inputs, results or access ---------------------
	{ route: 'POST /projects', exempt: 'a new project has nothing to diff yet; its first change records a baseline revision (recordModelRevision)' },
	{ route: 'POST /teams', exempt: 'a new team has no projects, so no project history; a project moved in records project.changed' },
	{ route: `DELETE ${T}/invites/:inviteId`, exempt: 'a pending team invite grants nothing; accepting one records team_member.added (072_audit_trail)' },
	{ route: 'PUT /me/alerts/:projectId', exempt: 'a member’s own alert subscription: their preference, not the project’s rules (alert_rules.changed covers those)' },
	{ route: 'POST /me/alerts/resume', exempt: 'resumes the caller’s own paused alert emails; a personal delivery setting, not project data' },
	{ route: 'POST /alerts/unsubscribe', exempt: 'a recipient’s one-click unsubscribe from alert emails: a personal delivery setting, not project data' },
	{ route: 'POST /share/view', exempt: 'reads a publication through a share link; writes nothing to the project (share/routes.ts)' },
	{ route: 'POST /share/series', exempt: 'reads one series through a share link; writes nothing to the project (share/routes.ts)' },
	{ route: 'PATCH /auth/me', exempt: 'the caller’s own account settings; history rows keep a snapshot of the name as it was (actor_label)' },
	{ route: 'POST /auth/register', exempt: 'creates an account, not project data; joining a project by invite records member.added on verify' },
	{ route: 'POST /auth/verify-email', exempt: 'confirms an address; the invites it accepts record member.added / team_member.added (app_accept_invites)' },
	{ route: 'POST /auth/resend-verification', exempt: 'resends the caller’s verification email; changes no project' },
	{ route: 'POST /auth/resend-confirmation', exempt: 'emails an unconfirmed account a new confirmation link, signed out; changes no project and must not reveal whether the account exists' },
	{ route: 'POST /auth/login', exempt: 'starts a session (auth rate limits and lockout cover abuse); changes no project' },
	{ route: 'POST /auth/logout', exempt: 'ends the caller’s session; changes no project or its history' },
	{ route: 'POST /auth/logout-everywhere', exempt: 'ends every session of the caller’s account; changes no project' },
	{ route: 'POST /auth/me/farm-notice', exempt: 'records the caller’s own acknowledgement of the farm view notice on their account (093); changes no project' },
	{ route: 'POST /auth/me/accept-terms', exempt: 'records which terms the caller’s own account accepted (app_user.terms_version, stamped by the database); changes no project' },
	{ route: 'POST /auth/change-password', exempt: 'the caller’s own credential; changes no project, and the password is never logged' },
	{ route: 'POST /auth/forgot-password', exempt: 'emails a reset link; changes no project and must not reveal whether the account exists' },
	{ route: 'POST /auth/reset-password', exempt: 'sets a new password from a reset token; changes no project' },
	{ route: 'POST /auth/invite-info', exempt: 'reads what an invite token is for, to show on the sign-up page; writes nothing' },
	{ route: 'POST /auth/render-session', exempt: 'exchanges a one-use render token for the report renderer’s read-only session; changes no project' }
];

const otherWriteRoutes = [
	...new Set(
		app.routes
			.filter((r) => !['GET', 'HEAD', 'ALL', 'OPTIONS'].includes(r.method) && !(r.path === P || r.path.startsWith(`${P}/`)))
			.map((r) => `${r.method} ${r.path}`)
	)
].sort();

describe('the other write routes', () => {
	it('lists every write route outside /projects/:id, and nothing that no longer exists', () => {
		const listed = OTHER_WRITE_ROUTES.map((e) => e.route);
		expect(otherWriteRoutes.length).toBeGreaterThan(20);
		expect(new Set(listed).size, 'a route listed twice').toBe(listed.length);
		expect(otherWriteRoutes.filter((r) => !listed.includes(r)), 'write routes missing from OTHER_WRITE_ROUTES').toEqual([]);
		expect(listed.filter((r) => !otherWriteRoutes.includes(r)), 'listed routes that no longer exist').toEqual([]);
		for (const e of OTHER_WRITE_ROUTES) if ('exempt' in e) expect(e.exempt.length, e.route).toBeGreaterThan(20);
	});

	const ctx = {} as TeamCtx;

	beforeAll(async () => {
		const [admin, mate] = await Promise.all(['Tadmin', 'Tmate'].map((n) => signUp(n)));
		ctx.admin = admin!;
		ctx.mate = mate!;
		ctx.teamId = (await admin!.call('POST', '/teams', { name: 'Guard WUA' })).body.team.id;
		ctx.teamProjects = [];
		for (const name of ['Upper', 'Lower']) {
			const r = await admin!.call('POST', '/projects', { name, teamId: ctx.teamId });
			expect(r.status).toBe(201);
			ctx.teamProjects.push(r.body.project.id);
		}
	}, 30_000);

	const recorded = OTHER_WRITE_ROUTES.filter((e): e is Extract<OtherEntry, { records: string[] }> => 'records' in e);
	for (const e of recorded) {
		it(`${e.route} records ${e.records.join(' + ')} on each project it reaches`, async () => {
			const [{ rev, ev }] = await asOwner(
				'SELECT (SELECT coalesce(max(id), 0) FROM model_revision) AS rev, (SELECT coalesce(max(id), 0) FROM audit_event) AS ev'
			);
			const res = await e.call(ctx);
			expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(200);
			expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
			const pids = e.projectsOf(ctx, res);
			expect(pids.length).toBeGreaterThan(0);
			for (const pid of pids) {
				const revs = await asOwner('SELECT 1 FROM model_revision WHERE project_id = $1 AND id > $2', [pid, rev]);
				const kinds = (await asOwner('SELECT kind FROM audit_event WHERE project_id = $1 AND id > $2', [pid, ev])).map((r) => r.kind);
				for (const want of e.records) {
					if (want === 'revision') expect(revs.length, `${e.route}: a model_revision on ${pid}`).toBeGreaterThan(0);
					else expect(kinds, `${e.route}: an audit_event ${want} on ${pid}`).toContain(want);
				}
			}
		});
	}
});

describe('a team change in the history', () => {
	let admin: User;
	let teamId: string;
	let projectId: string;
	const teamEvents = (kind: string) =>
		asOwner(`SELECT actor_user_id, actor_label, subject FROM audit_event WHERE project_id = $1 AND kind = $2 ORDER BY id`, [projectId, kind]);

	beforeAll(async () => {
		admin = await signUp('Thistory');
		teamId = (await admin.call('POST', '/teams', { name: 'History WUA' })).body.team.id;
		projectId = (await admin.call('POST', '/projects', { name: 'Team catchment', teamId })).body.project.id;
	});

	it('records who joined, as what here, and shows it in the project’s timeline', async () => {
		const mate = await signUp('Tjoiner');
		expect((await admin.call('POST', `/teams/${teamId}/members`, { email: mate.email, role: 'viewer' })).status).toBe(201);
		const [e] = await teamEvents('team_member.added');
		expect(e).toMatchObject({
			actor_user_id: admin.id,
			subject: { teamId, team: 'History WUA', userId: mate.id, displayName: 'Tjoiner', teamRole: 'viewer', role: 'viewer' }
		});
		// Positive control: the owner (the team admin) reads it through the API.
		const items = (await admin.call('GET', `/projects/${projectId}/history?kind=team_member`)).body.items;
		expect(items.map((i: { kind: string }) => i.kind)).toContain('team_member.added');
		// A team viewer leaving records it as themselves, before the access goes.
		expect((await mate.call('DELETE', `/teams/${teamId}/members/${mate.id}`)).status).toBe(204);
		const [left] = await teamEvents('team_member.removed');
		expect(left).toMatchObject({ actor_user_id: mate.id, subject: { userId: mate.id, self: true, teamRole: 'viewer' } });
	});

	it('records a role change only when the role changed', async () => {
		const mate = await signUp('Trole');
		expect((await admin.call('POST', `/teams/${teamId}/members`, { email: mate.email, role: 'member' })).status).toBe(201);
		const before = (await teamEvents('team_member.role')).length;
		expect((await admin.call('PATCH', `/teams/${teamId}/members/${mate.id}`, { role: 'member' })).status).toBe(200);
		expect(await teamEvents('team_member.role')).toHaveLength(before);
		expect((await admin.call('PATCH', `/teams/${teamId}/members/${mate.id}`, { role: 'admin' })).status).toBe(200);
		expect((await teamEvents('team_member.role')).at(-1)).toMatchObject({ subject: { userId: mate.id, from: 'member', to: 'admin', role: 'owner' } });
	});

	it('records a team invite accepted as the person joining (app_accept_invites, 072)', async () => {
		const email = `tinvited-${crypto.randomUUID()}@example.com`;
		const invited = await admin.call('POST', `/teams/${teamId}/members`, { email, role: 'member' });
		expect(invited.body.invited).toBe(true);
		const reg = await anon('POST', '/auth/register', { email, password: 'correct horse', displayName: 'Tinvited', acceptTerms: LEGAL_VERSION });
		expect(reg.status).toBe(202);
		expect((await anon('POST', '/auth/verify-email', { token: tokenIn(lastMailTo(email)) })).status).toBe(200);
		const { id } = ((await asOwner('SELECT id FROM app_user WHERE email = $1', [email])) as { id: string }[])[0]!;
		const joined = (await teamEvents('team_member.added')).filter((e) => e.subject.via === 'invite');
		expect(joined).toHaveLength(1);
		expect(joined[0]).toMatchObject({
			actor_user_id: id,
			actor_label: 'Tinvited',
			subject: { teamId, userId: id, teamRole: 'member', role: 'editor' }
		});
	});

	it('records the team deleted on the project it leaves, which keeps its history', async () => {
		expect((await admin.call('DELETE', `/teams/${teamId}`)).status).toBe(204);
		const [e] = await teamEvents('team.deleted');
		expect(e).toMatchObject({ actor_user_id: admin.id, subject: { teamId, team: 'History WUA' } });
		expect(e!.subject.members).toBeGreaterThanOrEqual(2);
		// The project stays, with its direct owner, and reads its history.
		const items = (await admin.call('GET', `/projects/${projectId}/history?kind=team`)).body.items;
		expect(items.map((i: { kind: string }) => i.kind)).toContain('team.deleted');
	});
});
