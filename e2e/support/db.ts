// Direct database access for the few e2e flows that start from an email.
// Tokens are stored only as SHA-256 hashes, and e2e prints mail to the
// backend's log (MAIL_TRANSPORT=log) rather than to somewhere a test can read,
// so these helpers plant a token whose plaintext the test knows, the way the
// backend would have issued it. Runs as the schema owner on the isolated
// `water_e2e` database; `pg` is the backend's own (see global-setup.ts).
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { OWNER_E2E_URL } from './env.ts';

interface PgClient {
	connect(): Promise<void>;
	query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null }>;
	end(): Promise<void>;
}
type PgModule = { Client: new (opts: { connectionString: string }) => PgClient };

const backendDir = fileURLToPath(new URL('../../backend/', import.meta.url));
const pg = createRequire(`${backendDir}package.json`)('pg') as PgModule;

async function withDb<T>(fn: (db: PgClient) => Promise<T>): Promise<T> {
	const db = new pg.Client({ connectionString: OWNER_E2E_URL });
	await db.connect();
	try {
		return await fn(db);
	} finally {
		await db.end();
	}
}

function newToken(): { token: string; hash: Buffer } {
	const token = randomBytes(32).toString('base64url');
	return { token, hash: createHash('sha256').update(token, 'utf8').digest() };
}

/**
 * A live link token for `email`, as POST /auth/forgot-password ('reset') or
 * sign-up / resend-verification ('verify') would have mailed it.
 */
export async function plantEmailToken(email: string, purpose: 'reset' | 'verify'): Promise<string> {
	const { token, hash } = newToken();
	await withDb(async (db) => {
		const r = await db.query(
			`INSERT INTO email_token (user_id, purpose, token_hash, expires_at)
			 SELECT id, $3::email_token_purpose, $2, now() + interval '1 hour' FROM app_user WHERE email = $1`,
			[email, hash, purpose]
		);
		if (r.rowCount !== 1) throw new Error(`no user ${email}`);
	});
	return token;
}

/** Re-key the pending invite(s) for `email` so the test knows the link token. */
export async function plantInviteToken(email: string): Promise<string> {
	const { token, hash } = newToken();
	await withDb(async (db) => {
		const r = await db.query('UPDATE invite SET token_hash = $2 WHERE email = $1', [email, hash]);
		if (r.rowCount !== 1) throw new Error(`expected one invite for ${email}, got ${r.rowCount}`);
	});
	return token;
}
