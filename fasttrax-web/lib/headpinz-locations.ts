/** HeadPinz location config — shared data between pages */

export interface HeadPinzLocation {
  slug: string;
  name: string;
  fullName: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  hours: string;
  hoursWeekend: string;
  bmiClientKey: string;
  bowlingUrl: string;
  waiverUrl: string;
  /** Location-specific overrides (pricing, etc.) */
  laserTagPrice: number;
  gelBlasterPrice: number;
}

export const HP_LOCATIONS: Record<string, HeadPinzLocation> = {
  "fort-myers": {
    slug: "fort-myers",
    name: "Fort Myers",
    fullName: "HeadPinz Fort Myers",
    address: "14513 Global Parkway",
    city: "Fort Myers",
    state: "FL",
    zip: "33913",
    phone: "(239) 302-2155",
    hours: "Sun-Thu 11AM-12AM",
    hoursWeekend: "Fri-Sat 11AM-2AM",
    bmiClientKey: "headpinzftmyers",
    bowlingUrl: "https://www.mybowlingpassport.com/2/9172/book",
    waiverUrl: "https://kiosk.bmileisure.com/headpinzftmyers",
    laserTagPrice: 10,
    gelBlasterPrice: 12,
  },
  naples: {
    slug: "naples",
    name: "Naples",
    fullName: "HeadPinz Naples",
    address: "8525 Radio Lane",
    city: "Naples",
    state: "FL",
    zip: "34104",
    phone: "(239) 455-3755",
    hours: "Sun-Thu 11AM-12AM",
    hoursWeekend: "Fri-Sat 11AM-2AM",
    bmiClientKey: "headpinznaples",
    bowlingUrl: "https://www.mybowlingpassport.com/2/3148/book",
    waiverUrl: "https://kiosk.bmileisure.com/headpinznaples",
    laserTagPrice: 8.50,
    gelBlasterPrice: 12,
  },
};

export function getLocation(slug: string): HeadPinzLocation | undefined {
  return HP_LOCATIONS[slug];
}
