// The example catchment a new user can start from on the empty project list
// (issue #286): the invented Kleinberg example (scripts/examples, the first
// of `pnpm seed:examples`) as a project document, the body
// POST /projects/import takes. The project list's "Start from an example"
// (frontend/src/lib/components/projects/GetStarted.svelte) loads it on demand
// and imports it as the signed-in user, with one run.
//
//   pnpm gen:example        (root script; no database, ~10 s for the GR4J fit)
//
// Deterministic: the example and its fit are seeded, so a rerun writes the
// same file until the engine or the example changes. Every number is
// synthetic, as the document's description says. Rerun it after changing the
// example catchments (scripts/examples/catchments.ts) or the engine's model
// fields; example-file.test.ts fails until you do.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildExamples, type ExampleProject } from './examples/catchments.js';

/** Where the frontend reads it (a lazy chunk of its own). */
export const EXAMPLE_FILE = fileURLToPath(new URL('../../frontend/src/lib/components/projects/exampleCatchment.generated.json', import.meta.url));

/** Ignored by the importer (an informational key); says where the file comes from. */
export const GENERATED_BY =
	'pnpm gen:example (backend/scripts/example-file.ts): the invented Kleinberg example catchment from backend/scripts/examples/catchments.ts. Synthetic data, no real place or farm.';

/** The project document for one example: what `pnpm seed:examples` imports for it, plus the provenance key. */
export function exampleDocument(ex: ExampleProject): Record<string, unknown> {
	return { generatedBy: GENERATED_BY, ...ex };
}

/**
 * JSON with tab indents, but every array of plain numbers on one line:
 * readable and diffable where it matters (settings, model), not 16 000 lines
 * of rainfall.
 */
export function formatDocument(doc: Record<string, unknown>): string {
	const text = JSON.stringify(doc, null, '\t');
	return `${text.replace(/\[(?:\s*(?:-?\d[\d.eE+-]*|null),?)+\s*\]/g, (m) => m.replace(/\s+/g, ''))}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const kleinberg = buildExamples({ fit: true })[0]!;
	await writeFile(EXAMPLE_FILE, formatDocument(exampleDocument(kleinberg)));
	console.log(`wrote ${EXAMPLE_FILE}`);
}
