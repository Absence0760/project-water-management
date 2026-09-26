// Prints the figures the farmer-view prototype shows, from a real engine run
// of the synthetic Sandspruit example (backend/scripts/examples), so the
// prototype never tells a story the engine can't (docs/design/farmer-view.md
// §11, finding F3). Design aid only: not part of any build or test.
//
//   pnpm -C backend exec tsx ../docs/design/farmer-view-prototype/figures.ts [farm] [end]
//
// Defaults: farm "Vaalbank", season 1 Oct 2023 to end 2024-01-10.
import { buildExamples } from '../../../backend/scripts/examples/catchments.ts';
import { runModel, type ModelInput } from '../../../packages/engine/src/index.ts';

const farmName = process.argv[2] ?? 'Vaalbank';
const end = process.argv[3] ?? '2024-01-10';
const endYear = Number(end.slice(0, 4));
const seasonStart = `${Number(end.slice(5, 7)) >= 10 ? endYear : endYear - 1}-10-01`;
const lastYear = (d: string) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;

const ex = buildExamples().find((e) => e.model.nodes.some((n) => n.name === farmName));
if (!ex) throw new Error(`no example farm ${farmName}`);
const series: ModelInput['series'] = {};
for (const s of ex.series) series[s.kind] ??= { startDate: s.startDate, values: s.values };
const out = runModel({ settings: { ...ex.settings, reportStart: seasonStart, reportEnd: end }, model: ex.model, series });

const start = ex.series[0]!.startDate;
const dayMs = 86_400_000;
const idx = (d: string) => Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / dayMs);
const iso = (i: number) => new Date(Date.parse(`${start}T00:00:00Z`) + i * dayMs).toISOString().slice(0, 10);
const farm = ex.model.nodes.find((n) => n.name === farmName)!;
const get = (key: string) => out.series.find((s) => s.nodeId === farm.id && s.key === key)!.values;
const sum = (v: number[], a: string, b: string) => v.slice(idx(a), idx(b) + 1).reduce((t, x) => t + x, 0);
const [demand, supplied, storage, spill, deficit, charge] = ['demand', 'supplied', 'dam_storage', 'spill', 'deficit', 'ewr_charge'].map(get);
const e = idx(end);
const pct = (i: number) => (100 * storage![i]!) / farm.damCapacityM3;
const stop = farm.damCapacityM3 * farm.damMinPct;
const last30 = iso(e - 29);
const use14 = sum(supplied!, iso(e - 13), end) / 14;
const days = (pred: (i: number) => boolean) => Array.from({ length: e - idx(seasonStart) + 1 }, (_, k) => idx(seasonStart) + k).filter(pred);
const cf = out.summary.curtailment!.farms.find((f) => f.nodeId === farm.id)!;
const charged = days((i) => charge![i]! < -1e-9).length;
const byId = new Map(ex.model.nodes.map((n) => [n.id, n]));
const up = (id: string): string[] => ex.model.nodes.filter((n) => n.downstreamNodeId === id).flatMap((n) => [n.id, ...up(n.id)]);
const down = (id: string): string[] => { const d = byId.get(id)?.downstreamNodeId; return d ? [d, ...down(d)] : []; };
const isFarm = (id: string) => byId.get(id)?.kind === 'farm';

console.log({
	farm: farmName, catchment: ex.name, season: `${seasonStart}..${end}`,
	seasonNeedM3: Math.round(sum(demand!, seasonStart, end)), seasonGotM3: Math.round(sum(supplied!, seasonStart, end)),
	last30NeedM3: Math.round(sum(demand!, last30, end)), last30GotM3: Math.round(sum(supplied!, last30, end)),
	shortDays: days((i) => deficit![i]! > 1e-6).map(iso), shortDaysAboveStop: days((i) => deficit![i]! > 1e-6 && storage![i]! > stop + 1e-3).length,
	damPct: pct(e), damPct30dAgo: pct(e - 30), damM3: storage![e], usableM3: Math.max(storage![e]! - stop, 0), stopPct: farm.damMinPct * 100,
	use14M3Day: use14, usableDaysAtUse14: Math.max(storage![e]! - stop, 0) / use14,
	lastSpill: iso(spill!.slice(0, e + 1).findLastIndex((x) => x > 1e-6)),
	lastSeasonFraction: sum(supplied!, lastYear(seasonStart), lastYear(end)) / sum(demand!, lastYear(seasonStart), lastYear(end)), lastSeasonDamPct: pct(idx(lastYear(end))),
	equitableFraction: out.summary.curtailment!.equitableFraction, curtailment: cf, chargedDays: charged,
	perChargedDaySupplyCutM3: (-(cf.ewrSupplyCutM3Day ?? 0) * out.summary.curtailment!.days) / charged,
	perChargedDayStorageM3: (-(cf.ewrChargeStorageM3Day ?? 0) * out.summary.curtailment!.days) / charged,
	headlineFraction: (cf.suppliedM3Day + (cf.ewrSupplyCutM3Day ?? 0)) / cf.demandM3Day,
	farmsUpstream: up(farm.id).filter(isFarm).length, farmsDownstream: down(farm.id).filter(isFarm).length,
	sites: out.summary.curtailment!.ewrSites?.map((s) => ({ site: byId.get(s.nodeId)?.name, daysNotMet: s.daysNotMet, naturalM3Day: s.naturalM3Day }))
});
