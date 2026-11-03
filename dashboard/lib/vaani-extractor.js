/**
 * Vaani — Natural Hindi/Hinglish Sales Conversation to Structured Data Engine
 * Phase F — Step 2 Implementation
 * Grounded in EXTRACTION-SCHEMA.json, SELLER-BUYER-SCHEMAS.md, and MACHINE-MASTER-MODEL.md
 */

// ============================================================================
// 1. CANONICAL MACHINE MASTER TAXONOMY & ALIASES
// ============================================================================

const MACHINE_TAXONOMY = [
  {
    brand: 'Tata Hitachi',
    model: 'EX 200 LC',
    tonnage_class: '20_ton_class',
    operating_weight_kg: 20100,
    aliases: ['tata 200', 'ex 200', 'ex200', '200 model', 'bada tata', 'tata hitachi ex 200', 'tata hitachi 200', 'ex 200 lc']
  },
  {
    brand: 'Tata Hitachi',
    model: 'EX 210 LC',
    tonnage_class: '21_ton_class',
    operating_weight_kg: 20900,
    aliases: ['tata 210', 'ex 210', 'ex210', '210 super', 'tata hitachi 210', 'ex 210 lc']
  },
  {
    brand: 'Tata Hitachi',
    model: 'EX 215 LC',
    tonnage_class: '21_ton_class',
    operating_weight_kg: 21500,
    aliases: ['tata 215', 'ex 215', 'ex215', '215 lc', 'tata hitachi 215']
  },
  {
    brand: 'Tata Hitachi',
    model: 'EX 225 LC',
    tonnage_class: '21_ton_class',
    operating_weight_kg: 22500,
    aliases: ['tata 225', 'ex 225', 'ex225', '225 lc', 'tata hitachi 225']
  },
  {
    brand: 'Tata Hitachi',
    model: 'ZAXIS 370 LCH',
    tonnage_class: '30_plus_ton_class',
    operating_weight_kg: 36800,
    aliases: ['tata 370', 'zaxis 370', 'zaxis 370 lch', '370 poclain', 'ex 370']
  },
  {
    brand: 'JCB',
    model: 'JS 205',
    tonnage_class: '20_ton_class',
    operating_weight_kg: 20500,
    aliases: ['jcb 205', 'js 205', 'js205', 'jcb excavator 205', 'jcb excavator']
  },
  {
    brand: 'JCB',
    model: 'JS 215 / JS 220',
    tonnage_class: '21_ton_class',
    operating_weight_kg: 21900,
    aliases: ['jcb 215', 'jcb 220', 'js 215', 'js 220', 'js 220 lc', 'js215', 'js220']
  },
  {
    brand: 'Hyundai',
    model: 'Robex R210-7',
    tonnage_class: '21_ton_class',
    operating_weight_kg: 21200,
    aliases: ['hyundai 210', 'robex 210', 'smart 210', 'r210', 'r 210', 'r210-7', 'robex r210']
  },
  {
    brand: 'Hyundai',
    model: 'Robex R215',
    tonnage_class: '21_ton_class',
    operating_weight_kg: 21500,
    aliases: ['hyundai 215', 'robex 215', 'r215', 'r 215', 'robex r215']
  },
  {
    brand: 'Komatsu',
    model: 'PC 210-10M0',
    tonnage_class: '21_ton_class',
    operating_weight_kg: 21000,
    aliases: ['komatsu 210', 'pc 210', 'pc210', 'komatsu pc210', 'pc 210-10m0']
  },
  {
    brand: 'Kobelco',
    model: 'SK 210 SuperX',
    tonnage_class: '21_ton_class',
    operating_weight_kg: 21400,
    aliases: ['kobelco 210', 'sk 210', 'sk210', 'kobelco sk210']
  },
  {
    brand: 'Sany',
    model: 'SY 215C',
    tonnage_class: '21_ton_class',
    operating_weight_kg: 21800,
    aliases: ['sany 215', 'sy 215', 'sany 200', 'sy215', 'sy215c']
  },
  {
    brand: 'Other',
    model: 'Generic Hydraulic Excavator',
    tonnage_class: 'any',
    operating_weight_kg: 20000,
    aliases: ['poclain', 'poclen', 'poklen', 'poklein', 'पोकलेन']
  }
];

const KNOWN_BRANDS = [
  'Tata Hitachi', 'JCB', 'Hyundai', 'Komatsu', 'Kobelco', 'Sany', 'Caterpillar', 'Volvo', 'Doosan'
];

const KNOWN_CITIES_STATES = {
  'jaipur': { city: 'Jaipur', state: 'Rajasthan' },
  'kishangarh': { city: 'Kishangarh', state: 'Rajasthan', ambiguous: true },
  'ajmer': { city: 'Ajmer', state: 'Rajasthan' },
  'alwar': { city: 'Alwar', state: 'Rajasthan' },
  'jodhpur': { city: 'Jodhpur', state: 'Rajasthan' },
  'udaipur': { city: 'Udaipur', state: 'Rajasthan' },
  'satara': { city: 'Satara', state: 'Maharashtra' },
  'pune': { city: 'Pune', state: 'Maharashtra' },
  'mumbai': { city: 'Mumbai', state: 'Maharashtra' },
  'nagpur': { city: 'Nagpur', state: 'Maharashtra' },
  'singrauli': { city: 'Singrauli', state: 'Madhya Pradesh' },
  'bhopal': { city: 'Bhopal', state: 'Madhya Pradesh' },
  'indore': { city: 'Indore', state: 'Madhya Pradesh' },
  'raipur': { city: 'Chhattisgarh' },
  'ranchi': { city: 'Jharkhand' },
  'delhi': { city: 'Delhi', state: 'Delhi' },
  'gurgaon': { city: 'Gurgaon', state: 'Haryana' },
  'noida': { city: 'Noida', state: 'Uttar Pradesh' }
};

// Hindi + transliterated number words (1-99) to digits. Used ONLY as a
// fallback when no ASCII/Devanagari digits are present, so English words
// like "do" in "do excavator" can never corrupt digit-based parsing.
const HINDI_NUMBER_WORDS = {
  'ek': 1, 'do': 2, 'teen': 3, 'tin': 3, 'chaar': 4, 'char': 4,
  'paanch': 5, 'paanchh': 5, 'cheh': 6, 'chhah': 6, 'saat': 7, 'sath': 7,
  'aanth': 8, 'aath': 8, 'nau': 9, 'nau': 9, 'das': 10, 'dus': 10,
  'gyarah': 11, 'baarah': 12, 'barah': 12, 'terah': 13, 'chaudah': 14,
  'pandrah': 15, 'pandraah': 15, 'solah': 16, 'satrah': 17, 'sattrah': 17, 'sathrah': 17,
  'athaarah': 18, 'attharah': 18, 'atharah': 18, 'athrah': 18, 'unnees': 19, 'unnis': 19,
  'bees': 20, 'bis': 20, 'vees': 20, 'ikkees': 21, 'ikkis': 21,
  'bais': 22, 'baees': 22, 'teis': 23, 'tayees': 23, 'chaubees': 24,
  'pachees': 25, 'pachchees': 25, 'pachchis': 25, 'pachis': 25, 'chhabbees': 26, 'sattaees': 27,
  'atthaees': 28, 'untees': 29, 'untis': 29, 'tees': 30, 'paintees': 35,
  'chaalis': 40, 'pachaas': 50, 'saath': 60, 'sattar': 70, 'assi': 80,
  'nabbe': 90,
  'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पाँच': 5, 'पांच': 5,
  'छह': 6, 'छै': 6, 'सात': 7, 'आठ': 8, 'नौ': 9, 'दस': 10,
  'ग्यारह': 11, 'बारह': 12, 'तेरह': 13, 'चौदह': 14, 'पंद्रह': 15,
  'पन्द्रह': 15, 'सोलह': 16, 'सत्रह': 17, 'अठारह': 18, 'उन्नीस': 19,
  'बीस': 20, 'इक्कीस': 21, 'बाइस': 22, 'बाईस': 22, 'तेईस': 23,
  'चौबीस': 24, 'पच्चीस': 25, 'पचीस': 25, 'छब्बीस': 26, 'सत्ताईस': 27,
  'अट्ठाईस': 28, 'उन्तीस': 29, 'तीस': 30, 'चालीस': 40, 'पचास': 50,
  'साठ': 60, 'सत्तर': 70, 'अस्सी': 80, 'नब्बे': 90,
  'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
  'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
};

// Hindi Devanagari digits to ASCII digits
function normalizeHindiNumerals(text) {
  if (!text) return '';
  const devanagariDigits = ['०', '१', '२', '३', '४', '५', '६', '७', '८', '९'];
  let res = String(text);
  for (let i = 0; i < 10; i++) {
    res = res.replaceAll(devanagariDigits[i], String(i));
  }
  return res;
}

// ============================================================================
// 2. VALUE NORMALIZATION UTILITIES
// ============================================================================

/**
 * Normalizes Indian prices in Lakh, Lac, L, Thousand, Crore into integer INR.
 * Strictly avoids guessing numbers without units.
 */
function wordsToDigitsForBudget(text) {
  // Replace number words ONLY adjacent to a budget unit, so unrelated words
  // ("do excavator", "ek minute") are never touched.
  return String(text).replace(
    new RegExp('([\\w\u0900-\u097F]+)\\s*(lakh|lac|lacs|lakhs|l|\u0932\u093E\u0916|\u0939\u091C\u093E\u0930|thousand|crore|cr)\\b', 'gi'),
    (m, w, u) => {
      const key = String(w).toLowerCase();
      if (Object.prototype.hasOwnProperty.call(HINDI_NUMBER_WORDS, key)) return HINDI_NUMBER_WORDS[key] + ' ' + u;
      if (/^\d+(\.\d+)?$/.test(key)) return m;
      return m;
    }
  );
}

function parseWordBudget(rawText) {
  // Word-form budgets ("bees se bais lakh") without any digits. Tried only
  // when digit parsing finds nothing.
  const lowered = normalizeHindiNumerals(rawText).toLowerCase();
  const unitRe = '(lakh|lac|lacs|lakhs|l|\u0932\u093E\u0916|\u0939\u091C\u093E\u0930|thousand|crore|cr)';
  const words = Object.keys(HINDI_NUMBER_WORDS).sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const edge = '(?:^|(?<=[^\\w\u0900-\u097F]))';
  const tail = '(?=$|[^\\w\u0900-\u097F])';
  const rangeRe = new RegExp(edge + '(' + words + ')\\s*(?:-|se|to|\u0938\u0947)\\s*(' + words + ')\\s*' + unitRe + tail, 'i');
  const rm = lowered.match(rangeRe);
  const mult = (u) => (/\u0939\u091C\u093E\u0930|thousand/i.test(u) ? 1000 : (/crore|^cr$/i.test(u) ? 10000000 : 100000));
  if (rm) {
    const a = HINDI_NUMBER_WORDS[rm[1].toLowerCase()];
    const b = HINDI_NUMBER_WORDS[rm[2].toLowerCase()];
    if (a !== undefined && b !== undefined) {
      const m = mult(rm[3]);
      return { min_inr: Math.round(a * m), max_inr: Math.round(b * m), exact_inr: Math.round(b * m), raw: rm[0], qualifier: 'range' };
    }
  }
  const singleRe = new RegExp(edge + '(' + words + ')\\s*' + unitRe + tail, 'i');
  const sm = lowered.match(singleRe);
  if (sm) {
    const a = HINDI_NUMBER_WORDS[sm[1].toLowerCase()];
    if (a !== undefined) {
      const inr = Math.round(a * mult(sm[2]));
      return { min_inr: inr, max_inr: inr, exact_inr: inr, raw: sm[0], qualifier: 'exact' };
    }
  }
  return null;
}

const QUANTITY_WORDS = { ek: 1, do: 2, teen: 3, tin: 3, chaar: 4, char: 4, paanch: 5, cheh: 6, saat: 7, aath: 8, nau: 9, das: 10, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

function parseSpokenQuantity(rawText) {
  // Quantity only when a machine noun or a want-verb is adjacent, so bare
  // counts ("ek minute", "do baar") never match.
  if (!rawText) return null;
  const text = normalizeHindiNumerals(rawText).toLowerCase();
  const numAlt = '(\\d+|ek|do|teen|tin|chaar|char|paanch|cheh|saat|aath|nau|das|one|two|three|four|five|six|seven|eight|nine|ten)';
  const nounRe = new RegExp('\\b' + numAlt + '\\s*(machine|machines|excavator|excavators|jcb|loader|dozer|poclain|hydra|crane)[s]?\\b', 'i');
  const m = text.match(nounRe);
  if (m) {
    const n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : QUANTITY_WORDS[m[1]];
    if (n >= 1 && n <= 20) return { quantity: n, raw: m[0] };
    return null;
  }
  const verbRe = new RegExp('\\b' + numAlt + '\\s*\\w{0,12}\\s*(chahiye|chahiyen|chahida|lena|leni|lene|hai)\\b', 'i');
  const v = text.match(verbRe);
  if (v && /chahiye|chahiyen|chahida|lena|leni|lene/i.test(v[0])) {
    const n = /^\d+$/.test(v[1]) ? parseInt(v[1], 10) : QUANTITY_WORDS[v[1]];
    if (n >= 1 && n <= 20) return { quantity: n, raw: v[0] };
  }
  return null;
}

function parseFinanceRequirement(rawText) {
  // Buyer-side finance need only. Seller mentions of existing loans
  // ("loan chal raha hai") are handled as document status elsewhere.
  if (!rawText) return null;
  const text = String(rawText).toLowerCase();
  if (/(?:finance|loan|emi|emat|kist|qist|credit)(?:\s*\w{0,10})?\s*(karwana|karana|len[ai]|lena|chahiye|par|per|pe|hoga|hogi)/.test(text)
    || /(?:financ|loan)\s*(?:chahiye|karwana)/.test(text)) {
    if (/\b(?:nahi|na|mat|without)\b/.test(text)) return null;
    return true;
  }
  if (/(?:cash|nakad|nagad|nakat)(?:\s*\w{0,10})?\s*(mein|me|lenga|lunga|lungi|dena|dunga|payment)/.test(text)
    || /full\s*payment|ek\s*saath\s*(paisa|payment)|poora\s*paisa/.test(text)) {
    return false;
  }
  return null;
}

function parseWhatsappRequest(rawText) {
  // Buyer asking Vaani to SEND details ("bhej do / de dijiye").
  // Promises to send ("bhej dunga/dungi") belong to evidence_readiness.
  if (!rawText) return false;
  const text = String(rawText).toLowerCase();
  if (/(?:bhej\s*dunga|bhej\s*dungi|send\s*kar\s*dunga|bhej\s*deta)/.test(text)) return false;
  return /(?:whatsapp\s*(?:par|pe|parr)?\s*(?:bhej|bhejo|send|share|kar\s*do|de\s*dijiye|details?)|details?\s*(?:whatsapp|wa)?\s*(?:par|pe)?\s*(?:bhej|send|kar\s*do|de\s*dijiye)|machine\s*(?:ki\s*)?details?\s*(?:whatsapp\s*(?:par|pe)?\s*)?(?:bhej|send))/.test(text);
}

function parseApplicationHistory(rawText) {
  // Single implementation backing both the class section and any caller:
  // returns rock_breaker/quarry_rock/soil_earthwork/mixed or null.
  if (!rawText) return null;
  const tLower = String(rawText).toLowerCase();
  if (/(?:breaker|rock breaker|hammer|\u092c\u094d\u0932\u0947\u0915\u0930|\u0939\u0925\u094c\u0921\u093c\u093e)/.test(tLower)) return 'rock_breaker';
  if (/(?:pahad|pathar|stone|quarry|mining|gitti|\u092a\u0939\u093e\u0921\u093c|\u092a\u0924\u094d\u0925\u0930)/.test(tLower)) return 'quarry_rock';
  if (/(?:mitti|soil|canal|earthwork|khet|soil excavation|\u092e\u093f\u091f\u094d\u091f\u0940)/.test(tLower)) return 'soil_earthwork';
  if (/(?:dono|mixed|kabhi mitti kabhi breaker)/.test(tLower)) return 'mixed';
  return null;
}

function parseSaleUrgency(rawText) {
  // Seller-only explicit urgency. Conservative: bare "jaldi"/"abhi"/"rate"/
  // "market" never resolve without the surrounding sale/exploration statement.
  // Returns URGENT/SOON/EXPLORING/NORMAL/null (never guesses).
  if (!rawText) return null;
  const text = String(rawText).toLowerCase();
  if (/(?:jaldi\s*(?:se\s*)?(?:bechna|bechni|sale\s*karni|bech\s*dena)|turant\s*(?:bechna|bechni|sale)|abhi\s*(?:bechna|bechni|sale\s*karna)|fatafat\s*bechna|jaldi\s*se\s*sale\s*karni|immediately\s*sell)/.test(text)) {
    return 'URGENT';
  }
  if (/(?:jaldi\s*hi\s*bech(?:na|ni|\s*unga|\s*dunga)|kuch\s*din\s*mein\s*bechna|is\s*hafte\s*bechna|next\s*week\s*tak\s*bechna|soon\s*sell)/.test(text)) {
    return 'SOON';
  }
  if (/(?:abhi\s*rate\s*pata\s*kar|bas\s*market\s*dekh|abhi\s*options\s*dekh|pehle\s*rate\s*check|abhi\s*decide\s*nahi|abhi\s*soch\s*rah)/.test(text)) {
    return 'EXPLORING';
  }
  return null;
}

function parsePriceNegotiability(rawText) {
  // Seller-only explicit flexibility language. Conservative: bare prices or
  // vague words never resolve. Returns true/false/null (never guesses).
  if (!rawText) return null;
  const text = String(rawText).toLowerCase();
  // Explicit NON-negotiable first (strongest, most specific).
  if (/(?:bilkul\s*final|ek\s*dam\s*final|final\s+(?:hai|price|rate)|\blast\s*price(?:\s+hai)?|isse\s*kam\s*nahi|isse\s*ni?che\s*nahi|\bfixed\b(?:\s*(?:hai|price|rate))?|\bno\s*negotiation\b|negotiation\s*nahi|rate\s*final|daam\s*final)/.test(text)) {
    return false;
  }
  if (/(?:kam\s*ho\s*jaye(?:ga|gi)?|thoda\s*kam|kuch\s*kam\s*ho|negotiable(?:\s*hai)?|negotiate\s*ho|baat\s*ho\s*jaye(?:ga|gi)?|final\s*nahi\s*hai|adjust\s*kar\s*lenge|(?:price|rate)\s*flexible\s*hai|gunjaish\s*hai|thoda\s*bahut\s*kam)/.test(text)) {
    return true;
  }
  return null;
}

function parseSpokenPrice(rawText) {
  if (!rawText) return null;
  const text = normalizeHindiNumerals(rawText).toLowerCase();
  const approx = /(?:\b(?:around|approx(?:imately)?|almost|kareeb|lagbhag|lagbhag|aaspass|aaju\s*baaju)\b)/i.test(text);
  const maxOnly = /(?:\btak\b|\bse\s*kam\b|\bkam\s*se\b|\bse\s*neeche\b|\bunder\b|\bbelow\b|\bmaximum\b|\bup\s*to\b)/i.test(text);

  // Range match e.g. "22-25 lakh", "22 se 25 lakh", "20 to 22 l"
  const rangeMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:-|se|to|\u0938\u0947)\s*(\d+(?:\.\d+)?)\s*(lakh|lac|lacs|lakhs|l|लाख|हजार|crore|cr)(?:\b|[^\w\u0900-\u097F]|$)/i);
  if (rangeMatch) {
    const minVal = parseFloat(rangeMatch[1]);
    const maxVal = parseFloat(rangeMatch[2]);
    const unit = rangeMatch[3].toLowerCase();
    let multiplier = 100000;
    if (unit.includes('हजार') || unit.includes('thousand')) multiplier = 1000;
    else if (unit.includes('crore') || unit.includes('cr')) multiplier = 10000000;

    return {
      min_inr: Math.round(minVal * multiplier),
      max_inr: Math.round(maxVal * multiplier),
      exact_inr: Math.round(maxVal * multiplier),
      raw: rangeMatch[0],
      qualifier: 'range'
    };
  }

  // Single price e.g. "24 lakh", "24.5 lakh", "24 l", "24 लाख", "50 हजार"
  const singleMatch = text.match(/(\d+(?:\.\d+)?)\s*(lakh|lac|lacs|lakhs|l|लाख|हजार|thousand|crore|cr)(?:\b|[^\w\u0900-\u097F]|$)/i);
  if (singleMatch) {
    const num = parseFloat(singleMatch[1]);
    const unit = singleMatch[2].toLowerCase();
    let multiplier = 100000;
    if (unit.includes('हजार') || unit.includes('thousand')) multiplier = 1000;
    else if (unit.includes('crore') || unit.includes('cr')) multiplier = 10000000;

    const inr = Math.round(num * multiplier);
    if (maxOnly) {
      return { min_inr: null, max_inr: inr, exact_inr: inr, raw: singleMatch[0], qualifier: 'max' };
    }
    return {
      min_inr: inr,
      max_inr: inr,
      exact_inr: inr,
      raw: singleMatch[0],
      qualifier: approx ? 'approximate' : 'exact'
    };
  }

  // Hindi "हजार में" or "लाख में" with prior digit
  const inUnitMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:mein|me)?\s*(laakh|lakh|l|लाख)/i);
  if (inUnitMatch) {
    const num = parseFloat(inUnitMatch[1]);
    const inr = Math.round(num * 100000);
    return {
      min_inr: inr,
      max_inr: inr,
      exact_inr: inr,
      raw: inUnitMatch[0],
      qualifier: 'exact'
    };
  }

  // Fallback: number-word budgets with no digits ("bees se bais lakh").
  const wordRes = parseWordBudget(rawText);
  if (wordRes) {
    if (maxOnly && wordRes.qualifier === 'exact') {
      return { ...wordRes, min_inr: null, qualifier: 'max' };
    }
    if (approx && wordRes.qualifier === 'exact') {
      return { ...wordRes, qualifier: 'approximate' };
    }
    return wordRes;
  }

  return null;
}

/**
 * Normalizes Indian telephone numbers to E.164 (+91...).
 * Rejects invalid length or impossible prefixes.
 */
function normalizeIndianPhone(rawPhone) {
  if (!rawPhone) return null;
  const digits = String(rawPhone).replace(/\D/g, '');
  if (digits.length === 10 && /^[6-9]/.test(digits)) {
    return `+91${digits}`;
  }
  if (digits.length === 12 && digits.startsWith('91') && /^[6-9]/.test(digits.slice(2))) {
    return `+${digits}`;
  }
  return null;
}

/**
 * Normalizes model year within 2005 - 2026.
 */
function parseModelYear(text) {
  if (!text) return null;
  const cleaned = normalizeHindiNumerals(text);
  const match = cleaned.match(/\b(200[5-9]|201[0-9]|202[0-6])\b/);
  if (match) {
    return parseInt(match[1], 10);
  }
  // Also check two digit years if accompanied by "model" e.g. "19 model", "20 model"
  const shortMatch = cleaned.match(/\b(0[5-9]|1[0-9]|2[0-6])\s*(?:ka\s*)?model\b/i);
  if (shortMatch) {
    return 2000 + parseInt(shortMatch[1], 10);
  }
  return null;
}

/**
 * Normalizes operating hours (0 to 50,000).
 */
function parseOperatingHours(text) {
  if (!text) return null;
  const cleaned = normalizeHindiNumerals(text).toLowerCase();
  const match = cleaned.match(/(\d{2,5})\s*(?:ghante|hours|hr|hrs|घंटे|घण्टे)/);
  if (match) {
    const hrs = parseInt(match[1], 10);
    if (hrs >= 0 && hrs <= 50000) {
      return hrs;
    }
  }
  return null;
}

/**
 * Matches machine make/model against canonical taxonomy.
 * Returns { brand, model, tonnage_class, is_canonical: true/false, raw_match }
 */
function matchMachineModel(text) {
  if (!text) return null;
  const cleaned = text.toLowerCase();

  for (const item of MACHINE_TAXONOMY) {
    for (const alias of item.aliases) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\b${escaped}\\b`, 'i');
      if (regex.test(cleaned)) {
        return {
          brand: item.brand,
          model: item.model,
          tonnage_class: item.tonnage_class,
          is_canonical: true,
          raw_match: alias
        };
      }
    }
  }

  // Check explicit brand without known model
  for (const brand of KNOWN_BRANDS) {
    const regex = new RegExp(`\\b${brand.toLowerCase()}\\b`, 'i');
    if (regex.test(cleaned)) {
      const modelMatch = cleaned.match(new RegExp(`${brand.toLowerCase()}\\s+([a-z0-9-]+)`, 'i'));
      const rawSubModel = modelMatch ? modelMatch[1] : null;
      return {
        brand: brand,
        model: null,
        raw_model: rawSubModel,
        tonnage_class: 'unknown',
        is_canonical: false,
        raw_match: brand
      };
    }
  }

  // Check generic tonnage specification e.g. "20 ton", "21 ton"
  const tonMatch = cleaned.match(/\b(20|21|22|30|35|37|sub-10|mini)\s*(?:-|ton|tonne|टन)/i);
  if (tonMatch) {
    const tonNum = tonMatch[1].toLowerCase();
    let tClass = 'unknown';
    if (tonNum === '20') tClass = '20_ton_class';
    else if (tonNum === '21' || tonNum === '22') tClass = '21_ton_class';
    else if (tonNum === '30' || tonNum === '35' || tonNum === '37') tClass = '30_plus_ton_class';
    else if (tonNum === 'sub-10' || tonNum === 'mini') tClass = 'mini_sub_10t';

    return {
      brand: null,
      model: null,
      tonnage_class: tClass,
      is_canonical: false,
      raw_match: tonMatch[0]
    };
  }

  return null;
}

/**
 * Resolves location with disambiguation support.
 */
function parseLocation(text) {
  if (!text) return null;
  const cleaned = text.toLowerCase();

  // Special disambiguation for Kishangarh
  if (cleaned.includes('kishangarh')) {
    if (cleaned.includes('ajmer')) {
      return {
        city: 'Kishangarh (Ajmer)',
        state: 'Rajasthan',
        ambiguous: false,
        raw: 'Kishangarh Ajmer'
      };
    }
    if (cleaned.includes('alwar')) {
      return {
        city: 'Kishangarh Bas (Alwar)',
        state: 'Rajasthan',
        ambiguous: false,
        raw: 'Kishangarh Alwar'
      };
    }
    return {
      city: 'Kishangarh',
      state: 'Rajasthan',
      ambiguous: true,
      raw: 'Kishangarh'
    };
  }

  for (const [key, loc] of Object.entries(KNOWN_CITIES_STATES)) {
    if (cleaned.includes(key)) {
      return {
        city: loc.city,
        state: loc.state || 'Rajasthan',
        ambiguous: Boolean(loc.ambiguous),
        raw: key
      };
    }
  }

  return null;
}

// ============================================================================
// 3. MULTI-TURN EXTRACTION WITH CONFLICT RESOLUTION & PROVENANCE
// ============================================================================

class VaaniConversationExtractor {
  constructor() {
    this.reset();
  }

  reset() {
    this.extracted = {
      caller_name: null,
      callback_number: null,
      whatsapp_number: null,
      customer_type: 'unknown',
      ownership_type: 'unknown',
      machine_details: {
        brand: null,
        model: null,
        quantity: null,
        model_year: null,
        running_hours: null,
        tonnage_class: 'unknown',
        application_history: 'unknown',
        machine_condition_summary: null,
        location_city: null,
        location_state: null,
        document_status: 'unknown'
      },
      commercial_terms: {
        expected_price_inr: null,
        price_negotiable: null,
        sale_urgency: null,
        budget_max_inr: null,
        budget_min_inr: null,
        price_or_budget_raw: null,
        budget_qualifier: null,
        finance_required: null,
        purchase_timeline: 'not_applicable',
        yard_visit_agreed: false,
        yard_visit_schedule: null
      },
      evidence_readiness: {
        photos_agreed: false,
        running_video_agreed: false,
        rc_copy_agreed: false,
        evidence_status: 'none'
      },
      condition_details: {
        engine: 'unknown',
        pump: 'unknown',
        undercarriage: 'unknown',
        boom: 'unknown',
        cabin: 'unknown'
      },
      evidence_breakdown: {
        boom_photo: false,
        undercarriage_photo: false,
        cabin_photo: false,
        counterweight_photo: false,
        hour_meter_photo: false,
        running_video: false,
        rc_copy: false,
        finance_noc: false
      },
      buyer_requirements: {
        required_machine_type: 'excavator',
        brand: null,
        model: null,
        tonnage: 'unknown',
        application: 'unknown',
        refurbished_preference: 'either',
        urgency: 'normal'
      },
      dnc_requested: false,
      whatsapp_requested: false,
      whatsapp_action: null,
      call_notes: ''
    };

    this.provenance = {};
    this.history = [];
    this.turnsProcessed = 0;
  }

  _setField(path, value, raw, confidence, sourceTurn, isCorrection = false) {
    if (value === undefined || value === null) return;

    const parts = path.split('.');
    let target = this.extracted;
    for (let i = 0; i < parts.length - 1; i++) {
      target = target[parts[i]];
    }
    const finalKey = parts[parts.length - 1];
    const prevValue = target[finalKey];

    if (prevValue !== null && prevValue !== undefined && prevValue !== 'unknown' && prevValue !== false && prevValue !== value) {
      this.history.push({
        field: path,
        previous_value: prevValue,
        new_value: value,
        corrected_at_turn: sourceTurn,
        raw_text: raw,
        reason: isCorrection ? 'explicit_correction' : 'updated_statement'
      });
    }

    target[finalKey] = value;
    this.provenance[path] = {
      value: value,
      raw: raw,
      confidence: confidence,
      source: `turn_${sourceTurn}_caller`,
      turn: sourceTurn
    };
  }

  _isCorrectionUtterance(text) {
    const correctionRegex = /(?:nahi nahi|nahi sir|actually|galat bol diya|sorry|matlab|baad mein yaad aaya|pehle galat tha)/i;
    return correctionRegex.test(text);
  }

  processTurn(userText, turnIndex = 1) {
    if (!userText || typeof userText !== 'string') return;
    const text = userText.trim();
    const tLower = text.toLowerCase();
    const isCorrection = this._isCorrectionUtterance(text);
    this.turnsProcessed++;

    // 1. DNC / COMPLIANCE OVERRIDE
    const dncTriggers = [
      'phone mat karo', 'call mat karna', 'number hatao', 'do not call',
      'disturb mat karo', 'dobara phone mat karna', 'cut the call', "don't call",
      'number delete kar do', 'call band karo'
    ];
    if (dncTriggers.some(t => tLower.includes(t))) {
      this._setField('dnc_requested', true, text, 'HIGH', turnIndex);
      return;
    }

    // 2. CUSTOMER TYPE
    const sellerKeywords = ['bechna', 'bechni', 'sell', 'bikau', 'mere paas hai', 'hamare paas', 'hata rahe hain', 'nikalni hai'];
    const buyerKeywords = ['chahiye', 'kharidna', 'kharidni', 'purchase', 'requirement', 'leni hai', 'dekh raha hoon', 'project ke liye'];

    if (sellerKeywords.some(w => tLower.includes(w))) {
      this._setField('customer_type', 'seller', text, 'HIGH', turnIndex, isCorrection);
    } else if (buyerKeywords.some(w => tLower.includes(w))) {
      this._setField('customer_type', 'buyer', text, 'HIGH', turnIndex, isCorrection);
    }

    // 3. OWNERSHIP TYPE
    if (tLower.match(/(?:munim|broker|mediator|dalal|commission|kisi aur ki|party ki machine)/)) {
      this._setField('ownership_type', 'broker_munim', text, 'HIGH', turnIndex, isCorrection);
    } else if (tLower.match(/(?:khud ki|direct owner|apni machine|meri machine|mera naam)/)) {
      this._setField('ownership_type', 'direct_owner', text, 'HIGH', turnIndex, isCorrection);
    }

    // 4. MACHINE MAKE, MODEL & TONNAGE
    const modelInfo = matchMachineModel(text);
    if (modelInfo) {
      if (modelInfo.brand) {
        this._setField('machine_details.brand', modelInfo.brand, modelInfo.raw_match, 'HIGH', turnIndex, isCorrection);
        if (this.extracted.customer_type === 'buyer') {
          this._setField('buyer_requirements.brand', modelInfo.brand, modelInfo.raw_match, 'HIGH', turnIndex, isCorrection);
        }
      }
      if (modelInfo.model) {
        this._setField('machine_details.model', modelInfo.model, modelInfo.raw_match, 'HIGH', turnIndex, isCorrection);
        if (this.extracted.customer_type === 'buyer') {
          this._setField('buyer_requirements.model', modelInfo.model, modelInfo.raw_match, 'HIGH', turnIndex, isCorrection);
        }
      } else if (modelInfo.raw_model) {
        this.provenance['machine_details.model_raw'] = {
          value: null,
          raw: modelInfo.raw_model,
          confidence: 'LOW',
          source: `turn_${turnIndex}_caller`
        };
      }

      if (modelInfo.tonnage_class && modelInfo.tonnage_class !== 'unknown') {
        const conf = modelInfo.is_canonical ? 'HIGH' : 'MEDIUM';
        this._setField('machine_details.tonnage_class', modelInfo.tonnage_class, modelInfo.raw_match, conf, turnIndex, isCorrection);
        if (this.extracted.customer_type === 'buyer') {
          this._setField('buyer_requirements.tonnage', modelInfo.tonnage_class, modelInfo.raw_match, conf, turnIndex, isCorrection);
        }
      }

      if (this.extracted.customer_type === 'unknown' && modelInfo.model) {
        this._setField('customer_type', 'seller', modelInfo.raw_match, 'MEDIUM', turnIndex);
      }
    }

    // 5. MODEL YEAR (Check for self-correction inside the same turn)
    // E.g. "2020 model hai... nahi nahi, 2019 model hai"
    const allYears = Array.from(normalizeHindiNumerals(text).matchAll(/\b(200[5-9]|201[0-9]|202[0-6])\b/g)).map(m => parseInt(m[1], 10));
    if (allYears.length > 1) {
      // Multiple years in one turn: take the last one as authoritative correction
      const firstYear = allYears[0];
      const finalYear = allYears[allYears.length - 1];
      this._setField('machine_details.model_year', firstYear, String(firstYear), 'HIGH', turnIndex, false);
      this._setField('machine_details.model_year', finalYear, String(finalYear), 'HIGH', turnIndex, true);
    } else if (allYears.length === 1) {
      this._setField('machine_details.model_year', allYears[0], text, 'HIGH', turnIndex, isCorrection);
    } else {
      const year = parseModelYear(text);
      if (year) {
        this._setField('machine_details.model_year', year, text, 'HIGH', turnIndex, isCorrection);
      }
    }

    // 6. OPERATING HOURS
    const hours = parseOperatingHours(text);
    if (hours !== null) {
      this._setField('machine_details.running_hours', hours, text, 'HIGH', turnIndex, isCorrection);
    }

    // 7. APPLICATION HISTORY (single implementation: parseApplicationHistory)
    const appHistory = parseApplicationHistory(text);
    if (appHistory) {
      this._setField('machine_details.application_history', appHistory, text, 'HIGH', turnIndex, isCorrection);
      if (this.extracted.customer_type === 'buyer' && appHistory !== 'mixed') {
        this._setField('buyer_requirements.application', appHistory, text, 'HIGH', turnIndex, isCorrection);
      }
    }

    // 8. MECHANICAL CONDITION
    if (tLower.match(/(?:original engine|sealed engine|engine sealed|engine badhiya)/) || (tLower.includes('engine') && (tLower.includes('sealed') || tLower.includes('original')))) {
      this._setField('condition_details.engine', 'original_sealed', text, 'HIGH', turnIndex, isCorrection);
    } else if (tLower.match(/(?:engine banwaya|engine overhaul|serviced)/)) {
      this._setField('condition_details.engine', 'overhauled_serviced', text, 'HIGH', turnIndex, isCorrection);
    } else if (tLower.match(/(?:dhua|smoke|blowby|engine kamzor)/)) {
      this._setField('condition_details.engine', 'smoking_blowby', text, 'HIGH', turnIndex, isCorrection);
    }

    if (tLower.match(/(?:pump mast|healthy pump|speed achhi|original pump)/) || (tLower.includes('pump') && (tLower.includes('healthy') || tLower.includes('original') || tLower.includes('mast')))) {
      this._setField('condition_details.pump', 'original_healthy', text, 'HIGH', turnIndex, isCorrection);
    } else if (tLower.match(/(?:pump banwaya|pump repair)/)) {
      this._setField('condition_details.pump', 'repaired_replaced', text, 'HIGH', turnIndex, isCorrection);
    } else if (tLower.match(/(?:pump slow|speed kam|pump weak)/)) {
      this._setField('condition_details.pump', 'weak_slow_cycle', text, 'HIGH', turnIndex, isCorrection);
    }

    if (tLower.match(/(?:chain 70|chain 80|track 70|track 80|undercarriage fresh|chain mast)/)) {
      this._setField('condition_details.undercarriage', 'good_70_plus', text, 'HIGH', turnIndex, isCorrection);
    } else if (tLower.match(/(?:chain 50|chain 60|track average)/)) {
      this._setField('condition_details.undercarriage', 'average_50_70', text, 'HIGH', turnIndex, isCorrection);
    } else if (tLower.match(/(?:chain down|track ghisa|chain sub 50)/)) {
      this._setField('condition_details.undercarriage', 'worn_sub_50', text, 'HIGH', turnIndex, isCorrection);
    }

    if (tLower.match(/(?:boom crack nahi|original boom|no crack)/)) {
      this._setField('condition_details.boom', 'original_no_cracks', text, 'HIGH', turnIndex, isCorrection);
    } else if (tLower.match(/(?:boom weld|boom repair|crack repair)/)) {
      this._setField('condition_details.boom', 'welded_repaired', text, 'HIGH', turnIndex, isCorrection);
    }

    // 9. LOCATION & GEOGRAPHY
    const loc = parseLocation(text);
    if (loc) {
      if (loc.ambiguous) {
        this.extracted.location_ambiguous = true;
        this._setField('machine_details.location_city', loc.city, loc.raw, 'LOW', turnIndex, isCorrection);
      } else {
        this.extracted.location_ambiguous = false;
        this._setField('machine_details.location_city', loc.city, loc.raw, 'HIGH', turnIndex, isCorrection);
        this._setField('machine_details.location_state', loc.state, loc.raw, 'HIGH', turnIndex, isCorrection);
      }
    }

    // 10. DOCUMENTS & FINANCE STATUS
    if (tLower.match(/(?:finance nahi|loan nahi|clear hai|cash li thi|all clear|noc mil jayegi|noc ready)/)) {
      this._setField('machine_details.document_status', 'all_clear_noc_ready', text, 'HIGH', turnIndex, isCorrection);
    } else if (tLower.match(/(?:loan chal raha|finance hai|bank mein hai|emi baki|hypothecation)/)) {
      this._setField('machine_details.document_status', 'loan_hypothecation_active', text, 'HIGH', turnIndex, isCorrection);
    } else if (tLower.match(/(?:tax baaki|tax due|passing fail)/)) {
      this._setField('machine_details.document_status', 'tax_due', text, 'HIGH', turnIndex, isCorrection);
    } else if (tLower.match(/(?:rc kho gayi|duplicate rc)/)) {
      this._setField('machine_details.document_status', 'rc_lost_duplicate', text, 'HIGH', turnIndex, isCorrection);
    }

    // 11. COMMERCIAL TERMS (Handle intra-turn self corrections: "25 lakh... actually 24 lakh")
    // Detect multiple prices if present
    const priceMatches = Array.from(normalizeHindiNumerals(text).matchAll(/(\d+(?:\.\d+)?)\s*(lakh|lac|lacs|lakhs|l|लाख|हजार|thousand|crore|cr)\b/gi));
    if (priceMatches.length > 1 && (isCorrection || tLower.includes('actually') || tLower.includes('nahi'))) {
      const p1 = parseSpokenPrice(priceMatches[0][0]);
      const p2 = parseSpokenPrice(priceMatches[priceMatches.length - 1][0]);
      if (p1 && p2) {
        const isSeller = this.extracted.customer_type !== 'buyer';
        const fieldName = isSeller ? 'commercial_terms.expected_price_inr' : 'commercial_terms.budget_max_inr';
        this._setField(fieldName, p1.exact_inr, p1.raw, 'HIGH', turnIndex, false);
        this._setField(fieldName, p2.exact_inr, p2.raw, 'HIGH', turnIndex, true);
        this._setField('commercial_terms.price_or_budget_raw', p2.raw, text, 'HIGH', turnIndex, true);
      }
    } else {
      const priceInfo = parseSpokenPrice(text);
      if (priceInfo) {
        this._setField('commercial_terms.price_or_budget_raw', priceInfo.raw, text, 'HIGH', turnIndex, isCorrection);
        if (priceInfo.qualifier) {
          this._setField('commercial_terms.budget_qualifier', priceInfo.qualifier, text, 'HIGH', turnIndex, isCorrection);
        }
        if (this.extracted.customer_type === 'buyer') {
          this._setField('commercial_terms.budget_max_inr', priceInfo.max_inr, text, 'HIGH', turnIndex, isCorrection);
          if (priceInfo.min_inr && priceInfo.min_inr !== priceInfo.max_inr) {
            this._setField('commercial_terms.budget_min_inr', priceInfo.min_inr, text, 'HIGH', turnIndex, isCorrection);
          }
        } else {
          this._setField('commercial_terms.expected_price_inr', priceInfo.exact_inr, text, 'HIGH', turnIndex, isCorrection);
        }
        if (this.extracted.customer_type === 'seller') {
          const _neg = parsePriceNegotiability(text);
          if (_neg !== null) {
            this._setField('commercial_terms.price_negotiable', _neg, text, 'HIGH', turnIndex, isCorrection);
          }
        }
        if (this.extracted.customer_type === 'seller') {
          const _urg = parseSaleUrgency(text);
          if (_urg !== null) {
            // Latest explicit seller position wins (sequential overwrite).
            this._setField('commercial_terms.sale_urgency', _urg, text, 'HIGH', turnIndex, isCorrection);
          } else if (this.extracted.commercial_terms.sale_urgency === null
            || this.extracted.commercial_terms.sale_urgency === undefined) {
            // NORMAL only on concrete sale evidence in THIS turn, never by default.
            const _hasPrice = parseSpokenPrice(text) !== null;
            const _hasModel = (() => { try { return !!(matchMachineModel(text) || {}).model; } catch (_) { return false; } })();
            const _sellTalk = /(?:bechna|bechni|sell|bikau)\b/.test(text.toLowerCase());
            if ((_hasPrice || _hasModel) && _sellTalk) {
              this._setField('commercial_terms.sale_urgency', 'NORMAL', text, 'MEDIUM', turnIndex, isCorrection);
            }
          }
        }
      }
    }

    // 11b. BUYER QUANTITY (buyer language only: "do excavator chahiye")
    if (this.extracted.customer_type === 'buyer') {
      const qty = parseSpokenQuantity(text);
      if (qty) {
        this._setField('machine_details.quantity', qty.quantity, qty.raw, 'HIGH', turnIndex, isCorrection);
      }
      const fin = parseFinanceRequirement(text);
      if (fin !== null) {
        this._setField('commercial_terms.finance_required', fin, text, 'MEDIUM', turnIndex, isCorrection);
      }
    }

    // 11d. ATTACHMENT / GST / SPECIAL NOTES (buyer only, keyword-level only).
    // Appended to machine_condition_summary, never a structured claim.
    if (this.extracted.customer_type === 'buyer') {
      const notes = [];
      if (/\b(bucket|balti|\u092c\u093e\u0932\u094d\u091f\u0940|\u092c\u0915\u0947\u091f)\b/i.test(text)) notes.push('Attachment: bucket/balti required');
      if (/\bgst\b|gst\s*bill|bill\s*chahiye|billing/i.test(text)) notes.push('GST billing required');
      if (notes.length) {
        const prev = this.extracted.machine_details.machine_condition_summary || '';
        const fresh = notes.filter((note) => !prev.includes(note));
        if (fresh.length) {
          this._setField('machine_details.machine_condition_summary',
            (prev ? prev + '; ' : '') + fresh.join('; '), text, 'MEDIUM', turnIndex, isCorrection);
        }
      }
    }

    // 11c. WHATSAPP REQUEST READINESS (request to SEND details, never a sent claim)
    if (parseWhatsappRequest(text)) {
      this._setField('whatsapp_requested', true, text, 'HIGH', turnIndex, isCorrection);
      this._setField('whatsapp_action', 'PENDING', text, 'HIGH', turnIndex, isCorrection);
    }

    // 12. BUYER TIMELINE & URGENCY
    if (tLower.match(/(?:urgent|turant|isi hafte|2-3 din|3 din|7 din|immediately)/)) {
      this._setField('commercial_terms.purchase_timeline', 'immediate_within_7_days', text, 'HIGH', turnIndex, isCorrection);
      this._setField('buyer_requirements.urgency', 'immediate', text, 'HIGH', turnIndex, isCorrection);
    } else if (tLower.match(/(?:15 din|15-30 din|mahine bhar|next month)/)) {
      this._setField('commercial_terms.purchase_timeline', 'within_15_30_days', text, 'HIGH', turnIndex, isCorrection);
      this._setField('buyer_requirements.urgency', 'within_month', text, 'HIGH', turnIndex, isCorrection);
    } else if (tLower.match(/(?:1-3 mahine|baad mein|aage chal kar)/)) {
      this._setField('commercial_terms.purchase_timeline', 'future_1_3_months', text, 'HIGH', turnIndex, isCorrection);
      this._setField('buyer_requirements.urgency', 'planning', text, 'HIGH', turnIndex, isCorrection);
    } else if (this.extracted.customer_type === 'buyer' && /(?:abhi\s+dekh\s*rah|market\s*explor|research\s*kar\s*rah|options?\s*dekh\s*rah|decide\s*nahi|decide\s*ni\s*kiya|faisla\s*nahi|abhi\s*(?:soch|dekh|pooch|pata\s*kar)\s*rah)/.test(tLower)) {
      // exploring_market: buyer browsing, not ready. Never overwrites a
      // meaningful explicit timeline unless this turn is an explicit
      // correction/update.
      const _cur = this.extracted.commercial_terms.purchase_timeline;
      if (_cur === null || _cur === undefined || _cur === 'not_applicable' || _cur === 'unknown' || isCorrection) {
        this._setField('commercial_terms.purchase_timeline', 'exploring_market', text, 'MEDIUM', turnIndex, isCorrection);
      }
    }

    // 13. BUYER YARD VISIT
    if (tLower.match(/(?:yard aaoonga|yard aaunga|dekhne aaoonga|jaipur aaunga|trial lunga|aake dekhunga|visit karunga|yard visit)/)) {
      this._setField('commercial_terms.yard_visit_agreed', true, text, 'HIGH', turnIndex, isCorrection);
      this._setField('commercial_terms.yard_visit_schedule', 'Inspection scheduled', text, 'HIGH', turnIndex, isCorrection);
    }

    // 14. DIGITAL EVIDENCE & WHATSAPP READINESS
    if (tLower.match(/(?:photos?\s*(?:whatsapp|bhej|send)|whatsapp\s*(?:pe\s*)?(?:photos?|daal|karta|kar deta)|bhej dunga|send kar dunga)/)) {
      this._setField('evidence_readiness.photos_agreed', true, text, 'HIGH', turnIndex, isCorrection);
      this.extracted.evidence_readiness.evidence_status = 'promised';
    }
    if (tLower.match(/(?:video\s*(?:bhej|send|whatsapp)|running\s*video|chalate\s*hue\s*video|30\s*second\s*video)/)) {
      this._setField('evidence_readiness.running_video_agreed', true, text, 'HIGH', turnIndex, isCorrection);
      this._setField('evidence_breakdown.running_video', true, text, 'HIGH', turnIndex, isCorrection);
    }
    if (tLower.match(/(?:rc\s*(?:bhej|dunga|send)|noc\s*(?:bhej|dunga|send)|kagaz\s*(?:bhej|dunga)|paper\s*share)/)) {
      this._setField('evidence_readiness.rc_copy_agreed', true, text, 'HIGH', turnIndex, isCorrection);
      this._setField('evidence_breakdown.rc_copy', true, text, 'HIGH', turnIndex, isCorrection);
    }
    if (tLower.match(/(?:boom photo|boom ka photo)/)) {
      this._setField('evidence_breakdown.boom_photo', true, text, 'HIGH', turnIndex, isCorrection);
    }
    if (tLower.match(/(?:chain photo|track photo|undercarriage photo)/)) {
      this._setField('evidence_breakdown.undercarriage_photo', true, text, 'HIGH', turnIndex, isCorrection);
    }
    if (tLower.match(/(?:meter photo|meter reading photo)/)) {
      this._setField('evidence_breakdown.hour_meter_photo', true, text, 'HIGH', turnIndex, isCorrection);
    }
  }

  evaluateMissingInformation() {
    const ext = this.extracted;
    const isSeller = ext.customer_type === 'seller';
    const isBuyer = ext.customer_type === 'buyer';

    const captured = [];
    const missing = [];
    const ambiguous = [];

    const isHighOrMed = (path) => {
      const p = this.provenance[path];
      return p && (p.confidence === 'HIGH' || p.confidence === 'MEDIUM');
    };

    if (isSeller) {
      if (ext.machine_details.brand && isHighOrMed('machine_details.brand')) captured.push('make');
      else missing.push('make');

      if (ext.machine_details.model && isHighOrMed('machine_details.model')) captured.push('model');
      else missing.push('model');

      if (ext.machine_details.model_year && isHighOrMed('machine_details.model_year')) captured.push('year');
      else missing.push('year');

      if (ext.machine_details.running_hours && isHighOrMed('machine_details.running_hours')) captured.push('hours');
      else missing.push('hours');

      if (ext.machine_details.application_history !== 'unknown') captured.push('application');
      else missing.push('application');

      if (ext.commercial_terms.expected_price_inr && isHighOrMed('commercial_terms.expected_price_inr')) captured.push('asking_price');
      else missing.push('asking_price');

      if (ext.machine_details.location_city) {
        if (ext.location_ambiguous || (this.provenance['machine_details.location_city'] && this.provenance['machine_details.location_city'].confidence === 'LOW')) {
          ambiguous.push('location_city');
        } else {
          captured.push('city');
        }
      } else {
        missing.push('city');
      }

      if (ext.machine_details.document_status !== 'unknown') captured.push('document_status');
      else missing.push('document_status');

      if (ext.evidence_readiness.photos_agreed) captured.push('photos_agreed');
      else missing.push('photos_agreed');

      if (ext.evidence_readiness.running_video_agreed) captured.push('running_video_agreed');
      else missing.push('running_video_agreed');

      if (ext.evidence_readiness.rc_copy_agreed) captured.push('rc_copy_agreed');
      else missing.push('rc_copy_agreed');

    } else if (isBuyer) {
      if (ext.buyer_requirements.brand || ext.machine_details.brand) captured.push('brand');
      else missing.push('brand');

      if (ext.machine_details.tonnage_class !== 'unknown') captured.push('tonnage');
      else missing.push('tonnage');

      if (ext.buyer_requirements.application !== 'unknown') captured.push('application');
      else missing.push('application');

      if (ext.commercial_terms.budget_max_inr && isHighOrMed('commercial_terms.budget_max_inr')) captured.push('budget');
      else missing.push('budget');

      if (ext.machine_details.location_city) {
        if (ext.location_ambiguous) ambiguous.push('location_city');
        else captured.push('city');
      } else {
        missing.push('city');
      }

      if (ext.commercial_terms.purchase_timeline !== 'not_applicable') captured.push('purchase_timeline');
      else missing.push('purchase_timeline');

      if (ext.commercial_terms.yard_visit_agreed) captured.push('yard_visit_agreed');
      else missing.push('yard_visit_agreed');
    }

    return { captured, missing, ambiguous };
  }

  generateFollowUpQuestion() {
    const ext = this.extracted;
    const { missing, ambiguous } = this.evaluateMissingInformation();

    if (ext.dnc_requested) {
      return 'ज़रूर सर, मैंने आपका अनुरोध नोट कर लिया है। हम आपको दोबारा संपर्क नहीं करेंगे। आपका दिन शुभ हो।';
    }

    if (ambiguous.includes('location_city') || ext.location_ambiguous) {
      return 'Sir, yeh Kishangarh Ajmer highway wala hai ya Alwar wala? Please confirm kar dijiye.';
    }

    if (ext.customer_type === 'seller') {
      if (missing.includes('make') || missing.includes('model')) {
        return 'Aapke paas kaunsi company aur model ki machine hai sir?';
      }
      if (missing.includes('year')) {
        const mod = ext.machine_details.model || 'Machine';
        return `${mod} kaunse saal ka model hai sir?`;
      }
      if (missing.includes('hours')) {
        return 'Meter reading kitne ghante (hours) show kar rahi hai sir?';
      }
      if (missing.includes('application')) {
        return 'Machine zyadatar mitti ke kaam mein chali hai ya pahad mein breaker pe chali hai?';
      }
      if (missing.includes('city')) {
        return 'Abhi machine kaunse shahar ya district mein khadi hai sir?';
      }
      if (missing.includes('asking_price')) {
        return 'Aapka expected selling price kitna hai sir?';
      }
      if (missing.includes('photos_agreed') || missing.includes('running_video_agreed')) {
        return 'Aap WhatsApp par machine ke chaar-paanch photo aur meter ka photo bhej dijiye. Ek 30-second ka running video bhi bhej dena.';
      }
      return 'Ji sir, humari technical inspection team aapse deal finalize karne ke liye jald hi call karegi.';
    }

    if (ext.customer_type === 'buyer') {
      if (missing.includes('brand') && missing.includes('tonnage')) {
        return 'Aapko kaunsi brand aur kitne ton class ki machine dekhni hai sir?';
      }
      if (missing.includes('application')) {
        return 'Aapka kaam kis cheez ka chal raha hai — road work, mitti excavation ya stone quarry?';
      }
      if (missing.includes('budget')) {
        return 'Aapka approximate budget kitna ban raha hai sir?';
      }
      if (missing.includes('city')) {
        return 'Machine aapko kaunsi location ya site pe deliver karwani hogi sir?';
      }
      if (missing.includes('yard_visit_agreed')) {
        return 'Hamara main yard Jaipur mein Loha Mandi (VKI Area) mein hai. Kya aap trial aur live load test ke liye visit karna chahenge?';
      }
      return 'Bilkul sir! Main aapko WhatsApp par Jaipur yard ki live Google Maps location aur inventory catalog share kar rahi hoon.';
    }

    return 'Namaste, main Vaani bol rahi hoon, Shyam Earthmover se. Aapki machine ke regarding baat karni thi. Aap machine bechna chahte hain ya kharidna?';
  }

  finalize() {
    const ext = this.extracted;
    const { captured, missing, ambiguous } = this.evaluateMissingInformation();

    let hasSpec = false;
    let hasComm = false;
    let hasGeo = false;

    if (ext.customer_type === 'seller') {
      const brandConf = this.provenance['machine_details.brand']?.confidence;
      const modelConf = this.provenance['machine_details.model']?.confidence;
      hasSpec = Boolean(ext.machine_details.brand && ext.machine_details.model && brandConf !== 'LOW' && modelConf !== 'LOW');

      const priceConf = this.provenance['commercial_terms.expected_price_inr']?.confidence;
      hasComm = Boolean(ext.commercial_terms.expected_price_inr && priceConf !== 'LOW');

      const cityConf = this.provenance['machine_details.location_city']?.confidence;
      hasGeo = Boolean(ext.machine_details.location_city && !ext.location_ambiguous && cityConf !== 'LOW');
    } else if (ext.customer_type === 'buyer') {
      const brandConf = this.provenance['machine_details.brand']?.confidence;
      const tonConf = this.provenance['machine_details.tonnage_class']?.confidence;
      hasSpec = Boolean((ext.machine_details.brand && brandConf !== 'LOW') || (ext.machine_details.tonnage_class !== 'unknown' && tonConf !== 'LOW'));

      const budgetConf = this.provenance['commercial_terms.budget_max_inr']?.confidence;
      hasComm = Boolean(ext.commercial_terms.budget_max_inr && budgetConf !== 'LOW');

      const cityConf = this.provenance['machine_details.location_city']?.confidence;
      hasGeo = Boolean(ext.machine_details.location_city && !ext.location_ambiguous && cityConf !== 'LOW');
    }

    let qualState = 'UNQUALIFIED';
    if (ext.dnc_requested) {
      qualState = 'DISQUALIFIED';
    } else if (hasSpec && hasComm && hasGeo) {
      qualState = 'QUALIFIED';
    } else if (hasSpec || hasComm || hasGeo) {
      qualState = 'PARTIALLY_QUALIFIED';
    }

    let leadTemp = 'COLD';
    if (ext.dnc_requested || qualState === 'DISQUALIFIED') {
      leadTemp = 'COLD';
    } else if (ext.customer_type === 'seller') {
      const isClean = ext.machine_details.application_history === 'soil_earthwork';
      const hasMedia = ext.evidence_readiness.photos_agreed || ext.evidence_readiness.running_video_agreed;
      const price = ext.commercial_terms.expected_price_inr;
      const yr = ext.machine_details.model_year;

      let realistic = true;
      if (yr && price) {
        if (yr <= 2019 && price > 2500000) realistic = false;
        else if (yr <= 2024 && price > 3600000) realistic = false;
      }

      if (qualState === 'QUALIFIED' && isClean && hasMedia && realistic) {
        leadTemp = 'HOT';
      } else if (qualState === 'QUALIFIED' || (qualState === 'PARTIALLY_QUALIFIED' && hasMedia)) {
        leadTemp = 'WARM';
      }
    } else if (ext.customer_type === 'buyer') {
      const urgent = ext.commercial_terms.purchase_timeline === 'immediate_within_7_days' || ext.commercial_terms.purchase_timeline === 'within_15_30_days';
      const yard = ext.commercial_terms.yard_visit_agreed;

      if (qualState === 'QUALIFIED' && (urgent || yard)) {
        leadTemp = 'HOT';
      } else if (qualState === 'QUALIFIED' || qualState === 'PARTIALLY_QUALIFIED') {
        leadTemp = 'WARM';
      }
    }

    let nextAction = 'NO_ACTION_REQUIRED';
    if (ext.dnc_requested) {
      nextAction = 'DNC_SUPPRESS';
    } else if (ext.customer_type === 'seller') {
      if (!ext.evidence_readiness.photos_agreed) nextAction = 'WAITING_FOR_MACHINE_PHOTOS';
      else if (!ext.evidence_readiness.running_video_agreed) nextAction = 'WAITING_FOR_RUNNING_VIDEO';
      else if (leadTemp === 'WARM') nextAction = 'NEGOTIATION_FOLLOW_UP';
      else if (qualState === 'QUALIFIED') nextAction = 'FOLLOW_UP_WITH_SELLER';
      else nextAction = 'DISCOVER_SELLER_REQUIREMENTS';
    } else if (ext.customer_type === 'buyer') {
      if (ext.commercial_terms.yard_visit_agreed) nextAction = 'SCHEDULE_YARD_VISIT';
      else if (qualState === 'QUALIFIED') nextAction = 'MATCH_BUYER';
      else nextAction = 'SEND_MACHINE_OPTIONS';
    }

    let outcome = 'inquiry';
    if (ext.dnc_requested) outcome = 'opt_out';
    else if (qualState === 'QUALIFIED') outcome = 'lead_qualified';
    else if (hasSpec && hasComm) outcome = 'price_discussion';

    return {
      extracted: ext,
      qualification_state: qualState,
      lead_temperature: leadTemp,
      next_action: nextAction,
      conversation_outcome: outcome,
      missing_info: { captured, missing, ambiguous },
      provenance: this.provenance,
      correction_history: this.history,
      follow_up_question: this.generateFollowUpQuestion()
    };
  }
}

function extractFromConversation(conversationInput) {
  const extractor = new VaaniConversationExtractor();

  if (Array.isArray(conversationInput)) {
    let turnIdx = 1;
    for (const turn of conversationInput) {
      const speaker = turn.speaker || (turn.role === 'user' ? 'caller' : 'agent');
      const text = turn.text || turn.content || '';
      if (speaker === 'caller' || speaker === 'user' || speaker === 'customer') {
        extractor.processTurn(text, turnIdx);
      }
      turnIdx++;
    }
  } else if (typeof conversationInput === 'string') {
    const lines = conversationInput.split('\n');
    let turnIdx = 1;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const callerMatch = trimmed.match(/^(?:caller|customer|user|party):\s*(.+)$/i);
      if (callerMatch) {
        extractor.processTurn(callerMatch[1], turnIdx);
      } else if (!trimmed.match(/^(?:agent|vaani|bot|assistant):\s*/i)) {
        extractor.processTurn(trimmed, turnIdx);
      }
      turnIdx++;
    }
  }

  return extractor.finalize();
}

// ============================================================================
// CALLBACK DATETIME (Hindi + Roman-Hindi + Devanagari).
// Resolves ONLY fully explicit day + clock-time expressions such as
// "kal ek baje" (tomorrow 13:00). Anything ambiguous (no day, no hour,
// duration "ghante", past-tense narrative) returns null so the generic
// default scheduler is never fed a guess.
const CALLBACK_DAY_OFFSETS = {
  'aaj': 0, 'aj': 0, 'आज': 0,
  'kal': 1, 'कल': 1,
  'parson': 2, 'parsoon': 2, 'परसों': 2, 'परसो': 2,
};

const CALLBACK_PERIOD_HINTS = [
  { re: /subah|subha|savere|सुबह|सवेरे/, shift: (h) => h },
  { re: /dopahar|दोपहर/, shift: (h) => (h < 12 ? h + 12 : h) },
  { re: /shaam|sham|शाम/, shift: (h) => (h < 12 ? h + 12 : h) },
  { re: /raat|रात/, shift: (h) => (h === 12 ? 0 : (h < 12 ? h + 12 : h)) },
];

// Explicit request-to-contact cues. Presence defeats the past-tense veto
// ("kal baat hui thi, kal ek baje phir call karna" still resolves).
const CALLBACK_CONTACT_CUES = /call|phone|callback|colback|karn[aei]|karega|karenge|kijiye|sampark|bataiyega|batana/i;
const CALLBACK_PAST_VETO = /\b(tha|thi|thay|thae|hue|hui|hua|huyi|chuka|chuki|gaya|gayi)\b/i;

function escapeCallbackRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseCallbackDatetime(rawText, nowMs) {
  if (!rawText) return null;
  const text = normalizeHindiNumerals(String(rawText));
  if (!text.trim()) return null;
  const lowered = text.toLowerCase();
  const EDGE = '(?:^|[^\\w\u0900-\u097F])';
  const TAIL = '(?=$|[^\\w\u0900-\u097F])';

  // Day: last day-word wins (corrections supersede, same discipline as budget).
  let dayOffset = null;
  for (const [word, offset] of Object.entries(CALLBACK_DAY_OFFSETS)) {
    if (new RegExp(EDGE + escapeCallbackRegExp(word) + TAIL, 'i').test(lowered)) {
      dayOffset = offset;
    }
  }

  // Hour: ASCII digits or number words 1-12, immediately before baje/bajey/बजे.
  // The leading-edge guard keeps phone fragments ("...45674 baje") from matching.
  const hourWords = Object.keys(HINDI_NUMBER_WORDS)
    .filter((w) => HINDI_NUMBER_WORDS[w] >= 1 && HINDI_NUMBER_WORDS[w] <= 12)
    .sort((a, b) => b.length - a.length)
    .map(escapeCallbackRegExp)
    .join('|');
  const timeRe = new RegExp(EDGE + '(\\d{1,2}|' + hourWords + ')\\s*(baje|bajey|बजे)' + TAIL, 'gi');
  let hour = null;
  let hourIndex = -1;
  let m;
  while ((m = timeRe.exec(lowered)) !== null) {
    const token = m[1];
    const n = /^\d+$/.test(token) ? parseInt(token, 10) : HINDI_NUMBER_WORDS[token];
    if (Number.isFinite(n) && n >= 1 && n <= 12) {
      hour = n; // last clock-time mention wins (corrections supersede)
      hourIndex = m.index;
    }
  }

  // Both day and clock time are required. A bare "3 baje" (no day) or a bare
  // "kal baat karenge" (no hour) resolves to nothing: never invent a date.
  if (dayOffset === null || hour === null) return null;

  const hasCue = CALLBACK_CONTACT_CUES.test(lowered);
  if (!hasCue && CALLBACK_PAST_VETO.test(lowered)) return null;

  // Period: nearest hint to the hour mention wins; bare hours follow Indian
  // business convention (7-11 morning, 12 noon, 1-6 afternoon).
  let hour24 = null;
  let bestDist = Infinity;
  for (const hint of CALLBACK_PERIOD_HINTS) {
    const hre = new RegExp(hint.re.source, 'gi');
    let hm;
    while ((hm = hre.exec(lowered)) !== null) {
      const dist = Math.abs(hm.index - hourIndex);
      if (dist < bestDist) { bestDist = dist; hour24 = hint.shift(hour); }
    }
  }
  if (hour24 === null) {
    hour24 = (hour >= 7 && hour <= 11) ? hour : (hour === 12 ? 12 : hour + 12);
  }

  // Server-local wall clock (IST on this box), identical frame to the
  // existing next-morning-11:00 default. Stored as ISO for the CRM field.
  const base = new Date(Number.isFinite(nowMs) ? nowMs : Date.now());
  const due = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, hour24, 0, 0, 0);
  return { datetime: due.toISOString(), qualifier: 'explicit' };
}

module.exports = {
  VaaniConversationExtractor,
  extractFromConversation,
  MACHINE_TAXONOMY,
  matchMachineModel,
  parseSpokenPrice,
  parseSpokenQuantity,
  parseFinanceRequirement,
  parseWhatsappRequest,
  parsePriceNegotiability,
  parseSaleUrgency,
  parseApplicationHistory,
  parseModelYear,
  parseOperatingHours,
  normalizeIndianPhone,
  parseLocation,
  normalizeHindiNumerals,
  parseCallbackDatetime
};
