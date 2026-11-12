
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";

function normalizeName(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

export class WatchlistService {
  private readonly filePath =
    process.env.WATCHLIST_PATH ||
    path.join("/tmp", "solana-ca-hunter", "watchlist.json");

  private names: string[] = [];

  async load(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(content);

      if (!Array.isArray(parsed)) {
        throw new Error("Invalid watchlist file format");
      }

      this.names = [
        ...new Set(
          parsed.filter(
            (item): item is string =>
              typeof item === "string" && item.trim().length > 0,
          ),
        ),
      ];
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        this.names = [];
        await this.save();
        return;
      }

      throw error;
    }
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });

    const temporaryPath = `${this.filePath}.tmp`;

    await writeFile(
      temporaryPath,
      JSON.stringify(this.names, null, 2),
      "utf8",
    );

    await rename(temporaryPath, this.filePath);
  }

  getNames(): string[] {
    return [...this.names];
  }

  async add(name: string): Promise<boolean> {
    const cleanName = name.trim();

    if (!cleanName) return false;

    const normalized = normalizeName(cleanName);

    if (this.names.some((item) => normalizeName(item) === normalized)) {
      return false;
    }

    this.names.push(cleanName);
    await this.save();
    return true;
  }

  async remove(name: string): Promise<boolean> {
    const normalized = normalizeName(name);

    const index = this.names.findIndex(
      (item) => normalizeName(item) === normalized,
    );

    if (index === -1) return false;

    this.names.splice(index, 1);
    await this.save();
    return true;
  }

  matches(tokenName: string | undefined): boolean {
    if (!tokenName) return false;

    const token = normalizeName(tokenName);

    return this.names.some((name) =>
      token.includes(normalizeName(name)),
    );
  }
}
