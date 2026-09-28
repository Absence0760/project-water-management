<script lang="ts">
	// First-run empty state for the project list: what a project is and the
	// three steps from nothing to a model run.
	import { base } from '$app/paths';

	let { oncreate, hasTeams }: { oncreate: () => void; hasTeams: boolean } = $props();
</script>

<section class="start" aria-labelledby="start-h">
	<div class="intro">
		<h2 id="start-h">Start your first catchment</h2>
		<p>
			You have no projects yet. A <strong>project</strong> models one catchment: hydrological units (farms or sub-catchments) with dams and
			irrigation drain through gauges to one outflow gauge. Run it against daily rainfall to see each
			hydrological unit's supply and deficit, dam storage, spills and whether the environmental flow requirement
			(EWR) is met.
		</p>
	</div>
	<ol class="steps">
		<li>
			<span class="n" aria-hidden="true">1</span>
			<div>
				<h3>Create the project</h3>
				<p>Name it after the catchment or scenario, e.g. “Upper Breede — baseline”.</p>
			</div>
		</li>
		<li>
			<span class="n" aria-hidden="true">2</span>
			<div>
				<h3>Build the network and crops</h3>
				<p>Add hydrological units and gauges with areas and dam sizes, then crops, crop factors and irrigated hectares.</p>
			</div>
		</li>
		<li>
			<span class="n" aria-hidden="true">3</span>
			<div>
				<h3>Load data and run</h3>
				<p>Upload daily rainfall (and observed flow to calibrate), set A-pan and EWR, then run the model.</p>
			</div>
		</li>
	</ol>
	<div class="cta">
		<button type="button" class="btn btn-primary" onclick={oncreate}>New project</button>
		<span class="muted">
			{#if hasTeams}
				You can create it in one of your teams so colleagues can work on it too.
			{:else}
				Working with colleagues? <a href="{base}/teams">Create a team</a> first to share catchments.
			{/if}
		</span>
	</div>
</section>

<style>
	.start {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow);
		padding: 1.5rem;
		max-width: 960px;
	}
	.intro {
		max-width: 70ch;
	}
	.intro h2 {
		font-family: var(--font-display);
		font-size: 1.25rem;
	}
	.intro p {
		color: var(--text-2);
	}
	.steps {
		list-style: none;
		margin: 1.25rem 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 1rem;
	}
	.steps li {
		display: flex;
		gap: 0.75rem;
		padding: 0.9rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg);
	}
	.n {
		flex: none;
		display: inline-grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border-radius: 50%;
		background: var(--accent);
		color: var(--accent-contrast);
		font-weight: 700;
		font-size: 0.85rem;
	}
	.steps h3 {
		margin: 0.2rem 0 0.25rem;
	}
	.steps p {
		margin: 0;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.cta {
		display: flex;
		align-items: center;
		gap: 1rem;
		flex-wrap: wrap;
	}
	.cta .muted {
		font-size: 0.85rem;
	}
	.cta a {
		text-decoration: underline;
	}
	@media (max-width: 760px) {
		.start {
			padding: 1rem;
		}
		.steps {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
