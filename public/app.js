const SESSION_KEY = "simple-poker-session-v3";
const POLL_INTERVAL_MS = 1000;
const RAISE_STEP = 10;

let session = loadSession();
let state = null;
let pollHandle = null;
let timerHandle = null;
let raiseDrawerOpen = false;

const rotateOverlay = document.getElementById("rotate-overlay");
const homeView = document.getElementById("home-view");
const lobbyView = document.getElementById("lobby-view");
const tableView = document.getElementById("table-view");

const homeName = document.getElementById("home-name");
const homePin = document.getElementById("home-pin");
const turnTimeSelect = document.getElementById("turn-time-select");
const joinGameCode = document.getElementById("join-game-code");
const createGameButton = document.getElementById("create-game-button");
const joinGameButton = document.getElementById("join-game-button");
const homeError = document.getElementById("home-error");

const lobbyGameCode = document.getElementById("lobby-game-code");
const lobbyTurnLimit = document.getElementById("lobby-turn-limit");
const lobbyPlayerCount = document.getElementById("lobby-player-count");
const lobbyPlayers = document.getElementById("lobby-players");
const lobbyNote = document.getElementById("lobby-note");
const lobbyError = document.getElementById("lobby-error");
const copyGameCodeButton = document.getElementById("copy-game-code-button");
const shareGameCodeButton = document.getElementById("share-game-code-button");
const startGameButton = document.getElementById("start-game-button");
const leaveLobbyButton = document.getElementById("leave-lobby-button");

const statusLine = document.getElementById("status-line");
const tableGameCode = document.getElementById("table-game-code");
const tableTurnLimit = document.getElementById("table-turn-limit");
const turnTimerLabel = document.getElementById("turn-timer-label");
const potValue = document.getElementById("pot-value");
const communityCards = document.getElementById("community-cards");
const youName = document.getElementById("you-name");
const youChips = document.getElementById("you-chips");
const yourCards = document.getElementById("your-cards");
const playersGrid = document.getElementById("players-grid");
const actionError = document.getElementById("action-error");
const lastHandSummary = document.getElementById("last-hand-summary");
const lastHandWinners = document.getElementById("last-hand-winners");
const recentActions = document.getElementById("recent-actions");

const startHandButton = document.getElementById("start-hand-button");
const leaveTableButton = document.getElementById("leave-table-button");
const quickActions = document.getElementById("quick-actions");
const raiseDrawer = document.getElementById("raise-drawer");
const raiseInput = document.getElementById("raise-input");
const raiseMinusButton = document.getElementById("raise-minus-button");
const raisePlusButton = document.getElementById("raise-plus-button");
const raiseConfirmButton = document.getElementById("raise-confirm-button");
const raiseCancelButton = document.getElementById("raise-cancel-button");

joinGameCode.addEventListener("input", () => {
  joinGameCode.value = normalizeGameCode(joinGameCode.value);
});

homePin.addEventListener("input", () => {
  homePin.value = normalizePersonalPin(homePin.value);
});

createGameButton.addEventListener("click", () => {
  tryLockLandscape();
  createGame();
});
joinGameButton.addEventListener("click", () => {
  tryLockLandscape();
  joinGame();
});
copyGameCodeButton.addEventListener("click", copyGameCode);
shareGameCodeButton.addEventListener("click", shareGameCode);
startGameButton.addEventListener("click", () => {
  tryLockLandscape();
  sendAction("startGame", undefined, "lobby");
});
leaveLobbyButton.addEventListener("click", leaveGame);
startHandButton.addEventListener("click", () => {
  tryLockLandscape();
  sendAction("startHand");
});
leaveTableButton.addEventListener("click", leaveGame);
raiseMinusButton.addEventListener("click", () => nudgeRaiseAmount(-RAISE_STEP));
raisePlusButton.addEventListener("click", () => nudgeRaiseAmount(RAISE_STEP));
raiseConfirmButton.addEventListener("click", submitRaiseAction);
raiseCancelButton.addEventListener("click", closeRaiseDrawer);

if (window.addEventListener) {
  window.addEventListener("resize", updateOrientationNotice);
  window.addEventListener("orientationchange", updateOrientationNotice);
}

boot();

function boot() {
  prefillJoinCodeFromUrl();
  if (!session || !session.gameCode || !session.playerId || !session.token) {
    clearSession();
    showHome();
    return;
  }

  startPolling();
  refreshState();
}

async function createGame() {
  homeError.textContent = "";
  const name = homeName.value.trim();
  const personalPin = normalizePersonalPin(homePin.value);
  const turnTimeLimitSeconds = Number(turnTimeSelect.value);

  if (!name) {
    homeError.textContent = "Enter your name.";
    return;
  }

  if (personalPin.length !== 4) {
    homeError.textContent = "Enter a 4-digit personal PIN.";
    return;
  }

  try {
    const response = await request("/api/create-game", {
      method: "POST",
      body: JSON.stringify({ name, personalPin, turnTimeLimitSeconds })
    });

    session = response;
    saveSession(session);
    startPolling();
    await refreshState();
  } catch (error) {
    homeError.textContent = error.message;
  }
}

async function joinGame() {
  homeError.textContent = "";
  const name = homeName.value.trim();
  const personalPin = normalizePersonalPin(homePin.value);
  const gameCode = normalizeGameCode(joinGameCode.value);

  if (!name) {
    homeError.textContent = "Enter your name.";
    return;
  }

  if (personalPin.length !== 4) {
    homeError.textContent = "Enter a 4-digit personal PIN.";
    return;
  }

  if (!gameCode) {
    homeError.textContent = "Enter a game pin.";
    return;
  }

  joinGameCode.value = gameCode;

  try {
    const response = await request("/api/join-game", {
      method: "POST",
      body: JSON.stringify({ name, personalPin, gameCode })
    });

    session = response;
    saveSession(session);
    startPolling();
    await refreshState();
  } catch (error) {
    homeError.textContent = error.message;
  }
}

async function copyGameCode() {
  if (!state) {
    return;
  }

  const code = state.table.gameCode;

  try {
    await navigator.clipboard.writeText(code);
    lobbyError.textContent = "Game pin copied.";
  } catch (error) {
    lobbyError.textContent = `Copy this pin: ${code}`;
  }
}

async function shareGameCode() {
  if (!state) {
    return;
  }

  const gameUrl = buildGameInviteUrl(state.table.gameCode);
  const inviteText = `Join my Simple Poker game with code ${state.table.gameCode}.`;

  try {
    if (navigator.share) {
      await navigator.share({
        title: "Simple Poker",
        text: inviteText,
        url: gameUrl
      });
      lobbyError.textContent = "Invite shared.";
      return;
    }

    await navigator.clipboard.writeText(`${inviteText} ${gameUrl}`);
    lobbyError.textContent = "Invite copied.";
  } catch (error) {
    lobbyError.textContent = `Share this code: ${state.table.gameCode}`;
  }
}

async function leaveGame() {
  if (!session) {
    showHome();
    return;
  }

  try {
    await sendAction("leave", undefined, state && state.view === "lobby" ? "lobby" : "table", true);
  } catch (error) {
    // Ignore server-side leave failures and clear the local session.
  }

  clearStateAndSession();
  showHome();
}

function showHome() {
  homeView.hidden = false;
  lobbyView.hidden = true;
  tableView.hidden = true;
  raiseDrawerOpen = false;
  stopTurnTimer();
  updateOrientationNotice();
}

function showLobby() {
  homeView.hidden = true;
  lobbyView.hidden = false;
  tableView.hidden = true;
  raiseDrawerOpen = false;
  stopTurnTimer();
  updateOrientationNotice();
}

function showTable() {
  homeView.hidden = true;
  lobbyView.hidden = true;
  tableView.hidden = false;
  updateOrientationNotice();
}

function startPolling() {
  stopPolling();
  pollHandle = window.setInterval(refreshState, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollHandle) {
    window.clearInterval(pollHandle);
    pollHandle = null;
  }
}

async function refreshState() {
  if (!session) {
    return;
  }

  try {
    const nextState = await request(
      `/api/state?gameCode=${encodeURIComponent(session.gameCode)}&playerId=${encodeURIComponent(session.playerId)}&token=${encodeURIComponent(session.token)}`
    );
    state = nextState;
    syncGameCodeInUrl(nextState.table.gameCode);
    render();
    homeError.textContent = "";
    lobbyError.textContent = "";
    actionError.textContent = "";
  } catch (error) {
    if (error.status === 401 || error.status === 404) {
      clearStateAndSession();
      showHome();
      homeError.textContent = error.status === 404
        ? "That game is no longer available."
        : "That seat needs you to sign in again.";
      return;
    }

    if (state && state.view === "table") {
      actionError.textContent = error.message;
    } else if (state && state.view === "lobby") {
      lobbyError.textContent = error.message;
    } else {
      homeError.textContent = error.message;
    }
  }
}

async function sendAction(action, amount, context = "table", suppressRender = false, extra = {}) {
  if (!session) {
    return;
  }

  if (context === "table") {
    actionError.textContent = "";
  } else if (context === "lobby") {
    lobbyError.textContent = "";
  }

  try {
    const response = await request("/api/action", {
      method: "POST",
      body: JSON.stringify({
        gameCode: session.gameCode,
        playerId: session.playerId,
        token: session.token,
        action,
        amount,
        targetPlayerId: extra.targetPlayerId
      })
    });

    if (!suppressRender) {
      state = response;
      render();
    }
  } catch (error) {
    if (error.status === 401 || error.status === 404) {
      clearStateAndSession();
      showHome();
      homeError.textContent = error.status === 404
        ? "That game is no longer available."
        : "That seat needs you to sign in again.";
      return;
    }

    if (context === "lobby") {
      lobbyError.textContent = error.message;
    } else {
      actionError.textContent = error.message;
    }
    throw error;
  }
}

function render() {
  if (!state) {
    return;
  }

  if (state.view === "lobby") {
    renderLobby(state.table, state.you);
    showLobby();
    return;
  }

  renderTable(state.table, state.you);
  showTable();
}

function tryLockLandscape() {
  if (typeof window === "undefined" || !window.screen || !window.screen.orientation) {
    return;
  }

  if (window.innerWidth > 900 || typeof window.screen.orientation.lock !== "function") {
    return;
  }

  window.screen.orientation.lock("landscape").catch(() => {});
}

function updateOrientationNotice() {
  if (!rotateOverlay) {
    return;
  }

  rotateOverlay.hidden = true;
}

function renderLobby(table, you) {
  syncGameCodeInUrl(table.gameCode);
  lobbyGameCode.textContent = table.gameCode;
  lobbyTurnLimit.textContent = formatTurnLimit(table.turnTimeLimitSeconds);
  lobbyPlayerCount.textContent = `${table.players.length} / ${table.maxPlayers}`;
  lobbyPlayers.innerHTML = "";

  for (const player of table.players) {
    const row = document.createElement("article");
    row.className = "lobby-player-row";
    if (!player.connected) {
      row.classList.add("is-disconnected");
    }

    const status = [];
    if (player.isHost) {
      status.push("Host");
    }
    if (player.id === you.id) {
      status.push("You");
    }
    if (!player.connected) {
      status.push("Away");
    } else if (!player.isBoughtOut) {
      status.push("Ready");
    }
    if (player.isBoughtOut) {
      status.push("Bought out");
    }

    row.innerHTML = `
      <span class="player-name">${escapeHtml(player.name)}</span>
      <span class="player-status-badges">${renderBadgeMarkup(status, "soft") || '<span class="status-badge status-badge-soft">Waiting</span>'}</span>
    `;
    lobbyPlayers.appendChild(row);
  }

  startGameButton.disabled = !you.availableActions.startGame;
  startGameButton.hidden = !you.isHost;
  const readyPlayers = table.players.filter((player) => player.connected && !player.isBoughtOut).length;

  if (!you.isHost) {
    lobbyNote.textContent = "Waiting for the host to start the game.";
  } else if (readyPlayers < 2) {
    lobbyNote.textContent = "At least two players are needed to start.";
  } else {
    lobbyNote.textContent = `${readyPlayers} players are ready. Start when you want.`;
  }
}

function renderTable(table, you) {
  syncGameCodeInUrl(table.gameCode);
  const actingPlayer = table.players.find((player) => player.id === table.turnPlayerId);

  statusLine.textContent = buildStatusLine(table, you, actingPlayer);
  statusLine.classList.toggle("is-your-turn", Boolean(you.isTurn));
  tableGameCode.textContent = table.gameCode;
  tableTurnLimit.textContent = formatTurnLimit(table.turnTimeLimitSeconds);
  potValue.textContent = formatChips(table.pot);
  youName.textContent = you.name;
  youChips.textContent = `${formatChips(you.chips)} chips`;

  renderCards(communityCards, table.communityCards, { fillerCount: Math.max(0, 5 - table.communityCards.length) });
  renderCards(yourCards, you.cards, { fillerCount: Math.max(0, 2 - you.cards.length) });
  renderTablePlayers(table.players, you, table);
  renderControls(you, table);
  renderSupportPanels(table);
  renderTurnTimer(table);
}

function renderTablePlayers(players, viewer, table) {
  playersGrid.innerHTML = "";

  for (const player of players) {
    const row = document.createElement("article");
    row.className = "player-row";

    if (player.isTurn) {
      row.classList.add("is-turn");
    }
    if (player.hasFolded) {
      row.classList.add("is-folded");
    }
    if (!player.connected) {
      row.classList.add("is-disconnected");
    }
    if (player.isBoughtOut) {
      row.classList.add("is-bought-out");
    }

    const status = [];
    if (player.id === viewer.id) {
      status.push("You");
    }
    if (player.isHost) {
      status.push("Host");
    }
    if (player.isDealer) {
      status.push("D");
    }
    if (player.isSmallBlind) {
      status.push("SB");
    }
    if (player.isBigBlind) {
      status.push("BB");
    }
    if (player.isAllIn) {
      status.push("All-in");
    }
    if (player.isTurn) {
      status.push("Turn");
    }
    if (!player.connected) {
      status.push("Away");
    }
    if (player.isBoughtOut) {
      status.push("Bought out");
    }

    const canHostBuyOut =
      viewer.isHost &&
      table.stage === "waiting" &&
      player.id !== viewer.id &&
      player.connected === false &&
      player.isBoughtOut === false;

    const noteContent = canHostBuyOut
      ? `${escapeHtml(player.showdownHand || player.lastAction)} <button class="table-mini-button" data-action="host-buyout" data-player-id="${player.id}">Buy Out</button>`
      : escapeHtml(player.showdownHand || player.lastAction);

    row.innerHTML = `
      <div class="player-row-main">
        <div class="player-row-identity">
          <span class="player-name">${escapeHtml(player.name)}</span>
          <span class="player-chip-stack">${formatChips(player.chips)} chips</span>
        </div>
        <div class="player-status-badges">${renderBadgeMarkup(status, player.isTurn ? "gold" : "soft") || '<span class="status-badge status-badge-soft">Waiting</span>'}</div>
      </div>
      <div class="player-row-foot">
        <div class="player-mini-stats">
          <span>Round ${formatChips(player.currentBet)}</span>
          <span>Total ${formatChips(player.totalContribution)}</span>
        </div>
        <div class="player-note">${noteContent}</div>
      </div>
    `;

    playersGrid.appendChild(row);
  }

  for (const button of playersGrid.querySelectorAll("[data-action='host-buyout']")) {
    button.addEventListener("click", () => {
      sendAction("buyOut", undefined, "table", false, { targetPlayerId: button.dataset.playerId });
    });
  }
}

function renderControls(you, table) {
  startHandButton.disabled = !you.availableActions.startHand;
  startHandButton.hidden = !you.isHost;
  const actions = buildActionItems(you);

  quickActions.innerHTML = actions.length
    ? actions.map((action) => (
      `<button class="action-chip ${action.kind}" type="button" data-action="${action.value}">${escapeHtml(action.label)}</button>`
    )).join("")
    : '<span class="controls-empty">No action right now.</span>';

  for (const button of quickActions.querySelectorAll("[data-action]")) {
    button.addEventListener("click", () => handleQuickAction(button.dataset.action));
  }

  raiseInput.min = String(you.minRaiseTo);
  raiseInput.max = String(you.maxBet);
  raiseInput.step = String(RAISE_STEP);

  if (!you.availableActions.raise) {
    raiseDrawerOpen = false;
  }

  if (raiseDrawerOpen && you.availableActions.raise) {
    raiseDrawer.hidden = false;
    syncRaiseInputBounds(you);
  } else {
    raiseDrawer.hidden = true;
  }
}

function buildActionItems(you) {
  const actions = [];
  if (you.availableActions.check) {
    actions.push({ value: "check", label: "Check", kind: "action-chip-primary" });
  }

  if (you.availableActions.call) {
    actions.push({ value: "call", label: `Call ${formatChips(you.toCall)}`, kind: "action-chip-primary" });
  }

  if (you.availableActions.raise) {
    actions.push({ value: "raise", label: "Raise", kind: "action-chip-secondary" });
  }

  if (you.availableActions.fold) {
    actions.push({ value: "fold", label: "Fold", kind: "action-chip-danger" });
  }

  if (you.availableActions.allIn) {
    actions.push({ value: "allIn", label: "All In", kind: "action-chip-secondary" });
  }

  if (you.availableActions.rebuy) {
    actions.push({ value: "rebuy", label: "Rebuy 1000", kind: "action-chip-secondary" });
  }

  if (you.availableActions.buyOut) {
    actions.push({ value: "buyOut", label: "Buy Out", kind: "action-chip-secondary" });
  }

  return actions;
}

function handleQuickAction(action) {
  if (!state || !state.you) {
    return;
  }

  actionError.textContent = "";

  if (action === "raise") {
    openRaiseDrawer();
    return;
  }

  if (action === "buyOut") {
    sendAction(action).then(() => {
      clearStateAndSession();
      showHome();
    }).catch(() => {});
    return;
  }

  raiseDrawerOpen = false;
  sendAction(action);
}

function openRaiseDrawer() {
  if (!state || !state.you || !state.you.availableActions.raise) {
    return;
  }

  actionError.textContent = "";
  raiseDrawerOpen = true;
  renderControls(state.you, state.table);
}

function closeRaiseDrawer() {
  actionError.textContent = "";
  raiseDrawerOpen = false;
  if (state && state.you) {
    renderControls(state.you, state.table);
  }
}

function syncRaiseInputBounds(you) {
  const currentValue = Number(raiseInput.value);
  if (!Number.isFinite(currentValue) || currentValue < you.minRaiseTo || currentValue > you.maxBet) {
    raiseInput.value = String(you.minRaiseTo);
  }
}

function nudgeRaiseAmount(delta) {
  if (!state || !state.you || !state.you.availableActions.raise) {
    return;
  }

  syncRaiseInputBounds(state.you);
  const currentValue = Number(raiseInput.value) || state.you.minRaiseTo;
  const nextValue = Math.max(state.you.minRaiseTo, Math.min(state.you.maxBet, currentValue + delta));
  raiseInput.value = String(nextValue);
}

function submitRaiseAction() {
  if (!state || !state.you || !state.you.availableActions.raise) {
    return;
  }

  const amount = Number(raiseInput.value);
  if (!Number.isFinite(amount)) {
    actionError.textContent = "Enter a raise amount.";
    return;
  }

  raiseDrawerOpen = false;
  sendAction("raise", amount).catch(() => {
    raiseDrawerOpen = true;
    if (state && state.you) {
      renderControls(state.you, state.table);
    }
  });
}

function renderTurnTimer(table) {
  stopTurnTimer();

  if (!table.turnDeadlineAt || table.stage === "waiting") {
    turnTimerLabel.textContent = "No active timer";
    turnTimerLabel.classList.remove("is-live", "is-urgent");
    return;
  }

  updateTurnTimer(table.turnDeadlineAt);
  timerHandle = window.setInterval(() => updateTurnTimer(table.turnDeadlineAt), 1000);
}

function updateTurnTimer(deadlineAt) {
  const remainingMs = Math.max(0, Number(deadlineAt) - Date.now());
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  turnTimerLabel.textContent = `Turn time left ${minutes}:${String(seconds).padStart(2, "0")}`;
  turnTimerLabel.classList.add("is-live");
  turnTimerLabel.classList.toggle("is-urgent", totalSeconds <= 15);
}

function stopTurnTimer() {
  if (timerHandle) {
    window.clearInterval(timerHandle);
    timerHandle = null;
  }
}

function buildStatusLine(table, you, actingPlayer) {
  if (table.stage === "waiting") {
    const readyPlayers = table.players.filter((player) => player.connected && !player.isBoughtOut).length;
    if (readyPlayers < 2) {
      return "Waiting for at least two ready players.";
    }

    if (you.isBoughtOut) {
      return "You are bought out for the next hand. Rejoin with your name and PIN to sit back in.";
    }

    if (you.isHost && you.availableActions.startHand) {
      return "Ready for the next hand.";
    }

    return "Waiting for the host to start the next hand.";
  }

  if (you.isTurn) {
    return you.toCall > 0
      ? `Your turn. Call ${formatChips(you.toCall)}, raise, or fold.`
      : "Your turn. You can check or bet.";
  }

  if (actingPlayer) {
    return `${actingPlayer.name}'s turn.`;
  }

  return "Hand in progress.";
}

function renderSupportPanels(table) {
  renderLastHand(table.lastHand);
  renderRecentActions(table.actionLog || []);
}

function renderLastHand(lastHand) {
  if (!lastHand) {
    lastHandSummary.textContent = "No hand finished yet.";
    lastHandWinners.innerHTML = "";
    return;
  }

  lastHandSummary.textContent = lastHand.summary;
  lastHandWinners.innerHTML = (lastHand.winners || [])
    .map((winner) => `<span class="winner-pill">${escapeHtml(winner.name)} +${formatChips(winner.amount)}</span>`)
    .join("");
}

function renderRecentActions(actionLog) {
  const items = actionLog.slice(0, 4);
  if (!items.length) {
    recentActions.innerHTML = '<span class="support-empty">No action yet.</span>';
    return;
  }

  recentActions.innerHTML = items
    .map((item) => `<div class="activity-item">${escapeHtml(item.text)}</div>`)
    .join("");
}

function renderCards(container, cards, options = {}) {
  container.innerHTML = renderCardsMarkup(cards, options.fillerCount || 0);
}

function renderCardsMarkup(cards, hiddenCount) {
  const parts = cards.map((card) => {
    const colorClass = card.isRed ? "is-red" : "";
    return `
      <div class="card ${colorClass}">
        <span class="card-rank">${card.rank}</span>
        <span class="card-suit">${card.suitSymbol}</span>
      </div>
    `;
  });

  for (let index = 0; index < hiddenCount; index += 1) {
    parts.push(`
      <div class="card is-hidden">
        <span class="card-back"></span>
      </div>
    `);
  }

  return parts.join("");
}

function renderBadgeMarkup(items, tone = "soft") {
  return items
    .map((item) => `<span class="status-badge status-badge-${tone}">${escapeHtml(item)}</span>`)
    .join("");
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(payload.error || "Request failed.");
    error.status = response.status;
    throw error;
  }

  return payload;
}

function formatTurnLimit(seconds) {
  const value = Number(seconds) || 0;
  if (value < 60) {
    return `${value} seconds`;
  }

  const minutes = value / 60;
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

function prefillJoinCodeFromUrl() {
  if (typeof window === "undefined") {
    return;
  }

  const code = normalizeGameCode(new URLSearchParams(window.location.search).get("game"));
  if (code) {
    joinGameCode.value = code;
  }
}

function syncGameCodeInUrl(gameCode) {
  if (typeof window === "undefined" || !window.history || !window.location) {
    return;
  }

  const code = normalizeGameCode(gameCode);
  if (!code) {
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.set("game", code);
  window.history.replaceState({}, "", url);
}

function buildGameInviteUrl(gameCode) {
  if (typeof window === "undefined" || !window.location) {
    return "";
  }

  const url = new URL(window.location.href);
  url.searchParams.set("game", normalizeGameCode(gameCode));
  return url.toString();
}

function normalizeGameCode(rawValue) {
  return String(rawValue || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
}

function normalizePersonalPin(rawValue) {
  return String(rawValue || "")
    .replace(/\D/g, "")
    .slice(0, 4);
}

function loadSession() {
  const raw = window.sessionStorage.getItem(SESSION_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    window.sessionStorage.removeItem(SESSION_KEY);
    return null;
  }
}

function saveSession(value) {
  window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(value));
}

function clearSession() {
  session = null;
  window.sessionStorage.removeItem(SESSION_KEY);
}

function clearStateAndSession() {
  state = null;
  stopPolling();
  stopTurnTimer();
  clearSession();
}

function formatChips(value) {
  return Number(value || 0).toLocaleString();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
