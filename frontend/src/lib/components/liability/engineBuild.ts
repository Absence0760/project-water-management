// The engine build record this site was built with (WP-3.13, docs/model.md
// §2.10f): the web release workflow runs the engine's invariant suite and a
// soak and injects the result (vite.config.ts `__ENGINE_BUILD__`, from
// scripts/release/engine-build.mjs). Null in any other build, and for a
// record that doesn't parse: the validation statement then says the build's
// results were not recorded.
import { parseEngineBuild } from '@water-management/engine';

// `typeof`: a context without the define (vitest) reads as no record rather than throwing.
export const ENGINE_BUILD = parseEngineBuild(typeof __ENGINE_BUILD__ === 'string' ? __ENGINE_BUILD__ : undefined);
