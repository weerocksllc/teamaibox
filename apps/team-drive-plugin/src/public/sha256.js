const K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);

const rotate = (value, count) => (value >>> count) | (value << (32 - count));

export class Sha256 {
  #state = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  #words = new Uint32Array(64);
  #buffer = new Uint8Array(64);
  #bufferLength = 0;
  #bytes = 0n;
  #finished = false;

  update(input) {
    if (this.#finished) throw new TypeError("SHA-256 digest is already finalized");
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    this.#bytes += BigInt(bytes.byteLength);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const length = Math.min(64 - this.#bufferLength, bytes.byteLength - offset);
      this.#buffer.set(bytes.subarray(offset, offset + length), this.#bufferLength);
      this.#bufferLength += length; offset += length;
      if (this.#bufferLength === 64) { this.#transform(this.#buffer); this.#bufferLength = 0; }
    }
    return this;
  }

  #transform(block) {
    const words = this.#words, view = new DataView(block.buffer, block.byteOffset, 64);
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const a = words[index - 15], b = words[index - 2];
      const s0 = rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3);
      const s1 = rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = this.#state;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const first = (h + s1 + choice + K[index] + words[index]) >>> 0;
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (s0 + majority) >>> 0;
      h=g;g=f;f=e;e=(d+first)>>>0;d=c;c=b;b=a;a=(first+second)>>>0;
    }
    this.#state[0]=(this.#state[0]+a)>>>0;this.#state[1]=(this.#state[1]+b)>>>0;
    this.#state[2]=(this.#state[2]+c)>>>0;this.#state[3]=(this.#state[3]+d)>>>0;
    this.#state[4]=(this.#state[4]+e)>>>0;this.#state[5]=(this.#state[5]+f)>>>0;
    this.#state[6]=(this.#state[6]+g)>>>0;this.#state[7]=(this.#state[7]+h)>>>0;
  }

  digestHex() {
    if (this.#finished) throw new TypeError("SHA-256 digest is already finalized");
    this.#finished = true;
    this.#buffer[this.#bufferLength] = 0x80;
    this.#bufferLength += 1;
    if (this.#bufferLength > 56) {
      this.#buffer.fill(0, this.#bufferLength); this.#transform(this.#buffer); this.#bufferLength = 0;
    }
    this.#buffer.fill(0, this.#bufferLength, 56);
    const bits = this.#bytes * 8n, view = new DataView(this.#buffer.buffer);
    view.setUint32(56, Number((bits >> 32n) & 0xffffffffn), false);
    view.setUint32(60, Number(bits & 0xffffffffn), false);
    this.#transform(this.#buffer);
    return [...this.#state].map((value) => value.toString(16).padStart(8, "0")).join("");
  }
}

export async function sha256Blob(blob, { chunkBytes = 1024 * 1024, onProgress = () => {}, signal = null } = {}) {
  if (!(blob instanceof Blob) || !Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new TypeError("SHA-256 blob input is invalid");
  const digest = new Sha256();
  if (blob.size === 0) onProgress(1);
  for (let offset = 0; offset < blob.size; offset += chunkBytes) {
    if (signal?.aborted) throw new DOMException("Upload cancelled", "AbortError");
    const bytes = new Uint8Array(await blob.slice(offset, Math.min(blob.size, offset + chunkBytes)).arrayBuffer());
    digest.update(bytes); bytes.fill(0); onProgress(Math.min(1, (offset + chunkBytes) / blob.size));
    // Blob reads already yield; extra timers are heavily throttled in background
    // tabs and needlessly stall multi-GiB installation media checks.
  }
  return digest.digestHex();
}
