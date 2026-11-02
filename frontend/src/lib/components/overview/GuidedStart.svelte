<!--
	The Summary of an empty model, for an editor (WP-4.10 "Fast catchment
	onboarding"; docs/ui.md § Summary): the guided way in, the Map's Start
	sheet (docs/maps.md § Start from the map), above the setup checklist, whose
	first step types the network in instead. Gone once the model has a node:
	the Map's Getting started pill then carries a model started from the map.
-->
<section class="panel guided" aria-labelledby="guided-h" data-testid="summary-guided-start">
	<div class="panel-head"><h2 id="guided-h">Set the catchment up from its map</h2></div>
	<p>
		Put the catchment’s boundary on the map (delineated from its outlet on the river where the server has an elevation model, or drawn or
		uploaded), then each unit’s boundary, dams and gauges. The units, their areas and their order are proposed for you to tick, and a to-do list takes you
		through rain, evaporation, observed flow, dams, crops and the EWR to a first run and its calibration.
	</p>
	<p class="ways">
		<a class="btn btn-primary" href="?tab=map&start=1" data-testid="summary-guided-open">Start from the map</a>
		<a href="?tab=network">Or type the network in</a>
	</p>
</section>

<style>
	.guided p {
		margin: 0 0 0.6rem;
		max-width: 72ch;
	}
	.ways {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
	}
	.guided p.ways {
		margin-bottom: 0;
	}
</style>
