// The time zone every vitest project runs in (CLAUDE.md rule 7: date-sensitive
// tests run under a skewed TZ). Each workspace's vitest.config.ts sets
// `test.env.TZ` from here, so a test never inherits the developer's shell (or
// CI's UTC), and code that reads a local-time Date where it means a UTC
// calendar day fails on every machine alike (docs/testing.md § Time zone).
//
// Two zones, on either side of UTC, both with a non-whole-hour offset and DST:
//   - Pacific/Chatham (UTC+12:45, +13:45 in the southern summer), the default.
//     A local midnight is the previous UTC day, so `new Date(y, m, d)` turned
//     into an ISO date string slips back a day.
//   - America/St_Johns (UTC−3:30, −2:30 in the northern summer). A UTC midnight
//     is the previous local day, so `getDate()` on a `YYYY-MM-DD` parse slips
//     back a day.
// CI's unit job runs `pnpm test` once under each (TEST_TZ=America/St_Johns for
// the second); locally `TEST_TZ=America/St_Johns pnpm test` does the same.
// The guards (src/testing/tz.test.ts in each workspace, and
// scripts/guards/test_tz.test.mjs) fail if the setting is removed.

/** The zones a vitest run may use. Never UTC: a UTC run hides the bugs. */
export const TEST_TIME_ZONES = Object.freeze(['Pacific/Chatham', 'America/St_Johns']);

/** The default zone, when TEST_TZ is unset. */
export const DEFAULT_TEST_TZ = TEST_TIME_ZONES[0];

/**
 * The zone this run uses: TEST_TZ if set (it must be one of TEST_TIME_ZONES),
 * else the default.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function testTimeZone(env = process.env) {
	const requested = env.TEST_TZ;
	if (requested === undefined || requested === '') return DEFAULT_TEST_TZ;
	if (!TEST_TIME_ZONES.includes(requested)) {
		throw new Error(`TEST_TZ=${requested} is not one of ${TEST_TIME_ZONES.join(', ')} (scripts/test-tz.mjs)`);
	}
	return requested;
}
