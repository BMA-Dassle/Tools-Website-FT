export type RaceProduct = {
  title: string;
  category: "adult" | "junior" | "mini";
  tier: "starter" | "intermediate" | "pro";
  age: string;
  height: string;
  qualification: string | null;
  arriveMinutes: number;
  licenseFee: string;
  note?: string;
};

export const products: Record<string, RaceProduct> = {
  "adult-starter": {
    title: "Adult Starter",
    category: "adult",
    tier: "starter",
    age: "13+",
    height: '59" or taller',
    qualification: null,
    arriveMinutes: 30,
    licenseFee: "$4.99",
  },
  "adult-intermediate": {
    title: "Adult Intermediate",
    category: "adult",
    tier: "intermediate",
    age: "16+",
    height: '59" or taller',
    qualification: "You must already be qualified in a Starter Race before booking this race. NO EXCEPTIONS — regardless of racing experience elsewhere.",
    arriveMinutes: 30,
    licenseFee: "$4.99",
  },
  "adult-pro": {
    title: "Adult Pro",
    category: "adult",
    tier: "pro",
    age: "16+",
    height: '59" or taller',
    qualification: "You must already be qualified in an Intermediate Race before booking this race. NO EXCEPTIONS — regardless of racing experience elsewhere.",
    arriveMinutes: 30,
    licenseFee: "$4.99",
  },
  "junior-starter": {
    title: "Junior Starter",
    category: "junior",
    tier: "starter",
    age: "7–13",
    height: '49"–70"',
    qualification: null,
    arriveMinutes: 30,
    licenseFee: "$4.99",
    note: "Not available on Mega Track Tuesdays.",
  },
  "junior-intermediate": {
    title: "Junior Intermediate",
    category: "junior",
    tier: "intermediate",
    age: "7–13",
    height: '49"–70"',
    qualification: "You must already be qualified in a Junior Starter Race before booking this race. NO EXCEPTIONS — regardless of racing experience elsewhere.",
    arriveMinutes: 30,
    licenseFee: "$4.99",
  },
  "junior-pro": {
    title: "Junior Pro",
    category: "junior",
    tier: "pro",
    age: "7–13",
    height: '49"–70"',
    qualification: "You must already be qualified in a Junior Intermediate Race before booking this race. NO EXCEPTIONS — regardless of racing experience elsewhere.",
    arriveMinutes: 30,
    licenseFee: "$4.99",
  },
};
