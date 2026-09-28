// Sessions and account tokens, the controls the feature tests
// (email.db.test.ts, auth.db.test.ts, invites.db.test.ts) don't pin
// (docs/security.md § Authentication, § Password reset, email verification
// and invites):
//   - no table can hold a raw credential: a sweep of every credential-like
//     column (information_schema), and a sweep of every text/json/bytea column
//     for the raw tokens the API just mailed;
//   - each emailed token gets the lifetime the docs promise;
//   - a reset or verify link is single use even when opened in parallel;
//   - the session JWT refuses every forgery shape and lives 7 days;
//   - adding someone by email answers the same whether or not an unverified
//     account holds the address (response, invite list, audit row and
//     History item), and login the same for an unknown address
//     and a wrong password.
// Every "cannot" has a positive control. Needs Postgres (pnpm dev:db:up).
import { SignJWT } from 'jose';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { anon, asOwner, lastMailTo, node, signUp, tokenIn } from '../__tests__/helpers.js';
import { maskEmail } from '../history/record.js';
import { hashToken } from './tokens.js';

const newEmail = (tag: string) => `${tag}-${crypto.randomUUID()}@example.com`;

async function withOwnerClient<T>(fn: (db: pg.Client) => Promise<T>): Promise<T> {
	const db = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await db.connect();
	try {
		return await fn(db);
	} finally {
		await db.end();
	}
}

/**
 * Columns whose name looks like a credential but which hold none, each with
 * its reason. Anything else matching CREDENTIAL_NAME must be a SHA-256 digest.
 */
const NOT_A_CREDENTIAL: Record<string, string> = {
	'api_key_throttle.tokens': 'the token bucket’s fill level (a number), not a secret',
	'job.lease_token': 'a worker’s lease on a claimed job (uuid); it authorises nothing outside the worker',
	'app_user.password_hash': 'bcrypt, not SHA-256: checked on its own below'
};
const CREDENTIAL_NAME = /(token|secret|password|api_?key|_hash)/;

describe('no table stores a raw credential', () => {
	it('every credential-like column is a 32-byte SHA-256 digest, CHECK-constrained (catalogue sweep)', async () => {
		const cols = await asOwner(
			`SELECT c.table_name AS t, c.column_name AS c, c.udt_name AS type,
				coalesce((SELECT array_agg(pg_get_constraintdef(k.oid)) FROM pg_constraint k
					WHERE k.conrelid = format('public.%I', c.table_name)::regclass AND k.contype = 'c'), '{}') AS checks
			 FROM information_schema.columns c
			 JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
			 WHERE c.table_schema = 'public' AND tb.table_type = 'BASE TABLE'`
		);
		const credential = cols.filter(
			(r) => CREDENTIAL_NAME.test(r.c) && !/_id$/.test(r.c) && !(`${r.t}.${r.c}` in NOT_A_CREDENTIAL)
		);
		// Positive control: the sweep finds the stores it is meant to guard.
		const names = credential.map((r) => `${r.t}.${r.c}`);
		for (const known of ['email_token.token_hash', 'invite.token_hash', 'share_link.token_hash', 'render_token.token_hash', 'api_key.key_hash']) {
			expect(names).toContain(known);
		}
		const bad = credential
			.filter((r) => {
				const digestCheck = new RegExp(`octet_length\\(${r.c}\\) = 32`);
				return !r.c.endsWith('_hash') || r.type !== 'bytea' || !(r.checks as string[]).some((k) => digestCheck.test(k));
			})
			.map((r) => `${r.t}.${r.c} (${r.type})`);
		expect(bad, 'store only the SHA-256 of a credential, as bytea with CHECK (octet_length(col) = 32)').toEqual([]);
		// Every allowlisted column still exists (a stale entry would hide a rename).
		for (const key of Object.keys(NOT_A_CREDENTIAL)) expect(cols.map((r) => `${r.t}.${r.c}`)).toContain(key);
	});

	it('passwords are bcrypt hashes, never the password', async () => {
		const u = await signUp('Bcrypt');
		const [row] = await asOwner('SELECT password_hash FROM app_user WHERE id = $1', [u.id]);
		expect(row.password_hash).toMatch(/^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/);
		expect(row.password_hash).not.toContain('correct horse');
	});

	it('the raw tokens just mailed (verify, reset, project and team invites) appear in no column of any table', async () => {
		const owner = await signUp('SweepOwner');
		const projectId = (await owner.call('POST', '/projects', { name: 'Sweep' })).body.project.id as string;
		const teamId = (await owner.call('POST', '/teams', { name: 'Sweep team' })).body.team.id as string;

		const unverified = await signUp('SweepVerify', { verified: false });
		const verifyToken = tokenIn(lastMailTo(unverified.email));
		const resetUser = await signUp('SweepReset');
		expect((await anon('POST', '/auth/forgot-password', { email: resetUser.email })).status).toBe(202);
		const resetToken = tokenIn(lastMailTo(resetUser.email));
		const projectInvitee = newEmail('sweep-project');
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: projectInvitee, role: 'viewer' })).status).toBe(201);
		const projectInvite = tokenIn(lastMailTo(projectInvitee));
		const teamInvitee = newEmail('sweep-team');
		expect((await owner.call('POST', `/teams/${teamId}/members`, { email: teamInvitee, role: 'member' })).status).toBe(201);
		const teamInvite = tokenIn(lastMailTo(teamInvitee));

		const raw = [verifyToken, resetToken, projectInvite, teamInvite];
		expect(new Set(raw).size).toBe(4);
		// Each token as text (base64url, and the hex of its bytes) and as bytes (decoded, and its UTF-8).
		const texts = raw.flatMap((t) => [t, Buffer.from(t, 'base64url').toString('hex')]);
		const bytes = raw.flatMap((t) => [Buffer.from(t, 'base64url'), Buffer.from(t, 'utf8')]);
		const digests = raw.map((t) => hashToken(t));

		const { leaks, digestsFound } = await withOwnerClient(async (db) => {
			const { rows: cols } = await db.query<{ t: string; c: string; type: string }>(
				`SELECT c.table_name AS t, c.column_name AS c, c.udt_name AS type
				 FROM information_schema.columns c
				 JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
				 WHERE c.table_schema = 'public' AND tb.table_type = 'BASE TABLE'
					AND c.udt_name IN ('text', 'varchar', 'bpchar', 'citext', 'json', 'jsonb', 'bytea', '_text')`
			);
			expect(cols.length).toBeGreaterThan(50);
			const leaks: string[] = [];
			let digestsFound = 0;
			for (const { t, c, type } of cols) {
				const ref = `${db.escapeIdentifier(t)}.${db.escapeIdentifier(c)}`;
				if (type === 'bytea') {
					const hit = await db.query(
						`SELECT 1 FROM ${db.escapeIdentifier(t)} WHERE EXISTS (SELECT 1 FROM unnest($1::bytea[]) b WHERE position(b IN ${ref}) > 0) LIMIT 1`,
						[bytes]
					);
					if (hit.rowCount) leaks.push(`${t}.${c}`);
					const { rows } = await db.query<{ n: number }>(
						`SELECT count(*)::int AS n FROM ${db.escapeIdentifier(t)} WHERE ${ref} = ANY($1::bytea[])`,
						[digests]
					);
					digestsFound += rows[0]!.n;
				} else {
					const hit = await db.query(
						`SELECT 1 FROM ${db.escapeIdentifier(t)} WHERE EXISTS (SELECT 1 FROM unnest($1::text[]) s WHERE strpos(${ref}::text, s) > 0) LIMIT 1`,
						[texts]
					);
					if (hit.rowCount) leaks.push(`${t}.${c}`);
				}
			}
			return { leaks, digestsFound };
		});
		// Positive control: the same scan finds each token's digest (email_token, invite).
		expect(digestsFound).toBe(4);
		expect(leaks, 'a raw emailed token is stored in the database').toEqual([]);
	});
});

describe('emailed tokens live as long as the docs say', () => {
	const lifetime = async (sql: string, params: unknown[]) => Number((await asOwner(sql, params))[0]?.s);

	it('verify 48 h, reset 1 h, invite 7 days, and a re-sent invite gets a fresh 7 days', async () => {
		const u = await signUp('Ttl', { verified: false });
		expect(await lifetime(`SELECT extract(epoch FROM expires_at - created_at) AS s FROM email_token WHERE user_id = $1 AND purpose = 'verify'`, [u.id])).toBe(48 * 3600);
		expect((await anon('POST', '/auth/forgot-password', { email: u.email })).status).toBe(202);
		expect(await lifetime(`SELECT extract(epoch FROM expires_at - created_at) AS s FROM email_token WHERE user_id = $1 AND purpose = 'reset'`, [u.id])).toBe(3600);

		const owner = await signUp('TtlOwner');
		const projectId = (await owner.call('POST', '/projects', { name: 'Ttl' })).body.project.id as string;
		const email = newEmail('ttl');
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email, role: 'viewer' })).status).toBe(201);
		const inviteTtl = `SELECT extract(epoch FROM expires_at - last_sent_at) AS s FROM invite WHERE email = $1`;
		expect(await lifetime(inviteTtl, [email])).toBe(7 * 24 * 3600);
		// Re-sent after the cooldown: a new link with a new 7 days (not the old expiry).
		await asOwner(`UPDATE invite SET last_sent_at = now() - interval '2 days', expires_at = now() + interval '5 days' WHERE email = $1`, [email]);
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email, role: 'viewer' })).status).toBe(201);
		expect(await lifetime(inviteTtl, [email])).toBe(7 * 24 * 3600);
	});
});

describe('a link is single use even when opened in parallel', () => {
	// Parallel HTTP requests don't overlap reliably (a reset hashes the new
	// password first, which serialises them on the event loop), so this races
	// the consume itself: a second transaction consumes the token while the
	// first, which already consumed it, is still open.
	it.each(['reset', 'verify'] as const)('a %s token consumed in one open transaction is refused to a second (app_consume_email_token)', async (purpose) => {
		const u = await signUp(`Race-${purpose}`, { verified: purpose === 'reset' });
		if (purpose === 'reset') expect((await anon('POST', '/auth/forgot-password', { email: u.email })).status).toBe(202);
		const hash = hashToken(tokenIn(lastMailTo(u.email)));
		const first = new pg.Client({ connectionString: process.env.DATABASE_URL });
		const second = new pg.Client({ connectionString: process.env.DATABASE_URL });
		await Promise.all([first.connect(), second.connect()]);
		try {
			await first.query('BEGIN');
			await second.query('BEGIN');
			const consume = 'SELECT app_consume_email_token($1, $2) AS user_id';
			// Positive control: the first consume gets the account.
			expect((await first.query(consume, [hash, purpose])).rows[0].user_id).toBe(u.id);
			const pid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
			const racing = second.query(consume, [hash, purpose]);
			// Wait until the second is blocked on the first's row lock, then let the first commit.
			let blocked = false;
			for (let i = 0; i < 200 && !blocked; i++) {
				const [row] = await asOwner('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid]);
				blocked = row?.wait_event_type === 'Lock';
			}
			expect(blocked).toBe(true);
			await first.query('COMMIT');
			expect((await racing).rows[0].user_id).toBeNull();
			await second.query('COMMIT');
		} finally {
			await Promise.all([first.end(), second.end()]);
		}
	});
});

describe('the session cookie', () => {
	const secret = () => new TextEncoder().encode(process.env.AUTH_JWT_SECRET!);
	const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
	const me = (jwt: string) => anon('GET', '/auth/me', undefined, `wm_session=${jwt}`);
	const now = () => Math.floor(Date.now() / 1000);
	const signed = (sub: string, opts: { alg?: string; key?: Uint8Array; iss?: string; iat?: number; exp?: number; claims?: Record<string, unknown> } = {}) =>
		new SignJWT({ iat_ms: Date.now(), ...opts.claims })
			.setProtectedHeader({ alg: opts.alg ?? 'HS256' })
			.setSubject(sub)
			.setIssuer(opts.iss ?? 'water-management')
			.setIssuedAt(opts.iat ?? now())
			.setExpirationTime(opts.exp ?? now() + 3600)
			.sign(opts.key ?? secret());

	it('refuses every forged or stale shape; the well-formed one is accepted (positive control)', async () => {
		const u = await signUp('Jwt');
		const other = await signUp('JwtOther');
		expect((await me(await signed(u.id))).status).toBe(200);

		const forged: Record<string, string> = {
			'unsigned (alg none)': `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: u.id, iss: 'water-management', iat: now(), exp: now() + 3600 })}.`,
			'another secret': await signed(u.id, { key: new TextEncoder().encode('an-attacker-chosen-secret-000000000000000') }),
			'another HMAC algorithm (HS512)': await signed(u.id, { alg: 'HS512' }),
			'another issuer': await signed(u.id, { iss: 'someone-else' }),
			expired: await signed(u.id, { iat: now() - 8 * 24 * 3600, exp: now() - 60 }),
			'a subject that is not a user id': await signed('admin'),
			'a tampered payload': (await signed(u.id)).replace(/\.[^.]+\./, `.${b64({ sub: other.id, iss: 'water-management', iat: now(), exp: now() + 3600 })}.`)
		};
		for (const [shape, jwt] of Object.entries(forged)) {
			const res = await me(jwt);
			expect(res.status, shape).toBe(401);
			expect(res.body?.user, shape).toBeUndefined();
		}
	});

	it('is HttpOnly and lives 7 days, cookie and token alike', async () => {
		const u = await signUp('Cookie');
		const res = await anon('POST', '/auth/login', { email: u.email, password: 'correct horse' });
		expect(res.status).toBe(200);
		const cookie = res.headers.get('set-cookie')!;
		expect(cookie).toMatch(/HttpOnly/i);
		expect(cookie).toMatch(/Max-Age=604800(;|$)/);
		const jwt = cookie.split(';')[0]!.split('=')[1]!;
		const payload = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()) as { iat: number; exp: number };
		expect(payload.exp - payload.iat).toBe(7 * 24 * 3600);
	});
});

describe('adding someone by email doesn’t reveal whether the address has an account', () => {
	const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	const ISO_RE = /^\d{4}-\d\d-\d\dT[\d:.]+Z$/;
	/** The response with the parts that must differ (the address, ids, clock) blanked. */
	function shape(v: unknown, email: string): unknown {
		if (typeof v === 'string') return v === email ? '<email>' : UUID_RE.test(v) ? '<id>' : ISO_RE.test(v) ? '<time>' : v;
		if (Array.isArray(v)) return v.map((x) => shape(x, email));
		if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, email)]));
		return v;
	}

	/** An address held by an account that never confirmed it, its sign-up mail's cooldown passed. */
	async function squatted(): Promise<string> {
		const u = await signUp('Squatter', { verified: false });
		await asOwner(`UPDATE email_token SET created_at = now() - interval '2 minutes' WHERE user_id = $1`, [u.id]);
		return u.email;
	}

	async function compare(add: (email: string) => Promise<{ status: number; body: unknown }>, list?: (email: string) => Promise<unknown>) {
		const unknown = newEmail('nobody');
		const held = await squatted();
		const a = await add(unknown);
		const b = await add(held);
		expect(a.status).toBe(201);
		expect(shape(b.body, held)).toEqual(shape(a.body, unknown));
		expect(b.status).toBe(a.status);
		if (list) expect(shape(await list(held), held)).toEqual(shape(await list(unknown), unknown));
		// Positive control: a verified account is told apart (it is added, not invited), so the comparison can see a difference.
		const verified = await signUp('Verified');
		const c = await add(verified.email);
		expect(c.status).toBe(201);
		expect(shape(c.body, verified.email)).not.toEqual(shape(a.body, unknown));
	}

	it('project members: the same invite, and the same row in the owner’s invite list', async () => {
		const owner = await signUp('EnumOwner');
		const projectId = (await owner.call('POST', '/projects', { name: 'Enum' })).body.project.id as string;
		await compare(
			(email) => owner.call('POST', `/projects/${projectId}/members`, { email, role: 'viewer' }),
			async (email) => ((await owner.call('GET', `/projects/${projectId}/invites`)).body.invites as { email: string }[]).find((i) => i.email === email)
		);
	});

	it('team members: the same invite, and the same row in the admin’s invite list', async () => {
		const admin = await signUp('EnumAdmin');
		const teamId = (await admin.call('POST', '/teams', { name: 'Enum team' })).body.team.id as string;
		await compare(
			(email) => admin.call('POST', `/teams/${teamId}/members`, { email, role: 'member' }),
			async (email) => ((await admin.call('GET', `/teams/${teamId}/invites`)).body.invites as { email: string }[]).find((i) => i.email === email)
		);
	});

	it('farmers, one at a time and in bulk: the same invite, and the same row in the farmer list', async () => {
		const owner = await signUp('EnumFarmOwner');
		const projectId = (await owner.call('POST', '/projects', { name: 'Enum farms' })).body.project.id as string;
		const outlet = node('Outlet', null);
		const farm = node('Enum Farm', outlet.id);
		const bulkFarm = node('Enum Bulk Farm', outlet.id);
		const model = { nodes: [outlet, farm, bulkFarm], crops: [], cropAreas: [], transfers: [], landCover: [] };
		expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
		const farmers = async (email: string) =>
			((await owner.call('GET', `/projects/${projectId}/farmers`)).body.farmers as { email: string }[]).find((f) => f.email === email);
		await compare((email) => owner.call('POST', `/projects/${projectId}/farmers`, { email, nodeIds: [farm.id] }), farmers);

		const unknown = newEmail('bulk-nobody');
		const held = await squatted();
		const bulk = await owner.call('POST', `/projects/${projectId}/farmers/bulk`, {
			rows: [
				{ email: unknown, farm: 'Enum Bulk Farm' },
				{ email: held, farm: 'Enum Bulk Farm' }
			]
		});
		expect(bulk.status).toBe(200);
		const [a, b] = bulk.body.results as { email: string; row: number }[];
		expect(a).toMatchObject({ status: 'invited' });
		expect(shape({ ...b, row: 0 }, held)).toEqual(shape(a, unknown));
	});

	// The audit trail too: an owner reads it in History (and their data
	// export carries it). The telling case is an account that signed up
	// moments ago: its verification link is inside the resend cooldown, so the
	// invite sends no new email, which an audit field like `mailed` would show.
	describe('the same audit row and History item', () => {
		type Add = (email: string) => Promise<{ status: number }>;
		/** What adding `email` wrote to the audit log and History, with the address, ids and clock blanked. */
		async function trail(owner: Awaited<ReturnType<typeof signUp>>, projectId: string, email: string, add: Add) {
			const [{ last }] = await asOwner('SELECT coalesce(max(id), 0) AS last FROM audit_event WHERE project_id = $1', [projectId]);
			expect((await add(email)).status).toBeLessThan(300);
			const rows = await asOwner(
				'SELECT kind, actor_user_id, actor_label, subject FROM audit_event WHERE project_id = $1 AND id > $2 ORDER BY id',
				[projectId, last]
			);
			const history = (await owner.call('GET', `/projects/${projectId}/history`)).body.items as { type: string; id: string }[];
			const items = history.filter((i) => i.type === 'event' && BigInt(i.id) > BigInt(last)).map(({ id: _id, ...i }) => i);
			const blank = (v: unknown) =>
				JSON.parse(JSON.stringify(shape(v, email)).replaceAll(JSON.stringify(maskEmail(email)), '"<masked>"')) as unknown;
			return { rows: blank(rows), items: blank(items) };
		}

		async function compareTrails(add: (owner: Awaited<ReturnType<typeof signUp>>, projectId: string, farmId: string) => Add) {
			const owner = await signUp('TrailOwner');
			const projectId = (await owner.call('POST', '/projects', { name: 'Trail' })).body.project.id as string;
			const outlet = node('Outlet', null);
			const farm = node('Trail Farm', outlet.id);
			const model = { nodes: [outlet, farm], crops: [], cropAreas: [], transfers: [], landCover: [] };
			expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
			const go = add(owner, projectId, farm.id);
			const none = await trail(owner, projectId, newEmail('nobody'), go);
			const justSignedUp = await trail(owner, projectId, (await signUp('Fresh', { verified: false })).email, go);
			const older = await trail(owner, projectId, await squatted(), go);
			expect((none.rows as { kind: string }[]).map((r) => r.kind)).toContain('invite.sent');
			expect(justSignedUp).toEqual(none);
			expect(older).toEqual(none);
			// Positive control: a verified account is added, not invited, and the comparison sees it.
			const verified = await trail(owner, projectId, (await signUp('Verified')).email, go);
			expect(verified.rows).not.toEqual(none.rows);
			expect(verified.items).not.toEqual(none.items);
		}

		it('project members', async () => {
			await compareTrails((owner, projectId) => (email) => owner.call('POST', `/projects/${projectId}/members`, { email, role: 'viewer' }));
		});

		it('farmers, one at a time and in bulk', async () => {
			await compareTrails((owner, projectId, farmId) => (email) => owner.call('POST', `/projects/${projectId}/farmers`, { email, nodeIds: [farmId] }));
			await compareTrails((owner, projectId) => async (email) => {
				const r = await owner.call('POST', `/projects/${projectId}/farmers/bulk`, { rows: [{ email, farm: 'Trail Farm' }] });
				return { status: r.body.results[0].status === 'error' ? 400 : r.status };
			});
		});
	});
});

describe('sign-in doesn’t reveal whether the address has an account', () => {
	it('an unknown address and a wrong password get the same answer, and neither a cookie', async () => {
		const u = await signUp('EnumLogin');
		const wrong = await anon('POST', '/auth/login', { email: u.email, password: 'not the password' });
		const unknown = await anon('POST', '/auth/login', { email: newEmail('nobody'), password: 'not the password' });
		expect(wrong.status).toBe(401);
		expect(unknown.status).toBe(wrong.status);
		expect(unknown.body).toEqual(wrong.body);
		expect(wrong.headers.get('set-cookie')).toBeNull();
		expect(unknown.headers.get('set-cookie')).toBeNull();
		// Positive control: the right password signs in.
		expect((await anon('POST', '/auth/login', { email: u.email, password: 'correct horse' })).status).toBe(200);
	});
});
