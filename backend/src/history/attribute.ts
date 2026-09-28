// Who changed each line of a run comparison's input diff (issue #42): the
// model_revision, between the two runs, that set the line's final value.
// Pure, no I/O. docs/run-comparison.md § What changed.
import { THOUSANDS_SEP, type InputChange } from '@water-management/engine';

/** A revision's id and its own change lines (diffInputs from the state before it). */
export interface Attributable {
	id: string;
	changes: InputChange[];
}

const ARROW = ' → ';

/**
 * The words before the first value of a "…: <field> <old> → <new>" line:
 * "Rooikloof: dam capacity ". The subject is skipped before looking for the
 * value, so a digit in a name ("Farm 2") doesn't cut the field off.
 */
function head(text: string, subject: string): string {
	const before = text.slice(0, text.indexOf(ARROW));
	const from = before.startsWith(subject) ? subject.length : 0;
	const at = before.slice(from).search(/[\d"“]/);
	return at < 0 ? before : before.slice(0, from + at);
}

/** The value a "changed" line ends on: what follows its last arrow. */
function tail(text: string): string | null {
	const at = text.lastIndexOf(ARROW);
	return at < 0 ? null : text.slice(at + ARROW.length);
}

/**
 * A revision's stored line with its figures in today's thousands separator: a
 * revision saved before D10 (issue #76) says "750,000 m³", today's diff
 * "750 000 m³" (a narrow no-break space). Only a comma between digits followed by exactly three
 * more is a group, so a list ("Oct, Nov") or a decimal comma is left alone.
 */
const regrouped = (text: string) => text.replace(/(\d),(?=\d{3}(?!\d))/g, `$1${THOUSANDS_SEP}`);

/**
 * Whether revision line `r` set what diff line `l` describes. The same text
 * (an added crop area, say) is the same change. Otherwise a "changed" line
 * matches when it is about the same subject and field (the words before the
 * values) and ends on the same new value: from run A to run B a dam went
 * 600 000 → 750 000 m³, and the revision that made it 750 000 m³ says
 * "650 000 → 750 000 m³".
 */
function sets(rev: InputChange, l: InputChange): boolean {
	const r = { ...rev, text: regrouped(rev.text) };
	if (r.text === l.text) return true;
	if (r.area !== l.area || r.subject !== l.subject || r.kind !== 'changed' || l.kind !== 'changed') return false;
	const t = tail(l.text);
	return t !== null && t === tail(r.text) && head(l.text, l.subject) === head(r.text, r.subject);
}

/**
 * For each line of the diff from an earlier run to a later one of the same
 * project, the id of the newest revision between them whose own lines set
 * it; null when none does. `revisions` is newest first. Series lines are
 * never attributed: a series change isn't a model revision (it is an audit
 * event, in the History tab). Conservative on purpose: a line no revision's
 * wording matches is left unattributed rather than credited to a guess.
 */
export function attributeChanges(lines: readonly InputChange[], revisions: readonly Attributable[]): (string | null)[] {
	return lines.map((l) => {
		if (l.area === 'series') return null;
		return revisions.find((r) => r.changes.some((c) => sets(c, l)))?.id ?? null;
	});
}
