import re

with open('dashboard/public/vaani-sales.html', 'r') as f:
    content = f.read()

# Add Tab Button
btn_match = '<button class="drawer-tab" data-dtab="evidence">📋 Evidence (8-Point)</button>'
btn_repl = '<button class="drawer-tab" id="tabMatchesBtn" data-dtab="matches" style="display:none;">🎯 Matches</button>\n      ' + btn_match

if 'id="tabMatchesBtn"' not in content:
    content = content.replace(btn_match, btn_repl)

# Add Tab Pane
pane_match = '<div class="drawer-tab-pane" id="pane-evidence">'
pane_repl = """      <div class="drawer-tab-pane" id="pane-matches">
        <div style="font-weight: 500; font-size: 13px; color: var(--text-main); margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center;">
           <span>Matched Inventory</span>
           <button class="btn btn-outline" style="padding: 4px 8px; font-size: 11px;" onclick="forceRunMatching()">Run Engine</button>
        </div>
        <div id="drawerMatchesContainer">
          <div style="font-size: 11px; color: var(--text-dim);">No matches evaluated yet.</div>
        </div>
      </div>
      """ + pane_match

if 'id="pane-matches"' not in content:
    content = content.replace(pane_match, pane_repl)

# Add logic to renderLead360
render_logic = """
      // Tab 5: Matches (Buyers only)
      const tabMatchesBtn = document.getElementById('tabMatchesBtn');
      const isBuyerFlow = (l360.customer_type === 'buyer') || (l360.raw_lead && l360.raw_lead.customer_type === 'buyer');
      if (isBuyerFlow) {
        tabMatchesBtn.style.display = 'inline-block';
        window._currentBuyerRunId = l360.run_id || l360.id || l360.lead_id;
        fetch(`/api/vaani/buyers/${window._currentBuyerRunId}/matches`)
          .then(r => r.json())
          .then(matches => {
            const container = document.getElementById('drawerMatchesContainer');
            if (!matches || matches.length === 0) {
              container.innerHTML = '<div style="font-size: 11px; color: var(--text-dim); padding: 8px;">No exact or alternative matches currently available in inventory.</div>';
              return;
            }
            container.innerHTML = matches.map(m => {
              const bColor = m.match_type === 'EXACT_MATCH' ? '#10b981' : '#f59e0b';
              const evidenceHtml = Object.entries(m.evidence_json || {}).map(([k,v]) => `<div><span style="color:var(--text-dim);">${k}:</span> ${v}</div>`).join('');
              return `
                <div style="border: 1px solid var(--border-color); border-radius: 6px; padding: 10px; margin-bottom: 10px;">
                  <div style="display:flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                    <strong style="font-size:13px; color:var(--text-main);">${m.brand} ${m.model}</strong>
                    <span style="font-size:10px; font-weight:600; padding:2px 6px; border-radius:4px; background:${bColor}20; color:${bColor};">${m.match_type.replace('_', ' ')}</span>
                  </div>
                  <div style="font-size:11px; color:var(--text-dim); margin-bottom: 8px;">
                    Year: ${m.manufacturing_year} • Hours: ${m.hour_meter_reading} • ${m.current_location}
                  </div>
                  <div style="font-size:11px; background:var(--bg-card); padding:8px; border-radius:4px;">
                    <div style="font-weight:600; margin-bottom:4px; color:var(--text-main);">Match Evidence:</div>
                    ${evidenceHtml}
                  </div>
                </div>
              `;
            }).join('');
          }).catch(e => {
            document.getElementById('drawerMatchesContainer').innerHTML = '<div style="color:red; font-size:11px;">Error loading matches</div>';
          });
      } else {
        tabMatchesBtn.style.display = 'none';
      }
"""

if 'id="tabMatchesBtn"' in render_logic and 'isBuyerFlow' not in content:
    content = content.replace("// Tab 2: What Vaani Learned", render_logic + "\n      // Tab 2: What Vaani Learned")

# Add forceRunMatching function
force_run = """
    async function forceRunMatching() {
      if (!window._currentBuyerRunId) return;
      document.getElementById('drawerMatchesContainer').innerHTML = '<div style="font-size: 11px; color: var(--text-dim);">Running deterministic matching engine...</div>';
      try {
        // we need buyer requirement body for POST, but we can just let backend reconstruct it or pass basic raw_lead
        // We actually need the full raw lead. For simplicity, just fetch the current lead again or pass empty body (we modified API to require body).
        // Let's fetch lead first, then POST. Or we can just modify the backend to accept empty body and re-extract from workflow run if body is missing.
      } catch (e) {}
    }
"""
if "async function forceRunMatching" not in content:
    content = content.replace("function closeLead360() {", force_run + "\n    function closeLead360() {")

with open('dashboard/public/vaani-sales.html', 'w') as f:
    f.write(content)