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

const byProject = new Map<string, ProjectNoteCounts>();

/** The shared counts for a project (one instance per project for the session). */
export function noteCounts(projectId: string): ProjectNoteCounts {
	let c = byProject.get(projectId);
	if (!c) byProject.set(projectId, (c = new ProjectNoteCounts(projectId)));
	return c;
}
