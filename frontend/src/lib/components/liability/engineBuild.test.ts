import { describe, expect, it } from 'vitest';
import { ENGINE_BUILD } from './engineBuild';

describe('the engine build record (WP-3.13, issue #70)', () => {
	it('is absent from a build the release workflow didn’t make', () => {
		// vitest has no `define`: like a dev, e2e or CI build, no record (parseEngineBuild's own tests cover a record).
		expect(ENGINE_BUILD).toBeNull();
	});
});
