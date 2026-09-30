import { describe, expect, it } from 'vitest';
import { PACK_SIGNER_PUBLIC, registrationAdvice, scrolledToEnd, shortHash, signoffBlockers, statementEngines, type SignoffFields } from './signoffForm';

const IDS = ['identity', 'competence', 'conflict', 'inputs', 'calibration', 'ewr', 'works', 'assurance', 'plausibility', 'limitations'];
const full: SignoffFields = {
	fullName: 'Dr A. Hydrologist',
	registrationBody: 'sacnasp',
	registrationCategory: 'pr_sci_nat',
	registrationField: 'water_resources',
	registrationNo: '400999/20',
	scope: 'Hydrology of a WULA'
};

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
		const empty = { fullName: ' ', registrationBody: '', registrationCategory: '', registrationField: '', registrationNo: '\n', scope: '' };
		expect(signoffBlockers(empty, IDS, new Set(IDS), true)).toEqual([
			'Fill in your full name, the registration body, your registration category, your field of practice, your registration number, what the sign-off covers.'
		]);
		// ECSA calls it a discipline.
		expect(signoffBlockers({ ...full, registrationBody: 'ecsa', registrationCategory: 'pr_eng', registrationField: '' }, IDS, new Set(IDS), true)).toEqual([
			'Fill in your discipline.'
		]);
	});

	it('refuses a blocked category with the reason, and a category or field left over from the other body', () => {
		expect(signoffBlockers({ ...full, registrationCategory: 'cand_sci_nat' }, IDS, new Set(IDS), true)).toEqual([
			'A Cand.Sci.Nat. (Candidate Natural Scientist) works under the supervision and control of a professional (Natural Scientific Professions Act, s 22(2)), so a sign-off must be made by the supervising professional. Ask them to sign; confirmation 2 covers work they supervised.'
		]);
		expect(signoffBlockers({ ...full, registrationBody: 'ecsa' }, IDS, new Set(IDS), true)).toEqual([expect.stringMatching(/not one of ECSA’s registration categories/)]);
	});
});

describe('registrationAdvice', () => {
	it('says nothing for Pr.Sci.Nat. in Water Resources Science, or before both are chosen', () => {
		expect(registrationAdvice(full)).toEqual({ warnings: [] });
		expect(registrationAdvice({ ...full, registrationField: '' })).toEqual({ warnings: [] });
		expect(registrationAdvice({ ...full, registrationCategory: '' })).toEqual({ warnings: [] });
	});

	it('blocks a candidate as soon as the category is picked, before a field', () => {
		expect(registrationAdvice({ registrationBody: 'ecsa', registrationCategory: 'cand_eng', registrationField: '' }).block).toMatch(/^A Candidate Engineer works under/);
	});

	it('warns, without blocking, on an unusual category and field', () => {
		const r = registrationAdvice({ registrationBody: 'ecsa', registrationCategory: 'pr_techni_eng', registrationField: 'mining' });
		expect(r.block).toBeUndefined();
		expect(r.warnings).toEqual([expect.stringMatching(/^Check that this assessment is within the work your category covers\./), expect.stringMatching(/^Your discipline is Mining\./)]);
		expect(registrationAdvice({ ...full, registrationField: 'earth' }).warnings).toEqual([expect.stringMatching(/^Your field is Earth Science\./)]);
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

describe('statementEngines (a run’s statement, or a pack’s two runs)', () => {
	it('names one engine for a run, and for a pack whose runs share it', () => {
		expect(statementEngines({ engineVersion: '1.33.0' })).toBe('1.33.0');
		expect(statementEngines({ baseline: { engineVersion: '1.33.0' }, application: null })).toBe('1.33.0');
		expect(statementEngines({ baseline: { engineVersion: '1.33.0' }, application: { engineVersion: '1.33.0' } })).toBe('1.33.0');
	});

	it('names both, each with its run, when a pack’s runs were made with different engines', () => {
		expect(statementEngines({ baseline: { engineVersion: '1.32.0' }, application: { engineVersion: '1.33.0' } })).toBe('1.32.0 (baseline) and 1.33.0 (application)');
	});

	it('tells a pack’s signer, before signing, that what they sign with is public on the verify page', () => {
		for (const what of ['full name', 'registration', 'publicly', 'verify page', 'even if it is withdrawn']) expect(PACK_SIGNER_PUBLIC).toContain(what);
	});
});
