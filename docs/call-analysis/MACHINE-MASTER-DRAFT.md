# Vaani — Machine Master Draft & Nomenclature

**Project:** RapidX  
**Agent:** Vaani — AI Used Excavator Sales & Calling Agent  
**Purpose:** Ground truth machine taxonomy, model aliases, and application classification derived from real sales calls.

---

## 1. Machine Nomenclature & Brand Master

In the Indian used earthmoving machinery market (specifically North India/Rajasthan/MP), contractors frequently use colloquial names and model shorthand. Vaani must accurately normalize these spoken terms into structured catalog records.

| Brand | Standard Model Name | Spoken Shorthand / Aliases | Class / Tonnage | Market Positioning |
|-------|---------------------|----------------------------|-----------------|--------------------|
| **Tata Hitachi** | EX 200 LC | *Tata 200, EX 200, 200 Model, Bada Tata* | 20-Ton Class (20,000 kg) | Most liquid resale machine in India; highest buyer demand. |
| **Tata Hitachi** | EX 210 LC / Super | *Tata 210, 210 Super, EX 210* | 21-Ton Class | High fuel efficiency, preferred for soil work. |
| **Tata Hitachi** | EX 215 / EX 225 | *Tata 215, Tata 225 LC* | 21.5 - 22.5 Ton Class | Heavy quarry/trenching duty. |
| **Tata Hitachi** | ZAXIS 370 LCH | *Tata 370, Zaxis 370, 370 Poclain* | 37-Ton Heavy Class | Heavy granite/limestone mining and quarrying. |
| **JCB** | JS 205 | *JCB 205, JS 205, JCB Excavator* | 20.5-Ton Class | Popular for bulk earthwork, affordable parts. |
| **JCB** | JS 215 / JS 220 | *JCB 215, JCB 220, JS 220 LC* | 21.5 - 22 Ton Class | Heavy infrastructure and road projects. |
| **Hyundai** | Robex R210-7 / R215 | *Hyundai 210, Robex 210, Hyundai Poclain, Smart 210* | 21-Ton Class | Smooth hydraulics, strong resale in Rajasthan. |
| **Komatsu** | PC 210-10M0 | *Komatsu 210, PC 210* | 21-Ton Heavy Duty | Known for durability in tough stone breaking. |
| **Kobelco** | SK 210 / SK 220 | *Kobelco 210, SK 210 SuperX* | 21-Ton Class | Low fuel consumption, high cycle speed. |
| **Sany** | SY 215C | *Sany 215, Sany 200* | 21.5-Ton Class | Competitive pricing, growing market presence. |
| **Generic / Category** | Poclain | *Poclen, Poklen, Poklein, Poclain Machine* | All Excavators | In the trade, "Poclain" is commonly used as a generic term for any 360-degree hydraulic excavator. |

---

## 2. Machine Application & Working Condition Taxonomy

Derived directly from Recording #13 (`[064.0s - 072.0s]`):

```
"Hum to mitti mein chali hui machine lete hain... pahadon mein chali hui machine ka boom aur pump wear out ho jata hai."
```

| Application Category | Hindi / Regional Term | Operating Description | Impact on Valuation & Resale |
|----------------------|-----------------------|-----------------------|------------------------------|
| **Soil / Earthwork (Clean)** | *Mitti mein chali hui* | Soft soil excavation, canal digging, agricultural levelling, road grading. | **High Value (+15-20%):** Lower hydraulic strain, intact track chains, no micro-fractures on boom/arm. |
| **Stone / Rock Quarry** | *Pahad / Pathar mein chali* | Mountain stone quarrying, rock cutting, hard basalt handling. | **Medium Discount (-10-15%):** High undercarriage wear, stress on turntable and pins. |
| **Rock Breaker Application** | *Breaker pe chali hui* | Fitted with hydraulic rock breaker/hammer for demolition or boulder breaking. | **Heavy Discount (-20-30%):** Severe hydraulic pump pulsation wear, boom crack risk, bushing play. |

---

## 3. Observed Price Valuation Matrix (Real Call Evidence)

Based on actual price quotations and negotiations from the human call transcripts:

| Model Year | Machine Class | Condition / Application | Indicative Market Value (Lakhs INR) | Real Call Evidence |
|------------|---------------|-------------------------|-------------------------------------|-------------------|
| **2024 / 2023** | 20-Ton (Tata 200 / JCB 205) | Low Hours (1,000 - 2,500 hrs), Soil Work | **₹32.0L – ₹36.0L** | Recording #7 & #13 (Singrauli / Jaipur) |
| **2021 / 2022** | 20-Ton (Tata 200 / Hyundai 210) | Standard (4,000 - 7,000 hrs), General Work | **₹27.0L – ₹31.0L** | Market standard & inventory |
| **2018 / 2019** | 20-Ton (Tata 200 / JCB 205) | Medium-High Hours (8,000+ hrs), Soil | **₹19.0L – ₹24.0L** | Recording #14 (Satara call: Seller asked ₹25L; agent counter: ₹25L is excessive for 2019) |
| **2015 – 2017** | 20-Ton Class | High Hours / Mixed Work | **₹14.0L – ₹18.0L** | Budget buyer bracket |

---

## 4. Key Machine Inspection Checkpoints for Vaani Inquiries

When collecting machine details from sellers or recommending to buyers, Vaani checks:

1. **Brand & Model:** (e.g., Tata Hitachi EX 200 LC)
2. **Manufacturing Year:** (e.g., 2019 / 2024)
3. **Meter Reading / Working Hours:** (e.g., 3,500 hours)
4. **Application Type:** Soil (*mitti*) vs Quarry/Breaker (*pahad/breaker*)
5. **Location:** Current site/city (e.g., Jaipur, Satara, Singrauli)
6. **Documentation / RC:** Hypothecation clearance / NOC availability
7. **Asset Exchange:** WhatsApp request for 4-angle photos, meter photo, and 30-sec engine/hydraulic running video.
