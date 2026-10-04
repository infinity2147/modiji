export { getZ3, z3SelfTest, type Z3Handle, type Z3SelfTestResult } from "./z3";
export {
  SolverInputError,
  UNRESOLVED,
  effectiveDecision,
  prepareRulebook,
  type EffectiveDecision,
  type Outcome,
  type Rulebook,
  type SolverRule,
} from "./semantics";
export {
  DEFAULT_LIMITS,
  equivalent,
  findBoundaries,
  findConflicts,
  findContrasts,
  findDisagreements,
  findUnresolved,
  practiceCases,
  type BoundaryQuery,
  type BoundaryWitness,
  type ConflictWitness,
  type ContrastQuery,
  type ContrastWitness,
  type DisagreementQuery,
  type DisagreementWitness,
  type EquivalenceResult,
  type FamilyQuery,
  type PracticeQuery,
  type PracticeWitness,
  type UnresolvedWitness,
} from "./witnesses";
export { UNRESOLVED_LIMIT, searchWitnesses, type WitnessSearch, type WitnessSearchResult } from "./search";
