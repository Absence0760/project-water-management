// Share links' security boundary, beyond share.db.test.ts (which covers
// owner-only CRUD, the dead-link 404s, the view's key allowlist and the k
// rule): a link reads the *current* publication only, a series read is
// swept over every key the published run actually stores (catchment and
// node level alike), and a revoked link can't be brought back, even by an
// owner's own transaction (065_share_links_revoke_final.sql). Every
// "cannot" has its positive control. docs/security.md § Share links.
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { anon, asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { SHARE_SERIES_KEYS } from './links.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let coOwner: User;
let stranger: User;
let projectId: string;

const outlet = node('Sentinel Weir', null);
const farms = ['Kestrel', 'Heron', 'Ibis', 'Plover', 'Egret', 'Crane'].map((n) => node(`Farm ${n}`, outlet.id));
const crop = { id: crypto.randomUUID(), name: 'Maize', cropFactor: monthly(0.9) };
const NOTE = 'Staff only: the second gauging looks off';
const DAYS = 500;

const rain = (wet: number) => Array.from({ length: DAYS }, (_, i) => (i % 9 === 0 ? wet : i % 4 === 0 ? 3 : 0));
const putRain = async (wet: number) =>
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2022-01-01', values: rain(wet) })).status).toBe(200);

async function publish(notice: string) {
	const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: notice });
	expect(run.status).toBe(201);
	const res = await owner.call('POST', `/projects/${projectId}/publication`, {
		runId: run.body.run.id,
		note: NOTE,
		restriction: { level: 'advisory', pct: 10, notice: { en: notice } },
		nextExpectedOn: '2023-06-01'
	});
	expect(res.status).toBe(201);
	return run.body.run.id as string;
}

const create = (label = 'Forum') => owner.call('POST', `/projects/${projectId}/share-links`, { label, expiresInDays: 30 });
const tokenOf = (url: string) => new URL(url).hash.replace(/^#t=/, '');
const hashOf = (token: string) => createHash('sha256').update(token, 'utf8').digest();
const view = (token: string) => anon('POST', '/share/view', { token });
const series = (token: string, key: string) => anon('POST', '/share/series', { token, key });
/** The definer functions straight, as a signed-in stranger: what the database itself hands out. */
const fnRows = (sql: string, params: unknown[]) => withUser(stranger.id, async (db) => (await db.query(sql, params)).rows);

let firstRun: string;
let secondRun: string;
let token: string;

beforeAll(async () => {
	[owner, coOwner, stranger] = (await Promise.all(['SSowner', 'SScoowner', 'SSstranger'].map((n) => signUp(n)))) as [User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Sentinel catchment' })).body.project.id;
	expect(
		(
			await owner.call('PUT', `/projects/${projectId}/model`, {
				nodes: [outlet, ...farms],
				crops: [crop],
				cropAreas: farms.map((f, i) => ({ nodeId: f.id, cropId: crop.id, areaM2: 100_000 + 40_000 * i })),
				transfers: []
			})
		).status
	).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(200), ewrPragmaticM3PerDay: monthly(4000) } })).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: coOwner.email, role: 'owner' })).status).toBe(201);
	await putRain(25);
	firstRun = await publish('First notice');
	// A link made while the first publication was current.
	token = tokenOf((await create('Made under the first')).body.link.url);
	// A wetter second run, so its flows differ from the first's.
	await putRain(60);
	secondRun = await publish('Second notice');
}, 90_000);

const catchmentValues = async (runId: string, key: string) =>
	(await asOwner('SELECT "values" FROM run_series WHERE run_id = $1 AND node_id IS NULL AND key = $2', [runId, key]))[0]?.values as number[] | undefined;

describe('a link reads the current publication only', () => {
	it('shows the newest publication, not the one current when the link was made', async () => {
		const res = await view(token);
		expect(res.status).toBe(200);
		expect(res.body.publication.restriction.notice).toEqual({ en: 'Second notice' });
		const [current] = await asOwner('SELECT published_at FROM run_publication WHERE project_id = $1 AND superseded_at IS NULL', [projectId]);
		expect(res.body.publication.publishedAt).toBe((current.published_at as Date).toISOString());
		// The function answers one row, the current one: never the superseded publication beside it.
		const rows = await fnRows('SELECT restriction_level, notice FROM app_share_view($1)', [hashOf(token)]);
		expect(rows).toEqual([{ restriction_level: 'advisory', notice: { en: 'Second notice' } }]);
		// Positive control: the first publication is still there, superseded, for the function to pass over.
		const all = await asOwner('SELECT notice, superseded_at IS NOT NULL AS superseded FROM run_publication WHERE project_id = $1 ORDER BY published_at', [projectId]);
		expect(all).toEqual([
			{ notice: { en: 'First notice' }, superseded: true },
			{ notice: { en: 'Second notice' }, superseded: false }
		]);
	});

	it('reads the series of the current publication’s run, never the superseded run’s', async () => {
		const first = (await catchmentValues(firstRun, 'natural_flow'))!;
		const second = (await catchmentValues(secondRun, 'natural_flow'))!;
		// The fixture's two runs differ, so the test can tell them apart.
		expect(second.at(-1)).not.toBeCloseTo(first.at(-1)!, 3);
		const rows = await fnRows('SELECT recent FROM app_share_series($1, $2)', [hashOf(token), 'natural_flow']);
		expect(rows).toHaveLength(1);
		expect((rows[0]!.recent as number[]).at(-1)).toBeCloseTo(second.at(-1)!, 6);
		const res = await series(token, 'natural_flow');
		expect(res.status).toBe(200);
		expect(res.body.recent.values.at(-1)).toBeCloseTo(second.at(-1)!, 6);
	});
});

describe('the series allowlist, swept over the run’s own series', () => {
	it('keeps the TypeScript allowlist and app_share_series’ SQL allowlist the same list', async () => {
		const [{ def }] = await asOwner("SELECT pg_get_functiondef('app_share_series(bytea, text)'::regprocedure) AS def");
		const list = /p_key IN \(([^)]*)\)/.exec(def as string)?.[1];
		expect(list, 'app_share_series has no p_key IN (…) allowlist').toBeDefined();
		const sqlKeys = [...list!.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
		expect(sqlKeys).toEqual([...SHARE_SERIES_KEYS].sort());
	});

	it('answers exactly the allowlisted catchment series, one row each, and nothing else the run stores', async () => {
		const stored = await asOwner('SELECT key, bool_or(node_id IS NULL) AS catchment, bool_or(node_id IS NOT NULL) AS node FROM run_series WHERE run_id = $1 GROUP BY key ORDER BY key', [
			secondRun
		]);
		// The sweep has to meet a node-level key that shares an allowlisted name, or it proves nothing about node_id.
		expect(stored.some((s) => s.node && (SHARE_SERIES_KEYS as readonly string[]).includes(s.key))).toBe(true);
		const answered: string[] = [];
		for (const { key, catchment } of stored as { key: string; catchment: boolean }[]) {
			const allowed = catchment && (SHARE_SERIES_KEYS as readonly string[]).includes(key);
			const rows = await fnRows('SELECT recent FROM app_share_series($1, $2)', [hashOf(token), key]);
			const res = await series(token, key);
			if (!allowed) {
				expect(rows, key).toEqual([]);
				expect(res.status, key).toBe(404);
				continue;
			}
			answered.push(key);
			// One row, the catchment's: a node's series of the same key never comes along or instead.
			expect(rows, key).toHaveLength(1);
			const values = (await catchmentValues(secondRun, key))!;
			expect((rows[0]!.recent as number[]).at(-1), key).toBeCloseTo(values.at(-1)!, 6);
			expect(res.status, key).toBe(200);
			// No farm or outlet name or id, and no modeller's note, in what a series read returns.
			const text = JSON.stringify(res.body);
			for (const n of [outlet, ...farms]) {
				expect(text, key).not.toContain(n.name);
				expect(text, key).not.toContain(n.id);
			}
			expect(text, key).not.toContain(NOTE);
		}
		// Positive control: the sweep did open the allowlisted series this run has.
		expect(answered.sort()).toEqual(['ewr', 'ewr_shortfall', 'natural_flow', 'simulated_outflow']);
	});
});

describe('revocation is final', () => {
	it('refuses to un-revoke a link or rewrite its revocation, even as an owner in SQL', async () => {
		const { link } = (await create('To withdraw')).body;
		const t = tokenOf(link.url);
		// Positive control: the owner's own transaction can revoke (the API's path).
		await withUser(owner.id, (db) => db.query('UPDATE share_link SET revoked_at = now(), revoked_by = app_current_user_id() WHERE id = $1', [link.id]));
		expect((await view(t)).status).toBe(404);
		for (const sql of [
			'UPDATE share_link SET revoked_at = NULL, revoked_by = NULL WHERE id = $1',
			"UPDATE share_link SET revoked_at = revoked_at + interval '1 year' WHERE id = $1",
			'UPDATE share_link SET revoked_by = $2 WHERE id = $1'
		]) {
			const params = sql.includes('$2') ? [link.id, coOwner.id] : [link.id];
			await expect(withUser(owner.id, (db) => db.query(sql, params)), sql).rejects.toMatchObject({ code: '23514' });
		}
		expect((await view(t)).status).toBe(404);
		const [row] = await asOwner('SELECT revoked_by FROM share_link WHERE id = $1', [link.id]);
		expect(row.revoked_by).toBe(owner.id);
	});

	it('still clears who revoked it when that account is deleted, and the link stays revoked', async () => {
		const { link } = (await create('Withdrawn by the co-owner')).body;
		expect((await coOwner.call('DELETE', `/projects/${projectId}/share-links/${link.id}`)).status).toBe(204);
		await asOwner('DELETE FROM app_user WHERE id = $1', [coOwner.id]);
		const [row] = await asOwner('SELECT revoked_at, revoked_by FROM share_link WHERE id = $1', [link.id]);
		expect(row.revoked_by).toBeNull();
		expect(row.revoked_at).not.toBeNull();
		expect((await view(tokenOf(link.url))).status).toBe(404);
	});
});
