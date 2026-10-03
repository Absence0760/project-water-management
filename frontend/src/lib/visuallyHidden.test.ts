// Text meant for screen readers only must be hidden on screen: the app's
// class is `.visually-hidden`, and `.sr-only` (used by markup written to the
// common convention, EwrHighFlowsEditor and EwrAssurancePanel) must be the
// same rule. Before it was, their "hidden" captions and cell text showed.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../app.css', import.meta.url), 'utf8');

/** The declarations of the rule whose selector list names `cls`, or null. */
function ruleFor(cls: string): string | null {
	for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
		const selectors = m[1]!.replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((s) => s.trim());
		if (selectors.includes(cls)) return m[2]!;
	}
	return null;
}

describe('visually hidden text', () => {
	it('.sr-only is the same rule as .visually-hidden', () => {
		const vh = ruleFor('.visually-hidden');
		expect(vh).toMatch(/position:\s*absolute/);
		expect(vh).toMatch(/clip:/);
		expect(ruleFor('.sr-only')).toBe(vh);
	});
});
