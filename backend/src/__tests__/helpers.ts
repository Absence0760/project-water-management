import { createApp } from '../app.js';
// (app is only exercised by *.db.test.ts; unit tests import the pure helpers)

export const app = createApp();
const ORIGIN = 'http://localhost:7777';

/** A signed-in test user whose requests carry their session cookie. */
export async function signUp(name = 'User') {
	const email = `${name.toLowerCase()}-${crypto.randomUUID()}@example.com`;
	const res = await app.request('/auth/register', {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: ORIGIN },
		body: JSON.stringify({ email, password: 'correct horse', displayName: name })
	});
	if (res.status !== 201) throw new Error(`register failed: ${res.status} ${await res.text()}`);
	const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
	const { user } = (await res.json()) as { user: { id: string } };
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
		returnFlowPct: 0.1,
		...extra
	};
}
