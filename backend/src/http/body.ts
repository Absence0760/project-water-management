import type { Context } from 'hono';
import { ApiError } from './errors.js';

/**
 * Deepest nesting a JSON body may have (objects and arrays). The deepest
 * legitimate body, a project file's settings or model, is under 10 levels;
 * past this, a hostile body overflows the stack of the schema walk or of
 * Postgres's jsonb parser (a 500 either way).
 */
export const MAX_JSON_DEPTH = 64;

/**
 * Why a parsed body can't be taken, or null. Walked without recursion, so a
 * deep body can't overflow the walk itself.
 * - A NUL (`\u0000`) in any string or key: Postgres refuses NUL in text and
 *   jsonb alike (22021, 22P05), so it could only ever fail as a 500.
 * - A number JSON.parse turned into ±Infinity (a literal like 1e400): no
 *   field means that, and a schema that forgets `.finite()` would store it.
 */
export function jsonBodyProblem(value: unknown): string | null {
	const stack: [unknown, number][] = [[value, 0]];
	while (stack.length) {
		const [v, depth] = stack.pop()!;
		if (typeof v === 'string') {
			if (v.includes('\u0000')) return 'the body contains a NUL character';
		} else if (typeof v === 'number') {
			if (!Number.isFinite(v)) return 'the body contains a number too large to use';
		} else if (v !== null && typeof v === 'object') {
			if (depth >= MAX_JSON_DEPTH) return `the body is nested more than ${MAX_JSON_DEPTH} levels deep`;
			if (Array.isArray(v)) for (const x of v) stack.push([x, depth + 1]);
			else
				for (const [k, x] of Object.entries(v)) {
					if (k.includes('\u0000')) return 'the body contains a NUL character';
					stack.push([x, depth + 1]);
				}
		}
	}
	return null;
}

/**
 * The request body parsed as JSON. A body that isn't JSON is the client's
 * mistake, so it is a 400, not the 500 that `c.req.json()`'s SyntaxError
 * would become in `handleError`. So is a body no route can store (a NUL, an
 * overflowing number, nesting past MAX_JSON_DEPTH): refused here, once for
 * every route, with the code `body_refused` (docs/security.md § Input limits).
 *
 * `optional`: a route whose every field is optional (start a run, restore a
 * revision) takes an empty body as `{}`. A body that is there is still
 * parsed and checked, so malformed JSON stays a 400.
 *
 * Every JSON body goes through here: body.guard.test.ts fails on a route
 * that reads one any other way.
 */
export async function readJson(c: Context, opts: { optional?: boolean } = {}): Promise<unknown> {
	let body: unknown;
	try {
		const text = await c.req.text();
		if (opts.optional && !text.trim()) return {};
		body = JSON.parse(text);
	} catch (err) {
		if (err instanceof SyntaxError) throw new ApiError(400, 'invalid JSON');
		throw err;
	}
	const problem = jsonBodyProblem(body);
	if (problem) throw ApiError.coded(400, 'body_refused', problem);
	return body;
}
