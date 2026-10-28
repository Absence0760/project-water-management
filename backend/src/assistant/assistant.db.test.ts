// The assistant against Postgres (routes.ts, usage.ts,
// 262_assistant_usage.sql):
//  - off (the default): GET says unavailable, POST is 404 assistant_off, nothing counted;
//  - on (mock): viewers chat, editors may Apply, farmers and contributors get 403, non-members 404;
//  - a turn streams to `usage` and `done`, and is charged to the caller's row this month;
//  - the tools run in a read-only transaction as the caller;
//  - RLS: a person reads only their own usage rows (positive control: they do read them), and
//    neither table can be written but through the functions;
//  - tokens count weighted (input + 5 × output) against three monthly caps: the project's spent is
//    429 assistant_budget_spent (another project still chats), the person's across projects
//    429 assistant_user_budget_spent (another person still chats), the deployment's
//    429 assistant_total_budget_spent (nobody chats, on any project), each with Retry-After; the
//    status shows the cap nearest its end; parallel turns past a spent deployment are all refused;
//  - the hourly cap: 429 assistant_rate_limited with Retry-After, nothing counted; parallel turns
//    are counted one by one, so no more than the cap get through;
//  - parallel charges are each counted once;
//  - an oversized message is 413 before anything is counted; a run of another project is 404;
//  - "Download my data" carries the person's usage rows;
//  - the tick purges rate rows past their hour and usage rows past ASSISTANT_USAGE_RETENTION_MONTHS;
//  - a tool's statements are cut at TOOL_STATEMENT_TIMEOUT_MS, and the turn's signal ends a hung one.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { app, asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { MOCK_IDLE_ANSWER } from './providers/mock.js';
import { ASSISTANT_DISCLAIMER, setAssistantTools, setProviderFactory } from './routes.js';
import type { AssistantProvider, AssistantStreamEvent, ProviderEvent } from './types.js';
import { assistantConfig } from './config.js';
import { firstHopInput, turnFloor } from './orchestrator.js';
import { systemPrompt } from './prompt.js';
import { chargeTurn } from './usage.js';
import { ASSISTANT_USAGE_RETENTION_MONTHS, runTick } from '../jobs/runner.js';
import { runToolBounded, TOOL_STATEMENT_TIMEOUT_MS } from './routes.js';

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
/** This month's weighted tokens across every project, spent and reserved (other files' rows included): the deployment's cap is set from it. */
const monthTotal = async () =>
	Number(
		(
			await asOwner(
				`SELECT (SELECT coalesce(sum(input_tokens + 5 * output_tokens), 0) FROM assistant_usage WHERE month = date_trunc('month', now() AT TIME ZONE 'UTC')::date)
				      + (SELECT coalesce(sum(reserved), 0) FROM assistant_reservation WHERE month = date_trunc('month', now() AT TIME ZONE 'UTC')::date) AS t`
			)
		)[0]!.t
	);
/** The reservations on the two projects (264), oldest first. */
const reservations = () =>
	asOwner(
		`SELECT id, user_id, project_id, reserved::int AS reserved, month::text AS month FROM assistant_reservation WHERE project_id = ANY($1) ORDER BY created_at, id`,
		[[projectId, otherId]]
	) as Promise<{ id: string; user_id: string | null; project_id: string; reserved: number; month: string }[]>;
/**
 * app_assistant_begin as the route calls it, with the caps given (the others far off): the hourly cap 1000, a turn
 * at most `max` and at least `min` weighted tokens, a reservation of 300 s.
 */
function begin(u: User, pid: string, caps: { project?: number; user?: number; total?: number; max?: number; min?: number } = {}) {
	return withUser(u.id, async (db) => {
		const { rows } = await db.query<{ outcome: string; reservation_id: string | null; budget: string | null }>(
			'SELECT outcome, reservation_id, budget FROM app_assistant_begin($1, $2, 1000, $3, $4, $5, $6, 300)',
			[pid, caps.project ?? 1e9, caps.user ?? 1e9, caps.total ?? 1e13, caps.max ?? 20_000, caps.min ?? 5_000]
		);
		const r = rows[0]!;
		return { outcome: r.outcome, reservationId: r.reservation_id, budget: r.budget === null ? null : Number(r.budget) };
	});
}
const charge = (u: User, pid: string, reservationId: string | null, input: number, output: number) =>
	withUser(u.id, (db) => db.query('SELECT * FROM app_assistant_charge($1, $2, $3, $4)', [pid, reservationId, input, output]));
const usedBy = async (u: User, pid = projectId) => {
	const { rows } = await withUser(u.id, (db) => db.query<{ p: string; u: string; t: string }>('SELECT project_used AS p, user_used AS u, total_used AS t FROM app_assistant_used($1)', [pid]));
	return { project: Number(rows[0]!.p), user: Number(rows[0]!.u), total: Number(rows[0]!.t) };
};
/** This UTC month, as Postgres has it (YYYY-MM-01). */
const utcMonth = async () => (await asOwner(`SELECT date_trunc('month', now() AT TIME ZONE 'UTC')::date::text AS m`))[0]!.m as string;
const rateOf = (u: User) => asOwner('SELECT messages FROM assistant_rate WHERE user_id = $1', [u.id]).then((r) => (r[0]?.messages as number | undefined) ?? 0);
const clearCounts = async () => {
	await asOwner('DELETE FROM assistant_reservation WHERE project_id = ANY($1)', [[projectId, otherId]]);
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
	await asOwner('DELETE FROM assistant_reservation WHERE project_id = ANY($1)', [[projectId, otherId]]);
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
		// The project's cap is the nearest its end here (the person's and the deployment's are far off).
		vi.stubEnv('ASSISTANT_TOKENS_PER_USER_MONTH', '5000000');
		vi.stubEnv('ASSISTANT_TOKENS_PER_MONTH_TOTAL', '200000000');
		const v = await viewer.call('GET', at('/assistant'));
		expect(v.status).toBe(200);
		expect(v.body).toEqual({
			available: true,
			provider: 'mock',
			canApply: false,
			budget: { tokensPerMonth: 2_000_000, tokensUsed: 0, scope: 'project', resetsAt: expect.stringMatching(/^\d{4}-\d{2}-01T00:00:00\.000Z$/) },
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

	it('streams a viewer’s turn to usage and done, and charges it to their row this month, output weighted ×5', async () => {
		vi.stubEnv('ASSISTANT_PROVIDER', 'mock');
		vi.stubEnv('ASSISTANT_TOKENS_PER_USER_MONTH', '5000000');
		vi.stubEnv('ASSISTANT_TOKENS_PER_MONTH_TOTAL', '200000000');
		const logs = vi.spyOn(console, 'info');
		const res = await post(viewer, ask());
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
		const evs = await events(res);
		expect(evs.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('')).toBe(MOCK_IDLE_ANSWER);
		const usage = evs.at(-2);
		expect(evs.at(-1)).toEqual({ type: 'done' });
		expect(usage).toMatchObject({ type: 'usage', tokensPerMonth: 2_000_000, scope: 'project' });
		const rows = await usageRows();
		expect(rows).toEqual([{ user_id: viewer.id, input: expect.any(Number), output: expect.any(Number), messages: 1 }]);
		expect(rows[0]!.input).toBeGreaterThan(0);
		if (usage?.type !== 'usage') throw new Error('no usage event');
		expect(rows[0]!.output).toBeGreaterThan(0);
		expect([usage.inputTokens, usage.outputTokens, usage.tokensUsed]).toEqual([rows[0]!.input, rows[0]!.output, rows[0]!.input + 5 * rows[0]!.output]);
		expect((await viewer.call('GET', at('/assistant'))).body.budget.tokensUsed).toBe(usage.tokensUsed);
		expect(await rateOf(viewer)).toBe(1);
		// The turn's reservation is settled by its charge (264): nothing left reserved.
		expect(await reservations()).toEqual([]);
		// One line for the turn's spend, counts only: the hourly spend alarm sums weightedTokens (infra/alarms.tf).
		const turn = logs.mock.calls.map((c) => (typeof c[0] === 'string' ? JSON.parse(c[0]) : c[0])).find((l) => l.event === 'assistant_turn');
		expect(turn).toEqual({ event: 'assistant_turn', inputTokens: rows[0]!.input, outputTokens: rows[0]!.output, weightedTokens: usage.tokensUsed, end: 'answered' });
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
		vi.stubEnv('ASSISTANT_TOKENS_PER_MONTH', '100000');
		await asOwner(
			// 50,000 + 5 × 10,000: the month's 100,000 weighted tokens (a cap well over a turn's floor, so the controls below can run).
			`INSERT INTO assistant_usage (project_id, user_id, month, input_tokens, output_tokens) VALUES ($1, $2, date_trunc('month', now() AT TIME ZONE 'UTC')::date, 50000, 10000)`,
			[projectId, owner.id]
		);
		const res = await post(viewer, ask());
		expect(res.status).toBe(429);
		expect(await res.json()).toMatchObject({ code: 'assistant_budget_spent', params: { scope: 'project' } });
		const wait = Number(res.headers.get('retry-after'));
		const now = new Date();
		const toMonthEnd = (Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - now.getTime()) / 1000;
		expect(Math.abs(wait - toMonthEnd)).toBeLessThan(60);
		expect(await rateOf(viewer)).toBe(0);
		expect((await viewer.call('GET', at('/assistant'))).body.budget).toMatchObject({ tokensPerMonth: 100_000, tokensUsed: 100_000, scope: 'project' });
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

	it('refuses a person whose month is spent across projects: 429 assistant_user_budget_spent; another person still chats', async () => {
		vi.stubEnv('ASSISTANT_PROVIDER', 'mock');
		vi.stubEnv('ASSISTANT_TOKENS_PER_USER_MONTH', '100000');
		// Spent on the other project: the person's cap spans their projects.
		await asOwner(
			`INSERT INTO assistant_usage (project_id, user_id, month, input_tokens, output_tokens) VALUES ($1, $2, date_trunc('month', now() AT TIME ZONE 'UTC')::date, 50000, 10000)`,
			[otherId, viewer.id]
		);
		const res = await post(viewer, ask());
		expect(res.status).toBe(429);
		expect(await res.json()).toMatchObject({ code: 'assistant_user_budget_spent', params: { scope: 'user', seconds: expect.any(Number) } });
		expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
		expect(await rateOf(viewer)).toBe(0);
		expect((await viewer.call('GET', at('/assistant'))).body.budget).toMatchObject({ tokensPerMonth: 100_000, tokensUsed: 100_000, scope: 'user' });
		// Positive control: someone else on the same project.
		expect((await post(editor, ask())).status).toBe(200);
	});

	it('refuses everyone once the deployment’s month is spent, on any project: 429 assistant_total_budget_spent, parallel turns included', async () => {
		vi.stubEnv('ASSISTANT_PROVIDER', 'mock');
		// A cap well over what every project has spent so far this month (room for a turn's floor), then a row that passes it.
		const cap = (await monthTotal()) + 100_000;
		vi.stubEnv('ASSISTANT_TOKENS_PER_MONTH_TOTAL', String(cap));
		// Positive control: below the cap the turn goes through.
		expect((await post(editor, ask())).status).toBe(200);
		await asOwner(
			`INSERT INTO assistant_usage (project_id, user_id, month, input_tokens, output_tokens) VALUES ($1, $2, date_trunc('month', now() AT TIME ZONE 'UTC')::date, 100000, 0)`,
			[otherId, owner.id]
		);
		const all = await Promise.all(
			(
				[
					[viewer, projectId],
					[viewer, otherId],
					[editor, projectId],
					[editor, projectId],
					[owner, projectId],
					[owner, otherId]
				] as const
			).map(async ([u, pid]) => {
				const r = await post(u, ask(), pid);
				return { status: r.status, body: await r.json() };
			})
		);
		expect(all.map((r) => r.status)).toEqual(Array(6).fill(429));
		for (const r of all) expect(r.body).toMatchObject({ code: 'assistant_total_budget_spent', params: { scope: 'total' } });
		expect(await rateOf(viewer)).toBe(0);
		expect((await viewer.call('GET', at('/assistant'))).body.budget).toMatchObject({ tokensPerMonth: cap, scope: 'total' });
	});

	it('counts parallel turns across people and projects without a deadlock: every one counted once', async () => {
		vi.stubEnv('ASSISTANT_PROVIDER', 'mock');
		const all = await Promise.all(Array.from({ length: 9 }, (_, i) => post([viewer, editor, owner][i % 3]!, ask(), i % 3 === 0 && i % 2 ? otherId : projectId)));
		await Promise.all(all.map((r) => r.text()));
		expect(all.map((r) => r.status)).toEqual(Array(9).fill(200));
		const messages = (await usageRows()).concat(await usageRows(otherId)).reduce((n, r) => n + r.messages, 0);
		expect(messages).toBe(9);
	});

	it('counts parallel charges once each, output weighted ×5', async () => {
		const n = 12;
		const totals = await Promise.all(Array.from({ length: n }, () => chargeTurn(viewer.id, projectId, null, 10, 5)));
		expect(totals.every((t) => t !== null)).toBe(true);
		const projectTotals = totals.map((t) => t!.project);
		expect(Math.max(...projectTotals)).toBe(n * 35);
		expect(new Set(projectTotals).size).toBe(n);
		expect(Math.max(...totals.map((t) => t!.user))).toBe(n * 35);
		expect(await usageRows()).toEqual([{ user_id: viewer.id, input: n * 10, output: n * 5, messages: 0 }]);
	});
});

describe('reservations: nobody passes a cap (264_assistant_reservation)', () => {
	it('reserves the least of the turn’s ceiling and what each cap has left (positive control: far under every cap, the whole ceiling)', async () => {
		expect(await begin(viewer, projectId, { max: 20_000 })).toMatchObject({ outcome: 'ok', budget: 20_000 });
		expect(await begin(viewer, projectId, { user: 50_000, max: 40_000 })).toMatchObject({ outcome: 'ok', budget: 30_000 });
		expect((await reservations()).map((r) => r.reserved)).toEqual([20_000, 30_000]);
	});

	it('counts parallel begins by one person one by one: what they reserve never passes what their month has left', async () => {
		// 50,000 left of the person's month (spent on the other project: the cap spans their projects).
		await asOwner(
			`INSERT INTO assistant_usage (project_id, user_id, month, input_tokens) VALUES ($1, $2, date_trunc('month', now() AT TIME ZONE 'UTC')::date, 950000)`,
			[otherId, viewer.id]
		);
		const all = await Promise.all(Array.from({ length: 8 }, (_, i) => begin(viewer, i % 2 ? otherId : projectId, { user: 1_000_000, max: 20_000, min: 5_000 })));
		const ok = all.filter((r) => r.outcome === 'ok');
		// 20,000 + 20,000 + 10,000, then less than a turn's floor (5,000) is left: refused as the person's month.
		expect(ok.map((r) => r.budget).sort((a, b) => b! - a!)).toEqual([20_000, 20_000, 10_000]);
		expect(all.filter((r) => r.outcome !== 'ok').map((r) => r.outcome)).toEqual(Array(5).fill('user_budget'));
		expect((await reservations()).reduce((n, r) => n + r.reserved, 0)).toBe(50_000);
		// Only the turns that began were counted as messages.
		expect(await rateOf(viewer)).toBe(3);
		// Positive control: someone else still begins.
		expect(await begin(editor, projectId, { user: 1_000_000 })).toMatchObject({ outcome: 'ok' });
	});

	it('the same for the project’s cap across its members, and the deployment’s across every project', async () => {
		const project = await Promise.all([viewer, editor, owner, viewer, editor, owner].map((u) => begin(u, projectId, { project: 45_000, max: 20_000, min: 5_000 })));
		expect(project.filter((r) => r.outcome === 'ok').reduce((n, r) => n + r.budget!, 0)).toBe(45_000);
		expect(project.filter((r) => r.outcome !== 'ok').map((r) => r.outcome)).toEqual(Array(3).fill('budget'));
		await clearCounts();
		// 37,000 left of the deployment's month, whatever other files have spent.
		const total = (await monthTotal()) + 37_000;
		const all = await Promise.all(
			(
				[
					[viewer, projectId],
					[viewer, otherId],
					[editor, projectId],
					[owner, otherId],
					[owner, projectId],
					[editor, projectId]
				] as const
			).map(([u, pid]) => begin(u, pid, { total, max: 20_000, min: 5_000 }))
		);
		expect(all.filter((r) => r.outcome === 'ok').reduce((n, r) => n + r.budget!, 0)).toBe(37_000);
		expect(all.filter((r) => r.outcome !== 'ok').map((r) => r.outcome)).toEqual(Array(4).fill('total_budget'));
		expect(await monthTotal()).toBe(total);
	});

	it('settles a reservation at charge: the real tokens counted, the rest freed for the next turn', async () => {
		const turn = await begin(viewer, projectId, { user: 30_000, max: 20_000 });
		expect(turn).toMatchObject({ outcome: 'ok', budget: 20_000 });
		// While the turn runs, the status counts its reservation as spent.
		expect((await usedBy(viewer)).user).toBe(20_000);
		// 10,000 left: a second turn gets that, not the ceiling.
		const second = await begin(viewer, projectId, { user: 30_000, max: 20_000 });
		expect(second).toMatchObject({ outcome: 'ok', budget: 10_000 });
		await charge(viewer, projectId, turn.reservationId, 1000, 100);
		// 1,000 + 5 × 100 spent, and the second's 10,000 still reserved.
		expect((await usedBy(viewer)).user).toBe(11_500);
		expect((await reservations()).map((r) => r.id)).toEqual([second.reservationId]);
		await charge(viewer, projectId, second.reservationId, 2000, 0);
		expect(await reservations()).toEqual([]);
		expect(await usageRows()).toEqual([{ user_id: viewer.id, input: 3000, output: 100, messages: 2 }]);
		// What the turns didn't spend is free again: 30,000 − 3,500.
		expect(await begin(viewer, projectId, { user: 30_000, max: 50_000 })).toMatchObject({ outcome: 'ok', budget: 26_500 });
	});

	it('charges an expired, unsettled reservation in full (its Lambda died), at the next begin and at the tick', async () => {
		const dead = await begin(viewer, projectId, { max: 20_000 });
		const expire = (id: string | null) =>
			asOwner(`UPDATE assistant_reservation SET created_at = now() - interval '10 minutes', expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
		// Expired but not yet converted, it still counts, in full.
		await expire(dead.reservationId);
		expect((await usedBy(viewer)).user).toBe(20_000);
		// The next begin (anyone's, on any project) charges it to its person's row, as input tokens.
		const live = await begin(owner, otherId, { max: 5_000 });
		expect(live.outcome).toBe('ok');
		expect(await usageRows()).toEqual([{ user_id: viewer.id, input: 20_000, output: 0, messages: 1 }]);
		expect((await reservations()).map((r) => r.id)).toEqual([live.reservationId]);
		// A charge arriving after that (it can't on Lambda, whose timeout comes first) adds its tokens again: never short.
		await charge(viewer, projectId, dead.reservationId, 700, 0);
		expect((await usageRows())[0]).toMatchObject({ input: 20_700 });
		// The tick converts one too, with no begin.
		const other = await begin(viewer, projectId, { max: 6_000 });
		await expire(other.reservationId);
		const tick = await runTick({ feeds: false, reports: false, alerts: false, maxJobs: 0 });
		expect(tick.assistantPurged).toBeGreaterThanOrEqual(1);
		expect((await usageRows())[0]).toMatchObject({ input: 26_700 });
		// Positive control: the live one, not yet expired, stays.
		expect((await reservations()).map((r) => r.id)).toEqual([live.reservationId]);
	});

	it('lets nobody read the reservations, and nobody settle another’s (positive control: its owner does)', async () => {
		const turn = await begin(viewer, projectId);
		await expect(withUser(viewer.id, (db) => db.query('SELECT * FROM assistant_reservation'))).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(viewer.id, (db) => db.query('DELETE FROM assistant_reservation'))).rejects.toMatchObject({ code: '42501' });
		// Another member of the project, and the owner, can't settle it: it stays, uncharged.
		for (const u of [editor, owner]) await expect(charge(u, projectId, turn.reservationId, 1, 0)).rejects.toMatchObject({ code: '42501' });
		// Nor can its own person charge it to another project.
		await expect(charge(viewer, otherId, turn.reservationId, 1, 0)).rejects.toMatchObject({ code: '42501' });
		expect((await reservations()).map((r) => r.id)).toEqual([turn.reservationId]);
		expect(await usageRows()).toEqual([{ user_id: viewer.id, input: 0, output: 0, messages: 1 }]);
		await charge(viewer, projectId, turn.reservationId, 5, 1);
		expect(await reservations()).toEqual([]);
		expect(await usageRows()).toEqual([{ user_id: viewer.id, input: 5, output: 1, messages: 1 }]);
	});

	it('refuses parameters a turn can’t run with: a floor past the ceiling, no floor, an endless reservation', async () => {
		for (const sql of [
			'SELECT * FROM app_assistant_begin($1, 1000000, 30, 1000000, 100000000, 1000, 2000, 300)',
			'SELECT * FROM app_assistant_begin($1, 1000000, 30, 1000000, 100000000, 1000, 0, 300)',
			'SELECT * FROM app_assistant_begin($1, 1000000, 30, 1000000, 100000000, 1000, 100, 0)',
			'SELECT * FROM app_assistant_begin($1, 1000000, 30, 1000000, 100000000, 1000, 100, 86400)'
		]) {
			await expect(
				withUser(viewer.id, (db) => db.query(sql, [projectId])),
				sql
			).rejects.toMatchObject({ code: '22023' });
		}
		expect(await rateOf(viewer)).toBe(0);
	});

	it('reserves against the UTC month whatever the session’s time zone, and a turn begun last month is charged to last month', async () => {
		const month = await utcMonth();
		for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
			const { rows } = await withUser(viewer.id, async (db) => {
				await db.query(`SELECT set_config('TimeZone', $1, true)`, [zone]);
				return db.query<{ reservation_id: string }>('SELECT reservation_id FROM app_assistant_begin($1, 1000000, 1000, 1000000, 10000000000000, 20000, 5000, 300)', [projectId]);
			});
			expect((await reservations()).find((r) => r.id === rows[0]!.reservation_id)?.month, zone).toBe(month);
		}
		await asOwner('DELETE FROM assistant_reservation WHERE project_id = $1', [projectId]);
		// One begun before the month turned: it counts against last month, not this one ...
		const old = await begin(viewer, projectId, { user: 25_000, max: 20_000 });
		await asOwner(`UPDATE assistant_reservation SET month = ($1::date - interval '1 month')::date WHERE id = $2`, [month, old.reservationId]);
		expect(await begin(viewer, projectId, { user: 25_000, max: 20_000 })).toMatchObject({ outcome: 'ok', budget: 20_000 });
		// ... and its charge goes to last month's row.
		await charge(viewer, projectId, old.reservationId, 900, 0);
		const lastMonth = (await asOwner(`SELECT ($1::date - interval '1 month')::date::text AS m`, [month]))[0]!.m;
		const rows = await asOwner(`SELECT month::text AS month, input_tokens::int AS input FROM assistant_usage WHERE project_id = $1 AND user_id = $2 ORDER BY month`, [projectId, viewer.id]);
		expect(rows).toEqual([
			{ month: lastMonth, input: 900 },
			{ month, input: 0 }
		]);
	});
});

describe('the route reserves the turn’s budget', () => {
	/** A model that spends as much as the contract lets it: input as high as the estimate, its whole output cap, and a tool call each hop. */
	const greedy: AssistantProvider = {
		name: 'mock',
		async *complete(req): AsyncIterable<ProviderEvent> {
			yield { type: 'tool_call', call: { id: `c${req.messages.length}`, name: 'probe', arguments: {} } };
			yield { type: 'usage', inputTokens: firstHopInput(req.system, req.tools, req.messages), outputTokens: req.maxOutputTokens };
		}
	};
	const probe = { spec: { name: 'probe', description: 'probe', parameters: { type: 'object', properties: {} } }, label: 'Probing', run: async () => ({ ok: true as const, data: 'ok' }) };
	const floorOf = (content = 'Hello') => turnFloor(assistantConfig(), systemPrompt(), [probe], [{ role: 'user', content }]);

	it('stops a turn at what the person’s month had left, not the turn’s ceiling: spent up to the cap, never past it', async () => {
		vi.stubEnv('ASSISTANT_PROVIDER', 'mock');
		setAssistantTools([probe]);
		setProviderFactory(() => greedy);
		const cap = floorOf() + 3000;
		vi.stubEnv('ASSISTANT_TOKENS_PER_USER_MONTH', String(cap));
		const evs = await events(await post(viewer, ask()));
		expect(evs.find((e) => e.type === 'error')).toMatchObject({ code: 'assistant_turn_limit' });
		const [row] = await usageRows();
		expect(row!.input + 5 * row!.output).toBeLessThanOrEqual(cap);
		expect(await reservations()).toEqual([]);
		// Less than a turn's floor is left now: refused, though the month isn't quite spent.
		const res = await post(viewer, ask());
		expect(res.status).toBe(429);
		expect(await res.json()).toMatchObject({ code: 'assistant_user_budget_spent' });
	});

	it('refuses a turn when the month has less than its floor left (positive control: exactly the floor runs)', async () => {
		vi.stubEnv('ASSISTANT_PROVIDER', 'mock');
		setAssistantTools([probe]);
		setProviderFactory(() => greedy);
		vi.stubEnv('ASSISTANT_TOKENS_PER_USER_MONTH', String(floorOf() - 1));
		const res = await post(viewer, ask());
		expect(res.status).toBe(429);
		expect(await res.json()).toMatchObject({ code: 'assistant_user_budget_spent' });
		expect(await rateOf(viewer)).toBe(0);
		vi.stubEnv('ASSISTANT_TOKENS_PER_USER_MONTH', String(floorOf()));
		const ok = await post(viewer, ask());
		expect(ok.status).toBe(200);
		await ok.text();
	});

	it('refuses with 413 a conversation whose first call alone needs more than ASSISTANT_MAX_TURN_TOKENS, counting nothing', async () => {
		vi.stubEnv('ASSISTANT_PROVIDER', 'mock');
		setAssistantTools([probe]);
		vi.stubEnv('ASSISTANT_MAX_TURN_TOKENS', String(floorOf('x'.repeat(20)) - 1));
		const res = await post(viewer, ask('x'.repeat(20)));
		expect(res.status).toBe(413);
		expect(await res.json()).toMatchObject({ code: 'assistant_input_too_large' });
		expect(await rateOf(viewer)).toBe(0);
		expect(await reservations()).toEqual([]);
		// Positive control: a shorter one fits.
		const ok = await post(viewer, ask('x'));
		expect(ok.status).toBe(200);
		await ok.text();
	});
});

describe('the usage tables under RLS', () => {
	it('lets a person read their own usage rows only (positive control: they do), and write neither table directly', async () => {
		await chargeTurn(viewer.id, projectId, null, 3, 4);
		await chargeTurn(editor.id, projectId, null, 5, 6);
		const own = await withUser(viewer.id, (db) => db.query('SELECT user_id, input_tokens::int AS i FROM assistant_usage WHERE project_id = $1', [projectId]));
		expect(own.rows).toEqual([{ user_id: viewer.id, i: 3 }]);
		// The project's total is the definer function's, for any member.
		// The month's weighted totals are the definer function's, for any member: the project's (3 + 5 × 4 + 5 + 5 × 6), theirs.
		const used = await withUser(viewer.id, (db) => db.query<{ p: string; u: string; t: string }>('SELECT project_used AS p, user_used AS u, total_used AS t FROM app_assistant_used($1)', [projectId]));
		expect([Number(used.rows[0]!.p), Number(used.rows[0]!.u)]).toEqual([58, 23]);
		expect(Number(used.rows[0]!.t)).toBeGreaterThanOrEqual(58);
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
			await expect(withUser(u.id, (db) => db.query('SELECT app_assistant_charge($1, NULL, 1, 1)', [projectId]))).rejects.toMatchObject({ code: '42501' });
			await expect(withUser(u.id, (db) => db.query('SELECT * FROM app_assistant_begin($1, 100, 10, 100, 100, 100, 10, 60)', [projectId]))).rejects.toMatchObject({ code: '42501' });
			expect((await withUser(u.id, (db) => db.query('SELECT * FROM app_assistant_used($1)', [projectId]))).rows[0]).toEqual({ project_used: null, user_used: null, total_used: null });
		}
		expect(await chargeTurn(outsider.id, projectId, null, 1, 1)).toBeNull();
		expect(await usageRows()).toEqual([]);
	});
});

describe('Download my data', () => {
	it('carries the person’s usage rows, counts only', async () => {
		await chargeTurn(viewer.id, projectId, null, 7, 8);
		await asOwner('UPDATE app_user SET data_exported_at = NULL WHERE id = $1', [viewer.id]);
		const r = await viewer.call('GET', '/auth/me/export');
		expect(r.status).toBe(200);
		expect(r.body.assistantUsage).toEqual([
			{ projectId, month: new Date().toISOString().slice(0, 7), inputTokens: 7, outputTokens: 8, messages: 0, updatedAt: expect.any(String) }
		]);
	});
});

describe('retention', () => {
	it('the tick purges rate rows past their hour and usage rows of months before the last 13; the rest stay', async () => {
		const month = (back: number) => `(date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => ${back}))::date`;
		for (const back of [0, ASSISTANT_USAGE_RETENTION_MONTHS - 1, ASSISTANT_USAGE_RETENTION_MONTHS, ASSISTANT_USAGE_RETENTION_MONTHS + 5]) {
			await asOwner(`INSERT INTO assistant_usage (project_id, user_id, month, input_tokens) VALUES ($1, $2, ${month(back)}, ${back + 1})`, [projectId, viewer.id]);
		}
		await asOwner(`INSERT INTO assistant_rate (user_id, window_start, messages) VALUES ($1, now() - interval '61 minutes', 3), ($2, now() - interval '10 minutes', 1)`, [viewer.id, editor.id]);
		const tick = await runTick({ feeds: false, reports: false, alerts: false, maxJobs: 0 });
		expect(tick.assistantPurged).toBeGreaterThanOrEqual(3);
		// This month and the 12 before it stay; the 13th back and older go.
		expect((await usageRows()).map((r) => r.input).sort((a, b) => a - b)).toEqual([1, ASSISTANT_USAGE_RETENTION_MONTHS]);
		expect(await rateOf(viewer)).toBe(0);
		// Positive control: a window still open stays.
		expect(await rateOf(editor)).toBe(1);
	});

	it('is the worker’s alone, and keeps at least two months', async () => {
		await expect(withUser(viewer.id, (db) => db.query('SELECT app_purge_assistant(13)'))).rejects.toMatchObject({ code: '42501' });
		await expect(asOwner('SELECT app_purge_assistant(1)')).rejects.toMatchObject({ code: '22023' });
	});
});

describe('a tool’s transaction', () => {
	it('cuts a statement at TOOL_STATEMENT_TIMEOUT_MS, and only in the tool’s own transaction', async () => {
		expect(await runToolBounded(viewer.id, async (db) => (await db.query<{ t: string }>("SELECT current_setting('statement_timeout') AS t")).rows[0]!.t)).toBe(`${TOOL_STATEMENT_TIMEOUT_MS / 1000}s`);
		// SET LOCAL: the next transaction on the connection is back to the default.
		expect(await withUser(viewer.id, async (db) => (await db.query<{ t: string }>("SELECT current_setting('statement_timeout') AS t")).rows[0]!.t)).not.toBe(`${TOOL_STATEMENT_TIMEOUT_MS / 1000}s`);
	});

	it('rejects at once when the turn’s signal fires, and the hung read still ends', async () => {
		const ctrl = new AbortController();
		let ended = false;
		const hung = runToolBounded(viewer.id, (db) => db.query('SELECT pg_sleep(1)').finally(() => (ended = true)), ctrl.signal);
		ctrl.abort(new DOMException('deadline', 'AbortError'));
		await expect(hung).rejects.toMatchObject({ name: 'AbortError' });
		expect(ended).toBe(false);
		// The connection comes back once the read ends.
		await vi.waitFor(() => expect(ended).toBe(true), { timeout: 5000 });
	});
});
