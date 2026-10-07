import { run } from "./run.js";

try {
  process.loadEnvFile?.(".env");
} catch {
  // no .env file; secrets come from the environment (e.g. GitHub Actions)
}

run().catch((err) => {
  console.error("[job-radar] run failed:", err);
  process.exitCode = 1;
});
