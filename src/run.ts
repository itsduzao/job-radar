import { loadConfig } from "./config.js";

export async function run(): Promise<void> {
  const config = loadConfig();
  console.log(
    `[job-radar] run starting with ${config.queries.length} source query/queries`,
  );
}
