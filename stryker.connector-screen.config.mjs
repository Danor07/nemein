import base from "./stryker.export.config.mjs";

// The owner's connectors screen: its routes and body limit in the local
// server, the platform notice, and the page script that uploads files.
// The view itself is a template, checked through the HTTP tests. Cheapest
// tests first.
export default {
  ...base,
  // HTTP tests open a budget and a server per test.
  timeoutMS: 20000,
  mutate: [
    "public/connectors.js",
    "src/server.js:12-12",
    "src/server.js:46-49",
    "src/server.js:132-150",
    "src/server.js:183-183",
    "src/server.js:402-442",
  ],
  commandRunner: {
    command:
      "node --test test/connectors-ui.test.js && node --test test/connectors-http.test.js",
  },
  ignorePatterns: [
    "**",
    "!src/**",
    "!views/**",
    "!public/**",
    "!test/connectors-ui.test.js",
    "!test/connectors-http.test.js",
    "!test/helpers/connector-budget.js",
    "!src-tauri/connector/examples/fictitious-bank-csv/fixtures/**",
    "!package.json",
  ],
  jsonReporter: { fileName: "reports/connector-screen-mutation/mutation.json" },
  htmlReporter: { fileName: "reports/connector-screen-mutation/mutation.html" },
};
