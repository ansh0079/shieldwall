// Test-only polyfill: Node 18 has no global Web Crypto (browsers and Node 20+ do).
import { webcrypto } from "node:crypto";
globalThis.crypto ??= webcrypto;
