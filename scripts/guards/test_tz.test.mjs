// CLAUDE.md rule 7: date-sensitive tests run under a skewed TZ. Every vitest
// config sets test.env.TZ from scripts/test-tz.mjs, and CI's unit job runs a
// second pass west of UTC. This fails if either is removed; the runtime half is
// each workspace's tz.test.ts, which checks the zone a worker actually sees.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_TEST_TZ, TEST_TIME_ZONES, testTimeZone } from '../test-tz.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

/** UTC offset in minutes of `zone` at `date`. */
function offsetMinutes(zone, date) {
	const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
		.formatToParts(date)
		.find((p) => p.type === 'timeZoneName').value;
	const m = /^GMT([+-])(\d\d):(\d\d)$/.exec(name);
	assert.ok(m, `${zone}: ${name}`);
	return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

describe('scripts/test-tz.mjs', () => {
	it('defaults to the first zone and accepts only the listed ones', () => {
		assert.equal(testTimeZone({}), DEFAULT_TEST_TZ);
		assert.equal(testTimeZone({ TEST_TZ: '' }), DEFAULT_TEST_TZ);
		for (const zone of TEST_TIME_ZONES) assert.equal(testTimeZone({ TEST_TZ: zone }), zone);
		assert.throws(() => testTimeZone({ TEST_TZ: 'UTC' }), /not one of/);
	});

	it('lists a zone each side of UTC, each off the whole hour and with DST', () => {
		const jan = new Date(Date.UTC(2026, 0, 15));
		const jul = new Date(Date.UTC(2026, 6, 15));
		const signs = new Set();
		for (const zone of TEST_TIME_ZONES) {
			const [a, b] = [offsetMinutes(zone, jan), offsetMinutes(zone, jul)];
			assert.notEqual(a, b, `${zone} has no DST`);
			assert.notEqual(a % 60, 0, `${zone} is a whole-hour offset`);
			signs.add(Math.sign(a));
		}
		assert.deepEqual([...signs].sort(), [-1, 1]);
	});
});

describe('the vitest configs', () => {
	for (const [config, from] of [
		['packages/engine/vitest.config.ts', '../../scripts/test-tz.mjs'],
		['backend/vitest.config.ts', '../scripts/test-tz.mjs'],
		['frontend/vitest.config.ts', '../scripts/test-tz.mjs']
	]) {
		it(`${config} sets test.env.TZ from scripts/test-tz.mjs`, () => {
			const text = read(config);
			assert.ok(text.includes(`import { testTimeZone } from '${from}';`), `${config} doesn't import testTimeZone`);
			assert.match(text, /env: \{[^}]*\bTZ: testTimeZone\(\)/, `${config} doesn't set env.TZ`);
		});
	}
});

describe('CI', () => {
	it('a job of its own runs pnpm test west of UTC, beside the unit job, and the CI gate needs it', () => {
		const ci = read('.github/workflows/ci.yml');
		// Its own job (test-west), so the two passes run at once rather than one after the other in `test`.
		const job = ci.match(/\n  test-west:\n([\s\S]*?)(?=\n  [a-z][\w-]*:\n)/);
		assert.ok(job, 'ci.yml has no test-west job');
		assert.match(job[1], /TEST_TZ: America\/St_Johns\n\s+run: pnpm test\n/);
		const unit = ci.match(/\n  test:\n([\s\S]*?)(?=\n  [a-z][\w-]*:\n)/);
		assert.ok(unit && !unit[1].includes('TEST_TZ'), 'the second pass belongs in test-west, not after the unit job');
		assert.match(ci, /ci-gate:[\s\S]*needs: \[[^\]]*\btest-west\b/);
		assert.ok(TEST_TIME_ZONES.includes('America/St_Johns'));
	});
});
