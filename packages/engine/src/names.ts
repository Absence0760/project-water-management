// What a model name may hold (issue #385). A node, crop, borehole or demand
// object name, or a demand schedule window's label, is one line of text: the
// schematic, map labels, tables and report headings draw it as a single line,
// and a line break or other control character there renders broken. The model
// schema refuses them (backend/src/model/validate.ts, validateScenarioOps,
// the frontend's validateModel); the workbook importers and clean-on-read of
// older data turn them into spaces with cleanName.

/**
 * The characters a name may not hold: the C0 controls (tab, line feed and
 * carriage return among them), DEL, the C1 controls (NEL among them) and the
 * Unicode line and paragraph separators (U+2028, U+2029), which break a line
 * as a line feed does.
 */
export const NAME_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** The message the checks give for a name holding one of NAME_CONTROL_CHARS. */
export const NAME_CONTROL_MESSAGE = 'cannot contain line breaks or control characters';

/** Whether `s` holds a character a name may not (NAME_CONTROL_CHARS). */
export const hasNameControlChars = (s: string): boolean => NAME_CONTROL_CHARS.test(s);

const NAME_JUNK_RUN = /[\s\u0000-\u001f\u007f-\u009f]+/g;

/**
 * A name made one line: every run of whitespace and control characters one
 * space, trimmed. What the b023 importers do to a cell (extract_project.py
 * clean(), the browser importer's clean()) and what migration 189 did to the
 * names already stored.
 */
export const cleanName = (s: string): string => s.replace(NAME_JUNK_RUN, ' ').trim();

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);
const cleanField = (o: unknown, key: string): unknown =>
	isObj(o) && typeof o[key] === 'string' ? { ...o, [key]: cleanName(o[key] as string) } : o;
const cleanList = (v: unknown, each: (o: unknown) => unknown): unknown => (Array.isArray(v) ? v.map(each) : v);

/**
 * A model written before names were checked (an older revision being
 * restored, a project document exported before issue #385) with every name
 * and schedule label passed through cleanName, so today's schema accepts it.
 * Anything not shaped like a model is returned as it is, for the schema to
 * refuse; the input is not changed.
 */
export function cleanModelNames<T>(model: T): T {
	if (!isObj(model)) return model;
	const m: Loose = { ...model };
	for (const key of ['nodes', 'crops', 'boreholes'] as const) m[key] = cleanList(m[key], (o) => cleanField(o, 'name'));
	m.demandObjects = cleanList(m.demandObjects, (o) => {
		const d = cleanField(o, 'name');
		return isObj(d) && Array.isArray(d.schedule) ? { ...d, schedule: cleanList(d.schedule, (w) => cleanField(w, 'label')) } : d;
	});
	for (const key of ['nodes', 'crops', 'boreholes', 'demandObjects'] as const) if (!(key in (model as Loose))) delete m[key];
	return m as T;
}
