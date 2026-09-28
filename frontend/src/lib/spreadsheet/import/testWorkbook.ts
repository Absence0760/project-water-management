// Test support: small synthetic b023 workbooks built in memory with
// XLSX.utils, named ranges included. Invented values only. Not imported by
// app code. The layout deliberately puts tables at other cells than the real
// workbooks do: the importer must find everything through the named ranges.
import { toEpochDay } from '@water-management/engine';
import * as XLSX from 'xlsx';
import { sheetjsSource } from './sheetjsReference';
import type { WorkbookSource } from './source';

export type TestValue = number | string | boolean | null | { date: string; fmt?: string } | { serial: number; fmt: string } | { error: number };

const MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
const CAL = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Excel serial (1900 date system) of an ISO date. */
export function serialOf(iso: string): number {
	return toEpochDay(iso) + 25569;
}

function cellObject(v: Exclude<TestValue, null>): XLSX.CellObject {
	if (typeof v === 'number') return { t: 'n', v };
	if (typeof v === 'string') return { t: 's', v };
	if (typeof v === 'boolean') return { t: 'b', v };
	if ('error' in v) return { t: 'e', v: v.error };
	if ('serial' in v) return { t: 'n', v: v.serial, z: v.fmt };
	return { t: 'n', v: serialOf(v.date), z: v.fmt ?? 'yyyy/mm/dd;@' };
}

export class WorkbookBuilder {
	private readonly sheets = new Map<string, Map<string, XLSX.CellObject>>();
	private readonly names = new Map<string, string>();

	sheet(name: string): this {
		if (!this.sheets.has(name)) this.sheets.set(name, new Map());
		return this;
	}

	set(sheet: string, addr: string, v: TestValue): this {
		this.sheet(sheet);
		const cells = this.sheets.get(sheet)!;
		if (v === null) cells.delete(addr);
		else cells.set(addr, cellObject(v));
		return this;
	}

	/** Values across from `addr`. */
	row(sheet: string, addr: string, values: TestValue[]): this {
		const { r, c } = XLSX.utils.decode_cell(addr);
		values.forEach((v, i) => this.set(sheet, XLSX.utils.encode_cell({ r, c: c + i }), v));
		return this;
	}

	/** Values down from `addr`. */
	col(sheet: string, addr: string, values: TestValue[]): this {
		const { r, c } = XLSX.utils.decode_cell(addr);
		values.forEach((v, i) => this.set(sheet, XLSX.utils.encode_cell({ r: r + i, c }), v));
		return this;
	}

	name(name: string, ref: string): this {
		this.names.set(name, ref);
		return this;
	}

	unname(name: string): this {
		this.names.delete(name);
		return this;
	}

	/** The workbook as the parser reads it (a SheetJS workbook behind WorkbookSource). */
	build(): WorkbookSource {
		return sheetjsSource(this.book());
	}

	/** A sparse (non-dense) SheetJS WorkBook, as XLSX.utils makes by default. */
	book(): XLSX.WorkBook {
		const wb = XLSX.utils.book_new();
		for (const [name, cells] of this.sheets) {
			const ws: XLSX.WorkSheet = {};
			let maxR = 0;
			let maxC = 0;
			for (const [addr, cell] of cells) {
				ws[addr] = cell;
				const { r, c } = XLSX.utils.decode_cell(addr);
				maxR = Math.max(maxR, r);
				maxC = Math.max(maxC, c);
			}
			ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
			XLSX.utils.book_append_sheet(wb, ws, name);
		}
		wb.Workbook = { Names: [...this.names].map(([Name, Ref]) => ({ Name, Ref })) };
		return wb;
	}

	/** The workbook as .xlsx bytes, for readWorkbook(). */
	toFile(): Uint8Array<ArrayBuffer> {
		return XLSX.write(this.book(), { type: 'array', bookType: 'xlsx' }) as Uint8Array<ArrayBuffer>;
	}
}

export interface SyntheticOptions {
	start?: string;
	/** Daily rain, one per day; its length sets the record length. */
	rain?: (number | null)[];
	gauge?: (number | null)[];
	logger?: (number | null)[];
	pitman?: (number | null)[];
}

/**
 * A minimal complete b023 workbook: Farm A → Farm B → Outlet (gauge), two
 * crops, one transfer Farm A → Farm B, five days of data from 2010-01-01.
 */
export function syntheticB023(opts: SyntheticOptions = {}): WorkbookBuilder {
	const b = new WorkbookBuilder();
	const start = opts.start ?? '2010-01-01';
	const rain = opts.rain ?? [0, 5, 12.5, 0, 1];
	const days = rain.length;

	b.set('AppSettings', 'C11', 'b022').name('zAppVer', 'AppSettings!$C$11');
	b.col('AppSettings', 'C96', CAL).col('AppSettings', 'D96', [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
	b.name('rAppSet_MonthLbls', 'AppSettings!$C$96:$C$107').name('zAppSet_MonthDays', 'AppSettings!$D$96:$D$107');

	// [Network]: names J26…, types K, upstream M..O, outflow J33.
	b.col('Network', 'J25', ['Element', 'Farm A', 'Farm B', 'Outlet', '-- do NOT delete this row']);
	b.col('Network', 'K25', ['Type', 'Farm', 'Farm', 'Gauge', '--']);
	b.set('Network', 'M27', 'Farm A').set('Network', 'M28', 'Farm B').set('Network', 'J33', 'Outlet');
	b.name('zNetwork_ElementNameLst', 'Network!$J$25:$J$31')
		.name('zNetwork_ElementTypeLst', 'Network!$K$25:$K$31')
		.name('zNetwork_UpstreamTbl', 'Network!$M$25:$O$31')
		.name('zNetwork_OutflowGauge', 'Network!$J$33');

	// [Farm spec]: names D30…, one column per parameter.
	const fs = "'Farm spec'";
	b.col('Farm spec', 'D29', ['Farm', 'Farm A', 'Farm B', '--']);
	b.set('Farm spec', 'F27', 12).col('Farm spec', 'F30', [5, 7]);
	b.col('Farm spec', 'I30', [4, 5]).col('Farm spec', 'J30', [1, 2]);
	b.set('Farm spec', 'M27', 'Area').set('Farm spec', 'I27', 0.8).set('Farm spec', 'J27', 0.2);
	b.col('Farm spec', 'M4', ['Area', 'Hi/Lo', 'Specific']).set('Farm spec', 'M24', 0.0002);
	b.col('Farm spec', 'L30', [0.5, 0.5]).col('Farm spec', 'M30', [0.4, 0.6]);
	b.col('Farm spec', 'N30', [1, 0.5]).col('Farm spec', 'O30', [0.2, 0.3]);
	b.col('Farm spec', 'P30', [100000, 0]).col('Farm spec', 'Q30', [0.5, 0]);
	b.col('Farm spec', 'R30', [0.3, 0]).col('Farm spec', 'S30', [0.2, 0]).col('Farm spec', 'T30', [1000, 0]);
	b.name('zFarmSpec_FarmNameLst', `${fs}!$D$29:$D$33`)
		.name('rFarmSpec_AreaTotal', `${fs}!$F$27`)
		.name('rFarmSpec_DataAreas', `${fs}!$I$30:$J$33`)
		.name('rFarmSpec_SelectedMethod', `${fs}!$M$27`)
		.name('rFarmSpec_Methods', `${fs}!$M$4:$M$6`)
		.name('rFarmSpec_FragmentationTolerance', `${fs}!$M$24`)
		.name('zFarmSpec_PercFragmLst', `${fs}!$M$30:$M$33`)
		.name('zFarmSpec_PercUpstrInflowToDamLst', `${fs}!$N$30:$N$33`)
		.name('zFarmSpec_PercFarmRunoffToDamList', `${fs}!$O$30:$O$33`)
		.name('zFarmSpec_CompositeDamVol', `${fs}!$P$30:$P$33`)
		.name('zFarmSpec_StartStoragePercLst', `${fs}!$Q$30:$Q$33`)
		.name('zFarmSpec_CompositeDamMinPerc', `${fs}!$R$30:$R$33`)
		.name('zFarmSpec_PercIrrReturnFlow', `${fs}!$S$30:$S$33`)
		.name('zFarmSpec_DiversionToDam', `${fs}!$T$30:$T$33`);

	// [Crop demand]: crops D30…, factors from F (header row 29), A-pan row 20, effective rain F23.
	const cd = "'Crop demand'";
	b.col('Crop demand', 'D29', ['Crop', 'Maize', 'Wheat', '--']);
	b.row('Crop demand', 'E29', ['Area', ...MONTHS]);
	b.row('Crop demand', 'F30', [0.3, 0.5, 0.8, 1.1, 1.1, 0.9, 0.5, 0.3, 0, 0, 0, 0.1]);
	b.row('Crop demand', 'F31', [0.9, 1, 0.8, 0.2, 0, 0, 0.2, 0.5, 0.7, 0.9, 1, 1]);
	b.set('Crop demand', 'D20', 'A-pan evaporation').set('Crop demand', 'E20', '(mm)');
	b.row('Crop demand', 'F20', [150, 190, 230, 240, 200, 170, 120, 90, 70, 75, 95, 120]);
	b.set('Crop demand', 'F23', 0.7);
	b.name('zCropDemand_CropNameLst', `${cd}!$D$29:$D$33`)
		.name('zCropDemand_FactorsTbl', `${cd}!$E$29:$R$33`)
		.name('rCropDemand_EffectiveRainfall', `${cd}!$F$23`);

	// [Farm demand]: farms D25…, crop header G24:H24, areas below.
	const fd = "'Farm demand'";
	b.col('Farm demand', 'D24', ['Farm', 'Farm A', 'Farm B', '--']).row('Farm demand', 'G24', ['Maize', 'Wheat']);
	b.row('Farm demand', 'G25', [10000, 0]).row('Farm demand', 'G26', [0, 5000]);
	b.name('zFarmDemand_FarmNameLst', `${fd}!$D$24:$D$28`)
		.name('zFarmDemand_CropNameLst', `${fd}!$G$24:$H$24`)
		.name('zFarmDemand_GrossMth', `${fd}!$Q$24:$AB$28`);

	// [Transfers]: labels in N, one draw column per source farm (O, P), InOut J..K, formula text row 8.
	b.col('Transfers', 'N10', ['Dam capacity (m3): ', 'Min capacity (%): ', 'Transfer To: ', 'Direction: ', 'Transfer months: ', 'Max Transfer to Farm (m³/s): ', 'Transfer capacity max: ']);
	b.row('Transfers', 'I19', ['|', 'Farm A', 'Farm B', null, null, '|', 'Farm A', 'Farm B', '|']);
	b.set('Transfers', 'O11', 0.2).set('Transfers', 'O12', 'Farm B').set('Transfers', 'O14', '1,2,3').set('Transfers', 'O15', 0.1);
	b.set('Transfers', 'P12', '--').set('Transfers', 'P15', 0);
	b.row('Transfers', 'I8', ['|', '=P7-O7', '=O7-P7', null, null, '|', "=IF(fIsMthIn($H7, O$14), fGetTrfVolCapped('Farm A'!Q6,O$10,O$11,O$16), 0)", '=0', '|']);
	b.name('zTransfers_HeaderFarmsFrom', 'Transfers!$N$19:$Q$19')
		.name('zTransfers_HeaderFarmsInOut', 'Transfers!$I$19:$N$19')
		.name('zTransfers_FormulaRow', 'Transfers!$H$7:$Q$7')
		.name('zTransfers_FormulasAsTxt', 'Transfers!$I$8:$Q$8');

	b.col('EWR Cfg', 'J88', [900, 1200, 1500, 1500, 1400, 1300, 1100, 900, 800, 700, 700, 800]);
	b.name('zEWR_Pragmatic', "'EWR Cfg'!$J$88:$J$99");

	// [Flow Calibration Cfg]: one cell per parameter in D, tables in F and G.
	const fc = "'Flow Calibration Cfg'";
	const params: [string, number | string][] = [
		['rCalibration_PeakCoef_a', 0.09],
		['rCalibration_PeakExp_b', 1.2],
		['rCalibration_RainThreshold', 2],
		['rCalibration_FactorSummer', 0.1],
		['rCalibration_FactorWinter', 1],
		['rCalibration_MinFlowRatioToResetBase', 1.5],
		['rCalibration_WinterTodayThresh', 10],
		['rCalibration_WinterNextDayThresh', 20],
		['rCalibration_ShiftPeakIndexLo', 1],
		['rCalibration_ShiftPeakIndexHi', 30],
		['rCalibration_Amplitude', 50000],
		['rCalibration_DaysMax', 5],
		['rCalibration_SummerMths', '10,11,12,1,2,3']
	];
	params.forEach(([n, v], i) => b.set('Flow Calibration Cfg', `D${20 + i}`, v).name(n, `${fc}!$D$${20 + i}`));
	b.col('Flow Calibration Cfg', 'F20', [0.9, 0.92, 0.94, 0.96, 0.98]).col('Flow Calibration Cfg', 'G20', [5000, 4000, 3000, 2000, 1000]);
	b.name('rCalibration_RecessionFactors', `${fc}!$F$20:$F$24`).name('rCalibration_Curve', `${fc}!$G$20:$G$24`);
	b.set('Flow Calibration Cfg', 'D11', { date: start }).set('Flow Calibration Cfg', 'D12', { date: isoAdd(start, days - 1) });
	b.name('zCalibration_Date1', `${fc}!$D$11`).name('zCalibration_DateN', `${fc}!$D$12`);

	// [Flow data]: header row 19 from E (date), F..K the hydrology columns, rows from 21.
	const fl = "'Flow data'";
	b.row('Flow data', 'E19', ['Date', 'Pitman (m³/s)', 'Gauge (m³/s)', 'Logger (m³/s)', 'Rain (mm)', 'CHIRPS (mm)', 'Forecast (mm)']);
	b.set('Flow data', 'R19', 'Use rain').set('Flow data', 'S20', 250).set('Flow data', 'P13', 2);
	b.set('Flow data', 'C12', { date: isoAdd(start, days - 1) });
	for (let i = 0; i < days; i++) {
		const r = 21 + i;
		b.set('Flow data', `E${r}`, { date: isoAdd(start, i) });
		b.set('Flow data', `F${r}`, opts.pitman?.[i] ?? null);
		b.set('Flow data', `G${r}`, opts.gauge ? (opts.gauge[i] ?? null) : 0.5 + i / 10);
		b.set('Flow data', `H${r}`, opts.logger?.[i] ?? null);
		b.set('Flow data', `I${r}`, rain[i] ?? null);
		b.set('Flow data', `J${r}`, (rain[i] ?? 0) * 0.8);
	}
	b.name('zFlowData_HeaderDate', `${fl}!$E$19`)
		.name('zFlowData_HeaderHydrologyData', `${fl}!$E$19:$K$19`)
		.name('zFlowData_HeaderUseRain', `${fl}!$R$19`)
		.name('zFlowData_DateE_DateSeries', `${fl}!$C$12`)
		.name('rUseFlow', `${fl}!$P$13`);
	return b;
}

export function isoAdd(iso: string, days: number): string {
	return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
