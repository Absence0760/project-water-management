import { describe, expect, it } from 'vitest';
import { FARMER_NOTICE_VERSION, LEGAL_VERSION, legalEffective } from './legal';

describe('legal version', () => {
	it('is a real calendar date', () => {
		expect(LEGAL_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(new Date(`${LEGAL_VERSION}T00:00:00Z`).toISOString().slice(0, 10)).toBe(LEGAL_VERSION);
	});

	it('words the effective line without a leading zero', () => {
		expect(legalEffective('2026-09-27')).toBe('Effective 27 September 2026.');
		expect(legalEffective('2027-01-05')).toBe('Effective 5 January 2027.');
		expect(legalEffective()).toBe(legalEffective(LEGAL_VERSION));
	});

	it('refuses anything that is not YYYY-MM-DD', () => {
		expect(() => legalEffective('27 September 2026')).toThrow();
		expect(() => legalEffective('2026-13-01')).toThrow();
	});
});

describe('farmer notice version', () => {
	it('is a real calendar date', () => {
		expect(new Date(`${FARMER_NOTICE_VERSION}T00:00:00Z`).toISOString().slice(0, 10)).toBe(FARMER_NOTICE_VERSION);
	});
});
