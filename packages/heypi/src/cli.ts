#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "./cli-run.js";

const templatesDir = resolve(dirname(fileURLToPath(import.meta.url)), "templates");
process.exitCode = await runCli(process.argv.slice(2), { templatesDir });
