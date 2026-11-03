-- 308_offtake_diversion_curve — a river off-take sized by a diversion curve
-- (engine 1.113.0, docs/model.md §2.6a). A canal fed by a weir takes a share
-- of the river that depends on how much the river carries: y = a · x^b percent
-- of the flow at the off-take, at most a largest share and the canal's capacity
-- (the rule's own rate, as for any off-take).
--
--   sizing                 now also 'diversionCurve' (091 allowed 'demand' and
--                          'capacity'; every existing row keeps its value).
--   diversion_coefficient  a, > 0.
--   diversion_exponent     b, any finite number (below 0 the share falls as the
--                          river rises).
--   diversion_max_pct      the largest share, 0 < m <= 1; NULL = 1.
--   diversion_flow_unit    the unit x is read in: L/s, m3/s, m3/day, Ml/day.
--   diversion_flow_basis   which flow x is: 'modelled' (the river at the
--                          off-take that day) or 'natural'; NULL = modelled.
--
-- All NULL by default, so every stored rule runs as before. A 'diversionCurve'
-- row needs its coefficient, exponent and unit (transfer_diversion_curve); the
-- engine refuses the same on save (modelRuleIssues) and runs a rule without
-- them as one that takes nothing. The fields are inert on any other sizing.
--
-- New columns on an existing table: the table-level grants to water_app (001)
-- and transfer's RLS policies already cover them; no foreign key, so no index.

ALTER TABLE transfer DROP CONSTRAINT transfer_sizing_check;

ALTER TABLE transfer
	ADD CONSTRAINT transfer_sizing_check CHECK (sizing IN ('demand', 'capacity', 'diversionCurve')),
	ADD COLUMN diversion_coefficient double precision
		CHECK (diversion_coefficient > 0 AND diversion_coefficient < 'Infinity'::float8),
	ADD COLUMN diversion_exponent double precision
		CHECK (diversion_exponent > '-Infinity'::float8 AND diversion_exponent < 'Infinity'::float8),
	ADD COLUMN diversion_max_pct double precision
		CHECK (diversion_max_pct > 0 AND diversion_max_pct <= 1),
	ADD COLUMN diversion_flow_unit text
		CHECK (diversion_flow_unit IN ('L/s', 'm3/s', 'm3/day', 'Ml/day')),
	ADD COLUMN diversion_flow_basis text
		CHECK (diversion_flow_basis IN ('modelled', 'natural')),
	ADD CONSTRAINT transfer_diversion_curve CHECK (
		sizing <> 'diversionCurve'
		OR (diversion_coefficient IS NOT NULL AND diversion_exponent IS NOT NULL AND diversion_flow_unit IS NOT NULL)
	);

COMMENT ON COLUMN transfer.diversion_coefficient IS
	'river, sizing diversionCurve: a of the share diverted, a * x^b percent of the river''s flow at the off-take. Engine >= 1.113.0.';
COMMENT ON COLUMN transfer.diversion_exponent IS
	'river, sizing diversionCurve: b of a * x^b. Engine >= 1.113.0.';
COMMENT ON COLUMN transfer.diversion_max_pct IS
	'river, sizing diversionCurve: the largest share of the river diverted, 0 < m <= 1; NULL = 1. Engine >= 1.113.0.';
COMMENT ON COLUMN transfer.diversion_flow_unit IS
	'river, sizing diversionCurve: the unit x is read in (L/s, m3/s, m3/day, Ml/day). Engine >= 1.113.0.';
COMMENT ON COLUMN transfer.diversion_flow_basis IS
	'river, sizing diversionCurve: x is the modelled river at the off-take (modelled, NULL) or the natural flow there (natural). Engine >= 1.113.0.';
