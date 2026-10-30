import base from "./stryker.import.config.mjs";

// The parser is pure and its limit tests handle 5 MB files: keep them away from the CSV scope.
export default {
  ...base,
  mutate: ["src/statement-import.js"],
  commandRunner: {
    command:
      "node --test test/statement-import.test.js test/properties/statement-import.property.test.js test/fuzz/statement-import.test.js",
  },
  jsonReporter: { fileName: "reports/statement-mutation/mutation.json" },
  htmlReporter: { fileName: "reports/statement-mutation/mutation.html" },
};
