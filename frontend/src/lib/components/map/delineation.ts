// The Map's delineation (issue #326 B-delineate; docs/design/delineation.md,
// docs/ui.md § Map): what the sheet says about a proposal, pure so it is
// tested without a browser.
import type { DelineationProposal, DelineationRequest, DelineationState } from '$lib/api/types';
import { fmtNum } from '$lib/format/number';

/** The proposal waiting for a decision, if any (at most one: a new one supersedes it). */
export const openProposal = (s: DelineationState | null): DelineationProposal | null => s?.proposals.find((p) => p.status === 'proposed') ?? null;

/** A delineation the background worker still has (queued or running): the sheet keeps asking for it. */
export const isWaiting = (r: DelineationRequest | null | undefined): boolean => !!r && (r.status === 'queued' || r.status === 'running');

/** How often the sheet asks the server about a waiting delineation (ms). */
export const POLL_MS = 2000;

/** What the sheet says while the worker has it. */
export function waitingText(r: DelineationRequest): string {
	if (r.status === 'running') {
		return `Working out the catchment in the background${r.progress ? ` (${Math.round(r.progress)} % through)` : ''}. A large catchment takes a minute or two; you can close this and come back.`;
	}
	return 'The catchment is too large to work out at once, so it is queued for the background. It takes a minute or two; you can close this and come back.';
}

/** The sentence for a background delineation that failed (its job died). */
export const failedText = (r: DelineationRequest) =>
	`The background delineation failed${r.error && r.error !== 'cancelled' ? `: ${r.error.replace(/\.$/, '')}` : ''}. Try again, or draw or import the boundary.`;

/** The Copernicus licence's notice for adapted data (Art. 6(b)), plain text: a delineated polygon is adapted DEM data. */
export const COPERNICUS_NOTICE =
	'Produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.';

/** The notice a proposal from this dataset carries: the Copernicus one for the GLO-30 DEM (Mapterhorn's build), none for the synthetic fixture or an unknown DEM. */
export function datasetNotice(d: { label: string; attribution?: string } | null | undefined): string | null {
	if (!d) return null;
	return /mapterhorn|copernicus/i.test(`${d.label} ${d.attribution ?? ''}`) ? COPERNICUS_NOTICE : null;
}

export const FROM_LABEL: Record<DelineationProposal['from'], string> = { outlet: 'The catchment’s outlet', dam_wall: 'Just below a dam wall' };

/** The proposal's facts, as the sheet lists them first: label, then value. */
export function proposalFacts(p: DelineationProposal): [string, string][] {
	const snap = Math.round(p.snapDistanceM);
	return [
		['Area', `${fmtNum(p.areaM2 / 1e6, 2)} km²`],
		['The point is', FROM_LABEL[p.from].toLowerCase()],
		['Outlet', snap === 0 ? 'where the point was' : `${snap} m from the point, on the channel`],
		['Cells', `${fmtNum(p.cells)} cells, each about ${Math.round(p.cellSizeM)} m across`]
	];
}

/** Where it came from, behind "How it was made": the dataset with its fingerprint, the method with its version. */
export function provenanceFacts(p: DelineationProposal): [string, string][] {
	return [
		['Dataset', `${p.dataset} (${p.datasetFingerprint})`],
		['Method', `${p.method} [${p.methodVersion}]`]
	];
}

/** What every proposal says about its accuracy (docs/design/delineation.md § Accuracy). */
export const CAVEATS = [
	'A proposal from a 30 m global elevation model, not a survey. In flat land the divide can be hundreds of metres out, and a catchment can come out joined to, or cut from, its neighbour.',
	'Flats and dams drain towards their outlet by construction. Canals, pipelines, culverts and transfers between basins are invisible to it.',
	'Check it against the map (the Relief layer, the rivers, the quaternary outlines) before accepting; you can edit the shape afterwards.'
] as const;
