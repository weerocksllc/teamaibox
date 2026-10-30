const MAXIMUM_FRAME_BYTES = 65_536;

export function extractControllerJsonLine(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.byteLength > MAXIMUM_FRAME_BYTES) {
    throw new TypeError("controller frame is invalid");
  }
  const newline = buffer.indexOf(10);
  if (newline < 0) return null;
  const frame = Buffer.from(buffer.subarray(0, newline));
  const remainder = Buffer.from(buffer.subarray(newline + 1));
  buffer.fill(0);
  return Object.freeze({ frame, remainder });
}

