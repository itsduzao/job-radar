import { run } from "./run.js";
import { StubSource } from "./source.js";

try {
  process.loadEnvFile?.(".env");
} catch {
  // no .env file; secrets come from the environment (e.g. GitHub Actions)
}

run([new StubSource()]).catch((err) => {
  console.error("[job-radar] run failed:", err);
  process.exitCode = 1;
});
