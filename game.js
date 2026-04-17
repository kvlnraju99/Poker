"use strict";

const crypto = require("node:crypto");

const STARTING_CHIPS = 1000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const MAX_PLAYERS = 10;
const INACTIVITY_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_TURN_TIME_LIMIT_SECONDS = 120;
const TURN_TIME_LIMIT_OPTIONS = new Set([30, 60, 120, 180]);

const SUITS = ["S", "H", "D", "C"];
const SUIT_SYMBOLS = {
  S: "♠",
  H: "♥",
  D: "♦",
  C: "♣"
};
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const GAME_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function createTable(options = {}) {
  return {
    gameCode: createGameCode(),
    hostPlayerId: null,
    gameStarted: false,
    turnTimeLimitSeconds: sanitizeTurnTimeLimit(options.turnTimeLimitSeconds),
    turnDeadlineAt: null,
    players: [],
    stage: "waiting",
    handNumber: 0,
    dealerIndex: -1,
    smallBlindIndex: -1,
    bigBlindIndex: -1,
    turnPlayerId: null,
    deck: [],
    communityCards: [],
    pot: 0,
    currentBet: 0,
    minRaise: BIG_BLIND,
    lastRaiseAmount: 0,
    lastAggressorId: null,
    roundStats: createRoundStats("waiting", 0, 0, 0),
    actionLog: [],
    lastHand: null
  };
}

function createRoundStats(stage, pot, currentBet, lastRaiseAmount) {
  return {
    stage,
    stageLabel: titleCase(stage),
    pot,
    currentBet,
    lastRaiseAmount,
    streetTotal: 0
  };
}

function titleCase(value) {
  if (!value) {
    return "";
  }

  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function joinPlayer(table, rawName) {
  const name = sanitizeName(rawName);

  if (!name) {
    throw new Error("Enter a player name.");
  }

  const existingPlayer = table.players.find(
    (player) => !player.markedForRemoval && player.name.toLowerCase() === name.toLowerCase()
  );

  if (existingPlayer) {
    if (existingPlayer.disconnected) {
      existingPlayer.token = crypto.randomBytes(24).toString("hex");
      existingPlayer.lastSeenAt = Date.now();
      existingPlayer.disconnected = false;
      existingPlayer.markedForRemoval = false;
      existingPlayer.lastAction = "Rejoined table";
      logAction(table, `${existingPlayer.name} rejoined the table.`);
      return existingPlayer;
    }

    throw new Error("That name is already taken.");
  }

  if (table.players.length >= MAX_PLAYERS) {
    throw new Error("Table is full.");
  }

  const player = {
    id: crypto.randomUUID(),
    token: crypto.randomBytes(24).toString("hex"),
    name,
    chips: STARTING_CHIPS,
    lastSeenAt: Date.now(),
    disconnected: false,
    markedForRemoval: false,
    inHand: false,
    hasFolded: false,
    isAllIn: false,
    actedThisStage: false,
    currentBet: 0,
    totalContribution: 0,
    holeCards: [],
    lastAction: "Joined table"
  };

  table.players.push(player);
  syncHostPlayer(table);
  logAction(table, `${player.name} joined the table.`);

  return player;
}

function sanitizeName(rawName) {
  return String(rawName || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 16);
}

function createGameCode() {
  let code = "";

  for (let index = 0; index < 6; index += 1) {
    const randomIndex = crypto.randomInt(GAME_CODE_ALPHABET.length);
    code += GAME_CODE_ALPHABET[randomIndex];
  }

  return code;
}

function sanitizeTurnTimeLimit(rawValue) {
  const value = Math.floor(Number(rawValue));
  return TURN_TIME_LIMIT_OPTIONS.has(value) ? value : DEFAULT_TURN_TIME_LIMIT_SECONDS;
}

function authenticate(table, playerId, token) {
  syncTable(table);
  const player = table.players.find((entry) => entry.id === playerId && entry.token === token);

  if (!player) {
    return null;
  }

  player.lastSeenAt = Date.now();
  player.disconnected = false;
  player.markedForRemoval = false;
  return player;
}

function cleanupInactivePlayers(table) {
  const now = Date.now();
  let changed = false;

  for (const player of table.players) {
    if (player.disconnected || player.markedForRemoval) {
      continue;
    }

    if (now - player.lastSeenAt <= INACTIVITY_TIMEOUT_MS) {
      continue;
    }

    player.disconnected = true;
    player.lastAction = "Disconnected";
    logAction(table, `${player.name} disconnected.`);

    if (table.stage !== "waiting" && player.inHand && !player.hasFolded && !player.isAllIn) {
      player.hasFolded = true;
      player.actedThisStage = true;
      logAction(table, `${player.name} folded after disconnecting.`);
      changed = true;
    }
  }

  if (!changed) {
    removeMarkedPlayers(table);
    syncHostPlayer(table);
    return;
  }

  resolveTableAfterExternalChange(table);
  removeMarkedPlayers(table);
  syncHostPlayer(table);
}

function applyAction(table, player, action, amount) {
  syncTable(table);

  switch (action) {
    case "startGame":
      startGame(table, player);
      break;
    case "startHand":
      startNextHand(table, player);
      break;
    case "fold":
      foldPlayer(table, player);
      break;
    case "check":
      checkPlayer(table, player);
      break;
    case "call":
      callPlayer(table, player);
      break;
    case "raise":
      raisePlayer(table, player, amount);
      break;
    case "allIn":
      allInPlayer(table, player);
      break;
    case "rebuy":
      rebuyPlayer(table, player);
      break;
    case "leave":
      leavePlayer(table, player);
      break;
    default:
      throw new Error("Unknown action.");
  }

  syncTable(table);
}

function startGame(table, player) {
  ensureHost(table, player);

  if (table.gameStarted) {
    throw new Error("The game already started.");
  }

  table.gameStarted = true;
  logAction(table, `${player.name} started the game.`);
  startHand(table);
}

function startNextHand(table, player) {
  ensureHost(table, player);

  if (!table.gameStarted) {
    throw new Error("Start the game from the lobby first.");
  }

  startHand(table);
}

function startHand(table) {
  if (table.stage !== "waiting") {
    throw new Error("A hand is already in progress.");
  }

  const eligibleIndexes = getEligibleIndexes(table, canJoinHand);
  if (eligibleIndexes.length < 2) {
    throw new Error("At least two connected players with chips are needed.");
  }

  table.handNumber += 1;
  table.communityCards = [];
  table.deck = shuffle(createDeck());
  table.pot = 0;
  table.currentBet = 0;
  table.minRaise = BIG_BLIND;
  table.lastRaiseAmount = BIG_BLIND;
  table.lastAggressorId = null;
  table.stage = "preflop";
  table.lastHand = null;

  for (const player of table.players) {
    player.inHand = canJoinHand(player);
    player.hasFolded = false;
    player.isAllIn = false;
    player.actedThisStage = false;
    player.currentBet = 0;
    player.totalContribution = 0;
    player.holeCards = [];
    player.lastAction = player.inHand ? "Waiting" : getIdleAction(player);
  }

  table.dealerIndex = findNextIndex(table, table.dealerIndex, canJoinHand);
  if (table.dealerIndex === -1) {
    throw new Error("No eligible dealer found.");
  }

  if (eligibleIndexes.length === 2) {
    table.smallBlindIndex = table.dealerIndex;
    table.bigBlindIndex = findNextIndex(table, table.smallBlindIndex, canJoinHand);
  } else {
    table.smallBlindIndex = findNextIndex(table, table.dealerIndex, canJoinHand);
    table.bigBlindIndex = findNextIndex(table, table.smallBlindIndex, canJoinHand);
  }

  dealHoleCards(table);
  postBlind(table, table.smallBlindIndex, SMALL_BLIND, "posted the small blind");
  postBlind(table, table.bigBlindIndex, BIG_BLIND, "posted the big blind");

  table.currentBet = table.players[table.bigBlindIndex].currentBet;
  table.roundStats = createRoundStats(table.stage, table.pot, table.currentBet, table.lastRaiseAmount);
  table.roundStats.streetTotal = table.pot;

  const firstToActIndex =
    eligibleIndexes.length === 2
      ? table.dealerIndex
      : findNextIndex(table, table.bigBlindIndex, canActOnTurn);

  setTurnPlayerByIndex(table, firstToActIndex);

  logAction(table, `Hand #${table.handNumber} started.`);
}

function canJoinHand(player) {
  return !player.disconnected && !player.markedForRemoval && player.chips > 0;
}

function getIdleAction(player) {
  if (player.disconnected) {
    return "Disconnected";
  }

  if (player.chips <= 0) {
    return "Out of chips";
  }

  return "Waiting";
}

function dealHoleCards(table) {
  const activeIndexes = getEligibleIndexes(table, (player) => player.inHand);

  for (let round = 0; round < 2; round += 1) {
    for (const index of orderedIndexesFrom(table, table.dealerIndex, activeIndexes)) {
      table.players[index].holeCards.push(drawCard(table));
    }
  }
}

function orderedIndexesFrom(table, startIndex, indexes) {
  const ordered = [];
  const allowed = new Set(indexes);
  let current = startIndex;

  for (let count = 0; count < table.players.length; count += 1) {
    current = nextIndex(table.players.length, current);
    if (allowed.has(current)) {
      ordered.push(current);
    }
  }

  return ordered;
}

function postBlind(table, playerIndex, amount, text) {
  const player = table.players[playerIndex];
  if (!player || !player.inHand) {
    return;
  }

  const paid = commitChips(table, player, amount);
  if (player.chips === 0) {
    player.isAllIn = true;
  }

  player.lastAction = paid < amount ? `All-in blind ${paid}` : `${titleCase(text)}`;
  logAction(table, `${player.name} ${text} (${paid}).`);
}

function foldPlayer(table, player) {
  ensureHandRunning(table);
  ensureTurn(table, player);

  player.hasFolded = true;
  player.actedThisStage = true;
  player.lastAction = "Folded";
  logAction(table, `${player.name} folded.`);

  completeTurn(table, player.id);
}

function checkPlayer(table, player) {
  ensureHandRunning(table);
  ensureTurn(table, player);

  if (table.currentBet !== player.currentBet) {
    throw new Error("You need to call or fold.");
  }

  player.actedThisStage = true;
  player.lastAction = "Checked";
  logAction(table, `${player.name} checked.`);

  completeTurn(table, player.id);
}

function callPlayer(table, player) {
  ensureHandRunning(table);
  ensureTurn(table, player);

  const toCall = Math.max(0, table.currentBet - player.currentBet);
  if (toCall === 0) {
    throw new Error("There is nothing to call.");
  }

  const paid = commitChips(table, player, toCall);
  player.actedThisStage = true;
  player.lastAction = paid < toCall ? `Called all-in ${player.currentBet}` : "Called";

  if (player.chips === 0) {
    player.isAllIn = true;
    logAction(table, `${player.name} called all-in for ${player.currentBet}.`);
  } else {
    logAction(table, `${player.name} called ${paid}.`);
  }

  completeTurn(table, player.id);
}

function raisePlayer(table, player, rawAmount) {
  ensureHandRunning(table);
  ensureTurn(table, player);

  const target = Math.floor(Number(rawAmount));
  const maxTarget = player.currentBet + player.chips;
  const minimumTarget = table.currentBet === 0 ? BIG_BLIND : table.currentBet + table.minRaise;

  if (!Number.isFinite(target)) {
    throw new Error("Enter a raise amount.");
  }

  if (target <= table.currentBet) {
    throw new Error("Raise must be above the current bet.");
  }

  if (target > maxTarget) {
    throw new Error("You do not have enough chips for that raise.");
  }

  if (target < minimumTarget) {
    throw new Error(`Raise must be at least ${minimumTarget}.`);
  }

  const previousBet = table.currentBet;
  const paid = commitChips(table, player, target - player.currentBet);
  const raiseAmount = target - previousBet;

  table.currentBet = player.currentBet;
  table.minRaise = Math.max(BIG_BLIND, raiseAmount);
  table.lastRaiseAmount = raiseAmount;
  table.lastAggressorId = player.id;
  resetActionFlagsForRaise(table, player.id);

  player.actedThisStage = true;
  player.lastAction = `Raised to ${player.currentBet}`;

  if (player.chips === 0) {
    player.isAllIn = true;
    logAction(table, `${player.name} raised all-in to ${player.currentBet}.`);
  } else {
    logAction(table, `${player.name} raised by ${raiseAmount} to ${player.currentBet}.`);
  }

  if (paid <= 0) {
    throw new Error("Raise failed.");
  }

  completeTurn(table, player.id);
}

function allInPlayer(table, player) {
  ensureHandRunning(table);
  ensureTurn(table, player);

  if (player.chips <= 0) {
    throw new Error("You are already all-in.");
  }

  const previousBet = table.currentBet;
  const totalTarget = player.currentBet + player.chips;
  commitChips(table, player, player.chips);
  player.isAllIn = true;
  player.actedThisStage = true;

  if (totalTarget > previousBet) {
    const raiseAmount = totalTarget - previousBet;
    table.currentBet = totalTarget;
    table.lastRaiseAmount = raiseAmount;
    table.lastAggressorId = player.id;
    if (raiseAmount >= BIG_BLIND) {
      table.minRaise = Math.max(BIG_BLIND, raiseAmount);
    }
    resetActionFlagsForRaise(table, player.id);
    player.actedThisStage = true;
    player.lastAction = `All-in ${totalTarget}`;
    logAction(table, `${player.name} went all-in to ${totalTarget}.`);
  } else {
    player.lastAction = `All-in ${player.currentBet}`;
    logAction(table, `${player.name} went all-in for ${player.currentBet}.`);
  }

  completeTurn(table, player.id);
}

function rebuyPlayer(table, player) {
  if (table.stage !== "waiting") {
    throw new Error("Wait until the current hand finishes to rebuy.");
  }

  if (player.chips > 0) {
    throw new Error("You still have chips.");
  }

  player.chips = STARTING_CHIPS;
  player.disconnected = false;
  player.markedForRemoval = false;
  player.lastAction = "Rebought";
  logAction(table, `${player.name} re-bought to ${STARTING_CHIPS} chips.`);
}

function leavePlayer(table, player) {
  if (table.stage !== "waiting" && player.inHand) {
    player.markedForRemoval = true;
    player.disconnected = true;
    player.lastAction = "Left table";
    if (!player.hasFolded && !player.isAllIn) {
      player.hasFolded = true;
      logAction(table, `${player.name} left the table and folded.`);
      completeTurn(table, player.id);
      return;
    }

    logAction(table, `${player.name} will leave after the hand.`);
    return;
  }

  const index = table.players.findIndex((entry) => entry.id === player.id);
  if (index >= 0) {
    table.players.splice(index, 1);
    fixButtonIndexesAfterRemoval(table, index);
    syncHostPlayer(table);
    logAction(table, `${player.name} left the table.`);
  }
}

function ensureHost(table, player) {
  syncHostPlayer(table);

  if (!player || table.hostPlayerId !== player.id) {
    throw new Error("Only the host can do that.");
  }
}

function ensureHandRunning(table) {
  if (table.stage === "waiting") {
    throw new Error("Start a hand first.");
  }
}

function ensureTurn(table, player) {
  if (!player.inHand || player.hasFolded || player.isAllIn) {
    throw new Error("You cannot act right now.");
  }

  if (table.turnPlayerId !== player.id) {
    throw new Error("It is not your turn.");
  }
}

function commitChips(table, player, amount) {
  const paid = Math.max(0, Math.min(amount, player.chips));
  player.chips -= paid;
  player.currentBet += paid;
  player.totalContribution += paid;
  table.pot += paid;
  table.roundStats.streetTotal += paid;
  syncRoundStats(table);

  if (player.chips === 0) {
    player.isAllIn = true;
  }

  return paid;
}

function resetActionFlagsForRaise(table, actingPlayerId) {
  for (const player of table.players) {
    if (!player.inHand || player.hasFolded || player.isAllIn) {
      continue;
    }

    player.actedThisStage = player.id === actingPlayerId;
  }
}

function completeTurn(table, actingPlayerId) {
  syncRoundStats(table);

  if (countRemainingPlayers(table) === 1) {
    finishHandByFold(table);
    return;
  }

  if (isBettingRoundComplete(table)) {
    advanceStage(table);
    return;
  }

  const actingIndex = table.players.findIndex((player) => player.id === actingPlayerId);
  const nextActingIndex = findNextIndex(table, actingIndex, canActOnTurn);
  setTurnPlayerByIndex(table, nextActingIndex);
}

function countRemainingPlayers(table) {
  return table.players.filter((player) => player.inHand && !player.hasFolded).length;
}

function isBettingRoundComplete(table) {
  const activePlayers = table.players.filter((player) => player.inHand && !player.hasFolded);
  if (activePlayers.length <= 1) {
    return true;
  }

  const playersWhoCanAct = activePlayers.filter((player) => !player.isAllIn);
  if (playersWhoCanAct.length === 0) {
    return true;
  }

  return playersWhoCanAct.every(
    (player) => player.actedThisStage && player.currentBet === table.currentBet
  );
}

function advanceStage(table) {
  const remainingPlayers = table.players.filter((player) => player.inHand && !player.hasFolded);
  const playersWhoCanAct = remainingPlayers.filter((player) => !player.isAllIn);

  if (remainingPlayers.length <= 1) {
    finishHandByFold(table);
    return;
  }

  if (playersWhoCanAct.length <= 1) {
    runBoardToShowdown(table);
    return;
  }

  switch (table.stage) {
    case "preflop":
      drawCommunityCards(table, 3);
      startStage(table, "flop");
      break;
    case "flop":
      drawCommunityCards(table, 1);
      startStage(table, "turn");
      break;
    case "turn":
      drawCommunityCards(table, 1);
      startStage(table, "river");
      break;
    case "river":
      settleShowdown(table);
      break;
    default:
      break;
  }
}

function runBoardToShowdown(table) {
  while (table.communityCards.length < 5) {
    drawCommunityCards(table, 1);
  }

  settleShowdown(table);
}

function startStage(table, stage) {
  table.stage = stage;
  table.currentBet = 0;
  table.lastRaiseAmount = 0;
  table.lastAggressorId = null;
  table.minRaise = BIG_BLIND;

  for (const player of table.players) {
    player.currentBet = 0;
    player.actedThisStage = false;
  }

  table.roundStats = createRoundStats(stage, table.pot, 0, 0);

  const nextActingIndex = findNextIndex(table, table.dealerIndex, canActOnTurn);
  if (nextActingIndex === -1) {
    runBoardToShowdown(table);
    return;
  }

  setTurnPlayerByIndex(table, nextActingIndex);
}

function drawCommunityCards(table, count) {
  for (let index = 0; index < count; index += 1) {
    table.communityCards.push(drawCard(table));
  }
}

function finishHandByFold(table) {
  const winner = table.players.find((player) => player.inHand && !player.hasFolded);
  if (!winner) {
    table.stage = "waiting";
    syncRoundStats(table);
    return;
  }

  const winnings = table.pot;
  winner.chips += winnings;
  logAction(table, `${winner.name} won ${winnings}; everyone else folded.`);

  table.lastHand = {
    kind: "fold",
    summary: `${winner.name} won ${winnings} because everyone else folded.`,
    winners: [{ id: winner.id, name: winner.name, amount: winnings }],
    handByPlayer: {}
  };

  finalizeHand(table);
}

function settleShowdown(table) {
  const contenders = table.players.filter((player) => player.inHand && !player.hasFolded);
  const handScores = new Map();

  for (const player of contenders) {
    handScores.set(player.id, evaluateSevenCardHand(player.holeCards.concat(table.communityCards)));
  }

  const sidePots = buildSidePots(table);
  const payoutMap = new Map();
  const potResults = [];

  for (const sidePot of sidePots) {
    const eligiblePlayers = contenders.filter((player) => sidePot.eligibleIds.includes(player.id));
    eligiblePlayers.sort((left, right) => compareHandScores(handScores.get(right.id), handScores.get(left.id)));
    const bestScore = handScores.get(eligiblePlayers[0].id);
    const winners = eligiblePlayers.filter(
      (player) => compareHandScores(handScores.get(player.id), bestScore) === 0
    );
    const orderedWinners = orderPlayersFromDealer(table, winners);
    const share = Math.floor(sidePot.amount / winners.length);
    let remainder = sidePot.amount % winners.length;
    const potWinnerResults = [];

    for (const winner of orderedWinners) {
      const awarded = share + (remainder > 0 ? 1 : 0);
      winner.chips += awarded;
      payoutMap.set(winner.id, (payoutMap.get(winner.id) || 0) + awarded);
      potWinnerResults.push({
        id: winner.id,
        name: winner.name,
        amount: awarded
      });
      if (remainder > 0) {
        remainder -= 1;
      }
    }

    potResults.push({
      amount: sidePot.amount,
      winners: potWinnerResults,
      hand: describeHandScore(bestScore)
    });
  }

  const winners = Array.from(payoutMap.entries())
    .map(([id, amount]) => {
      const player = table.players.find((entry) => entry.id === id);
      return { id, name: player.name, amount };
    })
    .sort((left, right) => right.amount - left.amount);

  const names = winners.map((winner) => winner.name).join(", ");
  const bestResult = potResults[0] ? potResults[0].hand : "best hand";

  table.lastHand = {
    kind: "showdown",
    summary:
      winners.length === 1
        ? `${names} won ${winners[0].amount} with ${bestResult}.`
        : `${names} split the pot.`,
    winners,
    potResults,
    handByPlayer: Object.fromEntries(
      contenders.map((player) => [player.id, describeHandScore(handScores.get(player.id))])
    )
  };

  logAction(table, table.lastHand.summary);
  finalizeHand(table);
}

function buildSidePots(table) {
  const contributors = table.players
    .filter((player) => player.totalContribution > 0)
    .sort((left, right) => left.totalContribution - right.totalContribution);

  const levels = [...new Set(contributors.map((player) => player.totalContribution))];
  const sidePots = [];
  let previousLevel = 0;

  for (const level of levels) {
    const involved = contributors.filter((player) => player.totalContribution >= level);
    const amount = (level - previousLevel) * involved.length;
    const eligibleIds = involved.filter((player) => !player.hasFolded).map((player) => player.id);

    if (amount > 0 && eligibleIds.length > 0) {
      sidePots.push({ amount, eligibleIds });
    }

    previousLevel = level;
  }

  return sidePots;
}

function finalizeHand(table) {
  table.pot = 0;
  table.currentBet = 0;
  table.lastRaiseAmount = 0;
  table.lastAggressorId = null;
  table.stage = "waiting";
  table.turnPlayerId = null;
  table.turnDeadlineAt = null;
  table.roundStats = createRoundStats("waiting", 0, 0, 0);

  for (const player of table.players) {
    player.inHand = false;
    player.actedThisStage = false;
    player.currentBet = 0;
    player.isAllIn = false;
  }

  removeMarkedPlayers(table);
}

function resolveTableAfterExternalChange(table) {
  if (table.stage === "waiting") {
    return;
  }

  if (countRemainingPlayers(table) <= 1) {
    finishHandByFold(table);
    return;
  }

  if (isBettingRoundComplete(table)) {
    advanceStage(table);
    return;
  }

  const turnPlayer = table.players.find((player) => player.id === table.turnPlayerId);
  if (turnPlayer && canActOnTurn(turnPlayer)) {
    return;
  }

  const startIndex = turnPlayer ? table.players.findIndex((player) => player.id === turnPlayer.id) : table.dealerIndex;
  const nextActingIndex = findNextIndex(table, startIndex, canActOnTurn);
  setTurnPlayerByIndex(table, nextActingIndex);
}

function removeMarkedPlayers(table) {
  if (table.stage !== "waiting") {
    return;
  }

  for (let index = table.players.length - 1; index >= 0; index -= 1) {
    if (!table.players[index].markedForRemoval) {
      continue;
    }

    table.players.splice(index, 1);
    fixButtonIndexesAfterRemoval(table, index);
  }

  syncHostPlayer(table);
}

function fixButtonIndexesAfterRemoval(table, removedIndex) {
  table.dealerIndex = adjustIndexAfterRemoval(table.dealerIndex, removedIndex);
  table.smallBlindIndex = adjustIndexAfterRemoval(table.smallBlindIndex, removedIndex);
  table.bigBlindIndex = adjustIndexAfterRemoval(table.bigBlindIndex, removedIndex);
}

function adjustIndexAfterRemoval(index, removedIndex) {
  if (index === -1) {
    return -1;
  }

  if (index === removedIndex) {
    return -1;
  }

  if (index > removedIndex) {
    return index - 1;
  }

  return index;
}

function syncHostPlayer(table) {
  const currentHost = table.players.find(
    (player) => player.id === table.hostPlayerId && !player.markedForRemoval
  );

  if (currentHost) {
    return;
  }

  const fallback =
    table.players.find((player) => !player.markedForRemoval && !player.disconnected) ||
    table.players.find((player) => !player.markedForRemoval) ||
    null;

  table.hostPlayerId = fallback ? fallback.id : null;
}

function setTurnPlayerByIndex(table, playerIndex) {
  if (playerIndex === -1 || !table.players[playerIndex]) {
    table.turnPlayerId = null;
    table.turnDeadlineAt = null;
    return;
  }

  table.turnPlayerId = table.players[playerIndex].id;
  table.turnDeadlineAt = Date.now() + table.turnTimeLimitSeconds * 1000;
}

function syncTable(table) {
  cleanupInactivePlayers(table);
  syncHostPlayer(table);

  while (processTurnTimeout(table)) {
    cleanupInactivePlayers(table);
    syncHostPlayer(table);
  }
}

function processTurnTimeout(table) {
  if (!table.gameStarted || table.stage === "waiting" || !table.turnPlayerId || !table.turnDeadlineAt) {
    return false;
  }

  if (Date.now() < table.turnDeadlineAt) {
    return false;
  }

  const player = table.players.find((entry) => entry.id === table.turnPlayerId);
  if (!player || !canActOnTurn(player)) {
    table.turnDeadlineAt = null;
    resolveTableAfterExternalChange(table);
    return true;
  }

  const toCall = Math.max(0, table.currentBet - player.currentBet);
  if (toCall === 0) {
    player.actedThisStage = true;
    player.lastAction = "Timed out and checked";
    logAction(table, `${player.name} timed out and checked.`);
  } else {
    player.hasFolded = true;
    player.actedThisStage = true;
    player.lastAction = "Timed out and folded";
    logAction(table, `${player.name} timed out and folded.`);
  }

  completeTurn(table, player.id);
  return true;
}

function findNextIndex(table, startIndex, predicate) {
  if (table.players.length === 0) {
    return -1;
  }

  let currentIndex = startIndex;
  for (let visited = 0; visited < table.players.length; visited += 1) {
    currentIndex = nextIndex(table.players.length, currentIndex);
    const player = table.players[currentIndex];
    if (predicate(player)) {
      return currentIndex;
    }
  }

  return -1;
}

function nextIndex(length, currentIndex) {
  if (length === 0) {
    return -1;
  }

  return (currentIndex + 1 + length) % length;
}

function getEligibleIndexes(table, predicate) {
  return table.players
    .map((player, index) => ({ player, index }))
    .filter(({ player }) => predicate(player))
    .map(({ index }) => index);
}

function canActOnTurn(player) {
  return player.inHand && !player.hasFolded && !player.isAllIn;
}

function syncRoundStats(table) {
  table.roundStats.stage = table.stage;
  table.roundStats.stageLabel = titleCase(table.stage);
  table.roundStats.pot = table.pot;
  table.roundStats.currentBet = table.currentBet;
  table.roundStats.lastRaiseAmount = table.lastRaiseAmount;
}

function logAction(table, text) {
  table.actionLog.unshift({
    text,
    at: new Date().toISOString()
  });
  table.actionLog = table.actionLog.slice(0, 24);
}

function drawCard(table) {
  const card = table.deck.pop();
  if (!card) {
    throw new Error("Deck is empty.");
  }

  return card;
}

function createDeck() {
  const deck = [];

  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }

  return deck;
}

function shuffle(deck) {
  const items = deck.slice();

  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }

  return items;
}

function getClientState(table, viewer) {
  syncTable(table);
  syncRoundStats(table);
  const eligiblePlayers = getEligibleIndexes(table, canJoinHand).length;

  return {
    view: table.gameStarted ? "table" : "lobby",
    table: {
      gameCode: table.gameCode,
      hostPlayerId: table.hostPlayerId,
      gameStarted: table.gameStarted,
      turnTimeLimitSeconds: table.turnTimeLimitSeconds,
      turnDeadlineAt: table.turnDeadlineAt,
      maxPlayers: MAX_PLAYERS,
      stage: table.stage,
      handNumber: table.handNumber,
      communityCards: table.communityCards.map(toClientCard),
      pot: table.pot,
      smallBlind: SMALL_BLIND,
      bigBlind: BIG_BLIND,
      dealerId: table.players[table.dealerIndex] ? table.players[table.dealerIndex].id : null,
      turnPlayerId: table.turnPlayerId,
      canStart: table.stage === "waiting" && eligiblePlayers >= 2,
      roundStats: {
        ...table.roundStats,
        playersRemaining: countRemainingPlayers(table),
        activePlayers: table.players.filter((player) => player.inHand && !player.hasFolded && !player.isAllIn).length
      },
      actionLog: table.actionLog,
      lastHand: table.lastHand,
      players: table.players.map((player, index) => {
        const revealCards =
          player.id === viewer.id ||
          (table.lastHand && table.lastHand.kind === "showdown" && !player.hasFolded);

        return {
          id: player.id,
          name: player.name,
          chips: player.chips,
          connected: !player.disconnected,
          inHand: player.inHand,
          hasFolded: player.hasFolded,
          isAllIn: player.isAllIn,
          currentBet: player.currentBet,
          totalContribution: player.totalContribution,
          lastAction: player.lastAction,
          isHost: player.id === table.hostPlayerId,
          isDealer: index === table.dealerIndex,
          isSmallBlind: index === table.smallBlindIndex,
          isBigBlind: index === table.bigBlindIndex,
          isTurn: player.id === table.turnPlayerId,
          cards: revealCards ? player.holeCards.map(toClientCard) : [],
          cardsHidden: !revealCards && player.holeCards.length > 0,
          showdownHand:
            table.lastHand && table.lastHand.handByPlayer ? table.lastHand.handByPlayer[player.id] || null : null
        };
      })
    },
    you: buildViewerState(table, viewer)
  };
}

function buildViewerState(table, viewer) {
  const toCall = Math.max(0, table.currentBet - viewer.currentBet);
  const maxBet = viewer.currentBet + viewer.chips;
  const minRaiseTo = table.currentBet === 0 ? BIG_BLIND : table.currentBet + table.minRaise;
  const canStart = getEligibleIndexes(table, canJoinHand).length >= 2;
  const canRaise =
    table.gameStarted &&
    table.stage !== "waiting" &&
    table.turnPlayerId === viewer.id &&
    viewer.inHand &&
    !viewer.hasFolded &&
    !viewer.isAllIn &&
    maxBet >= minRaiseTo;

  return {
    id: viewer.id,
    name: viewer.name,
    isHost: table.hostPlayerId === viewer.id,
    chips: viewer.chips,
    cards: viewer.holeCards.map(toClientCard),
    toCall,
    minRaiseTo,
    maxBet,
    isTurn: table.turnPlayerId === viewer.id,
    availableActions: {
      startGame:
        !table.gameStarted &&
        table.hostPlayerId === viewer.id &&
        table.stage === "waiting" &&
        canStart,
      startHand:
        table.gameStarted &&
        table.hostPlayerId === viewer.id &&
        table.stage === "waiting" &&
        canStart,
      fold:
        table.gameStarted &&
        table.stage !== "waiting" &&
        table.turnPlayerId === viewer.id &&
        viewer.inHand &&
        !viewer.hasFolded &&
        !viewer.isAllIn,
      check:
        table.gameStarted &&
        table.stage !== "waiting" &&
        table.turnPlayerId === viewer.id &&
        viewer.inHand &&
        !viewer.hasFolded &&
        !viewer.isAllIn &&
        toCall === 0,
      call:
        table.gameStarted &&
        table.stage !== "waiting" &&
        table.turnPlayerId === viewer.id &&
        viewer.inHand &&
        !viewer.hasFolded &&
        !viewer.isAllIn &&
        toCall > 0,
      raise: canRaise,
      allIn:
        table.gameStarted &&
        table.stage !== "waiting" &&
        table.turnPlayerId === viewer.id &&
        viewer.inHand &&
        !viewer.hasFolded &&
        !viewer.isAllIn &&
        viewer.chips > 0,
      rebuy: table.stage === "waiting" && viewer.chips <= 0,
      leave: true
    }
  };
}

function toClientCard(card) {
  return {
    rank: rankLabel(card.rank),
    suit: card.suit,
    suitSymbol: SUIT_SYMBOLS[card.suit],
    isRed: card.suit === "H" || card.suit === "D",
    value: `${rankLabel(card.rank)}${SUIT_SYMBOLS[card.suit]}`
  };
}

function rankLabel(rank) {
  if (rank <= 9) {
    return String(rank);
  }

  if (rank === 10) {
    return "10";
  }

  if (rank === 11) {
    return "J";
  }

  if (rank === 12) {
    return "Q";
  }

  if (rank === 13) {
    return "K";
  }

  return "A";
}

function orderPlayersFromDealer(table, players) {
  const playerIds = new Set(players.map((player) => player.id));
  const ordered = [];
  let index = table.dealerIndex;

  for (let visited = 0; visited < table.players.length; visited += 1) {
    index = nextIndex(table.players.length, index);
    const candidate = table.players[index];
    if (candidate && playerIds.has(candidate.id)) {
      ordered.push(candidate);
    }
  }

  return ordered;
}

function evaluateSevenCardHand(cards) {
  if (cards.length < 5) {
    throw new Error("At least five cards are required.");
  }

  let best = null;

  for (let first = 0; first < cards.length - 4; first += 1) {
    for (let second = first + 1; second < cards.length - 3; second += 1) {
      for (let third = second + 1; third < cards.length - 2; third += 1) {
        for (let fourth = third + 1; fourth < cards.length - 1; fourth += 1) {
          for (let fifth = fourth + 1; fifth < cards.length; fifth += 1) {
            const score = evaluateFiveCardHand([
              cards[first],
              cards[second],
              cards[third],
              cards[fourth],
              cards[fifth]
            ]);

            if (!best || compareHandScores(score, best) > 0) {
              best = score;
            }
          }
        }
      }
    }
  }

  return best;
}

function evaluateFiveCardHand(cards) {
  const ranks = cards.map((card) => card.rank).sort((left, right) => right - left);
  const counts = new Map();
  const suitCounts = new Map();

  for (const card of cards) {
    counts.set(card.rank, (counts.get(card.rank) || 0) + 1);
    suitCounts.set(card.suit, (suitCounts.get(card.suit) || 0) + 1);
  }

  const groups = Array.from(counts.entries()).sort((left, right) => {
    if (right[1] !== left[1]) {
      return right[1] - left[1];
    }

    return right[0] - left[0];
  });

  const isFlush = suitCounts.size === 1;
  const straightHigh = getStraightHigh(ranks);

  if (isFlush && straightHigh) {
    return { category: 8, tiebreak: [straightHigh] };
  }

  if (groups[0][1] === 4) {
    return { category: 7, tiebreak: [groups[0][0], groups[1][0]] };
  }

  if (groups[0][1] === 3 && groups[1][1] === 2) {
    return { category: 6, tiebreak: [groups[0][0], groups[1][0]] };
  }

  if (isFlush) {
    return { category: 5, tiebreak: ranks };
  }

  if (straightHigh) {
    return { category: 4, tiebreak: [straightHigh] };
  }

  if (groups[0][1] === 3) {
    const kickers = groups.slice(1).map((group) => group[0]).sort((left, right) => right - left);
    return { category: 3, tiebreak: [groups[0][0], ...kickers] };
  }

  if (groups[0][1] === 2 && groups[1][1] === 2) {
    const pairRanks = groups
      .slice(0, 2)
      .map((group) => group[0])
      .sort((left, right) => right - left);
    const kicker = groups[2][0];
    return { category: 2, tiebreak: [...pairRanks, kicker] };
  }

  if (groups[0][1] === 2) {
    const kickers = groups.slice(1).map((group) => group[0]).sort((left, right) => right - left);
    return { category: 1, tiebreak: [groups[0][0], ...kickers] };
  }

  return { category: 0, tiebreak: ranks };
}

function getStraightHigh(ranks) {
  const unique = [...new Set(ranks)].sort((left, right) => left - right);
  if (unique.includes(14)) {
    unique.unshift(1);
  }

  let streak = 1;
  let bestHigh = null;

  for (let index = 1; index < unique.length; index += 1) {
    if (unique[index] === unique[index - 1] + 1) {
      streak += 1;
      if (streak >= 5) {
        bestHigh = unique[index];
      }
    } else {
      streak = 1;
    }
  }

  return bestHigh;
}

function compareHandScores(left, right) {
  if (left.category !== right.category) {
    return left.category - right.category;
  }

  const length = Math.max(left.tiebreak.length, right.tiebreak.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left.tiebreak[index] || 0;
    const rightValue = right.tiebreak[index] || 0;
    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }

  return 0;
}

function describeHandScore(score) {
  switch (score.category) {
    case 8:
      return score.tiebreak[0] === 14
        ? "Royal flush"
        : `${rankName(score.tiebreak[0])}-high straight flush`;
    case 7:
      return `Four of a kind, ${rankPlural(score.tiebreak[0])}`;
    case 6:
      return `Full house, ${rankPlural(score.tiebreak[0])} over ${rankPlural(score.tiebreak[1])}`;
    case 5:
      return `Flush, ${rankName(score.tiebreak[0])} high`;
    case 4:
      return `${rankName(score.tiebreak[0])}-high straight`;
    case 3:
      return `Three of a kind, ${rankPlural(score.tiebreak[0])}`;
    case 2:
      return `Two pair, ${rankPlural(score.tiebreak[0])} and ${rankPlural(score.tiebreak[1])}`;
    case 1:
      return `Pair of ${rankPlural(score.tiebreak[0])}`;
    default:
      return `${rankName(score.tiebreak[0])} high`;
  }
}

function rankName(rank) {
  const names = {
    2: "Two",
    3: "Three",
    4: "Four",
    5: "Five",
    6: "Six",
    7: "Seven",
    8: "Eight",
    9: "Nine",
    10: "Ten",
    11: "Jack",
    12: "Queen",
    13: "King",
    14: "Ace"
  };

  return names[rank];
}

function rankPlural(rank) {
  const plurals = {
    2: "Twos",
    3: "Threes",
    4: "Fours",
    5: "Fives",
    6: "Sixes",
    7: "Sevens",
    8: "Eights",
    9: "Nines",
    10: "Tens",
    11: "Jacks",
    12: "Queens",
    13: "Kings",
    14: "Aces"
  };

  return plurals[rank];
}

module.exports = {
  BIG_BLIND,
  SMALL_BLIND,
  STARTING_CHIPS,
  applyAction,
  authenticate,
  cleanupInactivePlayers,
  createTable,
  getClientState,
  joinPlayer
};
