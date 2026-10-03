// NumberInput's markup, rendered with Svelte's server renderer: every field a
// text box with the decimal keypad (so 12,5 reads the same in every mode), a
// plain field a spinbutton with its bounds, a grouped one a textbox, and the
// caller's aria-describedby and aria-invalid kept. What it does as the user
// types and leaves (the message, invalid text kept through blur) is
// numberField.svelte.test.ts, since no test here has a DOM; the browser flow
// is e2e/tests/node-table.spec.ts.
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import NumberInput from './NumberInput.svelte';

const input = (props: Record<string, unknown>) => {
	const html = render(NumberInput, { props: props as never }).body;
	const tag = html.match(/<input[^>]*>/)?.[0] ?? '';
	return { html, tag };
};

describe('NumberInput markup', () => {
	it('a plain field is a text spinbutton with the decimal keypad and its bounds', () => {
		const { tag } = input({ value: 0.5, scale: 100, min: 0, max: 99.9, label: 'Losses on the way, %' });
		expect(tag).toContain('type="text"');
		expect(tag).toContain('inputmode="decimal"');
		expect(tag).toContain('role="spinbutton"');
		expect(tag).toContain('aria-valuemin="0"');
		expect(tag).toContain('aria-valuemax="99.9"');
		expect(tag).toContain('aria-valuenow="50"');
		expect(tag).toContain('value="50"');
		expect(tag).toContain('aria-label="Losses on the way, %"');
		expect(tag).not.toContain('aria-invalid');
	});

	it('a grouped field is a textbox showing separators', () => {
		const { tag } = input({ value: 300000, grouped: true, min: 0 });
		expect(tag).toContain('type="text"');
		expect(tag).not.toContain('role=');
		expect(tag).toContain('value="300 000"');
	});

	it('keeps the caller’s aria-describedby and aria-invalid, and shows no message while valid', () => {
		const { html, tag } = input({ value: 3, id: 'area', 'aria-describedby': 'area-h', 'aria-invalid': 'true' });
		expect(tag).toContain('id="area"');
		expect(tag).toContain('aria-describedby="area-h"');
		expect(tag).toContain('aria-invalid="true"');
		expect(html).not.toContain('num-err');
	});

	it('a read-only field stays focusable (readonly, not disabled)', () => {
		const { tag } = input({ value: 1, disabled: true });
		expect(tag).toContain('readonly');
		expect(tag).not.toMatch(/\sdisabled/);
	});
});
