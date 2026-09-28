/**
 * botService.js
 *
 * Automatically submits votes for bot players based on their role + phase.
 * Called from the heartbeat once per phase, shortly after each phase starts.
 *
 * Bot strategy (simple random AI):
 *   NIGHT phase:
 *     - MAFIA       → MAFIA_TARGET  (random alive non-mafia player)
 *     - DOCTOR      → DOC_SAVE      (random alive player, preferably self)
 *     - NURSE       → NURSE_ACTION  (random alive non-nurse player)
 *     - HITMAN      → HITMAN_TARGET (2 random targets + random role guesses)
 *     - BOUNTY_HUNTER → BOUNTY_HUNTER_SHOT (if VIP dead, random mafia target)
 *     - REPORTER    → skip (ability is rare/strategic, bots skip it)
 *   VOTING phase:
 *     - All alive bots → DAY_LYNCH  (random alive non-self player)
 */

import prisma from "../../config/prisma.js";

// Track which (roomCode, round, phase) combos bots have already acted in
// to avoid submitting duplicate votes across heartbeat ticks.
const botActedCache = new Set();

function cacheKey(roomCode, round, phase) {
  return `${roomCode}:${round}:${phase}`;
}

function pickRandom(arr) {
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function getMeta(room) {
  if (!room?.state_meta) return {};
  if (typeof room.state_meta === "string") {
    try { return JSON.parse(room.state_meta); } catch { return {}; }
  }
  return room.state_meta;
}

/**
 * Main entry point. Called each heartbeat tick.
 * Only acts once per (room, round, phase) combination.
 */
export async function runBotActions() {
  // Only query rooms that have bots (dev_mode rooms)
  const activeRooms = await prisma.gameRoom.findMany({
    where: {
      status: { in: ["NIGHT", "VOTING"] },
      phase_ends_at: { not: null },
    },
    select: {
      room_code: true,
      status: true,
      round: true,
      state_meta: true,
      phase_ends_at: true,
    },
  });

  for (const room of activeRooms) {
    const meta = getMeta(room);
    if (!meta.dev_mode || !Array.isArray(meta.bots) || meta.bots.length === 0) continue;

    const key = cacheKey(room.room_code, room.round, room.status);
    if (botActedCache.has(key)) continue;

    // Only act after phase has been running for at least 2s (let game state settle)
    const timeLeftMs = new Date(room.phase_ends_at) - Date.now();
    const phaseDurationGuess = room.status === "NIGHT" ? 30000 : 10000;
    const timeElapsedMs = phaseDurationGuess - timeLeftMs;
    if (timeElapsedMs < 2000) continue;

    // Mark as acted immediately to prevent duplicate submissions
    botActedCache.add(key);

    try {
      await actBotsInRoom(room, meta);
    } catch (e) {
      console.error(`[bots] Error acting in room ${room.room_code}:`, e.message);
      // Remove from cache so it can retry
      botActedCache.delete(key);
    }
  }

  // Clean up old cache entries to prevent unbounded memory growth
  if (botActedCache.size > 500) {
    const entries = [...botActedCache];
    entries.slice(0, 200).forEach((k) => botActedCache.delete(k));
  }
}

async function actBotsInRoom(room, meta) {
  const { room_code, round, status } = room;

  // Fetch all alive players in the room
  const alivePlayers = await prisma.gamePlayer.findMany({
    where: { room_code, status: "ALIVE" },
    select: { id: true, user_id: true, role: true, isBot: true },
  });

  const aliveBots = alivePlayers.filter((p) => p.isBot);
  if (aliveBots.length === 0) return;

  if (status === "NIGHT") {
    await actBotsNight(room_code, round, aliveBots, alivePlayers, meta);
  } else if (status === "VOTING") {
    await actBotsVoting(room_code, round, aliveBots, alivePlayers);
  }
}

// ─── NIGHT PHASE BOT ACTIONS ──────────────────────────────────────────────────

async function actBotsNight(roomCode, round, aliveBots, alivePlayers, meta) {
  const aliveNonBotIds = alivePlayers.filter((p) => !p.isBot).map((p) => p.id);
  const allAliveIds = alivePlayers.map((p) => p.id);

  for (const bot of aliveBots) {
    try {
      await actBotNightRole(bot, roomCode, round, alivePlayers, allAliveIds, aliveNonBotIds, meta);
    } catch (e) {
      // Ignore per-bot errors (e.g. vote already exists), continue others
      if (!e.message?.includes("already")) {
        console.warn(`[bots] Bot ${bot.user_id} (${bot.role}) night action failed:`, e.message);
      }
    }
  }
}

async function actBotNightRole(bot, roomCode, round, alivePlayers, allAliveIds, aliveNonBotIds, meta) {
  const othersIds = allAliveIds.filter((id) => id !== bot.id);

  switch (bot.role) {
    case "MAFIA":
    case "MAFIA_HELPER": {
      // Target a random alive non-mafia player
      const nonMafiaTargets = alivePlayers
        .filter((p) => p.id !== bot.id && p.role !== "MAFIA" && p.role !== "MAFIA_HELPER" && p.role !== "HITMAN")
        .map((p) => p.id);
      const target = pickRandom(nonMafiaTargets.length > 0 ? nonMafiaTargets : othersIds);
      if (!target) break;
      await upsertBotVote(roomCode, round, bot.id, target, "MAFIA_TARGET");
      break;
    }

    case "DOCTOR": {
      // 50% chance save self, 50% save random other
      const saveSelf = Math.random() < 0.5;
      const target = saveSelf ? bot.id : (pickRandom(othersIds) ?? bot.id);
      await upsertBotVote(roomCode, round, bot.id, target, "DOC_SAVE");
      break;
    }

    case "NURSE": {
      // Pick a random alive non-self player to investigate
      const target = pickRandom(othersIds);
      if (!target) break;
      await upsertBotVote(roomCode, round, bot.id, target, "NURSE_ACTION");
      break;
    }

    case "HITMAN": {
      // Pick 2 random distinct targets and guess random roles for them
      if (othersIds.length < 2) break;
      const shuffled = [...othersIds].sort(() => Math.random() - 0.5);
      const [t1, t2] = shuffled;

      // Look up user_ids for the targets (voteService expects user_ids in target_meta)
      const t1Player = alivePlayers.find((p) => p.id === t1);
      const t2Player = alivePlayers.find((p) => p.id === t2);
      if (!t1Player || !t2Player) break;

      const guessableRoles = ["CITIZEN", "DOCTOR", "NURSE", "BOUNTY_HUNTER", "REPORTER", "MAFIA"];
      const role1 = pickRandom(guessableRoles);
      const role2 = pickRandom(guessableRoles.filter((r) => r !== role1));

      await upsertBotVote(roomCode, round, bot.id, null, "HITMAN_TARGET", {
        targets: [t1Player.user_id, t2Player.user_id],
        roles: [role1, role2],
      });
      break;
    }

    case "BOUNTY_HUNTER": {
      // If VIP is dead and kill is unlocked, shoot a random mafia player
      if (meta.bounty_kill_unlocked) {
        const mafiaTargets = alivePlayers
          .filter((p) => p.role === "MAFIA" || p.role === "MAFIA_HELPER")
          .map((p) => p.id);
        const target = pickRandom(mafiaTargets.length > 0 ? mafiaTargets : othersIds);
        if (target) {
          await upsertBotVote(roomCode, round, bot.id, target, "BOUNTY_HUNTER_SHOT");
        }
      }
      // If VIP not set yet and bot is bounty hunter, set a random VIP
      // (VIP setting is optional for bots, skip for simplicity)
      break;
    }

    case "COP":
    case "PROPHET":
    case "CITIZEN":
    default:
      // These roles have no night action or are passive
      break;
  }
}

// ─── VOTING PHASE BOT ACTIONS ─────────────────────────────────────────────────

async function actBotsVoting(roomCode, round, aliveBots, alivePlayers) {
  const allAliveIds = alivePlayers.map((p) => p.id);

  for (const bot of aliveBots) {
    try {
      // Vote for a random alive player (not self)
      const targets = allAliveIds.filter((id) => id !== bot.id);
      const target = pickRandom(targets);
      if (!target) continue;
      await upsertBotVote(roomCode, round, bot.id, target, "DAY_LYNCH");
    } catch (e) {
      if (!e.message?.includes("already")) {
        console.warn(`[bots] Bot ${bot.user_id} voting failed:`, e.message);
      }
    }
  }
}

// ─── HELPER: direct DB upsert (bypasses submitVote to avoid bot voter checks) ─

async function upsertBotVote(roomCode, round, voterId, targetId, voteType, targetMeta = null) {
  const existing = await prisma.gameVote.findFirst({
    where: { room_code: roomCode, round, voter_id: voterId, vote_type: voteType },
    select: { id: true },
  });

  if (existing) {
    await prisma.gameVote.update({
      where: { id: existing.id },
      data: { target_id: targetId, target_meta: targetMeta },
    });
  } else {
    await prisma.gameVote.create({
      data: {
        room_code: roomCode,
        round,
        voter_id: voterId,
        target_id: targetId,
        vote_type: voteType,
        target_meta: targetMeta,
      },
    });
  }

  console.log(`[bots] 🤖 ${voteType} submitted for voter=${voterId} target=${targetId ?? "meta"} room=${roomCode} round=${round}`);
}
