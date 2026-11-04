// Regenerates the permission state-machine oracle from the real engine.
import { writeFileSync } from "node:fs";
import { scenarios, runScenario } from "../test/helpers/permission-scenarios.js";

const recorded = [];
for (const scenario of scenarios) recorded.push(await runScenario(scenario));
writeFileSync(
  new URL("../test/fixtures/permission-scenarios.json", import.meta.url),
  JSON.stringify({ format: "nemein-permission-scenarios", version: 1, scenarios: recorded }, null, 2) + "\n",
);
