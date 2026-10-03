// The scoping of the invalid-fields registry (invalidFields.svelte.ts): a
// field registers with the nearest owner above it (the workspace page, a
// scenario's override mode inside it), else with the default. So a number typed
// in override mode counts against its Record, never the page's save bar. The
// browser flow is e2e/tests/scenarios.spec.ts.
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import Owner from './__fixtures__/InvalidFieldsOwner.svelte';
import { InvalidFields, invalidFields } from './invalidFields.svelte';

function found(owners: InvalidFields[]): InvalidFields | null {
	let got: InvalidFields | null = null;
	// The renderer runs on reading the body.
	void render(Owner, { props: { owners, onfound: (f: InvalidFields) => (got = f) } }).body;
	return got;
}

describe('invalidFields scoping', () => {
	it('a field with no owner above it uses the default registry', () => {
		expect(found([])).toBe(invalidFields);
	});

	it('a field uses its owner’s registry, not the default', () => {
		const page = new InvalidFields();
		expect(found([page])).toBe(page);
	});

	it('a nested owner (override mode inside the page) wins over the outer one', () => {
		const page = new InvalidFields();
		const override = new InvalidFields();
		expect(found([page, override])).toBe(override);
	});

	it('the registries are separate: a field in one never counts in another', () => {
		const page = new InvalidFields();
		const override = new InvalidFields();
		override.set('a', { id: 'loss', label: 'Losses on the way, %', message: 'Enter a number from 0 to 99.9' });
		expect(override.count).toBe(1);
		expect(page.count).toBe(0);
		expect(invalidFields.count).toBe(0);
		override.delete('a');
	});
});
