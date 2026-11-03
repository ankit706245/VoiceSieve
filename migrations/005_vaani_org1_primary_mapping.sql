-- ============================================================================
-- Migration: 005_vaani_org1_primary_mapping.sql
-- Description: Make Org 1 the primary organization for the active Supabase
--   Vaani user by updating only the auth-linked profile mapping. This is an
--   auth configuration change, not a historical data migration. No leads,
--   calls, runs, transcripts, buyers, sellers, or Org 2 records are changed.
--
-- Preconditions enforced below:
--   * exactly one auth.users row exists (the active dashboard login)
--   * Org 1 exists
--   * Workflow 3 is active and owned by Org 1
--
-- Backup: public.vaani_user_profiles_org1_backup_20261024
--
-- Rollback:
--   BEGIN;
--   UPDATE public.vaani_user_profiles p
--      SET organization_id = b.organization_id,
--          updated_at = CURRENT_TIMESTAMP
--     FROM public.vaani_user_profiles_org1_backup_20261024 b
--    WHERE p.supabase_user_id = b.supabase_user_id;
--   COMMIT;
-- ============================================================================

BEGIN;

DO $$
DECLARE
  auth_user_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO auth_user_count FROM auth.users;
  IF auth_user_count <> 1 THEN
    RAISE EXCEPTION 'Refusing mapping update: expected exactly 1 auth.users row, found %', auth_user_count;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = 1) THEN
    RAISE EXCEPTION 'Refusing mapping update: organization 1 does not exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.workflows
    WHERE id = 3 AND organization_id = 1 AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Refusing mapping update: active Org 1 workflow 3 does not exist';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.vaani_user_profiles_org1_backup_20261024 AS
SELECT p.*
FROM public.vaani_user_profiles p
JOIN auth.users au ON au.id = p.supabase_user_id
WHERE p.organization_id = 2;

UPDATE public.vaani_user_profiles p
SET organization_id = 1,
    updated_at = CURRENT_TIMESTAMP
FROM auth.users au
WHERE au.id = p.supabase_user_id
  AND p.organization_id = 2;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.vaani_user_profiles p
    JOIN auth.users au ON au.id = p.supabase_user_id
    WHERE p.organization_id = 1
  ) THEN
    RAISE EXCEPTION 'Mapping update verification failed: no auth-linked profile maps to Org 1';
  END IF;
END $$;

COMMIT;
