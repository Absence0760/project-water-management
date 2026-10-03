// The project details (name, description, time zone, WUA name) being edited
// on the Project page (issue #162 item 12). The workspace page holds it, not
// the Project tab, so the edits survive a tab change and are saved or
// discarded by the page's one sticky "Save changes / Discard" bar with the
// model edits, and the leave guard counts them. Every other card on the
// Project page (move, members, farmers, links) still acts at once.
import type { api, Project } from '$lib/api';
import { DEFAULT_TIME_ZONE } from './project';

type ProjectUpdate = Parameters<typeof api.projects.update>[1];

type Fields = { name: string; description: string; timeZone: string; wuaName: string };

function fieldsOf(p: Project): Fields {
	return { name: p.name, description: p.description ?? '', timeZone: p.timeZone ?? DEFAULT_TIME_ZONE, wuaName: p.wuaName ?? '' };
}

export class ProjectDetailsDraft {
	// Equal to #saved until load(): nothing loaded is nothing unsaved (a project that failed to load).
	name = $state('');
	description = $state('');
	timeZone = $state(DEFAULT_TIME_ZONE);
	wuaName = $state('');
	saving = $state(false);
	saveError = $state<string | null>(null);
	/** The saved values the edits are measured against. */
	#saved = $state.raw<Fields>({ name: '', description: '', timeZone: DEFAULT_TIME_ZONE, wuaName: '' });

	/** Start over from the project as saved (a new project, or after a save). */
	load(p: Project): void {
		const f = fieldsOf(p);
		this.#saved = f;
		this.name = f.name;
		this.description = f.description;
		this.timeZone = f.timeZone;
		this.wuaName = f.wuaName;
		this.saveError = null;
	}

	/**
	 * The project changed elsewhere (a team move, Settings): the saved values
	 * follow it; the fields do too unless they hold edits, which are kept.
	 */
	rebase(p: Project): void {
		if (!this.dirty) {
			this.load(p);
			return;
		}
		this.#saved = fieldsOf(p);
	}

	/** The fields as typed now (trimmed), to hand back to afterSave once the save they went with returns. */
	typed(): Fields {
		return { name: this.name.trim(), description: this.description.trim(), timeZone: this.timeZone.trim(), wuaName: this.wuaName.trim() };
	}

	/**
	 * The save came back: `sent` is typed() as the save took it, `p` the project as saved. A field edited
	 * while the save was in flight keeps its text (still unsaved); the others take the saved value.
	 */
	afterSave(sent: Fields, p: Project): void {
		const now = this.typed();
		const f = fieldsOf(p);
		this.#saved = f;
		if (now.name === sent.name) this.name = f.name;
		if (now.description === sent.description) this.description = f.description;
		if (now.timeZone === sent.timeZone) this.timeZone = f.timeZone;
		if (now.wuaName === sent.wuaName) this.wuaName = f.wuaName;
		this.saveError = null;
	}

	get dirty(): boolean {
		const s = this.#saved;
		return (
			this.name.trim() !== s.name ||
			this.description.trim() !== s.description ||
			this.timeZone.trim() !== s.timeZone ||
			this.wuaName.trim() !== s.wuaName
		);
	}

	/** What stops a save: the name and the time zone are required. */
	get problems(): string[] {
		const out: string[] = [];
		if (!this.name.trim()) out.push('The project needs a name.');
		if (!this.timeZone.trim()) out.push('The project needs a time zone.');
		return out;
	}

	/** The update to send: name and description always, the zone and WUA name only when they changed. */
	patch(): ProjectUpdate {
		const s = this.#saved;
		const zone = this.timeZone.trim();
		const wua = this.wuaName.trim();
		return {
			name: this.name.trim(),
			description: this.description.trim(),
			...(zone !== s.timeZone ? { timeZone: zone } : {}),
			...(wua !== s.wuaName ? { wuaName: wua || null } : {})
		};
	}

	/** Put the saved values back. */
	revert(): void {
		const s = this.#saved;
		this.name = s.name;
		this.description = s.description;
		this.timeZone = s.timeZone;
		this.wuaName = s.wuaName;
		this.saveError = null;
	}
}
