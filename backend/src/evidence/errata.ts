// Errata found since a pack's manifest was frozen (issue #71 follow-up
// "Errata found after issue on verify"; docs/evidence-pack.md §
// Verification). A pack records the errata that applied to its runs' engines
// (and their fits') when it was drafted, and that record never changes: it is
// hashed. An erratum added to docs/engine-errata.md later, for one of those
// engines, is listed apart: the current list (ENGINE_ERRATA) through the
// engine's errataFor, less what the manifest recorded.
import { ENGINE_ERRATA, errataFor, type Erratum } from '@water-management/engine';

/** One of a pack's runs: its engine, and the engine of the automatic fit its parameters came from (null: entered parameters). */
export interface PackRunEngines {
	engineVersion: string;
	fitEngineVersion: string | null;
}

/** An erratum as verify prints it: its id and what goes wrong, nothing else. */
export interface PackErratum {
	id: string;
	summary: string;
}

/**
 * The errata that apply now to any of `runs` (by run engine, or by fit engine
 * for a `fit` erratum) and aren't among `recorded` (by id), in the list's
 * order, each once.
 */
export function errataFoundSince(recorded: readonly { id: string }[], runs: readonly PackRunEngines[], errata: readonly Erratum[] = ENGINE_ERRATA): PackErratum[] {
	const seen = new Set(recorded.map((e) => e.id));
	const applies = new Set(runs.flatMap((r) => errataFor(r.engineVersion, errata, r.fitEngineVersion).map((e) => e.id)));
	return errata.filter((e) => applies.has(e.id) && !seen.has(e.id)).map((e) => ({ id: e.id, summary: e.summary }));
}
