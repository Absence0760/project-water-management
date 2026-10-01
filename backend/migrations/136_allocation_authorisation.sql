-- 136_allocation_authorisation — a registration is not an entitlement, and
-- existing lawful use is verified only under s35 (issue #281), forward from
-- 038_allocations (already applied: checksummed, so not edited).
--
-- In this file:
--  * `allocation.authorisation` accepts two more values:
--    - 'existing_lawful_use_claimed': existing lawful use (s32) that is
--      claimed or registered but not verified. The importer maps an
--      unqualified "existing", "ELU" or "s32" here; only an explicit
--      "verified" or "s35" still maps to 'existing_lawful_use', which the app
--      labels as verified (DWS verification guide, Dec 2006).
--    - 'schedule_1': Schedule 1 permissible use (NWA s22(1)(a)(i)). 038's
--      importer read "Schedule 1" as a s39 general authorisation, which it
--      is not.
--  * Imported rows already stored as 'existing_lawful_use' become
--    'existing_lawful_use_claimed'. The importer mapped "existing" / "ELU" /
--    "s32" to the verified value and the cell's own words aren't stored, so
--    an imported row can't be shown to be verified; reading one as a claim
--    understates it, the other way round overstates it. A row typed into the
--    app (source_id NULL) was picked from a list that said "verified", so it
--    stays. Not yet deployed, so in practice this touches only dev data.
--
-- Expand only: no value is removed, so code from before this migration still
-- writes valid rows. RLS, policies and grants on `allocation` are unchanged.

-- Latest definition: 038_allocations.sql.
ALTER TABLE allocation DROP CONSTRAINT allocation_authorisation_check;
ALTER TABLE allocation ADD CONSTRAINT allocation_authorisation_check
	CHECK (authorisation IN (
		'registration', 'licence', 'general_authorisation', 'schedule_1',
		'existing_lawful_use_claimed', 'existing_lawful_use'
	));

UPDATE allocation SET authorisation = 'existing_lawful_use_claimed'
	WHERE authorisation = 'existing_lawful_use' AND source_id IS NOT NULL;

COMMENT ON COLUMN allocation.authorisation IS
	'registration (WARMS), licence (s40), general_authorisation (s39), schedule_1 (permissible use), existing_lawful_use_claimed (s32, not verified) or existing_lawful_use (verified under s35). Not a finding of lawfulness; a registration is not an entitlement.';
