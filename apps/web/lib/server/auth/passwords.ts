/**
 * Password hashing: scrypt from node:crypto, stored as `scrypt$N$r$p$<salt>$<hash>` (base64url) so the
 * cost can rise later without breaking stored hashes. Hashing runs on libuv's thread pool, off the
 * event loop; only the boot-time admin bootstrap uses the synchronous form.
 */
import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";

const COST = { N: 2 ** 15, r: 8, p: 1 } as const;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
/** 128 · N · r bytes is needed; Node's default limit (32 MiB) is just below it at N = 2^15, r = 8. */
const MAX_MEM = 64 * 1024 * 1024;

type Cost = { N: number; r: number; p: number };

function derive(password: string, salt: Buffer, cost: Cost, keyBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, keyBytes, { ...cost, maxmem: MAX_MEM }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

function encode(cost: Cost, salt: Buffer, key: Buffer): string {
  return `scrypt$${cost.N}$${cost.r}$${cost.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  return encode(COST, salt, await derive(password, salt, COST, KEY_BYTES));
}

/** Boot only (the env admin): blocks the event loop for one hash. */
export function hashPasswordSync(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  return encode(COST, salt, scryptSync(password.normalize("NFKC"), salt, KEY_BYTES, { ...COST, maxmem: MAX_MEM }));
}

const STORED = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

/** False for a wrong password and for a stored value that is not a hash this module wrote. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const match = STORED.exec(stored);
  if (match === null) return false;
  const [, n, r, p, salt, hash] = match;
  const expected = Buffer.from(hash ?? "", "base64url");
  if (expected.length === 0) return false;
  const key = await derive(password, Buffer.from(salt ?? "", "base64url"), { N: Number(n), r: Number(r), p: Number(p) }, expected.length);
  return timingSafeEqual(key, expected);
}

let dummy: string | undefined;

/**
 * A hash of a random password, verified against when the username does not exist, so a sign-in for an
 * unknown account takes as long as one with a wrong password and does not reveal which usernames exist.
 */
export async function dummyPasswordHash(): Promise<string> {
  dummy ??= await hashPassword(randomBytes(16).toString("hex"));
  return dummy;
}
