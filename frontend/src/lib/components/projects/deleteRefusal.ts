// DELETE /projects/:id refuses a project that has nominated an evidence run
// (issue #43, docs/api.md): 409 with `details.evidenceRun` naming the current
// nomination (null when a nomination landed mid-request). This reads that
// answer so the projects page can explain it instead of showing the raw error.
import { ApiError } from '$lib/api/client';

export interface EvidenceRefusal {
	/** The project's current evidence run, or null when the server couldn't name it. */
	run: { id: string; label: string } | null;
	/** How many nominations the project's history holds, when known. */
	nominations: number | null;
}

export function evidenceRefusal(err: unknown): EvidenceRefusal | null {
	if (!(err instanceof ApiError) || err.status !== 409) return null;
	const d = err.details;
	if (!d || typeof d !== 'object' || !('evidenceRun' in d)) return null;
	const run = (d as { evidenceRun: unknown }).evidenceRun;
	const n = (d as { nominations?: unknown }).nominations;
	const named =
		run && typeof run === 'object' && typeof (run as { id?: unknown }).id === 'string' && typeof (run as { label?: unknown }).label === 'string'
			? { id: (run as { id: string }).id, label: (run as { label: string }).label }
			: null;
	return { run: named, nominations: typeof n === 'number' ? n : null };
}
