// A project with a real row behind every sub-id a /projects/:id route takes,
// and a request body each route's validation accepts. Shared by the sweeps
// built from app.routes: projects/role-ladder.db.test.ts (who may call each
// route) and http/mass-assignment.security.db.test.ts (what a body may set).
// A route whose validation refuses an empty body needs a SAMPLE here; both
// sweeps fail until it has one.
import { expect } from 'vitest';
import { asOwner, monthly, node, plantCalibration, plantCompleteOutlook, retirePendingJobs, signUp } from './helpers.js';

export type User = Awaited<ReturnType<typeof signUp>>;

export interface LadderCtx {
	owner: User;
	editor: User;
	viewer: User;
	contributor: User;
	farmer: User;
	projectId: string;
	farmId: string;
	otherFarmId: string;
	runId: string;
	seriesId: string;
	model: unknown;
	ids: Record<string, string>;
}

export type Sample = { body?: unknown; query?: Record<string, string>; params?: Record<string, string> };
const levels = (key: 'name' | 'label') => [1, 0.85].map((f) => ({ [key]: `${f * 100} %`, ops: [{ op: 'demand.scale', factor: f }] }));
const csv = 'registration_no,farm,authorisation,water_source,volume_m3_year\nL-1,Farm A,licence,surface,500\n';

/** A request each route's validation accepts, where an empty body or query doesn't. */
export const SAMPLE: Record<string, (c: LadderCtx) => Sample> = {
	'POST /projects/:id/copy': () => ({ body: { name: 'Ladder copy' } }),
	'POST /projects/:id/members': () => ({ body: { email: `ladder-${crypto.randomUUID()}@example.com`, role: 'viewer' } }),
	'PATCH /projects/:id/members/:userId': () => ({ body: { role: 'editor' } }),
	'PUT /projects/:id/model': (c) => ({ body: c.model }),
	'PUT /projects/:id/series': () => ({ body: { kind: 'flow_observed_m3s', unit: 'm3/s', startDate: '2022-01-01', values: [1, 2] } }),
	'PATCH /projects/:id/series/:seriesId': () => ({ body: { product: 'Ladder gauge', productVersion: '1' } }),
	'POST /projects/:id/series/merge': () => ({ body: { kind: 'flow_observed_m3s', unit: 'm3/s', startDate: '2022-01-02', values: [5, 6] } }),
	'GET /projects/:id/runs/:runId/series': () => ({ query: { key: 'simulated_outflow' } }),
	'GET /projects/:id/runs/:runId/day': (c) => ({ query: { date: '2021-10-03', nodeId: c.farmId } }),
	'GET /projects/:id/runs/:runId/export/farms.csv': () => ({ query: { key: 'supplied' } }),
	'PATCH /projects/:id/runs/:runId': () => ({ body: { pinned: true } }),
	'POST /projects/:id/runs/:runId/uncertainty': () => ({
		body: { request: { members: 30, thresholds: { minSkill: -10, maxLowFlowBiasPct: null, wr2012MaxLevel: 'unusable' } } }
	}),
	'POST /projects/:id/evidence': (c) => ({ body: { runId: c.runId, reason: 'the calibrated run' } }),
	'POST /projects/:id/evidence/withdraw': () => ({ body: { reason: 'the application lapsed' } }),
	'POST /projects/:id/scenarios': (c) => ({ body: { name: `Ladder ${crypto.randomUUID()}`, baseRunId: c.runId, ops: [] } }),
	'PATCH /projects/:id/scenarios/:sid': () => ({ body: { description: 'ladder' } }),
	'POST /projects/:id/scenarios/:sid/rebase': (c) => ({ body: { baseRunId: c.runId } }),
	'POST /projects/:id/scenarios/:sid/decide': () => ({ body: { outcome: 'licence_issued', authority: 'Ladder CMA', decisionDate: '2026-09-30', reasonsReceived: true } }),
	'POST /projects/:id/scenarios/:sid/members': (c) => ({ body: { userId: c.contributor.id } }),
	'POST /projects/:id/scenarios/:sid/questions': () => ({ body: { problem: 0, line: 'op 1 (node.set): ladder' } }),
	'POST /projects/:id/application-questions/:qid/answer': () => ({ body: { answer: 'Ladder answer' } }),
	'DELETE /projects/:id/scenarios/:sid/members/:userId': (c) => ({ params: { userId: c.contributor.id } }),
	'POST /projects/:id/runs/:runId/signoffs': () => ({
		body: {
			fullName: 'Ladder Signer',
			registrationBody: 'sacnasp',
			registrationCategory: 'pr_sci_nat',
			registrationField: 'water_resources',
			registrationNo: '1',
			scope: 'ladder',
			confirmed: [],
			statementSha256: '0'.repeat(64)
		}
	}),
	'POST /projects/:id/packs': (c) => ({ body: { runId: c.runId } }),
	'POST /projects/:id/packs/:packId/withdraw': () => ({ body: { reason: 'superseded by the revised application' } }),
	'POST /projects/:id/packs/:packId/signoffs': () => ({
		body: {
			fullName: 'Ladder Signer',
			registrationBody: 'sacnasp',
			registrationCategory: 'pr_sci_nat',
			registrationField: 'water_resources',
			registrationNo: '1',
			scope: 'ladder',
			confirmed: [],
			statementSha256: '0'.repeat(64)
		}
	}),
	'POST /projects/:id/jobs': () => ({ body: { kind: 'rerun', label: 'Ladder' } }),
	'POST /projects/:id/yield': (c) => ({ body: { nodeId: c.farmId, runId: c.runId, kind: 'firm' } }),
	'GET /projects/:id/yield': (c) => ({ query: { runId: c.runId } }),
	'GET /projects/:id/yield/jobs': (c) => ({ query: { nodeId: c.farmId } }),
	'POST /projects/:id/sweeps': (c) => ({ body: { name: 'Ladder sweep', baseRunId: c.runId, members: levels('name') } }),
	'POST /projects/:id/assessments': (c) => ({ body: { name: `Ladder assessment ${crypto.randomUUID()}`, scenarioIds: [c.ids.sid!, c.ids.sid2!] } }),
	'POST /projects/:id/outlooks': (c) => ({ body: { name: 'Ladder outlook', baseRunId: c.runId, levels: levels('label') } }),
	'POST /projects/:id/outlooks/:outlookId/publish': () => ({ body: { levelId: '0' } }),
	'POST /projects/:id/feeds': () => ({ body: { source: 'dws', config: { station: 'X0H001' } } }),
	// A body of the right shape; with no boundary on the ladder's map the owner gets 409, past the role check.
	'POST /projects/:id/feeds/chirps/from-boundary': () => ({ body: { featureId: crypto.randomUUID(), updatedAt: '2026-10-01T00:00:00.000Z' } }),
	'POST /projects/:id/report-schedules': (c) => ({ body: { frequency: 'weekly', weekday: 1, hour: 7, timezone: 'UTC', recipients: [c.owner.id] } }),
	'POST /projects/:id/farmers': (c) => ({ body: { email: `ladder-${crypto.randomUUID()}@example.com`, nodeIds: [c.farmId] } }),
	'POST /projects/:id/farmers/bulk': () => ({ body: { rows: [{ email: `ladder-${crypto.randomUUID()}@example.com`, farm: 'Farm A' }] } }),
	'PUT /projects/:id/farmers/:userId': (c) => ({ body: { nodeIds: [c.otherFarmId] }, params: { userId: c.farmer.id } }),
	'POST /projects/:id/publication': (c) => ({ body: { runId: c.runId } }),
	'PATCH /projects/:id/publication/:pubId': () => ({ body: { restriction: { level: 'advisory', notice: { en: 'Use water sparingly' } } } }),
	'POST /projects/:id/publication/:pubId/endorse': () => ({ body: { note: 'ladder' } }),
	'POST /projects/:id/share-links': () => ({ body: { label: 'Ladder link', expiresInDays: 7 } }),
	'POST /projects/:id/allocations': (c) => ({ body: { nodeId: c.farmId, authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: 1000 } }),
	// A PATCH changes only what it sends (issue #72), so an empty one is refused before the role check.
	'PATCH /projects/:id/allocations/:aid': () => ({ body: { reference: 'ladder' } }),
	'POST /projects/:id/map/features': () => ({ body: { kind: 'gauge', name: 'Ladder gauge', lon: 21.3, lat: -33.6 } }),
	'PATCH /projects/:id/map/features/:fid': () => ({ body: { name: 'Ladder feature' } }),
	'POST /projects/:id/map/import': () => ({
		body: {
			fileName: `ladder-${crypto.randomUUID()}.geojson`,
			kind: 'other',
			text: JSON.stringify({ type: 'Feature', properties: { name: crypto.randomUUID() }, geometry: { type: 'Point', coordinates: [21.3, -33.6] } })
		}
	}),
	'POST /projects/:id/map/import/preview': () => ({
		body: {
			fileName: 'ladder.geojson',
			text: JSON.stringify({ type: 'Feature', properties: { name: 'Ladder' }, geometry: { type: 'Point', coordinates: [21.3, -33.6] } })
		}
	}),
	'POST /projects/:id/nodes/:nodeId/area-from-map': (c) => ({ body: { featureId: c.ids.fid } }),
	'GET /projects/:id/map/quaternary': () => ({ query: { lon: '21.35', lat: '-33.65' } }),
	'GET /projects/:id/map/quaternaries': () => ({ query: { bbox: '21.2,-33.8,21.5,-33.5' } }),
	'POST /projects/:id/nodes/:nodeId/dam-capacity-from-register': () => ({ body: { registerNo: 'Z100/07' } }),
	'POST /projects/:id/nodes/:nodeId/dam-area-from-map': (c) => ({ body: { featureId: c.ids.fid } }),
	'POST /projects/:id/allocations/import': () => ({ body: { kind: 'csv', fileName: 'ladder.csv', text: csv } }),
	'POST /projects/:id/allocations/import/commit': () => ({ body: { kind: 'csv', fileName: 'ladder.csv', text: csv } }),
	'POST /projects/:id/notes': (c) => ({ body: { body: 'Ladder note', nodeId: c.farmId } }),
	'PATCH /projects/:id/notes/:noteId': () => ({ body: { body: 'Edited' } }),
	'POST /projects/:id/api-keys': () => ({ body: { name: 'Ladder key' } }),
	'PUT /projects/:id/alert-rules': (c) => ({ body: { rules: [{ kind: 'dam_below', nodeId: c.farmId, threshold: 0.25, enabled: false }] } }),
	'PUT /me/alerts/:projectId': () => ({ body: { items: [{ kind: 'all', mode: 'immediate' }] } })
};

/**
 * The owner's project: a model of two farms under a weir, rain, a run, the
 * editor, viewer and contributor as members and the farmer linked to Farm A,
 * and one row (owned by the owner) behind every sub-id a route takes, so a
 * route that looks the row up first is still reached.
 */
export async function buildLadder(prefix = 'L'): Promise<LadderCtx> {
	const [owner, editor, viewer, contributor, farmer] = await Promise.all(
		['owner', 'editor', 'viewer', 'contributor', 'farmer'].map((n) => signUp(`${prefix}${n}`))
	);
	const projectId = (await owner!.call('POST', '/projects', { name: 'Ladder' })).body.project.id as string;
	const at = `/projects/${projectId}`;
	const outlet = node('Weir', null);
	const a = node('Farm A', outlet.id);
	const b = node('Farm B', outlet.id);
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
	expect((await owner!.call('PUT', `${at}/model`, model)).status).toBe(200);
	expect((await owner!.call('PATCH', at, { settings: { apanMm: monthly(200), ewrPragmaticM3PerDay: monthly(4000) } })).status).toBe(200);
	const rain = Array.from({ length: 400 }, (_, i) => (i % 9 === 0 ? 25 : i % 4 === 0 ? 3 : 0));
	const series = await owner!.call('PUT', `${at}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: rain });
	expect(series.status).toBe(200);
	for (const [u, role] of [
		[editor!, 'editor'],
		[viewer!, 'viewer'],
		[contributor!, 'contributor']
	] as const) {
		expect((await owner!.call('POST', `${at}/members`, { email: u.email, role })).status).toBe(201);
	}
	expect((await owner!.call('POST', `${at}/farmers`, { email: farmer!.email, nodeIds: [a.id] })).status).toBe(201);
	const run = await owner!.call('POST', `${at}/runs`, { label: 'Ladder run' });
	expect(run.status).toBe(201);
	const runId = run.body.run.id as string;
	const made = async (path: string, body: unknown, pick: (b: any) => string) => { // eslint-disable-line @typescript-eslint/no-explicit-any
		const r = await owner!.call('POST', `${at}${path}`, body);
		expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
		return pick(r.body);
	};
	const pubId = await made('/publication', { runId }, (b) => b.publication.id);
	const sid = await made('/scenarios', { name: 'Team scenario', baseRunId: runId, ops: [] }, (b) => b.scenario.id);
	// A second, for an assessment of two (WP-3.11).
	const sid2 = await made('/scenarios', { name: 'Second team scenario', baseRunId: runId, ops: [] }, (b) => b.scenario.id);
	const feedId = await made('/feeds', { source: 'dws', config: { station: 'X0H000' } }, (b) => b.feed.id);
	const scheduleId = await made('/report-schedules', { frequency: 'weekly', weekday: 1, hour: 7, timezone: 'UTC', recipients: [owner!.id] }, (b) => b.schedule.id);
	const fid = await made('/map/features', { kind: 'farm_parcel', name: 'Ladder parcel', nodeId: a.id, geometry: { type: 'Polygon', coordinates: [[[21.3, -33.7], [21.32, -33.7], [21.32, -33.68], [21.3, -33.68], [21.3, -33.7]]] } }, (b) => b.feature.id);
	const aid = await made('/allocations', { nodeId: a.id, authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: 1000 }, (b) => b.allocation.id);
	const linkId = await made('/share-links', { label: 'Ladder link', expiresInDays: 7 }, (b) => b.link.id);
	const keyId = await made('/api-keys', { name: 'Ladder key' }, (b) => b.key.id);
	const inviteId = await made('/members', { email: `ladder-${crypto.randomUUID()}@example.com`, role: 'viewer' }, (b) => b.invite.id);
	const noteId = await made('/notes', { body: 'Owner note', nodeId: a.id }, (b) => b.note.id);
	const jobId = await made('/yield', { nodeId: a.id, runId, kind: 'firm' }, (b) => b.jobId);
	const outlookId = await plantCompleteOutlook(owner!.id, projectId, runId, [{ nodeId: a.id }, { nodeId: b.id }]);
	const cid = await plantCalibration(owner!.id, projectId);
	const [rev] = await asOwner('SELECT id FROM model_revision WHERE project_id = $1 ORDER BY id DESC LIMIT 1', [projectId]);
	const qid = await plantQuestion(projectId, sid);
	return {
		owner: owner!,
		editor: editor!,
		viewer: viewer!,
		contributor: contributor!,
		farmer: farmer!,
		projectId,
		farmId: a.id,
		otherFarmId: b.id,
		runId,
		seriesId: series.body.id,
		model,
		ids: {
			id: projectId,
			projectId,
			runId,
			seriesId: series.body.id,
			nodeId: a.id,
			userId: owner!.id,
			sid,
			sid2,
			pubId,
			feedId,
			scheduleId,
			aid,
			fid,
			linkId,
			keyId,
			inviteId,
			noteId,
			jobId,
			outlookId,
			cid,
			qid,
			revId: String(rev!.id)
		}
	};
}

/**
 * An unanswered "Ask the assessors why" question on scenario `sid`, planted as
 * the schema owner (164_applicant_visibility): asking one through the API
 * needs an application whose rule turns on hidden farms
 * (scenarios/questions.db.test.ts asks one).
 */
export async function plantQuestion(projectId: string, sid: string): Promise<string> {
	const [q] = await asOwner(
		`INSERT INTO application_question (project_id, scenario_id, scenario_name, problem, op_indexes, ops, rules, assessor_text)
		 VALUES ($1, $2, 'Ladder application', 'op 1 (node.set): doesn''t apply to the catchment as modelled', '{0}', '[]', '{shares}', 'op 1 (node.set): ladder')
		 RETURNING id`,
		[projectId, sid]
	);
	return q!.id as string;
}

/**
 * Retire the jobs the ladder left pending: buildLadder's yield job, and
 * whatever the routes a file sends queued (re-runs, yields, sweeps …). Call it
 * in the file's afterAll: the job queue is shared by every DB test file, and a
 * later file's tick would claim them (src/__tests__/db-setup.ts).
 */
export const clearLadderJobs = (c: Pick<LadderCtx, 'projectId'> | undefined) => retirePendingJobs(c?.projectId);
