// Lowercase-hex SHA-256, matching the Rust `app_identity_crypto` helpers
// (`compute_payload_hash` = lowercase-hex sha256 of the JCS bytes).

/** Lowercase hex SHA-256 of a UTF-8 string. */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHexLower(new Uint8Array(digest));
}

function toHexLower(bytes: Uint8Array): string {
  const hex = "0123456789abcdef";
  let out = "";
  for (const b of bytes) {
    out += hex[(b >> 4) & 0x0f]! + hex[b & 0x0f]!;
  }
  return out;
}
