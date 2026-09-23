import { Hono } from 'hono';
import { z } from 'zod';
import { withoutUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { requireUser, type AuthEnv } from './middleware.js';
import { DUMMY_HASH, hashPassword, verifyPassword } from './password.js';
import { clearSession, issueSession } from './session.js';

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(8).max(200);

const RegisterBody = z.object({
	email,
	password,
	displayName: z.string().trim().min(1).max(100)
});
const LoginBody = z.object({ email, password: z.string().min(1).max(200) });

type UserRow = { id: string; email: string; display_name: string };
const toUser = (r: UserRow) => ({ id: r.id, email: r.email, displayName: r.display_name });

export const authRoutes = new Hono<AuthEnv>()
	.post('/register', async (c) => {
		const body = RegisterBody.parse(await c.req.json());
		const hash = await hashPassword(body.password);
		const row = await withoutUser(async (db) => {
			const { rows } = await db.query<UserRow>(
				`INSERT INTO app_user (email, display_name, password_hash) VALUES ($1, $2, $3)
				 ON CONFLICT (email) DO NOTHING RETURNING id, email, display_name`,
				[body.email, body.displayName, hash]
			);
			return rows[0];
		});
		if (!row) throw new ApiError(409, 'an account with that email already exists');
		await issueSession(c, row.id);
		return c.json({ user: toUser(row) }, 201);
	})
	.post('/login', async (c) => {
		const body = LoginBody.parse(await c.req.json());
		const row = await withoutUser(async (db) => {
			const { rows } = await db.query<UserRow & { password_hash: string }>(
				'SELECT id, email, display_name, password_hash FROM app_user WHERE email = $1',
				[body.email]
			);
			return rows[0];
		});
		const ok = await verifyPassword(body.password, row?.password_hash ?? DUMMY_HASH);
		if (!row || !ok) throw new ApiError(401, 'wrong email or password');
		await issueSession(c, row.id);
		return c.json({ user: toUser(row) });
	})
	.post('/logout', (c) => {
		clearSession(c);
		return c.body(null, 204);
	})
	.get('/me', requireUser, async (c) => {
		const row = await withoutUser(async (db) => {
			const { rows } = await db.query<UserRow>('SELECT id, email, display_name FROM app_user WHERE id = $1', [
				c.get('userId')
			]);
			return rows[0];
		});
		if (!row) throw new ApiError(401, 'not signed in');
		return c.json({ user: toUser(row) });
	});
