// Every dedupe key a contributor's job is queued under names the user
// (contributorKinds.ts, issue #386): two users never share one.
import { describe, expect, it } from 'vitest';
import { CONTRIBUTOR_JOB_DEDUPE_KEYS } from './contributorKinds.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('the dedupe keys of the kinds a contributor can queue', () => {
	const cases = Object.entries(CONTRIBUTOR_JOB_DEDUPE_KEYS).flatMap(([kind, keys]) => (keys ?? []).map((key, i) => [`${kind} #${i}`, key] as const));

	it('lists at least one key for each kind', () => {
		for (const [kind, keys] of Object.entries(CONTRIBUTOR_JOB_DEDUPE_KEYS)) expect(keys?.length, kind).toBeGreaterThan(0);
	});

	it.each(cases)('%s names the user, so two users never share a pending job', (_, key) => {
		expect(key(A)).toContain(A);
		expect(key(A)).not.toBe(key(B));
	});

	it('keeps the kinds’ keys apart, so a retry or an answer never stands in for a request', () => {
		const all = cases.map(([, key]) => key(A));
		expect(new Set(all).size).toBe(all.length);
	});
});
