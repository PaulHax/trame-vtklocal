#!/usr/bin/env node
// Wrapper around scripts/gen_translation_schema.py.
//
// The static lookup tables that drive vtkjs_translator live in Python, so this
// script shells out to a Python helper that imports the module and emits a JS
// module with mirrored constants. Pass --check to verify the generated file
// matches the current Python source (used as a CI guard).

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const pyScript = path.join(__dirname, "gen_translation_schema.py");
const outPath = path.join(
  __dirname,
  "..",
  "src",
  "components",
  "generated",
  "translationSchema.js",
);

const args = process.argv.slice(2);
const check = args.includes("--check");

function findPython() {
  const candidates = [
    process.env.PYTHON,
    path.join(repoRoot, ".venv", "bin", "python"),
    "python3",
    "python",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // continue
    }
  }
  throw new Error(
    "No Python interpreter found. Set PYTHON=/path/to/python and retry.",
  );
}

const python = findPython();
const pyArgs = [pyScript, "--out", outPath];
if (check) {
  pyArgs.push("--check");
}

try {
  execFileSync(python, pyArgs, { stdio: "inherit" });
} catch (err) {
  process.exit(err.status ?? 1);
}
