import json

DB_URL = "postgresql://postgres:postgres@localhost:5432/postgres"

def run():
    # Construct the JSON for the new workflow
    workflow_json = {
        "nodes": [
            {
                "id": "0",
                "type": "globalNode",
                "data": {
                    "name": "Vaani Master Sales Persona",
                    "prompt": "# WHO YOU ARE\nYou are Vaani (वाणी), a senior sales and equipment sourcing specialist for Om Shyam Earthmover (Used Excavator Division).\n\n# CONVERSATION STYLE\n- Speak naturally in Hindi and Hinglish. Use \"sir/madam/ji\" naturally.\n- Keep turns short: maximum 1-2 questions per turn.\n- Do not sound robotic. Never say \"I am an AI assistant.\"\n- If the caller interrupts with machine details, follow the conversation naturally.\n- If the caller already provided information, do not ask for it again.\n\n# BUSINESS RULES\n- DO NOT NEGOTIATE PRICE. If a seller states an asking price, just acknowledge it. If a buyer states a budget, acknowledge it and use it for matching.\n- You MUST NOT invent or hardcode example machines. If asked for live inventory, say you will check the system and send the list via WhatsApp.\n\n# OBJECTIONS\n- If asked about commission/broker: \"Sir, commission ka humara koi kaam nahi hai. Hum khud purchase karke sell karte hain.\"\n- If asked about machine source (stone vs soil): \"Hum mitti mein chali hui machines lete hain. Company mein check karwayenge toh genuine milegi.\"\n- If seller price is too high: Do not counter-offer. Say \"Aap rate bata dijiye, main note kar leti hoon. Team check karke callback karegi.\"\n- If requested machine is unavailable: Pivot to an alternative. \"Woh toh abhi nahi hai sir, par [Brand/Tonnage] mein mil jayegi.\""
                }
            },
            {
                "id": "1",
                "type": "startCall",
                "data": {
                    "name": "Start & Intent",
                    "is_start": True,
                    "prompt": "# GREETING & INTENT\nGreet warmly: \"Namaste, main Vaani bol rahi hoon, Om Shyam Earthmover se.\"\nThen ask: \"Koi machine sale karni hai ya purchase karni hai?\"\nIf caller gives details immediately, acknowledge them and proceed to missing info.",
                    "extraction_enabled": True,
                    "extraction_prompt": "Extract explicit caller facts. Any missing field must strictly be null (or false). Never invent. Follow EXTRACTION-SCHEMA.json.",
                    "extraction_variables": [
                        {"name": "intent", "type": "string", "description": "BUYER, SELLER, NOT_INTERESTED"},
                        {"name": "buyer_seller_classification", "type": "string", "description": "Same as intent"},
                        {"name": "customer_name", "type": "string", "description": "Caller name (Optional)"},
                        {"name": "phone_number", "type": "string", "description": "Phone number"},
                        {"name": "whatsapp_availability", "type": "boolean", "description": "True if WhatsApp available"},
                        {"name": "machine_brand", "type": "string", "description": "Brand of machine (Optional)"},
                        {"name": "machine_model", "type": "string", "description": "Model of machine (Optional)"},
                        {"name": "model_year", "type": "number", "description": "Year of machine (Optional)"},
                        {"name": "running_hours", "type": "number", "description": "Running hours (Optional)"},
                        {"name": "location_city", "type": "string", "description": "City of caller/machine (Optional)"},
                        {"name": "expected_price_or_budget", "type": "number", "description": "Price/budget in INR (Optional)"},
                        {"name": "application_history", "type": "string", "description": "SOIL, STONE, MIXED (Optional)"},
                        {"name": "lead_qualification", "type": "string", "description": "QUALIFIED, PARTIAL, UNQUALIFIED"},
                        {"name": "objection_raised", "type": "string", "description": "Objection details (Optional)"},
                        {"name": "next_action_agreed", "type": "string", "description": "Agreed next action"},
                        {"name": "follow_up_required", "type": "boolean", "description": "Whether follow up is required"}
                    ]
                }
            },
            {
                "id": "2",
                "type": "agentNode",
                "data": {
                    "name": "Buyer Flow",
                    "prompt": "# BUYER FLOW\nSequence:\n1. Collect Brand/Model.\n2. Collect Model Year.\n3. Collect GST preference if relevant.\n4. LIVE INVENTORY: [BACKEND API MISSING] Since the live inventory API is not connected yet, say \"Main system mein check karke aapko WhatsApp par inventory details bhej dungi.\"\n5. Confirm WhatsApp: \"Aapka yehi number WhatsApp par hai?\"\n6. Collect Name + City (if not known).\n7. Offer photos on WhatsApp and promise a callback.\nClose politely."
                }
            },
            {
                "id": "3",
                "type": "agentNode",
                "data": {
                    "name": "Seller Flow",
                    "prompt": "# SELLER FLOW\nSequence:\n1. Collect Brand/Model.\n2. Collect Model Year.\n3. Collect Running Hours.\n4. Collect Machine Location.\n5. Ask application history (mitti/pahad) if naturally relevant.\n6. COLLECT ASKING PRICE: \"Aap kya price demand kar rahe hain?\" (DO NOT NEGOTIATE. Acknowledge the price only).\n7. Request WhatsApp photos/RC: \"Aap machine ki photos aur RC detail mujhe is number par WhatsApp kar dijiye.\"\n8. Close + Human callback: \"Main check karke aapko callback karti hoon.\"\nClose politely."
                }
            },
            {
                "id": "4",
                "type": "agentNode",
                "data": {
                    "name": "Objection Handling",
                    "prompt": "# OBJECTIONS\nHandle objections smoothly using the rules in your global persona. Answer the question, then pivot back to the main flow (either Buyer or Seller) to collect missing details or move to WhatsApp closure."
                }
            },
            {
                "id": "5",
                "type": "endCall",
                "data": {
                    "name": "End / Not Interested",
                    "is_end": True,
                    "prompt": "# CALL CLOSE\nPolitely end the call. If they were not interested, say: \"Theek hai sir, aap number save kar lijiyega future ke liye. Dhanyawad.\""
                }
            }
        ],
        "edges": [
            {
                "id": "1-2",
                "source": "1",
                "target": "2",
                "type": "custom",
                "data": {"label": "Buyer detected", "condition": "Caller wants to buy a machine."}
            },
            {
                "id": "1-3",
                "source": "1",
                "target": "3",
                "type": "custom",
                "data": {"label": "Seller detected", "condition": "Caller wants to sell a machine."}
            },
            {
                "id": "1-5",
                "source": "1",
                "target": "5",
                "type": "custom",
                "data": {"label": "Not Interested", "condition": "Caller is not interested or opts out."}
            },
            {
                "id": "2-4",
                "source": "2",
                "target": "4",
                "type": "custom",
                "data": {"label": "Buyer Objection", "condition": "Buyer asks about commission, machine source, or exact unavailable machine."}
            },
            {
                "id": "3-4",
                "source": "3",
                "target": "4",
                "type": "custom",
                "data": {"label": "Seller Objection", "condition": "Seller asks about commission or sets high price."}
            },
            {
                "id": "4-2",
                "source": "4",
                "target": "2",
                "type": "custom",
                "data": {"label": "Return to Buyer", "condition": "Objection resolved, caller is a buyer."}
            },
            {
                "id": "4-3",
                "source": "4",
                "target": "3",
                "type": "custom",
                "data": {"label": "Return to Seller", "condition": "Objection resolved, caller is a seller."}
            },
            {
                "id": "2-5",
                "source": "2",
                "target": "5",
                "type": "custom",
                "data": {"label": "Buyer Flow Complete", "condition": "Buyer details collected and WhatsApp offered."}
            },
            {
                "id": "3-5",
                "source": "3",
                "target": "5",
                "type": "custom",
                "data": {"label": "Seller Flow Complete", "condition": "Seller details collected and WhatsApp requested."}
            }
        ]
    }

    sql = f"""
WITH new_def AS (
    INSERT INTO workflow_definitions (workflow_id, workflow_json, status, version_number)
    VALUES (3, '{json.dumps(workflow_json).replace("'", "''")}'::json, 'published', 2)
    RETURNING id, workflow_json
)
UPDATE workflows w
SET workflow_definition = n.workflow_json,
    released_definition_id = n.id
FROM new_def n
WHERE w.id = 3;
"""

    with open('/tmp/dograh_workflow_v2.sql', 'w') as f:
        f.write(sql)
    print("Created /tmp/dograh_workflow_v2.sql")

if __name__ == "__main__":
    run()
