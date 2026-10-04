-- 199_demand_monthly_unit — the unit a demand object's monthly demand is
-- entered and shown in (engine 1.72.0; docs/ui.md § Demand objects).
--
-- A monthly demand object's demand is stored in m³/day (monthly_m3_day). A
-- town's or a scheme's supply is often given in litres or cubic metres a
-- second, so the form offers those too, and remembers which the object was
-- entered in: display only, a run never reads it.
--
-- In this file:
--  * demand_object.monthly_unit: 'ls' (l/s) or 'm3s' (m³/s); NULL (every row
--    before 199) = m³/day. No new table, policy, grant or function: the
--    column inherits demand_object's RLS and water_app's table grants.

ALTER TABLE demand_object ADD COLUMN monthly_unit text CHECK (monthly_unit IN ('ls', 'm3s'));

COMMENT ON COLUMN demand_object.monthly_unit IS
	'The unit a monthly object''s demand is entered and shown in: ''ls'' (l/s) or ''m3s'' (m3/s); NULL = m3/day. Display only: monthly_m3_day holds the demand.';
