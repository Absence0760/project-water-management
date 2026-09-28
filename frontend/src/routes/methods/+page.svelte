<script lang="ts">
	// How the model is checked: the public summary of the engine audit
	// (docs/engine-audit.md), linked from the landing page's trust strip
	// (issue #57). Written for a hydrologist, an assessor or a farmer deciding
	// whether to trust a result; no client data (the repo and this page are
	// public). The departures are a plain summary with audit ids
	// (lib/methods/departures.ts, tested against the audit); which of them are
	// still pending, and the known limitations list, come from the engine's
	// generated list, the same one every report prints, so this page can't
	// claim a decision is settled when the audit says it isn't. English only,
	// like the other reference pages in this frame.
	import { KNOWN_LIMITATIONS } from '@water-management/engine/limitations';
	import { ENGINE_VERSION } from '@water-management/engine/version';
	import LegalPage from '$lib/components/legal/LegalPage.svelte';
	import { DEPARTURES, openIds } from '$lib/methods/departures';

	const sections = [
		{ id: 'model', label: '1. What the model does' },
		{ id: 'standard', label: '2. The standard it is held to' },
		{ id: 'every-run', label: '3. Checks on every run' },
		{ id: 'tests', label: '4. Checks on every change' },
		{ id: 'departures', label: '5. Where it departs from the spreadsheet' },
		{ id: 'limitations', label: '6. Known limitations' },
		{ id: 'calibration', label: '7. How a fit is scored' },
		{ id: 'reproducible', label: '8. Versions and reproducibility' },
		{ id: 'more', label: '9. The full audit' }
	];
</script>

<LegalPage
	title="How the model is checked"
	description="How Water Management's catchment model is checked: the standard it is held to, the checks on every run, where it departs from the spreadsheet it replaced and why, and its known limitations."
	effective="Engine version {ENGINE_VERSION}"
	{sections}
>
	<p>
		Water Management turns a catchment’s rainfall, dams, farms and river into a daily water balance, and people make decisions with
		it: how much a farm can irrigate, whether the river keeps its Ecological Reserve, whether a licence application holds up. This
		page says how the model behind those figures is checked, where it deliberately differs from the spreadsheet model it replaced,
		and what is still open.
	</p>

	<h2 id="model">1. What the model does</h2>
	<p>For every day of the record, the model:</p>
	<ul>
		<li>turns rainfall into natural river flow with <strong>GR4J</strong>, a published daily rainfall–runoff model, calibrated against measured flow;</li>
		<li>works out each farm’s irrigation demand from its crops, evaporation and the rain that fell;</li>
		<li>routes the water down the network, farm by farm and dam by dam, with transfers between dams, and the dams’ own rain, evaporation and seepage;</li>
		<li>compares the flow at the outlet and at each gauge with the Ecological Reserve, and shares any shortfall among the farms upstream;</li>
		<li>reports each farm’s supply, each dam’s storage and the river’s flow, day by day and in summary.</li>
	</ul>

	<h2 id="standard">2. The standard it is held to</h2>
	<p>
		The model started as a port of a spreadsheet tool. Matching the spreadsheet is <strong>not</strong> the test of whether it is
		right. It is judged against documented hydrology (published methods, cited in the audit) and against invariants: rules that must
		hold on any input, such as water never being created or destroyed.
	</p>
	<p>
		Where the spreadsheet was wrong, the engine replaces it outright; there is no “spreadsheet-compatible” mode. Every such change is
		written down with its reason, and a regression suite compares the engine with the spreadsheet column by column, allowing a
		difference only where a named finding explains it. Any other difference fails the suite.
	</p>

	<h2 id="every-run">3. Checks on every run</h2>
	<p>Every saved run checks its own results before anyone sees them. Among them:</p>
	<ul>
		<li>the water balance closes at every farm on every day: what came in and what was stored equals what left, was used and is stored now;</li>
		<li>supply stays between nothing and the demand, storage between empty and the dam’s capacity, and a dam spills only when full;</li>
		<li>transfers net to zero and respect each dam’s minimum level and the receiving dam’s room;</li>
		<li>each Reserve shortfall is shared out exactly: the farms’ shares and the part nobody caused add up to the whole;</li>
		<li>the report’s totals agree with the daily figures they summarise.</li>
	</ul>
	<p>
		The run also warns about inputs that are impossible or doubtful: more runoff than rain, days with no rainfall value, farm areas
		that don’t add up, gaps filled from satellite rain, and dams whose surface area had to be estimated.
	</p>

	<h2 id="tests">4. Checks on every change</h2>
	<ul>
		<li>
			<strong>Invariant tests</strong> run the model on thousands of randomly generated catchments and check the rules above on every
			day of every one, plus rules about behaviour: more demand never means a higher share of demand met, and the order farms or
			transfers are listed in never changes a result.
		</li>
		<li><strong>An event-scale test</strong> checks that no runoff model returns more water from a storm than fell in it.</li>
		<li>
			<strong>Worked examples</strong> check each finding with a hand-calculated case: every fix was written as a failing test first.
		</li>
		<li>
			<strong>The regression suite</strong> replays a real catchment’s spreadsheet and checks every column against it, within the
			bounds its findings allow. That catchment’s data is private and is not in the public source; the test skips where it is absent.
		</li>
	</ul>

	<h2 id="departures">5. Where it departs from the spreadsheet</h2>
	<p>
		Each row is a finding of the audit, with its id. Some decisions were made on a recommendation and still wait for a hydrologist to
		confirm them; they are marked, and they are also printed on every report (§6).
	</p>
	<div class="stack">
		<table>
			<thead>
				<tr><th scope="col">Finding</th><th scope="col">The spreadsheet</th><th scope="col">The engine</th></tr>
			</thead>
			<tbody>
				{#each DEPARTURES as d (d.ids[0])}
					{@const open = openIds(d, KNOWN_LIMITATIONS)}
					<tr>
						<td data-label="Finding">{d.ids.join(', ')}</td>
						<td data-label="The spreadsheet">{d.was}</td>
						<td data-label="The engine">
							{d.now}
							{#if open.length}<br /><em>Pending a hydrologist’s confirmation ({open.join(', ')}).</em>{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<h2 id="limitations">6. Known limitations</h2>
	<p>
		These audit items are still open: a decision waits on a hydrologist or an assessor, or the engine only warns about the problem.
		Every report’s validation statement and sign-off prints this same list, generated from the audit, so none can be left out quietly.
	</p>
	<div class="stack">
		<table>
			<thead>
				<tr><th scope="col">Item</th><th scope="col">What is uncertain</th><th scope="col">Where it stands</th></tr>
			</thead>
			<tbody>
				{#each KNOWN_LIMITATIONS as l (l.id)}
					<tr><td data-label="Item">{l.id}</td><td data-label="What is uncertain">{l.title}</td><td data-label="Where it stands">{l.status}</td></tr>
				{/each}
			</tbody>
		</table>
	</div>

	<h2 id="calibration">7. How a fit is scored</h2>
	<p>
		A fit of the runoff model to measured flow is scored with the standard statistics: the Nash–Sutcliffe efficiency (NSE, where 1 is a
		perfect fit), the Kling–Gupta efficiency (KGE), percent bias, root-mean-square error, and NSE on the logarithm of flow, which weighs
		low flows, the regime the Reserve is about. Days with no measurement are left out. The app shows the numbers without rating words
		like “good”: what is good enough depends on the purpose and the record.
	</p>

	<h2 id="reproducible">8. Versions and reproducibility</h2>
	<p>
		Every run records the engine version that produced it, with its inputs and settings, so a result can be traced and re-run. A
		change in the engine’s behaviour changes its version. The engine today is version <strong>{ENGINE_VERSION}</strong>.
	</p>

	<h2 id="more">9. The full audit</h2>
	<p>
		The full engine audit, with every finding’s evidence, the tests that pin it and the published sources behind each decision, is in
		the project’s public source: <a href="https://github.com/Absence0760/project-water-management/blob/main/docs/engine-audit.md">engine audit</a>. The model’s formulas are in the
		<a href="https://github.com/Absence0760/project-water-management/blob/main/docs/model.md">model reference</a>. Questions about the method are welcome at
		<a href="mailto:jared@jaredhoward.com">jared@jaredhoward.com</a>.
	</p>
</LegalPage>

<style>
	/* On a phone a three-column table of sentences would scroll sideways inside
	   the page (and a scrolling region needs keyboard access): each row becomes
	   a card instead, every cell under its column's name. */
	@media (max-width: 600px) {
		.stack thead {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip-path: inset(50%);
			white-space: nowrap;
		}
		.stack table,
		.stack tbody,
		.stack tr,
		.stack td {
			display: block;
		}
		.stack tr {
			margin-bottom: 0.75rem;
			border: 1px solid var(--border);
			border-radius: var(--radius);
		}
		.stack td {
			border: none;
			border-top: 1px solid var(--border);
		}
		.stack td:first-child {
			border-top: none;
			font-weight: 600;
		}
		.stack td::before {
			content: attr(data-label);
			display: block;
			font-size: 0.8rem;
			font-weight: 600;
			color: var(--text-muted);
		}
	}
</style>
