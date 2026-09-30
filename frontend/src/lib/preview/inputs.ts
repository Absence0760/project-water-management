// A run's own input for the preview worker (roadmap WP-1.17): the one the
// server runs on (`GET …/runs/:runId/model-input`, which reads the run's
// stored series as the `yield` job's loadRunInput does). A stored run's input
// never changes, so the last one fetched is kept: reopening a dam, or another
// dam on the same run, starts its preview without fetching it again. One
// entry only, since an input holds every series of the record.
import type { ModelInput } from '@water-management/engine';

let last: { key: string; input: Promise<ModelInput> } | null = null;

/** The run's input, from `fetch` (the panel passes api.uncertainty.runInput) unless it is the one kept. */
export function runInputFor(projectId: string, runId: string, fetch: (projectId: string, runId: string) => Promise<ModelInput>): Promise<ModelInput> {
	const key = `${projectId}/${runId}`;
	if (last?.key === key) return last.input;
	const input = fetch(projectId, runId);
	const entry = { key, input };
	last = entry;
	// A failed fetch isn't kept: the next preview asks again.
	input.catch(() => {
		if (last === entry) last = null;
	});
	return input;
}

/** For the tests. */
export function forgetRunInput(): void {
	last = null;
}
