CREATE TABLE IF NOT EXISTS vaani_buyer_machine_matches (
    id SERIAL PRIMARY KEY,
    organization_id INT NOT NULL,
    buyer_run_id INT NOT NULL,
    inventory_machine_id VARCHAR(64) NOT NULL,
    match_type VARCHAR(32) NOT NULL,
    match_status VARCHAR(32) DEFAULT 'NEW',
    evidence_json JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT vaani_buyer_machine_matches_org_fk FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    CONSTRAINT vaani_buyer_machine_matches_buyer_fk FOREIGN KEY (buyer_run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE,
    CONSTRAINT vaani_buyer_machine_matches_machine_fk FOREIGN KEY (inventory_machine_id) REFERENCES vaani_machines(machine_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_vaani_buyer_matches_org ON vaani_buyer_machine_matches(organization_id);
CREATE INDEX IF NOT EXISTS idx_vaani_buyer_matches_run ON vaani_buyer_machine_matches(buyer_run_id);
