// Settings → Model selection for flow generation → The catchment's rainfall station (issue #612 follow-up,
// docs/ui.md § Model settings, docs/model.md §2.4i): settings.rainStations.catchment, the station whose rain is the
// catchment rain (what GR4J's one run reads under Fragmentation, and what demand and the dams read under either
// method), with its patching priority. Same shape and same rule as a unit's assignment (#619's decision), so the
// stored-default rules are flowGeneration.ts's: no assignment = the catchment rain series as before stations, the
// default patching priority [CHIRPS] stored as none, the main station never in its own priority, scaling on and the
// station itself as the correcting station stored as none. Pure.
import type { RainPatchSource, RainStationAssignment, RainStationSettings } from '@water-management/engine';
import { patchOf, patchValues, storedPatch, tidyStations, type PatchValue, type StationOption } from './flowGeneration';

/** The catchment's station as the form shows it. */
export interface CatchmentStationRow {
	/** The stored assignment, or null (the catchment rain series, as before stations). */
	assignment: RainStationAssignment | null;
	/** The assigned station, or null: none, or one the project no longer has (`missing`). */
	station: StationOption | null;
	missing: boolean;
	/** Whether the station's rain is scaled to the catchment MAP (the assignment's; on by default). */
	scale: boolean;
	/** The station correcting the catchment's CHIRPS: the assignment's, else its own station. */
	correctAgainst: string | null;
	/** The patching priority as the pull-downs hold it: [`chirps`] by default; [] without a station. */
	patch: PatchValue[];
}

export function catchmentStationRow(rs: RainStationSettings | null | undefined, stations: readonly StationOption[]): CatchmentStationRow {
	const assignment = rs?.catchment ?? null;
	const station = assignment ? (stations.find((s) => s.id === assignment.stationId) ?? null) : null;
	return {
		assignment,
		station,
		missing: !!assignment && !station,
		scale: assignment?.scaleToMap !== false,
		correctAgainst: assignment ? (assignment.correctAgainst ?? assignment.stationId) : null,
		patch: assignment ? patchValues(patchOf(assignment)) : []
	};
}

/**
 * The setting with the catchment's station set ('' / null: none, so the catchment runs on its rain series as before
 * stations). Another station keeps the scaling, the correcting station and the patching priority, less the new main
 * station, which can't patch its own gaps.
 */
export function withCatchmentStation(rs: RainStationSettings | null | undefined, stationId: string | null): RainStationSettings | null {
	const out: RainStationSettings = { ...(rs ?? {}) };
	if (!stationId) delete out.catchment;
	else {
		const a: RainStationAssignment = { ...(rs?.catchment ?? {}), stationId };
		out.catchment = Array.isArray(a.patch) ? storedPatch(a, a.patch.filter((p) => !(p.source === 'station' && p.stationId === stationId))) : a;
	}
	return tidyStations(out);
}

/** The setting with the catchment's patching priority set (none without a station: it has no gaps to patch). */
export function withCatchmentPatch(rs: RainStationSettings | null | undefined, patch: readonly RainPatchSource[]): RainStationSettings | null {
	const a = rs?.catchment;
	if (!a) return rs ?? null;
	return tidyStations({ ...rs, catchment: storedPatch(a, patch.filter((p) => !(p.source === 'station' && p.stationId === a.stationId))) });
}

/** The setting with the catchment's "Scale to catchment MAP" set. Scaling is the default, so on stores none. */
export function withCatchmentScale(rs: RainStationSettings | null | undefined, scale: boolean): RainStationSettings | null {
	const a = rs?.catchment;
	if (!a) return rs ?? null;
	const { scaleToMap: _s, ...rest } = a;
	return tidyStations({ ...rs, catchment: scale ? rest : { ...rest, scaleToMap: false } });
}

/** The setting with the station that corrects the catchment's CHIRPS ('' / null / its own station: the default, stored as none). */
export function withCatchmentCorrectAgainst(rs: RainStationSettings | null | undefined, stationId: string | null): RainStationSettings | null {
	const a = rs?.catchment;
	if (!a) return rs ?? null;
	const { correctAgainst: _c, ...rest } = a;
	return tidyStations({ ...rs, catchment: stationId && stationId !== a.stationId ? { ...rest, correctAgainst: stationId } : rest });
}
