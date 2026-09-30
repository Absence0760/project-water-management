// In-memory editor for a project's ProjectModel, shared by the Network, Crops
// and Transfers tabs. Tracks unsaved changes against the last loaded/saved
// snapshot and re-validates on every edit.
import { BOREHOLE_DEFAULTS, DAM_AREA_EXPONENT, DAM_STORAGE_DEFAULTS, DEVELOPMENT_DEFAULTS, NEW_FARM_IRRIGATION, OFFTAKE_DEFAULTS, OPERATING_DEFAULTS, SUPPLY_DEFAULTS, USER_DEFAULTS, type Borehole, type CropDef, type DemandObject, type DemandObjectCategory, newDemandObjectDefaults, type LandCoverPatch, type NetworkNode, type ProjectModel, type Transfer } from '@water-management/engine';
import { bySortOrder } from './order';
import { validateModel, type ModelIssue } from './validate';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function emptyModel(): ProjectModel {
	return { nodes: [], crops: [], cropAreas: [], transfers: [], landCover: [] };
}

export function newNode(sortOrder: number, downstreamNodeId: string | null): NetworkNode {
	return {
		id: crypto.randomUUID(),
		name: '',
		kind: downstreamNodeId === null ? 'gauge' : 'farm',
		downstreamNodeId,
		sortOrder,
		areaKm2: 0,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: 1,
		pctRunoffToDam: 0,
		damCapacityM3: 0,
		damInitialPct: 0,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		// Drip (0.90, the client's default, issue #90) with half its losses returning (audit N1).
		...NEW_FARM_IRRIGATION,
		// Dam area unknown (the run estimates it), the default exponent, no seepage (audit N2).
		damAreaFullM2: null,
		damAreaExponent: DAM_AREA_EXPONENT,
		damSeepagePerDay: 0,
		// Not an other water user until its kind says so (WP-1.33), no boreholes (WP-1.34).
		...USER_DEFAULTS,
		...BOREHOLE_DEFAULTS,
		// No survey curve, no release, all seepage returning (WP-3.5).
		...DAM_STORAGE_DEFAULTS,
		// No sediment, in-service date or abstraction start: as entered for the whole run (engine 1.30.0).
		...DEVELOPMENT_DEFAULTS,
		// The dam only, no river pump (WP-3.8).
		...SUPPLY_DEFAULTS,
		// No hands-off flow, River to dam all year at the one capacity (engine 1.32.0).
		...OPERATING_DEFAULTS,
		// A gauge is an EWR site until unticked (engine 1.5.0); the flag means nothing on a unit.
		ewrSite: true
	};
}

export function newCrop(): CropDef {
	return { id: crypto.randomUUID(), name: '', cropFactor: new Array(12).fill(0) };
}

export function newTransfer(fromNodeId: string, toNodeId: string): Transfer {
	return {
		id: crypto.randomUUID(),
		fromNodeId,
		toNodeId,
		months: [],
		maxRateM3s: 0,
		dailyCapM3: null,
		minStoragePct: 0,
		enabled: true,
		// Equal priorities share a source dam pro rata (audit Q18); raise it to serve a rule later.
		priority: 0,
		// No month on yet; entering a month's rate on the Transfers tab gives it its own rate per month (engine ≥ 1.14.0).
		monthlyRateM3s: null,
		// From the source's dam; the Transfers tab switches it to a river off-take (engine ≥ 1.14.0).
		...OFFTAKE_DEFAULTS
	};
}

export class ModelEditor {
	model = $state<ProjectModel>(emptyModel());
	// Starts equal to the empty model: an editor that never loaded (the project
	// failed to load or 404'd) has no unsaved changes to guard on navigation.
	#saved = $state(JSON.stringify(this.model));
	saving = $state(false);
	saveError = $state<string | null>(null);

	dirty = $derived(JSON.stringify(this.model) !== this.#saved);
	/** Nodes as last loaded or saved: the ones the server knows, so notes (WP-2.7) can be kept on them. */
	savedNodeIds = $derived(new Set((JSON.parse(this.#saved) as ProjectModel).nodes.map((n) => n.id)));
	issues = $derived<ModelIssue[]>(validateModel(this.model));

	load(m: ProjectModel) {
		// Array order = display order (sortOrder) from here on; reordering keeps them in step.
		const normalised: ProjectModel = {
			nodes: bySortOrder(m.nodes ?? []),
			crops: bySortOrder(m.crops ?? []),
			cropAreas: m.cropAreas ?? [],
			transfers: m.transfers ?? [],
			// Land cover (WP-1.35); an older API or document has none.
			landCover: m.landCover ?? [],
			// Individual boreholes (WP-3.9): in the document only when there are any, as the API returns it.
			...(m.boreholes?.length ? { boreholes: m.boreholes } : {}),
			// Demand objects (engine ≥ 1.7.0): likewise only when there are any.
			...(m.demandObjects?.length ? { demandObjects: m.demandObjects } : {})
		};
		this.model = clone(normalised);
		this.#saved = JSON.stringify(this.model);
		this.saveError = null;
	}

	/** Snapshot to send to the API (plain object, no proxies). */
	snapshot(): ProjectModel {
		return $state.snapshot(this.model) as ProjectModel;
	}

	revert() {
		this.model = JSON.parse(this.#saved) as ProjectModel;
		this.saveError = null;
	}

	// --- network --------------------------------------------------------
	addNode() {
		const nodes = this.model.nodes;
		const outlet = nodes.find((n) => n.downstreamNodeId === null);
		const sort = nodes.reduce((m, n) => Math.max(m, n.sortOrder), 0) + 1;
		const node = newNode(sort, nodes.length === 0 ? null : (outlet?.id ?? nodes[0]!.id));
		node.name = nodes.length === 0 ? 'Outflow gauge' : `Farm ${nodes.length}`;
		nodes.push(node);
		return node;
	}

	/** An other water user (WP-1.33) draining into the outlet: no land, dam or crops, no demand until it is entered. */
	addUser() {
		const nodes = this.model.nodes;
		const outlet = nodes.find((n) => n.downstreamNodeId === null);
		const sort = nodes.reduce((m, n) => Math.max(m, n.sortOrder), 0) + 1;
		const node = newNode(sort, outlet?.id ?? null);
		node.kind = 'user';
		node.pctUpstreamToDam = 0;
		node.irrigationEfficiency = 1;
		node.lossReturnFraction = 0;
		node.userDemandM3Day = new Array(12).fill(0);
		node.userReturnPct = 0;
		node.userPriority = 'senior';
		node.name = `Other user ${nodes.filter((n) => n.kind === 'user').length + 1}`;
		nodes.push(node);
		return node;
	}

	removeNode(id: string) {
		const m = this.model;
		const removed = m.nodes.find((n) => n.id === id);
		// Re-route anything that drained into the removed node to where it drained.
		for (const n of m.nodes) {
			if (n.downstreamNodeId === id) n.downstreamNodeId = removed?.downstreamNodeId ?? null;
		}
		m.nodes = m.nodes.filter((n) => n.id !== id);
		m.cropAreas = m.cropAreas.filter((a) => a.nodeId !== id);
		m.transfers = m.transfers.filter((t) => t.fromNodeId !== id && t.toNodeId !== id);
		// An off-take whose seepage rejoined below it returns none now, as a scenario's node.remove leaves it (engine ≥ 1.42.0).
		for (const t of m.transfers) {
			if (t.lossReturnNodeId !== id) continue;
			t.lossReturnNodeId = null;
			t.lossReturnPct = 0;
		}
		m.landCover = (m.landCover ?? []).filter((p) => p.nodeId !== id);
		if (m.boreholes) m.boreholes = m.boreholes.filter((b) => b.nodeId !== id);
		if (m.demandObjects) m.demandObjects = m.demandObjects.filter((o) => o.nodeId !== id);
	}

	// --- demand objects (engine ≥ 1.7.0, issue #54 item 2b) ----------------
	/** A new demand object on a unit, with its category's defaults (the 2b research table) and no demand yet. */
	addDemandObject(nodeId: string, category: DemandObjectCategory = 'municipal'): DemandObject {
		const count = (this.model.demandObjects ?? []).filter((o) => o.nodeId === nodeId).length;
		const d = newDemandObjectDefaults(category);
		const o: DemandObject = {
			id: crypto.randomUUID(),
			nodeId,
			name: `Demand ${count + 1}`,
			category,
			...d,
			monthlyM3Day: d.sizing === 'monthly' ? new Array(12).fill(0) : null,
			count: d.sizing === 'perUnit' ? 0 : null,
			monthlyFactor: null,
			enabled: true,
			schedule: null,
			// Where its number comes from (engine ≥ 1.56.0): not recorded until the modeller says, even at a category's norm.
			source: null,
			note: ''
		};
		// Not `(this.model.demandObjects ??= []).push(o)`: see addBorehole.
		this.model.demandObjects ??= [];
		this.model.demandObjects.push(o);
		return o;
	}

	removeDemandObject(id: string) {
		this.model.demandObjects = (this.model.demandObjects ?? []).filter((o) => o.id !== id);
	}

	// --- individual boreholes (WP-3.9) -------------------------------------
	/** A new borehole on a farm or user: supplemental, straight to the crop, no capacity or cap yet. */
	addBorehole(nodeId: string): Borehole {
		const count = (this.model.boreholes ?? []).filter((b) => b.nodeId === nodeId).length;
		const b: Borehole = {
			id: crypto.randomUUID(),
			nodeId,
			name: `Borehole ${count + 1}`,
			capacityM3Day: 0,
			annualCapM3: null,
			mode: 'supplemental',
			emergencyBelowPct: 0.3,
			target: 'direct',
			depletionFactor: 0
		};
		// Not `(this.model.boreholes ??= []).push(b)`: the assignment's value is the plain
		// array, not the state proxy, so the first borehole would never render.
		this.model.boreholes ??= [];
		this.model.boreholes.push(b);
		return b;
	}

	removeBorehole(id: string) {
		this.model.boreholes = (this.model.boreholes ?? []).filter((b) => b.id !== id);
	}

	// --- land cover (WP-1.35) --------------------------------------------
	/** A new patch on a farm: invasive trees at full condensed cover, no area yet. */
	addLandCover(nodeId: string): LandCoverPatch {
		const p: LandCoverPatch = { id: crypto.randomUUID(), nodeId, coverClass: 'invasive', areaKm2: 0, densityPct: 1, factors: null };
		(this.model.landCover ??= []).push(p);
		return p;
	}

	removeLandCover(id: string) {
		this.model.landCover = (this.model.landCover ?? []).filter((p) => p.id !== id);
	}

	// --- crops ----------------------------------------------------------
	addCrop() {
		const c = newCrop();
		c.name = `Crop ${this.model.crops.length + 1}`;
		c.sortOrder = this.model.crops.reduce((m, x, i) => Math.max(m, (x.sortOrder ?? i) + 1), 0);
		this.model.crops.push(c);
		return c;
	}

	removeCrop(id: string) {
		this.model.crops = this.model.crops.filter((c) => c.id !== id);
		this.model.cropAreas = this.model.cropAreas.filter((a) => a.cropId !== id);
	}

	cropArea(nodeId: string, cropId: string): number {
		return this.model.cropAreas.find((a) => a.nodeId === nodeId && a.cropId === cropId)?.areaM2 ?? 0;
	}

	/** Set a farm × crop area; 0 removes the row so the saved document stays sparse. */
	setCropArea(nodeId: string, cropId: string, areaM2: number) {
		const list = this.model.cropAreas;
		const i = list.findIndex((a) => a.nodeId === nodeId && a.cropId === cropId);
		if (!areaM2) {
			if (i >= 0) list.splice(i, 1);
		} else if (i >= 0) {
			list[i]!.areaM2 = areaM2;
		} else {
			list.push({ nodeId, cropId, areaM2 });
		}
	}

	// --- transfers ------------------------------------------------------
	addTransfer() {
		const [a, b] = this.model.nodes;
		const t = newTransfer(a?.id ?? '', b?.id ?? a?.id ?? '');
		// Served after the rules already there, as a new rule was before priorities (Q18).
		if (this.model.transfers.length) t.priority = Math.max(...this.model.transfers.map((x) => x.priority)) + 1;
		this.model.transfers.push(t);
		return t;
	}

	removeTransfer(id: string) {
		this.model.transfers = this.model.transfers.filter((t) => t.id !== id);
	}
}
