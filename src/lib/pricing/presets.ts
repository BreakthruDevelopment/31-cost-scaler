import { BASE_SPEC, type ScenarioSpec } from "./spec";

/** "10x users": the base scenario with ten times the monthly active users (and identity users). Public pages price this one. */
export const TEN_X_PRESET: ScenarioSpec = {
  ...BASE_SPEC,
  users: { ...BASE_SPEC.users, mau: BASE_SPEC.users.mau * 10 },
  identity: { mau: BASE_SPEC.identity.mau * 10 },
};
