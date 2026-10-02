// Notes and comments (WP-2.7; docs/ui.md § Notes): what a notes drawer is
// about, the query and create body for it, its count badge, and the words
// for a note's target. Pure, so the rules are unit-tested.
import { NOTE_MAX, type Note, type NoteCounts, type NoteCreate, type NotesQuery, type NoteVisibility } from '$lib/api/types';
import { NOTES_EN, type NotesWords } from './words';

/** What a drawer or list holds notes about. */
export type NoteTarget =
	| { kind: 'project' }
	| { kind: 'node'; nodeId: string; name: string; isFarm: boolean }
	| { kind: 'run'; runId: string; label: string }
	| { kind: 'setting'; key: string; label: string }
	/**
	 * A scenario's comments (WP-3.15): `audiences` are the visibilities the
	 * caller may post with (the server holds the rule, 115_scenario_share_notes),
	 * the first being the default.
	 */
	| { kind: 'scenario'; scenarioId: string; name: string; audiences: NoteVisibility[] }
	/**
	 * An evidence pack's notes and public comments (128_pack_share_notes):
	 * `team`, or `public_participation` while it has a live share link (the
	 * server holds the rule); the first audience is the default.
	 */
	| { kind: 'pack'; packId: string; name: string; audiences: NoteVisibility[] };

/** Who reads a scenario note, in the drawer's words (docs/data-model.md § Notes has the matrix). */
export const AUDIENCE_LABEL: Record<NoteVisibility, string> = {
	team: 'The project team',
	farm: 'The team and its farmers',
	assessors: 'The assessors only',
	parties: 'The assessors and the applicant’s party',
	public_participation: 'Public participation: shown with your name on the shared link'
};

/** A note's audience as a short badge on the note. */
export const AUDIENCE_BADGE: Record<NoteVisibility, string> = {
	team: 'Team',
	farm: 'Shown to its farmers',
	assessors: 'Assessors',
	parties: 'Parties',
	public_participation: 'Public'
};

/**
 * The audiences a caller may post with on a scenario, their natural one
 * first (the server's scenarioVisibility default): an assessor writes to the
 * assessors; one of the application's parties to the parties; anyone else
 * takes part in public participation only.
 */
export function scenarioAudiences(who: { assessor: boolean; party: boolean }): NoteVisibility[] {
	if (who.assessor) return ['assessors', 'parties', 'public_participation', 'team'];
	if (who.party) return ['parties', 'assessors', 'public_participation'];
	return ['public_participation'];
}

/**
 * The audiences an editor or viewer of a pack may post with: the team first;
 * public participation too while the pack is issued (the server refuses it
 * when no share link is live, and says so).
 */
export function packAudiences(issued: boolean): NoteVisibility[] {
	return issued ? ['team', 'public_participation'] : ['team'];
}

/** Whether a target's notes pick an audience and keep their edits (a scenario's or a pack's). */
export const hasAudiences = (t: NoteTarget): t is Extract<NoteTarget, { kind: 'scenario' | 'pack' }> => t.kind === 'scenario' || t.kind === 'pack';

/**
 * The settings groups that take notes, keyed as the note's setting_key (a
 * group; a later per-parameter key such as `flow.a` would still count
 * under its group, since GET /notes?settingKey=flow matches `flow.*`).
 */
export const SETTING_NOTE_GROUPS = {
	demand: 'Demand',
	flow: 'Flow calibration',
	rain: 'Rain gaps and CHIRPS',
	record: 'Calibration record',
	share: 'Flow share',
	ewr: 'EWR',
	period: 'Simulation period',
	quality: 'Data quality'
} as const;
export type SettingNoteGroup = keyof typeof SETTING_NOTE_GROUPS;

export const settingTarget = (key: SettingNoteGroup): NoteTarget => ({ kind: 'setting', key, label: SETTING_NOTE_GROUPS[key] });

/** The GET /notes filter for a target. */
export function targetQuery(t: NoteTarget): NotesQuery {
	switch (t.kind) {
		case 'project':
			return { target: 'project' };
		case 'node':
			return { nodeId: t.nodeId };
		case 'run':
			return { runId: t.runId };
		case 'setting':
			return { settingKey: t.key };
		case 'scenario':
			return { scenarioId: t.scenarioId };
		case 'pack':
			return { packId: t.packId };
	}
}

/**
 * Beside every public-participation comment box (166_public_participation;
 * licensing positions item 7, provisional position, pre-counsel research,
 * 2026-10-01): only a timeous written objection keeps a right to appeal
 * (National Water Act s148(1)(f)). The share pages say the same in the
 * reader's language (share/ShareComments.svelte).
 */
export const OBJECTION_WARNING =
	'A comment here is not a written objection. To object, and to keep the right to appeal (National Water Act s148(1)(f)), write to the address in the application’s notice before its closing date.';
/** The register opt-in (GN R267 reg 18): the email goes to the applicant only when ticked. */
export const REGISTER_CONSENT_LABEL = 'Give my name and email to the applicant for the register of interested and affected parties (GN R267 reg 18)';
/** Who receives a public comment (POPIA s18). */
export const PUBLIC_COMMENT_RECIPIENTS =
	'The applicant, the responsible authority that decides the application, and the public participation report the applicant gives it (GN R267 reg 19) receive your comment and your name.';

/** The POST /notes body for a new note on a target. `registerConsent` goes only with a public comment. */
export function createBody(t: NoteTarget, body: string, visibility: NoteVisibility, registerConsent = false): NoteCreate {
	const text = normaliseBody(body);
	const out = createBodyFor(t, text, visibility);
	return out.visibility === 'public_participation' && registerConsent ? { ...out, registerConsent: true } : out;
}

function createBodyFor(t: NoteTarget, text: string, visibility: NoteVisibility): NoteCreate {
	switch (t.kind) {
		case 'project':
			return { body: text, visibility: 'team' };
		case 'node':
			return { body: text, nodeId: t.nodeId, visibility: t.isFarm ? visibility : 'team' };
		case 'run':
			return { body: text, runId: t.runId, visibility: 'team' };
		case 'setting':
			return { body: text, settingKey: t.key, visibility: 'team' };
		case 'scenario':
			return { body: text, scenarioId: t.scenarioId, visibility: t.audiences.includes(visibility) ? visibility : (t.audiences[0] ?? 'public_participation') };
		case 'pack':
			return { body: text, packId: t.packId, visibility: t.audiences.includes(visibility) ? visibility : (t.audiences[0] ?? 'team') };
	}
}

/** How many notes the counts show for a target; a settings group adds up its keys. */
export function countFor(counts: NoteCounts | null, t: NoteTarget): number {
	if (!counts) return 0;
	switch (t.kind) {
		case 'project':
			return counts.project;
		case 'node':
			return counts.nodes[t.nodeId] ?? 0;
		case 'run':
			return counts.runs[t.runId] ?? 0;
		case 'setting':
			return Object.entries(counts.settings).reduce((n, [k, c]) => (k === t.key || k.startsWith(`${t.key}.`) ? n + c : n), 0);
		case 'scenario':
			return counts.scenarios?.[t.scenarioId] ?? 0;
		case 'pack':
			return counts.packs?.[t.packId] ?? 0;
	}
}

/** What the drawer's heading says it is about. */
export function targetTitle(t: NoteTarget): string {
	switch (t.kind) {
		case 'project':
			return 'Project notes';
		case 'node':
			return `Notes on ${t.name || 'this node'}`;
		case 'run':
			return `Notes on run ${t.label}`;
		case 'setting':
			return `Notes on ${t.label}`;
		case 'scenario':
			return `Comments on “${t.name}”`;
		case 'pack':
			return `Notes and comments on ${t.name}`;
	}
}

/** "Notes (3)" for a button's accessible name, "Notes" when there are none. */
export const notesButtonLabel = (count: number, about: string) => (count > 0 ? `Notes on ${about} (${count})` : `Add a note on ${about}`);

/** A note's target in a mixed list (the Overview's recent notes). */
export function noteAbout(n: Pick<Note, 'target' | 'nodeName' | 'settingKey'>): string {
	if (n.target === 'scenario') return 'A scenario';
	if (n.target === 'pack') return 'An evidence pack';
	switch (n.target) {
		case 'project':
			return 'The project';
		case 'node':
			return n.nodeName ?? 'A node';
		case 'run':
			return 'A run';
		case 'setting': {
			const group = n.settingKey?.split('.')[0] as SettingNoteGroup | undefined;
			return `Settings: ${(group && SETTING_NOTE_GROUPS[group]) || n.settingKey}`;
		}
	}
}

/** Where a note's target is shown in the workspace (the Overview's recent notes link there). */
export function noteHref(n: Pick<Note, 'target' | 'nodeId' | 'runId' | 'settingKey'> & { scenarioId?: string | null }): string | null {
	switch (n.target) {
		case 'pack':
			// The pack's own page is outside the workspace's tabs; its notes are there (the pack page's Notes).
			return null;
		case 'scenario':
			return n.scenarioId ? `?tab=scenarios&scenario=${encodeURIComponent(n.scenarioId)}` : '?tab=scenarios';
		case 'project':
			return null;
		case 'node':
			// The Network's map with the node picked: its card has the notes (issue #17).
			return n.nodeId ? `?tab=network&node=${encodeURIComponent(n.nodeId)}` : '?tab=network';
		case 'run':
			return n.runId ? `?tab=runs&run=${encodeURIComponent(n.runId)}#res-notes` : '?tab=runs';
		case 'setting': {
			const group = n.settingKey?.split('.')[0];
			return group && group in SETTING_NOTE_GROUPS ? `?tab=settings#set-${group}` : '?tab=settings';
		}
	}
}

/** The text as it is saved: trimmed, Windows line ends made plain. */
export const normaliseBody = (s: string) => s.replace(/\r\n?/g, '\n').trim();

/** Why a draft can't be saved, or null, in the list's words (English by default). */
export function bodyProblem(s: string, w: Pick<NotesWords, 'writeFirst' | 'tooLong'> = NOTES_EN): string | null {
	const t = normaliseBody(s);
	if (!t) return w.writeFirst;
	if (t.length > NOTE_MAX) return w.tooLong(t.length, NOTE_MAX);
	return null;
}
