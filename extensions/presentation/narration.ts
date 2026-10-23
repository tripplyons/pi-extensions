import { Buffer } from "node:buffer";

// Signature envelopes are protobuf messages. Read field boundaries rather than
// searching opaque signature bytes for words that might occur by chance.
function fields(bytes: Buffer): Map<number, number | Buffer | undefined> {
  let offset = 0;
  const result = new Map<number, number | Buffer | undefined>();
  const varint = () => {
    let value = 0;
    for (let shift = 0; shift < 53 && offset < bytes.length; shift += 7) {
      const byte = bytes[offset++];
      value += (byte & 127) * 2 ** shift;
      if (!Number.isSafeInteger(value)) throw new Error("Oversized signature field");
      if (!(byte & 128)) return value;
    }
    throw new Error("Incomplete signature field");
  };
  while (offset < bytes.length) {
    const tag = varint();
    const number = Math.floor(tag / 8);
    const wire = tag % 8;
    if (!number || number > 0x1fffffff || result.has(number)) throw new Error("Invalid signature field");
    let value: number | Buffer | undefined;
    if (wire === 0) value = varint();
    else if (wire === 2) {
      const length = varint();
      if (length > bytes.length - offset) throw new Error("Truncated signature field");
      value = bytes.subarray(offset, offset + length);
      offset += length;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > bytes.length) throw new Error("Truncated signature field");
    } else throw new Error("Unsupported signature field");
    result.set(number, value);
  }
  return result;
}

export function isNarrationSignature(signature: string | undefined): boolean {
  if (!signature || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return false;
  try {
    const decoded = Buffer.from(signature, "base64");
    const canonical = decoded.toString("base64");
    if (signature !== canonical && signature !== canonical.replace(/=+$/, "")) return false;
    const envelope = fields(decoded);
    // Only the observed format-4 envelope is supported. Its body contains a
    // metadata message whose field 8 explicitly labels thinking or narration.
    if (envelope.get(1) !== 4) return false;
    const body = envelope.get(2);
    if (!Buffer.isBuffer(body)) return false;
    const metadata = fields(body).get(1);
    if (!Buffer.isBuffer(metadata)) return false;
    const kind = fields(metadata).get(8);
    return Buffer.isBuffer(kind) && kind.equals(Buffer.from("narration"));
  } catch { return false; }
}
