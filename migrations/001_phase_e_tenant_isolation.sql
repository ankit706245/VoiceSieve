-- ============================================================================
-- Migration: 001_phase_e_tenant_isolation.sql
-- Description: Phase E Step 2 - Multi-Tenant Security & Strict Tenant Isolation
-- Author: RapidX / Vaani AI
-- Target Engine: PostgreSQL 17 (dograh-local-postgres-1)
-- Security Boundary: NO tenant fallbacks or defaults. Strict NOT NULL enforcement.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Table: public.vaani_machines
-- ----------------------------------------------------------------------------

-- Add organization_id column referencing organizations(id) with CASCADE delete
ALTER TABLE public.vaani_machines 
ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES public.organizations(id) ON DELETE CASCADE;

-- Remove any default if previously set (guarantees NO silent fallback to tenant 1)
ALTER TABLE public.vaani_machines ALTER COLUMN organization_id DROP DEFAULT;

-- Verified relational backfill: derive strictly from verified workflow relationship
UPDATE public.vaani_machines m
SET organization_id = (
    SELECT w.organization_id 
    FROM public.workflow_runs r 
    JOIN public.workflows w ON r.workflow_id = w.id 
    WHERE r.id = m.source_lead_run_id
)
WHERE organization_id IS NULL AND m.source_lead_run_id IS NOT NULL;

-- Fail-safe gate: Halt migration if any record cannot be mapped to a verified organization
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.vaani_machines WHERE organization_id IS NULL) THEN
        RAISE EXCEPTION 'Migration aborted: unmapped records in vaani_machines cannot be assigned to any tenant';
    END IF;
END $$;

-- Enforce strict NOT NULL (without ANY default)
ALTER TABLE public.vaani_machines ALTER COLUMN organization_id SET NOT NULL;

-- Tenant-scoped indexes
CREATE INDEX IF NOT EXISTS idx_vaani_machines_org ON public.vaani_machines(organization_id);
CREATE INDEX IF NOT EXISTS idx_vaani_machines_org_status ON public.vaani_machines(organization_id, status);


-- ----------------------------------------------------------------------------
-- 2. Table: public.vaani_digital_evidence
-- ----------------------------------------------------------------------------

-- Add organization_id column referencing organizations(id) with CASCADE delete
ALTER TABLE public.vaani_digital_evidence 
ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES public.organizations(id) ON DELETE CASCADE;

-- Remove any default if previously set
ALTER TABLE public.vaani_digital_evidence ALTER COLUMN organization_id DROP DEFAULT;

-- Verified relational backfill: derive strictly from machine or workflow run
UPDATE public.vaani_digital_evidence e
SET organization_id = COALESCE(
    (SELECT m.organization_id FROM public.vaani_machines m WHERE m.machine_id = e.machine_id),
    (SELECT w.organization_id 
     FROM public.workflow_runs r 
     JOIN public.workflows w ON r.workflow_id = w.id 
     WHERE r.id = e.run_id)
)
WHERE organization_id IS NULL;

-- Fail-safe gate: Halt migration if any record cannot be mapped to a verified organization
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.vaani_digital_evidence WHERE organization_id IS NULL) THEN
        RAISE EXCEPTION 'Migration aborted: unmapped records in vaani_digital_evidence cannot be assigned to any tenant';
    END IF;
END $$;

-- Enforce strict NOT NULL (without ANY default)
ALTER TABLE public.vaani_digital_evidence ALTER COLUMN organization_id SET NOT NULL;

-- Tenant-scoped indexes
CREATE INDEX IF NOT EXISTS idx_vaani_digital_evidence_org ON public.vaani_digital_evidence(organization_id);
CREATE INDEX IF NOT EXISTS idx_vaani_digital_evidence_org_run ON public.vaani_digital_evidence(organization_id, run_id);


-- ----------------------------------------------------------------------------
-- 3. Table: public.vaani_dnc_registry
-- ----------------------------------------------------------------------------

-- Add organization_id column referencing organizations(id) with CASCADE delete
ALTER TABLE public.vaani_dnc_registry 
ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES public.organizations(id) ON DELETE CASCADE;

-- Remove any default if previously set
ALTER TABLE public.vaani_dnc_registry ALTER COLUMN organization_id DROP DEFAULT;

-- Verified relational backfill: derive strictly from workflow run
UPDATE public.vaani_dnc_registry d
SET organization_id = (
    SELECT w.organization_id 
    FROM public.workflow_runs r 
    JOIN public.workflows w ON r.workflow_id = w.id 
    WHERE r.id = d.run_id
)
WHERE organization_id IS NULL AND d.run_id IS NOT NULL;

-- Fail-safe gate: Halt migration if any record cannot be mapped to a verified organization
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.vaani_dnc_registry WHERE organization_id IS NULL) THEN
        RAISE EXCEPTION 'Migration aborted: unmapped records in vaani_dnc_registry cannot be assigned to any tenant';
    END IF;
END $$;

-- Enforce strict NOT NULL (without ANY default)
ALTER TABLE public.vaani_dnc_registry ALTER COLUMN organization_id SET NOT NULL;

-- Fix DNC uniqueness: drop global single-column PK and replace with composite (organization_id, phone_number)
-- This guarantees Tenant A's DNC opt-out never leaks or suppresses Tenant B's contacts
ALTER TABLE public.vaani_dnc_registry DROP CONSTRAINT IF EXISTS vaani_dnc_registry_pkey;
ALTER TABLE public.vaani_dnc_registry ADD CONSTRAINT vaani_dnc_registry_pkey PRIMARY KEY (organization_id, phone_number);

-- Fast lookup indexes
CREATE INDEX IF NOT EXISTS idx_vaani_dnc_org ON public.vaani_dnc_registry(organization_id);
CREATE INDEX IF NOT EXISTS idx_vaani_dnc_phone ON public.vaani_dnc_registry(phone_number);


-- ----------------------------------------------------------------------------
-- 4. View: public.vaani_excavator_sales_leads
-- ----------------------------------------------------------------------------

-- Recreate view exposing organization_id through workflow -> organization relationship
DROP VIEW IF EXISTS public.vaani_excavator_sales_leads;

CREATE OR REPLACE VIEW public.vaani_excavator_sales_leads AS
SELECT 
    r.id AS run_id,
    r.workflow_id,
    w.organization_id,
    r.mode,
    r.call_type,
    r.created_at,
    
    -- Common Contact & Lead Identity
    (r.gathered_context -> 'extracted_variables'::text) ->> 'caller_name'::text AS caller_name,
    (r.gathered_context -> 'extracted_variables'::text) ->> 'callback_number'::text AS callback_number,
    (r.gathered_context -> 'extracted_variables'::text) ->> 'whatsapp_number'::text AS whatsapp_number,
    COALESCE((r.gathered_context -> 'extracted_variables'::text) ->> 'customer_type'::text, 'unknown'::text) AS customer_type,
    
    -- Seller Sourcing Specific Fields
    (r.gathered_context -> 'extracted_variables'::text) ->> 'ownership_type'::text AS ownership_type,
    COALESCE(((r.gathered_context -> 'extracted_variables'::text) -> 'machine_details'::text) ->> 'brand'::text, (r.gathered_context -> 'extracted_variables'::text) ->> 'machine_brand'::text) AS machine_brand,
    COALESCE(((r.gathered_context -> 'extracted_variables'::text) -> 'machine_details'::text) ->> 'model'::text, (r.gathered_context -> 'extracted_variables'::text) ->> 'machine_model'::text) AS machine_model,
    COALESCE((((r.gathered_context -> 'extracted_variables'::text) -> 'machine_details'::text) ->> 'model_year'::text)::integer, ((r.gathered_context -> 'extracted_variables'::text) ->> 'model_year'::text)::integer) AS model_year,
    COALESCE((((r.gathered_context -> 'extracted_variables'::text) -> 'machine_details'::text) ->> 'running_hours'::text)::integer, ((r.gathered_context -> 'extracted_variables'::text) ->> 'running_hours'::text)::integer) AS running_hours,
    COALESCE(((r.gathered_context -> 'extracted_variables'::text) -> 'machine_details'::text) ->> 'application_history'::text, (r.gathered_context -> 'extracted_variables'::text) ->> 'application_history'::text) AS application_history,
    COALESCE(((r.gathered_context -> 'extracted_variables'::text) -> 'machine_details'::text) ->> 'location_city'::text, (r.gathered_context -> 'extracted_variables'::text) ->> 'location_city'::text) AS machine_location_city,
    COALESCE(((r.gathered_context -> 'extracted_variables'::text) -> 'machine_details'::text) ->> 'location_state'::text, (r.gathered_context -> 'extracted_variables'::text) ->> 'location_state'::text) AS machine_location_state,
    COALESCE(((r.gathered_context -> 'extracted_variables'::text) -> 'machine_details'::text) ->> 'document_status'::text, (r.gathered_context -> 'extracted_variables'::text) ->> 'document_status'::text) AS document_status,
    COALESCE((((r.gathered_context -> 'extracted_variables'::text) -> 'commercial_terms'::text) ->> 'expected_price_inr'::text)::bigint, ((r.gathered_context -> 'extracted_variables'::text) ->> 'expected_price_inr'::text)::bigint) AS expected_selling_price_inr,
    COALESCE(((r.gathered_context -> 'extracted_variables'::text) -> 'commercial_terms'::text) ->> 'price_or_budget_raw'::text, (r.gathered_context -> 'extracted_variables'::text) ->> 'price_or_budget_raw'::text) AS price_raw,
    
    -- Buyer Sales Specific Fields
    COALESCE(((r.gathered_context -> 'extracted_variables'::text) -> 'machine_details'::text) ->> 'tonnage_class'::text, (r.gathered_context -> 'extracted_variables'::text) ->> 'tonnage_class'::text) AS required_tonnage_class,
    COALESCE((((r.gathered_context -> 'extracted_variables'::text) -> 'commercial_terms'::text) ->> 'budget_max_inr'::text)::bigint, ((r.gathered_context -> 'extracted_variables'::text) ->> 'budget_max_inr'::text)::bigint) AS buyer_budget_max_inr,
    COALESCE(((r.gathered_context -> 'extracted_variables'::text) -> 'commercial_terms'::text) ->> 'purchase_timeline'::text, (r.gathered_context -> 'extracted_variables'::text) ->> 'purchase_timeline'::text) AS purchase_timeline,
    COALESCE((((r.gathered_context -> 'extracted_variables'::text) -> 'commercial_terms'::text) ->> 'yard_visit_agreed'::text)::boolean, ((r.gathered_context -> 'extracted_variables'::text) ->> 'yard_visit_agreed'::text)::boolean, false) AS yard_visit_agreed,
    COALESCE(((r.gathered_context -> 'extracted_variables'::text) -> 'commercial_terms'::text) ->> 'yard_visit_schedule'::text, (r.gathered_context -> 'extracted_variables'::text) ->> 'yard_visit_schedule'::text) AS yard_visit_schedule,
    
    -- Evidence & Asset Status
    COALESCE((((r.gathered_context -> 'extracted_variables'::text) -> 'evidence_readiness'::text) ->> 'photos_agreed'::text)::boolean, ((r.gathered_context -> 'extracted_variables'::text) ->> 'photos_agreed'::text)::boolean, false) AS photos_agreed,
    COALESCE((((r.gathered_context -> 'extracted_variables'::text) -> 'evidence_readiness'::text) ->> 'running_video_agreed'::text)::boolean, ((r.gathered_context -> 'extracted_variables'::text) ->> 'running_video_agreed'::text)::boolean, false) AS running_video_agreed,
    COALESCE((((r.gathered_context -> 'extracted_variables'::text) -> 'evidence_readiness'::text) ->> 'rc_copy_agreed'::text)::boolean, ((r.gathered_context -> 'extracted_variables'::text) ->> 'rc_copy_agreed'::text)::boolean, false) AS rc_copy_agreed,
    
    -- Qualification, Priority & Lifecycle
    COALESCE((r.gathered_context -> 'extracted_variables'::text) ->> 'lead_temperature'::text, 'COLD'::text) AS lead_temperature,
    COALESCE((r.gathered_context -> 'extracted_variables'::text) ->> 'qualification_state'::text, 'UNQUALIFIED'::text) AS qualification_state,
    COALESCE((r.gathered_context -> 'extracted_variables'::text) ->> 'conversation_outcome'::text, 'inquiry'::text) AS conversation_outcome,
    (r.gathered_context -> 'extracted_variables'::text) ->> 'next_action'::text AS next_action,
    COALESCE(((r.gathered_context -> 'extracted_variables'::text) ->> 'follow_up_required'::text)::boolean, false) AS follow_up_required,
    (r.gathered_context -> 'extracted_variables'::text) ->> 'follow_up_datetime'::text AS follow_up_datetime,
    (r.gathered_context -> 'extracted_variables'::text) ->> 'call_notes'::text AS call_notes,
    COALESCE(((r.gathered_context -> 'extracted_variables'::text) ->> 'dnc_requested'::text)::boolean, false) AS dnc_requested,
    
    -- Raw Payload
    r.gathered_context -> 'extracted_variables'::text AS raw_extracted_variables
FROM public.workflow_runs r
JOIN public.workflows w ON r.workflow_id = w.id
WHERE w.name ILIKE '%Sales%' OR w.name ILIKE '%Excavator%' OR w.name ILIKE '%Vaani%' OR (r.gathered_context -> 'extracted_variables') IS NOT NULL;

COMMIT;
