// All balance knobs of the simulation in one place.
// Units: time in seconds, capacity in vehicles per hour, money in tenge.

export const SLOTS = 48;               // half-hour slots of a typical weekday
export const SLOT_H = 0.5;

// Assignment regimes: drivers pick routes with the costs of the regime
// their trip falls into. Night slots use the midday costs (near free flow).
export const R_AM = 0, R_MID = 1, R_PM = 2;
export const REGIMES = 3;
export function regimeOfSlot(s) {
  if (s >= 12 && s < 21) return R_AM;    // 06:00–10:30
  if (s >= 31 && s < 42) return R_PM;    // 15:30–21:00
  return R_MID;
}

// Road classes: motorway, trunk, primary, secondary, tertiary.
export const CRUISE_KMH = [82, 62, 44, 37, 30];  // free-flow incl. average signal delay
export const LINK_CRUISE_KMH = 36;
export const CAP_PER_LANE = [1850, 1350, 800, 700, 600];
export const LINK_CAP_PER_LANE = 1200;
export const CURB_PARKING_FACTOR = 0.86;  // secondary/tertiary lose part of a lane to parked cars
export const SIGNALIZED = [false, true, true, true, true];

// Volume-delay (BPR): t = t0 * (1 + ALPHA * x^BETA), x = flow / capacity.
export const BPR_ALPHA = 0.62;
export const BPR_BETA = 4;
export const MAX_RATIO = 9;          // cap for the displayed index (one link can't explode a district)
export const ROUTE_MAX_RATIO = 60;   // drivers see the real queue when choosing routes

// Demand (daily car trips in the base year). Calibrated with CAPACITY_SCALE.
export const DEMAND = {
  workCarTripsPerJob: 0.36,     // home->work by car per job
  pupilsDriven: 0.22,           // share of pupils driven to school
  pickupShare: 0.55,            // ...of which are also picked up by car
  secondShift: 0.28,            // pupils studying in the second shift
  uniCarShare: 0.13,
  otherPerResident: 0.155,      // home->other (shopping, services, leisure)
  externalCommuters: 100000,    // cars entering from the agglomeration each morning
  throughTrips: 16000,          // transit that has no bypass in the modelled area
  commercialPerCapita: 0.052,   // taxis, deliveries, service vans (both directions)
};
export const GRAVITY_BETA = {      // per minute of free-flow travel time
  work: 0.058, school: 0.19, uni: 0.045, other: 0.095, ext: 0.035, com: 0.07,
};
export const INTRAZONAL_MIN = 4;   // assumed intrazonal travel time (min)

export const CAPACITY_SCALE = 1.53; // global calibration knob (baseline index ~60%, see tests/calibrate.html)

// Calibration overrides (tests/calibrate.html tweaks these before building a model).
export const TUNE = { capacity: 1.0, demand: 1.0, alpha: BPR_ALPHA };

// Monthly learning rate of drivers (MSA step after warm-up).
export const MSA_STEP = 0.5;
export const WARMUP_ITERS = 14;

// Growth: annual rates, tapering linearly over the given number of years.
export const GROWTH = {
  popStart: 0.021, popEnd: 0.006, popYears: 30,
  motorStart: 0.012, motorEnd: 0.002, motorYears: 25,
  // district multipliers of population growth (normalized by population)
  district: { alatau: 1.5, almaly: 0.35, auezov: 0.75, bostandyk: 0.95, zhetysu: 0.8, medeu: 0.6, nauryzbay: 2.2, turksib: 1.05 },
};

// Seasons (month 0 = January).
export const SEASON = {
  schoolActive: m => !(m >= 5 && m <= 7),             // June–August holidays
  workFactor: m => (m === 6 || m === 7 ? 0.9 : m === 0 ? 0.95 : 1),
  winterCap: m => (m === 11 || m === 0 || m === 1 ? 0.93 : m === 2 ? 0.97 : 1),
  otherFactor: m => (m === 11 ? 1.08 : m === 6 || m === 7 ? 1.04 : 1),
};
