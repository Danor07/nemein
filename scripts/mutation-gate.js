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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(
    "Mutation gate: " +
      mutationGate(
        JSON.parse(fs.readFileSync("reports/mutation/mutation.json", "utf8")),
      ).toFixed(2) +
      "%",
  );
