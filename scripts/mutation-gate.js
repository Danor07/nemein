import fs from "node:fs";
import { pathToFileURL } from "node:url";
export function mutationGate(report) {
  const mutants = Object.values(report.files || {}).flatMap((f) => f.mutants);
  if (!mutants.length) throw Error("No mutants were evaluated");
  if (mutants.some((m) => !["Killed", "Survived"].includes(m.status)))
    throw Error("Mutation run contains timeouts, errors or uncovered mutants");
  const score =
    (100 * mutants.filter((m) => m.status === "Killed").length) /
    mutants.length;
  if (score < 90) throw Error("Mutation score below 90: " + score);
  return score;
}
// cargo-mutants outcomes.json in the same vocabulary, so Rust and JavaScript
// share one threshold. Unviable mutants do not compile and, as in cargo-mutants,
// measure nothing; any other outcome (Timeout, Failure) keeps rejecting the run.
// Several reports (the shards of one run) are judged as one: each must carry
// its own successful baseline.
const cargoStatus = { CaughtMutant: "Killed", MissedMutant: "Survived" };
export function cargoMutantsReport(...labs) {
  if (labs.length === 0) throw Error("Not a cargo-mutants outcomes report");
  const mutants = labs.flatMap((lab) => {
    const outcomes = lab?.outcomes;
    if (!Array.isArray(outcomes))
      throw Error("Not a cargo-mutants outcomes report");
    const baseline = outcomes.filter((o) => o.scenario === "Baseline");
    if (baseline.length !== 1 || baseline[0].summary !== "Success")
      throw Error("cargo-mutants baseline did not succeed");
    return outcomes
      .filter((o) => o.scenario !== "Baseline" && o.summary !== "Unviable")
      .map((o) => ({
        status: Object.hasOwn(cargoStatus, o.summary)
          ? cargoStatus[o.summary]
          : String(o.summary),
      }));
  });
  return { files: { "cargo-mutants": { mutants } } };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  const report =
    process.argv[2] === "--cargo-mutants"
      ? cargoMutantsReport(...process.argv.slice(3).map(read))
      : read(process.argv[2] ?? "reports/mutation/mutation.json");
  console.log("Mutation gate: " + mutationGate(report).toFixed(2) + "%");
}
