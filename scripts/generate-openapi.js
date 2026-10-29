import { readFileSync, writeFileSync } from "node:fs";
import { generateOpenApi } from "../src/openapi.js";

const file = new URL("../docs/openapi.v1.json", import.meta.url);
const text = JSON.stringify(generateOpenApi(), null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(file, "utf8") !== text)
    throw Error("OpenAPI is stale. Run npm run openapi:generate.");
} else writeFileSync(file, text);
