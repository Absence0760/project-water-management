import { describe, expect, it } from 'vitest';
import {
	BLOCKED_CATEGORIES_NOTE,
	CATEGORY_WARNING,
	ECSA_DISCIPLINES,
	REGISTRATION_BODIES,
	REGISTRATION_CATEGORIES,
	registrationCategoriesOf,
	registrationCheck,
	registrationFieldsOf,
	registrationLine,
	SACNASP_FIELDS
} from './registration';

describe('registration lists', () => {
	it('offers SACNASP and ECSA only, each with a register URL', () => {
		expect(REGISTRATION_BODIES.map((b) => b.code)).toEqual(['sacnasp', 'ecsa']);
		for (const b of REGISTRATION_BODIES) expect(b.registerUrl).toMatch(/^https:\/\//);
	});

	it('holds the 26 gazetted SACNASP fields and the 11 ECSA disciplines, with unique codes of the stored shape', () => {
		expect(SACNASP_FIELDS).toHaveLength(26);
		expect(ECSA_DISCIPLINES).toHaveLength(11);
		for (const list of [SACNASP_FIELDS, ECSA_DISCIPLINES, REGISTRATION_CATEGORIES.filter((c) => c.body === 'sacnasp'), REGISTRATION_CATEGORIES.filter((c) => c.body === 'ecsa')]) {
			const codes = list.map((x) => x.code);
			expect(new Set(codes).size).toBe(codes.length);
			// 092_signoff_registration checks this shape.
			for (const c of codes) expect(c).toMatch(/^[a-z_]{1,40}$/);
		}
		expect(registrationFieldsOf('sacnasp')).toBe(SACNASP_FIELDS);
		expect(registrationFieldsOf('ecsa')).toBe(ECSA_DISCIPLINES);
		expect(registrationFieldsOf('other')).toEqual([]);
		expect(registrationCategoriesOf('sacnasp').map((c) => c.code)).toEqual(['pr_sci_nat', 'cand_sci_nat', 'cert_sci_nat']);
	});

	it('explains the blocked categories in a note that cites both Acts', () => {
		expect(BLOCKED_CATEGORIES_NOTE).toMatch(/NSP Act s 22\(2\); Engineering Profession Act s 18\(4\)/);
	});
});

describe('registrationCheck', () => {
	it('is silent for the usual registrations: Pr.Sci.Nat. in Water Resources Science, Pr Eng or Pr Tech Eng in Civil or Agricultural', () => {
		expect(registrationCheck('sacnasp', 'pr_sci_nat', 'water_resources')).toEqual({ warnings: [] });
		for (const c of ['pr_eng', 'pr_tech_eng']) for (const f of ['civil', 'agricultural']) expect(registrationCheck('ecsa', c, f)).toEqual({ warnings: [] });
	});

	it('blocks every candidate, certificated and specified category, whatever the field', () => {
		const blocked = REGISTRATION_CATEGORIES.filter((c) => c.status === 'blocked');
		expect(blocked.map((c) => c.code)).toEqual(['cand_sci_nat', 'cert_sci_nat', 'cand_eng', 'cand_tech_eng', 'cand_techni_eng', 'cand_cert_eng', 'specified']);
		for (const c of blocked) {
			const field = c.body === 'sacnasp' ? 'water_resources' : 'civil';
			const r = registrationCheck(c.body, c.code, field);
			expect(r.block, c.code).toBeTruthy();
			expect(r.invalid).toBeUndefined();
		}
		expect(registrationCheck('sacnasp', 'cand_sci_nat', 'water_resources').block).toBe(
			'A Cand.Sci.Nat. (Candidate Natural Scientist) works under the supervision and control of a professional (Natural Scientific Professions Act, s 22(2)), so a sign-off must be made by the supervising professional. Ask them to sign; confirmation 2 covers work they supervised.'
		);
		expect(registrationCheck('ecsa', 'cand_eng', 'civil').block).toMatch(/^A Candidate Engineer works under .*\(Engineering Profession Act, s 18\(4\)\)/);
		expect(registrationCheck('ecsa', 'specified', 'civil').block).toMatch(/specified category .*s 18\(1\)\(c\)/);
	});

	it('warns, and allows, Pr Techni Eng and Pr Cert Eng', () => {
		for (const c of ['pr_techni_eng', 'pr_cert_eng']) expect(registrationCheck('ecsa', c, 'civil')).toEqual({ warnings: [CATEGORY_WARNING] });
	});

	it('warns on every other field or discipline, naming it and the code of conduct', () => {
		for (const f of SACNASP_FIELDS.filter((x) => x.code !== 'water_resources')) {
			const r = registrationCheck('sacnasp', 'pr_sci_nat', f.code);
			expect(r.warnings).toEqual([expect.stringContaining(`Your field is ${f.label}.`)]);
		}
		expect(registrationCheck('sacnasp', 'pr_sci_nat', 'earth').warnings[0]).toBe(
			'Your field is Earth Science. This statement covers catchment hydrology, which SACNASP places under Water Resources Science. Sign only if this work is within your competence (SACNASP Code of Conduct r 2.3.1).'
		);
		expect(registrationCheck('ecsa', 'pr_eng', 'mining').warnings[0]).toMatch(/^Your discipline is Mining\. .*ECSA Code of Conduct r 3\.1\(b\)/);
		// Both warnings at once: an unusual category in an unusual discipline.
		expect(registrationCheck('ecsa', 'pr_cert_eng', 'mining').warnings).toHaveLength(2);
	});

	it('rejects an unknown body, and a category or field of the other body', () => {
		expect(registrationCheck('saice', 'pr_eng', 'civil').invalid).toMatch(/unknown registration body/);
		expect(registrationCheck('sacnasp', 'pr_eng', 'water_resources').invalid).toMatch(/not one of SACNASP’s registration categories/);
		expect(registrationCheck('ecsa', 'pr_eng', 'water_resources').invalid).toMatch(/not one of ECSA’s disciplines/);
		expect(registrationCheck('sacnasp', 'pr_sci_nat', 'civil').invalid).toMatch(/not one of SACNASP’s fields of practice/);
		expect(registrationCheck('sacnasp', 'pr_sci_nat', 'water_resources').invalid).toBeUndefined();
	});
});

describe('registrationLine', () => {
	it('prints the credential, and nothing for a sign-off without category and field', () => {
		expect(registrationLine('sacnasp', 'pr_sci_nat', 'water_resources', '400123/15')).toBe(
			'Pr.Sci.Nat. (Professional Natural Scientist), SACNASP, Water Resources Science, no. 400123/15'
		);
		expect(registrationLine('ecsa', 'pr_eng', 'civil', '20051234')).toBe('Pr Eng (Professional Engineer), ECSA, Civil, no. 20051234');
		expect(registrationLine('SACNASP', null, null, '400123/15')).toBeNull();
		expect(registrationLine('sacnasp', 'pr_sci_nat', 'gone', '1')).toBeNull();
	});
});
