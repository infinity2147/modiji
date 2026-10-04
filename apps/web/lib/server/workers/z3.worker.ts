/**
 * The Z3 worker thread: the only place the server process loads the Z3 WASM solver. Building
 * formulas, reading models and spawning Z3's own threads all happen here, off the event loop that
 * serves requests (the custom LLM and the gate in particular).
 */
import { findDisagreements, practiceCases, searchWitnesses, z3SelfTest } from "@vashistha/solver";
import { serveRpc } from "./serve";
import { Z3_OPS } from "./z3-ops";

serveRpc(Z3_OPS, {
  witnesses: searchWitnesses,
  disagreements: findDisagreements,
  practice: practiceCases,
  selfTest: () => z3SelfTest(),
});
