const SESSION_KEY = "simple-poker-session-v2";
const POLL_INTERVAL_MS = 1000;

let session = loadSession();
let state = null;
let pollHandle = null;
let timerHandle = null;

const rotateOverlay = document.getElementById("rotate-overlay");
const homeView = document.getElementById("home-view");
const lobbyView = document.getElementById("lobby-view");
const tableView = document.getElementById("table-view");

const homeName = document.getElementById("home-name");
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

const startHandButton = document.getElementById("start-hand-button");
const leaveTableButton = document.getElementById("leave-table-button");
const actionSelect = document.getElementById("action-select");
const raiseInput = document.getElementById("raise-input");
const actionSubmitButton = document.getElementById("action-submit-button");

joinGameCode.addEventListener("input", () => {
  joinGameCode.value = normalizeGameCode(joinGameCode.value);
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
actionSelect.addEventListener("change", updateActionInputState);
actionSubmitButton.addEventListener("click", submitSelectedAction);

if (window.addEventListener) {
  window.addEventListener("resize", updateOrientationNotice);
  window.addEventListener("orientationchange", updateOrientationNotice);
}

boot();

function boot() {
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
  const turnTimeLimitSeconds = Number(turnTimeSelect.value);

  if (!name) {
    homeError.textContent = "Enter your name.";
    return;
  }

  try {
    const response = await request("/api/create-game", {
      method: "POST",
      body: JSON.stringify({ name, turnTimeLimitSeconds })
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
  const gameCode = normalizeGameCode(joinGameCode.value);

  if (!name) {
    homeError.textContent = "Enter your name.";
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
      body: JSON.stringify({ name, gameCode })
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
  stopTurnTimer();
  updateOrientationNotice();
}

function showLobby() {
  homeView.hidden = true;
  lobbyView.hidden = false;
  tableView.hidden = true;
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
    render();
    homeError.textContent = "";
    lobbyError.textContent = "";
    actionError.textContent = "";
  } catch (error) {
    if (error.status === 401 || error.status === 404) {
      clearStateAndSession();
      showHome();
      homeError.textContent = error.status === 404 ? "Game not found." : "Your session ended. Join again.";
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

async function sendAction(action, amount, context = "table", suppressRender = false) {
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
        amount
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
      homeError.textContent = error.status === 404 ? "Game not found." : "Your session ended. Join again.";
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

  const isPhoneWidth = typeof window !== "undefined" ? window.innerWidth <= 900 : false;
  const isPortrait = typeof window !== "undefined" ? window.innerHeight > window.innerWidth : false;
  const showOverlay = !tableView.hidden && isPhoneWidth && isPortrait;
  rotateOverlay.hidden = !showOverlay;
}

function renderLobby(table, you) {
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
    }

    row.innerHTML = `
      <span class="player-name">${escapeHtml(player.name)}</span>
      <span class="player-status">${escapeHtml(status.join(", ") || "Waiting")}</span>
    `;
    lobbyPlayers.appendChild(row);
  }

  startGameButton.disabled = !you.availableActions.startGame;
  startGameButton.hidden = !you.isHost;

  if (!you.isHost) {
    lobbyNote.textContent = "Waiting for the host to start the game.";
  } else if (table.players.length < 2) {
    lobbyNote.textContent = "At least two players are needed to start.";
  } else {
    lobbyNote.textContent = "You are the host. Start when everyone is ready.";
  }
}

function renderTable(table, you) {
  const actingPlayer = table.players.find((player) => player.id === table.turnPlayerId);

  statusLine.textContent = buildStatusLine(table, you, actingPlayer);
  tableGameCode.textContent = table.gameCode;
  tableTurnLimit.textContent = formatTurnLimit(table.turnTimeLimitSeconds);
  potValue.textContent = formatChips(table.pot);
  youName.textContent = you.name;
  youChips.textContent = `${formatChips(you.chips)} chips`;

  renderCards(communityCards, table.communityCards, { fillerCount: Math.max(0, 5 - table.communityCards.length) });
  renderCards(yourCards, you.cards, { fillerCount: Math.max(0, 2 - you.cards.length) });
  renderTablePlayers(table.players, you.id);
  renderControls(you);
  renderTurnTimer(table);
}

function renderTablePlayers(players, viewerId) {
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

    const status = [];
    if (player.id === viewerId) {
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

    row.innerHTML = `
      <span class="player-name">${escapeHtml(player.name)}</span>
      <span class="player-status">${escapeHtml(status.join(", ") || "-")}</span>
      <span>${formatChips(player.chips)}</span>
      <span>${formatChips(player.currentBet)}</span>
      <span>${formatChips(player.totalContribution)}</span>
      <span class="player-note">${escapeHtml(player.showdownHand || player.lastAction)}</span>
    `;

    playersGrid.appendChild(row);
  }
}

function renderControls(you) {
  startHandButton.disabled = !you.availableActions.startHand;
  startHandButton.hidden = !you.isHost;
  const options = buildActionOptions(you);
  const previousValue = actionSelect.value;
  actionSelect.innerHTML = options.map((option) => (
    `<option value="${option.value}">${escapeHtml(option.label)}</option>`
  )).join("");

  if (options.some((option) => option.value === previousValue)) {
    actionSelect.value = previousValue;
  }

  actionSelect.disabled = options.length <= 1;
  actionSubmitButton.disabled = options.length <= 1;

  raiseInput.min = String(you.minRaiseTo);
  raiseInput.max = String(you.maxBet);
  updateActionInputState();

  if (actionSelect.value === "raise" && you.availableActions.raise) {
    const currentValue = Number(raiseInput.value);
    if (!Number.isFinite(currentValue) || currentValue < you.minRaiseTo || currentValue > you.maxBet) {
      raiseInput.value = String(you.minRaiseTo);
    }
  } else if (actionSelect.value !== "raise") {
    raiseInput.value = "";
  }
}

function buildActionOptions(you) {
  const options = [{ value: "", label: "Select action" }];

  if (you.availableActions.check) {
    options.push({ value: "check", label: "Check" });
  }

  if (you.availableActions.call) {
    options.push({ value: "call", label: `Call ${formatChips(you.toCall)}` });
  }

  if (you.availableActions.fold) {
    options.push({ value: "fold", label: "Fold" });
  }

  if (you.availableActions.raise) {
    options.push({ value: "raise", label: "Raise" });
  }

  if (you.availableActions.allIn) {
    options.push({ value: "allIn", label: "All In" });
  }

  if (you.availableActions.rebuy) {
    options.push({ value: "rebuy", label: "Rebuy 1000" });
  }

  return options;
}

function updateActionInputState() {
  const selectedAction = actionSelect.value;
  const isRaise = selectedAction === "raise";
  raiseInput.disabled = !isRaise;
  actionSubmitButton.disabled = actionSelect.disabled || !selectedAction;

  if (!isRaise) {
    raiseInput.value = "";
  }
}

function submitSelectedAction() {
  const action = actionSelect.value;
  if (!action) {
    return;
  }

  const amount = action === "raise" ? Number(raiseInput.value) : undefined;
  sendAction(action, amount);
}

function renderTurnTimer(table) {
  stopTurnTimer();

  if (!table.turnDeadlineAt || table.stage === "waiting") {
    turnTimerLabel.textContent = "No active timer";
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
}

function stopTurnTimer() {
  if (timerHandle) {
    window.clearInterval(timerHandle);
    timerHandle = null;
  }
}

function buildStatusLine(table, you, actingPlayer) {
  if (table.stage === "waiting") {
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

function normalizeGameCode(rawValue) {
  return String(rawValue || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
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
