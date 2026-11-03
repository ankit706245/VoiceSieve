-- ============================================================================
-- Migration: 004_vaani_user_profiles.sql
-- Description: Phase 1 BRAIVEX auth - minimal Supabase Auth user to
--   organization mapping. Additive only: new isolated table, no changes to
--   existing tables, no RLS changes (isolation stays application-enforced
--   like the rest of the Vaani schema). Rollback: DROP TABLE IF EXISTS
--   public.vaani_user_profiles;
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.vaani_user_profiles (
  supabase_user_id UUID PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  tenant_id TEXT,
  role TEXT NOT NULL DEFAULT 'member'
    CHECK (role IN ('member', 'owner', 'admin', 'super_admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vaani_user_profiles_org
  ON public.vaani_user_profiles(organization_id);

COMMIT;
