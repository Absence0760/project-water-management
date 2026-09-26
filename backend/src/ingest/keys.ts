// Per-project API keys (roadmap WP-2.9, 039_api_keys.sql, docs/api.md §
// Ingest): the key format, hashing, the constant-time comparison, the owner's
// request bodies and the row shapes. Pure, so it is unit-tested (keys.test.ts).
//
// A key is `wm_<prefix>_<secret>`: `prefix` is the first 8 characters of the
// key's id (lower-case hex, shown in lists and used to find the row), and
// `secret` is 32 random bytes as base64url (43 characters). Only the SHA-256
// of the whole key is stored; with 256 bits of entropy a slow hash adds
// nothing (the reasoning of the emailed tokens, auth/tokens.ts).
import { SERIES_KINDS } from '@water-management/engine';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/** Longest key name, in characters (039_api_keys.sql CHECK). */
export const API_KEY_NAME_MAX = 100;
/** Longest a key may be set to live, in days (the CHECK allows 3650); absent = until revoked. */
export const API_KEY_DAYS_MAX = 3650;
/** Most series one key may be limited to (the CHECK). */
export const ALLOWED_SERIES_MAX = 50;
/** The scopes a key can hold. Only one so far. */
export const API_KEY_SCOPES = ['series:write'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** The per-key rate limit: a bucket of `capacity` requests, refilled at `perMinute` (app_api_key_take). */
export const INGEST_RATE = { capacity: 60, perMinute: 60 } as const;

/** A key we issued, exactly: anything else is refused before any database work. */
const KEY_RE = /^wm_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;

/** SHA-256 of the whole key, as stored in api_key.key_hash. */
export const hashApiKey = (key: string): Buffer => createHash('sha256').update(key, 'utf8').digest();

/** A new key for the row `id` (a UUID the caller inserts with): the key, shown once, and its hash. */
export function newApiKey(id: string): { key: string; prefix: string; hash: Buffer } {
	const prefix = id.slice(0, 8).toLowerCase();
	const key = `wm_${prefix}_${randomBytes(32).toString('base64url')}`;
	return { key, prefix, hash: hashApiKey(key) };
}

/** The prefix and hash of a presented key, or null when it can't be one of ours. */
export function parseApiKey(key: string): { prefix: string; hash: Buffer } | null {
	const m = KEY_RE.exec(key);
	return m ? { prefix: m[1]!, hash: hashApiKey(key) } : null;
}

/**
 * The key from an `Authorization: Bearer <key>` header, or null. The scheme
 * is case-insensitive (RFC 9110); the key itself is not.
 */
export function bearerKey(header: string | undefined | null): string | null {
	if (!header || header.length > 200) return null;
	const m = /^Bearer +(\S+)$/i.exec(header.trim());
	return m ? m[1]! : null;
}

/**
 * Whether two key hashes are equal, in constant time: the comparison takes as
 * long whichever byte differs, so response timing says nothing about how
 * close a guess was. Hashes of another length never match (and still cost a
 * comparison).
 */
export function sameKeyHash(presented: Buffer, stored: Buffer): boolean {
	if (presented.length !== stored.length) {
		timingSafeEqual(presented, presented);
		return false;
	}
	return timingSafeEqual(presented, stored);
}

/** One series a key may write. */
export const AllowedSeriesItem = z
	.object({
		kind: z.enum(SERIES_KINDS),
		name: z.string().trim().max(100).default('')
	})
	.strict();
export type AllowedSeries = z.output<typeof AllowedSeriesItem>;

const noNul = (s: string) => !s.includes('\u0000');

export const CreateKeyBody = z
	.object({
		name: z.string().trim().min(1, 'give the key a name').max(API_KEY_NAME_MAX).refine(noNul, 'name cannot contain NUL characters'),
		scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).max(API_KEY_SCOPES.length).optional(),
		// Absent or null: any series of the project.
		allowedSeries: z
			.array(AllowedSeriesItem)
			.min(1)
			.max(ALLOWED_SERIES_MAX)
			.nullable()
			.optional()
			.transform((list) => {
				if (!list) return null;
				const seen = new Set<string>();
				return list.filter((s) => {
					const k = `${s.kind}\u0000${s.name}`;
					if (seen.has(k)) return false;
					seen.add(k);
					return true;
				});
			}),
		// Absent or null: until revoked.
		expiresInDays: z.number().int().min(1).max(API_KEY_DAYS_MAX).nullable().optional()
	})
	.strict();

/** The ingest merge's own field beside the series body: a free label for where the days came from. */
export const IngestExtras = z.object({
	source: z.string().trim().max(100).refine(noNul, 'source cannot contain NUL characters').optional()
});

/** Whether a key limited to `allowed` (null: any) may write the series (kind, name). */
export const keyAllows = (allowed: readonly AllowedSeries[] | null, kind: string, name: string): boolean =>
	allowed === null || allowed.some((s) => s.kind === kind && s.name === name);

export interface ApiKeyRow {
	id: string;
	name: string;
	prefix: string;
	scopes: string[];
	allowed_series: AllowedSeries[] | null;
	created_at: Date;
	created_by_name: string | null;
	last_used_at: Date | null;
	expires_at: Date | null;
	revoked_at: Date | null;
	revoked_by_name: string | null;
}

/** Every column the owner sees. Never key_hash. */
export const SELECT_KEYS = `
	SELECT k.id, k.name, k.prefix, k.scopes, k.allowed_series, k.created_at, cu.display_name AS created_by_name,
		k.last_used_at, k.expires_at, k.revoked_at, ru.display_name AS revoked_by_name
	FROM api_key k
	LEFT JOIN app_user cu ON cu.id = k.created_by
	LEFT JOIN app_user ru ON ru.id = k.revoked_by`;

/** A key as its owner sees it: never the key or its hash. */
export interface ApiKey {
	id: string;
	name: string;
	prefix: string;
	scopes: string[];
	allowedSeries: AllowedSeries[] | null;
	createdAt: string;
	createdBy: string | null;
	lastUsedAt: string | null;
	expiresAt: string | null;
	revokedAt: string | null;
	revokedBy: string | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export const toApiKey = (r: ApiKeyRow): ApiKey => ({
	id: r.id,
	name: r.name,
	prefix: r.prefix,
	scopes: r.scopes,
	allowedSeries: r.allowed_series,
	createdAt: r.created_at.toISOString(),
	createdBy: r.created_by_name,
	lastUsedAt: iso(r.last_used_at),
	expiresAt: iso(r.expires_at),
	revokedAt: iso(r.revoked_at),
	revokedBy: r.revoked_by_name
});
