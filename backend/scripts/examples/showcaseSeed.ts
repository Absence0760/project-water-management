// Seeds the showcase example (showcase.ts) for demo@example.com, with data
// behind every workspace tab: named runs (one before the GR4J fit, the
// calibrated baseline, a forecast run), a published run with a notice,
// scenarios that each change something different with their runs, a
// cumulative assessment, a sensitivity sweep, a seasonal outlook and a yield
// analysis, an applicant's submitted application, the map, registered water
// use, an evidence pack draft, notes, alert rules, a data feed, a share link
// and a report schedule. What it holds, tab by tab: docs/run-locally.md
// § The showcase.
//
// Almost everything goes through the app's own API (./api.ts), as a click
// would, so it is checked, audited and stored exactly as the app stores it;
// every run is the real engine's. The project is built under a working name
// and renamed when it is complete, so an interrupted seed is found and
// replaced by the next one instead of being left half made.
import { declaredRuleRequest, runEnsemble, type ProjectModel, type ScenarioOp } from '@water-management/engine';
import { withoutUser, withUser } from '../../src/db/tx.js';
import { claimJobs } from '../../src/jobs/queue.js';
import { DEFAULT_LEASE_SECONDS, runJob } from '../../src/jobs/runner.js';
import { findOwnedProject, importProjectData } from '../import-project.js';
import { apiAs } from './api.js';
import type { ExampleMapFeature } from './map.js';
import { buildShowcase, SHOWCASE_NAME, SHOWCASE_UNCERTAINTY_RULE, showcaseNodeId, UNITS } from './showcase.js';
import { SHOWCASE_MAP_FILE, showcaseMap } from './showcaseMap.js';

/** The name the project has until its seeding finishes. */
export const SHOWCASE_WORKING_NAME = `${SHOWCASE_NAME} (seeding…)`;

type User = { email: string; password: string; displayName: string };
export interface ShowcaseDeps {
	demo: User;
	analyst: User;
	farmers: readonly User[];
	applicant: User;
	userId: (email: string) => Promise<string>;
	ensureUser: (u: User) => Promise<string>;
	linkFarmer: (ownerEmail: string, projectId: string, farmerId: string, farm: string, role?: 'farmer' | 'contributor') => Promise<void>;
	seedMap: (ownerEmail: string, projectId: string, fileName: string, features: ExampleMapFeature[]) => Promise<void>;
}

/** The scenarios the showcase compares, each changing one kind of thing on the calibrated baseline. */
export function showcaseScenarios(model: Pick<ProjectModel, 'nodes' | 'crops'>): { name: string; description: string; ops: ScenarioOp[] }[] {
	const crop = (name: string) => model.crops.find((c) => c.name === name)!.id;
	const node = (name: string) => model.nodes.find((n) => n.name === name)!.id;
	const middle = node(UNITS.middle);
	return [
		{
			name: 'Raise the Kransdal dam',
			description: 'Invented: raise the headwater dam from 600 000 to 900 000 m³ (a bigger dam).',
			ops: [{ op: 'node.set', nodeId: node(UNITS.upper), field: 'damCapacityM3', value: 900_000 }]
		},
		{
			name: 'New feedlot at Vleiplaas',
			description: 'Invented: a new 250 m³/day feedlot supplied before the crops (a new demand).',
			ops: [
				{
					op: 'demandObject.add',
					demandObject: {
						id: showcaseNodeId('scenario:feedlot'),
						nodeId: middle,
						name: 'Feedlot',
						category: 'livestock',
						sizing: 'monthly',
						monthlyM3Day: new Array(12).fill(250),
						count: null,
						litresPerUnitDay: null,
						lossPct: 0,
						monthlyFactor: null,
						returnPct: 0,
						priority: 'first',
						rank: 1,
						destination: 'internal',
						enabled: true,
						schedule: null,
						population: null,
						source: null,
						waterSource: null,
						riverPumpM3Day: null,
						riverPoolM3: null,
						note: 'Invented scenario demand.'
					}
				}
			]
		},
		{
			name: 'WUA drought restrictions',
			description: 'Invented: the WUA cuts crops by 20 % when the farm dams are below half full and by 40 % (and industry by 30 %) below 30 %, reviewed each season.',
			ops: [
				{
					op: 'settings.set',
					path: 'droughtRestriction',
					value: {
						reviewDates: ['10-01', '01-01', '04-01', '07-01'],
						levels: [
							{ label: 'Level 1', belowPct: 0.5, cuts: { crops: 0.2 } },
							{ label: 'Level 2', belowPct: 0.3, cuts: { crops: 0.4, industrial: 0.3 } }
						],
						source: 'Invented WUA decision (demo)'
					}
				}
			]
		},
		{
			name: 'Vleiplaas swaps maize for citrus',
			description: 'Invented: the 40 ha of maize replaced by 30 ha of citrus (a crop change).',
			ops: [
				{ op: 'cropArea.set', nodeId: middle, cropId: crop('Maize'), areaM2: 0 },
				{ op: 'cropArea.set', nodeId: middle, cropId: crop('Citrus'), areaM2: 300_000 }
			]
		},
		{
			name: 'Drier climate (−15 % rain)',
			description: 'Invented: every day’s catchment rain 15 % lower (a climate stress test).',
			ops: [{ op: 'series.scale', kind: 'rain_catchment_mm', factor: 0.85 }]
		}
	];
}

/**
 * The demo applicant's application on Vleiplaas: raise its dam by half, and pass the EWR through it before
 * storing. Vleiplaas's dam sits on the river (it takes its whole upstream inflow, with no River to dam) and
 * the unit has no river pump, so a hands-off flow (`handsOffEwr`) would bind nothing there (docs/model.md
 * §2.7h): an on-channel dam passes the EWR by a pass-inflow release with no monthly amounts, whose target is
 * the EWR required at the unit (§2.7a). No outlet capacity, so nothing caps the release below its target.
 */
export function showcaseApplication(model: Pick<ProjectModel, 'nodes'>): { name: string; description: string; ops: ScenarioOp[] } {
	const middle = model.nodes.find((n) => n.name === UNITS.middle)!;
	return {
		name: 'Raise the Vleiplaas dam',
		description: 'Demo application: raise the farm dam by half, releasing the EWR through it before storing (invented).',
		ops: [
			{ op: 'node.set', nodeId: middle.id, field: 'damCapacityM3', value: middle.damCapacityM3 * 1.5 },
			{ op: 'node.set', nodeId: middle.id, field: 'damReleaseRule', value: 'passInflow' },
			// null: the release's target is the EWR required at the unit, not monthly amounts.
			{ op: 'node.set', nodeId: middle.id, field: 'damReleaseM3Day', value: null }
		]
	};
}

/** Run the project's queued jobs (sweep, outlook, yield, alert checks) here, as the worker would. */
async function runProjectJobs(projectId: string): Promise<number> {
	let n = 0;
	for (;;) {
		const [job] = await withoutUser((db) => claimJobs(db, 1, DEFAULT_LEASE_SECONDS, [projectId]));
		if (!job) return n;
		const outcome = await runJob(job);
		// 'released': a feed backfill handing its next window to a later tick, as it does in the app.
		if (outcome !== 'done' && outcome !== 'released') throw new Error(`the showcase's ${job.kind} job ended ${outcome}`);
		n++;
	}
}

export async function seedShowcase(d: ShowcaseDeps): Promise<string | null> {
	if (await findOwnedProject(d.demo.email, SHOWCASE_NAME)) return null;
	const demo = await d.userId(d.demo.email);
	const api = await apiAs(demo);
	// An earlier seed that stopped part way: start again.
	const stale = await findOwnedProject(d.demo.email, SHOWCASE_WORKING_NAME);
	if (stale) {
		try {
			await api('DELETE', `/projects/${stale}`);
		} catch (err) {
			// Stopped after the evidence nomination: the app keeps that project for good, so set it aside by name.
			const aside = `${SHOWCASE_NAME} (interrupted seed ${new Date().toISOString().slice(0, 16)})`;
			await api('PATCH', `/projects/${stale}`, { name: aside });
			console.warn(`an interrupted showcase seed can't be deleted (${(err as Error).message.slice(0, 120)}…): renamed it “${aside}”`);
		}
	}

	const ex = buildShowcase();
	const { gr4j, fitRecord, ...unfitted } = ex.settings;
	const id = await importProjectData({ ...ex, name: SHOWCASE_WORKING_NAME, settings: unfitted }, d.demo.email);
	const at = `/projects/${id}`;
	// The import gives the nodes new ids: look them up by name in the stored model.
	const stored = (await api('GET', `${at}/model`)) as ProjectModel;
	const nodeId = (name: string) => stored.nodes.find((n) => n.name === name)!.id;

	// The demo team (analyst edits through it), the farmers and the applicant.
	await withUser(demo, async (db) => {
		const { rows } = await db.query<{ id: string }>(`SELECT id FROM team WHERE name = 'Demo Catchment Consultants' AND created_by = $1 LIMIT 1`, [demo]);
		if (rows[0]) await db.query('UPDATE project SET team_id = $1 WHERE id = $2', [rows[0].id, id]);
	});
	await api('PATCH', at, { wuaName: 'Kraaispruit Water User Association (invented)' });
	// farmer2 (already on farms in two examples) farms Kransdal and Rivieroewer here; farmer1 stays a one-farm user.
	const farmer = await d.ensureUser(d.farmers[1]!);
	await d.linkFarmer(d.demo.email, id, farmer, UNITS.upper);
	await d.linkFarmer(d.demo.email, id, farmer, UNITS.lower);
	const applicant = await d.ensureUser(d.applicant);
	await d.linkFarmer(d.demo.email, id, applicant, UNITS.middle, 'contributor');

	// The map, then a CHIRPS feed over its boundary and a DWS gauge feed.
	await d.seedMap(d.demo.email, id, SHOWCASE_MAP_FILE, showcaseMap(stored));
	const { features } = await api('GET', `${at}/map/features`);
	const boundary = (features as { id: string; kind: string; updatedAt: string }[]).find((f) => f.kind === 'catchment_boundary')!;
	// Configured but switched off: the synthetic fixtures are recent days, which would stretch this 2010–2024 record
	// across a two-year gap. Switching one on (Settings › Data feeds) fetches them.
	const chirps = (await api('POST', `${at}/feeds/chirps/from-boundary`, { featureId: boundary.id, updatedAt: boundary.updatedAt })).feed;
	await api('PATCH', `${at}/feeds/${chirps.id}`, { enabled: false });
	await api('POST', `${at}/feeds`, { source: 'dws', config: { station: 'Z1H001' }, targetName: 'Outlet weir (DWS feed)', enabled: false });

	// Runs: before the fit, the calibrated baseline, and a forecast run.
	await api('POST', `${at}/runs`, { label: 'Before calibration (GR4J defaults)' });
	await api('PATCH', at, { settings: { gr4j, fitRecord }, reason: 'Applied the automatic GR4J fit (Settings → Fit automatically)' });
	const r2 = (await api('POST', `${at}/runs`, { label: 'Calibrated baseline' })).run.id as string;
	await api('PATCH', `${at}/runs/${r2}`, { pinned: true, notes: 'The baseline every scenario is built on. Calibrated 2011/12–2019/20, 2016/17 excluded.' });
	await api('POST', `${at}/runs`, { label: 'Forecast (next 10 days)', forecast: true });
	await api('POST', `${at}/publication`, {
		runId: r2,
		note: 'Seeded showcase run',
		restriction: { level: 'restricted', pct: 20, notice: { en: 'Dams are below half full: irrigate 20 % less until the next review. (Demo notice.)', af: 'Damme is minder as half vol: besproei 20 % minder tot die volgende hersiening. (Demonstrasie-kennisgewing.)' } }
	});

	// Scenarios on the calibrated baseline, each with its run, and a cumulative assessment of two.
	const sids: string[] = [];
	for (const s of showcaseScenarios(stored)) {
		const sid = (await api('POST', `${at}/scenarios`, { ...s, baseRunId: r2 })).scenario.id as string;
		await api('POST', `${at}/scenarios/${sid}/runs`, { label: s.name });
		sids.push(sid);
	}
	await api('POST', `${at}/assessments`, { name: 'Dam raise and feedlot together', scenarioIds: [sids[0], sids[1]] });

	// The applicant's application: raise their own dam, releasing the EWR through it; run and submitted.
	const asApplicant = await apiAs(applicant);
	const middle = nodeId(UNITS.middle);
	const app = (
		await asApplicant('POST', `${at}/scenarios`, {
			...showcaseApplication(stored),
			baseRunId: r2,
			purposeAndNeed: 'Invented: winter storage for the lucerne on the subsurface drip trial.',
			monitoring: 'Invented: a gauge plate on the dam wall, read weekly.'
		})
	).scenario.id as string;
	await asApplicant('POST', `${at}/scenarios/${app}/runs`, { label: 'Application run' });

	// Background analyses: a sensitivity sweep, a seasonal outlook and the Kransdal dam's firm yield.
	const levels = (key: 'name' | 'label') => [1, 0.9, 0.8].map((f) => ({ [key]: `Demand ${Math.round(f * 100)} %`, ops: [{ op: 'demand.scale', factor: f }] }));
	await api('POST', `${at}/sweeps`, { name: 'Demand sensitivity', baseRunId: r2, members: levels('name') });
	await api('POST', `${at}/outlooks`, { name: 'Coming season', baseRunId: r2, levels: levels('label') });
	await api('POST', `${at}/yield`, { nodeId: nodeId(UNITS.upper), runId: r2, kind: 'firm' });

	// Registered water use: a licence, a registration, a general authorisation for a borehole and a dam's storage.
	const alloc = (b: Record<string, unknown>) => api('POST', `${at}/allocations`, b);
	await alloc({ nodeId: nodeId(UNITS.upper), registrationNo: 'DEMO-0001', holder: 'Kransdal Boerdery (invented)', authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: 420_000, validFrom: '2015-01-01', validTo: '2035-12-31', months: [10, 11, 12, 1, 2, 3], conditions: ['Pass the EWR before storing (invented condition)'] });
	await alloc({ nodeId: middle, registrationNo: 'DEMO-0002', holder: 'Vleiplaas Trust (invented)', authorisation: 'existing_lawful_use', waterSource: 'surface', volumeM3PerYear: 380_000 });
	await alloc({ nodeId: nodeId(UNITS.lower), registrationNo: 'DEMO-0003', holder: 'Rivieroewer (invented)', authorisation: 'registration', waterSource: 'surface', volumeM3PerYear: 300_000 });
	await alloc({ nodeId: nodeId(UNITS.lower), registrationNo: 'DEMO-0004', holder: 'Rivieroewer (invented)', authorisation: 'general_authorisation', waterSource: 'groundwater', volumeM3PerYear: 40_000, purpose: 'livestock' });
	await alloc({ nodeId: nodeId(UNITS.upper), registrationNo: 'DEMO-0005', holder: 'Kransdal Boerdery (invented)', authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: 0, storageM3: 600_000, waterUse: '21b' });
	await api('PUT', `${at}/allocations/viewer-units`, { on: true });

	// Notes on the project, a unit, a run and a scenario.
	await api('POST', `${at}/notes`, { body: 'Invented: site visit planned for March to check the Kransdal spillway.' });
	await api('POST', `${at}/notes`, { body: 'Invented: the river pump at Rivieroewer was replaced in 2022 (3 000 m³/day).', nodeId: nodeId(UNITS.lower) });
	await api('POST', `${at}/notes`, { body: 'Invented: this is the run the WUA saw at its September meeting.', runId: r2 });
	await api('POST', `${at}/notes`, { body: 'Invented: the WUA asked for this one before the AGM.', scenarioId: sids[2] });

	// Alerts: the project's rules, and the demo hydrologist's own subscription.
	await api('PUT', `${at}/alert-rules`, {
		rules: [
			{ kind: 'dam_below', nodeId: nodeId(UNITS.upper), threshold: 0.3, enabled: true },
			{ kind: 'ewr_forecast_fail', threshold: 3, enabled: true },
			{ kind: 'farms_short', threshold: 1, enabled: true }
		]
	});
	await api('PUT', `/me/alerts/${id}`, { items: [{ kind: 'ewr_forecast_fail', mode: 'immediate' }, { kind: 'farms_short', mode: 'daily_digest' }] });

	// Sharing: a read-only link to the published baseline, and a monthly-style report schedule.
	await api('POST', `${at}/share-links`, { label: 'For the WUA committee (demo)', expiresInDays: 90 });
	await api('POST', `${at}/report-schedules`, { frequency: 'weekly', weekday: 1, hour: 7, timezone: 'Africa/Johannesburg', recipients: [demo] });

	const jobs = await runProjectJobs(id);
	// The steps after this can't be undone (a nominated run and a submitted application keep the project for good), so they come last.
	// The baseline's uncertainty ensemble on the declared rule, computed here as the browser does; then the baseline nominated as evidence.
	const { ensemble } = await api('POST', `${at}/runs/${r2}/uncertainty`, { request: declaredRuleRequest(SHOWCASE_UNCERTAINTY_RULE) });
	const { input } = await api('GET', `${at}/runs/${r2}/model-input`);
	const result = runEnsemble(input, ensemble.options);
	await api('POST', `${at}/runs/${r2}/uncertainty/${ensemble.id}/result`, { members: result.members, coverage: result.coverage });
	await api('POST', `${at}/evidence`, { runId: r2, reason: 'Invented: the calibrated baseline the scenarios and the application are judged against' });
	// The evidence report's pack, left a draft (signing and issuing need a two-step sign-in).
	await api('POST', `${at}/packs`, { runId: r2 });

	// Last, since a submitted application keeps the project from being deleted (scenario_guard).
	await asApplicant('POST', `${at}/scenarios/${app}/submit`);
	await api('PATCH', at, { name: SHOWCASE_NAME });
	console.log(`seeded ${SHOWCASE_NAME} (${d.demo.email}; ${jobs} background jobs run)`);
	return id;
}
