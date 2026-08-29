// Minimal RFC 6455 server-side WebSocket over a raw socket (text frames, close, ping/pong).
// Enough to emulate the JSON Ledger API's streaming endpoints in tests; no dependency.
import { EventEmitter } from "node:events";
import crypto from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function acceptKey(key) {
  return crypto.createHash("sha1").update(key + GUID).digest("base64");
}

export function encodeFrame(op, payload) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | op; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | op; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}

/** Wrap an upgraded socket. Emits "message" (string) and "close". */
export function wrapSocket(socket, head) {
  const ee = new EventEmitter();
  let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  let closed = false;
  const write = (b) => { if (!socket.destroyed) socket.write(b); };
  const ws = {
    get closed() { return closed; },
    on: ee.on.bind(ee),
    send(obj) { if (closed) return; write(encodeFrame(1, Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj)))); },
    close(code = 1000, reason = "") {
      if (closed) return; closed = true;
      const p = Buffer.alloc(2 + Buffer.byteLength(reason)); p.writeUInt16BE(code, 0); p.write(reason, 2);
      write(encodeFrame(8, p)); socket.end();
    },
  };
  socket.on("data", (d) => { buf = Buffer.concat([buf, d]); parse(); });
  socket.on("close", () => { closed = true; ee.emit("close"); });
  socket.on("error", () => {});
  function parse() {
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      const mask = masked ? buf.subarray(off, off + 4) : null;
      const payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buf = buf.subarray(off + maskLen + len);
      if (op === 1) ee.emit("message", payload.toString());
      else if (op === 8) { if (!closed) { closed = true; write(encodeFrame(8, payload.subarray(0, 2))); socket.end(); } }
      else if (op === 9) write(encodeFrame(10, payload));
    }
  }
  return ws;
}
