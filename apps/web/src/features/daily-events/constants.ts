/**
 * Daily Events — constants ported from the employee portal
 * (Tools-Team-Member-Portal api/lib/sms-timing.ts + DailyEventsPage.tsx).
 *
 * The portal read its FM resource→location split from its own Postgres
 * (system_settings.sms_timing_resource_mappings). The website cannot reach
 * that DB, so the authoritative row was exported 2026-07-12 and frozen into
 * SMS_TIMING_RESOURCE_MAPPINGS below. Everything else is a verbatim port —
 * per owner directive the upstream API calls must not change.
 */

export const SMS_TIMING_BASE_URL = "https://office-api22.sms-timing.com";

export const SMS_HEADERS = {
  origin: "https://office.bmileisure.com",
  referer: "https://office.bmileisure.com/",
};

// Portal location IDs (7shifts ids — kept verbatim so the moved UI and the
// portal iframe contract stay identical).
export const LOCATION_TO_CLIENT_KEY: Record<number, string> = {
  332160: "headpinzftmyers", // HeadPinz Fort Myers
  467486: "headpinzftmyers", // FastTrax (shares FM server)
  332145: "headpinznaples", // HeadPinz Naples
};

export const SHARED_FM_LOCATIONS = [332160, 467486];

export const LOCATION_NAMES: Record<number, string> = {
  332160: "HeadPinz Fort Myers",
  332145: "HeadPinz Naples",
  467486: "FastTrax Fort Myers",
};

/** Location picker entries (replaces the portal's LocationContext). */
export const LOCATIONS: { id: number; label: string; short: string }[] = [
  { id: 332160, label: "HeadPinz Fort Myers", short: "HP FM" },
  { id: 467486, label: "FastTrax Fort Myers", short: "FastTrax" },
  { id: 332145, label: "HeadPinz Naples", short: "Naples" },
];

/**
 * FM resource→location assignments. Exported from the portal DB
 * (system_settings.sms_timing_resource_mappings) on 2026-07-12.
 * Shape matches the portal row exactly: resourceId → [locationId, ...].
 */
export const SMS_TIMING_RESOURCE_MAPPINGS: Record<string, number[]> = {
  "76810": [332160],
  "305105": [332160],
  "305107": [332160],
  "305133": [332160],
  "305605": [332160],
  "310752": [332160],
  "311252": [332160],
  "312255": [332160],
  "312258": [332160],
  "312261": [332160],
  "312264": [332160],
  "314545": [332160],
  "314548": [332160],
  "314551": [332160],
  "314554": [332160],
  "315746": [332160],
  "333684": [332160],
  "333807": [332160],
  "333931": [332160],
  "334065": [332160],
  "350398": [332160],
  "350401": [332160],
  "350404": [332160],
  "350407": [332160],
  "350410": [332160],
  "350413": [332160],
  "350416": [332160],
  "350419": [332160],
  "350422": [332160],
  "350425": [332160],
  "350428": [332160],
  "350431": [332160],
  "350434": [332160],
  "350437": [332160],
  "350440": [332160],
  "350443": [332160],
  "350954": [332160],
  "635846": [332160],
  "1796293": [332160],
  "1796296": [332160],
  "1796301": [332160],
  "11208654": [467486],
  "11208660": [467486],
  "11252394": [467486],
  "11415868": [467486],
  "11415871": [467486],
  "11415874": [467486],
  "11416386": [467486],
  "11416391": [467486],
  "11418744": [467486],
  "11418764": [467486],
  "11418768": [467486],
  "11418772": [467486],
  "11418775": [467486],
  "11418778": [467486],
  "11418781": [467486],
  "11418784": [467486],
  "11418787": [467486],
  "11981277": [467486],
  "14824707": [467486],
  "15159040": [467486],
  "23109817": [332160],
  "23118611": [467486],
  "23134588": [332160],
  "24396607": [332160],
  "24397590": [332160],
  "24398518": [332160],
  "24712785": [467486],
  "28443055": [332160],
  "28443057": [332160],
  "28443690": [332160],
  "28443692": [332160],
  "28443696": [332160],
  "28443699": [332160],
  "28443702": [332160],
  "28443707": [332160],
  "28443710": [332160],
  "28443713": [332160],
  "28443716": [332160],
  "33416821": [467486],
  "-1": [467486],
};

// Curated resource IDs per client key (portal RESOURCE_IDS, verbatim) —
// fallback for shared FM when mappings are empty, primary for Naples.
export const RESOURCE_IDS: Record<string, string[]> = {
  headpinzftmyers: ["305133", "11208654", "11208660", "14824707", "15159040", "33416821", "-1"],
  headpinznaples: [
    "1243628", // Game Zone
    "23540", // Karting
    "34633", // LaserTag
    "34635",
    "34637",
    "34639",
    "34641",
    "35125",
    "35127",
    "35129",
    "34652", // Lanes 1-8
    "35131",
    "35134",
    "35137",
    "35140",
    "35143",
    "35146",
    "35149",
    "35152", // Lanes 9-16
    "35155",
    "35158",
    "35161",
    "35164",
    "35167",
    "35170",
    "35173",
    "35176", // Lanes 17-24
    "35179",
    "35183",
    "35186",
    "35189",
    "35192",
    "35195",
    "35198",
    "35201", // Lanes 25-32
    "523598", // Nemos
  ],
};

// Static fallback resource names (portal RESOURCE_NAMES, verbatim).
export const RESOURCE_NAMES: Record<string, string> = {
  // Sales / POS
  "635846": "HPFM POS",
  "11981277": "POS",
  "23557": "Bar",
  // Go-kart tracks / attractions
  "305133": "HP Arena",
  "11208654": "Blue Track",
  "11208660": "Red Track",
  "14824707": "Mini Track",
  "15159040": "Ferrari Sim",
  "33416821": "Web Credit",
  "-1": "Mega Track",
  // Resource groups
  "334065": "Axe Throwing",
  "11418744": "FT Duck Pin",
  "11416391": "FT Rooms",
  "23118611": "FT Shuffly",
  "305105": "HP Old Time Lanes",
  "350954": "HP Regular Lanes",
  "11416386": "HP Rooms",
  "310752": "HP VIP Lanes",
  "24396607": "HPFM Shuffly",
  "28443057": "HPFM Tables",
  // HP Old Time Lanes (Lanes 1-4)
  "305107": "Lane 1",
  "305605": "Lane 2",
  "315746": "Lane 3",
  "311252": "Lane 4",
  // HP VIP Lanes (Lanes 5-12)
  "312255": "Lane 5",
  "312258": "Lane 6",
  "312261": "Lane 7",
  "312264": "Lane 8",
  "314545": "Lane 9",
  "314548": "Lane 10",
  "314551": "Lane 11",
  "314554": "Lane 12",
  // HP Regular Lanes (Lanes 13-28)
  "350398": "Lane 13",
  "350401": "Lane 14",
  "350404": "Lane 15",
  "350407": "Lane 16",
  "350410": "Lane 17",
  "350413": "Lane 18",
  "350416": "Lane 19",
  "350419": "Lane 20",
  "350422": "Lane 21",
  "350425": "Lane 22",
  "350428": "Lane 23",
  "350431": "Lane 24",
  "350434": "Lane 25",
  "350437": "Lane 26",
  "350440": "Lane 27",
  "350443": "Lane 28",
  // Axe Throwing lanes
  "333684": "Axe Lane 1",
  "76810": "Axe Lane 2",
  "333807": "Axe Lane 3",
  "333931": "Axe Lane 4",
  // HP Rooms
  "1796293": "HP Corp Room",
  "1796296": "HP Nemos",
  "1796301": "HP Pool Tables",
  // FT Duck Pin lanes (group 11418744)
  "11418764": "Duck Lane 1",
  "11418768": "Duck Lane 2",
  "11418772": "Duck Lane 3",
  "11418775": "Duck Lane 4",
  "11418778": "Duck Lane 5",
  "11418781": "Duck Lane 6",
  "11418784": "Duck Lane 7",
  "11418787": "Duck Lane 8",
  // FT Rooms (group 11416391)
  "11415871": "FT Room 1",
  "11415874": "FT Room 2",
  "11415868": "FT VIP Room",
  // HPFM Shuffly Tables (group 24396607)
  "24397590": "HPFM Shuffly Table 1",
  "24398518": "HPFM Shuffly Table 2",
  // FT Shuffly Tables (group 23118611)
  "23109817": "Shuffly Table 1",
  "23134588": "Shuffly Table 2",
  // HPFM Tables (group 28443057)
  "28443055": "HP Table 1",
  "28443690": "HP Table 2",
  "28443692": "HP Table 3",
  "28443696": "HP Table 4",
  "28443699": "HP Table 5",
  "28443702": "HP Table 6",
  "28443707": "HP Table 7",
  "28443710": "HP Table 8",
  "28443713": "HP Table 9",
  "28443716": "HP Table 10",
  // Other
  "24712785": "Combos",
  "11252394": "Test",
  "74842": "Z-DO NOT TOUCH",
  // ── HeadPinz Naples ──
  "1243628": "Game Zone",
  "50338": "HPN POS",
  "23540": "Karting",
  "34633": "LaserTag",
  "34635": "Lane 1",
  "34637": "Lane 2",
  "34639": "Lane 3",
  "34641": "Lane 4",
  "35125": "Lane 5",
  "35127": "Lane 6",
  "35129": "Lane 7",
  "34652": "Lane 8",
  "35131": "Lane 9",
  "35134": "Lane 10",
  "35137": "Lane 11",
  "35140": "Lane 12",
  "35143": "Lane 13",
  "35146": "Lane 14",
  "35149": "Lane 15",
  "35152": "Lane 16",
  "35155": "Lane 17",
  "35158": "Lane 18",
  "35161": "Lane 19",
  "35164": "Lane 20",
  "35167": "Lane 21",
  "35170": "Lane 22",
  "35173": "Lane 23",
  "35176": "Lane 24",
  "35179": "Lane 25",
  "35183": "Lane 26",
  "35186": "Lane 27",
  "35189": "Lane 28",
  "35192": "Lane 29",
  "35195": "Lane 30",
  "35198": "Lane 31",
  "35201": "Lane 32",
  "523598": "Nemos",
};

// Known kind ID to display name mappings (portal KIND_NAMES, verbatim).
export const KIND_NAMES: Record<string, string> = {
  "-1": "Group Event",
  "-10": "Online",
};

// Hardcoded BMI user ID → display name (portal USER_NAMES, verbatim).
export const USER_NAMES: Record<string, string> = {
  "6927814": "Desk",
  "6926773": "Desk",
  "304099": "Alex Test",
  "465272": "Alyssa Alexander",
  "465277": "Angeline Barrientos",
  "1984736": "Antwon Cross",
  "465322": "Arianis Santiago",
  "1984742": "Ashley Rodriguez",
  "465282": "Barb Bill",
  "21356027": "Bruce McElhone",
  "-7": "bvherck",
  "25171759": "Caleb Rios",
  "30080112": "Guest Services",
  "36161360": "Cedriq Coles",
  "465287": "Christian Houghtaling",
  "465267": "Collin Walden",
  "313534": "Curtis Stavich",
  "3230624": "Cynthia Halsey",
  "3230618": "Daniel Lynn",
  "34013172": "David Ryan",
  "-8": "Default",
  "37558734": "Diana Blackburn",
  "4192623": "Dona Anil",
  "3230654": "Dwight Pinder",
  "3230677": "Dylan Barrantes",
  "75262": "Eric Osborn",
  "17828857": "FT Agent",
  "-14": "Garage",
  "3230648": "Garvens Doricar",
  "22641919": "Henrry Gomez",
  "15705734": "Houston Jackson",
  "7251049": "Jacob Elliott",
  "465292": "Jah'nay Brown",
  "74755": "Jp Odea",
  "3230695": "Jamil Hisham",
  "665547": "Jasmine",
  "1095075": "Jeff Doucette",
  "465297": "Jeffrey Molina",
  "465340": "Jeliannis Gonzalez",
  "31362107": "Jesse Yarnell",
  "1984748": "Joao Miranda",
  "28267036": "Kelsea Kosco",
  "33134127": "Kenyon Campos",
  "16500973": "Leah",
  "1984772": "Leonardo Leon",
  "465247": "Lori Lehman",
  "465302": "Malak Hisham",
  "2049261": "Marc Ciniello",
  "465307": "Mason Gallipo",
  "3230630": "Morgan Zabonik",
  "-13": "Office",
  "-6": "Online",
  "1365638": "Patty Robinson",
  "6772410": "Paula McGarvey",
  "-11": "Pit",
  "-12": "Pos",
  "3230606": "Rishadd Wilcox",
  "7346506": "Ronald C",
  "9086189": "Simone Caposeno",
  "465312": "Sebastian Viviani",
  "465317": "Sophia Gomez",
  "465242": "Stephanie Wegman",
  "31983047": "Stephanie Tajkowski",
  "3230612": "Steven Rodriguez",
  "3230683": "Steven Gomez",
  "3230636": "Terry Gonzalez",
  "31362099": "Wyatt Little",
  "15156997": "Yicela Almeida",
  "465332": "Zachary Christian",
  "465252": "Aiden Bernhardt",
  "465257": "Alexses Fry",
};

// Known payment method IDs (portal PAY_METHOD_NAMES, verbatim).
export const PAY_METHOD_NAMES: Record<string, string> = {
  "27393137": "Square Online",
  "-1": "Cash",
  "7197134": "Refunded on Square",
  "24926200": "Submitted to IT for Refund",
  "393793": "Paid on Conq",
  "14845425": "Paid on Square",
  "25441119": "Group Function",
  "393797": "PandaDoc Payment",
};

// Built-in SMS-Timing project state IDs (required for liveReservations queries).
export const BUILTIN_PROJECT_STATES = ["-2", "-3", "-4", "-5", "-106"];

// ── Waiver display rules (portal DailyEventsPage.tsx, verbatim) ──────

export const DEFAULT_WAIVER_THRESHOLDS = { red: 60, yellow: 90 };

export const WAIVER_RESOURCE_KEYWORDS = ["arena", "track", "laser", "gel blaster"];

// ── BMI private-note sync (portal sync-bmi-notes.ts, verbatim) ───────

export const PORTAL_SEPARATOR = "\n\n----- Portal Staff -----\n";

// ── Cross-links ──────────────────────────────────────────────────────

/** The TV events dashboard stays in the employee portal. */
export function portalTvUrl(locationId: number): string {
  return `https://portal.headpinz.com/tv/events?location=${locationId}`;
}
