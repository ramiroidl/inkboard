import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const KEY_FILE = "secret.key";
const PREFIX = "v1:";

/**
 * Encrypts secrets at rest (AES-256-GCM). The key comes from `INKBOARD_SECRET_KEY` (32 bytes
 * as hex or base64) or is generated once into the data folder, outside the database, so a
 * copied database alone does not reveal tokens.
 */
export class SecretBox {
  private constructor(private readonly key: Buffer) {}

  public static async create(dataDirectory: string, configuredKey?: string): Promise<SecretBox> {
    if (configuredKey !== undefined && configuredKey.trim() !== "") {
      return new SecretBox(SecretBox.parseKey(configuredKey.trim()));
    }
    const keyPath = join(dataDirectory, KEY_FILE);
    try {
      return new SecretBox(SecretBox.parseKey((await readFile(keyPath, "utf8")).trim()));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const key = randomBytes(32);
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(keyPath, `${key.toString("hex")}\n`, { mode: 0o600, flag: "wx" });
    return new SecretBox(key);
  }

  private static parseKey(value: string): Buffer {
    const key = /^[0-9a-f]{64}$/i.test(value)
      ? Buffer.from(value, "hex")
      : Buffer.from(value, "base64");
    if (key.length !== 32) {
      throw new Error("The secret key must be 32 bytes, encoded as hex or base64");
    }
    return key;
  }

  public encrypt(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
  }

  /** Returns null when the value cannot be decrypted, for example after a key change. */
  public decrypt<T>(value: string): T | null {
    if (!value.startsWith(PREFIX)) {
      return null;
    }
    try {
      const data = Buffer.from(value.slice(PREFIX.length), "base64");
      const decipher = createDecipheriv("aes-256-gcm", this.key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      const plaintext = Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
      return JSON.parse(plaintext.toString("utf8")) as T;
    } catch {
      return null;
    }
  }
}
