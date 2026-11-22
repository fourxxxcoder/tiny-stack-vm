// Tiny stack VM: a faithful interpreter of make.fun's tiny stack ISA v1.
// Each program is decoded once into op/arg arrays, then run by a tight dispatch loop.
// Exact 32-bit wrap arithmetic (Math.imul, unsigned DIVU/MODU/LTU), every trap with its
// own exit code (2-11), the 1,000,000-step and 65,536-byte output limits included.
// Deterministic: no clock, no randomness; one run answers all 40 instances of a set.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Op ids, in byte order: HALT PUSH8 PUSH32 POP DUP SWAP OVER ROT ADD SUB MUL DIV MOD DIVU MODU
// NEG AND OR XOR NOT SHL SHR SHRU EQ LT LTU JMP JZ JNZ CALL RET LOAD STORE PRINT PUTC IN EXIT.
const IL = [0, 1, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0];
const PO = [0, 0, 0, 1, 1, 2, 2, 3, 2, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 0, 1, 1, 0, 0, 1, 2, 1, 1, 0, 1];
const PU = [0, 1, 1, 0, 2, 2, 3, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0];

// Opcode byte -> op id, or -1 for an unknown opcode.
const bid = (b: number): number =>
  b < 8 ? b : b < 0x10 ? -1 : b < 0x1f ? b - 8 : b < 0x20 ? -1 : b < 0x23 ? b - 9 :
  b < 0x30 ? -1 : b < 0x35 ? b - 22 : b < 0x40 ? -1 : b < 0x42 ? b - 33 :
  b < 0x50 ? -1 : b < 0x54 ? b - 47 : -1;

function run(p: Uint8Array, inp: Uint8Array): { out: Uint8Array; code: number } {
  const n = p.length;
  const op = new Int8Array(n); // -1 unknown opcode, -2 immediate cut off by the program's end
  const ag = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const id = bid(p[i]);
    if (id < 0) { op[i] = -1; continue; }
    const L = IL[id];
    if (i + L >= n) { op[i] = -2; continue; }
    op[i] = id;
    if (id === 1) ag[i] = (p[i + 1] << 24) >> 24;
    else if (id === 2) ag[i] = p[i + 1] | (p[i + 2] << 8) | (p[i + 3] << 16) | (p[i + 4] << 24);
    else if (id >= 26 && id <= 28) ag[i] = ((p[i + 1] | (p[i + 2] << 8)) << 16) >> 16;
    else if (id === 29) ag[i] = p[i + 1] | (p[i + 2] << 8);
  }
  const D = new Int32Array(256);
  const C = new Int32Array(64);
  const M = new Int32Array(256);
  const out = new Uint8Array(65536);
  let pc = 0, sp = 0, csp = 0, ip = 0, steps = 0, ol = 0;
  const end = (code: number) => ({ out: out.subarray(0, ol), code });
  for (;;) {
    if (steps === 1e6) return end(10);
    if (pc < 0 || pc >= n) return end(9);
    const o = op[pc];
    if (o < 0) return end(o === -1 ? 5 : 9);
    const a = ag[pc];
    steps++;
    const nx = pc + 1 + IL[o];
    if (sp < PO[o]) return end(2);
    if (sp - PO[o] + PU[o] > 256) return end(3);
    pc = nx;
    switch (o) {
      case 0: return end(0);
      case 1: case 2: D[sp++] = a; break;
      case 3: sp--; break;
      case 4: D[sp] = D[sp - 1]; sp++; break;
      case 5: { const t = D[sp - 1]; D[sp - 1] = D[sp - 2]; D[sp - 2] = t; break; }
      case 6: D[sp] = D[sp - 2]; sp++; break;
      case 7: { const t = D[sp - 3]; D[sp - 3] = D[sp - 2]; D[sp - 2] = D[sp - 1]; D[sp - 1] = t; break; }
      case 8: case 9: case 10: case 11: case 12: case 13: case 14:
      case 16: case 17: case 18: case 20: case 21: case 22: case 23: case 24: case 25: {
        const b = D[sp - 1], x = D[sp - 2];
        let r = 0;
        if (o === 8) r = (x + b) | 0;
        else if (o === 9) r = (x - b) | 0;
        else if (o === 10) r = Math.imul(x, b);
        else if (o === 11) { if (b === 0) return end(4); r = (x / b) | 0; }
        else if (o === 12) { if (b === 0) return end(4); r = (x % b) | 0; }
        else if (o === 13) { if (b === 0) return end(4); r = Math.floor((x >>> 0) / (b >>> 0)) | 0; }
        else if (o === 14) { if (b === 0) return end(4); r = ((x >>> 0) % (b >>> 0)) | 0; }
        else if (o === 16) r = x & b;
        else if (o === 17) r = x | b;
        else if (o === 18) r = x ^ b;
        else if (o === 20) r = x << (b & 31);
        else if (o === 21) r = x >> (b & 31);
        else if (o === 22) r = (x >>> (b & 31)) | 0;
        else if (o === 23) r = x === b ? 1 : 0;
        else if (o === 24) r = x < b ? 1 : 0;
        else r = (x >>> 0) < (b >>> 0) ? 1 : 0;
        sp -= 2; D[sp++] = r;
        break;
      }
      case 15: D[sp - 1] = (-D[sp - 1]) | 0; break;
      case 19: D[sp - 1] = ~D[sp - 1]; break;
      case 26: pc = nx + a; break;
      case 27: if (D[--sp] === 0) pc = nx + a; break;
      case 28: if (D[--sp] !== 0) pc = nx + a; break;
      case 29: if (csp === 64) return end(7); C[csp++] = nx; pc = a; break;
      case 30: if (csp === 0) return end(8); pc = C[--csp]; break;
      case 31: { const ad = D[sp - 1]; if (ad < 0 || ad > 255) return end(6); D[sp - 1] = M[ad]; break; }
      case 32: { const ad = D[sp - 1]; if (ad < 0 || ad > 255) return end(6); sp -= 2; M[ad] = D[sp]; break; }
      case 33: { const s = String(D[sp - 1]); if (ol + s.length > 65536) return end(11); sp--; for (let i = 0; i < s.length; i++) out[ol++] = s.charCodeAt(i); break; }
      case 34: if (ol + 1 > 65536) return end(11); out[ol++] = D[--sp] & 255; break;
      case 35: D[sp++] = ip < inp.length ? inp[ip++] : -1; break;
      case 36: return end(D[--sp] & 255);
    }
  }
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const r = run(readFileSync(join(I, id, 'program.bin')), readFileSync(join(I, id, 'input.bin')));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), r.out);
  writeFileSync(join(O, id, 'exit.txt'), `${r.code}\n`);
}
