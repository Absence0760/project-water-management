// The engine build's test record (WP-3.13, model.md §2.10f), for evidence pack
// manifests (WP-3.14). infra/scripts/package-lambdas.sh bakes the release's
// engine-build.json into every Lambda bundle as the esbuild define
// __ENGINE_BUILD_JSON__ (from ENGINE_BUILD_JSON, which deploy-backend.yml sets
// from scripts/release/engine-build.mjs). Unbundled (the dev server, the
// worker under tsx, vitest) the global is undefined and there is no record.
// Deliberately not a process.env read: the record is a fact about the bundle,
// fixed when it was built, not a setting (config/production.ts classifies every
// setting a Lambda reads).
import { parseEngineBuild, type EngineBuild } from '@water-management/engine';

declare const __ENGINE_BUILD_JSON__: string | undefined;

/** This build's engine test record, or null (none injected, unreadable, or made for another ENGINE_VERSION). */
export function engineBuild(): EngineBuild | null {
	return parseEngineBuild(typeof __ENGINE_BUILD_JSON__ === 'string' ? __ENGINE_BUILD_JSON__ : null);
}
