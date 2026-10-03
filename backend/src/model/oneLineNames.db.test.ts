// 189_one_line_names (issue #385): the names already stored with a line break
// or other control character are made one line, so their projects still save
// under today's schema, and a CHECK keeps any path that skips the API from
// storing one again. Needs Postgres (pnpm dev:db:up).
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { ModelBody, modelProblems } from './validate.js';
import { loadModel } from './store.js';

const MIGRATION = readFileSync(new URL('../../migrations/189_one_line_names.sql', import.meta.url), 'utf8');
/** The migration's cleaning (its DO block and the schedule UPDATE), without the CHECKs that follow. */
const CLEANING = MIGRATION.slice(0, MIGRATION.indexOf('ALTER TABLE node ADD CONSTRAINT'));
const CHECKS = ['node', 'crop', 'borehole', 'demand_object'] as const;

async function newProject(name: string) {
	const owner = await signUp(name);
	return (await owner.call('POST', '/projects', { name })).body.project.id as string;
}

describe('189_one_line_names', () => {
	it('the cleaning is the whole migration but its CHECKs', () => {
		expect(CLEANING).toMatch(/DO \$\$/);
		expect(MIGRATION.slice(CLEANING.length).trim().split('\n')).toHaveLength(CHECKS.length);
	});

	it('makes stored names and schedule labels one line, keeps node and crop names unique, and leaves notes and other projects alone', async () => {
		const pid = await newProject('OneLine');
		const other = await newProject('OneLineOther');
		const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
		await client.connect();
		try {
			await client.query('BEGIN');
			// As the data was before 189: no CHECK.
			for (const t of CHECKS) await client.query(`ALTER TABLE ${t} DROP CONSTRAINT ${t}_name_one_line`);
			const insertNode = async (project: string, name: string) =>
				(await client.query<{ id: string }>(`INSERT INTO node (project_id, name, kind) VALUES ($1, $2, 'farm') RETURNING id`, [project, name])).rows[0]!.id;
			const golf = await insertNode(pid, 'Golf\r\nFarm');
			await insertNode(pid, 'golf farm'); // the cleaned name, but for case: " (2)"
			const blank = await insertNode(pid, '\u0007\n');
			const long = await insertNode(pid, `${'x'.repeat(98)}\ty`);
			const elsewhere = await insertNode(other, 'Golf\nFarm'); // another project: no clash
			const crop = (await client.query<{ id: string }>(`INSERT INTO crop (project_id, name, crop_factor) VALUES ($1, $2, $3) RETURNING id`, [pid, 'Vines\u009fD', new Array(12).fill(0.5)])).rows[0]!.id;
			const bh = (await client.query<{ id: string }>(`INSERT INTO borehole (project_id, node_id, name, capacity_m3_day) VALUES ($1, $2, $3, 10) RETURNING id`, [pid, golf, 'BH\u20281'])).rows[0]!.id;
			const schedule = [{ label: 'Easter\tweek', span: 'always', factor: 1 }, { label: '', span: 'always', factor: 2 }];
			const obj = (
				await client.query<{ id: string }>(
					`INSERT INTO demand_object (project_id, node_id, name, monthly_m3_day, note, schedule) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
					[pid, golf, 'Town\nwater', new Array(12).fill(5), 'line one\nline two', JSON.stringify(schedule)]
				)
			).rows[0]!.id;

			await client.query(CLEANING);

			const name = async (t: string, id: string) => (await client.query<{ name: string }>(`SELECT name FROM ${t} WHERE id = $1`, [id])).rows[0]!.name;
			expect(await name('node', golf)).toBe('Golf Farm (2)');
			expect(await name('node', blank)).toBe('Unnamed');
			expect(await name('node', long)).toBe(`${'x'.repeat(98)} y`.slice(0, 100));
			expect(await name('node', elsewhere)).toBe('Golf Farm');
			expect(await name('crop', crop)).toBe('Vines D');
			expect(await name('borehole', bh)).toBe('BH 1');
			const o = (await client.query(`SELECT name, note, schedule FROM demand_object WHERE id = $1`, [obj])).rows[0];
			expect(o).toEqual({ name: 'Town water', note: 'line one\nline two', schedule: [{ label: 'Easter week', span: 'always', factor: 1 }, { label: '', span: 'always', factor: 2 }] });

			// Every name now passes the CHECK the migration adds.
			for (const t of CHECKS) await client.query(MIGRATION.split('\n').find((l) => l.startsWith(`ALTER TABLE ${t} ADD CONSTRAINT`))!);

			// And the project's model passes today's schema (as the editor's next save sends it).
			const model = await loadModel(client as never, pid);
			const parsed = ModelBody.safeParse(model);
			expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
			expect(modelProblems(parsed.data!).filter((p) => /name/i.test(p))).toEqual([]);
		} finally {
			await client.query('ROLLBACK');
			await client.end();
		}
	});

	it('the CHECKs refuse a control character in a stored name (positive control: one line is stored)', async () => {
		const pid = await newProject('OneLineCheck');
		await expect(asOwner(`INSERT INTO node (project_id, name, kind) VALUES ($1, $2, 'farm')`, [pid, 'Golf\nFarm'])).rejects.toMatchObject({ code: '23514' });
		await expect(asOwner(`INSERT INTO node (project_id, name, kind) VALUES ($1, $2, 'farm')`, [pid, 'Golf\u0085Farm'])).rejects.toMatchObject({ code: '23514' });
		await expect(asOwner(`INSERT INTO crop (project_id, name, crop_factor) VALUES ($1, $2, $3)`, [pid, 'Vines\u2029D', new Array(12).fill(0.5)])).rejects.toMatchObject({ code: '23514' });
		expect(await asOwner(`INSERT INTO node (project_id, name, kind) VALUES ($1, $2, 'farm') RETURNING name`, [pid, 'Golf Farm'])).toEqual([{ name: 'Golf Farm' }]);
	});
});
