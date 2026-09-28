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
	| { kind: 'setting'; key: string; label: string };

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
	}
}

/** The POST /notes body for a new note on a target. */
export function createBody(t: NoteTarget, body: string, visibility: NoteVisibility): NoteCreate {
	const text = normaliseBody(body);
	switch (t.kind) {
		case 'project':
			return { body: text, visibility: 'team' };
		case 'node':
			return { body: text, nodeId: t.nodeId, visibility: t.isFarm ? visibility : 'team' };
		case 'run':
			return { body: text, runId: t.runId, visibility: 'team' };
		case 'setting':
			return { body: text, settingKey: t.key, visibility: 'team' };
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
	}
}

/** "Notes (3)" for a button's accessible name, "Notes" when there are none. */
export const notesButtonLabel = (count: number, about: string) => (count > 0 ? `Notes on ${about} (${count})` : `Add a note on ${about}`);

/** A note's target in a mixed list (the Overview's recent notes). */
export function noteAbout(n: Pick<Note, 'target' | 'nodeName' | 'settingKey'>): string {
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
export function noteHref(n: Pick<Note, 'target' | 'nodeId' | 'runId' | 'settingKey'>): string | null {
	switch (n.target) {
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
