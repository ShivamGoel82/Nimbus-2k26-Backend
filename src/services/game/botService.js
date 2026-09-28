/**
 * botService.js
 *
 * Automatically submits votes and drives strategic AI discussions for bot players.
 * Called from the heartbeat once per second.
 *
 * Features:
 *   NIGHT phase:
 *     - MAFIA / HITMAN → MAFIA_TARGET (alive non-mafia target)
 *     - DOCTOR         → DOC_SAVE     (alive player, 50% self)
 *     - NURSE          → NURSE_ACTION (random non-nurse player)
 *     - HITMAN         → HITMAN_TARGET (2 random targets + role guesses)
 *     - BOUNTY_HUNTER  → BOUNTY_HUNTER_SHOT (if VIP dead, random mafia target)
 *
 *   DISCUSSION phase:
 *     - Bots discuss suspicions in chat like real players.
 *     - Citizen bots accuse suspects and build town consensus.
 *     - Mafia bots act innocent, confuse the town, and deflect blame to citizens without revealing their role.
 *     - Once town reaches consensus (~8-10s), bots announce the decision and reduce discussion time so game moves to voting fast!
 *
 *   VOTING phase:
 *     - Citizen bots vote for the consensus suspect agreed upon during discussion.
 *     - Mafia bots vote to protect teammates or blend into the crowd.
 *
 *   INTERACTIVE CHAT:
 *     - Bots reply dynamically when real players talk, ask questions, or accuse them in global chat.
 */

import prisma from "../../config/prisma.js";

// Track which actions bots have already executed to prevent duplicates
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
    try {
      return JSON.parse(room.state_meta);
    } catch {
      return {};
    }
  }
  return room.state_meta;
}

/**
 * Main entry point. Called each heartbeat tick.
 */
export async function runBotActions() {
  const activeRooms = await prisma.gameRoom.findMany({
    where: {
      status: { in: ["NIGHT", "DISCUSSION", "VOTING"] },
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
    if (!Array.isArray(meta.bots) || meta.bots.length === 0) continue;

    if (room.status === "NIGHT" || room.status === "VOTING") {
      const key = cacheKey(room.room_code, room.round, room.status);
      if (botActedCache.has(key)) continue;

      const timeLeftMs = new Date(room.phase_ends_at) - Date.now();
      const phaseDurationGuess = room.status === "NIGHT" ? 30000 : 10000;
      const timeElapsedMs = phaseDurationGuess - timeLeftMs;
      if (timeElapsedMs < 2000) continue;

      botActedCache.add(key);

      try {
        await actBotsInRoom(room, meta);
      } catch (e) {
        console.error(`[bots] Error acting in room ${room.room_code}:`, e.message);
        botActedCache.delete(key);
      }
    } else if (room.status === "DISCUSSION") {
      try {
        await actBotsDiscussion(room, meta);
      } catch (e) {
        console.error(`[bots] Error in discussion in room ${room.room_code}:`, e.message);
      }
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

  const alivePlayers = await prisma.gamePlayer.findMany({
    where: { room_code, status: "ALIVE" },
    select: {
      id: true,
      user_id: true,
      role: true,
      isBot: true,
      user: { select: { full_name: true } },
    },
  });

  const aliveBots = alivePlayers.filter((p) => p.isBot);
  if (aliveBots.length === 0) return;

  if (status === "NIGHT") {
    await actBotsNight(room_code, round, aliveBots, alivePlayers, meta);
  } else if (status === "VOTING") {
    await actBotsVoting(room_code, round, aliveBots, alivePlayers, meta);
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
      const nonMafiaTargets = alivePlayers
        .filter((p) => p.id !== bot.id && p.role !== "MAFIA" && p.role !== "MAFIA_HELPER" && p.role !== "HITMAN")
        .map((p) => p.id);
      const target = pickRandom(nonMafiaTargets.length > 0 ? nonMafiaTargets : othersIds);
      if (!target) break;
      await upsertBotVote(roomCode, round, bot.id, target, "MAFIA_TARGET");
      break;
    }

    case "DOCTOR": {
      const saveSelf = Math.random() < 0.5;
      const target = saveSelf ? bot.id : (pickRandom(othersIds) ?? bot.id);
      await upsertBotVote(roomCode, round, bot.id, target, "DOC_SAVE");
      break;
    }

    case "NURSE": {
      const target = pickRandom(othersIds);
      if (!target) break;
      await upsertBotVote(roomCode, round, bot.id, target, "NURSE_ACTION");
      break;
    }

    case "HITMAN": {
      if (othersIds.length < 2) break;
      const shuffled = [...othersIds].sort(() => Math.random() - 0.5);
      const [t1, t2] = shuffled;

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
      if (meta.bounty_kill_unlocked) {
        const mafiaTargets = alivePlayers
          .filter((p) => p.role === "MAFIA" || p.role === "MAFIA_HELPER")
          .map((p) => p.id);
        const target = pickRandom(mafiaTargets.length > 0 ? mafiaTargets : othersIds);
        if (target) {
          await upsertBotVote(roomCode, round, bot.id, target, "BOUNTY_HUNTER_SHOT");
        }
      }
      break;
    }

    case "COP":
    case "PROPHET":
    case "CITIZEN":
    default:
      break;
  }
}

// ─── DISCUSSION PHASE: STRATEGIC CHAT & TIME REDUCTION ─────────────────────────

async function actBotsDiscussion(room, meta) {
  const { room_code, round, phase_ends_at } = room;

  const alivePlayers = await prisma.gamePlayer.findMany({
    where: { room_code, status: "ALIVE" },
    select: {
      id: true,
      user_id: true,
      role: true,
      isBot: true,
      user: { select: { full_name: true } },
    },
  });

  const aliveBots = alivePlayers.filter((p) => p.isBot);
  if (aliveBots.length === 0) return;

  const startRaw = meta.discussion_phase_started_at;
  const startTime = startRaw ? new Date(startRaw).getTime() : 0;
  const now = Date.now();
  const discussionStartMs = startTime > 0 ? startTime : new Date(phase_ends_at).getTime() - 120000;
  const elapsedSec = (now - discussionStartMs) / 1000;

  // Don't act in the very first 2 seconds
  if (elapsedSec < 2) return;

  const keyPrefix = `${room_code}:${round}:DISC`;

  // STEP 1: Accusation / initial lead (around 2.5 - 4s)
  if (!meta.bot_disc_step1 && !botActedCache.has(`${keyPrefix}:1`)) {
    botActedCache.add(`${keyPrefix}:1`);

    const speakerBot =
      pickRandom(aliveBots.filter((b) => b.role !== "MAFIA" && b.role !== "HITMAN")) ||
      pickRandom(aliveBots);

    const possibleSuspects = alivePlayers.filter((p) => p.id !== speakerBot.id);
    const suspect = pickRandom(possibleSuspects);
    if (!suspect) return;

    const suspectName = suspect.user?.full_name || "someone";
    const speakerName = speakerBot.user?.full_name || "Bot";

    const accusations = [
      `I've been watching ${suspectName}... they're being way too quiet. Anyone else think they're mafia?`,
      `We need to find the mafia today. What's everyone's read on ${suspectName}?`,
      `I'm getting really suspicious vibes from ${suspectName}. Look at how they voted earlier!`,
      `Let's focus on ${suspectName} this round. Their behavior has been off.`,
      `Town needs to unite. I think ${suspectName} is our best suspect right now.`,
    ];
    const message = pickRandom(accusations);

    const { default: pusher } = await import("../../config/pusher.js");
    await pusher.trigger(`game-${room_code}`, "chat-message", {
      userId: speakerBot.user_id,
      name: speakerName,
      message,
      channel: "global",
      timestamp: new Date().toISOString(),
    });

    await prisma.gameRoom.update({
      where: { room_code },
      data: {
        state_meta: {
          ...meta,
          bot_disc_step1: true,
          bot_suspect_id: suspect.id,
          bot_suspect_name: suspectName,
          bot_accuser_name: speakerName,
        },
      },
    });
    return;
  }

  // STEP 2: Response / Debate (around 5 - 7s)
  if (meta.bot_disc_step1 && !meta.bot_disc_step2 && elapsedSec >= 5 && !botActedCache.has(`${keyPrefix}:2`)) {
    botActedCache.add(`${keyPrefix}:2`);

    const suspectName = meta.bot_suspect_name || "the suspect";
    const accuserName = meta.bot_accuser_name || "town";

    const otherBots = aliveBots.filter((b) => b.user?.full_name !== accuserName);
    const responderBot = pickRandom(otherBots.length > 0 ? otherBots : aliveBots);
    const responderName = responderBot.user?.full_name || "Bot";

    let message;
    if (responderBot.role === "MAFIA" || responderBot.role === "HITMAN") {
      // Mafia bot deflects blame to someone else without admitting to being mafia
      const innocentCandidates = alivePlayers.filter(
        (p) => p.id !== responderBot.id && p.role !== "MAFIA" && p.role !== "HITMAN" && p.id !== meta.bot_suspect_id
      );
      const framedPlayer = pickRandom(innocentCandidates);
      const framedName = framedPlayer ? framedPlayer.user?.full_name : "someone else";

      const mafiaDeflections = [
        `Wait, ${suspectName} might actually be innocent! What about ${framedName}? They've been deflecting all game!`,
        `Don't rush into voting ${suspectName} yet! I think ${framedName} is trying to slip under the radar.`,
        `Are we sure? Don't let ${accuserName} tunnel vision us. ${framedName} looks much more sus!`,
        `I'm not convinced about ${suspectName}. The real mafia is probably ${framedName}!`,
      ];
      message = pickRandom(mafiaDeflections);
    } else {
      // Citizen bot agrees or reinforces suspicion
      const citizenAgreements = [
        `I agree with ${accuserName}! ${suspectName} has been super sus. Let's lynch them!`,
        `Yeah, ${suspectName}'s defense makes no sense. I'm voting them this round.`,
        `Good eye, ${accuserName}. Let's make sure town votes together on ${suspectName}!`,
        `I'm ready to vote ${suspectName}. Citizens must stick together!`,
      ];
      message = pickRandom(citizenAgreements);
    }

    const { default: pusher } = await import("../../config/pusher.js");
    await pusher.trigger(`game-${room_code}`, "chat-message", {
      userId: responderBot.user_id,
      name: responderName,
      message,
      channel: "global",
      timestamp: new Date().toISOString(),
    });

    await prisma.gameRoom.update({
      where: { room_code },
      data: {
        state_meta: {
          ...meta,
          bot_disc_step2: true,
        },
      },
    });
    return;
  }

  // STEP 3: Consensus & REDUCE TIME (around 8 - 10s)
  if (meta.bot_disc_step2 && !meta.bot_disc_step3 && elapsedSec >= 8 && !botActedCache.has(`${keyPrefix}:3`)) {
    botActedCache.add(`${keyPrefix}:3`);

    const suspectName = meta.bot_suspect_name || "our target";
    const suspectId = meta.bot_suspect_id;

    const closerBot = pickRandom(aliveBots);
    const closerName = closerBot.user?.full_name || "Bot";

    const conclusions = [
      `Town has decided: we are voting out ${suspectName}! Speeding up timer ⏩`,
      `We know what to do in the voting round! Let's eliminate ${suspectName}. Skipping to vote ⏩`,
      `Decision made on ${suspectName}! Reducing discussion time to vote now ⏩`,
    ];
    const message = pickRandom(conclusions);

    const { default: pusher } = await import("../../config/pusher.js");
    await pusher.trigger(`game-${room_code}`, "chat-message", {
      userId: closerBot.user_id,
      name: closerName,
      message,
      channel: "global",
      timestamp: new Date().toISOString(),
    });

    // Reduce discussion time so game moves to VOTING in 3.5 seconds
    const newEndsAt = new Date(Date.now() + 3500);

    const votes = {};
    for (const bot of aliveBots) {
      votes[bot.user_id] = -1;
    }

    await prisma.gameRoom.update({
      where: { room_code },
      data: {
        phase_ends_at: newEndsAt,
        state_meta: {
          ...meta,
          bot_disc_step3: true,
          bot_target_id: suspectId,
          discussion_time_votes: votes,
        },
      },
    });

    // Broadcast timer change to frontend
    await pusher.trigger(`game-${room_code}`, "discussion-time-adjusted", {
      phase: "DISCUSSION",
      round,
      phaseEndsAt: newEndsAt.toISOString(),
      deltaSeconds: 1,
      netAdjustment: -aliveBots.length,
      aliveCount: alivePlayers.length,
      increaseVotes: 0,
      decreaseVotes: aliveBots.length,
    });
  }
}

// ─── VOTING PHASE BOT ACTIONS ─────────────────────────────────────────────────

async function actBotsVoting(roomCode, round, aliveBots, alivePlayers, meta) {
  const allAliveIds = alivePlayers.map((p) => p.id);
  const targetSuspectId = meta?.bot_target_id;
  const isTargetAlive = targetSuspectId && alivePlayers.some((p) => p.id === targetSuspectId);

  for (const bot of aliveBots) {
    try {
      let target;

      if (bot.role === "MAFIA" || bot.role === "HITMAN") {
        // Mafia strategy: if the target is a teammate, vote for an innocent citizen to protect them!
        const targetPlayer = alivePlayers.find((p) => p.id === targetSuspectId);
        const isTeammate = targetPlayer && (targetPlayer.role === "MAFIA" || targetPlayer.role === "HITMAN");

        if (isTeammate) {
          const innocentTargets = alivePlayers
            .filter((p) => p.id !== bot.id && p.role !== "MAFIA" && p.role !== "HITMAN")
            .map((p) => p.id);
          target = pickRandom(innocentTargets.length > 0 ? innocentTargets : allAliveIds.filter((id) => id !== bot.id));
        } else if (isTargetAlive) {
          target = targetSuspectId;
        } else {
          const nonSelf = allAliveIds.filter((id) => id !== bot.id);
          target = pickRandom(nonSelf);
        }
      } else {
        // Citizen / Specials vote for consensus target
        if (isTargetAlive && targetSuspectId !== bot.id) {
          target = targetSuspectId;
        } else {
          const targets = allAliveIds.filter((id) => id !== bot.id);
          target = pickRandom(targets);
        }
      }

      if (!target) continue;
      await upsertBotVote(roomCode, round, bot.id, target, "DAY_LYNCH");
    } catch (e) {
      if (!e.message?.includes("already")) {
        console.warn(`[bots] Bot ${bot.user_id} voting failed:`, e.message);
      }
    }
  }
}

// ─── HELPER: direct DB upsert ─────────────────────────────────────────────────

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

// ─── DYNAMIC BOT CHAT SYSTEM ───────────────────────────────────────────────────

const GREETINGS = ["hi", "hello", "hey", "sup", "yo"];
const ACCUSATIONS = ["sus", "mafia", "killer", "vote", "kill", "is bad", "fake", "guilty", "lying", "impostor"];
const QUESTIONS = ["who", "what", "why", "where", "how", "?"];

function generateBotReply(message, botRole, senderName, otherPlayerNames = []) {
  const msg = message.toLowerCase();
  const otherName = otherPlayerNames.length > 0 ? pickRandom(otherPlayerNames) : "someone";

  // If asking who is mafia / who to vote
  if (
    msg.includes("who") &&
    (msg.includes("mafia") || msg.includes("vote") || msg.includes("sus") || msg.includes("kill") || msg.includes("lynch"))
  ) {
    if (botRole === "MAFIA" || botRole === "HITMAN") {
      const mafiaReplies = [
        `I think ${otherName} is definitely mafia. Look at their moves!`,
        `Don't look at me, I suspect ${otherName}! They've been way too quiet.`,
        `We should vote out ${otherName} this round. They're trying to deceive town!`,
      ];
      return pickRandom(mafiaReplies);
    } else {
      const citizenReplies = [
        `I have a really strong suspicion on ${otherName}. Let's vote them out!`,
        `Follow the facts: ${otherName} hasn't defended themselves at all.`,
        `We need to eliminate ${otherName} today to win this for the town!`,
      ];
      return pickRandom(citizenReplies);
    }
  }

  // If accused or voting talk
  if (ACCUSATIONS.some((word) => msg.includes(word))) {
    if (botRole === "MAFIA" || botRole === "HITMAN") {
      const mafiaDefensive = [
        `I'm 100% innocent citizen! You're trying to frame me because you're the real mafia!`,
        `Classic mafia deflection! Don't let ${senderName} trick town!`,
        `I swear on my role I'm on town's side! Why are you targeting me, ${senderName}?`,
        `If you vote me, town loses an innocent. Look at ${otherName} instead!`,
      ];
      return pickRandom(mafiaDefensive);
    } else {
      const citizenDefensive = [
        "I'm innocent, I swear! Don't waste town's vote on me!",
        `Why is ${senderName} looking at me? I'm helping the citizens!`,
        `I think ${senderName} is trying to divert attention from ${otherName}.`,
        "Don't vote me, I'm a simple citizen trying to win!",
        "Are we sure about this? You'll regret voting me out.",
      ];
      return pickRandom(citizenDefensive);
    }
  }

  if (QUESTIONS.some((word) => msg.includes(word))) {
    const answers = [
      `Not sure, but we should keep our eyes on ${otherName}.`,
      "Let's focus on finding the mafia before time runs out.",
      "I was just analyzing the voting patterns.",
      "We need to stick together as town to win this.",
    ];
    return pickRandom(answers);
  }

  if (GREETINGS.some((word) => msg.includes(word))) {
    const greetings = [
      `Hey ${senderName}! Ready to catch some mafia?`,
      "Hello! Let's win this for town.",
      `Sup ${senderName}. Who are you suspecting?`,
    ];
    return pickRandom(greetings);
  }

  const generic = [
    "Yeah, makes sense.",
    "Interesting point, let's keep that in mind.",
    "I'm watching everyone closely.",
    "Let's get ready for the vote.",
    "I agree with that.",
  ];
  return pickRandom(generic);
}

export async function triggerBotChatReply(roomCode, channel, message, senderName) {
  if (channel && channel !== "global") return;

  const alivePlayers = await prisma.gamePlayer.findMany({
    where: { room_code: roomCode, status: "ALIVE" },
    select: {
      id: true,
      user_id: true,
      role: true,
      isBot: true,
      user: { select: { full_name: true } },
    },
  });

  const aliveBots = alivePlayers.filter((p) => p.isBot);
  if (aliveBots.length === 0) return;

  const isQuestionOrAccusation =
    QUESTIONS.some((q) => message.includes(q)) ||
    ACCUSATIONS.some((a) => message.toLowerCase().includes(a));

  if (!isQuestionOrAccusation && Math.random() > 0.8) return;

  const bot = pickRandom(aliveBots);
  const otherPlayerNames = alivePlayers
    .filter((p) => p.id !== bot.id && p.user?.full_name !== senderName)
    .map((p) => p.user?.full_name || "someone");

  const reply = generateBotReply(message, bot.role, senderName, otherPlayerNames);

  const delay = 1000 + Math.random() * 1000;

  setTimeout(async () => {
    try {
      const { default: pusher } = await import("../../config/pusher.js");
      await pusher.trigger(`game-${roomCode}`, "chat-message", {
        userId: bot.user_id,
        name: bot.user.full_name,
        message: reply,
        channel: "global",
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      console.error("[bot chat]", e.message);
    }
  }, delay);
}
