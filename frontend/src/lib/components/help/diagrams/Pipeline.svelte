<!-- One run's daily chain, from inputs to the outlet checks, top to bottom
     so it fits the guide's column whole from 1280 px (660 wide: its 11 px
     text is drawn no smaller than the 9.5 px floor at 570 px).
     Styles: ../Diagram.svelte. -->
<svg
	viewBox="0 0 660 480"
	role="img"
	aria-label="Daily rain and A-pan evaporation drive the runoff model, GR4J, which makes the catchment's natural flow. Flow shares split the natural flow, and the EWR, between the hydrological units. Rain, A-pan evaporation and the crops and their areas give each hydrological unit's irrigation demand. The hydrological unit balance, run for each hydrological unit from upstream down, takes the hydrological unit runoff and the demand, and handles dam capture, diversion, transfers, irrigation, spill and return flow. What leaves the last element is the simulated outflow at the outflow gauge, which is checked against the EWR and scored against observed flow."
>
	<defs>
		<marker id="pl-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
			<path class="head" d="M0 0 L10 5 L0 10 z" />
		</marker>
	</defs>

	<text class="m lbl" x="10" y="14">Inputs</text>
	<text class="m lbl" x="10" y="282">Network</text>
	<text class="m lbl" x="10" y="392">At the outlet</text>

	<!-- inputs -->
	<rect class="box" x="10" y="22" width="190" height="52" rx="6" />
	<text class="t" x="105" y="44" text-anchor="middle">Daily rain</text>
	<text class="s" x="105" y="62" text-anchor="middle">gap-filled, mm</text>

	<rect class="box" x="235" y="22" width="190" height="52" rx="6" />
	<text class="t" x="330" y="44" text-anchor="middle">A-pan evaporation</text>
	<text class="s" x="330" y="62" text-anchor="middle">monthly, mm</text>

	<rect class="box" x="460" y="22" width="190" height="52" rx="6" />
	<text class="t" x="555" y="44" text-anchor="middle">Crops and areas</text>
	<text class="s" x="555" y="62" text-anchor="middle">crop factors, ha</text>

	<!-- rain to flow, and demand -->
	<rect class="box key" x="10" y="112" width="190" height="52" rx="6" />
	<text class="t" x="105" y="134" text-anchor="middle">Runoff model</text>
	<text class="s" x="105" y="152" text-anchor="middle">GR4J</text>

	<rect class="box" x="460" y="112" width="190" height="52" rx="6" />
	<text class="t" x="555" y="134" text-anchor="middle">Irrigation demand</text>
	<text class="s" x="555" y="152" text-anchor="middle">net of effective rain</text>

	<rect class="box" x="10" y="200" width="190" height="52" rx="6" />
	<text class="t" x="105" y="222" text-anchor="middle">Natural flow</text>
	<text class="s" x="105" y="240" text-anchor="middle">before any use, m³/day</text>

	<rect class="box" x="235" y="200" width="190" height="52" rx="6" />
	<text class="t" x="330" y="222" text-anchor="middle">Flow shares</text>
	<text class="s" x="330" y="240" text-anchor="middle">per hydrological unit</text>

	<!-- network -->
	<rect class="box key" x="10" y="290" width="640" height="72" rx="6" />
	<text class="t" x="330" y="314" text-anchor="middle">Hydrological unit balance</text>
	<text class="s" x="330" y="332" text-anchor="middle">each one, upstream first</text>
	<text class="s" x="330" y="350" text-anchor="middle">dam capture, diversion, transfers, irrigation, spill, return flow</text>

	<!-- outlet -->
	<rect class="box key" x="10" y="400" width="190" height="52" rx="6" />
	<text class="t" x="105" y="422" text-anchor="middle">Outflow gauge</text>
	<text class="s" x="105" y="440" text-anchor="middle">simulated outflow</text>

	<rect class="box" x="235" y="400" width="190" height="52" rx="6" />
	<text class="t" x="330" y="422" text-anchor="middle">EWR check</text>
	<text class="s" x="330" y="440" text-anchor="middle">days not met</text>

	<rect class="box" x="460" y="400" width="190" height="52" rx="6" />
	<text class="t" x="555" y="422" text-anchor="middle">Calibration</text>
	<text class="s" x="555" y="440" text-anchor="middle">vs observed flow</text>

	<path class="wire" d="M105 74 V110" marker-end="url(#pl-arrow)" />
	<path class="wire" d="M280 74 L178 110" marker-end="url(#pl-arrow)" />
	<path class="wire" d="M170 74 L476 110" marker-end="url(#pl-arrow)" />
	<path class="wire" d="M400 74 L522 110" marker-end="url(#pl-arrow)" />
	<path class="wire" d="M555 74 V110" marker-end="url(#pl-arrow)" />
	<path class="wire" d="M105 164 V198" marker-end="url(#pl-arrow)" />
	<path class="wire" d="M200 226 H233" marker-end="url(#pl-arrow)" />
	<path class="wire" d="M330 252 V288" marker-end="url(#pl-arrow)" />
	<path class="wire" d="M555 164 V288" marker-end="url(#pl-arrow)" />
	<path class="wire" d="M105 362 V398" marker-end="url(#pl-arrow)" />
	<path class="wire" d="M200 426 H233" marker-end="url(#pl-arrow)" />
	<path class="wire" d="M150 452 V468 H555 V454" marker-end="url(#pl-arrow)" />
</svg>
