#!/usr/bin/env node
/**
 * migrate-with-retry.mjs
 *
 * Runs `prisma migrate deploy` with retry logic to handle Render's free-tier
 * Postgres cold-start where the DB isn't ready immediately (P1017).
 */

import { execSync } from "child_process";

const MAX_ATTEMPTS = 5;
const INITIAL_DELAY_MS = 3000; // 3 seconds

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function migrate() {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`[migrate] Attempt ${attempt}/${MAX_ATTEMPTS} — running prisma migrate deploy...`);
      execSync("npx prisma migrate deploy", { stdio: "inherit" });
      console.log("[migrate] ✅ Migration successful!");
      process.exit(0);
    } catch (err) {
      const output = (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? "");
      const isConnectionError =
        output.includes("P1017") ||
        output.includes("Server has closed") ||
        output.includes("ECONNRESET") ||
        output.includes("Connection terminated");

      if (isConnectionError && attempt < MAX_ATTEMPTS) {
        const delay = INITIAL_DELAY_MS * attempt; // 3s, 6s, 9s, 12s...
        console.warn(
          `[migrate] ⚠️  DB connection error (P1017). Retrying in ${delay / 1000}s...`
        );
        await sleep(delay);
      } else {
        console.error(
          `[migrate] ❌ Migration failed after ${attempt} attempt(s). Giving up.`
        );
        process.exit(1);
      }
    }
  }
}

migrate();
