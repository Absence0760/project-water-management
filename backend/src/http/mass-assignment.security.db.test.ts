// Mass assignment (docs/security.md § Input validation): a request body can't
// set what the server owns. Swept from the live route list, like the role
// ladder (projects/role-ladder.db.test.ts), whose SAMPLE bodies it reuses.
//
// Every POST/PUT/PATCH route is called, by the project's owner (or whoever the
// route is for), with a body its validation accepts plus hostile extra
// fields: the row's own id, another project's id, another member's user id as
// its author/creator/owner, `role: 'owner'`, server timestamps (created_at,
// revoked_at, …) and marker strings for status/hash columns and unknown keys.
// Twice: once at the top level, once in every nested object too. Then, as the
// schema owner, every row any table gained or changed during the request is
// searched for a hostile value (rows are picked by xmin, so the sweep needs no
// table list and a new table is covered the day it lands).
//
// Each route must either refuse the hostile body with 400 (a .strict()
// schema) and accept the same body without the extras, or accept it and store
// none of them (zod's default strips unknown keys). Positive controls: a
// route that accepted the hostile body wrote rows (or is listed as writing
// none, with the reason), the sweep's detector finds a hostile value written
// on purpose, and the legitimate fields of a few routes are read back.
import { FARMER_NOTICE_VERSION, LEGAL_VERSION } from '@water-management/engine/legal';
import { runEnsemble, type ModelInput, type ResolvedEnsembleOptions } from '@water-management/engine';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app, asOwner, lastMailTo, signUp, tokenIn } from '../__tests__/helpers.js';
import { buildLadder, clearLadderJobs, SAMPLE, type LadderCtx, type User } from '../__tests__/routeSamples.js';
import { newSubscriptionSecret, unsubscribeToken } from '../alerts/tokens.js';
import { withUser } from '../db/tx.js';
import { issueRenderToken } from '../reports/tokens.js';

const ORIGIN = 'http://localhost:7777';
const ZERO = '00000000-0000-4000-8000-000000000000';
const FRESH = crypto.randomUUID();
const TS = '1999-09-09T09:09:09.000Z';
const MARK = 'zzhostile';

type Req = { as?: User | null; body?: unknown; params?: Record<string, string>; query?: Record<string, string>; headers?: Record<string, string> };

const ctx = {} as LadderCtx & {
	victim: User;
	consultant: User;
	otherProjectId: string;
	teamId: string;
	otherTeamId: string;
	apiKey: string;
	shareToken: string;
	exportDoc: unknown;
};

/** The hostile extras, each only where the legitimate body doesn't already have the key. */
function hostile(): Record<string, unknown> {
	const V = ctx.victim.id;
	return {
		id: FRESH,
		uuid: FRESH,
		projectId: ctx.otherProjectId,
		project_id: ctx.otherProjectId,
		teamId: ctx.otherTeamId,
		team_id: ctx.otherTeamId,
		...Object.fromEntries(
			['userId', 'user_id', 'createdBy', 'created_by', 'authorId', 'author_id', 'ownerId', 'owner_id', 'requestedBy', 'requested_by', 'actingUserId', 'updatedBy', 'decidedBy', 'applicantId', 'invitedBy'].map((k) => [k, V])
		),
		role: 'owner',
		...Object.fromEntries(
			[
				'createdAt', 'created_at', 'updatedAt', 'updated_at', 'revokedAt', 'revoked_at', 'deletedAt', 'expiresAt', 'expires_at', 'lastUsedAt',
				'submittedAt', 'decidedAt', 'publishedAt', 'acceptedAt', 'emailVerifiedAt', 'email_verified_at', 'cancelRequestedAt'
			].map((k) => [k, TS])
		),
		...Object.fromEntries(['status', 'state', 'tokenHash', 'token_hash', 'keyHash', 'passwordHash', 'secretHash', 'engineVersion', 'hostileMarker'].map((k) => [k, MARK]))
	};
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const addMissing = (o: Record<string, unknown>) => ({ ...hostile(), ...o });
/** The extras on the top-level object only. */
const shallow = (b: unknown) => (isObj(b) ? addMissing(b) : b);
/** The extras on every object in the body, nested ones included. */
function deep(b: unknown, depth = 0): unknown {
	if (Array.isArray(b)) return b.map((x) => deep(x, depth + 1));
	if (!isObj(b) || depth > 5) return b;
	return addMissing(Object.fromEntries(Object.entries(b).map(([k, v]) => [k, deep(v, depth + 1)])));
}

const freshUser = (n: string, verified = true) => signUp(n, { verified });
const at = () => `/projects/${ctx.projectId}`;
const ok = async (r: Promise<{ status: number; body: any }>) => { // eslint-disable-line @typescript-eslint/no-explicit-any
	const res = await r;
	expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
	return res.body;
};
const observed = () => ({ kind: 'flow_observed_m3s', unit: 'm3/s', startDate: '2021-10-01', values: Array.from({ length: 400 }, (_, i) => 0.2 + 0.1 * Math.sin(i / 9)) });
/** The model with Farm A's dam changed, so restoring an earlier version changes something. */
async function changeModel() {
	const m = structuredClone(ctx.model) as { nodes: { damCapacityM3: number }[] };
	m.nodes[1]!.damCapacityM3 = 100_000 + Math.floor(Math.random() * 100_000);
	await ok(ctx.owner.call('PUT', `${at()}/model`, m));
}
const currentFeed = async () => (await ok(ctx.owner.call('GET', `${at()}/feeds`))).feeds[0].id as string;
/** A new team scenario of the owner's, moved through `steps` (submit, withdraw, …). */
async function scenario(steps: string[]) {
	const sid = (await ok(ctx.owner.call('POST', `${at()}/scenarios`, { name: `Mass ${crypto.randomUUID()}`, baseRunId: ctx.runId, ops: [] }))).scenario.id as string;
	for (const step of steps) await ok(ctx.owner.call('POST', `${at()}/scenarios/${sid}/${step}`, {}));
	return { params: { sid } };
}

/**
 * A draft evidence pack on the ladder's run, planted as the schema owner: the
 * ladder has no nominated run with a cited ensemble, so POST …/packs can't
 * draft one (NOT_REACHED). Its manifest is a stand-in; the pack routes that
 * take a body (sign, withdraw) read only its row.
 */
async function plantedPack() {
	const id = crypto.randomUUID();
	await asOwner(
		`INSERT INTO evidence_pack (id, project_id, baseline_run_id, version, manifest, manifest_sha256, report_version, engine_version, created_by)
		 VALUES ($1::uuid, $2::uuid, $3, 1, jsonb_build_object('pack', jsonb_build_object('id', $1::text, 'version', 1), 'project', jsonb_build_object('id', $2::text), 'engine', jsonb_build_object('version', '0.0.0'), 'report', jsonb_build_object('version', 'evidence-1')), md5(random()::text) || md5(random()::text), 'evidence-1', '0.0.0', $4)`,
		[id, ctx.projectId, ctx.runId, ctx.owner.id]
	);
	return id;
}

/**
 * A pack that was issued and then withdrawn, planted past evidence_pack_guard
 * (replica role, as jobs/trust.security.db.test.ts arranges its issued pack):
 * issuing needs an issuable report, which the ladder has none of. Withdrawn so
 * a new one each call doesn't meet evidence_pack_one_issued; POST …/pdf asks
 * only that it was issued (issued_at) and has no PDF yet.
 */
async function plantedIssuedPack() {
	const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await client.connect();
	try {
		await client.query('BEGIN');
		await client.query('SET LOCAL session_replication_role = replica');
		const { rows } = await client.query<{ id: string }>(
			`INSERT INTO evidence_pack (id, project_id, baseline_run_id, version, status, status_reason, manifest, manifest_sha256, report_version, engine_version, created_by, issued_at, issued_by)
			 VALUES (gen_random_uuid(), $1, $2, 1, 'withdrawn', 'mass sweep', '{}', md5(random()::text) || md5(random()::text), 'evidence-1', '0.0.0', $3, now(), $3) RETURNING id::text`,
			[ctx.projectId, ctx.runId, ctx.owner.id]
		);
		await client.query('COMMIT');
		return rows[0]!.id;
	} finally {
		await client.end();
	}
}

/**
 * Requests for the routes outside /projects/:id, and parameter overrides for
 * ones inside it; every other project route takes its role-ladder SAMPLE, as
 * the owner. Each is called afresh per request, so a token is new each time.
 */
const RECIPE: Record<string, () => Promise<Req> | Req> = {
	'POST /auth/register': () => ({ as: null, body: { email: `mass-${crypto.randomUUID()}@example.com`, password: 'correct horse', displayName: 'Mass Register', acceptTerms: LEGAL_VERSION } }),
	'POST /auth/resend-confirmation': () => ({ as: null, body: { email: `mass-${crypto.randomUUID()}@example.com` } }),
	'POST /auth/login': () => ({ as: null, body: { email: ctx.owner.email, password: 'correct horse' } }),
	'POST /auth/logout': async () => ({ as: await freshUser('Mlogout') }),
	'POST /auth/logout-everywhere': async () => ({ as: await freshUser('Meverywhere') }),
	'PATCH /auth/me': () => ({ body: { displayName: 'Mass Owner' } }),
	'POST /auth/me/farm-notice': async () => ({ as: await freshUser('Mnotice'), body: { version: FARMER_NOTICE_VERSION } }),
	'POST /auth/me/accept-terms': async () => ({ as: await freshUser('Mterms'), body: { version: LEGAL_VERSION } }),
	'POST /auth/change-password': async () => ({ as: await freshUser('Mpassword'), body: { currentPassword: 'correct horse', newPassword: 'correct horse battery' } }),
	'POST /auth/forgot-password': () => ({ as: null, body: { email: ctx.owner.email } }),
	'POST /auth/reset-password': async () => {
		const u = await freshUser('Mreset');
		await app.request('/auth/forgot-password', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ email: u.email }) });
		return { as: null, body: { token: tokenIn(lastMailTo(u.email)), password: 'correct horse battery' } };
	},
	'POST /auth/verify-email': async () => {
		const u = await freshUser('Mverify', false);
		return { as: null, body: { token: tokenIn(lastMailTo(u.email)) } };
	},
	'POST /auth/resend-verification': async () => {
		const u = await freshUser('Mresend', false);
		// Past the resend cooldown of the sign-up email.
		await db.query(`UPDATE email_token SET created_at = created_at - interval '1 hour' WHERE user_id = $1`, [u.id]);
		return { as: u };
	},
	'POST /auth/invite-info': async () => {
		const email = `mass-${crypto.randomUUID()}@example.com`;
		await ctx.owner.call('POST', `/projects/${ctx.projectId}/members`, { email, role: 'viewer' });
		return { as: null, body: { token: tokenIn(lastMailTo(email)) } };
	},
	'POST /auth/render-session': async () => ({ as: null, body: { token: await withUser(ctx.owner.id, (d) => issueRenderToken(d, ctx.projectId, ctx.runId)) } }),
	'POST /alerts/unsubscribe': async () => {
		// A subscription's token, as its alert email would carry it (alerts/tokens.ts).
		const { nonce, hash } = newSubscriptionSecret();
		await db.query(
			`UPDATE alert_subscription SET unsubscribe_nonce = $1, unsubscribe_hash = $2, mode = 'immediate'
			 WHERE id = (SELECT id FROM alert_subscription WHERE user_id = $3 AND project_id = $4 LIMIT 1)`,
			[nonce, hash, ctx.owner.id, ctx.projectId]
		);
		return { as: null, body: { token: unsubscribeToken(nonce) } };
	},
	'POST /share/view': () => ({ as: null, body: { token: ctx.shareToken } }),
	'POST /share/series': () => ({ as: null, body: { token: ctx.shareToken, key: 'simulated_outflow' } }),
	// A baseline link's token: the scenario read answers it 404 (a link opens only its own target).
	'POST /share/scenario': () => ({ as: null, body: { token: ctx.shareToken } }),
	// The same baseline token: the pack read answers it 404 too (128_pack_share_notes).
	'POST /share/pack': () => ({ as: null, body: { token: ctx.shareToken } }),
	'POST /ingest/v1/series/merge': () => ({
		as: null,
		headers: { authorization: `Bearer ${ctx.apiKey}` },
		body: { kind: 'flow_observed_m3s', unit: 'm3/s', startDate: '2022-02-01', values: [3, 4] }
	}),
	// teamId is a real field of these two (the caller must be a member of that team); null keeps the project out of one.
	'POST /projects': () => ({ body: { name: 'Mass new', teamId: null } }),
	'PATCH /projects/:id': () => ({ body: { name: 'Mass renamed', teamId: null, settings: { lakeEvapFactor: 0.8 } } }),
	'POST /projects/import': () => ({ body: ctx.exportDoc }),
	'POST /me/alerts/resume': () => ({}),
	// A verified account accepting its own invite (issue #136): it joins as the invite's role, whatever the body says.
	'POST /me/invites/:inviteId/accept': async () => {
		const invitee = await signUp('Minvitee', { acceptInvites: false });
		await ok(ctx.owner.call('POST', `${at()}/members`, { email: invitee.email, role: 'viewer' }));
		const mine = await ok(invitee.call('GET', '/me/invites'));
		return { as: invitee, params: { inviteId: mine.invites[0].id as string } };
	},
	'POST /teams': () => ({ body: { name: `Mass team ${crypto.randomUUID().slice(0, 8)}` } }),
	'PATCH /teams/:id': () => ({ params: { id: ctx.teamId }, body: { name: 'Mass team renamed' } }),
	'POST /teams/:id/members': async () => ({ params: { id: ctx.teamId }, body: { email: (await freshUser('Mteam')).email, role: 'viewer' } }),
	'PATCH /teams/:id/members/:userId': () => ({ params: { id: ctx.teamId, userId: ctx.viewer.id }, body: { role: 'member' } }),
	// A run with the observed record in its inputs (the SAMPLE of PUT …/series replaces it with two days).
	// One queued run of the rules per user (calibration/schema.ts AUTO_CALIBRATION_JOBS_PER_USER): clear the last one's job first.
	'POST /projects/:id/auto-calibrations': async () => {
		await asOwner(`DELETE FROM job WHERE kind = 'auto_calibration' AND project_id = $1`, [ctx.projectId]);
		return {};
	},
	'POST /projects/:id/runs/:runId/uncertainty': async () => {
		await ok(ctx.owner.call('PUT', `${at()}/series`, observed()));
		const run = await ok(ctx.owner.call('POST', `${at()}/runs`, { label: 'Mass ensemble' }));
		return { ...SAMPLE['POST /projects/:id/runs/:runId/uncertainty']!(ctx), params: { runId: run.run.id } };
	},
	'POST /projects/:id/runs/:runId/uncertainty/:uid/result': async () => {
		await ok(ctx.owner.call('PUT', `${at()}/series`, observed()));
		const run = await ok(ctx.owner.call('POST', `${at()}/runs`, { label: 'Mass ensemble' }));
		const path = `${at()}/runs/${run.run.id}`;
		const e = (await ok(ctx.owner.call('POST', `${path}/uncertainty`, SAMPLE['POST /projects/:id/runs/:runId/uncertainty']!(ctx).body))).ensemble;
		const input = (await ok(ctx.owner.call('GET', `${path}/model-input`))).input as ModelInput;
		const { members, coverage } = runEnsemble(input, e.options as ResolvedEnsembleOptions);
		return { params: { runId: run.run.id, uid: e.id }, body: { members, coverage } };
	},
	'POST /projects/:id/runs/:runId/signoffs': async () => {
		const run = await ok(ctx.owner.call('POST', `${at()}/runs`, { label: 'Mass signed' }));
		const { statement, statementSha256 } = await ok(ctx.owner.call('GET', `${at()}/runs/${run.run.id}/signoffs`));
		return {
			params: { runId: run.run.id },
			body: {
				fullName: 'Mass Signer',
				registrationBody: 'sacnasp',
				registrationCategory: 'pr_sci_nat',
				registrationField: 'water_resources',
				registrationNo: '1',
				scope: 'mass',
				confirmed: statement.confirmations.map((k: { id: string }) => k.id),
				statementSha256
			}
		};
	},
	'POST /projects/:id/packs/:packId/signoffs': async () => {
		const packId = await plantedPack();
		const { statement, statementSha256 } = await ok(ctx.owner.call('GET', `${at()}/packs/${packId}/signoffs`));
		return {
			params: { packId },
			body: {
				fullName: 'Mass Signer',
				registrationBody: 'sacnasp',
				registrationCategory: 'pr_sci_nat',
				registrationField: 'water_resources',
				registrationNo: '1',
				scope: 'mass',
				confirmed: statement.confirmations.map((k: { id: string }) => k.id),
				statementSha256
			}
		};
	},
	'POST /projects/:id/packs/:packId/withdraw': async () => ({ params: { packId: await plantedPack() }, body: { reason: 'mass withdrawal' } }),
	// An empty body only (strict); a pack that was issued, with no PDF yet, so the legit call queues its render (202).
	'POST /projects/:id/packs/:packId/pdf': async () => ({ params: { packId: await plantedIssuedPack() } }),
	'POST /projects/:id/series/:seriesId/revisions/:revId/restore': async () => {
		const rain = Array.from({ length: 400 }, (_, i) => (i % 5 === 0 ? 10 + Math.random() : 0));
		await ok(ctx.owner.call('PUT', `${at()}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: rain }));
		const revs = (await ok(ctx.owner.call('GET', `${at()}/series/${ctx.seriesId}/revisions`))).revisions as { id: string }[];
		return { params: { revId: revs.at(-1)!.id } };
	},
	'POST /projects/:id/history/revisions/:revId/restore': async () => (await changeModel(), {}),
	'POST /projects/:id/runs/:runId/restore-inputs': async () => (await changeModel(), {}),
	'POST /projects/:id/scenarios/:sid/submit': () => scenario([]),
	'POST /projects/:id/scenarios/:sid/withdraw': () => scenario(['submit']),
	'POST /projects/:id/scenarios/:sid/reopen': () => scenario(['submit', 'withdraw']),
	'POST /projects/:id/scenarios/:sid/decide': async () => ({ ...(await scenario(['submit'])), body: { outcome: 'approved' } }),
	// An applicant shares their own application with someone of their party (049).
	'POST /projects/:id/scenarios/:sid/members': async () => {
		const app = await ok(ctx.contributor.call('POST', `${at()}/scenarios`, { name: `Mass application ${crypto.randomUUID()}`, baseRunId: ctx.runId, ops: [] }));
		return { as: ctx.contributor, params: { sid: app.scenario.id }, body: { userId: ctx.consultant.id } };
	},
	// One DWS feed per series: the last request's feed goes first.
	'POST /projects/:id/feeds': async () => {
		for (const f of (await ok(ctx.owner.call('GET', `${at()}/feeds`))).feeds as { id: string }[]) await ok(ctx.owner.call('DELETE', `${at()}/feeds/${f.id}`));
		return { body: { source: 'dws', config: { station: 'X0H001' } } };
	},
	'PATCH /projects/:id/feeds/:feedId': async () => ({ params: { feedId: await currentFeed() }, body: { enabled: false } }),
	'POST /projects/:id/feeds/:feedId/run-now': async () => {
		const feedId = await currentFeed();
		await ok(ctx.owner.call('PATCH', `${at()}/feeds/${feedId}`, { enabled: true }));
		return { params: { feedId } };
	},
	'PATCH /projects/:id/publication/:pubId': async () => ({
		params: { pubId: (await ok(ctx.owner.call('GET', `${at()}/publication`))).current.id },
		body: { restriction: { level: 'advisory', notice: { en: 'Use water sparingly' } } }
	}),
	// The owner can't demote themselves as the last owner; change the viewer instead.
	'PATCH /projects/:id/members/:userId': () => ({ params: { userId: ctx.viewer.id }, body: { role: 'editor' } })
};

/**
 * Routes that write nothing the sweep can see, and why (checked: exactly these
 * answer 2xx and change no row).
 */
const NO_WRITE = new Map<string, string>([
	['POST /auth/login', 'the session is a signed cookie; a correct password leaves the lockout table as it was'],
	['POST /auth/invite-info', 'reads what an invite is for, so the sign-up page can name it'],
	['POST /auth/resend-confirmation', 'an address with no account (the sweep’s): the same 202, and nothing to mail'],
	['POST /me/alerts/resume', 'the owner’s alert emails are not paused, so there is nothing to resume']
]);

/** Routes the owner's sample can't reach past a business rule, and why (their body never gets that far). */
const NOT_REACHED = new Map<string, { why: string; legit: number }>([
	['POST /share/scenario', { why: 'a read (app_share_scenario); the ladder link is a baseline link, which opens no scenario', legit: 404 }],
	['POST /share/pack', { why: 'a read (app_share_pack); the ladder link is a baseline link, which opens no pack', legit: 404 }],
	[
		'POST /projects/:id/packs',
		{
			why: 'a strict body; the ladder has no nominated run with a declared rule and a cited ensemble, so no report there may become a pack (evidence/packs.db.test.ts drafts one)',
			legit: 409
		}
	],
	[
		'POST /projects/:id/packs/:packId/issue',
		{ why: 'takes an empty body only (strict); a pack is issued only from an issuable report, which the ladder has none of (evidence/packs.db.test.ts)', legit: 404 }
	],
	['POST /share/series', { why: 'a read (app_share_series); the ladder catchment has 2 farms, under the 5 holders a link needs to show a series', legit: 404 }],
	[
		'POST /projects/:id/auto-calibrations/:cid/apply',
		{ why: 'takes an empty body only; the ladder’s run of the rules is still running (it has no fitted cases to apply), so a legit call is 409', legit: 409 }
	]
]);

const routes = [...new Set(app.routes.filter((r) => ['POST', 'PUT', 'PATCH'].includes(r.method)).map((r) => `${r.method} ${r.path}`))];

async function recipe(route: string): Promise<Req> {
	if (RECIPE[route]) return { as: ctx.owner, ...(await RECIPE[route]!()) };
	return { as: ctx.owner, ...(SAMPLE[route]?.(ctx) ?? {}) };
}

async function send(route: string, req: Req, body: unknown) {
	const [method, pattern] = route.split(' ') as [string, string];
	const ids = { ...ctx.ids, ...req.params };
	let path = pattern.replace(/:([A-Za-z]+)/g, (_, name: string) => ids[name] ?? ZERO);
	if (req.query) path += `?${new URLSearchParams(req.query)}`;
	const r = await app.request(path, {
		method,
		headers: { origin: ORIGIN, 'content-type': 'application/json', ...(req.as ? { cookie: req.as.cookie } : {}), ...req.headers },
		body: JSON.stringify(body ?? {})
	});
	return { status: r.status, text: await r.text() };
}

let db: pg.Client;
let tables: { name: string; cols: string[]; role: boolean }[] = [];
let pattern = '';

/** The next transaction id: every row written from here on has an xmin at or above it. */
async function mark(): Promise<number> {
	const { rows } = await db.query<{ x: string }>('SELECT (pg_snapshot_xmax(pg_current_snapshot())::text::bigint % 4294967296) AS x');
	return Number(rows[0]!.x);
}

const since = (t: string) => `FROM ${t} r WHERE r.xmin::text::bigint >= $1`;

/** Rows written since `x`: how many, the table.columns holding a hostile value, and new owner roles. */
async function written(x: number, caller: string | null) {
	const counts = await db.query<{ t: string; n: string; bad: string; owners: string }>(
		tables
			.map(
				(t, i) =>
					`SELECT ${i} AS t, count(*) AS n, count(*) FILTER (WHERE r::text ~ $2) AS bad, ${t.role ? `count(*) FILTER (WHERE r.role::text IN ('owner', 'admin') AND to_jsonb(r)->>'user_id' IS DISTINCT FROM $3::text)` : '0'} AS owners ${since(t.name)}`
			)
			.join(' UNION ALL '),
		[x, pattern, caller]
	);
	let rows = 0;
	const hostileCols: string[] = [];
	const owners: string[] = [];
	for (const c of counts.rows) {
		const t = tables[Number(c.t)]!;
		rows += Number(c.n);
		if (Number(c.owners) > 0) owners.push(t.name);
		if (Number(c.bad) === 0) continue;
		const { rows: cols } = await db.query(
			`SELECT ${t.cols.map((col, i) => `count(*) FILTER (WHERE r.${col}::text ~ $2) AS c${i}`).join(', ')} ${since(t.name)}`,
			[x, pattern]
		);
		for (const [i, col] of t.cols.entries()) if (Number(cols[0]![`c${i}`]) > 0) hostileCols.push(`${t.name}.${col}`);
	}
	return { rows, hostileCols, owners };
}

type Outcome = { route: string; hostile: number[]; legit?: number; rows: number; hostileCols: string[]; owners: string[]; text: string };
const outcomes = new Map<string, Outcome>();


beforeAll(async () => {
	Object.assign(ctx, await buildLadder('M'));
	ctx.victim = await signUp('Mvictim');
	ctx.otherProjectId = (await ctx.owner.call('POST', '/projects', { name: 'Mass other' })).body.project.id;
	const team = async () => (await ctx.owner.call('POST', '/teams', { name: `Mass team ${crypto.randomUUID().slice(0, 8)}` })).body.team.id as string;
	ctx.teamId = await team();
	ctx.otherTeamId = await team();
	// The victim may be named anywhere a member may: an editor of both projects and a team member.
	for (const p of [ctx.projectId, ctx.otherProjectId]) expect((await ctx.owner.call('POST', `/projects/${p}/members`, { email: ctx.victim.email, role: 'editor' })).status).toBe(201);
	for (const t of [ctx.teamId, ctx.otherTeamId]) expect((await ctx.owner.call('POST', `/teams/${t}/members`, { email: ctx.victim.email, role: 'member' })).status).toBe(201);
	expect((await ctx.owner.call('POST', `/teams/${ctx.teamId}/members`, { email: ctx.viewer.email, role: 'viewer' })).status).toBe(201);
	// Whom the contributor may share an application with: their party (049).
	ctx.consultant = await signUp('Mconsultant');
	expect((await ctx.owner.call('POST', `${at()}/members`, { email: ctx.consultant.email, role: 'contributor' })).status).toBe(201);
	for (const u of [ctx.contributor, ctx.consultant]) expect((await ctx.owner.call('PATCH', `${at()}/members/${u.id}`, { party: 'Mass party' })).status).toBe(200);
	// An observed record, so an uncertainty ensemble can start; alert subscriptions to unsubscribe from.
	expect((await ctx.owner.call('PUT', `${at()}/series`, observed())).status).toBe(200);
	expect((await ctx.owner.call('PUT', `/me/alerts/${ctx.projectId}`, { items: [{ kind: 'all', mode: 'immediate' }] })).status).toBe(200);
	const key = await ctx.owner.call('POST', `/projects/${ctx.projectId}/api-keys`, { name: 'Mass key' });
	expect(key.status).toBe(201);
	ctx.apiKey = key.body.secret;
	const link = await ctx.owner.call('POST', `/projects/${ctx.projectId}/share-links`, { label: 'Mass link', expiresInDays: 7 });
	ctx.shareToken = String(link.body.link.url).split('#t=')[1]!;
	const doc = await app.request(`/projects/${ctx.projectId}/export.json`, { headers: { cookie: ctx.owner.cookie, origin: ORIGIN } });
	expect(doc.status).toBe(200);
	ctx.exportDoc = await doc.json();

	pattern = `(${[FRESH, ctx.otherProjectId, ctx.victim.id, ctx.otherTeamId, MARK, 'hostileMarker', TS.slice(0, 10)].join('|')})`;
	db = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await db.connect();
	await db.query(`SET TIME ZONE 'UTC'`);
	const { rows } = await db.query<{ name: string; cols: string[] }>(
		`SELECT format('%I', c.relname) AS name, array_agg(format('%I', a.attname) ORDER BY a.attnum) AS cols
		 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		 JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
		 WHERE n.nspname = 'public' AND c.relkind = 'r' GROUP BY c.relname ORDER BY c.relname`
	);
	tables = rows.map((r) => ({ ...r, role: r.cols.includes('role') }));

	for (const route of routes) {
		const o: Outcome = { route, hostile: [], rows: 0, hostileCols: [], owners: [], text: '' };
		for (const extras of [shallow, deep]) {
			const req = await recipe(route);
			const x = await mark();
			const r = await send(route, req, extras(req.body ?? {}));
			const w = await written(x, req.as?.id ?? null);
			o.hostile.push(r.status);
			o.rows += w.rows;
			o.hostileCols.push(...w.hostileCols);
			o.owners.push(...w.owners);
			if (r.status >= 300) o.text ||= r.text.slice(0, 200);
		}
		if (o.hostile.some((s) => s === 400)) {
			const req = await recipe(route);
			const l = await send(route, req, req.body ?? {});
			o.legit = l.status;
			if (l.status >= 300) o.text = `legit: ${l.text.slice(0, 200)}`;
		}
		outcomes.set(route, o);
	}
}, 300_000);

afterAll(async () => {
	// The ladder's yield job and what the sweep's POSTs queued (the rules' run …/auto-calibrations queues among them).
	await clearLadderJobs(ctx);
	await db?.end();
});

describe('the mass-assignment sweep', () => {
	it('sweeps every write route (not vacuous)', () => {
		expect(routes.length).toBeGreaterThan(70);
		expect(tables.length).toBeGreaterThan(40);
	});

	it('lists no route that no longer exists', () => {
		for (const r of [...Object.keys(RECIPE), ...NO_WRITE.keys(), ...NOT_REACHED.keys()]) expect(routes, r).toContain(r);
	});

	it('stores no hostile extra field, at the top level or nested', () => {
		const bad = [...outcomes.values()].filter((o) => o.hostileCols.length).map((o) => `${o.route} → ${[...new Set(o.hostileCols)].join(', ')}`);
		expect(bad).toEqual([]);
	});

	it('makes nobody but the caller an owner (project) or admin (team), whatever role the body names', () => {
		const bad = [...outcomes.values()].filter((o) => o.owners.length).map((o) => `${o.route} → ${o.owners.join(', ')}`);
		expect(bad).toEqual([]);
	});

	it('answers each hostile body with success or a 400, never an error', () => {
		const bad = [...outcomes.values()]
			.filter((o) => !NOT_REACHED.has(o.route) && o.hostile.some((s) => s >= 300 && s !== 400))
			.map((o) => `${o.route} → ${o.hostile.join('/')} ${o.text}`);
		expect(bad).toEqual([]);
	});

	it('positive control: a route that refused the extras (400) accepts the same body without them', () => {
		const bad = [...outcomes.values()]
			.filter((o) => !NOT_REACHED.has(o.route) && o.legit !== undefined && (o.legit < 200 || o.legit >= 300))
			.map((o) => `${o.route} → hostile ${o.hostile.join('/')}, legit ${o.legit}: ${o.text}`);
		expect(bad).toEqual([]);
	});

	it('positive control: a route that accepted the extras wrote rows, unless listed as writing none', () => {
		const silent = [...outcomes.values()].filter((o) => o.hostile.some((s) => s < 300) && o.rows === 0).map((o) => o.route);
		expect(silent.sort().join('\n')).toBe([...NO_WRITE.keys()].sort().join('\n'));
	});

	it('lists as not reached only routes that are refused past validation', () => {
		for (const r of NOT_REACHED.keys()) {
			const o = outcomes.get(r)!;
			expect(o.hostile, r).toEqual([400, 400]);
			expect(o.legit, r).toBe(NOT_REACHED.get(r)!.legit);
		}
	});
});

describe('positive control: the detector and the legitimate fields', () => {
	it('finds a hostile value written on purpose', async () => {
		const x = await mark();
		await db.query('UPDATE project SET name = $1 WHERE id = $2', [`Mass ${MARK}`, ctx.otherProjectId]);
		expect((await written(x, null)).hostileCols).toContain('project.name');
		await db.query(`UPDATE project SET name = 'Mass other' WHERE id = $1`, [ctx.otherProjectId]);
	});

	it('finds someone other than the caller made an owner', async () => {
		const x = await mark();
		const set = (role: string) => db.query('UPDATE project_member SET role = $1 WHERE project_id = $2 AND user_id = $3', [role, ctx.otherProjectId, ctx.victim.id]);
		await set('owner');
		const byOther = await written(x, ctx.owner.id);
		// The caller's own owner row is theirs to have (a new project, a team move).
		const bySelf = await written(x, ctx.victim.id);
		await set('editor');
		expect(byOther.owners).toContain('project_member');
		expect(bySelf.owners).toEqual([]);
	});

	it('stores the legitimate fields beside the ignored extras', async () => {
		// POST /projects strips what it doesn't know (zod's default): the name is kept, the rest is the server's.
		const made = await ctx.owner.call('POST', '/projects', { ...hostile(), teamId: undefined, name: 'Kept project' });
		expect(made.status).toBe(201);
		const { rows } = await db.query('SELECT id, name, team_id, created_at FROM project WHERE id = $1', [made.body.project.id]);
		expect(rows[0]).toMatchObject({ name: 'Kept project', team_id: null });
		expect(rows[0]!.id).not.toBe(FRESH);
		expect(new Date(rows[0]!.created_at).getFullYear()).toBeGreaterThan(2020);
		const { rows: members } = await db.query('SELECT user_id, role FROM project_member WHERE project_id = $1', [made.body.project.id]);
		expect(members).toEqual([{ user_id: ctx.owner.id, role: 'owner' }]);

		const reg = await app.request('/auth/register', {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: ORIGIN },
			body: JSON.stringify({ ...hostile(), email: `mass-${crypto.randomUUID()}@example.com`, password: 'correct horse', displayName: 'Kept Name', acceptTerms: LEGAL_VERSION, emailVerified: true, isAdmin: true })
		});
		// Waits for its confirmation link (202, issue #57): nothing it sent confirms it.
		expect(reg.status).toBe(202);
		const { email: regEmail } = (await reg.json()) as { email: string };
		const { rows: u } = await db.query('SELECT display_name, email_verified_at FROM app_user WHERE email = $1', [regEmail]);
		expect(u[0]).toEqual({ display_name: 'Kept Name', email_verified_at: null });
	});

	// The deep pass can't reach the settings of a project file: another nested
	// object refuses the extras first. The settings on their own, then.
	it('imports a project file without the unknown settings keys (they used to pass through)', async () => {
		const doc = structuredClone(ctx.exportDoc) as { settings: Record<string, unknown> };
		doc.settings = { ...hostile(), ...doc.settings, lakeEvapFactor: 0.7 };
		const x = await mark();
		const r = await ctx.owner.call('POST', '/projects/import', doc);
		expect(r.status).toBe(201);
		expect((await written(x, ctx.owner.id)).hostileCols).toEqual([]);
		const { rows } = await db.query('SELECT settings FROM project WHERE id = $1', [r.body.project.id]);
		expect(rows[0]!.settings.lakeEvapFactor).toBe(0.7);
		expect(Object.keys(rows[0]!.settings)).not.toContain('hostileMarker');
	});
});
