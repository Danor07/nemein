import base from "./stryker.export.config.mjs";

// Connector administration and imports: the inventory, enablement bound to
// the audit, prepare and the protected confirmation, the owner guards, and the
// import rows the budget shares with CSV. Cheapest tests first.
export default {
  ...base,
  mutate: [
    "src/connectors.js",
    "src/core.js:335-355",
    "src/core.js:505-519",
    "src/access.js:784-824",
  ],
  commandRunner: {
    command:
      "node --test test/properties/connectors.property.test.js test/fuzz/connectors.test.js && node --test test/connectors.test.js test/import-csv.test.js",
  },
  ignorePatterns: [
    ...base.ignorePatterns,
    "!src/connectors.js",
    "!test/connectors.test.js",
    "!test/import-csv.test.js",
    "!test/properties/connectors.property.test.js",
    "!test/fuzz/connectors.test.js",
    "!test/helpers/connector-budget.js",
    "!test/fixtures/**",
    "!src-tauri/connector/examples/fictitious-bank-csv/fixtures/**",
  ],
  jsonReporter: { fileName: "reports/connectors-mutation/mutation.json" },
  htmlReporter: { fileName: "reports/connectors-mutation/mutation.html" },
};
