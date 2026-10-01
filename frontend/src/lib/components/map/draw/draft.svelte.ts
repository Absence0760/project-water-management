// The shape being drawn, placed or edited on the catchment map (issue #326 C1,
// D1; docs/ui.md § Map, docs/maps.md § Drawing). One instance per Map tab: the
// map (CatchmentMap.svelte) draws it and turns clicks, drags and keys into the
// calls below; the draw bar (DrawBar.svelte) shows what it is and offers
// Undo, Finish, Save and Cancel; nothing is sent to the server until a save
// sheet's confirm. Every change goes on an undo stack.
import type { MapFeature, MapFeatureKind, MapGeometry, MapPosition } from '$lib/api/types';
import { confirmDialog, type ConfirmOptions } from '$lib/components/common/confirm.svelte';
import { positionText } from '../mapData';
import { canFinish, CORNER, distinctCorners, DRAW_CHOICES, type DrawChoice, type DraftShape, editableCorners, geometryOf, shapeOf, withoutCorner } from './shape';

/** draw: a new line or polygon; place: a new point; edit: an existing feature's shape or position. */
export type DraftMode = 'draw' | 'place' | 'edit';

/** The most changes Undo keeps. */
const UNDO_MAX = 200;

export class Draft {
	mode = $state<DraftMode | null>(null);
	kind = $state<MapFeatureKind>('farm_parcel');
	shape = $state<DraftShape>('polygon');
	/** The draw choice (DRAW_CHOICES id) while drawing a line or polygon. */
	choice = $state('farm_parcel');
	/** The corners: a polygon's are not closed (geometryOf closes it). */
	coords = $state<MapPosition[]>([]);
	/** drawing: corners are being added; review: the shape is closed and can be adjusted, then saved. */
	phase = $state<'drawing' | 'review'>('drawing');
	/** The feature being edited (mode edit). */
	feature = $state<MapFeature | null>(null);
	/** A pasted shape of several parts (or with holes): saved whole, not editable corner by corner. */
	whole = $state<MapGeometry | null>(null);
	/** The picked corner (review), for Delete. */
	corner = $state<number | null>(null);
	/** Where the pointer is while drawing, for the line to it. */
	cursor = $state<MapPosition | null>(null);
	/** The last thing that happened, for a polite live region. */
	said = $state('');
	#asking = false;
	#undo = $state<{ coords: MapPosition[]; phase: 'drawing' | 'review'; whole: MapGeometry | null }[]>([]);

	get active() {
		return this.mode !== null;
	}
	get canUndo() {
		return this.#undo.length > 0;
	}
	/** What saves: the pasted whole shape, else the corners' geometry (null while too few). */
	get geometry(): MapGeometry | null {
		return this.whole ?? geometryOf(this.shape, this.coords);
	}
	get canFinish() {
		return this.phase === 'drawing' && canFinish(this.shape, this.coords);
	}
	get cornerWord() {
		return CORNER[this.shape];
	}
	/**
	 * Work that Escape mustn't drop without asking: an edit with any change, a
	 * finished (or pasted) line or polygon, or one with two corners or more.
	 * A placed point or a single corner is one click to make again.
	 */
	get unsaved() {
		if (!this.active) return false;
		if (this.mode === 'edit') return this.canUndo;
		if (this.shape === 'point') return false;
		return this.whole !== null || this.phase === 'review' || this.coords.length >= 2;
	}

	#reset() {
		this.coords = [];
		this.phase = 'drawing';
		this.feature = null;
		this.whole = null;
		this.corner = null;
		this.cursor = null;
		this.#undo = [];
		this.said = '';
	}

	#record() {
		this.#undo = [...this.#undo.slice(-(UNDO_MAX - 1)), { coords: this.coords.map((p) => [p[0], p[1]] as MapPosition), phase: this.phase, whole: this.whole }];
	}

	/** Start drawing a line or polygon. */
	draw(choice: DrawChoice = DRAW_CHOICES[1]!) {
		this.#reset();
		this.mode = 'draw';
		this.choose(choice.id);
	}

	/** Change what is being drawn; the corners stay (a line becomes a polygon's outline and back). */
	choose(id: string) {
		const c = DRAW_CHOICES.find((x) => x.id === id);
		if (!c) return;
		this.choice = c.id;
		this.kind = c.kind;
		if (c.shape !== this.shape && this.whole) this.whole = null;
		this.shape = c.shape;
	}

	/** Start placing a point of this kind. */
	place(kind: MapFeatureKind = 'gauge') {
		this.#reset();
		this.mode = 'place';
		this.kind = kind;
		this.shape = 'point';
	}

	/** Start editing a feature's shape (or a point's position); false when it has several parts or holes. */
	edit(f: MapFeature): boolean {
		const e = editableCorners(f.geometry);
		if (!e) return false;
		this.#reset();
		this.mode = 'edit';
		this.feature = f;
		this.kind = f.kind;
		this.shape = e.shape;
		this.coords = e.coords;
		this.phase = 'review';
		return true;
	}

	cancel() {
		this.#reset();
		this.mode = null;
	}

	/**
	 * Escape: cancels at once when nothing would be lost, else asks once
	 * ("Discard this drawing?"); a second Escape while the question is up does
	 * nothing more. True when the draft was cancelled. The Cancel button stays
	 * the immediate way out (a named button is a deliberate act; a key can be
	 * a slip).
	 */
	async escape(ask: (o: ConfirmOptions) => Promise<boolean> = confirmDialog): Promise<boolean> {
		if (!this.active || this.#asking) return false;
		if (!this.unsaved) {
			this.cancel();
			return true;
		}
		this.#asking = true;
		const editing = this.mode === 'edit';
		try {
			const ok = await ask({
				title: editing ? 'Discard your changes?' : 'Discard this drawing?',
				message: editing ? 'The changes to this shape haven’t been saved.' : `The ${this.shape === 'polygon' ? 'shape' : 'line'} you drew hasn’t been saved.`,
				confirmLabel: editing ? 'Discard changes' : 'Discard drawing',
				cancelLabel: 'Keep drawing',
				danger: true
			});
			if (!ok || !this.active) return false;
			this.cancel();
			return true;
		} finally {
			this.#asking = false;
		}
	}

	/** A click or Enter while drawing: a corner (a point's position: the point, ready to save). */
	add(p: MapPosition) {
		if (this.shape === 'point') {
			this.#record();
			this.coords = [p];
			this.phase = 'review';
			this.whole = null;
			this.said = `Point at ${positionText(p)}.`;
			return;
		}
		if (this.phase !== 'drawing') return;
		this.#record();
		this.coords = [...this.coords, p];
		this.said = `${cap(this.cornerWord.one)} ${this.coords.length} at ${positionText(p)}.`;
	}

	/** Close the line or polygon: it is drawn, and can be adjusted and saved. */
	finish(): boolean {
		if (!this.canFinish) return false;
		this.#record();
		this.coords = distinctCorners(this.coords, this.shape === 'polygon');
		this.phase = 'review';
		this.cursor = null;
		this.said = `${this.shape === 'polygon' ? 'Shape closed' : 'Line finished'} with ${this.coords.length} ${this.cornerWord.many}. Drag a ${this.cornerWord.one} to adjust it, then save.`;
		return true;
	}

	/** Before a drag: one undo step for the whole drag. */
	beginChange() {
		this.#record();
	}

	/** Move corner i (during a drag; the undo step was taken by beginChange). */
	moveCorner(i: number, p: MapPosition) {
		if (i < 0 || i >= this.coords.length) return;
		this.coords = this.coords.map((c, k) => (k === i ? p : c));
	}

	/** Add a corner after corner `after` (a click on an edge's middle). */
	insertCorner(after: number, p: MapPosition) {
		this.#record();
		this.coords = [...this.coords.slice(0, after + 1), p, ...this.coords.slice(after + 1)];
		this.corner = after + 1;
		this.said = `${cap(this.cornerWord.one)} added; the shape has ${this.coords.length} ${this.cornerWord.many}.`;
	}

	/** Remove corner i, unless the shape would have too few. */
	removeCorner(i: number): boolean {
		const next = withoutCorner(this.shape, this.coords, i);
		if (!next) {
			this.said = `A ${this.shape === 'polygon' ? 'shape' : 'line'} keeps at least ${this.shape === 'polygon' ? 3 : 2} ${this.cornerWord.many}.`;
			return false;
		}
		this.#record();
		this.coords = next;
		this.corner = null;
		this.said = `${cap(this.cornerWord.one)} removed; ${this.coords.length} left.`;
		return true;
	}

	/** A pasted shape replaces the draft: editable when it has one part, else kept whole. False when its shape doesn't fit. */
	replace(g: MapGeometry): boolean {
		const shape = shapeOf(g);
		if (shape !== this.shape) return false;
		this.#record();
		const e = editableCorners(g);
		this.coords = e ? e.coords : [];
		this.whole = e ? null : g;
		this.phase = 'review';
		this.corner = null;
		this.cursor = null;
		this.said = e ? `Pasted: ${this.coords.length} ${this.coords.length === 1 ? this.cornerWord.one : this.cornerWord.many}.` : 'Pasted a shape of several parts.';
		return true;
	}

	/** Undo the last change (while drawing: the last corner). */
	undo() {
		const last = this.#undo.at(-1);
		if (!last) return;
		this.#undo = this.#undo.slice(0, -1);
		this.coords = last.coords;
		this.phase = last.phase;
		this.whole = last.whole;
		this.corner = null;
		this.said = this.coords.length ? `Undone; ${this.coords.length} ${this.coords.length === 1 ? this.cornerWord.one : this.cornerWord.many}.` : 'Undone; nothing drawn yet.';
	}
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
