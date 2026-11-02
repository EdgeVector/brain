#!/usr/bin/env bun
// Export the app's actual canonical owned definitions for the source runner.
// This reads source definitions only. It never contacts a node or declares schemas.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalSchema } from "../src/canonical-vocabulary.ts";
import { ownedSchemas } from "../src/multi-key.ts";

const path = fileURLToPath(new URL("../lastdb-app.json", import.meta.url));
const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const manifest = JSON.parse(readFileSync(path, "utf8"));
const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
manifest.version = pkg.version;
manifest.schemas = ownedSchemas().map(({ schema }) => canonicalSchema(schema));
writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Updated Brain source manifest with ${manifest.schemas.length} canonical owned schemas.`);
