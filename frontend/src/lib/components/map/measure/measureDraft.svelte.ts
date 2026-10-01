// Measure on the catchment map (issue #326 A7; docs/maps.md § Measure): the
// drawing mode's plumbing (Draft, draw/attachDrawing.ts, draw/drawLayers.ts)
// reused for a shape that is never saved. A click (or Enter at the
// crosshair) adds a point, the running distance shows as they go; closing
// the shape (a click on the first point, a double click, or Close the
// shape) gives its area. The points can then be dragged, added and removed
// like a drawing's. Nothing here is sent anywhere.
//
// Unlike a drawing, a measurement has nothing to lose, so Escape ends it at
// once without asking (`unsaved` is always false).
import type { MapPosition } from '$lib/api/types';
import { Draft } from '../draw/draft.svelte';
import { DRAW_CHOICES } from '../draw/shape';
import { measureText } from './measure';

/** Drawn as an "other" area: a polygon while it closes, a path until then. */
const MEASURE_CHOICE = DRAW_CHOICES.find((c) => c.id === 'other-area')!;

export class MeasureDraft extends Draft {
	/** Marks the draft as a measurement, for the map's keyboard help (CatchmentMap.svelte). */
	readonly measuring = true;

	override get unsaved() {
		return false;
	}

	/** Start (or start again): no points yet. */
	start() {
		this.draw(MEASURE_CHOICE);
	}

	/** The shape is closed: the result is its area. */
	get closed() {
		return this.phase === 'review' && this.coords.length >= 3;
	}

	get points(): readonly MapPosition[] {
		return this.coords;
	}

	/** The result in one sentence (MeasureBar's live region). */
	get result(): string {
		return measureText(this.coords, this.closed);
	}
}
