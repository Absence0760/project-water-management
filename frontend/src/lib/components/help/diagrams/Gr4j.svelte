<!-- GR4J's structure (Perrin, Michel & Andréassian 2003): interception,
     production store, unit hydrographs, routing store, exchange.
     Styles: ../Diagram.svelte. -->
<svg
	viewBox="0 0 660 536"
	role="img"
	aria-label="Rain P and potential evaporation E first cancel out: what is left is either net rain Pn or net evaporation En. Part of the net rain, Ps, enters the production store, of capacity X1, which loses water to evaporation Es. The rest of the net rain, Pn minus Ps, joins the percolation from the production store to make Pr, the water to route. 90 percent of Pr goes through unit hydrograph UH1, with time base X4, into the routing store, of capacity X3, which releases Qr. 10 percent goes through unit hydrograph UH2, with time base twice X4, and becomes the direct flow Qd. The exchange F, set by X2, adds or removes groundwater on both paths, and is 0 by default. The flow Q is Qr plus Qd."
>
	<defs>
		<marker id="g4-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
			<path class="head" d="M0 0 L10 5 L0 10 z" />
		</marker>
	</defs>

	<rect class="box" x="120" y="10" width="140" height="34" rx="6" />
	<text class="t" x="190" y="32" text-anchor="middle">Rain P</text>
	<rect class="box" x="380" y="10" width="160" height="34" rx="6" />
	<text class="t" x="460" y="32" text-anchor="middle">Potential evap. E</text>

	<rect class="box" x="100" y="70" width="460" height="34" rx="6" />
	<text class="t" x="330" y="92" text-anchor="middle">Net rain Pn, or net evaporation En</text>
	<path class="wire" d="M190 44 V68" marker-end="url(#g4-arrow)" />
	<path class="wire" d="M460 44 V68" marker-end="url(#g4-arrow)" />

	<!-- production store -->
	<rect class="box key" x="100" y="140" width="160" height="80" rx="6" />
	<rect class="water" x="101" y="186" width="158" height="33" rx="4" />
	<text class="t" x="180" y="162" text-anchor="middle">Production store</text>
	<text class="s" x="180" y="179" text-anchor="middle">capacity X1</text>
	<path class="wire" d="M180 104 V138" marker-end="url(#g4-arrow)" />
	<text class="s lbl" x="188" y="126">Ps</text>
	<path class="wire" d="M100 170 H40" marker-end="url(#g4-arrow)" />
	<text class="s lbl" x="66" y="162" text-anchor="middle">Es</text>

	<path class="wire" d="M460 104 V236" marker-end="url(#g4-arrow)" />
	<text class="s lbl" x="468" y="176">Pn − Ps</text>
	<path class="wire" d="M180 220 V255 H318" marker-end="url(#g4-arrow)" />
	<text class="s lbl" x="188" y="242">Perc</text>

	<rect class="box" x="320" y="238" width="240" height="34" rx="6" />
	<text class="t" x="440" y="260" text-anchor="middle">Pr: water to route</text>

	<!-- unit hydrographs -->
	<path class="wire" d="M380 272 L242 298" marker-end="url(#g4-arrow)" />
	<text class="s lbl" x="336" y="300">90 %</text>
	<path class="wire" d="M500 272 V298" marker-end="url(#g4-arrow)" />
	<text class="s lbl" x="508" y="290">10 %</text>

	<rect class="box" x="150" y="300" width="160" height="40" rx="6" />
	<text class="t" x="230" y="317" text-anchor="middle">UH1</text>
	<text class="s" x="230" y="333" text-anchor="middle">time base X4</text>
	<rect class="box" x="420" y="300" width="160" height="40" rx="6" />
	<text class="t" x="500" y="317" text-anchor="middle">UH2</text>
	<text class="s" x="500" y="333" text-anchor="middle">time base 2 × X4</text>

	<!-- routing store and exchange -->
	<rect class="box key" x="150" y="380" width="160" height="70" rx="6" />
	<rect class="water" x="151" y="423" width="158" height="26" rx="4" />
	<text class="t" x="230" y="400" text-anchor="middle">Routing store</text>
	<text class="s" x="230" y="416" text-anchor="middle">capacity X3</text>
	<path class="wire" d="M230 340 V378" marker-end="url(#g4-arrow)" />

	<path class="wire" d="M90 415 H148" marker-end="url(#g4-arrow)" />
	<text class="s lbl" x="70" y="419" text-anchor="middle">F</text>
	<path class="wire" d="M620 410 H502" marker-end="url(#g4-arrow)" />
	<text class="s lbl" x="632" y="414" text-anchor="middle">F</text>

	<path class="wire" d="M230 450 V490 H358" marker-end="url(#g4-arrow)" />
	<text class="s lbl" x="238" y="474">Qr</text>
	<path class="wire" d="M500 340 V473" marker-end="url(#g4-arrow)" />
	<text class="s lbl" x="508" y="372">Qd</text>

	<rect class="box key" x="360" y="475" width="220" height="32" rx="6" />
	<text class="t" x="470" y="496" text-anchor="middle">Flow Q = Qr + Qd</text>

	<text class="m lbl" x="10" y="528">F: exchange with groundwater outside the catchment (X2, 0 by default)</text>
</svg>
