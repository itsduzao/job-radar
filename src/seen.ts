import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface SeenStore {
  load(): Promise<Set<string>>;
  save(ids: Set<string>): Promise<void>;
}

export class FileSeenStore implements SeenStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<Set<string>> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return new Set();
      }
      throw err;
    }
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  }

  async save(ids: Set<string>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify([...ids].sort(), null, 2)}\n`);
  }
}
