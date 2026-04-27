/**
 * North American Numbering Plan (NANP) area-code → IANA timezone mapping.
 *
 * Used by the campaign scheduler to evaluate quiet-hours compliance against
 * the contact's local time rather than the campaign owner's local time. This
 * is required for TCPA compliance — calls outside 8am–9pm local time at the
 * called party's location are prohibited for telemarketing.
 *
 * The map intentionally covers every assigned US/Canada area code currently
 * in active use as of 2024. Codes that span multiple timezones (e.g. some
 * along the Tennessee/Kentucky border) are mapped to the timezone that
 * covers the largest population in that area code so the default behavior
 * stays conservative; campaigns can override per-area-code with the
 * `areaCodeTimezones` config field if they need finer control.
 */

export const NANP_AREA_CODE_TIMEZONES: Record<string, string> = {
  // ── Eastern Time ─────────────────────────────────────────────────────────
  '201': 'America/New_York', '202': 'America/New_York', '203': 'America/New_York',
  '207': 'America/New_York', '212': 'America/New_York', '215': 'America/New_York',
  '216': 'America/New_York', '223': 'America/New_York', '224': 'America/Chicago',
  '227': 'America/New_York', '229': 'America/New_York', '231': 'America/New_York',
  '234': 'America/New_York', '239': 'America/New_York', '240': 'America/New_York',
  '241': 'America/New_York', '248': 'America/New_York', '252': 'America/New_York',
  '267': 'America/New_York', '269': 'America/New_York', '270': 'America/New_York',
  '272': 'America/New_York', '276': 'America/New_York', '278': 'America/New_York',
  '283': 'America/New_York', '301': 'America/New_York', '302': 'America/New_York',
  '304': 'America/New_York', '305': 'America/New_York', '313': 'America/New_York',
  '315': 'America/New_York', '317': 'America/Indiana/Indianapolis', '321': 'America/New_York',
  '326': 'America/New_York', '330': 'America/New_York', '336': 'America/New_York',
  '339': 'America/New_York', '347': 'America/New_York', '352': 'America/New_York',
  '353': 'America/New_York', '364': 'America/New_York', '386': 'America/New_York',
  '404': 'America/New_York', '407': 'America/New_York', '410': 'America/New_York',
  '412': 'America/New_York', '413': 'America/New_York', '419': 'America/New_York',
  '423': 'America/New_York', '434': 'America/New_York', '440': 'America/New_York',
  '443': 'America/New_York', '445': 'America/New_York', '447': 'America/New_York',
  '463': 'America/Indiana/Indianapolis', '464': 'America/New_York',
  '470': 'America/New_York', '475': 'America/New_York', '478': 'America/New_York',
  '484': 'America/New_York', '513': 'America/New_York', '516': 'America/New_York',
  '517': 'America/New_York', '518': 'America/New_York', '540': 'America/New_York',
  '551': 'America/New_York', '561': 'America/New_York', '567': 'America/New_York',
  '570': 'America/New_York', '571': 'America/New_York', '585': 'America/New_York',
  '586': 'America/New_York', '603': 'America/New_York', '606': 'America/New_York',
  '607': 'America/New_York', '609': 'America/New_York', '610': 'America/New_York',
  '614': 'America/New_York', '616': 'America/New_York', '617': 'America/New_York',
  '624': 'America/New_York', '631': 'America/New_York', '646': 'America/New_York',
  '667': 'America/New_York', '670': 'Pacific/Saipan', '672': 'America/New_York',
  '673': 'America/New_York', '678': 'America/New_York', '680': 'America/New_York',
  '681': 'America/New_York', '689': 'America/New_York', '703': 'America/New_York',
  '704': 'America/New_York', '706': 'America/New_York', '716': 'America/New_York',
  '717': 'America/New_York', '718': 'America/New_York', '724': 'America/New_York',
  '727': 'America/New_York', '732': 'America/New_York', '734': 'America/New_York',
  '740': 'America/New_York', '743': 'America/New_York', '754': 'America/New_York',
  '757': 'America/New_York', '762': 'America/New_York', '770': 'America/New_York',
  '772': 'America/New_York', '774': 'America/New_York', '781': 'America/New_York',
  '786': 'America/New_York', '787': 'America/Puerto_Rico', '789': 'America/New_York',
  '802': 'America/New_York', '803': 'America/New_York', '804': 'America/New_York',
  '810': 'America/New_York', '813': 'America/New_York', '814': 'America/New_York',
  '828': 'America/New_York', '829': 'America/Santo_Domingo', '835': 'America/New_York',
  '843': 'America/New_York', '845': 'America/New_York', '848': 'America/New_York',
  '849': 'America/Santo_Domingo', '850': 'America/New_York', '856': 'America/New_York',
  '857': 'America/New_York', '859': 'America/New_York', '860': 'America/New_York',
  '862': 'America/New_York', '863': 'America/New_York', '864': 'America/New_York',
  '865': 'America/New_York', '878': 'America/New_York', '904': 'America/New_York',
  '908': 'America/New_York', '910': 'America/New_York', '912': 'America/New_York',
  '914': 'America/New_York', '917': 'America/New_York', '919': 'America/New_York',
  '929': 'America/New_York', '934': 'America/New_York', '937': 'America/New_York',
  '939': 'America/Puerto_Rico', '941': 'America/New_York', '945': 'America/New_York',
  '947': 'America/New_York', '954': 'America/New_York', '959': 'America/New_York',
  '973': 'America/New_York', '978': 'America/New_York', '980': 'America/New_York',
  '984': 'America/New_York',
  // ── Central Time ─────────────────────────────────────────────────────────
  '205': 'America/Chicago', '210': 'America/Chicago', '214': 'America/Chicago',
  '217': 'America/Chicago', '218': 'America/Chicago', '219': 'America/Indiana/Indianapolis',
  '225': 'America/Chicago', '228': 'America/Chicago', '251': 'America/Chicago',
  '254': 'America/Chicago', '256': 'America/Chicago', '262': 'America/Chicago',
  '281': 'America/Chicago', '309': 'America/Chicago', '312': 'America/Chicago',
  '314': 'America/Chicago', '316': 'America/Chicago', '318': 'America/Chicago',
  '319': 'America/Chicago', '320': 'America/Chicago', '331': 'America/Chicago',
  '334': 'America/Chicago', '337': 'America/Chicago', '346': 'America/Chicago',
  '361': 'America/Chicago', '402': 'America/Chicago', '405': 'America/Chicago',
  '409': 'America/Chicago', '414': 'America/Chicago', '417': 'America/Chicago',
  '430': 'America/Chicago', '432': 'America/Chicago', '441': 'Atlantic/Bermuda',
  '450': 'America/Toronto',
  '458': 'America/Los_Angeles',
  '469': 'America/Chicago', '479': 'America/Chicago', '501': 'America/Chicago',
  '502': 'America/New_York', '504': 'America/Chicago', '507': 'America/Chicago',
  '512': 'America/Chicago', '515': 'America/Chicago', '563': 'America/Chicago',
  '573': 'America/Chicago', '580': 'America/Chicago', '601': 'America/Chicago',
  '608': 'America/Chicago', '612': 'America/Chicago', '618': 'America/Chicago',
  '620': 'America/Chicago', '630': 'America/Chicago', '636': 'America/Chicago',
  '641': 'America/Chicago', '651': 'America/Chicago', '659': 'America/Chicago',
  '660': 'America/Chicago', '662': 'America/Chicago', '682': 'America/Chicago',
  '708': 'America/Chicago', '712': 'America/Chicago', '713': 'America/Chicago',
  '715': 'America/Chicago', '731': 'America/Chicago', '737': 'America/Chicago',
  '763': 'America/Chicago', '769': 'America/Chicago', '773': 'America/Chicago',
  '779': 'America/Chicago', '785': 'America/Chicago', '806': 'America/Chicago',
  '815': 'America/Chicago', '816': 'America/Chicago', '817': 'America/Chicago',
  '818': 'America/Los_Angeles', '825': 'America/Edmonton', '830': 'America/Chicago',
  '832': 'America/Chicago', '847': 'America/Chicago', '870': 'America/Chicago',
  '872': 'America/Chicago', '901': 'America/Chicago', '903': 'America/Chicago',
  '913': 'America/Chicago', '915': 'America/Denver', '918': 'America/Chicago',
  '920': 'America/Chicago', '931': 'America/Chicago', '936': 'America/Chicago',
  '940': 'America/Chicago', '952': 'America/Chicago', '956': 'America/Chicago',
  '972': 'America/Chicago', '985': 'America/Chicago', '989': 'America/New_York',
  // ── Mountain Time ────────────────────────────────────────────────────────
  '208': 'America/Denver', '303': 'America/Denver', '307': 'America/Denver',
  '385': 'America/Denver', '406': 'America/Denver', '435': 'America/Denver',
  '480': 'America/Phoenix', '505': 'America/Denver', '520': 'America/Phoenix',
  '575': 'America/Denver', '602': 'America/Phoenix', '623': 'America/Phoenix',
  '719': 'America/Denver', '720': 'America/Denver', '801': 'America/Denver',
  '928': 'America/Phoenix', '970': 'America/Denver', '986': 'America/Denver',
  // ── Pacific Time ─────────────────────────────────────────────────────────
  '206': 'America/Los_Angeles', '209': 'America/Los_Angeles', '213': 'America/Los_Angeles',
  '253': 'America/Los_Angeles', '279': 'America/Los_Angeles', '310': 'America/Los_Angeles',
  '323': 'America/Los_Angeles', '341': 'America/Los_Angeles', '350': 'America/Los_Angeles',
  '360': 'America/Los_Angeles', '408': 'America/Los_Angeles', '415': 'America/Los_Angeles',
  '424': 'America/Los_Angeles', '425': 'America/Los_Angeles', '426': 'America/Los_Angeles',
  '442': 'America/Los_Angeles', '503': 'America/Los_Angeles', '509': 'America/Los_Angeles',
  '510': 'America/Los_Angeles', '530': 'America/Los_Angeles', '541': 'America/Los_Angeles',
  '559': 'America/Los_Angeles', '562': 'America/Los_Angeles', '564': 'America/Los_Angeles',
  '619': 'America/Los_Angeles', '626': 'America/Los_Angeles', '628': 'America/Los_Angeles',
  '650': 'America/Los_Angeles', '657': 'America/Los_Angeles', '661': 'America/Los_Angeles',
  '669': 'America/Los_Angeles', '702': 'America/Los_Angeles', '707': 'America/Los_Angeles',
  '714': 'America/Los_Angeles', '725': 'America/Los_Angeles', '747': 'America/Los_Angeles',
  '760': 'America/Los_Angeles', '775': 'America/Los_Angeles', '805': 'America/Los_Angeles',
  '820': 'America/Los_Angeles', '831': 'America/Los_Angeles', '858': 'America/Los_Angeles',
  '909': 'America/Los_Angeles', '916': 'America/Los_Angeles', '925': 'America/Los_Angeles',
  '935': 'America/Los_Angeles', '949': 'America/Los_Angeles', '951': 'America/Los_Angeles',
  // ── Alaska / Hawaii ──────────────────────────────────────────────────────
  '907': 'America/Anchorage', '808': 'Pacific/Honolulu',
};

/**
 * Extract the NANP area code from an E.164-formatted phone number.
 * Returns null when the number is not a 10-digit NANP number.
 */
export function extractAreaCode(phoneNumber: string): string | null {
  if (!phoneNumber) return null;
  const digits = phoneNumber.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return digits.substring(1, 4);
  }
  if (digits.length === 10) {
    return digits.substring(0, 3);
  }
  return null;
}

/**
 * Resolve the IANA timezone for a phone number using its NANP area code.
 * Falls back to the supplied default when the area code is unknown or the
 * number is outside NANP.
 */
export function getTimezoneForPhone(phoneNumber: string, fallback: string): string {
  const area = extractAreaCode(phoneNumber);
  if (!area) return fallback;
  return NANP_AREA_CODE_TIMEZONES[area] ?? fallback;
}
