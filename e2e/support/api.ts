// Thin API helpers for arranging test state directly against the backend
// (users, projects, model, series), so each spec only drives the UI it is
// actually about. Every test creates its own users, so tests are independent
// and can run in parallel against the one e2e database.
import { expect, type APIRequestContext } from '@playwright/test';
import { plantEmailToken } from './db.ts';
import { API_URL } from './env.ts';

export const PASSWORD = 'correct horse battery';

export interface TestUser {
	id: string;
	email: string;
	displayName: string;
	password: string;
}

export type Role = 'viewer' | 'editor' | 'owner';

async function json<T>(res: Awaited<ReturnType<APIRequestContext['get']>>, status: number): Promise<T> {
	expect(res.status(), `${res.url()} → ${await res.text()}`).toBe(status);
	return (await res.json()) as T;
}

let seq = 0;
/** A unique, human-readable email for this worker/test. */
export function uniqueEmail(name: string): string {
	return `${name.toLowerCase().replace(/\W+/g, '-')}-${process.pid}-${Date.now()}-${++seq}@example.com`;
}

/**
 * Registers a user. When `request` belongs to a browser context
 * (`page.request` / `context.request`), that context is now signed in as
 * the user, because it shares the context's cookie jar.
 *
 * The address is confirmed by default (through the verify-email endpoint,
 * with a planted link token), because only a verified account can be added
 * to a project or team directly; pass `{ verified: false }` for a fresh,
 * unconfirmed account.
 */
export async function register(
	request: APIRequestContext,
	displayName: string,
	{ verified = true }: { verified?: boolean } = {}
): Promise<TestUser> {
	const email = uniqueEmail(displayName);
	const res = await request.post(`${API_URL}/auth/register`, {
		data: { email, password: PASSWORD, displayName }
	});
	const { user } = await json<{ user: { id: string } }>(res, 201);
	if (verified) {
		const token = await plantEmailToken(email, 'verify');
		await json(await request.post(`${API_URL}/auth/verify-email`, { data: { token } }), 200);
	}
	return { id: user.id, email, displayName, password: PASSWORD };
}

export async function createProject(request: APIRequestContext, name: string, description?: string): Promise<{ id: string }> {
	const res = await request.post(`${API_URL}/projects`, { data: { name, description } });
	return (await json<{ project: { id: string } }>(res, 201)).project;
}

export async function addMember(request: APIRequestContext, projectId: string, email: string, role: Role): Promise<void> {
	const res = await request.post(`${API_URL}/projects/${projectId}/members`, { data: { email, role } });
	await json(res, 201);
}

export async function updateSettings(request: APIRequestContext, projectId: string, settings: Record<string, unknown>): Promise<void> {
	const res = await request.patch(`${API_URL}/projects/${projectId}`, { data: { settings } });
	await json(res, 200);
}

export async function putModel(request: APIRequestContext, projectId: string, model: Model): Promise<void> {
	const res = await request.put(`${API_URL}/projects/${projectId}/model`, { data: model });
	await json(res, 200);
}

export async function putSeries(
	request: APIRequestContext,
	projectId: string,
	s: { kind: string; name?: string; unit: string; startDate: string; values: (number | null)[]; product?: string; productVersion?: string }
): Promise<void> {
	const res = await request.put(`${API_URL}/projects/${projectId}/series`, { data: s });
	await json(res, 200);
}

/** Runs the model; returns the new run's id. */
export async function createRun(request: APIRequestContext, projectId: string, label: string): Promise<string> {
	const res = await request.post(`${API_URL}/projects/${projectId}/runs`, { data: { label } });
	return (await json<{ run: { id: string } }>(res, 201)).run.id;
}

/** Copies a project (model, settings, series); returns the copy's id. */
export async function copyProject(request: APIRequestContext, projectId: string, name: string): Promise<string> {
	const res = await request.post(`${API_URL}/projects/${projectId}/copy`, { data: { name } });
	return (await json<{ project: { id: string } }>(res, 201)).project.id;
}

// --- a small synthetic catchment (no client data: names and numbers are made up) ---

export interface Model {
	nodes: Record<string, unknown>[];
	crops: { id: string; name: string; cropFactor: number[] }[];
	cropAreas: { nodeId: string; cropId: string; areaM2: number }[];
	transfers: Record<string, unknown>[];
}

function node(name: string, kind: 'farm' | 'gauge', downstreamNodeId: string | null, sortOrder: number, extra: Record<string, unknown> = {}) {
	return {
		id: crypto.randomUUID(),
		name,
		kind,
		downstreamNodeId,
		sortOrder,
		areaKm2: 12,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: 0,
		pctRunoffToDam: 0.5,
		damCapacityM3: 0,
		damInitialPct: 0.5,
		damMinPct: 0.1,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 0.8,
		lossReturnFraction: 0.5,
		damAreaFullM2: null,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...extra
	};
}

/** Outflow gauge + two farms with dams, one crop planted on both, one transfer. */
export function sampleModel(): Model {
	const gauge = node('Outflow gauge', 'gauge', null, 1, { pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const upper = node('Upper farm', 'farm', gauge.id, 2, { damCapacityM3: 150_000 });
	const lower = node('Lower farm', 'farm', gauge.id, 3, { damCapacityM3: 90_000, areaKm2: 8 });
	const crop = { id: crypto.randomUUID(), name: 'Orchard', cropFactor: [0.6, 0.7, 0.8, 0.8, 0.8, 0.7, 0.6, 0.5, 0.4, 0.4, 0.5, 0.6] };
	return {
		nodes: [gauge, upper, lower],
		crops: [crop],
		cropAreas: [
			{ nodeId: upper.id, cropId: crop.id, areaM2: 200_000 },
			{ nodeId: lower.id, cropId: crop.id, areaM2: 120_000 }
		],
		transfers: [
			{
				id: crypto.randomUUID(),
				fromNodeId: upper.id,
				toNodeId: lower.id,
				months: [11, 12, 1, 2],
				maxRateM3s: 0.01,
				dailyCapM3: null,
				minStoragePct: 0.2,
				enabled: true,
				priority: 0
			}
		]
	};
}

/** Deterministic synthetic daily rain (mm): dry spells with a storm every 9 days. */
export function syntheticRain(days: number): number[] {
	return Array.from({ length: days }, (_, i) => (i % 9 === 0 ? 18 + (i % 5) : i % 4 === 0 ? 2.5 : 0));
}

/** Deterministic synthetic observed flow (m³/s). */
export function syntheticFlow(days: number): number[] {
	return Array.from({ length: days }, (_, i) => Math.round((0.05 + 0.3 * Math.exp(-(i % 9) / 3)) * 1000) / 1000);
}

/** A project with a model, rain + observed flow and A-pan evaporation, ready to run. */
export async function seedRunnableProject(request: APIRequestContext, name: string): Promise<{ id: string; model: Model }> {
	const project = await createProject(request, name);
	const model = sampleModel();
	await putModel(request, project.id, model);
	await updateSettings(request, project.id, {
		apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110],
		ewrPragmaticM3PerDay: [2000, 1500, 1000, 1000, 1000, 1500, 2500, 4000, 5000, 5000, 4000, 3000]
	});
	const days = 120;
	await putSeries(request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: syntheticRain(days) });
	await putSeries(request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2021-10-01', values: syntheticFlow(days) });
	return { id: project.id, model };
}
