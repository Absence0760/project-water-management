// The build line of the validation statement (WP-3.13, model.md §2.10f): the
// record CI injects (lib/engineBuild.ts), shown only for a run this engine
// version made, and "Not recorded for this build" otherwise.
import { ENGINE_VERSION, type RunSummary } from '@water-management/engine';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import ValidationStatement from './ValidationStatement.svelte';

const summary = {
	farms: [],
	catchment: { meanNaturalFlowM3Day: 1, meanSimulatedOutflowM3Day: 1, ewrDaysNotMet: 0, ewrFractionDaysNotMet: 0 },
	calibration: null,
	warnings: []
} as unknown as RunSummary;
const build = { version: ENGINE_VERSION, gitSha: '0123456789abcdef0123456789abcdef01234567', invariantsPassed: true, soakCases: 2000 };
const text = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const line = (props: Record<string, unknown>) => /Invariant suite and soak for this build (.*?) Self-checks/.exec(text(render(ValidationStatement, { props: { summary, engineVersion: ENGINE_VERSION, legacy: false, ...props } }).body))?.[1];

describe('ValidationStatement: the build line', () => {
	it('says "Not recorded" without a record (dev, vitest and the e2e build inject none)', () => {
		expect(line({})).toBe('Not recorded for this build');
		expect(line({ build: null })).toBe('Not recorded for this build');
	});

	it('shows the injected record for a run this engine version made', () => {
		expect(line({ build })).toMatch(/^Passed, 2[\s,]?000 random catchments \(build 0123456\)$/);
		expect(line({ build: { ...build, invariantsPassed: false } })).toMatch(/^FAILED,/);
	});

	it('never vouches for a run another engine version made', () => {
		expect(line({ build, engineVersion: '0.0.1' })).toBe('Not recorded for this build');
	});
});
