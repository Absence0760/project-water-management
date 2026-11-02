// Types for the modules the Map's upload imports that ship none of their own
// (upload/proj4lite.ts, upload/shapefile.ts).

// parsedbf 2.0.0: a shapefile's .dbf rows, decoded with the .cpg's code page when given.
declare module 'parsedbf' {
	export default function parseDbf(dbf: DataView, cpg?: string): Record<string, unknown>[];
}

// proj4 2.22.0's own modules, imported one by one so the upload carries only
// the projections it registers (upload/proj4lite.ts).
declare module 'proj4/lib/core.js' {
	import type { Converter } from 'proj4';
	export default function core(from: string, to: string): Converter;
}
declare module 'proj4/lib/Proj.js' {
	interface Proj {
		projName?: string;
		a?: number;
		datum?: { datum_type?: number };
	}
	const Proj: {
		new (def: string): Proj;
		projections: { add(projection: unknown): void };
	};
	export default Proj;
}
declare module 'proj4/lib/projections/*' {
	const projection: unknown;
	export default projection;
}
