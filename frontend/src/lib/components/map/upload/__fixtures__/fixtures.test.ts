// The committed upload fixtures (read by e2e/tests/map-upload-formats.spec.ts)
// are what build.ts makes; UPDATE_UPLOAD_FIXTURES=1 rewrites them.
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMMITTED } from './build';

describe('committed upload fixtures', () => {
	for (const [name, build] of Object.entries(COMMITTED)) {
		it(`${name} is what build.ts makes`, () => {
			const url = new URL(`./${name}`, import.meta.url);
			const want = build();
			const bytes = typeof want === 'string' ? new TextEncoder().encode(want) : want;
			if (process.env.UPDATE_UPLOAD_FIXTURES) writeFileSync(url, bytes);
			expect(new Uint8Array(readFileSync(url))).toEqual(bytes);
		});
	}
});
