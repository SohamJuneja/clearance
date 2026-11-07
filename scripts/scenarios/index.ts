import type { Scenario } from "../demo/runner.ts";
import sc01 from "./sc01.ts";
import sc02 from "./sc02.ts";
import sc02t from "./sc02t.ts";
import scbg from "./scbg.ts";
import scdg from "./scdg.ts";
import sc03 from "./sc03.ts";
import sc04 from "./sc04.ts";
import sc05 from "./sc05.ts";
import sc06 from "./sc06.ts";
import sc07 from "./sc07.ts";
import sc08 from "./sc08.ts";
import sc09 from "./sc09.ts";
import sc10 from "./sc10.ts";
import sc11 from "./sc11.ts";
import sc12 from "./sc12.ts";
import sc13 from "./sc13.ts";
import sc14 from "./sc14.ts";
import scco from "./scco.ts";
import scfw from "./scfw.ts";
import scou from "./scou.ts";
import sccc from "./sccc.ts";
import scri from "./scri.ts";
import scro from "./scro.ts";
import scho, { nobodyHoldsIt } from "./scho.ts";
import scst from "./scst.ts";

/** Every scenario in PLAN 8.7, in order. */
export const SCENARIOS: Scenario[] = [
  sc01,
  sc02,
  sc03,
  sc04,
  sc05,
  sc06,
  sc07,
  sc08,
  sc09,
  sc10,
  sc11,
  sc12,
  sc13,
  sc14,
];

/** Scenes that aren't numbered rows of PLAN 8.7. `pnpm demo:run all` leaves them out. */
export const EXTRA_SCENARIOS: Scenario[] = [sc02t, scbg, scdg, scco, scfw, scou, scst, sccc, scri, scro, scho, nobodyHoldsIt];

export function findScenario(id: string): Scenario | undefined {
  const wanted = id.toUpperCase();
  return [...SCENARIOS, ...EXTRA_SCENARIOS].find((scenario) => scenario.id === wanted);
}
