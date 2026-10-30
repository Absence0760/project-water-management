// Calibration zones as the Network and the Map show them (issue #555 round 4,
// docs/model.md §2.10n, docs/ui.md § Network, docs/maps.md § Calibration
// zones on the map): each zone's land units and its colour, from the model as
// it is now and the saved settings, by the engine's own rule (resolveZones), so
// what the screens colour is what the next run applies. Pure, unit-tested.
import { resolveZones, zoneSiteName, type NetworkNode, type ProjectSettings } from '@water-management/engine';

/**
 * The zones' colour tokens, in order: the crop palette's (crops/cards.ts
 * CROP_PALETTE, every adjacent pair validated apart for colour-blind readers in
 * both themes, `--series-4` left to the line charts). A zone's name is always
 * written beside its colour (legend, label line, card), so a reused colour past
 * the ninth zone never stands alone.
 */
export const ZONE_TOKENS = ['--series-1', '--series-2', '--series-3', '--series-5', '--series-6', '--series-7', '--series-8', '--series-9', '--series-10'] as const;

export interface ZoneGroup {
	/** The zone's gauge; null = the calibration site's own zone (every unit not in a ticked zone). */
	nodeId: string | null;
	/** The gauge's name; the site's zone: the site's (Scored at's gauge, else the outflow gauge). */
	name: string;
	/** Its land units, node-id order. */
	units: string[];
	/** Whether the row has parameters of its own (the site's zone: always, the catchment's). */
	fitted: boolean;
	/** Its colour token (`--series-N`), for a fill read through the theme. */
	token: string;
}

type ZoneSettings = Pick<ProjectSettings, 'calibrationZones' | 'calibrationSiteNodeId' | 'gr4j'>;

/**
 * The zones a run would apply now, upstream first and the site's own zone
 * last, each with its colour; null when none applies (no ticked gauge, or every
 * ticked gauge unusable). The engine's warnings are dropped here: the run gives them.
 */
export function zoneGroups(nodes: readonly NetworkNode[], settings: ZoneSettings | null | undefined): ZoneGroup[] | null {
	if (!settings?.calibrationZones?.some((z) => z.enabled)) return null;
	const a = resolveZones(nodes, settings, settings.gr4j, []);
	if (!a) return null;
	const site = settings.calibrationSiteNodeId ?? null;
	const groups = [
		...a.zones.map((z) => ({ nodeId: z.nodeId as string | null, name: z.name, units: [...z.units], fitted: z.fitted })),
		{ nodeId: null, name: zoneSiteName(nodes, site), units: [...a.primaryUnits], fitted: true }
	];
	return groups.map((g, i) => ({ ...g, token: ZONE_TOKENS[i % ZONE_TOKENS.length]! }));
}

/** Each land unit's zone (by unit id). */
export function zoneByUnit(groups: readonly ZoneGroup[] | null): Map<string, ZoneGroup> {
	const out = new Map<string, ZoneGroup>();
	for (const g of groups ?? []) for (const u of g.units) out.set(u, g);
	return out;
}

/** A zone in words: "Weir zone" or "Outlet zone (calibration site)", with "not fitted yet" when its units take the catchment's parameters. */
export function zoneName(g: Pick<ZoneGroup, 'nodeId' | 'name' | 'fitted'>): string {
	return `${g.name} zone${g.nodeId === null ? ' (calibration site)' : ''}${g.fitted ? '' : ', not fitted yet'}`;
}

/** "3 units". */
export const unitCount = (n: number) => `${n} unit${n === 1 ? '' : 's'}`;
