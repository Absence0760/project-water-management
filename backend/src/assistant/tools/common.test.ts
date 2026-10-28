// The tools' shared helpers (issue #610): arguments, node lookup, compact.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiError } from '../../http/errors.js';
import { compact, findNode, parseArgs, refusal, round, specOf } from './common.js';

describe('parseArgs', () => {
	const S = z.object({ key: z.string().min(1), n: z.number().int().default(3) }).strict();
	it('takes an object or JSON text of one, with defaults', () => {
		expect(parseArgs(S, { key: 'outflow' })).toEqual({ ok: true, value: { key: 'outflow', n: 3 } });
		expect(parseArgs(S, '{"key":"x","n":5}')).toEqual({ ok: true, value: { key: 'x', n: 5 } });
	});
	it('refuses bad JSON, a wrong type and an unknown field, naming the field', () => {
		expect(parseArgs(S, '{key')).toEqual({ ok: false, error: 'the arguments are not valid JSON' });
		const wrong = parseArgs(S, { key: 'x', n: 1.5 });
		expect(wrong.ok === false && wrong.error).toMatch(/^invalid arguments: n: /);
		expect(parseArgs(S, { key: 'x', extra: 1 }).ok).toBe(false);
		expect(parseArgs(S, undefined).ok).toBe(false);
	});
});

describe('specOf', () => {
	it('is the zod schema as JSON Schema, without $schema', () => {
		const spec = specOf('t', 'd', z.object({ key: z.string().describe('the key') }).strict());
		expect(spec).toMatchObject({ name: 't', description: 'd', parameters: { type: 'object', properties: { key: { type: 'string', description: 'the key' } }, required: ['key'] } });
		expect(spec.parameters.$schema).toBeUndefined();
	});
});

describe('refusal', () => {
	it('answers an ApiError with its message and rethrows anything else (a database error is never sent)', () => {
		expect(refusal(new ApiError(404, 'not found'))).toEqual({ ok: false, error: 'not found' });
		const db = new Error('relation "run_series" does not exist');
		expect(() => refusal(db)).toThrow(db);
	});
});

describe('findNode', () => {
	const nodes = [
		{ id: 'a1', name: 'Upper Weir' },
		{ id: 'b2', name: 'Farm B' }
	];
	it('finds by id, then by name in any case', () => {
		expect(findNode(nodes, 'b2')?.name).toBe('Farm B');
		expect(findNode(nodes, ' upper weir ')?.id).toBe('a1');
		expect(findNode(nodes, 'nowhere')).toBeUndefined();
	});
});

describe('compact', () => {
	it('rounds, cuts long arrays with a count, folds deep nesting and trims long strings', () => {
		expect(round(1234.5678)).toBe(1235);
		expect(round(Number.NaN)).toBeNull();
		expect(compact({ a: [1, 2, 3, 4], b: { c: { d: 1 } }, s: 'x'.repeat(10), u: undefined }, { maxItems: 2, maxDepth: 2, maxString: 4 })).toEqual({
			a: [1, 2, '… 2 more'],
			b: { c: '…' },
			s: 'xxxx…'
		});
		expect(compact(0.123456789, { digits: 0 })).toBe(0.123456789);
	});
});
