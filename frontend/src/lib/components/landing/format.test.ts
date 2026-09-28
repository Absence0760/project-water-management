import { afterEach, describe, expect, it } from 'vitest';
import { i18n } from '$lib/i18n/state.svelte';
import { fmt, signed } from './format';

afterEach(() => {
	i18n.locale = 'en';
});

describe('landing numbers', () => {
	it('groups thousands with narrow no-break spaces and follows the language’s decimal mark', () => {
		expect(fmt(5479)).toBe('5\u202f479');
		expect(fmt(41.63, 1)).toBe('41.6');
		i18n.locale = 'af';
		expect(fmt(41.63, 1)).toBe('41,6');
		expect(fmt(1234567.5, 1)).toBe('1\u202f234\u202f567,5');
	});

	it('signs a change, with a real minus', () => {
		expect(signed(4)).toBe('+4');
		expect(signed(-2.5, 1)).toBe('−2.5');
		expect(signed(0)).toBe('0');
	});
});
