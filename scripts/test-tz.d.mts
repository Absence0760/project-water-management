// Types for scripts/test-tz.mjs, which the workspaces' vitest configs and tz guards import.
export declare const TEST_TIME_ZONES: readonly string[];
export declare const DEFAULT_TEST_TZ: string;
export declare function testTimeZone(env?: Record<string, string | undefined>): string;
