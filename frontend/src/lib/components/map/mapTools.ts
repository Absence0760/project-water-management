// The Map tab's tools (docs/ui.md § Map): which tool is on, in words, for the
// strip over the map while one is ("Delineating · Esc to stop"). The draw,
// measure and click bars above the map say how to use the tool; the strip
// only names it where the eye is, on the map, and says how to leave it. Pure:
// MapTab passes in what is on.

/** What the map is doing, as MapTab knows it. */
export interface ToolState {
	measuring: boolean;
	/** The draft's mode (draw/Draft.mode), null when nothing is drawn. */
	mode: 'draw' | 'place' | 'edit' | 'split' | null;
	delineating: boolean;
	dividing: boolean;
	tracing: boolean;
	/** A dam outline traced from the water data, now a drawing to adjust. */
	traced?: boolean;
	/** The feature being edited or split, by name. */
	featureName?: string | null;
}

/**
 * The strip's words, or null when no tool is on. Escape works on the map and
 * in the bars: it ends a measurement or a click mode at once, and cancels a
 * drawing (asking first once there is work to lose), so a drawing says
 * "cancel" and the rest "stop".
 */
export function toolStrip(s: ToolState): string | null {
	if (s.measuring) return 'Measuring · Esc to stop';
	if (s.dividing) return 'Sub-catchments, one per click · Esc to stop';
	switch (s.mode) {
		case null:
			return null;
		case 'place':
			if (s.delineating) return 'Delineating · Esc to stop';
			if (s.tracing) return 'Tracing a dam · Esc to stop';
			return 'Placing a point · Esc to cancel';
		case 'draw':
			return s.traced ? 'Adjusting the traced dam · Esc to cancel' : 'Drawing a shape · Esc to cancel';
		case 'edit':
			return `Editing ${s.featureName ? `“${s.featureName}”` : 'the feature'} · Esc to cancel`;
		case 'split':
			return `Splitting ${s.featureName ? `“${s.featureName}”` : 'the shape'} · Esc to cancel`;
	}
}
