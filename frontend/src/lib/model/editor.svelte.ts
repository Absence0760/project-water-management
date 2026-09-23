// In-memory editor for a project's ProjectModel, shared by the Network, Crops
// and Transfers tabs. Tracks unsaved changes against the last loaded/saved
// snapshot and re-validates on every edit.
import type { CropDef, NetworkNode, ProjectModel, Transfer } from '@water-management/engine';
import { validateModel, type ModelIssue } from './validate';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function emptyModel(): ProjectModel {
	return { nodes: [], crops: [], cropAreas: [], transfers: [] };
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
		pctUpstreamToDam: 0,
		pctRunoffToDam: 0,
		damCapacityM3: 0,
		damInitialPct: 0,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		returnFlowPct: 0
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
		enabled: true
	};
}

export class ModelEditor {
	model = $state<ProjectModel>(emptyModel());
	#saved = $state('');
	saving = $state(false);
	saveError = $state<string | null>(null);

	dirty = $derived(JSON.stringify(this.model) !== this.#saved);
	issues = $derived<ModelIssue[]>(validateModel(this.model));

	load(m: ProjectModel) {
		const normalised: ProjectModel = {
			nodes: m.nodes ?? [],
			crops: m.crops ?? [],
			cropAreas: m.cropAreas ?? [],
			transfers: m.transfers ?? []
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
	}

	// --- crops ----------------------------------------------------------
	addCrop() {
		const c = newCrop();
		c.name = `Crop ${this.model.crops.length + 1}`;
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
		this.model.transfers.push(t);
		return t;
	}

	removeTransfer(id: string) {
		this.model.transfers = this.model.transfers.filter((t) => t.id !== id);
	}
}
