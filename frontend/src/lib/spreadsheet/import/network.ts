// [Network]: the elements, their kind and which elements drain into which
// (extract_project.py read_network and the downstream links in extract()).
import { clean, isName, pyRepr } from './cells';
import { InvalidWorkbookError } from './errors';
import type { Report } from './report';
import type { B023Workbook } from './workbook';

export interface NetworkElement {
	name: string;
	kind: 'farm' | 'gauge';
	/** Names in the element's "Upstream element" columns. */
	upstream: string[];
}

/** read_network(): the elements in table order and the outflow gauge's name. */
export function readNetwork(wb: B023Workbook, report: Report): { elements: NetworkElement[]; outflow: string } {
	const { sheet, rows, names } = wb.tableRows('zNetwork_ElementNameLst');
	const tc = wb.ref('zNetwork_ElementTypeLst').c1;
	const { c1: uc1, c2: uc2 } = wb.ref('zNetwork_UpstreamTbl');
	const elements: NetworkElement[] = [];
	rows.forEach((r, i) => {
		const name = names[i]!;
		const typeCell = wb.cell(sheet, tc, r);
		const etype = clean(typeCell).toLowerCase();
		// Anything but "Gauge" is a farm, as in the Python; b023 has only the two types.
		if (etype !== 'gauge' && etype !== 'farm') {
			report.unmap({
				code: 'element-type-unknown',
				message: `[Network] ${name} has element type ${etype ? `"${clean(typeCell)}"` : '(blank)'}, which is neither Farm nor Gauge; imported as a farm`,
				sheet,
				element: name,
				text: clean(typeCell)
			});
		}
		const upstream: string[] = [];
		for (let c = uc1; c <= uc2; c++) {
			const v = wb.cell(sheet, c, r);
			if (isName(v)) upstream.push(clean(v));
		}
		elements.push({ name, kind: etype === 'gauge' ? 'gauge' : 'farm', upstream });
	});
	return { elements, outflow: clean(wb.cellNamed('zNetwork_OutflowGauge')) };
}

/**
 * Each element's downstream element, the inverse of the upstream columns
 * (keyed by name; a repeated name keeps its first position, as a Python dict
 * does). An unknown upstream name or an element draining into two stops the
 * import, as in the Python.
 */
export function downstreamLinks(elements: NetworkElement[], outflow: string, report: Report): Map<string, string | null> {
	const known = new Set(elements.map((e) => e.name));
	const downstream = new Map<string, string | null>();
	for (const e of elements) downstream.set(e.name, null);
	for (const e of elements) {
		for (const u of e.upstream) {
			if (!known.has(u)) throw new InvalidWorkbookError(`[Network] ${e.name} lists unknown upstream element ${pyRepr(u)}`, 'Network');
			const already = downstream.get(u);
			if (already !== null && already !== undefined) throw new InvalidWorkbookError(`[Network] ${u} drains into both ${already} and ${e.name}`, 'Network');
			downstream.set(u, e.name);
		}
	}
	const roots = [...downstream].filter(([, d]) => d === null).map(([n]) => n);
	if (outflow && roots.includes(outflow) && roots.length > 1) {
		report.note('several-outlets', `elements ${pyRepr(roots)} have no downstream element; only ${outflow} is the outflow gauge`, { sheet: 'Network' });
	}
	return downstream;
}
