<!-- One farm element on one day: inflows split around the dam, rain on the
     dam, evaporation, seepage, irrigation, spill, diversion, return flow and
     outflow. Styles: ../Diagram.svelte. -->
<svg
	viewBox="0 0 660 390"
	role="img"
	aria-label="Upstream inflow splits: its upstream share enters the dam and the rest passes below it. The hydrological unit's own runoff splits the same way by its runoff share. A transfer adds water to the dam or takes it out. Rain falls on the dam's surface and adds to it; open-water evaporation leaves it. Seepage leaks from the dam into the river below it. The diversion takes water from the river below the dam back into it. Irrigation draws from the dam; part of it returns to the river as return flow. Water above the dam's capacity spills into the river below the dam. The river below the dam leaves as the hydrological unit's outflow to the next element."
>
	<defs>
		<marker id="fd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
			<path class="head" d="M0 0 L10 5 L0 10 z" />
		</marker>
	</defs>

	<rect class="box" x="20" y="20" width="170" height="44" rx="6" />
	<text class="t" x="105" y="38" text-anchor="middle">Upstream inflow</text>
	<text class="s" x="105" y="55" text-anchor="middle">from elements above</text>

	<rect class="box" x="245" y="20" width="170" height="44" rx="6" />
	<text class="t" x="330" y="38" text-anchor="middle">Transfer</text>
	<text class="s" x="330" y="55" text-anchor="middle">in or out</text>

	<rect class="box" x="470" y="20" width="170" height="44" rx="6" />
	<text class="t" x="555" y="38" text-anchor="middle">Hydrological unit runoff</text>
	<text class="s" x="555" y="55" text-anchor="middle">its share of natural flow</text>

	<rect class="box key" x="245" y="110" width="170" height="70" rx="6" />
	<rect class="water" x="246" y="162" width="168" height="17" rx="4" />
	<text class="t" x="330" y="136" text-anchor="middle">Dam</text>
	<text class="s" x="330" y="154" text-anchor="middle">storage ≤ capacity</text>

	<rect class="box" x="160" y="215" width="130" height="40" rx="6" />
	<text class="t" x="225" y="232" text-anchor="middle">Crops</text>
	<text class="s" x="225" y="248" text-anchor="middle">irrigation use</text>

	<rect class="box band" x="20" y="300" width="620" height="36" rx="6" />
	<text class="t" x="440" y="323" text-anchor="middle">River below the dam</text>

	<!-- upstream inflow -->
	<path class="wire" d="M150 64 L243 127" marker-end="url(#fd-arrow)" />
	<text class="s lbl" x="184" y="104" text-anchor="end">× upstream share</text>
	<path class="wire" d="M60 64 V298" marker-end="url(#fd-arrow)" />
	<text class="s lbl" x="68" y="186">rest</text>

	<!-- farm runoff -->
	<path class="wire" d="M510 64 L417 127" marker-end="url(#fd-arrow)" />
	<text class="s lbl" x="476" y="104">× runoff share</text>
	<path class="wire" d="M600 64 V298" marker-end="url(#fd-arrow)" />
	<text class="s lbl" x="608" y="186">rest</text>

	<!-- transfer, diversion, irrigation, spill, return flow -->
	<path class="wire" d="M330 66 V108" marker-start="url(#fd-arrow)" marker-end="url(#fd-arrow)" />
	<path class="wire" d="M520 298 V160 H417" marker-end="url(#fd-arrow)" />
	<text class="s lbl" x="528" y="240">diversion</text>
	<path class="wire" d="M270 180 V213" marker-end="url(#fd-arrow)" />
	<text class="s lbl" x="264" y="203" text-anchor="end">irrigation</text>
	<path class="wire" d="M390 180 V298" marker-end="url(#fd-arrow)" />
	<text class="s lbl" x="398" y="245">spill</text>
	<path class="wire" d="M225 255 V298" marker-end="url(#fd-arrow)" />
	<text class="s lbl" x="233" y="282">return flow</text>

	<!-- the dam's own surface: rain in, evaporation out; seepage below the wall -->
	<path class="wire" d="M290 76 V108" marker-end="url(#fd-arrow)" />
	<text class="s lbl" x="284" y="96" text-anchor="end">rain on dam</text>
	<path class="wire" d="M370 108 V76" marker-end="url(#fd-arrow)" />
	<text class="s lbl" x="376" y="96">evaporation</text>
	<path class="wire" d="M345 180 V298" marker-end="url(#fd-arrow)" />
	<text class="s lbl" x="339" y="238" text-anchor="end">seepage</text>

	<path class="wire" d="M330 336 V372" marker-end="url(#fd-arrow)" />
	<text class="s lbl" x="342" y="368">outflow to the next element</text>
</svg>
