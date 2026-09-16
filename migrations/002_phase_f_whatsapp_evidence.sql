-- ============================================================================
-- Migration: 002_phase_f_whatsapp_evidence.sql
-- Description: Phase F Step 4 - WhatsApp Evidence Engine & Outbound Message Ledger
-- Author: RapidX / Vaani AI
-- Target Engine: PostgreSQL 17 (dograh-local-postgres-1)
-- Security Boundary: Strict tenant isolation (organization_id NOT NULL REFERENCES organizations(id))
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Table: public.vaani_whatsapp_messages (Outbound Message Ledger)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.vaani_whatsapp_messages (
    message_id VARCHAR(64) PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    lead_id VARCHAR(64) NOT NULL,
    customer_id VARCHAR(64),
    phone_number VARCHAR(32) NOT NULL,
    message_type VARCHAR(32) NOT NULL DEFAULT 'TEXT',
    template_key VARCHAR(64),
    body TEXT NOT NULL,
    media_reference TEXT,
    status VARCHAR(32) NOT NULL DEFAULT 'QUEUED',
    direction VARCHAR(16) NOT NULL DEFAULT 'OUTBOUND',
    provider VARCHAR(32) NOT NULL DEFAULT 'mock',
    provider_message_id VARCHAR(128),
    idempotency_key VARCHAR(128),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at TIMESTAMP WITH TIME ZONE,
    delivered_at TIMESTAMP WITH TIME ZONE,
    read_at TIMESTAMP WITH TIME ZONE,
    failed_at TIMESTAMP WITH TIME ZONE,
    error_code VARCHAR(64),
    error_message TEXT,
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_vaani_wa_org ON public.vaani_whatsapp_messages(organization_id);
CREATE INDEX IF NOT EXISTS idx_vaani_wa_lead ON public.vaani_whatsapp_messages(organization_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_vaani_wa_idemp ON public.vaani_whatsapp_messages(organization_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_vaani_wa_status ON public.vaani_whatsapp_messages(organization_id, status);

-- ----------------------------------------------------------------------------
-- 2. Table: public.vaani_whatsapp_inbound_events (Webhook Ingress Ledger)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.vaani_whatsapp_inbound_events (
    event_id VARCHAR(128) PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    provider VARCHAR(32) NOT NULL DEFAULT 'mock',
    provider_event_type VARCHAR(64),
    from_phone VARCHAR(32) NOT NULL,
    to_phone VARCHAR(32),
    message_type VARCHAR(32) NOT NULL,
    text TEXT,
    media_url TEXT,
    mime_type VARCHAR(128),
    filename VARCHAR(255),
    processed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    raw_metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_vaani_wa_inbound_org ON public.vaani_whatsapp_inbound_events(organization_id);
CREATE INDEX IF NOT EXISTS idx_vaani_wa_inbound_phone ON public.vaani_whatsapp_inbound_events(organization_id, from_phone);

-- ----------------------------------------------------------------------------
-- 3. Enhance public.vaani_digital_evidence (8-Point Checklist Classification)
-- ----------------------------------------------------------------------------

ALTER TABLE public.vaani_digital_evidence
    ADD COLUMN IF NOT EXISTS lead_id VARCHAR(64),
    ADD COLUMN IF NOT EXISTS evidence_type VARCHAR(64),
    ADD COLUMN IF NOT EXISTS status VARCHAR(32) DEFAULT 'RECEIVED',
    ADD COLUMN IF NOT EXISTS source VARCHAR(64) DEFAULT 'whatsapp',
    ADD COLUMN IF NOT EXISTS provider_message_id VARCHAR(128),
    ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS verified_by VARCHAR(128),
    ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

-- Drop legacy media_type check constraint to support canonical 8-point types
ALTER TABLE public.vaani_digital_evidence DROP CONSTRAINT IF EXISTS vaani_digital_evidence_media_type_check;

CREATE INDEX IF NOT EXISTS idx_vaani_evidence_lead ON public.vaani_digital_evidence(organization_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_vaani_evidence_type ON public.vaani_digital_evidence(organization_id, evidence_type);

COMMIT;
