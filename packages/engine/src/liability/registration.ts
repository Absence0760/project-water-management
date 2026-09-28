// The signer's statutory registration on a professional sign-off (issue #47):
// the body, the category and the field of practice (SACNASP) or discipline
// (ECSA), as fixed choices, with the rules for which may sign. One source for
// the dialog, the route and the report. Pure.
//
// Why these lists and rules (pre-counsel research, 2026-09-28):
// - Both statutes register a person in a category, and SACNASP also in a
//   field of practice (Natural Scientific Professions Act 27 of 2003 s 18(1),
//   s 20(2)(a); Engineering Profession Act 46 of 2000 s 18(1)).
// - Candidates and certificated natural scientists work "only under the
//   supervision and control of" a professional (NSP Act s 22(2)(a);
//   Engineering Profession Act s 18(4)), so they can't sign independently:
//   blocked. ECSA's specified categories (lift inspectors, medical equipment)
//   are unrelated work: blocked.
// - No statute reserves catchment hydrology to one field or discipline, so an
//   unusual field only warns; competence stays the signer's own declaration.
//
// The allowed values live here, not in the database (092_signoff_registration
// checks only their shape), so a re-prescribed category list (the draft
// Natural Scientific Professions Bill, GG 54325, 2026) is a code change. Codes
// are stored; never rename one, add a new one.

export type RegistrationBodyCode = 'sacnasp' | 'ecsa';

/** What a choice allows: sign, sign after a warning, or not sign at all. */
export type RegistrationStatus = 'allowed' | 'warn' | 'blocked';

export interface RegistrationBody {
	code: RegistrationBodyCode;
	/** The body's name in full, for the dialog. */
	label: string;
	/** The name printed in a credential line. */
	short: string;
	/** Where a reader checks a registration, printed as a visible URL on the report. */
	registerUrl: string;
	registerName: string;
	/** An example number for the dialog's placeholder (unverified formats: an example only). */
	numberExample: string;
	/** What this body calls a field: SACNASP's field of practice, ECSA's discipline. */
	fieldName: string;
}

export interface RegistrationCategory {
	code: string;
	body: RegistrationBodyCode;
	/** Printed on the report, e.g. "Pr.Sci.Nat. (Professional Natural Scientist)". */
	label: string;
	status: RegistrationStatus;
	/** The provision that limits a blocked category. */
	law?: string;
}

export interface RegistrationField {
	code: string;
	label: string;
	/** No field blocks (the law reserves this work to none); an unusual one warns. */
	status: Exclude<RegistrationStatus, 'blocked'>;
}

export const REGISTRATION_BODIES: readonly RegistrationBody[] = [
	{
		code: 'sacnasp',
		label: 'SACNASP (South African Council for Natural Scientific Professions)',
		short: 'SACNASP',
		registerUrl: 'https://www.sacnasp.org.za/scientists',
		registerName: 'the SACNASP database of registered scientists',
		numberExample: '400123/15',
		fieldName: 'Field of practice'
	},
	{
		code: 'ecsa',
		label: 'ECSA (Engineering Council of South Africa)',
		short: 'ECSA',
		registerUrl: 'https://findregisteredpersonprod.powerappsportals.com/Who-is-Registered/',
		registerName: 'ECSA “Find a Registered Person”',
		numberExample: '20051234',
		fieldName: 'Discipline'
	}
];

const NSP = 'Natural Scientific Professions Act, s 22(2)';
const EPA = 'Engineering Profession Act, s 18(4)';

/** NSP Act s 18(1), s 22 (SACNASP); Engineering Profession Act s 18(1) (ECSA). */
export const REGISTRATION_CATEGORIES: readonly RegistrationCategory[] = [
	{ code: 'pr_sci_nat', body: 'sacnasp', label: 'Pr.Sci.Nat. (Professional Natural Scientist)', status: 'allowed' },
	{ code: 'cand_sci_nat', body: 'sacnasp', label: 'Cand.Sci.Nat. (Candidate Natural Scientist)', status: 'blocked', law: NSP },
	{ code: 'cert_sci_nat', body: 'sacnasp', label: 'Cert.Sci.Nat. (Certificated Natural Scientist)', status: 'blocked', law: NSP },
	{ code: 'pr_eng', body: 'ecsa', label: 'Pr Eng (Professional Engineer)', status: 'allowed' },
	{ code: 'pr_tech_eng', body: 'ecsa', label: 'Pr Tech Eng (Professional Engineering Technologist)', status: 'allowed' },
	{ code: 'pr_techni_eng', body: 'ecsa', label: 'Pr Techni Eng (Professional Engineering Technician)', status: 'warn' },
	{ code: 'pr_cert_eng', body: 'ecsa', label: 'Pr Cert Eng (Professional Certificated Engineer)', status: 'warn' },
	{ code: 'cand_eng', body: 'ecsa', label: 'Candidate Engineer', status: 'blocked', law: EPA },
	{ code: 'cand_tech_eng', body: 'ecsa', label: 'Candidate Engineering Technologist', status: 'blocked', law: EPA },
	{ code: 'cand_techni_eng', body: 'ecsa', label: 'Candidate Engineering Technician', status: 'blocked', law: EPA },
	{ code: 'cand_cert_eng', body: 'ecsa', label: 'Candidate Certificated Engineer', status: 'blocked', law: EPA },
	{ code: 'specified', body: 'ecsa', label: 'Specified category (e.g. Lift Inspector)', status: 'blocked', law: 'Engineering Profession Act, s 18(1)(c)' }
];

const w = (code: string, label: string): RegistrationField => ({ code, label, status: 'warn' });

/** Schedule I of the NSP Act as substituted by GN 469 of 2021 (GG 44981): the 26 fields, as gazetted. */
export const SACNASP_FIELDS: readonly RegistrationField[] = [
	{ code: 'water_resources', label: 'Water Resources Science', status: 'allowed' },
	w('earth', 'Earth Science'),
	w('geological', 'Geological Science'),
	w('environmental', 'Environmental Science'),
	w('agricultural', 'Agricultural Science'),
	w('atmospheric', 'Atmospheric Science'),
	w('aquatic', 'Aquatic Science'),
	w('ecological', 'Ecological Science'),
	w('soil', 'Soil Science'),
	w('animal', 'Animal Science'),
	w('biological', 'Biological Science'),
	w('botanical', 'Botanical Science'),
	w('chemical', 'Chemical Science'),
	w('conservation', 'Conservation Science'),
	w('extension', 'Extension Science'),
	w('food', 'Food Science'),
	w('geospatial', 'Geospatial Science'),
	w('materials', 'Materials Science'),
	w('mathematical', 'Mathematical Science'),
	w('microbiological', 'Microbiological Science'),
	w('physical', 'Physical Science'),
	w('specified', 'Specified Science'),
	w('statistical', 'Statistical Science'),
	w('toxicological', 'Toxicological Science'),
	w('zoological', 'Zoological Science'),
	w('measurement', 'Measurement Science')
];

/** The engineering disciplines of ECSA's Identification of Engineering Work Rules (BN 892 of 2026). */
export const ECSA_DISCIPLINES: readonly RegistrationField[] = [
	{ code: 'civil', label: 'Civil', status: 'allowed' },
	{ code: 'agricultural', label: 'Agricultural', status: 'allowed' },
	w('aeronautical', 'Aeronautical'),
	w('chemical', 'Chemical'),
	w('computer', 'Computer'),
	w('electrical', 'Electrical or Electronic'),
	w('industrial', 'Industrial'),
	w('mechanical', 'Mechanical'),
	w('mechatronic', 'Mechatronic'),
	w('metallurgical', 'Metallurgical'),
	w('mining', 'Mining')
];

export const registrationBody = (code: string): RegistrationBody | undefined => REGISTRATION_BODIES.find((b) => b.code === code);

/** The categories a body registers, in the dialog's order. */
export const registrationCategoriesOf = (body: string): readonly RegistrationCategory[] => REGISTRATION_CATEGORIES.filter((c) => c.body === body);

/** The fields (SACNASP) or disciplines (ECSA) a body registers. */
export const registrationFieldsOf = (body: string): readonly RegistrationField[] => (body === 'sacnasp' ? SACNASP_FIELDS : body === 'ecsa' ? ECSA_DISCIPLINES : []);

export const registrationCategory = (body: string, code: string): RegistrationCategory | undefined => registrationCategoriesOf(body).find((c) => c.code === code);
export const registrationField = (body: string, code: string): RegistrationField | undefined => registrationFieldsOf(body).find((f) => f.code === code);

/** Shown in the dialog under the category list: why the blocked categories can't be chosen. */
export const BLOCKED_CATEGORIES_NOTE =
	'Candidates and certificated scientists work under a professional’s supervision (NSP Act s 22(2); Engineering Profession Act s 18(4)), so their supervising professional signs.';

/** Why a blocked category can't sign (the route's 400, and the dialog). */
export function blockMessage(c: RegistrationCategory): string {
	if (c.code === 'specified')
		return `A registration in a specified category (such as Lift Inspector) covers work unrelated to catchment hydrology (${c.law}), so it cannot sign this off. Ask a registered professional to sign.`;
	return `A ${c.label} works under the supervision and control of a professional (${c.law}), so a sign-off must be made by the supervising professional. Ask them to sign; confirmation 2 covers work they supervised.`;
}

/** Pr Techni Eng and Pr Cert Eng. */
export const CATEGORY_WARNING =
	'Check that this assessment is within the work your category covers. ECSA’s rules place technicians on well-defined problems, and certificated engineers on mines and factories.';

/** A field of practice or discipline outside the usual one for catchment hydrology. */
export function fieldWarning(body: RegistrationBodyCode, f: RegistrationField): string {
	return body === 'sacnasp'
		? `Your field is ${f.label}. This statement covers catchment hydrology, which SACNASP places under Water Resources Science. Sign only if this work is within your competence (SACNASP Code of Conduct r 2.3.1).`
		: `Your discipline is ${f.label}. This statement covers catchment hydrology, which ECSA’s rules place under Civil engineering (water resources and supply). Sign only if this work is within your competence (ECSA Code of Conduct r 3.1(b)).`;
}

export interface RegistrationCheck {
	/** A choice that isn't on the lists, or a category or field of the other body. */
	invalid?: string;
	/** A category that can't sign (a candidate, certificated or specified category). */
	block?: string;
	/** Things the signer should weigh; a sign-off is still allowed. */
	warnings: string[];
}

/** Whether this registration may sign, and what it should be warned of. */
export function registrationCheck(body: string, category: string, field: string): RegistrationCheck {
	const b = registrationBody(body);
	if (!b) return { invalid: `unknown registration body: ${body}`, warnings: [] };
	const c = registrationCategory(body, category);
	if (!c) return { invalid: `${category} is not one of ${b.short}’s registration categories`, warnings: [] };
	const f = registrationField(body, field);
	if (!f) return { invalid: `${field} is not one of ${b.short}’s ${b.code === 'sacnasp' ? 'fields of practice' : 'disciplines'}`, warnings: [] };
	if (c.status === 'blocked') return { block: blockMessage(c), warnings: [] };
	const warnings: string[] = [];
	if (c.status === 'warn') warnings.push(CATEGORY_WARNING);
	if (f.status === 'warn') warnings.push(fieldWarning(b.code, f));
	return { warnings };
}

/**
 * The credential as the report prints it: "Pr.Sci.Nat. (Professional Natural
 * Scientist), SACNASP, Water Resources Science, no. 400123/15". Null for a
 * sign-off made before category and field were recorded (signoff-1 and -2),
 * or with codes these lists no longer hold.
 */
export function registrationLine(body: string, category: string | null, field: string | null, no: string): string | null {
	const b = registrationBody(body);
	const c = category === null ? undefined : registrationCategory(body, category);
	const f = field === null ? undefined : registrationField(body, field);
	if (!b || !c || !f) return null;
	return `${c.label}, ${b.short}, ${f.label}, no. ${no}`;
}
