#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { oneLineSummary, routeMessage } from "./index.mjs";

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write("Usage: node src/route.mjs --input <file.json> --record <record.json> [--json]\n");
  process.exitCode = 1;
}

function argumentsFrom(argv) {
  const result = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") result.json = true;
    else if (argument === "--input" || argument === "--record") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} needs a file`);
      result[argument.slice(2)] = value;
      index += 1;
    } else throw new Error(`unknown argument ${argument}`);
  }
  if (!result.input) throw new Error("--input is required");
  if (!result.record) throw new Error("--record is required");
  return result;
}

try {
  const options = argumentsFrom(process.argv.slice(2));
  const [inputText, recordText] = await Promise.all([
    readFile(options.input, "utf8"),
    readFile(options.record, "utf8")
  ]);
  const result = routeMessage(JSON.parse(inputText), JSON.parse(recordText));
  process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${oneLineSummary(result)}\n`);
} catch (error) {
  usage(error instanceof Error ? error.message : String(error));
}
