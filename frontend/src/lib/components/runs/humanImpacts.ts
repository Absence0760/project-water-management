// Land cover, groundwater, other users' and demand objects' tables: a separate chunk
// (HumanImpactTables.svelte), drawn by RunSummaryView (the catchment's) and Hydrological units
// (the units', issue #175). A plain module rather than RunSummaryView's `<script module>`, so the
// printable report can load it before it says it is ready: Vite's dependency scan can't see a
// .svelte file's named exports, and failed on the import.
import type { RunSummary } from '@water-management/engine';

export const loadHumanImpacts = () => import('./HumanImpactTables.svelte');

/** Which of the tables: the catchment's (land cover, groundwater), the units' (demand objects, other water users), or all. */
export type ImpactParts = 'all' | 'catchment' | 'units';

type ImpactSummary = Pick<RunSummary, 'landCover' | 'users' | 'farms'>;

/** The run has land cover or a borehole (a farm's or another user's): the catchment's tables have something to show. */
export const hasCatchmentImpacts = (s: ImpactSummary): boolean =>
	!!s.landCover || [...(s.farms ?? []), ...(s.users ?? [])].some((f) => f.avgGroundwaterM3Day !== undefined);

/** The run has other water users or a unit with demand objects: the units' tables have something to show. */
export const hasUnitImpacts = (s: ImpactSummary): boolean => !!s.users?.length || (s.farms ?? []).some((f) => !!f.demandObjects?.length);
