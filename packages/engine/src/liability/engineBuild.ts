// The engine build's own test record (roadmap WP-3.13, model.md §2.10f): the
// release workflows run scripts/release/engine-build.mjs, which runs the
// engine's unit suite (the invariant tests included) and a random-network soak
// and writes engine-build.json; the frontend build (a Vite `define`) and the
// backend's Lambda bundles (an esbuild `define`) inject that JSON as
// ENGINE_BUILD_JSON. Everything here is pure: the frontend and the backend
// each read the injected text through parseEngineBuild. No record (dev, the
// e2e build, any build CI didn't make) is null, and a statement then says the
// build's results were not recorded rather than claiming them.
import { ENGINE_VERSION } from '../version';

export interface EngineBuild {
	/** The ENGINE_VERSION the suite ran against. */
	version: string;
	/** The commit the suite ran on (hex, 7–40 characters). */
	gitSha: string;
	invariantsPassed: boolean;
	/** Random catchments the soak ran (FUZZ_CASES). */
	soakCases: number;
}

const SHA = /^[0-9a-f]{7,40}$/;

/** The record's four fields when `x` has exactly that shape, else null. */
export function asEngineBuild(x: unknown): EngineBuild | null {
	if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
	const o = x as Record<string, unknown>;
	if (typeof o.version !== 'string' || !o.version) return null;
	if (typeof o.gitSha !== 'string' || !SHA.test(o.gitSha)) return null;
	if (typeof o.invariantsPassed !== 'boolean') return null;
	if (typeof o.soakCases !== 'number' || !Number.isSafeInteger(o.soakCases) || o.soakCases < 0) return null;
	return { version: o.version, gitSha: o.gitSha, invariantsPassed: o.invariantsPassed, soakCases: o.soakCases };
}

/**
 * The injected ENGINE_BUILD_JSON text as a record for this engine: null when
 * absent or empty, when it isn't JSON or isn't a record, and when it was made
 * for another ENGINE_VERSION (a stale file must never vouch for this build).
 */
export function parseEngineBuild(json: string | null | undefined, engineVersion: string = ENGINE_VERSION): EngineBuild | null {
	if (!json) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch {
		return null;
	}
	const b = asEngineBuild(raw);
	return b && b.version === engineVersion ? b : null;
}
