// Which parts of the model an unsaved edit touches, for the save bar's line
// ("Unsaved changes to the model (network and transfers)") and the Discard
// question, which names what goes. The model's lists by the tab that edits
// them: the network (nodes and what hangs on a node: land cover, boreholes,
// demand objects), crops (the crops and their planted areas) and transfers.
import type { ProjectModel } from '@water-management/engine';

export type ModelArea = 'network' | 'crops' | 'transfers';

const AREAS: readonly [ModelArea, readonly (keyof ProjectModel)[]][] = [
	['network', ['nodes', 'landCover', 'boreholes', 'demandObjects']],
	['crops', ['crops', 'cropAreas']],
	['transfers', ['transfers']]
];

// An absent list and an empty one are the same model (the API returns a list only when there are any).
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/** The areas whose lists differ between the saved model and the draft, in tab order. */
export function changedAreas(saved: ProjectModel, draft: ProjectModel): ModelArea[] {
	return AREAS.filter(([, keys]) => keys.some((k) => !same(saved[k], draft[k]))).map(([area]) => area);
}

/** "the network", "crops", "transfers": as the save bar's words name them. */
export const AREA_WORDS: Record<ModelArea, string> = { network: 'the network', crops: 'crops', transfers: 'transfers' };
