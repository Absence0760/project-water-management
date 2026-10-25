// DayInput's markup, rendered with Svelte's server renderer: a text box (never type="date") showing the
// stored YYYY-MM-DD day first, the example placeholder ("e.g. 15 Nov 2021", or the caller's), readonly, and the caller's aria-describedby and
// aria-invalid kept. What it does as the user types is dayField.svelte.test.ts; the browser flow is
// e2e/tests/day-input.spec.ts.
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import DayInput from './DayInput.svelte';

const input = (props: Record<string, unknown>) => {
	const html = render(DayInput, { props: props as never }).body;
	return { html, tag: html.match(/<input[^>]*>/)?.[0] ?? '' };
};

describe('DayInput markup', () => {
	it('is a text box showing the stored day day first', () => {
		const { tag, html } = input({ value: '2021-11-15', id: 'from' });
		expect(tag).toContain('type="text"');
		expect(tag).not.toContain('type="date"');
		expect(tag).toContain('value="15 Nov 2021"');
		expect(tag).toContain('placeholder="e.g. 15 Nov 2021"');
		expect(tag).toContain('id="from"');
		expect(tag).toContain('autocomplete="off"');
		expect(tag).not.toContain('aria-invalid');
		expect(html).not.toContain('num-err');
	});

	it('marks its default placeholder as an example, so a blank field never reads as holding that day, and takes the caller’s', () => {
		// A bare "15 Nov 2021" in a blank Simulation start and end read as a stored period.
		expect(input({ value: '' }).tag).toMatch(/placeholder="e\.g\. /);
		expect(input({ value: null, placeholder: 'First day with rain' }).tag).toContain('placeholder="First day with rain"');
	});

	it('shows none as blank, and passes readonly, required, a label and the caller’s description', () => {
		const { tag } = input({ value: null, readonly: true, required: true, label: 'Valid from', 'aria-describedby': 'h', 'aria-invalid': 'true' });
		expect(tag).toContain('value=""');
		expect(tag).toContain('readonly');
		expect(tag).toContain('required');
		expect(tag).toContain('aria-label="Valid from"');
		expect(tag).toContain('aria-describedby="h"');
		expect(tag).toContain('aria-invalid="true"');
	});
});
