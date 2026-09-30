// This build's engine test record (WP-3.13, model.md §2.10f): the release
// workflow runs scripts/release/engine-build.mjs and the build injects its
// JSON as the `__ENGINE_BUILD_JSON__` define (vite.config.ts engineBuildDefine).
// Dev, vitest and the e2e build have none: null, and ValidationStatement says
// "Not recorded for this build". parseEngineBuild refuses a record made for
// another ENGINE_VERSION.
import { parseEngineBuild, type EngineBuild } from '@water-management/engine';

declare const __ENGINE_BUILD_JSON__: string | undefined;

export const ENGINE_BUILD: EngineBuild | null = parseEngineBuild(typeof __ENGINE_BUILD_JSON__ === 'string' ? __ENGINE_BUILD_JSON__ : null);
