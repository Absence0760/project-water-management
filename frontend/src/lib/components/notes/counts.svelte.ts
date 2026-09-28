// The note counts behind every notes badge in a project's workspace: one
// GET /notes/counts shared by all the drawers on screen, loaded when the
// first one mounts and again after any note is added, edited or deleted.
import { api, type NoteCounts } from '$lib/api';

export class ProjectNoteCounts {
	counts = $state<NoteCounts | null>(null);
	/** The last load failed: badges show no number (the drawers still work). */
	failed = $state(false);
	#loading: Promise<void> | null = null;

	constructor(readonly projectId: string) {}

	/** Load once; later callers share the first load. */
	ensure(): Promise<void> {
		return (this.#loading ??= this.refresh());
	}

	async refresh(): Promise<void> {
		try {
			this.counts = await api.notes.counts(this.projectId);
			this.failed = false;
		} catch {
			// Shown as `failed`, not thrown: a badge is a hint, and the notes themselves load in the drawer.
			this.failed = true;
		}
	}
}

// One project's counts at a time: the workspace shows one project, so moving
// to another drops the last one (coming back loads fresh counts rather than
// the ones from the first visit), and the cache never grows with the number
// of projects opened in a session.
let current: ProjectNoteCounts | null = null;

/** The shared counts for a project; asking for another project replaces them. */
export function noteCounts(projectId: string): ProjectNoteCounts {
	if (current?.projectId !== projectId) current = new ProjectNoteCounts(projectId);
	return current;
}

/** Forget the cached counts (on sign-out, so the next account never sees this one's). */
export function clearNoteCounts(): void {
	current = null;
}
