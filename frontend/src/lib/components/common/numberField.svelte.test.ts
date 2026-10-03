// NumberInput's rules without a DOM (numberField.svelte.ts): the same reading
// in every mode (a decimal comma in a % or month field, not only a grouped
// volume), the message built from the bounds, invalid text kept through blur
// rather than put back, a nullable field storing null when cleared, and the
// arrow keys' step. The markup (aria-describedby, the spinbutton) is
// NumberInput.test.ts; the browser flow e2e/tests/node-table.spec.ts.
import { describe, expect, it, vi } from 'vitest';
import { NumberField, numberFieldMessage, readField, readNumber, stepText, type NumberFieldProps } from './numberField.svelte';

describe('readNumber', () => {
	it('reads a decimal comma, a grouping comma and spaces', () => {
		expect(readNumber('12,5')).toBe(12.5);
		expect(readNumber('0,125')).toBe(0.125);
		expect(readNumber('-0,5')).toBe(-0.5);
		expect(readNumber('1,500')).toBe(1500);
		expect(readNumber('300 000')).toBe(300000);
		expect(readNumber('300 000,5')).toBe(300000.5);
		expect(readNumber('12.5')).toBe(12.5);
	});
	it('refuses text that is not a number', () => {
		expect(readNumber('abc')).toBeNull();
		expect(readNumber('1,2,3')).toBeNull();
		expect(readNumber('12,5,')).toBeNull();
		expect(readNumber('')).toBeNull();
	});
});

describe('readField', () => {
	it('checks the bounds in displayed units', () => {
		expect(readField('99.9', { min: 0, max: 99.9 })).toEqual({ ok: true, value: 99.9 });
		expect(readField('120', { min: 0, max: 99.9 })).toEqual({ ok: false });
		expect(readField('-1', { min: 0 })).toEqual({ ok: false });
	});
	it('takes a blank as null only when nullable', () => {
		expect(readField('', { nullable: true })).toEqual({ ok: true, value: null });
		expect(readField('  ', { nullable: true })).toEqual({ ok: true, value: null });
		expect(readField('', {})).toEqual({ ok: false });
	});
});

describe('numberFieldMessage', () => {
	it('names the range the field takes', () => {
		expect(numberFieldMessage({ min: 0, max: 99.9 })).toBe('Enter a number from 0 to 99.9');
		expect(numberFieldMessage({ min: 0 })).toBe('Enter 0 or more');
		expect(numberFieldMessage({ max: 100 })).toBe('Enter 100 or less');
		expect(numberFieldMessage({})).toBe('Enter a number');
		expect(numberFieldMessage({ nullable: true })).toBe('Enter a number, or leave it blank for none');
		expect(numberFieldMessage({ min: 1800, max: 2200, nullable: true })).toBe('Enter a number from 1 800 to 2 200, or leave it blank for none');
	});
});

describe('stepText', () => {
	it('steps from the text, or the stored value, within the bounds', () => {
		expect(stepText('5', 1, 'any', null, {})).toBe('6');
		expect(stepText('0.3', 1, 0.1, null, {})).toBe('0.4');
		expect(stepText('abc', -1, 1, 7, {})).toBe('6');
		expect(stepText('', 1, 1, null, { min: 2 })).toBe('3');
		expect(stepText('100', 1, 1, null, { max: 100 })).toBe('100');
		expect(stepText('0', -1, 1, null, { min: 0 })).toBe('0');
	});
});

function makeField(over: Partial<NumberFieldProps> = {}) {
	const props: NumberFieldProps = $state({ value: 0.5, scale: 100, grouped: false, disabled: false, step: 'any', min: 0, max: 99.9, ...over });
	const commit = vi.fn((v: number | null) => {
		props.value = v;
	});
	const field = new NumberField(() => props, commit);
	return { props, commit, field };
}

describe('NumberField', () => {
	it('stores a decimal comma in a % field, divided by the scale', () => {
		const { field, commit } = makeField();
		field.focus();
		field.input('12,5');
		expect(field.invalid).toBe(false);
		expect(commit).toHaveBeenLastCalledWith(0.125);
	});

	it('keeps out-of-range text, invalid, through blur and stores nothing', () => {
		const { field, commit, props } = makeField();
		field.focus();
		field.input('120');
		field.blur();
		expect(field.invalid).toBe(true);
		expect(field.text).toBe('120');
		expect(commit).not.toHaveBeenCalled();
		expect(props.value).toBe(0.5);
	});

	it('keeps a cleared non-nullable field blank and invalid, the value unchanged', () => {
		const { field, commit } = makeField();
		field.focus();
		field.input('');
		field.blur();
		expect(field.invalid).toBe(true);
		expect(field.text).toBe('');
		expect(commit).not.toHaveBeenCalled();
	});

	it('stores null when a nullable field is cleared', () => {
		const { field, commit } = makeField({ nullable: true, value: 20, scale: 1, min: 0, max: undefined });
		field.focus();
		field.input('');
		field.blur();
		expect(commit).toHaveBeenLastCalledWith(null);
		expect(field.invalid).toBe(false);
		expect(field.text).toBe('');
	});

	it('follows a value changed from outside over invalid text, but not while typing', () => {
		const { field, props } = makeField();
		field.focus();
		field.input('abc');
		props.value = 0.25;
		field.follow();
		expect(field.text).toBe('abc');
		field.blur();
		field.follow();
		expect(field.text).toBe('25');
		expect(field.invalid).toBe(false);
	});

	it('reset puts invalid text back to the stored value', () => {
		const { field } = makeField();
		field.input('120');
		field.blur();
		field.reset();
		expect(field.text).toBe('50');
		expect(field.invalid).toBe(false);
	});

	it('a grouped field shows separators at rest and the plain number while editing', () => {
		const { field } = makeField({ value: 300000, scale: 1, grouped: true, min: 0, max: undefined });
		expect(field.text).toBe('300 000');
		field.focus();
		expect(field.text).toBe('300000');
		field.input('1 500,5');
		field.blur();
		expect(field.text).toBe('1 500.5');
	});

	it('steps a plain field with the arrow keys, never a grouped or read-only one', () => {
		const { field, commit } = makeField({ step: 1 });
		expect(field.step(1)).toBe(true);
		expect(commit).toHaveBeenLastCalledWith(0.51);
		expect(makeField({ grouped: true }).field.step(1)).toBe(false);
		expect(makeField({ disabled: true }).field.step(1)).toBe(false);
	});
});
