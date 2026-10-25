// The line under an interactive chart (LineChart.svelte): how to zoom and
// move through it, worded for the reader's pointer (issue #586). uPlot's zoom
// box and its double-click reset listen to mouse events, and the Shift+drag
// pan needs a Shift key, so on a touch screen a drag scrolls the page and
// neither gesture exists: a tap moves the cursor (the values in the legend),
// and Earlier / Later are the way through the record. The chart shows the
// `fine` words under `(pointer: fine)` and the `touch` words otherwise.

export interface ZoomHint {
	/** A mouse or trackpad. */
	fine: string;
	/** A touch screen: no drag zoom, no Shift key. */
	touch: string;
}

/** The hint for a chart; `pannable` is a daily chart with Earlier / Later and Shift+drag. */
export function zoomHint(pannable: boolean): ZoomHint {
	return pannable
		? {
				fine: 'Drag across the chart to zoom, then Shift+drag (or Earlier / Later) to move through the record; double-click for the full period.',
				touch: 'Tap the chart to read its values; Earlier / Later move through the record.'
			}
		: { fine: 'Drag across the chart to zoom; double-click to reset.', touch: 'Tap the chart to read its values.' };
}
