import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { readJson } from './body.js';
import { handleError } from './errors.js';

const app = new Hono().post('/', async (c) => c.json({ got: await readJson(c) })).onError(handleError);
const post = (body: string) => app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body });

describe('readJson', () => {
	it('returns the parsed body', async () => {
		const res = await post('{"a":1}');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ got: { a: 1 } });
	});

	it.each(['', '{', 'not json', '{"a":1,}'])('turns %j into a 400', async (body) => {
		const res = await post(body);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'invalid JSON' });
	});
});
