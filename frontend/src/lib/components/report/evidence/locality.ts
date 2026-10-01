// § 1's locality map (report format evidence-12, issue #326 A5;
// docs/evidence-pack.md § The locality map): what the section shows. The
// figure is the engine's SVG string (localityMapSvg), shown as an image from a
// data: URL, so the page and the server's PDF print exactly the bytes whose
// SHA-256 the pack's manifest names, and no markup is ever parsed into the
// page (rawHtml.test.ts): the SVG is an image, which runs no script and loads
// nothing. Its legend, labels and notes follow as text for a screen reader
// (visually hidden: the image prints them).
import { localityMapSvg, type EvidenceReport, type LocalityFigure } from '@water-management/engine';

export const LOCALITY_NONE = 'No locality map: the project has no map features.';
export const LOCALITY_NOT_IN_PACK = 'No locality map: this pack was drafted before the report carried one (report format evidence-12), so it isn’t part of the pack.';

export type LocalityView =
	| { kind: 'figure'; figure: LocalityFigure; src: string; alt: string; svgSha256: string | null; asOf: string }
	| { kind: 'none'; text: string };

/** The section's figure, or why there is none. `frozen`: an evidence pack's report, which may predate the figure. */
export function localityView(report: Pick<EvidenceReport, 'localityMap' | 'mode'>, frozen: boolean): LocalityView {
	const loc = report.localityMap;
	if (loc === undefined) return { kind: 'none', text: frozen ? LOCALITY_NOT_IN_PACK : LOCALITY_NONE };
	if (loc === null) return { kind: 'none', text: LOCALITY_NONE };
	const figure = localityMapSvg(loc);
	return {
		kind: 'figure',
		figure,
		src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(figure.svg)}`,
		alt: `Locality map of the ${report.mode === 'application' ? 'application' : 'catchment'}, north up, drawn from the project’s map features; its legend, labels and notes follow as text.`,
		svgSha256: loc.svgSha256,
		asOf: loc.asOf
	};
}
