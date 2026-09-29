import { LEGAL_VERSION } from '@water-management/engine/legal';
import pg from 'pg';
import { createApp } from '../app.js';
import { outbox, type Mail } from '../mail/transport.js';
import { SESSION_COOKIE, signSession } from '../auth/session.js';
import { withUser } from '../db/tx.js';
// (app is only exercised by *.db.test.ts; unit tests import the pure helpers)

export const app = createApp();
const ORIGIN = 'http://localhost:7777';

/**
 * A signed-in test user whose requests carry their session cookie. Confirmed
 * by default, the way a real person gets in: sign up, open the emailed link,
 * sign in (an unconfirmed account can't sign in, issue #57). `{ verified:
 * false }` gives a signed-in, unconfirmed account: no longer reachable by
 * signing in, but the state a session made before confirmation became
 * required is still in, so its session is minted directly (signSession).
 */
export async function signUp(name = 'User', { verified = true }: { verified?: boolean } = {}) {
	const email = `${name.toLowerCase()}-${crypto.randomUUID()}@example.com`;
	const password = 'correct horse';
	const res = await app.request('/auth/register', {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: ORIGIN },
		body: JSON.stringify({ email, password, displayName: name, acceptTerms: LEGAL_VERSION })
	});
	if (res.status !== 202) throw new Error(`register failed: ${res.status} ${await res.text()}`);
	let cookie: string;
	let id: string;
	if (verified) {
		const v = await anon('POST', '/auth/verify-email', { token: tokenIn(lastMailTo(email)) });
		if (v.status !== 200) throw new Error(`verify failed: ${v.status}`);
		const login = await app.request('/auth/login', {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: ORIGIN },
			body: JSON.stringify({ email, password })
		});
		if (login.status !== 200) throw new Error(`login failed: ${login.status} ${await login.text()}`);
		cookie = login.headers.get('set-cookie')!.split(';')[0]!;
		id = ((await login.json()) as { user: { id: string } }).user.id;
	} else {
		id = await userIdOf(email);
		cookie = `${SESSION_COOKIE}=${await signSession(id)}`;
	}
	const call = async (method: string, path: string, body?: unknown) => {
		const r = await app.request(path, {
			method,
			headers: { cookie, origin: ORIGIN, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
			body: body !== undefined ? JSON.stringify(body) : undefined
		});
		const text = await r.text();
		return { status: r.status, body: text ? JSON.parse(text) : null };
	};
	return { id, email, cookie, call };
}

export const monthly = (v: number) => new Array(12).fill(v);

export function node(name: string, downstreamNodeId: string | null, extra: Record<string, unknown> = {}) {
	return {
		id: crypto.randomUUID(),
		name,
		kind: downstreamNodeId ? 'farm' : 'gauge',
		downstreamNodeId,
		sortOrder: 0,
		areaKm2: 10,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: 0,
		pctRunoffToDam: 0.5,
		damCapacityM3: 100_000,
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

/** The newest email sent to `to` (MAIL_TRANSPORT=memory), or undefined. */
export const lastMailTo = (to: string): Mail | undefined => outbox.filter((m) => m.to === to).at(-1);
export const mailCount = (to: string) => outbox.filter((m) => m.to === to).length;

/** The token from a link in an email (`?token=…` or `?invite=…`). */
export function tokenIn(mail: Mail | undefined): string {
	const m = mail?.text.match(/[?&](?:token|invite)=([A-Za-z0-9_-]+)/);
	if (!m) throw new Error(`no token link in ${mail ? `"${mail.subject}"` : 'missing email'}`);
	return m[1]!;
}

/** POST as an anonymous browser (no session cookie). */
export async function anon(method: string, path: string, body?: unknown, cookie?: string) {
	const r = await app.request(path, {
		method,
		headers: { origin: ORIGIN, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
		body: body !== undefined ? JSON.stringify(body) : undefined
	});
	const text = await r.text();
	return { status: r.status, body: text ? JSON.parse(text) : null, headers: r.headers };
}

/**
 * Run SQL as the schema owner — ONLY to arrange test state the API can't
 * (backdating a token to test expiry), or bulk state that isn't under test and
 * would take seconds through the API (a multi-MB series from generate_series).
 * Never used to assert on data.
 */
/** A test account's id by its address (as the schema owner: app_user is under RLS). */
async function userIdOf(email: string): Promise<string> {
	const rows = (await asOwner('SELECT id FROM app_user WHERE email = $1', [email])) as { id: string }[];
	if (!rows[0]) throw new Error(`no account for ${email}`);
	return rows[0].id;
}

export async function asOwner(sql: string, params: unknown[] = []) {
	const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await client.connect();
	try {
		return (await client.query(sql, params)).rows;
	} finally {
		await client.end();
	}
}

/**
 * Turn a run just made through the API into one saved on the legacy runoff
 * model before engine 1.0.0 removed it (issue #16), which the API can no
 * longer make: its settings say 'legacy', its summary has no runoff balance
 * and it stores the [Flow data] trace columns (engine LEGACY_RUNOFF_COLUMNS)
 * instead of GR4J's stores. Test state only, like the rest of asOwner.
 */
export async function makeStoredLegacyRun(runId: string) {
	await asOwner(
		`UPDATE model_run SET engine_version = '0.45.0', summary = summary - 'runoff',
			inputs = jsonb_set(inputs, '{settings,runoffModel}', '"legacy"') WHERE id = $1`,
		[runId]
	);
	await asOwner(
		`DELETE FROM run_series WHERE run_id = $1 AND node_id IS NULL AND key IN ('pet', 'aet', 'exchange', 'production_store', 'routing_store', 'uh_store')`,
		[runId]
	);
	await asOwner(
		`INSERT INTO run_series (run_id, project_id, node_id, key, meta, "values")
		 SELECT s.run_id, s.project_id, NULL, k.key, jsonb_build_object('label', k.label, 'unit', k.unit), s."values"
		 FROM run_series s,
			(VALUES ('is_summer', 'Summer (1) or winter (0)', ''), ('rain_flow', 'Rain-driven flow', 'm³/day'), ('base_flow', 'Underlying base flow', 'm³/day'),
				('response_flow', 'Response flow', 'm³/day'), ('resultant_flow', 'Resultant flow', 'm³/day')) AS k(key, label, unit)
		 WHERE s.run_id = $1 AND s.node_id IS NULL AND s.key = 'natural_flow'`,
		[runId]
	);
}

/**
 * A complete seasonal outlook planted as `userId` (an editor), without its
 * job: one level, "0" (85 %), and each of `farms` with a share of demand met
 * and a dam of 100 000 m³ (issue #53 R5: something to publish to farmers;
 * the outlook job itself is outlooks.db.test.ts's). The season defaults to
 * 2099/2100, so it hasn't ended; no review date.
 */
export async function plantCompleteOutlook(
	userId: string,
	projectId: string,
	runId: string,
	farms: { nodeId: string; p50?: number }[],
	opts: { season?: [string, string]; perFarm?: boolean } = {}
): Promise<string> {
	const [from, to] = opts.season ?? ['2099-10-01', '2100-04-30'];
	const stat = (p50: number, top = 1) => ({ p10: p50 * 0.75, p50, p90: Math.min(top, p50 * 1.2) });
	const level = {
		id: '0',
		label: '85 %',
		problems: [],
		nYears: 12,
		storageByDam: farms.map((f) => ({ nodeId: f.nodeId, name: 'Farm', capacityM3: 100_000, stat: stat(50_000, 100_000) })),
		// perFarm false: an outlook from before engine 1.19.0, without per-farm figures.
		...(opts.perFarm === false ? {} : { demandMetByFarm: farms.map((f) => ({ nodeId: f.nodeId, name: 'Farm', nYears: 12, stat: stat(f.p50 ?? 0.8) })) })
	};
	const result = { decisionDate: from, seasonEnd: to, nYears: 12, levels: [level] };
	return withUser(userId, async (db) => {
		const { rows } = await db.query<{ id: string }>(
			`INSERT INTO seasonal_outlook (project_id, base_run_id, name, decision_date, season_end, review_date, levels)
			 VALUES ($1, $2, 'Planted outlook', $4, $5, NULL, $3) RETURNING id`,
			[projectId, runId, JSON.stringify([{ id: '0', label: '85 %', ops: [{ op: 'demand.scale', factor: 0.85 }] }]), from, to]
		);
		await db.query(`UPDATE seasonal_outlook SET status = 'complete', result = $2, engine_version = 'x' WHERE id = $1`, [rows[0]!.id, JSON.stringify(result)]);
		return rows[0]!.id;
	});
}

