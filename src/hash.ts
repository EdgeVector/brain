// Lowercase-hex SHA-256. The app SDK no longer exports this helper.
import { createHash } from "node:crypto";

export function sha256Hex(bytes: Uint8Array | string): string {
  const hash = createHash("sha256");
  hash.update(bytes);
  return hash.digest("hex");
}
