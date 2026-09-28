<!-- One run's daily chain, from inputs to the outlet checks.
     Styles: ../Diagram.svelte. -->
<svg
	viewBox="0 0 920 280"
	role="img"
	aria-label="Daily rain and A-pan evaporation drive the runoff model, GR4J, which makes the catchment's natural flow. Flow shares split the natural flow, and the EWR, between the hydrological units. Rain, A-pan evaporation and the crops and their areas give each hydrological unit's irrigation demand. The hydrological unit balance, run for each hydrological unit from upstream down, takes the hydrological unit runoff and the demand, and handles dam capture, diversion, transfers, irrigation, spill and return flow. What leaves the last element is the simulated outflow at the outflow gauge, which is checked against the EWR and scored against observed flow."
>
	<defs>
		<marker id="pl-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
			<path class="head" d="M0 0 L10 5 L0 10 z" />
		</marker>
	</defs>

	<text class="m lbl" x="10" y="12">Inputs</text>
	<text class="m lbl" x="580" y="12">Network</text>
	<text class="m lbl" x="760" y="12">At the outlet</text>

	<!-- inputs -->
	<rect class="box" x="10" y="20" width="150" height="56" rx="6" />
	<text class="t" x="85" y="44" text-anchor="middle">Daily rain</text>
	<text class="s" x="85" y="62" text-anchor="middle">gap-filled, mm</text>

	<rect class="box" x="10" y="110" width="150" height="56" rx="6" />
	<text class="t" x="85" y="134" text-anchor="middle">A-pan evaporation</text>
	<text class="s" x="85" y="152" text-anchor="middle">monthly, mm</text>

	<rect class="box" x="10" y="200" width="150" height="56" rx="6" />
	<text class="t" x="85" y="224" text-anchor="middle">Crops and areas</text>
	<text class="s" x="85" y="242" text-anchor="middle">crop factors, ha</text>

	<!-- rain to flow, and demand -->
	<rect class="box key" x="220" y="20" width="150" height="56" rx="6" />
	<text class="t" x="295" y="44" text-anchor="middle">Runoff model</text>
	<text class="s" x="295" y="62" text-anchor="middle">GR4J</text>

	<rect class="box" x="220" y="200" width="150" height="56" rx="6" />
	<text class="t" x="295" y="224" text-anchor="middle">Irrigation demand</text>
	<text class="s" x="295" y="242" text-anchor="middle">net of effective rain</text>

	<rect class="box" x="400" y="20" width="150" height="56" rx="6" />
	<text class="t" x="475" y="44" text-anchor="middle">Natural flow</text>
	<text class="s" x="475" y="62" text-anchor="middle">before any use, m³/day</text>

	<rect class="box" x="400" y="110" width="150" height="56" rx="6" />
	<text class="t" x="475" y="134" text-anchor="middle">Flow shares</text>
	<text class="s" x="475" y="152" text-anchor="middle">per hydrological unit</text>

	<!-- network -->
	<rect class="box key" x="580" y="20" width="150" height="236" rx="6" />
	<text class="t" x="655" y="86" text-anchor="middle">Hydrological unit</text>
	<text class="t" x="655" y="104" text-anchor="middle">balance</text>
	<text class="s" x="655" y="124" text-anchor="middle">each one, upstream first</text>
	<text class="s" x="655" y="144" text-anchor="middle">dam capture, diversion</text>
	<text class="s" x="655" y="162" text-anchor="middle">transfers</text>
	<text class="s" x="655" y="180" text-anchor="middle">irrigation</text>
	<text class="s" x="655" y="198" text-anchor="middle">spill, return flow</text>

	<!-- outlet -->
	<rect class="box key" x="760" y="20" width="150" height="56" rx="6" />
	<text class="t" x="835" y="44" text-anchor="middle">Outflow gauge</text>
	<text class="s" x="835" y="62" text-anchor="middle">simulated outflow</text>

	<rect class="box" x="760" y="110" width="150" height="56" rx="6" />
	<text class="t" x="835" y="134" text-anchor="middle">EWR check</text>
	<text class="s" x="835" y="152" text-anchor="middle">days not met</text>

	<rect class="box" x="760" y="200" width="150" height="56" rx="6" />
	<text class="t" x="835" y="224" text-anchor="middle">Calibration</text>
	<text class="s" x="835" y="242" text-anchor="middle">vs observed flow</text>

	<path class="wire" d="M160 44 H218" marker-end="url(#pl-arrow)" />
	<path class="wire" d="M160 130 L218 62" marker-end="url(#pl-arrow)" />
	<path class="wire" d="M160 62 L218 210" marker-end="url(#pl-arrow)" />
	<path class="wire" d="M160 146 L218 222" marker-end="url(#pl-arrow)" />
	<path class="wire" d="M160 236 H218" marker-end="url(#pl-arrow)" />
	<path class="wire" d="M370 48 H398" marker-end="url(#pl-arrow)" />
	<path class="wire" d="M475 76 V108" marker-end="url(#pl-arrow)" />
	<path class="wire" d="M550 138 H578" marker-end="url(#pl-arrow)" />
	<path class="wire" d="M370 228 H578" marker-end="url(#pl-arrow)" />
	<path class="wire" d="M730 48 H758" marker-end="url(#pl-arrow)" />
	<path class="wire" d="M835 76 V108" marker-end="url(#pl-arrow)" />
	<path class="wire" d="M760 70 H745 V228 H758" marker-end="url(#pl-arrow)" />
</svg>
