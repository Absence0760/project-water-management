// The assistant against Postgres (routes.ts, usage.ts,
// 258_assistant_usage.sql):
//  - off (the default): GET says unavailable, POST is 404 assistant_off, nothing counted;
//  - on (mock): viewers chat, editors may Apply, farmers and contributors get 403, non-members 404;
//  - a turn streams to `usage` and `done`, and is charged to the caller's row this month;
//  - the tools run in a read-only transaction as the caller;
//  - RLS: a person reads only their own usage rows (positive control: they do read them), and
//    neither table can be written but through the functions;
//  - the month's budget spent: 429 assistant_budget_spent with Retry-After, another project still chats;
//  - the hourly cap: 429 assistant_rate_limited with Retry-After, nothing counted; parallel turns
//    are counted one by one, so no more than the cap get through;
//  - parallel charges are each counted once;
//  - an oversized message is 413 before anything is counted; a run of another project is 404;
//  - "Download my data" carries the person's usage rows.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { app, asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { MOCK_IDLE_ANSWER } from './providers/mock.js';
import { ASSISTANT_DISCLAIMER, setAssistantTools, setProviderFactory } from './routes.js';
import type { AssistantProvider, AssistantStreamEvent, ProviderEvent } from './types.js';
import { chargeTurn } from './usage.js';

type User = Awaited<ReturnType<typeof signUp>>;
let owner: User;
let editor: User;
let viewer: User;
let contributor: User;
let farmer: User;
let outsider: User;
let projectId: string;
let otherId: string;
/** A run of the other project. */
let otherRunId: string;
const ORIGIN = 'http://localhost:7777';
const at = (p: string, pid = projectId) => `/projects/${pid}${p}`;

function post(u: User, body: unknown, pid = projectId) {
	return app.request(at('/assistant/messages', pid), {
		method: 'POST',
		headers: { cookie: u.cookie, origin: ORIGIN, 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
}
const ask = (content = 'Hello') => ({ messages: [{ role: 'user', content }] });

/** The events of a streamed answer, in order. */
async function events(res: Response): Promise<AssistantStreamEvent[]> {
	const text = await res.text();
	return text
		.split('\n\n')
		.filter((block) => block.startsWith('event: '))
		.map((block) => JSON.parse(block.split('\n')[1]!.slice('data: '.length)) as AssistantStreamEvent);
}

const usageRows = (pid = projectId) =>
	asOwner(
		`SELECT user_id, input_tokens::int AS input, output_tokens::int AS output, messages FROM assistant_usage WHERE project_id = $1 ORDER BY user_id`,
		[pid]
	) as Promise<{ user_id: string | null; input: number; output: number; messages: number }[]>;
const rateOf = (u: User) => asOwner('SELECT messages FROM assistant_rate WHERE user_id = $1', [u.id]).then((r) => (r[0]?.messages as number | undefined) ?? 0);
const clearCounts = async () => {
	await asOwner('DELETE FROM assistant_usage WHERE project_id = ANY($1)', [[projectId, otherId]]);
	await asOwner('DELETE FROM assistant_rate WHERE user_id = ANY($1)', [[owner, editor, viewer, contributor, farmer, outsider].map((u) => u.id)]);
};

beforeAll(async () => {
	[owner, editor, viewer, contributor, farmer, outsider] = (await Promise.all(['Aowner', 'Aeditor', 'Aviewer', 'Acontrib', 'Afarmer', 'Aoutsider'].map((n) => signUp(n)))) as User[] as [
		User,
		User,
		User,
		User,
		User,
		User
	];
	projectId = (await owner.call('POST', '/projects', { name: 'Assistant' })).body.project.id;
	otherId = (await owner.call('POST', '/projects', { name: 'Assistant, other' })).body.project.id;
	const outlet = node('Weir', null);
	const farm = node('Farm A', outlet.id);
	expect((await owner.call('PUT', at('/model'), { nodes: [outlet, farm], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer'],
		[contributor, 'contributor']
	] as const) {
		expect((await owner.call('POST', at('/members'), { email: u.email, role })).status).toBe(201);
	}
	expect((await owner.call('POST', at('/members', otherId), { email: viewer.email, role: 'viewer' })).status).toBe(201);
	const otherOutlet = node('Outlet', null);
	const otherFarm = node('Farm', otherOutlet.id);
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const otherModel = { nodes: [otherOutlet, otherFarm], crops: [crop], cropAreas: [{ nodeId: otherFarm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
	expect((await owner.call('PUT', at('/model', otherId), otherModel)).status).toBe(200);
	expect((await owner.call('PATCH', at('', otherId), { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 60 }, (_, i) => (i % 5 === 0 ? 10 : 0));
	expect((await owner.call('PUT', at('/series', otherId), { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	const run = await owner.call('POST', at('/runs', otherId), { label: 'Other run' });
	expect(run.status, JSON.stringify(run.body)).toBe(201);
	otherRunId = run.body.run.id;
	expect((await owner.call('POST', at('/farmers'), { email: farmer.email, nodeIds: [farm.id] })).status).toBe(201);
}, 60_000);

afterEach(async () => {
	vi.unstubAllEnvs();
	setProviderFactory(null);
	setAssistantTools(null);
	await clearCounts();
});

afterAll(async () => {
	await asOwner('DELETE FROM assistant_usage WHERE project_id = ANY($1)', [[projectId, otherId]]);
});

describe('the assistant, off (the default)', () => {
	it('tells a viewer it is unavailable, and refuses a message with 404 assistant_off, counting nothing', async () => {
		vi.stubEnv('ASSISTANT_PROVIDER', 'off');
		expect(await viewer.call('GET', at('/assistant'))).toMatchObject({ status: 200, body: { available: false } });
		const res = await post(viewer, ask());
		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({ code: 'assistant_off' });
		expect(await usageRows()).toEqual([]);
		expect(await rateOf(viewer)).toBe(0);
	});

	it('still answers a non-member 404 not found (the role check comes first)', async () => {
		vi.stubEnv('ASSISTANT_PROVIDER', 'off');
		const r = await outsider.call('GET', at('/assistant'));
		expect(r.status).toBe(404);
		expect(r.body.code).toBeUndefined();
	});
});

describe('the assistant, on (mock)', () => {
	it('shows a viewer the status without Apply, and an editor and the owner with it', async () => {
		vi.stubEnv('ASSISTANT_PROVIDER', 'mock');
		const v = await viewer.call('GET', at('/assistant'));
		expect(v.status).toBe(200);
		expect(v.body).toEqual({
			available: true,
			provider: 'mock',
			canApply: false,
			budget: { tokensPerMonth: 2_000_000, tokensUsed: 0, resetsAt: expect.stringMatching(/^\d{4}-\d{2}-01T00:00:00\.000Z$/) },
			rate: { messagesPerHour: 30 },
			disclaimer: ASSISTANT_DISCLAIMER
		});
		expect((await editor.call('GET', at('/assistant'))).body.canApply).toBe(true);
		expect((await owner.call('GET', at('/assistant'))).body.canApply).toBe(true);
	});

	it('refuses a farmer and a contributor 403 and a non-member 404, on both routes, counting nothing', async () => {
		vi.stubEnv('ASSISTANT_PROVIDER', 'mock');
		for (const [u, status] of [
			[farmer, 403],
			[contributor, 403],
			[outsider, 404]
		] as const) {
			expect((await u.call('GET', at('/assistant'))).status).toBe(status);
			expect((await post(u, ask())).status).toBe(status);
			expect(await rateOf(u)).toBe(0);
		}
		expect(await usageRows()).toEqual([]);
	});

	it('streams a viewer’s turn to usage and done, and charges it to their row this month', async () => {
		vi.stubEnv('ASSISTANT_PROVIDER', 'mock');
		const res = await post(viewer, ask());
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
		const evs = await events(res);
		expect(evs.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('')).toBe(MOCK_IDLE_ANSWER);
		const usage = evs.at(-2);
		expect(evs.at(-1)).toEqual({ type: 'done' });
		expect(usage).toMatchObject({ type: 'usage', tokensPerMonth: 2_000_000 });
		const rows = await usageRows();
		expect(rows).toEqual([{ user_id: viewer.id, input: expect.any(Number), output: expect.any(Number), messages: 1 }]);
		expect(rows[0]!.input).toBeGreaterThan(0);
		if (usage?.type !== 'usage') throw new Error('no usage event');
		expect([usage.inputTokens, usage.outputTokens, usage.tokensUsed]).toEqual([rows[0]!.input, rows[0]!.output, rows[0]!.input + rows[0]!.output]);
		expect((await viewer.call('GET', at('/assistant'))).body.budget.tokensUsed).toBe(usage.tokensUsed);
		expect(await rateOf(viewer)).toBe(1);
	});

	it('runs each tool in a read-only transaction as the caller, with the conversation’s run', async () => {
		vi.stubEnv('ASSISTANT_PROVIDER', 'mock');
		const seen: unknown[] = [];
		setAssistantTools([
			{
				spec: { name: 'probe', description: 'probe', parameters: { type: 'object', properties: {} } },
				label: 'Probing',
				run: async (ctx) => {
					const { rows } = await ctx.db.query<{ uid: string; ro: string }>(
						"SELECT current_setting('app.current_user_id') AS uid, current_setting('transaction_read_only') AS ro"
					);
					// A write is refused in it.
					const write = await ctx.db.query('CREATE TEMP TABLE nope (x int)').then(
						() => 'wrote',
						(e: { code?: string }) => e.code
					);
					seen.push({ ...rows[0], write, projectId: ctx.projectId, runId: ctx.runId, userId: ctx.userId });
					return { ok: true, data: 'ok' };
				}
			}
		]);
		const provider: AssistantProvider = {
			name: 'mock',
			async *complete(req): AsyncIterable<ProviderEvent> {
				if (!req.messages.some((m) => m.role === 'tool')) yield { type: 'tool_call', call: { id: 'p1', name: 'probe', arguments: {} } };
				else yield { type: 'text', delta: 'done' };
				yield { type: 'usage', inputTokens: 1, outputTokens: 1 };
			}
		};
		setProviderFactory(() => provider);
		const evs = await events(await post(viewer, ask()));
		expect(evs.map((e) => e.type)).toEqual(['tool', 'tool', 'text', 'usage', 'done']);
		expect(seen).toEqual([{ uid: viewer.id, ro: 'on', write: '25006', projectId, runId: null, userId: viewer.id }]);
	});

	it('refuses another project’s run (and one that doesn’t exist) with 404, counting nothing', async () => {
		vi.stubEnv('ASSISTANT_PROVIDER', 'mock');
		expect((await post(viewer, { ...ask(), runId: otherRunId })).status).toBe(404);
		expect((await post(viewer, { ...ask(), runId: crypto.randomUUID() })).status).toBe(404);
		expect(await rateOf(viewer)).toBe(0);
		// Positive control: the run on its own project.
		expect((await post(viewer, { ...ask(), runId: otherRunId }, otherId)).status).toBe(200);
	});

	it('refuses a newest message past ASSISTANT_MAX_INPUT_CHARS with 413 assistant_input_too_large, counting nothing', async () => {
		vi.stubEnv('ASSISTANT_PROVIDER', 'mock');
		vi.stubEnv('ASSISTANT_MAX_INPUT_CHARS', '50');
		const res = await post(viewer, ask('x'.repeat(51)));
		expect(res.status).toBe(413);
		expect(await res.json()).toMatchObject({ code: 'assistant_input_too_large' });
		expect(await rateOf(viewer)).toBe(0);
		// Positive control: older turns past the cap are dropped, not refused.
		expect((await post(viewer, { messages: [{ role: 'user', content: 'y'.repeat(60) }, { role: 'assistant', content: 'z' }, { role: 'user', content: 'Hello' }] })).status).toBe(200);
	});

	it('refuses a turn once the project’s month is spent: 429 assistant_budget_spent with Retry-After to the month’s end; another project still chats', async () => {
		vi.stubEnv('ASSISTANT_PROVIDER', 'mock');
		vi.stubEnv('ASSISTANT_TOKENS_PER_MONTH', '1000');
		await asOwner(
			`INSERT INTO assistant_usage (project_id, user_id, month, input_tokens, output_tokens) VALUES ($1, $2, date_trunc('month', now() AT TIME ZONE 'UTC')::date, 900, 100)`,
			[projectId, owner.id]
		);
		const res = await post(viewer, ask());
		expect(res.status).toBe(429);
		expect(await res.json()).toMatchObject({ code: 'assistant_budget_spent' });
		const wait = Number(res.headers.get('retry-after'));
		const now = new Date();
		const toMonthEnd = (Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - now.getTime()) / 1000;
		expect(Math.abs(wait - toMonthEnd)).toBeLessThan(60);
		expect(await rateOf(viewer)).toBe(0);
		expect((await viewer.call('GET', at('/assistant'))).body.budget).toMatchObject({ tokensPerMonth: 1000, tokensUsed: 1000 });
		// Positive control: the same person on another project.
		expect((await post(viewer, ask(), otherId)).status).toBe(200);
		// Last month's spend doesn't count.
		await asOwner(`UPDATE assistant_usage SET month = (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month')::date WHERE project_id = $1`, [projectId]);
		expect((await post(viewer, ask())).status).toBe(200);
	});

	it('refuses past the hourly cap: 429 assistant_rate_limited with Retry-After, nothing counted; an hour on it starts again', async () => {
		vi.stubEnv('ASSISTANT_PROVIDER', 'mock');
		vi.stubEnv('ASSISTANT_MESSAGES_PER_HOUR', '2');
		expect((await post(viewer, ask())).status).toBe(200);
		expect((await post(viewer, ask(), otherId)).status).toBe(200);
		const res = await post(viewer, ask());
		expect(res.status).toBe(429);
		const body = await res.json();
		expect(body).toMatchObject({ code: 'assistant_rate_limited', params: { seconds: expect.any(Number) } });
		const wait = Number(res.headers.get('retry-after'));
		expect(wait).toBeGreaterThan(3500);
		expect(wait).toBeLessThanOrEqual(3600);
		expect(await rateOf(viewer)).toBe(2);
		// Positive control: the cap is the person's, not the project's.
		expect((await post(editor, ask())).status).toBe(200);
		await asOwner(`UPDATE assistant_rate SET window_start = now() - interval '61 minutes' WHERE user_id = $1`, [viewer.id]);
		expect((await post(viewer, ask())).status).toBe(200);
		expect(await rateOf(viewer)).toBe(1);
	});

	it('counts parallel turns one by one: no more than the hourly cap get through', async () => {
		vi.stubEnv('ASSISTANT_PROVIDER', 'mock');
		vi.stubEnv('ASSISTANT_MESSAGES_PER_HOUR', '3');
		const all = await Promise.all(Array.from({ length: 8 }, (_, i) => post(viewer, ask(), i % 2 ? otherId : projectId)));
		await Promise.all(all.map((r) => r.text()));
		expect(all.map((r) => r.status).sort()).toEqual([200, 200, 200, 429, 429, 429, 429, 429]);
		expect(await rateOf(viewer)).toBe(3);
		const messages = (await usageRows()).concat(await usageRows(otherId)).reduce((n, r) => n + r.messages, 0);
		expect(messages).toBe(3);
	});

	it('counts parallel charges once each', async () => {
		const n = 12;
		const totals = await Promise.all(Array.from({ length: n }, () => chargeTurn(viewer.id, projectId, 10, 5)));
		expect(totals.every((t) => t !== null)).toBe(true);
		expect(Math.max(...(totals as number[]))).toBe(n * 15);
		expect(new Set(totals).size).toBe(n);
		expect(await usageRows()).toEqual([{ user_id: viewer.id, input: n * 10, output: n * 5, messages: 0 }]);
	});
});

describe('the usage tables under RLS', () => {
	it('lets a person read their own usage rows only (positive control: they do), and write neither table directly', async () => {
		await chargeTurn(viewer.id, projectId, 3, 4);
		await chargeTurn(editor.id, projectId, 5, 6);
		const own = await withUser(viewer.id, (db) => db.query('SELECT user_id, input_tokens::int AS i FROM assistant_usage WHERE project_id = $1', [projectId]));
		expect(own.rows).toEqual([{ user_id: viewer.id, i: 3 }]);
		// The project's total is the definer function's, for any member.
		const total = await withUser(viewer.id, (db) => db.query<{ t: string }>('SELECT app_assistant_used($1) AS t', [projectId]));
		expect(Number(total.rows[0]!.t)).toBe(18);
		for (const sql of [
			`INSERT INTO assistant_usage (project_id, user_id, month) VALUES ('${projectId}', '${viewer.id}', '2020-01-01')`,
			`UPDATE assistant_usage SET input_tokens = 0 WHERE user_id = '${viewer.id}'`,
			`DELETE FROM assistant_usage WHERE user_id = '${viewer.id}'`
		]) {
			await expect(withUser(viewer.id, (db) => db.query(sql)), sql).rejects.toMatchObject({ code: '42501' });
		}
		// assistant_rate: the deny-all policy hides every row and refuses every write.
		await expect(withUser(viewer.id, (db) => db.query(`INSERT INTO assistant_rate (user_id) VALUES ('${viewer.id}')`))).rejects.toMatchObject({ code: '42501' });
		await asOwner(`INSERT INTO assistant_rate (user_id, messages) VALUES ($1, 5)`, [viewer.id]);
		expect((await withUser(viewer.id, (db) => db.query('SELECT * FROM assistant_rate'))).rows).toEqual([]);
	});

	it('refuses the functions to a non-member, a farmer and no user: nobody spends another project’s budget', async () => {
		for (const u of [outsider, farmer]) {
			await expect(withUser(u.id, (db) => db.query('SELECT app_assistant_charge($1, 1, 1)', [projectId]))).rejects.toMatchObject({ code: '42501' });
			await expect(withUser(u.id, (db) => db.query('SELECT * FROM app_assistant_begin($1, 100, 10)', [projectId]))).rejects.toMatchObject({ code: '42501' });
			expect((await withUser(u.id, (db) => db.query('SELECT app_assistant_used($1) AS t', [projectId]))).rows[0].t).toBeNull();
		}
		expect(await chargeTurn(outsider.id, projectId, 1, 1)).toBeNull();
		expect(await usageRows()).toEqual([]);
	});
});

describe('Download my data', () => {
	it('carries the person’s usage rows, counts only', async () => {
		await chargeTurn(viewer.id, projectId, 7, 8);
		await asOwner('UPDATE app_user SET data_exported_at = NULL WHERE id = $1', [viewer.id]);
		const r = await viewer.call('GET', '/auth/me/export');
		expect(r.status).toBe(200);
		expect(r.body.assistantUsage).toEqual([
			{ projectId, month: new Date().toISOString().slice(0, 7), inputTokens: 7, outputTokens: 8, messages: 0, updatedAt: expect.any(String) }
		]);
	});
});
