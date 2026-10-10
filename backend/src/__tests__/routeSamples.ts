// A project with a real row behind every sub-id a /projects/:id route takes,
// and a request body each route's validation accepts. Shared by the sweeps
// built from app.routes: projects/role-ladder.db.test.ts (who may call each
// route) and http/mass-assignment.security.db.test.ts (what a body may set).
// A route whose validation refuses an empty body needs a SAMPLE here; both
// sweeps fail until it has one.
import { expect } from 'vitest';
import { fileURLToPath } from 'node:url';
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

/** A square (west, south, side in degrees) cut in two down its middle: the two parts POST …/map/features/:fid/split takes. */
export function splitHalves(w: number, s: number, d: number) {
	const m = Math.round((w + d / 2) * 1e7) / 1e7;
	const e = Math.round((w + d) * 1e7) / 1e7;
	const n = Math.round((s + d) * 1e7) / 1e7;
	const box = (x0: number, x1: number) => ({ type: 'Polygon', coordinates: [[[x0, s], [x1, s], [x1, n], [x0, n], [x0, s]]] });
	return [box(w, m), box(m, e)];
}

export type Sample = { body?: unknown; query?: Record<string, string>; params?: Record<string, string> };
const levels = (key: 'name' | 'label') => [1, 0.85].map((f) => ({ [key]: `${f * 100} %`, ops: [{ op: 'demand.scale', factor: f }] }));
const csv = 'registration_no,farm,authorisation,water_source,volume_m3_year\nL-1,Farm A,licence,surface,500\n';

/** A request each route's validation accepts, where an empty body or query doesn't. */
export const SAMPLE: Record<string, (c: LadderCtx) => Sample> = {
	'POST /projects/:id/copy': () => ({ body: { name: 'Ladder copy' } }),
	'POST /projects/:id/members': () => ({ body: { email: `ladder-${crypto.randomUUID()}@example.com`, role: 'viewer' } }),
	'PATCH /projects/:id/members/:userId': () => ({ body: { role: 'editor' } }),
	'POST /projects/:id/members/:userId/registration-checks': () => ({
		body: {
			registrationBody: 'sacnasp',
			registrationCategory: 'pr_sci_nat',
			registrationNo: '400999/20',
			registerName: 'Ladder Signer',
			outcome: 'registered',
			checkedByOrg: 'Ladder WUA',
			checkedAt: '2026-01-01'
		}
	}),
	'PUT /projects/:id/registration-check-required': () => ({ body: { required: true } }),
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
	// Every unit the proposal lists (#482): the ladder's farm A, from its parcel.
	'POST /projects/:id/feeds/chirps/from-units': () => ({ body: { product: 'rnl' } }),
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
	// The river network (issue #345, geo/rivers.ts): a bbox round the synthetic network, and one of its reaches.
	'GET /projects/:id/map/rivers': () => ({ query: { bbox: '21.2,-33.8,21.5,-33.5' } }),
	'GET /projects/:id/map/map-grid': () => ({ query: { bbox: '21.2,-33.8,21.5,-33.5' } }),
	'GET /projects/:id/map/dem-grid': () => ({ query: { bbox: '20.7,-33.5,20.78,-33.42' } }),
	// The DEM's channels: the tile holding the synthetic DEM's valley (the ladder turns DEM_URL on with it).
	'GET /projects/:id/map/channels': () => ({ query: { tile: '103,-168' } }),
	'POST /projects/:id/map/rivers/add': () => ({ body: { dataset: 'synthetic', reachId: 90000005 } }),
	'POST /projects/:id/nodes/:nodeId/dam-capacity-from-register': () => ({ body: { registerNo: 'Z100/07' } }),
	'POST /projects/:id/nodes/:nodeId/dam-area-from-map': (c) => ({ body: { featureId: c.ids.fid } }),
	// Delineation (175): the ladder turns DEM_URL on with the committed synthetic DEM, and this is its valley's outlet.
	'POST /projects/:id/map/delineation': () => ({ body: { lon: 20.7428741, lat: -33.5396777, from: 'outlet' } }),
	'POST /projects/:id/map/delineation/:pid/accept': () => ({ body: { as: 'other' } }),
	// Sub-catchments from clicks: the synthetic DEM's outlet and a click just below its dam wall.
	'POST /projects/:id/map/subcatchments': () => ({ body: { clicks: [{ lon: 20.7428741, lat: -33.5396777 }, { lon: 20.7428741, lat: -33.4262838 }] } }),
	'POST /projects/:id/map/subcatchments/save': () => ({ body: { clicks: [{ lon: 20.7428741, lat: -33.5396777 }, { lon: 20.7428741, lat: -33.4262838 }] } }),
	// Tracing a dam (issue #326 C2): the ladder turns WATER_URL on with the committed synthetic raster, and this is inside its dam.
	'POST /projects/:id/map/dam-trace': () => ({ body: { lon: 21.3191414, lat: -33.6724971 } }),
	// Splitting the ladder's parcel (21.30–21.32° E) down its middle; once it is split, a second call is refused past the role check (the halves no longer add up to it).
	'POST /projects/:id/map/features/:fid/split': () => ({ body: { parts: splitHalves(21.3, -33.7, 0.02) } }),
	// Start from the map (178): the ladder's model has nodes, so a proposal is refused (409) after the role check; apply takes ticks for the planted proposal's no units.
	'POST /projects/:id/map/start': () => ({ body: { points: [] } }),
	'POST /projects/:id/map/start/:spid/apply': () => ({ body: { outletName: 'Ladder outlet', units: [], rest: { include: false, name: 'Rest', area: false } } }),
	// Dividing the model from the map (182): the ladder's parcel as a new gauge point, refused (400) after the role check (a parcel is no gauge point); apply's planted proposal is a start, so 409 after it.
	'POST /projects/:id/map/divide': (c) => ({ body: { points: [{ featureId: c.ids.fid, nodeId: null }] } }),
	'POST /projects/:id/map/divide/:spid/apply': () => ({ body: { units: [], rest: { to: 'none' } } }),
	// Needs the synthetic land-cover grid loaded (scripts/import-land-cover.ts); the ladder's parcel lies in its 0.5 block.
	'POST /projects/:id/nodes/:nodeId/crop-area-from-land-cover': (c) => ({ body: { cropId: c.ids.cropId, dataset: 'synthetic' } }),
	// Needs the synthetic evaporation grid loaded (scripts/import-evaporation.ts) and a catchment boundary on the map inside it.
	'POST /projects/:id/evaporation-from-map': () => ({ body: { dataset: 'synthetic' } }),
	// Needs the synthetic MAP grid loaded (scripts/import-map-grid.ts); the ladder's parcel lies in its region Z.
	'POST /projects/:id/map/unit-map': () => ({ body: { dataset: 'synthetic' } }),
	'POST /projects/:id/allocations/import': () => ({ body: { kind: 'csv', fileName: 'ladder.csv', text: csv } }),
	'POST /projects/:id/allocations/import/commit': () => ({ body: { kind: 'csv', fileName: 'ladder.csv', text: csv } }),
	'POST /projects/:id/notes': (c) => ({ body: { body: 'Ladder note', nodeId: c.farmId } }),
	'PATCH /projects/:id/notes/:noteId': () => ({ body: { body: 'Edited' } }),
	'POST /projects/:id/api-keys': () => ({ body: { name: 'Ladder key' } }),
	'PUT /projects/:id/alert-rules': (c) => ({ body: { rules: [{ kind: 'dam_below', nodeId: c.farmId, threshold: 0.25, enabled: false }] } }),
	'PUT /me/alerts/:projectId': () => ({ body: { items: [{ kind: 'all', mode: 'immediate' }] } }),
	'PUT /projects/:id/licence-record': () => ({ body: { outcome: 'granted', outcomeOn: '2026-03-01', expiresOn: '2046-02-28', reason: 'ladder' } }),
	'PUT /projects/:id/allocations/viewer-units': () => ({ body: { on: true } })
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
	// Delineation's routes read the committed synthetic DEM (off by default), and decide an open proposal planted here.
	process.env.DEM_URL = fileURLToPath(new URL('../../fixtures/dem/synthetic-dem.pmtiles', import.meta.url));
	// Tracing a dam (issue #326 C2) reads the committed synthetic water occurrence raster (off by default).
	process.env.WATER_URL = fileURLToPath(new URL('../../fixtures/water/synthetic-water.pmtiles', import.meta.url));
	const pid = await plantDelineationProposal(projectId);
	const spid = await plantStartProposal(projectId);
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
			cropId: crop.id,
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
			pid,
			spid,
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
/**
 * The ladder project's leftovers a later file's tick would claim: its pending
 * jobs, and its feeds, switched off (the feed routes the sweeps call, POST
 * /feeds and from-boundary / from-units, leave enabled feeds behind, due at
 * once, and the next tick would schedule them).
 */
export async function clearLadderJobs(c: Pick<LadderCtx, 'projectId'> | undefined) {
	if (c?.projectId) await asOwner('UPDATE data_feed SET enabled = false WHERE project_id = $1', [c.projectId]);
	await retirePendingJobs(c?.projectId);
}

/**
 * An open start-from-the-map proposal on `projectId` (178_start_proposal),
 * planted as the schema owner so no DEM is read: no units, the rest of the
 * catchment without an area. The project's open one, if any, is superseded
 * first (one open a project). Returns its id.
 */
export async function plantStartProposal(projectId: string): Promise<string> {
	await asOwner(`UPDATE start_proposal SET status = 'superseded' WHERE project_id = $1 AND status = 'proposed'`, [projectId]);
	const plan = {
		fromDem: false,
		outlet: { featureId: null, name: 'Outflow gauge', point: null, snapDistanceM: null, foundIn: null },
		catchment: { areaM2: null, boundaryAreaM2: null },
		units: [],
		rest: { name: 'Rest of the catchment', areaM2: null, geometry: null },
		dropped: [],
		warnings: [],
		cellSizeM: null,
		zoom: null,
		windowCells: null
	};
	const [row] = await asOwner(
		`INSERT INTO start_proposal (project_id, plan, from_dem, method, method_version) VALUES ($1, $2, false, 'planted', 'start-1') RETURNING id`,
		[projectId, JSON.stringify(plan)]
	);
	return row!.id as string;
}

/**
 * An open delineation proposal on `projectId` (175_delineation), planted as
 * the schema owner so no DEM is read: the project's open one, if any, is
 * superseded first (one open a project). Returns its id.
 */
export async function plantDelineationProposal(projectId: string): Promise<string> {
	await asOwner(`UPDATE delineation_proposal SET status = 'superseded' WHERE project_id = $1 AND status = 'proposed'`, [projectId]);
	const square = { type: 'Polygon', coordinates: [[[21.3, -33.7], [21.32, -33.7], [21.32, -33.68], [21.3, -33.68], [21.3, -33.7]]] };
	const [row] = await asOwner(
		`INSERT INTO delineation_proposal (project_id, click_kind, click_lon, click_lat, outlet_lon, outlet_lat, snap_distance_m, geometry, area_m2, cells,
			cell_size_m, zoom, window_cells, dataset, dataset_fingerprint, method, method_version)
		 VALUES ($1, 'outlet', 21.31, -33.7, 21.31, -33.7, 0, $2, 4000000, 250, 128, 10, 1024, 'Planted', '0000000000000000', 'planted', 'delineate-1') RETURNING id`,
		[projectId, JSON.stringify(square)]
	);
	return row!.id as string;
}
