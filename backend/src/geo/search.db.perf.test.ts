// Wall-clock budget for the Map's search over a country-sized gazetteer
// (issue #523 C5; docs/maps.md § Gazetteer). South Africa's GeoNames dump
// keeps about 150 000 places, and production's database is a db.t4g.small,
// so a search must go through the trigram index on ' ' || search_name (225),
// never read the whole table: the first test checks the plan (structural, so
// it fails on the query's shape, not on a slow laptop), the second the time.
// Before the index (and 225's USING (true) read policy, which lets the query
// use it under RLS) a search read every row: a median of about 150 ms here.
// Through it, 5 to 11 ms.
//
// Its own vitest project (`perf-db`, vitest.config.ts): a timing budget,
// so out of `pnpm test` and CI, and against Postgres, so with the db
// project's global setup. Run it alone: `pnpm test:backend:perf:db`.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp } from '../__tests__/helpers.js';
import { withUser, type Db } from '../db/tx.js';
import { searchMap } from './gazetteer.js';
import { replacePlaces, type PlaceRecord } from './loadGazetteer.js';

const PLACES = 150_000;
const DATASET = 'perf-gazetteer';
const BUDGET_MS = 40;
/** A long word, a common word that matches thousands, two one-letter words, a word and a number. */
const QUERIES = ['kwartsv klein', 'fontein', 'k d', 'groot more', 'kloof 42'];

const OWNER_URL = () => process.env.TEST_MIGRATION_DATABASE_URL!;
let userId: string;

/** Invented, Afrikaans-shaped place names: a prefix word or none, a compound of two parts, then a word and a number. */
function place(i: number): PlaceRecord {
	const pre = ['klein', 'groot', 'nuwe', 'ou', 'boven', 'onder', 'wes', 'oos', '', ''][(i * 7) % 10]!;
	const a = ['kwarts', 'wilge', 'sand', 'more', 'vaal', 'riet', 'doorn', 'klip', 'berg', 'leeu', 'olifants', 'bos', 'water', 'fontein', 'kraal', 'hoek', 'drift', 'rand', 'kloof', 'vlei'][i % 20]!;
	const b = ['vallei', 'rivier', 'laagte', 'ster', 'bank', 'fontein', 'kop', 'spruit', 'dal', 'pan', 'hoek', 'kuil', 'berg', 'plaas', 'vlakte'][Math.floor(i / 20) % 15]!;
	const tail = i % 3 === 0 ? `${['dam', 'farm', 'noord', 'suid', 'plot'][Math.floor(i / 300) % 5]} ${i % 997}` : `${i % 5003}`;
	const name = `${pre ? `${pre} ` : ''}${a}${b} ${tail}`;
	return { placeId: String(i), name, searchName: name, feature: ['P.PPL', 'S.FRM', 'H.STM', 'T.HLL'][i % 4]!, admin1: '11', country: 'ZA', lon: 18 + (i % 1000) / 100, lat: -34 + Math.floor(i / 1000) / 100, source: 'SYNTHETIC perf data' };
}

/** The SQL and parameters searchMap sends for the gazetteer, caught on the way through. */
async function placesQuery(q: string): Promise<{ sql: string; params: unknown[] }> {
	let caught: { sql: string; params: unknown[] } | null = null;
	await withUser(userId, async (db) => {
		const spy = new Proxy(db, {
			get(target, prop) {
				if (prop === 'query')
					return (sql: string, params: unknown[]) => {
						if (sql.includes('FROM gazetteer_reference')) caught = { sql, params };
						return target.query(sql, params);
					};
				const v = Reflect.get(target, prop);
				return typeof v === 'function' ? v.bind(target) : v;
			}
		}) as Db;
		await searchMap(spy, q);
	});
	if (!caught) throw new Error(`no gazetteer query for ${q}`);
	return caught;
}

/** Every plan node's type and index, depth first. */
function planNodes(plan: Record<string, unknown>): { type: string; index?: string }[] {
	const here = { type: plan['Node Type'] as string, index: plan['Index Name'] as string | undefined };
	return [here, ...((plan['Plans'] as Record<string, unknown>[] | undefined) ?? []).flatMap(planNodes)];
}

beforeAll(async () => {
	userId = (await signUp('PerfSearch')).id;
	const client = new pg.Client({ connectionString: OWNER_URL() });
	await client.connect();
	try {
		expect(await replacePlaces(client, DATASET, Array.from({ length: PLACES }, (_, i) => place(i + 1)))).toBe(PLACES);
		await client.query('ANALYZE gazetteer_reference');
	} finally {
		await client.end();
	}
}, 300_000);

afterAll(async () => {
	const client = new pg.Client({ connectionString: OWNER_URL() });
	await client.connect();
	try {
		await client.query('DELETE FROM gazetteer_reference WHERE dataset = $1', [DATASET]);
	} finally {
		await client.end();
	}
});

describe('map search over a country-sized gazetteer', () => {
	it.each(QUERIES)('"%s" goes through the trigram index, never a scan of the table', async (q) => {
		const { sql, params } = await placesQuery(q);
		const plan = await withUser(userId, (db) => db.query<{ 'QUERY PLAN': [{ Plan: Record<string, unknown> }] }>(`EXPLAIN (FORMAT JSON) ${sql}`, params));
		const nodes = planNodes(plan.rows[0]!['QUERY PLAN'][0].Plan);
		expect(nodes.some((n) => n.index === 'gazetteer_reference_search_trgm_idx'), JSON.stringify(nodes)).toBe(true);
		expect(nodes.some((n) => n.type === 'Seq Scan'), JSON.stringify(nodes)).toBe(false);
	});

	it(`answers each search over ${PLACES} places in under ${BUDGET_MS} ms (median of 7)`, async () => {
		for (const q of QUERIES) {
			const once = async () => {
				const t = performance.now();
				const answer = await withUser(userId, (db) => searchMap(db, q));
				return { ms: performance.now() - t, answer };
			};
			const { answer } = await once(); // warm-up
			// The fixture is what the budget is about: each search finds places in it.
			expect(answer.hits.some((h) => h.kind === 'place' && h.dataset === DATASET), q).toBe(true);
			const ms: number[] = [];
			for (let i = 0; i < 7; i++) ms.push((await once()).ms);
			ms.sort((a, b) => a - b);
			console.info(`map search "${q}": median ${ms[3]!.toFixed(1)} ms, min ${ms[0]!.toFixed(1)}, max ${ms[6]!.toFixed(1)} (${PLACES} places)`);
			expect(ms[3], q).toBeLessThan(BUDGET_MS);
		}
	});
});
