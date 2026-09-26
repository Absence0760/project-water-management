// Authenticating an ingest request by its API key (WP-2.9, 039_api_keys.sql;
// docs/security.md § API keys).
//
//   1. The Authorization header must carry `Bearer wm_<prefix>_<secret>` in
//      exactly our format; anything else is refused before any database work.
//   2. The prefix finds the row (app_api_key_lookup, SECURITY DEFINER: there
//      is no user), and the presented key's SHA-256 is compared with the
//      stored one in constant time (keys.ts sameKeyHash). An unknown prefix
//      still costs a comparison, against a dummy hash.
//   3. A revoked or expired key, an unknown one and a wrong secret all get
//      the same 401 with the same message.
//   4. The key's token bucket takes one request (app_api_key_take, which also
//      records last_used_at at most once a minute); an empty bucket is a 429
//      with Retry-After. This transaction commits on its own, before the
//      request's work, so a failing request still counts.
//
// The request's work then runs in withApiKey (db/tx.ts), where RLS re-checks
// the key on every statement.
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { withoutUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { type AllowedSeries, bearerKey, INGEST_RATE, parseApiKey, sameKeyHash } from './keys.js';

/** The key a request authenticated with. */
export interface ApiKeyContext {
	id: string;
	projectId: string;
	projectName: string;
	name: string;
	scopes: string[];
	allowedSeries: AllowedSeries[] | null;
}

export type IngestEnv = { Variables: { apiKey: ApiKeyContext } };

/** One message for every refused key: missing, malformed, unknown, wrong, revoked or expired. */
export const BAD_KEY = 'invalid or missing API key';

/** Compared against when the prefix matches no key, so that path costs a comparison too. */
const DUMMY_HASH = Buffer.alloc(32);

interface LookupRow {
	id: string;
	project_id: string;
	project_name: string;
	key_hash: Buffer;
	name: string;
	scopes: string[];
	allowed_series: AllowedSeries[] | null;
	live: boolean;
}

export type KeyCheck = { ok: true; key: ApiKeyContext } | { ok: false; status: 401 } | { ok: false; status: 429; retryAfter: number };

/** Check an Authorization header's key and take one request from its bucket. */
export async function checkApiKey(header: string | undefined): Promise<KeyCheck> {
	const parsed = parseApiKey(bearerKey(header) ?? '');
	if (!parsed) return { ok: false, status: 401 };
	return withoutUser(async (db) => {
		const { rows } = await db.query<LookupRow>('SELECT * FROM app_api_key_lookup($1)', [parsed.prefix]);
		const row = rows[0];
		const match = sameKeyHash(parsed.hash, row?.key_hash ?? DUMMY_HASH);
		if (!row || !match || !row.live) return { ok: false, status: 401 } as const;
		const { rows: taken } = await db.query<{ wait: number }>('SELECT app_api_key_take($1, $2, $3) AS wait', [
			row.id,
			INGEST_RATE.capacity,
			INGEST_RATE.perMinute
		]);
		const wait = taken[0]!.wait;
		// -1: revoked or expired between the lookup and the take.
		if (wait < 0) return { ok: false, status: 401 } as const;
		if (wait > 0) return { ok: false, status: 429, retryAfter: wait } as const;
		return {
			ok: true,
			key: {
				id: row.id,
				projectId: row.project_id,
				projectName: row.project_name,
				name: row.name,
				scopes: row.scopes,
				allowedSeries: row.allowed_series
			}
		} as const;
	});
}

/** Rejects with 401 (or 429) unless the request carries a live API key; sets `apiKey`. */
export const requireApiKey = createMiddleware<IngestEnv>(async (c, next) => {
	const res = await checkApiKey(c.req.header('authorization'));
	if (!res.ok) {
		if (res.status === 429) {
			c.header('Retry-After', String(res.retryAfter));
			throw new ApiError(429, `too many requests for this key: at most ${INGEST_RATE.perMinute} a minute`);
		}
		c.header('WWW-Authenticate', 'Bearer');
		throw new ApiError(401, BAD_KEY);
	}
	c.set('apiKey', res.key);
	await next();
});

/** 403 unless the request's key holds `scope`. */
export function requireScope(c: Context<IngestEnv>, scope: string): ApiKeyContext {
	const key = c.get('apiKey');
	if (!key.scopes.includes(scope)) throw new ApiError(403, `this key does not have the ${scope} scope`);
	return key;
}
