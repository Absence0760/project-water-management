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

describe('readJson with optional', () => {
	const opt = new Hono().post('/', async (c) => c.json({ got: await readJson(c, { optional: true }) })).onError(handleError);
	const send = (body: string) => opt.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body });

	it.each(['', '  \n'])('takes the empty body %j as {}', async (body) => {
		const res = await send(body);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ got: {} });
	});

	it('still parses a body that is there (positive control)', async () => {
		expect(await (await send('{"label":"x"}')).json()).toEqual({ got: { label: 'x' } });
	});

	it('still refuses malformed JSON and a hostile body', async () => {
		const bad = await send('{');
		expect(bad.status).toBe(400);
		expect(await bad.json()).toEqual({ error: 'invalid JSON' });
		const nul = await send(JSON.stringify({ label: 'a\u0000b' }));
		expect(nul.status).toBe(400);
		expect(await nul.json()).toMatchObject({ code: 'body_refused' });
	});
});
