-- 090_transfer_monthly_rates — a transfer rule's maximum rate month by month
-- (engine 1.14.0, docs/model.md §2.6).
--
-- monthly_rate_m3s: the rule's own maximum rate (m3/s) for each water-year
-- month, October first; a month with 0 is a month the rule is off. NULL (every
-- existing row) = max_rate_m3s in the calendar months listed in `months`, as
-- b023 has it, which runs exactly as before. When set it is what runs, and
-- `months` (the months with a rate above 0) and `max_rate_m3s` (the largest
-- rate) are kept in step with it by every writer; the API refuses a model
-- where they disagree (engine modelRuleIssues), so a reader of the old pair
-- still sees what the rule does.
--
-- A new column on an existing table: the table-level grants to water_app in
-- 001 and transfer's RLS policies already cover it; no foreign key, so no
-- index.

ALTER TABLE transfer
	ADD COLUMN monthly_rate_m3s double precision[]
		CHECK (monthly_rate_m3s IS NULL OR (cardinality(monthly_rate_m3s) = 12 AND array_position(monthly_rate_m3s, NULL) IS NULL AND 0 <= ALL (monthly_rate_m3s)));

COMMENT ON COLUMN transfer.monthly_rate_m3s IS
	'Max rate (m3/s) per water-year month, Oct-Sep; 0 = off that month. NULL = max_rate_m3s in the listed months. Engine >= 1.14.0.';
