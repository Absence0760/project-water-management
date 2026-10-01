// "Start from an example" on the empty project list (GetStarted.svelte, issue
// #286): the invented Kleinberg example catchment, imported as the signed-in
// user through POST /projects/import with one run, so a new user has a
// finished model to look round before building their own.
//
// The document (exampleCatchment.generated.json, `pnpm gen:example` from the
// backend's example catchments; synthetic data only) is ~25 KB gzip of
// rainfall and flow that nobody with projects needs, so it is a lazy chunk of
// its own: loaded on hover, focus or press, never with the page.
// example.test.ts keeps every static import of it out.
import type { ImportResult, ProjectFile } from '$lib/api';
import { loadOnce, type Loader } from '$lib/components/common/lazy';

export const loadExample: Loader<ProjectFile> = () =>
	import('./exampleCatchment.generated.json').then((m) => ({ default: m.default as unknown as ProjectFile }));

/** Why starting the example stopped: its chunk didn't download (only a reload helps, lazy.ts), or the import failed. */
export type ExampleFailure = { kind: 'chunk' } | { kind: 'import'; error: unknown };

export type ImportProject = (file: ProjectFile, opts: { run: boolean }) => Promise<ImportResult>;

/**
 * Import the example as a new personal project and run it. The path to open
 * (after `base`): its Runs tab on the new run, or the project when the run
 * failed, with `runError` saying why (the project was still created, as the
 * import dialog says in the same case), so the card can tell the user
 * before they open it rather than land them on a project with no run.
 */
export async function startFromExample(
	importProject: ImportProject,
	load: Loader<ProjectFile> = loadExample
): Promise<{ ok: true; path: string; runError?: string } | ({ ok: false } & ExampleFailure)> {
	let file: ProjectFile;
	try {
		file = await loadOnce(load);
	} catch {
		return { ok: false, kind: 'chunk' };
	}
	try {
		const r = await importProject(file, { run: true });
		const id = encodeURIComponent(r.project.id);
		if (r.runId) return { ok: true, path: `/projects/${id}?tab=runs&run=${encodeURIComponent(r.runId)}` };
		return { ok: true, path: `/projects/${id}`, runError: r.runError ?? 'the model didn’t run' };
	} catch (error) {
		return { ok: false, kind: 'import', error };
	}
}
