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

/** Failed asks in a row before the sheet stops waiting for a delineation. */
export const POLL_GIVE_UP = 5;

/**
 * After a failed ask about a waiting delineation (`failures` in a row,
 * counting this one; `status` the HTTP status, if there was an answer): ask
 * again, since a dropped connection or a 5xx says nothing about the job,
 * which keeps running; give up after POLL_GIVE_UP in a row, or at once on a
 * 404 (the request is gone, or another project's).
 */
export function afterPollError(failures: number, status: number | undefined): 'retry' | 'give_up' {
	if (status === 404) return 'give_up';
	return failures >= POLL_GIVE_UP ? 'give_up' : 'retry';
}

/** What the sheet says while the worker has it. */
export function waitingText(r: DelineationRequest): string {
	if (r.status === 'running') {
		return `Working out the catchment in the background${r.progress ? ` (${Math.round(r.progress)} % through)` : ''}. A large catchment takes a minute or two.`;
	}
	return 'The catchment is too large to work out at once, so it is queued for the background. It takes a minute or two.';
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
		['Cells', `${fmtNum(p.cells)} cells, each about ${Math.round(p.cellSizeM)} m across`],
		...panFacts(p)
	];
}

/**
 * What drains into pans (docs/design/delineation.md § Pans): the non-contributing area and the effective area left, or that
 * none was found. Nothing for a proposal made before delineate-9, which never looked.
 */
export function panFacts(p: Pick<DelineationProposal, 'areaM2' | 'pans'>): [string, string][] {
	const pans = p.pans;
	if (!pans) return [];
	return [...intoPans(p.areaM2, pans), ...onRiverFacts(pans)];
}

function intoPans(areaM2: number, pans: NonNullable<DelineationProposal['pans']>): [string, string][] {
	if (!pans.count) return [['Into pans', 'none found (no closed depression deep and large enough)']];
	const nc = pans.nonContributingM2;
	const big = pans.largest[0];
	return [
		[
			'Into pans',
			`${fmtNum(nc / 1e6, 2)} km² (${Math.round((100 * nc) / areaM2)} %) drains into ${pans.count === 1 ? 'a pan' : `${fmtNum(pans.count)} pans`}${big ? `; the largest holds ${fmtNum(big.storageMm)} mm over its ${fmtNum(big.drainsM2 / 1e6, 2)} km²` : ''}. Non-contributing in WR2012’s sense; still inside the area and outline`
		],
		['Effective area', `${fmtNum((areaM2 - nc) / 1e6, 2)} km², if the pans contribute nothing`]
	];
}

/** The depressions found to be storage on a river (delineate-12): listed, not counted as pans. Nothing when none or not checked. */
function onRiverFacts(pans: NonNullable<DelineationProposal['pans']>): [string, string][] {
	const r = pans.onRiver;
	if (!r?.count) return [];
	const big = r.largest[0]!;
	const why = big.by === 'dam' ? 'a dam holds it' : 'a mapped river flows out of it over a wall';
	return [
		[
			'Storage on a river',
			r.count === 1
				? `A closed depression holds as much as a pan, but ${why}: storage on a river, so the ${fmtNum(big.drainsM2 / 1e6, 2)} km² draining into it is not counted as non-contributing`
				: `${fmtNum(r.count)} closed depressions hold as much as pans, but a mapped river flows out of each over a wall or a dam holds it: storage on a river, not counted as non-contributing (the largest has ${fmtNum(big.drainsM2 / 1e6, 2)} km² draining into it)`
		]
	];
}

/** Where it came from, behind "How it was made": the dataset with its fingerprint, the method with its version. */
export function provenanceFacts(p: DelineationProposal): [string, string][] {
	return [
		['Dataset', `${p.dataset} (${p.datasetFingerprint})`],
		['Method', `${p.method} [${p.methodVersion}]`],
		...(p.pans ? ([['Pans', p.pans.method]] as [string, string][]) : [])
	];
}

/** What every proposal says about its accuracy (docs/design/delineation.md § Accuracy). */
export const CAVEATS = [
	'A proposal from a 30 m global elevation model, not a survey. In flat land the divide can be hundreds of metres out, and a catchment can come out joined to, or cut from, its neighbour.',
	'Flats, dams and pans drain towards their outlet by construction: the area draining into pans is reported beside it, not taken out. A dam drawn down below its spillway, or a pond behind an embankment, can count as a pan if it holds a lot over its catchment, unless a mapped river flows out of it over a wall or the register or the map has a dam there (then it is listed as storage on a river). Canals, pipelines, culverts and transfers between basins are invisible to it.',
	'Check it against the map (the Relief layer, the rivers, the quaternary outlines) before accepting; you can edit the shape afterwards.'
] as const;
