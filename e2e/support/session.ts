// A session token for the e2e API, minted the way backend/src/auth/session.ts
// signs one (HS256 over { iat_ms, sub, iss, iat, exp }), with the key the e2e
// backend reads: AUTH_JWT_SECRET from backend/.env.development.local, else the
// committed backend/.env.development (the dev-only key; server.ts loads them
// in that order). Only for a state the API can no longer produce: a signed-in
// account that never confirmed its address (api.ts signInUnconfirmed).
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const backend = fileURLToPath(new URL('../../backend/', import.meta.url));

function secret(): string {
	for (const file of ['.env.development.local', '.env.development']) {
		const path = backend + file;
		if (!existsSync(path)) continue;
		const line = readFileSync(path, 'utf8').match(/^AUTH_JWT_SECRET=(.*)$/m);
		if (line?.[1]) return line[1].trim().replace(/^['"]|['"]$/g, '');
	}
	throw new Error('no AUTH_JWT_SECRET in backend/.env.development(.local)');
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

export function sessionToken(userId: string): string {
	const now = Math.floor(Date.now() / 1000);
	const body = `${b64({ alg: 'HS256' })}.${b64({ iat_ms: Date.now(), sub: userId, iss: 'water-management', iat: now, exp: now + 3600 })}`;
	return `${body}.${createHmac('sha256', secret()).update(body).digest('base64url')}`;
}
