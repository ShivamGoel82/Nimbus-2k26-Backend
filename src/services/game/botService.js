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
 *     - Mafia bot coordinates with human teammate in mafia chat.
 *
 *   DISCUSSION phase:
 *     - Natural human-like pacing (12-16s between automated messages).
 *     - Bots actively LISTEN to the human player:
 *         * If human suspects/accuses someone, citizen bots validate the human's perspective,
 *           adopt the human's suspect as town consensus, and cite the human by name!
 *         * If human defends someone, bots remove them from suspect list.
 *         * Mafia bots deflect to protect teammates or bandwagon on innocent citizens.
 *     - Fast-forward to voting only after sufficient discussion (~65s), giving an 8s clean countdown.
 *
 *   VOTING phase:
 *     - Citizen bots vote for the consensus suspect agreed upon during discussion.
 *     - Mafia bots protect teammates or vote strategically.
 *
 *   INTERACTIVE CHAT:
 *     - 100% reliable dynamic replies addressing the player by name and engaging with their ideas.
 */

import prisma from "../../config/prisma.js";
import pusher from "../../config/pusher.js";

// Track which actions bots have already executed in NIGHT and VOTING
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
  try {
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
      try {
        const botCount = await prisma.gamePlayer.count({
          where: { room_code: room.room_code, isBot: true, status: "ALIVE" },
        });
        if (botCount === 0) continue;

        const meta = getMeta(room);

        if (room.status === "NIGHT" || room.status === "VOTING") {
          const key = cacheKey(room.room_code, room.round, room.status);
          if (botActedCache.has(key)) continue;

          const timeLeftMs = new Date(room.phase_ends_at).getTime() - Date.now();
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
          await actBotsDiscussion(room, meta);
        }
      } catch (roomErr) {
        console.error(`[bots] Error processing room ${room.room_code}:`, roomErr.message);
      }
    }

    // Clean up old cache entries
    if (botActedCache.size > 500) {
      const entries = [...botActedCache];
      entries.slice(0, 200).forEach((k) => botActedCache.delete(k));
    }
  } catch (err) {
    console.error("[bots] Fatal error in runBotActions:", err.message);
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

  // If there are alive mafia bots, post an initial team chat message in private-mafia channel
  const mafiaBots = aliveBots.filter((b) => b.role === "MAFIA" || b.role === "MAFIA_HELPER" || b.role === "HITMAN");
  if (mafiaBots.length > 0) {
    const mafiaBot = pickRandom(mafiaBots);
    const nonMafia = alivePlayers.filter((p) => p.role !== "MAFIA" && p.role !== "MAFIA_HELPER" && p.role !== "HITMAN");
    const target = pickRandom(nonMafia);
    const targetName = target ? target.user?.full_name : "our target";

    setTimeout(async () => {
      try {
        await pusher.trigger(`private-mafia-${roomCode}`, "chat-message", {
          userId: mafiaBot.user_id,
          name: mafiaBot.user?.full_name || "Mafia Bot",
          message: `Partner, I'm thinking we eliminate ${targetName} tonight. What's your call?`,
          channel: "mafia",
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        console.error("[mafia night start chat]", e.message);
      }
    }, 1500);
  }

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
  let startTime = startRaw ? new Date(startRaw).getTime() : 0;
  if (!startTime || isNaN(startTime)) {
    startTime = new Date(phase_ends_at).getTime() - 120000;
  }
  const now = Date.now();
  const elapsedSec = Math.max(0, (now - startTime) / 1000);

  // NATURAL PACING: don't bombard chat if a message was sent less than 9 seconds ago
  const lastChatTs = meta.bot_disc_last_ts || 0;
  if (now - lastChatTs < 9000) return;

  const stepKey = `bot_disc_step_r${round}`;
  const currentStep = typeof meta[stepKey] === "number" ? meta[stepKey] : 0;

  let suspectId = meta[`bot_suspect_id_r${round}`] || meta.bot_suspect_id;
  let suspectName = meta[`bot_suspect_name_r${round}`] || meta.bot_suspect_name;
  let accuserName = meta[`bot_accuser_name_r${round}`] || meta.bot_accuser_name;

  // STEP 1: Accusation / initial lead (t >= 5s)
  if (currentStep === 0 && elapsedSec >= 5) {
    const speakerBot =
      pickRandom(aliveBots.filter((b) => b.role !== "MAFIA" && b.role !== "HITMAN")) ||
      pickRandom(aliveBots);

    const possibleSuspects = alivePlayers.filter((p) => p.id !== speakerBot.id);
    const suspect = pickRandom(possibleSuspects);
    if (!suspect) return;

    suspectId = suspect.id;
    suspectName = suspect.user?.full_name || "someone";
    accuserName = speakerBot.user?.full_name || "Bot";

    const accusations = [
      `I've been watching ${suspectName}... they're being way too quiet. Anyone else think they're mafia?`,
      `We need to find the mafia today. What's everyone's read on ${suspectName}?`,
      `I'm getting really suspicious vibes from ${suspectName}. Look at how they acted earlier!`,
      `Let's focus on ${suspectName} this round. Their behavior has been super off.`,
      `Town needs to unite. I think ${suspectName} is our prime suspect right now. What do you think?`,
    ];
    const message = pickRandom(accusations);

    await pusher.trigger(`game-${room_code}`, "chat-message", {
      userId: speakerBot.user_id,
      name: accuserName,
      message,
      channel: "global",
      timestamp: new Date().toISOString(),
    });
    console.log(`[bots] 🗣️ [Step 1] Accusation by ${accuserName}: "${message}"`);

    await prisma.gameRoom.update({
      where: { room_code },
      data: {
        state_meta: {
          ...meta,
          [stepKey]: 1,
          [`bot_suspect_id_r${round}`]: suspectId,
          [`bot_suspect_name_r${round}`]: suspectName,
          [`bot_accuser_name_r${round}`]: accuserName,
          bot_suspect_id: suspectId,
          bot_suspect_name: suspectName,
          bot_accuser_name: accuserName,
          bot_disc_last_ts: Date.now(),
        },
      },
    });
    return;
  }

  // STEP 2: Response / Debate / Mafia Deflection (t >= 18s)
  if (currentStep === 1 && elapsedSec >= 18) {
    const otherBots = aliveBots.filter((b) => b.user?.full_name !== accuserName);
    const responderBot = pickRandom(otherBots.length > 0 ? otherBots : aliveBots);
    const responderName = responderBot.user?.full_name || "Bot";

    let message;
    if (responderBot.role === "MAFIA" || responderBot.role === "HITMAN") {
      // Mafia bot deflects blame onto an innocent citizen to protect teammates
      const innocentCandidates = alivePlayers.filter(
        (p) => p.id !== responderBot.id && p.role !== "MAFIA" && p.role !== "HITMAN" && p.id !== suspectId
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
        `I agree with ${accuserName}! ${suspectName} has been super sus. Let's eliminate them!`,
        `Yeah, ${suspectName}'s defense makes no sense. I'm voting them this round.`,
        `Good eye, ${accuserName}. Let's make sure town votes together on ${suspectName}!`,
        `I'm ready to vote ${suspectName}. Citizens must stick together!`,
      ];
      message = pickRandom(citizenAgreements);
    }

    await pusher.trigger(`game-${room_code}`, "chat-message", {
      userId: responderBot.user_id,
      name: responderName,
      message,
      channel: "global",
      timestamp: new Date().toISOString(),
    });
    console.log(`[bots] 🗣️ [Step 2] Debate reply by ${responderName}: "${message}"`);

    await prisma.gameRoom.update({
      where: { room_code },
      data: {
        state_meta: {
          ...meta,
          [stepKey]: 2,
          bot_disc_last_ts: Date.now(),
        },
      },
    });
    return;
  }

  // STEP 3: Third Bot chimes in with cross-examination (t >= 32s)
  if (currentStep === 2 && elapsedSec >= 32) {
    const thirdBotCandidates = aliveBots.filter((b) => b.user?.full_name !== accuserName);
    const thirdBot = pickRandom(thirdBotCandidates.length > 0 ? thirdBotCandidates : aliveBots);
    const thirdName = thirdBot.user?.full_name || "Bot";

    const chimes = [
      `I've been listening to both sides. ${suspectName} really hasn't cleared their name at all.`,
      `We only have limited time left in discussion. We need to lock in on ${suspectName}!`,
      `Agreed, let's not split our votes. ${suspectName} is our clearest lead right now.`,
      `If we don't eliminate ${suspectName} today, town is in serious danger tonight!`,
      `Look, splitting votes only helps the mafia. Everyone vote ${suspectName}!`,
    ];
    const message = pickRandom(chimes);

    await pusher.trigger(`game-${room_code}`, "chat-message", {
      userId: thirdBot.user_id,
      name: thirdName,
      message,
      channel: "global",
      timestamp: new Date().toISOString(),
    });
    console.log(`[bots] 🗣️ [Step 3] Analysis by ${thirdName}: "${message}"`);

    await prisma.gameRoom.update({
      where: { room_code },
      data: {
        state_meta: {
          ...meta,
          [stepKey]: 3,
          bot_disc_last_ts: Date.now(),
        },
      },
    });
    return;
  }

  // STEP 4: Fourth Bot rallies the town / warning (t >= 48s)
  if (currentStep === 3 && elapsedSec >= 48) {
    const fourthBot = pickRandom(aliveBots);
    const fourthName = fourthBot.user?.full_name || "Bot";

    const rallies = [
      `${suspectName}, you have moments to defend yourself before voting starts! Town, get ready to vote ${suspectName}.`,
      `No valid defense from ${suspectName}. That seals it for me. Voting ${suspectName}!`,
      `Get ready to lock in votes on ${suspectName} as soon as voting opens!`,
      `Town is united on ${suspectName}. Let's end this round cleanly.`,
    ];
    const message = pickRandom(rallies);

    await pusher.trigger(`game-${room_code}`, "chat-message", {
      userId: fourthBot.user_id,
      name: fourthName,
      message,
      channel: "global",
      timestamp: new Date().toISOString(),
    });
    console.log(`[bots] 🗣️ [Step 4] Rally by ${fourthName}: "${message}"`);

    await prisma.gameRoom.update({
      where: { room_code },
      data: {
        state_meta: {
          ...meta,
          [stepKey]: 4,
          bot_disc_last_ts: Date.now(),
        },
      },
    });
    return;
  }

  // STEP 5: Consensus & WRAP UP TO VOTING (t >= 65s)
  // Give players ample time (over a minute) to discuss before wrapping up
  if (currentStep === 4 && elapsedSec >= 65) {
    const closerBot = pickRandom(aliveBots);
    const closerName = closerBot.user?.full_name || "Bot";

    const conclusions = [
      `Town consensus reached: we're voting out ${suspectName}! Fast-forwarding to voting in 8s ⏩`,
      `Decision made on ${suspectName}! Moving straight to vote ⏩`,
      `We all know what to do on ${suspectName}! Get ready for the voting round ⏩`,
    ];
    const message = pickRandom(conclusions);

    await pusher.trigger(`game-${room_code}`, "chat-message", {
      userId: closerBot.user_id,
      name: closerName,
      message,
      channel: "global",
      timestamp: new Date().toISOString(),
    });
    console.log(`[bots] 🗣️ [Step 5] Consensus by ${closerName}: "${message}"`);

    // Speed up discussion: set phase_ends_at to (now + 8s) to give players a clear, comfortable countdown
    const fastForwardEndsAt = new Date(Date.now() + 8000);

    const votes = { ...(meta.discussion_time_votes || {}) };
    for (const bot of aliveBots) {
      votes[bot.user_id] = -1;
    }

    await prisma.gameRoom.update({
      where: { room_code },
      data: {
        phase_ends_at: fastForwardEndsAt,
        state_meta: {
          ...meta,
          [stepKey]: 5,
          bot_target_id: suspectId,
          discussion_time_votes: votes,
          bot_disc_last_ts: Date.now(),
        },
      },
    });

    // Broadcast updated timer to frontend so linear progress timer snaps to 8s
    await pusher.trigger(`game-${room_code}`, "day-time-updated", {
      phase: "DISCUSSION",
      round,
      phaseEndsAt: fastForwardEndsAt.toISOString(),
      deltaSeconds: 1,
      netAdjustment: -aliveBots.length,
      aliveCount: alivePlayers.length,
      increaseVotes: 0,
      decreaseVotes: aliveBots.length,
    });
    return;
  }

  // ONGOING BANTER: If discussion timer was extended (t > 70s), chat every 12-15s
  if (currentStep >= 5 && now - lastChatTs >= 14000) {
    const speakerBot = pickRandom(aliveBots);
    const speakerName = speakerBot.user?.full_name || "Bot";

    const reminders = [
      `Stay focused town, lock in your vote on ${suspectName} when voting opens!`,
      `Don't switch up at the last second. ${suspectName} is our target!`,
      `Tick tock... get ready to vote out ${suspectName}!`,
      `United town wins! Make sure everyone votes ${suspectName}.`,
    ];
    const message = pickRandom(reminders);

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
          bot_disc_last_ts: now,
        },
      },
    });
  }
}

// ─── VOTING PHASE BOT ACTIONS ─────────────────────────────────────────────────

async function actBotsVoting(roomCode, round, aliveBots, alivePlayers, meta) {
  const allAliveIds = alivePlayers.map((p) => p.id);
  const targetSuspectId = meta?.bot_target_id || meta?.bot_suspect_id;
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

const GREETINGS = ["hi", "hello", "hey", "sup", "yo", "good morning", "morning"];
const ACCUSATIONS = ["sus", "mafia", "killer", "vote", "kill", "is bad", "fake", "guilty", "lying", "impostor", "eliminate"];
const QUESTIONS = ["who", "what", "why", "where", "how", "?", "whom"];

export async function triggerBotChatReply(roomCode, channel, message, senderName) {
  try {
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

    const room = await prisma.gameRoom.findUnique({
      where: { room_code: roomCode },
      select: { state_meta: true, status: true, round: true },
    });
    const meta = getMeta(room);
    const msgLower = message.toLowerCase().trim();

    // ─── MAFIA TEAM CHAT REPLY ───
    if (channel === "mafia") {
      const aliveMafiaBots = alivePlayers.filter(
        (p) => p.isBot && (p.role === "MAFIA" || p.role === "MAFIA_HELPER" || p.role === "HITMAN")
      );
      if (aliveMafiaBots.length === 0) return;

      const bot = pickRandom(aliveMafiaBots);
      const nonMafiaTargets = alivePlayers
        .filter((p) => p.role !== "MAFIA" && p.role !== "MAFIA_HELPER" && p.role !== "HITMAN")
        .map((p) => p.user?.full_name || "someone");
      const targetName = nonMafiaTargets.length > 0 ? pickRandom(nonMafiaTargets) : "someone";

      let reply;
      if (msgLower.includes("who") || msgLower.includes("kill") || msgLower.includes("target") || msgLower.includes("shoot") || msgLower.includes("vote")) {
        const replies = [
          `Let's eliminate ${targetName} tonight!`,
          `I vote for ${targetName}. They are a big threat to us.`,
          `Target ${targetName}. Town won't see it coming.`,
          `We should take down ${targetName} first.`,
        ];
        reply = pickRandom(replies);
      } else {
        const replies = [
          `Got it partner! Let's eliminate the citizens together.`,
          `Agreed. Stay quiet during discussion so they don't suspect us.`,
          `We have the upper hand. Let's finish them off!`,
          `I'm with you on this plan.`,
        ];
        reply = pickRandom(replies);
      }

      const botName = bot.user?.full_name || "Mafia Bot";
      const delay = 800 + Math.random() * 600;
      setTimeout(async () => {
        try {
          await pusher.trigger(`private-mafia-${roomCode}`, "chat-message", {
            userId: bot.user_id,
            name: botName,
            message: reply,
            channel: "mafia",
            timestamp: new Date().toISOString(),
          });
          console.log(`[bots] 🕶️ Mafia chat reply by ${botName}: "${reply}"`);
        } catch (e) {
          console.error("[mafia bot chat]", e.message);
        }
      }, delay);
      return;
    }

    // ─── LOBBY CHAT REPLY ───
    if (channel === "lobby" || room?.status === "LOBBY") {
      const allBots = await prisma.gamePlayer.findMany({
        where: { room_code: roomCode, isBot: true },
        select: { user_id: true, user: { select: { full_name: true } } },
      });
      if (allBots.length === 0) return;

      const bot = pickRandom(allBots);
      const botName = bot.user?.full_name || "Bot";
      const lobbyReplies = [
        `Ready to play! Let's start!`,
        `Good luck everyone, may the best side win!`,
        `Excited for this game! Let's go!`,
        `Ready! Don't let the mafia win today!`,
      ];
      const reply = pickRandom(lobbyReplies);

      const delay = 600 + Math.random() * 600;
      setTimeout(async () => {
        try {
          await pusher.trigger(`game-${roomCode}`, "chat-message", {
            userId: bot.user_id,
            name: botName,
            message: reply,
            channel: "lobby",
            timestamp: new Date().toISOString(),
          });
          console.log(`[bots] 🎮 Lobby chat reply by ${botName}: "${reply}"`);
        } catch (e) {
          console.error("[lobby bot chat]", e.message);
        }
      }, delay);
      return;
    }

    // ─── GLOBAL DISCUSSION CHAT: LISTEN TO PLAYER PERSPECTIVE ───
    const aliveBots = alivePlayers.filter((p) => p.isBot);
    if (aliveBots.length === 0) return;

    // Detect if human mentioned any player in the room
    const mentionedPlayer = alivePlayers.find((p) => {
      const fullName = p.user?.full_name?.toLowerCase();
      if (!fullName) return false;
      const parts = fullName.split(/\s+/).filter((part) => part.length >= 3 && part !== "bot");
      if (msgLower.includes(fullName)) return true;
      return parts.some((part) => msgLower.includes(part));
    });

    const isAccusingOrVoting =
      ACCUSATIONS.some((a) => msgLower.includes(a)) ||
      msgLower.includes("think") ||
      msgLower.includes("vote") ||
      msgLower.includes("kill") ||
      msgLower.includes("get rid") ||
      msgLower.includes("lynch");

    const isInnocentVouch =
      msgLower.includes("innocent") ||
      msgLower.includes("not mafia") ||
      msgLower.includes("don't vote") ||
      msgLower.includes("dont vote") ||
      msgLower.includes("leave") ||
      msgLower.includes("trust");

    let reply = "";
    let respondingBot = pickRandom(aliveBots);
    let newSuspectId = meta.bot_suspect_id;
    let newSuspectName = meta.bot_suspect_name;
    let newAccuserName = meta.bot_accuser_name;

    // CASE 1: Player vouches for someone as innocent ("X is innocent", "don't vote X")
    if (mentionedPlayer && isInnocentVouch) {
      const vouchedName = mentionedPlayer.user?.full_name;
      respondingBot = pickRandom(aliveBots.filter((b) => b.id !== mentionedPlayer.id)) || respondingBot;

      const vouchReplies = [
        `Got it @${senderName}, I trust your read! We'll leave ${vouchedName} alone. Who do you suspect instead?`,
        `Fair enough @${senderName}! If you're confident ${vouchedName} is innocent, who is the real mafia?`,
        `Understood @${senderName}. Taking ${vouchedName} off the hot seat. Give us a lead!`,
      ];
      reply = pickRandom(vouchReplies);

      // If they were the current suspect, clear them!
      if (newSuspectId === mentionedPlayer.id) {
        newSuspectId = null;
        newSuspectName = null;
      }
    }
    // CASE 2: Player accuses or points suspicion at a player ("I think X is mafia", "vote X", "X is sus")
    else if (mentionedPlayer && isAccusingOrVoting) {
      const targetName = mentionedPlayer.user?.full_name;

      // If player is accusing the bot itself
      if (mentionedPlayer.id === respondingBot.id) {
        if (respondingBot.role === "MAFIA" || respondingBot.role === "HITMAN") {
          const mafiaDefense = [
            `Who, me?! @${senderName}, you're deflecting because you're the real mafia!`,
            `Classic mafia move, @${senderName}! Trying to pin blame on me won't save you!`,
            `I'm 100% innocent citizen! Don't let @${senderName} confuse the town!`,
          ];
          reply = pickRandom(mafiaDefense);
        } else {
          const citizenDefense = [
            `Wait @${senderName}, no way! I'm 100% innocent citizen! Check my votes!`,
            `You've got the wrong person @${senderName}! If you vote me out, town loses!`,
            `I swear on my role I'm with town @${senderName}! Look at someone else!`,
          ];
          reply = pickRandom(citizenDefense);
        }
      } else {
        // Player is accusing another player: BOTS LISTEN AND ADAPT TO PLAYER!
        newSuspectId = mentionedPlayer.id;
        newSuspectName = targetName;
        newAccuserName = senderName;

        if (respondingBot.role === "MAFIA" || respondingBot.role === "HITMAN") {
          // Mafia checks if target is a teammate
          const isTeammate = mentionedPlayer.role === "MAFIA" || mentionedPlayer.role === "HITMAN";
          if (isTeammate) {
            const innocentCandidates = alivePlayers.filter(
              (p) => p.id !== respondingBot.id && p.role !== "MAFIA" && p.role !== "HITMAN" && p.id !== mentionedPlayer.id
            );
            const altName = pickRandom(innocentCandidates)?.user?.full_name || "someone else";
            const mafiaDeflections = [
              `Hold on @${senderName}, are you sure? I feel like ${targetName} might be innocent and ${altName} is the real threat!`,
              `I don't know @${senderName}, don't tunnel on ${targetName}. Look at ${altName}'s silence!`,
            ];
            reply = pickRandom(mafiaDeflections);
          } else {
            // Mafia happily agrees with human to lynch an innocent citizen!
            const mafiaAgrees = [
              `100% agree with @${senderName}! ${targetName} has been super sus all game!`,
              `Great catch @${senderName}! Let's lock our votes on ${targetName}!`,
              `I'm with @${senderName}. We need to eliminate ${targetName} right now!`,
            ];
            reply = pickRandom(mafiaAgrees);
          }
        } else {
          // Citizen bot respects and adopts human player's perspective!
          const citizenAgrees = [
            `Wait, @${senderName} has a really solid point! ${targetName} has been acting very shady.`,
            `I trust your read @${senderName}! Let's switch our focus to ${targetName}!`,
            `Good eye @${senderName}! I was watching ${targetName} too. Town, let's vote ${targetName}!`,
            `Agreed @${senderName}! Let's unite all citizen votes on ${targetName}!`,
          ];
          reply = pickRandom(citizenAgrees);
        }
      }
    }
    // CASE 3: Player asks "who is mafia?", "who to vote?", "who should we eliminate?"
    else if (
      msgLower.includes("who") ||
      msgLower.includes("whom") ||
      msgLower.includes("lead") ||
      msgLower.includes("target") ||
      msgLower.includes("anyone")
    ) {
      const primeTarget = newSuspectName || "someone";
      const leadReplies = [
        `We've been eyeing ${primeTarget}, but what's your take @${senderName}? Anyone you find suspicious?`,
        `Our main lead right now is ${primeTarget}. Do you agree with voting them @${senderName}?`,
        `I'm thinking ${primeTarget}, but I want to hear your perspective @${senderName}! Who is your top suspect?`,
      ];
      reply = pickRandom(leadReplies);
    }
    // CASE 4: Greetings ("hi", "hello", "hey")
    else if (GREETINGS.some((g) => msgLower.includes(g))) {
      const greetings = [
        `Hey @${senderName}! Let's work together and catch the mafia this round! Who are you suspecting?`,
        `Hello @${senderName}! Glad you're here. Any leads on who the mafia might be?`,
        `Sup @${senderName}! Ready to help town find the killer?`,
      ];
      reply = pickRandom(greetings);
    }
    // CASE 5: General player message
    else {
      const general = [
        `I hear you @${senderName}. Let's make sure town stays united and votes together!`,
        `Good point @${senderName}. Who do you think we should eliminate this round?`,
        `I'm listening closely, @${senderName}. What's our plan for the voting round?`,
      ];
      reply = pickRandom(general);
    }

    const botName = respondingBot.user?.full_name || "Bot";
    const delay = 700 + Math.random() * 600;

    setTimeout(async () => {
      try {
        await pusher.trigger(`game-${roomCode}`, "chat-message", {
          userId: respondingBot.user_id,
          name: botName,
          message: reply,
          channel: "global",
          timestamp: new Date().toISOString(),
        });
        console.log(`[bots] 🤖 Adaptive reply by ${botName} to @${senderName}: "${reply}"`);
      } catch (e) {
        console.error("[bot chat]", e.message);
      }
    }, delay);

    // Save updated suspect and reset last chat timestamp so automated script doesn't talk over the human
    await prisma.gameRoom.update({
      where: { room_code: roomCode },
      data: {
        state_meta: {
          ...meta,
          bot_suspect_id: newSuspectId,
          bot_suspect_name: newSuspectName,
          bot_accuser_name: newAccuserName,
          bot_target_id: newSuspectId,
          [`bot_suspect_id_r${room.round}`]: newSuspectId,
          [`bot_suspect_name_r${room.round}`]: newSuspectName,
          [`bot_accuser_name_r${room.round}`]: newAccuserName,
          bot_disc_last_ts: Date.now(),
        },
      },
    });
  } catch (err) {
    console.error("[triggerBotChatReply]", err.message);
  }
}
