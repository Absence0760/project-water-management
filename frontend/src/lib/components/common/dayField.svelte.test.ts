// DayInput's rules without a DOM (dayField.svelte.ts): day first or ISO both read, the value stays
// YYYY-MM-DD whatever the time zone (string work, never a Date), the bounds, invalid text kept through
// blur, and the two commit modes. The browser flow: e2e/tests/day-input.spec.ts and the specs of each form.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DayField, dayFieldMessage, dayText, readDay, type DayFieldProps } from './dayField.svelte';

const tz = process.env.TZ;
afterEach(() => {
	process.env.TZ = tz;
});
// The zones furthest either side of UTC: a Date-based reading would move the day in one of them.
const ZONES = ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Africa/Johannesburg'];

describe('readDay', () => {
	it('reads day first and ISO alike, to YYYY-MM-DD, in any time zone', () => {
		for (const zone of ZONES) {
			process.env.TZ = zone;
			for (const text of ['15 Nov 2021', '15 November 2021', '15/11/2021', '15-11-2021', '15.11.2021', '2021-11-15', ' 15  nov 2021 ']) {
				expect(readDay(text), `${zone}: ${text}`).toEqual({ ok: true, value: '2021-11-15' });
			}
			expect(readDay('1/1/2000')).toEqual({ ok: true, value: '2000-01-01' });
			expect(readDay('31 Dec 2024')).toEqual({ ok: true, value: '2024-12-31' });
		}
	});
	it('takes a blank field as none, and refuses what is not a day', () => {
		expect(readDay('')).toEqual({ ok: true, value: '' });
		expect(readDay('   ')).toEqual({ ok: true, value: '' });
		for (const text of ['31/02/2021', '2021-13-01', '12/30/2021', 'soon', '2021-11', '15 Novx 2021']) expect(readDay(text), text).toEqual({ ok: false });
	});
	it('keeps to the bounds, the bounds themselves included', () => {
		const b = { min: '2021-10-01', max: '2022-09-30' };
		expect(readDay('1 Oct 2021', b)).toEqual({ ok: true, value: '2021-10-01' });
		expect(readDay('30/09/2022', b)).toEqual({ ok: true, value: '2022-09-30' });
		expect(readDay('30 Sep 2021', b)).toEqual({ ok: false });
		expect(readDay('2022-10-01', b)).toEqual({ ok: false });
		expect(readDay('', b)).toEqual({ ok: true, value: '' });
	});
});

describe('dayFieldMessage and dayText', () => {
	it('says how to fix the field, from its bounds, day first', () => {
		expect(dayFieldMessage({})).toBe('Enter a day, day first: 15 Nov 2021, 15/11/2021 or 2021-11-15');
		expect(dayFieldMessage({ min: '1981-01-01', max: '2024-12-31' })).toBe('Enter a day from 1 Jan 1981 to 31 Dec 2024, day first: 15 Nov 2021, 15/11/2021 or 2021-11-15');
		expect(dayFieldMessage({ min: '1981-01-01' })).toBe('Enter a day on or after 1 Jan 1981, day first: 15 Nov 2021, 15/11/2021 or 2021-11-15');
		expect(dayFieldMessage({ max: '2026-10-11' })).toBe('Enter a day on or before 11 Oct 2026, day first: 15 Nov 2021, 15/11/2021 or 2021-11-15');
	});
	it('shows a stored day day first, in any time zone, and none as blank', () => {
		for (const zone of ZONES) {
			process.env.TZ = zone;
			expect(dayText('2021-11-15')).toBe('15 Nov 2021');
			expect(dayText('2024-01-01')).toBe('1 Jan 2024');
		}
		expect(dayText('')).toBe('');
		expect(dayText(null)).toBe('');
		expect(dayText(undefined)).toBe('');
	});
});

function make(init: Partial<DayFieldProps> = {}) {
	const props: DayFieldProps = { value: '', commit: 'input', ...init };
	const store = vi.fn((v: string) => (props.value = v));
	const field = new DayField(() => props, store);
	return { props, store, field };
}

describe('DayField', () => {
	it('stores each keystroke that reads as a day, and shows it back day first on blur', () => {
		process.env.TZ = 'Pacific/Kiritimati';
		const { field, store, props } = make({ value: '2021-10-01' });
		expect(field.text).toBe('1 Oct 2021');
		field.focus();
		field.input('15/11/202');
		expect(field.invalid).toBe(true);
		expect(store).not.toHaveBeenCalled();
		field.input('15/11/2021');
		expect(field.invalid).toBe(false);
		expect(store).toHaveBeenLastCalledWith('2021-11-15');
		expect(props.value).toBe('2021-11-15');
		expect(field.text).toBe('15/11/2021');
		field.blur();
		expect(field.text).toBe('15 Nov 2021');
	});
	it('keeps text it cannot take through blur, invalid, and stores nothing', () => {
		const { field, store } = make({ value: '2021-10-01', max: '2021-12-31' });
		field.focus();
		field.input('2022-01-05');
		field.blur();
		expect(field.invalid).toBe(true);
		expect(field.text).toBe('2022-01-05');
		expect(store).not.toHaveBeenCalled();
	});
	it('stores a cleared field as blank', () => {
		const { field, store } = make({ value: '2021-10-01' });
		field.focus();
		field.input('');
		expect(store).toHaveBeenLastCalledWith('');
		expect(field.invalid).toBe(false);
	});
	it('stores nothing when the day typed is the day stored', () => {
		const { field, store } = make({ value: '2021-11-15' });
		field.focus();
		field.input('15 Nov 2021');
		field.blur();
		expect(store).not.toHaveBeenCalled();
	});
	it('a change field stores once typing ends (blur or Enter), not on each keystroke', () => {
		const { field, store } = make({ value: '2021-10-01', commit: 'change' });
		field.focus();
		field.input('2021-11-1');
		field.input('2021-11-15');
		expect(store).not.toHaveBeenCalled();
		field.change();
		expect(store).toHaveBeenCalledTimes(1);
		expect(store).toHaveBeenLastCalledWith('2021-11-15');
		expect(field.text).toBe('15 Nov 2021');
	});
	it('follows an outside change unless the user is typing, and reset puts the stored day back', () => {
		const { field, props } = make({ value: '2021-10-01' });
		field.focus();
		field.input('nonsense');
		props.value = '2022-02-02';
		field.follow();
		expect(field.text).toBe('nonsense');
		field.blur();
		field.follow();
		expect(field.text).toBe('2 Feb 2022');
		expect(field.invalid).toBe(false);
		field.input('nope');
		field.reset();
		expect(field.text).toBe('2 Feb 2022');
		expect(field.invalid).toBe(false);
	});
});
