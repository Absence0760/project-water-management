// The migrate Lambda's role step (syncAppRole) against real Postgres: the
// password verifier it builds is one Postgres accepts at login, a re-run
// re-passwords the role, and a role holding an attribute that defeats RLS
// stops the deploy. A throwaway role, never water_app: a role belongs to the
// whole cluster, and water_app's password is every local database's.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { OWNER_URL, TEST_DB } from './__tests__/test-db.js';
import { syncAppRole } from './lambda-migrate.js';

const role = `wm_sync_test_${randomBytes(6).toString('hex')}`;
const password = () => randomBytes(18).toString('hex');

/** Signs in as the throwaway role over TCP (SCRAM): null when Postgres accepts, else the SQLSTATE. */
async function signIn(pw: string): Promise<string | null> {
	const c = new pg.Client({ connectionString: `postgresql://${role}:${pw}@127.0.0.1:5434/${TEST_DB}` });
	try {
		await c.connect();
		return null;
	} catch (e) {
		return (e as { code?: string }).code ?? String(e);
	} finally {
		await c.end().catch(() => {});
	}
}

async function asOwner(sql: string) {
	const c = new pg.Client({ connectionString: OWNER_URL });
	await c.connect();
	try {
		await c.query(sql);
	} finally {
		await c.end();
	}
}

afterAll(() => asOwner(`DROP ROLE IF EXISTS ${role}`));

describe('syncAppRole (the migrate Lambda’s role step)', () => {
	const first = password();
	const second = password();

	it('creates the role with a SCRAM verifier Postgres accepts for its password, and no other', async () => {
		expect(await syncAppRole(OWNER_URL, first, role)).toBe('created');
		expect(await signIn(first)).toBeNull();
		expect(await signIn(second)).toBe('28P01');
	});

	it('a re-run re-passwords the role: the old password stops working', async () => {
		expect(await syncAppRole(OWNER_URL, second, role)).toBe('updated');
		expect(await signIn(second)).toBeNull();
		expect(await signIn(first)).toBe('28P01');
	});

	it('refuses to continue when the role can bypass RLS or create roles', async () => {
		for (const attr of ['BYPASSRLS', 'CREATEROLE']) {
			await asOwner(`ALTER ROLE ${role} ${attr}`);
			await expect(syncAppRole(OWNER_URL, second, role)).rejects.toThrow(/privileged attribute .* refusing to continue/);
			await asOwner(`ALTER ROLE ${role} NO${attr}`);
		}
		// Positive control: with the attribute gone the same call goes through.
		expect(await syncAppRole(OWNER_URL, second, role)).toBe('updated');
	});
});
