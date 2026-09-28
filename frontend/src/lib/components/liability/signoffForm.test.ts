import { describe, expect, it } from 'vitest';
import { scrolledToEnd, shortHash, signoffBlockers, type SignoffFields } from './signoffForm';

const IDS = ['identity', 'competence', 'conflict', 'inputs', 'calibration', 'ewr', 'works', 'assurance', 'plausibility', 'limitations'];
const full: SignoffFields = { fullName: 'Dr A. Hydrologist', registrationBody: 'SACNASP', registrationNo: '400999/20', scope: 'Hydrology of a WULA' };

describe('signoffBlockers', () => {
	it('lets a complete sign-off through', () => {
		expect(signoffBlockers(full, IDS, new Set(IDS), true)).toEqual([]);
	});

	it('needs every statement ticked on its own', () => {
		expect(signoffBlockers(full, IDS, new Set(IDS.slice(0, 8)), true)).toEqual(['Tick each of the 2 statements still open.']);
		expect(signoffBlockers(full, IDS, new Set(IDS.slice(1)), true)).toEqual(['Tick the last statement.']);
		// A tick for something that isn't a statement doesn't count.
		expect(signoffBlockers(full, IDS, new Set([...IDS.slice(1), 'other']), true)).toHaveLength(1);
	});

	it('needs the limitations read to the end', () => {
		expect(signoffBlockers(full, IDS, new Set(IDS), false)).toEqual(['Scroll to the end of the known limitations.']);
	});

	it('names each empty field, ignoring spaces', () => {
		const empty = { fullName: ' ', registrationBody: '', registrationNo: '\n', scope: '' };
		expect(signoffBlockers(empty, IDS, new Set(IDS), true)).toEqual([
			'Fill in your full name, the registration body, your registration number, what the sign-off covers.'
		]);
	});
});

describe('scrolledToEnd', () => {
	it('is true at the bottom (within 2 px) and for a list that does not scroll', () => {
		expect(scrolledToEnd({ scrollTop: 0, clientHeight: 200, scrollHeight: 800 })).toBe(false);
		expect(scrolledToEnd({ scrollTop: 598.5, clientHeight: 200, scrollHeight: 800 })).toBe(true);
		expect(scrolledToEnd({ scrollTop: 0, clientHeight: 200, scrollHeight: 150 })).toBe(true);
	});
});

describe('shortHash', () => {
	it('keeps 12 hex digits', () => {
		expect(shortHash('0123456789abcdef'.repeat(4))).toBe('0123456789ab');
	});
});
