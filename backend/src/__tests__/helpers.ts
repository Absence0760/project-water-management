import pg from 'pg';
import { createApp } from '../app.js';
import { outbox, type Mail } from '../mail/transport.js';
// (app is only exercised by *.db.test.ts; unit tests import the pure helpers)

export const app = createApp();
const ORIGIN = 'http://localhost:7777';

/**
 * A signed-in test user whose requests carry their session cookie. Verified by
 * default (through the emailed link, as a real user would), because only a
 * verified account can be added to a project or team directly; pass
 * `{ verified: false }` to keep the fresh, unconfirmed state.
 */
export async function signUp(name = 'User', { verified = true }: { verified?: boolean } = {}) {
	const email = `${name.toLowerCase()}-${crypto.randomUUID()}@example.com`;
	const res = await app.request('/auth/register', {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: ORIGIN },
		body: JSON.stringify({ email, password: 'correct horse', displayName: name })
	});
	if (res.status !== 201) throw new Error(`register failed: ${res.status} ${await res.text()}`);
	const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
	const { user } = (await res.json()) as { user: { id: string } };
	if (verified) {
		const v = await anon('POST', '/auth/verify-email', { token: tokenIn(lastMailTo(email)) });
		if (v.status !== 200) throw new Error(`verify failed: ${v.status}`);
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
	return { id: user.id, email, cookie, call };
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
export async function asOwner(sql: string, params: unknown[] = []) {
	const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await client.connect();
	try {
		return (await client.query(sql, params)).rows;
	} finally {
		await client.end();
	}
}
