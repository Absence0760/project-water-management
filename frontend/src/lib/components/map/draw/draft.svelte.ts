// The shape being drawn, placed or edited on the catchment map (issue #326 C1,
// D1; docs/ui.md § Map, docs/maps.md § Drawing). One instance per Map tab: the
// map (CatchmentMap.svelte) draws it and turns clicks, drags and keys into the
// calls below; the draw bar (DrawBar.svelte) shows what it is and offers
// Undo, Finish, Save and Cancel; nothing is sent to the server until a save
// sheet's confirm. Every change goes on an undo stack.
//
// Assisted drawing (#326 C2; docs/maps.md § Assisted drawing): a corner
// placed with a snap hit (draw/snap.ts) lands on the other feature's corner
// or edge, and with Follow edges on, two in a row on one outline take the
// corners between them along it; `split` draws the line a polygon is cut
// along (draw/split.ts); `trace` holds a dam outline proposed from the water
// occurrence data as a drawing to adjust, with how it was made.
import type { DamTraceProposal, MapFeature, MapFeatureKind, MapGeometry, MapPosition } from '$lib/api/types';
import { confirmDialog, type ConfirmOptions } from '$lib/components/common/confirm.svelte';
import { areaText, positionText } from '../mapData';
import { shapeAreaM2 } from '../measure/measure';
import { canFinish, CORNER, distinctCorners, DRAW_CHOICES, type DrawChoice, type DraftShape, editableCorners, geometryOf, shapeOf, withoutCorner } from './shape';
import { sameLine, snapLines, traceAlong, type SnapHit } from './snap';
import { splitPolygon, type SplitResult } from './split';

/** draw: a new line or polygon; place: a new point; edit: an existing feature's shape or position; split: the line a polygon is cut along. */
export type DraftMode = 'draw' | 'place' | 'edit' | 'split';

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
	/** Snap corners to the other features' corners and edges (#326 C2); off in the draw bar, or for one click with Alt held. */
	snapOn = $state(true);
	/** Two corners in a row on one outline or line take the corners between them along it (polygons and lines being drawn; never a split's cut). */
	follow = $state(true);
	/** The features a corner can snap to (the tab's list); the one being edited is left out. */
	snapFeatures = $state.raw<readonly MapFeature[]>([]);
	/** Where the pointer would snap now (drawn as a ring on the map), or null. */
	snapHint = $state.raw<SnapHit | null>(null);
	/** A dam outline traced from the water occurrence data (#326 C2), while it is this drawing: how it was made, saved with it. */
	traced = $state.raw<DamTraceProposal | null>(null);
	#tracedAs: string | null = null;
	#asking = false;
	/** Each corner's snap hit while drawing (parallel to coords), for Follow edges. */
	#hits: (SnapHit | null)[] = [];
	#undo = $state<{ coords: MapPosition[]; phase: 'drawing' | 'review'; whole: MapGeometry | null; hits: (SnapHit | null)[] }[]>([]);

	/** What a corner can snap to now. */
	readonly snapTargets = $derived(snapLines(this.snapFeatures, this.mode === 'edit' ? (this.feature?.id ?? null) : null));

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
		this.#hits = [];
		this.snapHint = null;
		this.traced = null;
		this.#tracedAs = null;
		this.said = '';
	}

	#record() {
		this.#undo = [...this.#undo.slice(-(UNDO_MAX - 1)), { coords: this.coords.map((p) => [p[0], p[1]] as MapPosition), phase: this.phase, whole: this.whole, hits: [...this.#hits] }];
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
		// A traced outline is a dam's (or an other area's): drawn as anything else it is no longer the trace.
		if (this.traced && c.id !== 'dam' && c.id !== 'other-area') {
			this.traced = null;
			this.said = 'No longer a traced dam outline: it saves as a drawing.';
		}
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

	/**
	 * Start splitting a polygon (#326 C2): draw the line it is cut along, then
	 * the two parts are previewed (`splitResult`) and saved together. False for
	 * a shape that isn't one outline (several parts, holes) or isn't a polygon.
	 */
	split(f: MapFeature): boolean {
		const e = editableCorners(f.geometry);
		if (!e || e.shape !== 'polygon') return false;
		this.#reset();
		this.mode = 'split';
		this.feature = f;
		this.kind = f.kind;
		this.shape = 'line';
		return true;
	}

	/** The polygon cut along the drawn line: its two parts, or why it can't be cut (null while the line is still being drawn). */
	get splitResult(): SplitResult | null {
		if (this.mode !== 'split' || this.phase !== 'review' || !this.feature) return null;
		const e = editableCorners(this.feature.geometry);
		if (!e) return { problem: 'Only a shape of one outline can be split.' };
		return splitPolygon(e.coords, this.coords);
	}

	/**
	 * A traced dam outline (#326 C2) becomes the drawing, ready to adjust and
	 * save as a dam: one undo step back to an empty drawing. `trace` says how
	 * it was made; `tracedEdited` whether it was changed after.
	 */
	trace(g: MapGeometry, trace: DamTraceProposal): boolean {
		this.draw(DRAW_CHOICES.find((c) => c.id === 'dam')!);
		if (!this.replace(g)) return false;
		this.traced = trace;
		this.#tracedAs = JSON.stringify(this.geometry);
		this.said = `Traced a dam outline with ${this.coords.length} corners. Adjust it if it needs it, then save.`;
		return true;
	}

	/** A split's cut is drawn: the live region says what it makes (the parts' areas), or why it can't be cut. */
	#sayCut() {
		const r = this.splitResult;
		if (!r) return;
		this.said = 'parts' in r ? `Cut in two: ${cutText(r.parts)}.` : r.problem;
	}

	/** The traced outline was changed before saving (its method says so). */
	get tracedEdited(): boolean {
		return this.traced !== null && JSON.stringify(this.geometry) !== this.#tracedAs;
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

	/** Whether corners being drawn follow a shared outline between snapped corners: polygons and lines drawn new, never a split's cut or a measurement. */
	get following() {
		return this.follow && this.snapOn && this.mode === 'draw' && !('measuring' in this);
	}

	/**
	 * A click or Enter while drawing: a corner (a point's position: the point,
	 * ready to save). `hit` is where it snapped (draw/snap.ts), when it did:
	 * the live region says so, and with Follow edges on, a corner on the same
	 * outline as the last one brings the corners between them along it.
	 */
	add(p: MapPosition, hit: SnapHit | null = null) {
		const on = hit ? `, on ${hit.line.label}${hit.what === 'corner' ? '’s corner' : '’s edge'}` : '';
		if (this.shape === 'point') {
			this.#record();
			this.coords = [p];
			this.phase = 'review';
			this.whole = null;
			this.said = `Point at ${positionText(p)}${on}.`;
			return;
		}
		if (this.phase !== 'drawing') return;
		this.#record();
		const last = this.#hits.at(-1) ?? null;
		const along = this.following && hit && this.coords.length && sameLine(last, hit) ? traceAlong(hit.line, last!.pos, hit.pos, this.coords.at(-1)!, p) : [];
		this.coords = [...this.coords, ...along, p];
		this.#hits = [...this.#hits, ...along.map(() => null), hit];
		const followed = along.length ? ` (${along.length} ${along.length === 1 ? this.cornerWord.one : this.cornerWord.many} followed along it)` : '';
		this.said = `${cap(this.cornerWord.one)} ${this.coords.length} at ${positionText(p)}${on}${followed}.`;
	}

	/** Close the line or polygon: it is drawn, and can be adjusted and saved. */
	finish(): boolean {
		if (!this.canFinish) return false;
		this.#record();
		// Closing a polygon whose first and last corners sit on one outline follows it too.
		const first = this.#hits[0] ?? null;
		const last = this.#hits.at(-1) ?? null;
		if (this.shape === 'polygon' && this.following && this.coords.length >= 3 && sameLine(last, first) && last !== first) {
			this.coords = [...this.coords, ...traceAlong(last!.line, last!.pos, first!.pos, this.coords.at(-1)!, this.coords[0]!)];
		}
		this.#hits = [];
		this.coords = distinctCorners(this.coords, this.shape === 'polygon');
		this.phase = 'review';
		this.cursor = null;
		this.said = `${this.shape === 'polygon' ? 'Shape closed' : 'Line finished'} with ${this.coords.length} ${this.cornerWord.many}. Drag a ${this.cornerWord.one} to adjust it, then save.`;
		this.#sayCut();
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
		this.#hits = [];
		this.phase = 'review';
		this.corner = null;
		this.cursor = null;
		this.said = e ? `Pasted: ${this.coords.length} ${this.coords.length === 1 ? this.cornerWord.one : this.cornerWord.many}.` : 'Pasted a shape of several parts.';
		this.#sayCut();
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
		this.#hits = last.hits;
		this.corner = null;
		this.said = this.coords.length ? `Undone; ${this.coords.length} ${this.coords.length === 1 ? this.cornerWord.one : this.cornerWord.many}.` : 'Undone; nothing drawn yet.';
	}
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Where a part lies against the other, in words: the bigger difference of their middles, west–east or north–south. */
function sideOf(part: readonly MapPosition[], other: readonly MapPosition[]): string {
	const mid = (c: readonly MapPosition[]) => [c.reduce((s, p) => s + p[0], 0) / c.length, c.reduce((s, p) => s + p[1], 0) / c.length] as const;
	const [ax, ay] = mid(part);
	const [bx, by] = mid(other);
	const dx = (ax - bx) * Math.cos((((ay + by) / 2) * Math.PI) / 180);
	const dy = ay - by;
	return Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'western' : 'eastern') : dy < 0 ? 'southern' : 'northern';
}

/** A split's two parts in words, by where each lies and its area: "part 1, the western, about 51.6 km², and part 2, the eastern, about 51.6 km²". */
export function cutText(parts: readonly [readonly MapPosition[], readonly MapPosition[]]): string {
	return parts.map((p, i) => `part ${i + 1}, the ${partSide(parts, i)}, about ${areaText(shapeAreaM2(p))}`).join(', and ');
}

/** Where part i lies against the other ("western", "northern"). */
export const partSide = (parts: readonly [readonly MapPosition[], readonly MapPosition[]], i: number) => sideOf(parts[i]!, parts[1 - i]!);
