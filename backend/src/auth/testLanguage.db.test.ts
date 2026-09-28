// Proof, end to end through the API and the database, that a language is one
// table entry plus its email catalogue (issue #58; docs/ui.md § Adding a
// language). The engine's language table is mocked with a stand-in `xx`
// ("Xx-test") and the email catalogue index with a stand-in catalogue for it.
// With no other code change: the migration runner's sync adds it to the
// `language` table, sign-up and PATCH /auth/me accept it, a farmer invite
// (single, and a CSV row naming it by its own name) carries it to the new
// account, and the emails are written in it. Nothing here ships: the rows are
// removed afterwards.
import { LEGAL_VERSION } from '@water-management/engine/legal';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { anon, asOwner, lastMailTo, node, signUp, tokenIn } from '../__tests__/helpers.js';
import { syncLanguages } from '../../scripts/migrate.js';

vi.mock('@water-management/engine/languages', async (importOriginal) => {
	const real = await importOriginal<typeof import('@water-management/engine/languages')>();
	return { ...real, ...real.languageTable([...real.LANGUAGES, { code: 'xx', name: 'Xx-test', intl: 'en-US', decimalMark: ',' }]) };
});
vi.mock('../mail/i18n/catalogues.js', async () => {
	const { en } = await vi.importActual<typeof import('../mail/i18n/en.js')>('../mail/i18n/en.js');
	const real = await vi.importActual<typeof import('../mail/i18n/catalogues.js')>('../mail/i18n/catalogues.js');
	return { CATALOGUES: { ...real.CATALOGUES, xx: Object.fromEntries(Object.entries(en).map(([k, v]) => [k, `[xx] ${v}`])) } };
});

type User = Awaited<ReturnType<typeof signUp>>;
const newEmail = (tag: string) => `${tag}-${crypto.randomUUID()}@example.com`;

let owner: pg.Client;
let wua: User;
let projectId: string;
const outlet = node('Outlet', null);
const farm = node('Farm X', outlet.id);

beforeAll(async () => {
	owner = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await owner.connect();
	// What the migration runner does after every run, here with the mocked table.
	expect(await syncLanguages(owner)).toEqual(['xx']);
	wua = await signUp('Xowner');
	projectId = (await wua.call('POST', '/projects', { name: 'Stand-in catchment' })).body.project.id;
	expect((await wua.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farm], crops: [], cropAreas: [], transfers: [], landCover: [] })).status).toBe(200);
});

afterAll(async () => {
	await owner.query(`UPDATE app_user SET locale = NULL WHERE locale = 'xx'`);
	await owner.query(`UPDATE invite SET locale = 'en' WHERE locale = 'xx'`);
	await owner.query(`DELETE FROM language WHERE code = 'xx'`);
	await owner.end();
});

describe('a stand-in language added to the table (and its email catalogue) only', () => {
	it('is accepted at sign-up, stored, and the confirmation email is in it', async () => {
		const email = newEmail('xx-signup');
		const res = await anon('POST', '/auth/register', { email, password: 'correct horse', displayName: 'X', acceptTerms: LEGAL_VERSION, locale: 'xx' });
		// Waits for its confirmation link (issue #57): the account is read as the schema owner.
		expect(res.status).toBe(202);
		expect(await asOwner('SELECT locale FROM app_user WHERE email = $1', [email])).toEqual([{ locale: 'xx' }]);
		const mail = lastMailTo(email)!;
		expect(mail.subject).toMatch(/^\[xx\] /);
		expect(mail.html).toContain('<html lang="xx">');
	});

	it('is a choice PATCH /auth/me accepts, while an unknown one is still refused', async () => {
		const u = await signUp('Xpatch');
		const ok = await u.call('PATCH', '/auth/me', { locale: 'xx' });
		expect(ok.status).toBe(200);
		expect(ok.body.user.locale).toBe('xx');
		expect((await u.call('PATCH', '/auth/me', { locale: 'zz' })).status).toBe(400);
	});

	it('goes on a farmer invite, and the account made from it takes it', async () => {
		const email = newEmail('xx-farmer');
		const res = await wua.call('POST', `/projects/${projectId}/farmers`, { email, nodeIds: [farm.id], locale: 'xx' });
		expect(res.status).toBe(201);
		expect(res.body.invite.locale).toBe('xx');
		expect(lastMailTo(email)!.subject).toMatch(/^\[xx\] /);
		const reg = await anon('POST', '/auth/register', { email, password: 'correct horse', displayName: 'X', acceptTerms: LEGAL_VERSION, inviteToken: tokenIn(lastMailTo(email)) });
		expect(reg.status).toBe(201);
		expect(reg.body.user.locale).toBe('xx');
	});

	it('is named in a CSV row by its code or its own name, any case', async () => {
		const rows = [
			{ email: newEmail('xx-csv1'), farm: 'Farm X', locale: 'XX' },
			{ email: newEmail('xx-csv2'), farm: 'Farm X', locale: 'xx-TEST' },
			{ email: newEmail('xx-csv3'), farm: 'Farm X', locale: 'yy' }
		];
		const res = await wua.call('POST', `/projects/${projectId}/farmers/bulk`, { rows, dryRun: true });
		expect(res.status).toBe(200);
		expect(res.body.results.map((r: { status: string; error?: string }) => r.error ?? r.status)).toEqual([
			'invited',
			'invited',
			'unknown language “yy” (use en, af, xx, or the language’s name)'
		]);
	});
});
