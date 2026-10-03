import { describe, expect, it } from 'vitest';
import { keptOr } from './kept';

describe('keptOr', () => {
	it('off gives the off value; on brings back a copy of what was kept, else a fresh default', () => {
		expect(keptOr(false, { a: 1 }, () => ({ a: 0 }), null)).toBeNull();
		expect(keptOr(true, null, () => ({ a: 0 }), null)).toEqual({ a: 0 });
		const last = { a: 5 };
		const back = keptOr(true, last, () => ({ a: 0 }), null);
		expect(back).toEqual({ a: 5 });
		expect(back).not.toBe(last);
		// A kept 0 is a value, not "nothing kept".
		expect(keptOr(true, 0, () => 20, null)).toBe(0);
	});
});
