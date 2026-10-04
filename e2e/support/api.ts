// Thin API helpers for arranging test state directly against the backend
// (users, projects, model, series), so each spec only drives the UI it is
// actually about. Every test creates its own users, so tests are independent
// and can run in parallel against the one e2e database.
import { expect, request as apiRequest, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { plantEmailToken, userIdByEmail, verifiedUserIdByEmail } from './db.ts';
import { sessionToken } from './session.ts';
import { API_URL } from './env.ts';
// The terms version the sign-up form sends (acceptTerms): the engine's, by
// path, since this workspace has no dependency on it and legal.ts imports nothing.
import { FARMER_NOTICE_VERSION, LEGAL_VERSION } from '../../packages/engine/src/legal.ts';

export { FARMER_NOTICE_VERSION, LEGAL_VERSION };

export const PASSWORD = 'correct horse battery';

export interface TestUser {
	id: string;
	email: string;
	displayName: string;
	password: string;
}

/** 'contributor': a licence applicant (WP-3.3). */
export type Role = 'contributor' | 'viewer' | 'editor' | 'owner';

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
 * Registers a user the way a person gets in (issue #57): sign up (which signs
 * nobody in), confirm the address (the verify-email endpoint, with a planted
 * link token), sign in. When `request` belongs to a browser context
 * (`page.request` / `context.request`), that context is then signed in as the
 * user, because it shares the context's cookie jar.
 *
 * `{ verified: false }` leaves the address unconfirmed and signs nobody in
 * (an unconfirmed account can't sign in); signInUnconfirmed gives a browser
 * such an account's session, for the pages that still meet one.
 *
 * A signed-in account has also pressed "I understand" on the farm view's
 * notice (POST /auth/me/farm-notice), so a spec about the farm pages meets
 * the figures; `{ farmNotice: false }` leaves it unacknowledged
 * (farm-view.spec.ts tests the notice itself).
 */
export async function register(
	request: APIRequestContext,
	displayName: string,
	{ verified = true, farmNotice = true }: { verified?: boolean; farmNotice?: boolean } = {}
): Promise<TestUser> {
	const email = uniqueEmail(displayName);
	const res = await request.post(`${API_URL}/auth/register`, {
		data: { email, password: PASSWORD, displayName, acceptTerms: LEGAL_VERSION }
	});
	await json(res, 202);
	const id = await userIdByEmail(email);
	if (verified) {
		const token = await plantEmailToken(email, 'verify');
		await json(await request.post(`${API_URL}/auth/verify-email`, { data: { token } }), 200);
		await json(await request.post(`${API_URL}/auth/login`, { data: { email, password: PASSWORD } }), 200);
		if (farmNotice) await acknowledgeFarmNotice(request);
	}
	return { id, email, displayName, password: PASSWORD };
}

/** "I understand" on the farm view's notice, as the account `request` is signed in as. */
export async function acknowledgeFarmNotice(request: APIRequestContext): Promise<void> {
	await json(await request.post(`${API_URL}/auth/me/farm-notice`, { data: { version: FARMER_NOTICE_VERSION } }), 200);
}

/**
 * Signs `context` in as an account that never confirmed its address. Sign-in
 * refuses such an account since issue #57, but a session made before that
 * still reaches the app (the confirm-email banner, the account page's "Not
 * confirmed"), so the session is minted with the e2e API's own key.
 */
export async function signInUnconfirmed(context: BrowserContext, user: TestUser): Promise<void> {
	await context.addCookies([{ name: 'wm_session', value: sessionToken(user.id), url: API_URL, httpOnly: true, sameSite: 'Lax' }]);
}

export async function createProject(request: APIRequestContext, name: string, description?: string): Promise<{ id: string }> {
	const res = await request.post(`${API_URL}/projects`, { data: { name, description } });
	return (await json<{ project: { id: string } }>(res, 201)).project;
}

/**
 * Shows every workspace section in the signed-in account's sidebar (its own choice, `hiddenTabs: []`),
 * instead of the default that hides History, Allocations and Applications (frontend
 * lib/workspace/tabs.ts DEFAULT_HIDDEN_TABS): setup for the specs that reach one of those through the
 * sidebar, or need every section in it. own-sections.spec.ts tests the choice and the default themselves.
 */
export async function showAllSections(request: APIRequestContext): Promise<void> {
	await json(await request.patch(`${API_URL}/auth/me`, { data: { preferences: { hiddenTabs: [] } } }), 200);
}

/**
 * Adds `email` to a project as `role`. Every add by email is an invite (issue #136), and a verified
 * account joins only when its holder accepts, so this accepts it as them (acceptInvites): setup for the
 * specs about something else. invitations.spec.ts tests the invitation itself.
 */
export async function addMember(request: APIRequestContext, projectId: string, email: string, role: Role): Promise<void> {
	const res = await request.post(`${API_URL}/projects/${projectId}/members`, { data: { email, role } });
	await json(res, 201);
	await acceptInvites(email, projectId);
}

/** Let a project's viewers read each registered volume (D3, 162; owners only, off by default). */
export async function setAllocationViewerUnits(request: APIRequestContext, projectId: string, on: boolean): Promise<void> {
	const res = await request.put(`${API_URL}/projects/${projectId}/allocations/viewer-units`, { data: { on } });
	await json(res, 200);
}

/**
 * The holder of `email` pressing Accept on each of their pending invites to `targetId` (a project or a
 * team), through the API as themselves: a session minted for them (session.ts), since the spec's own
 * request context is the inviter's. No account, or one that never confirmed its address: nothing to do
 * (such an address joins once it's confirmed). Returns how many invites it accepted.
 */
export async function acceptInvites(email: string, targetId: string): Promise<number> {
	const id = await verifiedUserIdByEmail(email);
	if (!id) return 0;
	const as = await apiRequest.newContext({ extraHTTPHeaders: { cookie: `wm_session=${sessionToken(id)}` } });
	try {
		const { invites } = await json<{ invites: { id: string; targetId: string }[] }>(await as.get(`${API_URL}/me/invites`), 200);
		const mine = invites.filter((i) => i.targetId === targetId);
		// A JSON body: without one the CSRF guard (app.ts) reads the POST as a form post from nowhere.
		for (const inv of mine) await json(await as.post(`${API_URL}/me/invites/${inv.id}/accept`, { data: {} }), 200);
		return mine.length;
	} finally {
		await as.dispose();
	}
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

/** Nominates a run as the project's evidence (POST /projects/:id/evidence). */
export async function nominateRun(request: APIRequestContext, projectId: string, runId: string, reason: string): Promise<void> {
	const res = await request.post(`${API_URL}/projects/${projectId}/evidence`, { data: { runId, reason } });
	await json(res, 201);
}

/** Copies a project (model, settings, series); returns the copy's id. */
export async function copyProject(request: APIRequestContext, projectId: string, name: string): Promise<string> {
	const res = await request.post(`${API_URL}/projects/${projectId}/copy`, { data: { name } });
	return (await json<{ project: { id: string } }>(res, 201)).project.id;
}

// --- a small synthetic catchment (no client data: names and numbers are made up) ---

export interface Model {
	nodes: Record<string, unknown>[];
	/** `irrigationSystemId` (engine ≥ 1.72.0): a row of the project's table, or a SABI preset's key ('drip'). */
	crops: { id: string; name: string; cropFactor: number[]; irrigationSystemId?: string | null }[];
	cropAreas: { nodeId: string; cropId: string; areaM2: number; irrigationSystemId?: string | null }[];
	transfers: Record<string, unknown>[];
	irrigationSystems?: { id: string; name: string; efficiency: number; preset?: string | null }[];
}

export function node(name: string, kind: 'farm' | 'gauge', downstreamNodeId: string | null, sortOrder: number, extra: Record<string, unknown> = {}) {
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
		returnFlowFraction: 0.1,
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
