// The in-app half of the known-defect procedure (issue #103;
// docs/legal/known-defect-procedure.md): a run says which known engine bugs
// may affect it. The run list and a run's detail carry `errata`, the ids of
// the errata whose range holds the run's engine (or, for a `fit` erratum, the
// engine of the fit its parameters came from), computed here from the
// engine's ENGINE_ERRATA, so the frontend flags them without shipping the
// errata table in its main bundle (the validation statement prints the rows).
import { ENGINE_ERRATA, errataFor, type Erratum } from '@water-management/engine';

/** A run row as RUN_META selects it: its engine, and its fit's (null: entered parameters). */
export interface RunEngines {
	engineVersion: string;
	fitEngineVersion?: string | null;
}

/** The row with `errata`: the ids of the errata that may affect it, in the list's order (empty for none). */
export function withErrata<T extends RunEngines>(run: T, errata: readonly Erratum[] = ENGINE_ERRATA): T & { errata: string[] } {
	return { ...run, errata: errataFor(run.engineVersion, errata, run.fitEngineVersion ?? null).map((e) => e.id) };
}
