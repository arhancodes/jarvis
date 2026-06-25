import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';

// ── Conversions Module ──
// Programmatic timezone and unit conversions. No LLM needed — always accurate.

// ── Timezone Data (UTC offset in minutes) ──
const TIMEZONES: Record<string, { offset: number; name: string }> = {
  // UTC / GMT
  'utc':  { offset: 0, name: 'Coordinated Universal Time' },
  'gmt':  { offset: 0, name: 'Greenwich Mean Time' },

  // Americas
  'est':  { offset: -300, name: 'Eastern Standard Time' },
  'edt':  { offset: -240, name: 'Eastern Daylight Time' },
  'cst':  { offset: -360, name: 'Central Standard Time' },
  'cdt':  { offset: -300, name: 'Central Daylight Time' },
  'mst':  { offset: -420, name: 'Mountain Standard Time' },
  'mdt':  { offset: -360, name: 'Mountain Daylight Time' },
  'pst':  { offset: -480, name: 'Pacific Standard Time' },
  'pdt':  { offset: -420, name: 'Pacific Daylight Time' },
  'akst': { offset: -540, name: 'Alaska Standard Time' },
  'hst':  { offset: -600, name: 'Hawaii Standard Time' },
  'ast':  { offset: -240, name: 'Atlantic Standard Time' },
  'nst':  { offset: -210, name: 'Newfoundland Standard Time' },
  'brt':  { offset: -180, name: 'Brasilia Time' },
  'art':  { offset: -180, name: 'Argentina Time' },
  'clt':  { offset: -240, name: 'Chile Standard Time' },
  'vet':  { offset: -240, name: 'Venezuelan Standard Time' },
  'cot':  { offset: -300, name: 'Colombia Time' },
  'pet':  { offset: -300, name: 'Peru Time' },

  // Europe
  'wet':  { offset: 0, name: 'Western European Time' },
  'cet':  { offset: 60, name: 'Central European Time' },
  'cest': { offset: 120, name: 'Central European Summer Time' },
  'eet':  { offset: 120, name: 'Eastern European Time' },
  'eest': { offset: 180, name: 'Eastern European Summer Time' },
  'bst':  { offset: 60, name: 'British Summer Time' },
  'ist':  { offset: 330, name: 'India Standard Time' },
  'msk':  { offset: 180, name: 'Moscow Standard Time' },

  // Middle East / Gulf
  'gst':  { offset: 240, name: 'Gulf Standard Time' },
  'irst': { offset: 210, name: 'Iran Standard Time' },
  'ast-arab': { offset: 180, name: 'Arabia Standard Time' },
  'adt':  { offset: 240, name: 'Arabia Daylight Time' },
  'pkt':  { offset: 300, name: 'Pakistan Standard Time' },

  // Asia
  'sgt':  { offset: 480, name: 'Singapore Time' },
  'hkt':  { offset: 480, name: 'Hong Kong Time' },
  'cst-china': { offset: 480, name: 'China Standard Time' },
  'jst':  { offset: 540, name: 'Japan Standard Time' },
  'kst':  { offset: 540, name: 'Korea Standard Time' },
  'ict':  { offset: 420, name: 'Indochina Time' },
  'wib':  { offset: 420, name: 'Western Indonesian Time' },
  'npt':  { offset: 345, name: 'Nepal Time' },
  'bdt':  { offset: 360, name: 'Bangladesh Standard Time' },
  'mmt':  { offset: 390, name: 'Myanmar Time' },
  'slt':  { offset: 330, name: 'Sri Lanka Time' },
  'aft':  { offset: 270, name: 'Afghanistan Time' },
  'pht':  { offset: 480, name: 'Philippine Time' },

  // Oceania
  'aest': { offset: 600, name: 'Australian Eastern Standard Time' },
  'aedt': { offset: 660, name: 'Australian Eastern Daylight Time' },
  'acst': { offset: 570, name: 'Australian Central Standard Time' },
  'awst': { offset: 480, name: 'Australian Western Standard Time' },
  'nzst': { offset: 720, name: 'New Zealand Standard Time' },
  'nzdt': { offset: 780, name: 'New Zealand Daylight Time' },
  'fjt':  { offset: 720, name: 'Fiji Time' },

  // Africa
  'cat':  { offset: 120, name: 'Central Africa Time' },
  'eat':  { offset: 180, name: 'East Africa Time' },
  'wat':  { offset: 60, name: 'West Africa Time' },
  'sast': { offset: 120, name: 'South Africa Standard Time' },
};

// Aliases for common names
const TZ_ALIASES: Record<string, string> = {
  'indian': 'ist',
  'india': 'ist',
  'gulf': 'gst',
  'dubai': 'gst',
  'uae': 'gst',
  'pacific': 'pst',
  'eastern': 'est',
  'central': 'cst',
  'mountain': 'mst',
  'japan': 'jst',
  'japanese': 'jst',
  'korea': 'kst',
  'korean': 'kst',
  'china': 'cst-china',
  'chinese': 'cst-china',
  'singapore': 'sgt',
  'london': 'gmt',
  'uk': 'gmt',
  'british': 'bst',
  'moscow': 'msk',
  'russia': 'msk',
  'new zealand': 'nzst',
  'nz': 'nzst',
  'australia': 'aest',
  'sydney': 'aest',
  'tokyo': 'jst',
  'hong kong': 'hkt',
  'nepal': 'npt',
  'pakistan': 'pkt',
  'bangladesh': 'bdt',
  'iran': 'irst',
  'brazil': 'brt',
  'argentina': 'art',
  'south africa': 'sast',
  'arabia': 'ast-arab',
  'saudi': 'ast-arab',
  'philippine': 'pht',
  'philippines': 'pht',
  'sri lanka': 'slt',
  'myanmar': 'mmt',
  'afghanistan': 'aft',
};

// ── Unit Conversion Data ──
interface UnitDef { factor: number; names: string[] }
interface UnitCategory { units: UnitDef[]; type: string }

const UNIT_CATEGORIES: UnitCategory[] = [
  {
    type: 'length',
    units: [
      { factor: 1, names: ['meter', 'meters', 'metre', 'metres', 'm'] },
      { factor: 0.01, names: ['centimeter', 'centimeters', 'centimetre', 'cm'] },
      { factor: 0.001, names: ['millimeter', 'millimeters', 'millimetre', 'mm'] },
      { factor: 1000, names: ['kilometer', 'kilometers', 'kilometre', 'km'] },
      { factor: 0.0254, names: ['inch', 'inches', 'in'] },
      { factor: 0.3048, names: ['foot', 'feet', 'ft'] },
      { factor: 0.9144, names: ['yard', 'yards', 'yd'] },
      { factor: 1609.344, names: ['mile', 'miles', 'mi'] },
    ],
  },
  {
    type: 'weight',
    units: [
      { factor: 1, names: ['kilogram', 'kilograms', 'kilo', 'kilos', 'kg'] },
      { factor: 0.001, names: ['gram', 'grams', 'g'] },
      { factor: 0.000001, names: ['milligram', 'milligrams', 'mg'] },
      { factor: 0.453592, names: ['pound', 'pounds', 'lb', 'lbs'] },
      { factor: 0.0283495, names: ['ounce', 'ounces', 'oz'] },
      { factor: 1000, names: ['tonne', 'tonnes', 'metric ton', 'metric tons'] },
      { factor: 6.35029, names: ['stone', 'stones', 'st'] },
    ],
  },
  {
    type: 'volume',
    units: [
      { factor: 1, names: ['liter', 'liters', 'litre', 'litres', 'l'] },
      { factor: 0.001, names: ['milliliter', 'milliliters', 'ml'] },
      { factor: 3.78541, names: ['gallon', 'gallons', 'gal'] },
      { factor: 0.946353, names: ['quart', 'quarts', 'qt'] },
      { factor: 0.473176, names: ['pint', 'pints', 'pt'] },
      { factor: 0.236588, names: ['cup', 'cups'] },
      { factor: 0.0295735, names: ['fluid ounce', 'fluid ounces', 'fl oz'] },
      { factor: 0.0147868, names: ['tablespoon', 'tablespoons', 'tbsp'] },
      { factor: 0.00492892, names: ['teaspoon', 'teaspoons', 'tsp'] },
    ],
  },
  {
    type: 'temperature',
    units: [
      { factor: 1, names: ['celsius', 'c', 'centigrade'] },
      { factor: 1, names: ['fahrenheit', 'f'] },
      { factor: 1, names: ['kelvin', 'k'] },
    ],
  },
  {
    type: 'speed',
    units: [
      { factor: 1, names: ['km/h', 'kmh', 'kph', 'kilometers per hour', 'kmph'] },
      { factor: 1.60934, names: ['mph', 'miles per hour'] },
      { factor: 3.6, names: ['m/s', 'meters per second'] },
      { factor: 1.852, names: ['knot', 'knots', 'kt', 'kn'] },
    ],
  },
  {
    type: 'data',
    units: [
      { factor: 1, names: ['byte', 'bytes', 'b'] },
      { factor: 1024, names: ['kilobyte', 'kilobytes', 'kb'] },
      { factor: 1048576, names: ['megabyte', 'megabytes', 'mb'] },
      { factor: 1073741824, names: ['gigabyte', 'gigabytes', 'gb'] },
      { factor: 1099511627776, names: ['terabyte', 'terabytes', 'tb'] },
    ],
  },
];

function resolveTimezone(input: string): { key: string; tz: { offset: number; name: string } } | null {
  const lower = input.toLowerCase().trim();

  // Direct match
  if (TIMEZONES[lower]) return { key: lower, tz: TIMEZONES[lower] };

  // Alias match
  if (TZ_ALIASES[lower]) {
    const key = TZ_ALIASES[lower];
    return { key, tz: TIMEZONES[key] };
  }

  // Try stripping common suffixes: "standard time", "time"
  const stripped = lower.replace(/\s*(standard\s+)?time$/i, '').trim();
  if (TZ_ALIASES[stripped]) {
    const key = TZ_ALIASES[stripped];
    return { key, tz: TIMEZONES[key] };
  }

  return null;
}

function formatOffset(minutes: number): string {
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m > 0 ? `UTC${sign}${h}:${String(m).padStart(2, '0')}` : `UTC${sign}${h}`;
}

function convertTimezone(timeStr: string, fromTz: string, toTz: string): CommandResult {
  const from = resolveTimezone(fromTz);
  const to = resolveTimezone(toTz);

  if (!from) return { success: false, message: `Unknown timezone: "${fromTz}"` };
  if (!to) return { success: false, message: `Unknown timezone: "${toTz}"` };

  // Parse the time
  const timeMatch = timeStr.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!timeMatch) return { success: false, message: `Could not parse time: "${timeStr}". Try "6 PM", "14:30", etc.` };

  let hours = parseInt(timeMatch[1], 10);
  const minutes = parseInt(timeMatch[2] || '0', 10);
  const ampm = timeMatch[3]?.toLowerCase();

  if (ampm === 'pm' && hours !== 12) hours += 12;
  if (ampm === 'am' && hours === 12) hours = 0;

  // Convert: source time → UTC → target time
  const sourceMinutes = hours * 60 + minutes;
  const utcMinutes = sourceMinutes - from.tz.offset;
  let targetMinutes = utcMinutes + to.tz.offset;

  // Normalize to 0-1440
  if (targetMinutes < 0) targetMinutes += 1440;
  if (targetMinutes >= 1440) targetMinutes -= 1440;

  const targetH = Math.floor(targetMinutes / 60);
  const targetM = targetMinutes % 60;

  // Format nicely with AM/PM
  const h12 = targetH === 0 ? 12 : targetH > 12 ? targetH - 12 : targetH;
  const ampmOut = targetH >= 12 ? 'PM' : 'AM';
  const timeOut = targetM > 0 ? `${h12}:${String(targetM).padStart(2, '0')} ${ampmOut}` : `${h12} ${ampmOut}`;

  // Day change indicator
  let dayNote = '';
  if (utcMinutes + to.tz.offset >= 1440) dayNote = ' (next day)';
  if (utcMinutes + to.tz.offset < 0) dayNote = ' (previous day)';

  // Format source time for display
  const srcH12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
  const srcAmpm = hours >= 12 ? 'PM' : 'AM';
  const srcTimeOut = minutes > 0 ? `${srcH12}:${String(minutes).padStart(2, '0')} ${srcAmpm}` : `${srcH12} ${srcAmpm}`;

  const fromLabel = fromTz.toUpperCase();
  const toLabel = toTz.toUpperCase();

  const diff = to.tz.offset - from.tz.offset;
  const diffH = Math.abs(diff) / 60;
  const ahead = diff > 0 ? 'ahead of' : 'behind';
  const diffStr = diffH === Math.floor(diffH) ? `${diffH} hour${diffH !== 1 ? 's' : ''}` : `${diffH} hours`;

  return {
    success: true,
    message: `${srcTimeOut} ${fromLabel} (${from.tz.name}) = ${timeOut} ${toLabel} (${to.tz.name})${dayNote}\n  ${toLabel} is ${diffStr} ${ahead} ${fromLabel} (${formatOffset(from.tz.offset)} → ${formatOffset(to.tz.offset)})`,
    voiceMessage: `${srcTimeOut} ${from.tz.name} is ${timeOut} ${to.tz.name}${dayNote}. ${toLabel} is ${diffStr} ${ahead} ${fromLabel}.`,
  };
}

// ── City / country → IANA timezone (DST-accurate current time) ──
const CITY_TO_IANA: Record<string, string> = {
  'tokyo': 'Asia/Tokyo', 'japan': 'Asia/Tokyo', 'osaka': 'Asia/Tokyo',
  'london': 'Europe/London', 'uk': 'Europe/London', 'england': 'Europe/London', 'britain': 'Europe/London',
  'new york': 'America/New_York', 'nyc': 'America/New_York', 'new york city': 'America/New_York',
  'washington': 'America/New_York', 'boston': 'America/New_York', 'miami': 'America/New_York', 'atlanta': 'America/New_York',
  'chicago': 'America/Chicago', 'dallas': 'America/Chicago', 'houston': 'America/Chicago',
  'denver': 'America/Denver',
  'los angeles': 'America/Los_Angeles', 'la': 'America/Los_Angeles', 'san francisco': 'America/Los_Angeles',
  'sf': 'America/Los_Angeles', 'california': 'America/Los_Angeles', 'seattle': 'America/Los_Angeles', 'vegas': 'America/Los_Angeles',
  'dubai': 'Asia/Dubai', 'uae': 'Asia/Dubai', 'abu dhabi': 'Asia/Dubai', 'sharjah': 'Asia/Dubai',
  'india': 'Asia/Kolkata', 'delhi': 'Asia/Kolkata', 'mumbai': 'Asia/Kolkata', 'bangalore': 'Asia/Kolkata',
  'bengaluru': 'Asia/Kolkata', 'kolkata': 'Asia/Kolkata', 'hyderabad': 'Asia/Kolkata', 'chennai': 'Asia/Kolkata',
  'paris': 'Europe/Paris', 'france': 'Europe/Paris',
  'berlin': 'Europe/Berlin', 'germany': 'Europe/Berlin', 'munich': 'Europe/Berlin', 'frankfurt': 'Europe/Berlin',
  'madrid': 'Europe/Madrid', 'spain': 'Europe/Madrid', 'barcelona': 'Europe/Madrid',
  'rome': 'Europe/Rome', 'italy': 'Europe/Rome', 'milan': 'Europe/Rome',
  'amsterdam': 'Europe/Amsterdam', 'netherlands': 'Europe/Amsterdam',
  'moscow': 'Europe/Moscow', 'russia': 'Europe/Moscow',
  'istanbul': 'Europe/Istanbul', 'turkey': 'Europe/Istanbul',
  'dublin': 'Europe/Dublin', 'ireland': 'Europe/Dublin',
  'sydney': 'Australia/Sydney', 'melbourne': 'Australia/Melbourne', 'australia': 'Australia/Sydney', 'brisbane': 'Australia/Brisbane', 'perth': 'Australia/Perth',
  'singapore': 'Asia/Singapore',
  'hong kong': 'Asia/Hong_Kong',
  'beijing': 'Asia/Shanghai', 'shanghai': 'Asia/Shanghai', 'china': 'Asia/Shanghai',
  'seoul': 'Asia/Seoul', 'korea': 'Asia/Seoul', 'south korea': 'Asia/Seoul',
  'toronto': 'America/Toronto', 'canada': 'America/Toronto', 'vancouver': 'America/Vancouver',
  'sao paulo': 'America/Sao_Paulo', 'brazil': 'America/Sao_Paulo', 'rio': 'America/Sao_Paulo',
  'mexico city': 'America/Mexico_City', 'mexico': 'America/Mexico_City',
  'auckland': 'Pacific/Auckland', 'new zealand': 'Pacific/Auckland',
  'bangkok': 'Asia/Bangkok', 'thailand': 'Asia/Bangkok',
  'karachi': 'Asia/Karachi', 'pakistan': 'Asia/Karachi', 'lahore': 'Asia/Karachi',
  'jakarta': 'Asia/Jakarta', 'indonesia': 'Asia/Jakarta',
  'manila': 'Asia/Manila', 'philippines': 'Asia/Manila',
  'cairo': 'Africa/Cairo', 'egypt': 'Africa/Cairo',
  'lagos': 'Africa/Lagos', 'nigeria': 'Africa/Lagos',
  'johannesburg': 'Africa/Johannesburg', 'south africa': 'Africa/Johannesburg', 'cape town': 'Africa/Johannesburg',
  'tel aviv': 'Asia/Jerusalem', 'israel': 'Asia/Jerusalem', 'jerusalem': 'Asia/Jerusalem',
  'riyadh': 'Asia/Riyadh', 'saudi arabia': 'Asia/Riyadh', 'saudi': 'Asia/Riyadh',
};

/** Current wall-clock time in a named city/country/timezone, DST-accurate via Intl. */
function currentTimeIn(place: string): CommandResult {
  const lower = place
    .toLowerCase()
    .trim()
    .replace(/\s+(?:time|timezone|right\s+now|now)$/i, '')
    .replace(/^the\s+/i, '')
    .replace(/\?+$/, '')
    .trim();

  const iana = CITY_TO_IANA[lower];
  if (iana) {
    const timeStr = new Intl.DateTimeFormat('en-US', {
      timeZone: iana, hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date());
    const niceLabel = lower.replace(/\b\w/g, (c) => c.toUpperCase());
    return {
      success: true,
      message: `Current time in ${niceLabel}: ${timeStr}`,
      voiceMessage: `It's ${timeStr} in ${niceLabel}.`,
    };
  }

  // Fall back to the fixed-offset table (no DST) for timezone abbreviations.
  const tz = resolveTimezone(lower);
  if (tz) {
    const now = new Date();
    const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
    const target = new Date(utcMs + tz.tz.offset * 60000);
    const h = target.getHours();
    const m = target.getMinutes();
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const ampm = h >= 12 ? 'PM' : 'AM';
    const timeStr = `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
    return {
      success: true,
      message: `Current time in ${tz.tz.name}: ${timeStr}`,
      voiceMessage: `It's ${timeStr} in ${tz.tz.name}.`,
    };
  }

  return { success: false, message: `I don't have a timezone for "${place}". Try a major city or country.` };
}

function findUnit(name: string): { category: UnitCategory; unit: UnitDef } | null {
  const lower = name.toLowerCase().trim();
  for (const cat of UNIT_CATEGORIES) {
    for (const unit of cat.units) {
      if (unit.names.includes(lower)) return { category: cat, unit };
    }
  }
  return null;
}

function convertTemperature(value: number, fromName: string, toName: string): number {
  const from = fromName.toLowerCase();
  const to = toName.toLowerCase();

  // Normalize to Celsius first
  let celsius: number;
  if (['fahrenheit', 'f'].includes(from)) celsius = (value - 32) * 5 / 9;
  else if (['kelvin', 'k'].includes(from)) celsius = value - 273.15;
  else celsius = value;

  // Convert from Celsius to target
  if (['fahrenheit', 'f'].includes(to)) return celsius * 9 / 5 + 32;
  if (['kelvin', 'k'].includes(to)) return celsius + 273.15;
  return celsius;
}

function convertUnits(value: number, fromStr: string, toStr: string): CommandResult {
  const from = findUnit(fromStr);
  const to = findUnit(toStr);

  if (!from) return { success: false, message: `Unknown unit: "${fromStr}"` };
  if (!to) return { success: false, message: `Unknown unit: "${toStr}"` };
  if (from.category.type !== to.category.type) {
    return { success: false, message: `Cannot convert ${from.category.type} to ${to.category.type}` };
  }

  let result: number;
  if (from.category.type === 'temperature') {
    result = convertTemperature(value, from.unit.names[0], to.unit.names[0]);
  } else {
    // Convert: value in source → base unit → target unit
    const baseValue = value * from.unit.factor;
    result = baseValue / to.unit.factor;
  }

  // Smart rounding
  const rounded = result < 0.01 ? result.toExponential(2) : result < 1 ? result.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : result < 100 ? parseFloat(result.toFixed(2)).toString() : Math.round(result).toString();

  const fromLabel = from.unit.names[0];
  const toLabel = to.unit.names[0];

  return {
    success: true,
    message: `${value} ${fromLabel}${value !== 1 ? 's' : ''} = ${rounded} ${toLabel}${parseFloat(rounded) !== 1 ? 's' : ''}`,
    voiceMessage: `${value} ${fromLabel}${value !== 1 ? 's' : ''} is ${rounded} ${toLabel}${parseFloat(rounded) !== 1 ? 's' : ''}.`,
  };
}


// ── Currency Conversion (live rates, no API key) ──
const CURRENCY_CODES = new Set([
  'usd', 'eur', 'gbp', 'jpy', 'aud', 'cad', 'chf', 'cny', 'inr', 'aed', 'sgd',
  'hkd', 'nzd', 'sek', 'nok', 'dkk', 'krw', 'mxn', 'brl', 'zar', 'rub', 'try',
  'pln', 'thb', 'idr', 'myr', 'php', 'czk', 'huf', 'ils', 'sar', 'qar', 'kwd',
  'bhd', 'omr', 'egp', 'ngn', 'pkr', 'bdt', 'lkr', 'vnd', 'twd', 'clp', 'cop',
  'ars', 'ron', 'isk', 'uah', 'ghs', 'kes',
]);

const CURRENCY_ALIASES: Record<string, string> = {
  'dollar': 'usd', 'dollars': 'usd', 'buck': 'usd', 'bucks': 'usd', '$': 'usd',
  'us dollar': 'usd', 'us dollars': 'usd', 'usd$': 'usd',
  'euro': 'eur', 'euros': 'eur', '€': 'eur',
  'pound': 'gbp', 'pounds': 'gbp', 'quid': 'gbp', 'sterling': 'gbp', '£': 'gbp', 'pound sterling': 'gbp',
  'yen': 'jpy', '¥': 'jpy',
  'rupee': 'inr', 'rupees': 'inr', '₹': 'inr',
  'dirham': 'aed', 'dirhams': 'aed',
  'yuan': 'cny', 'rmb': 'cny', 'renminbi': 'cny',
  'won': 'krw',
  'real': 'brl', 'reais': 'brl',
  'peso': 'mxn', 'pesos': 'mxn',
  'franc': 'chf', 'francs': 'chf',
  'riyal': 'sar', 'riyals': 'sar',
  'ringgit': 'myr', 'baht': 'thb', 'rand': 'zar',
  'ruble': 'rub', 'rubles': 'rub', 'rouble': 'rub',
  'lira': 'try', 'shekel': 'ils', 'shekels': 'ils',
};

function normalizeCurrency(name: string): string | null {
  const lower = name.toLowerCase().trim().replace(/\.$/, '');
  if (CURRENCY_ALIASES[lower]) return CURRENCY_ALIASES[lower];
  if (CURRENCY_CODES.has(lower)) return lower;
  return null;
}

function isCurrencyPair(from: string, to: string): boolean {
  return normalizeCurrency(from) !== null && normalizeCurrency(to) !== null;
}

async function convertCurrency(value: number, fromStr: string, toStr: string): Promise<CommandResult> {
  const from = normalizeCurrency(fromStr);
  const to = normalizeCurrency(toStr);
  if (!from || !to) return { success: false, message: `Unknown currency: "${!from ? fromStr : toStr}"` };
  const fromU = from.toUpperCase();
  const toU = to.toUpperCase();

  if (from === to) {
    return { success: true, message: `${value} ${fromU} = ${value} ${toU}`, voiceMessage: `That's the same currency, sir — ${value} ${fromU}.` };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`https://open.er-api.com/v6/latest/${fromU}`, { signal: controller.signal });
    clearTimeout(timer);
    const data: any = await res.json();
    const rate = data?.rates?.[toU];
    if (data?.result !== 'success' || typeof rate !== 'number') {
      return { success: false, message: `Couldn't get a live rate for ${fromU} → ${toU}.` };
    }
    const result = value * rate;
    const rounded = result < 1
      ? result.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
      : result.toLocaleString('en-US', { maximumFractionDigits: 2 });
    return {
      success: true,
      message: `${value.toLocaleString('en-US')} ${fromU} = ${rounded} ${toU}  (rate ${rate.toFixed(4)})`,
      voiceMessage: `${value.toLocaleString('en-US')} ${fromU} is ${rounded} ${toU}.`,
    };
  } catch (err) {
    const reason = (err as Error).name === 'AbortError' ? 'the rate service timed out' : (err as Error).message;
    return { success: false, message: `Currency lookup failed — ${reason}.` };
  }
}

export class ConversionsModule implements JarvisModule {
  name = 'conversions' as const;
  description = 'Timezone and unit conversions — always accurate, no LLM needed';

  patterns: PatternDefinition[] = [
    // ── Timezone Conversion ──
    {
      intent: 'timezone',
      patterns: [
        // "6 PM IST to GST", "6PM IST in GST", "convert 6 PM IST to GST"
        /^(?:convert\s+|what(?:'?s| is)\s+)?(\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm))\s+([a-z]{2,5})\s+(?:to|in)\s+([a-z]{2,5})$/i,
        // "what is 6 PM IST in GST", "what's 14:00 EST in PST"
        /^what(?:'?s| is)\s+(\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm))\s+([a-z]{2,5})\s+(?:to|in)\s+([a-z]{2,5})/i,
        // "6 PM India time to Gulf time", "convert 6 PM Indian standard time to Gulf standard time"
        /^(?:convert\s+|what(?:'?s| is)\s+)?(\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm))\s+(.+?)\s+(?:to|in)\s+(.+?)$/i,
        // "time in GST when it's 6 PM IST"
        /^(?:what\s+)?time\s+in\s+([a-z]{2,5})\s+when\s+(?:it(?:'?s| is)\s+)?(\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm))\s+([a-z]{2,5})$/i,
      ],
      extract: (match, raw) => {
        // Handle "time in GST when it's 6 PM IST" — different argument order
        if (/^(?:what\s+)?time\s+in/i.test(raw)) {
          return { time: match[2].trim(), from: match[3].trim(), to: match[1].trim() };
        }
        return { time: match[1].trim(), from: match[2].trim(), to: match[3].trim() };
      },
    },
    // ── Current Time in a Place ──
    // Placed after timezone (which needs an explicit time) so "6 PM IST to GST"
    // still wins, but before personality's generic clock so "what time is it in
    // tokyo" gives Tokyo's time, not the local time. The negative lookahead for
    // "when" avoids stealing the "time in GST when it's 6 PM IST" timezone form.
    {
      intent: 'current-time',
      patterns: [
        /^what(?:'?s| is)?\s+time\s+is\s+it\s+(?:in|at)\s+(?!.*\bwhen\b)(.+?)\??$/i,
        /^(?:what(?:'?s| is)?\s+)?(?:the\s+)?current\s+time\s+(?:in|at)\s+(.+?)\??$/i,
        /^(?:what(?:'?s| is)?\s+)?(?:the\s+)?time\s+(?:in|at)\s+(?!.*\bwhen\b)(.+?)\??$/i,
      ],
      extract: (match) => ({ place: match[1].trim() }),
    },
    // ── Unit Conversion ──
    {
      intent: 'unit',
      patterns: [
        // "10 miles to km", "convert 5 pounds to kg", "100 fahrenheit in celsius"
        /^(?:convert\s+|what(?:'?s| is)\s+)?(\d+(?:\.\d+)?)\s+(.+?)\s+(?:to|in|into)\s+(.+?)$/i,
        // "how many cups in a gallon", "how many ounces in a cup"
        /^how\s+many\s+(.+?)\s+(?:in|per)\s+(?:a\s+|an?\s+)?(.+?)$/i,
      ],
      extract: (match, raw) => {
        if (/^how\s+many/i.test(raw)) {
          // "how many cups in a gallon" → 1 gallon to cups
          return { value: '1', from: match[2].trim(), to: match[1].trim() };
        }
        return { value: match[1].trim(), from: match[2].trim(), to: match[3].trim() };
      },
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'timezone':
        return convertTimezone(command.args.time, command.args.from, command.args.to);
      case 'current-time':
        return currentTimeIn(command.args.place);
      case 'unit': {
        // Currency uses live rates; real units stay programmatic. Units win
        // when a token is both (none overlap today, but order makes it explicit).
        const { from, to, value } = command.args;
        if (!(findUnit(from) && findUnit(to)) && isCurrencyPair(from, to)) {
          return convertCurrency(parseFloat(value), from, to);
        }
        return convertUnits(parseFloat(value), from, to);
      }
      default:
        return { success: false, message: `Unknown conversion action: ${command.action}` };
    }
  }

  getHelp(): string {
    return [
      '  Conversions — timezone & unit conversions',
      '    6 PM IST to GST              Timezone conversion',
      '    convert 3:30 PM EST to PST   Timezone conversion',
      '    10 miles to km               Unit conversion',
      '    100 fahrenheit to celsius     Temperature conversion',
      '    how many cups in a gallon    Unit lookup',
    ].join('\n');
  }
}
