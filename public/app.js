const SESSION_KEY = "simple-poker-session";
const POLL_INTERVAL_MS = 1000;

let session = loadSession();
let state = null;
let pollHandle = null;

const joinView = document.getElementById("join-view");
const tableView = document.getElementById("table-view");
const joinForm = document.getElementById("join-form");
const joinError = document.getElementById("join-error");
const actionError = document.getElementById("action-error");
const statusLine = document.getElementById("status-line");
const playerCount = document.getElementById("player-count");
const streetLabel = document.getElementById("street-label");
const potValue = document.getElementById("pot-value");
const currentBetValue = document.getElementById("current-bet-value");
const toCallValue = document.getElementById("to-call-value");
const lastRaiseValue = document.getElementById("last-raise-value");
const streetTotalValue = document.getElementById("street-total-value");
const communityCards = document.getElementById("community-cards");
const youName = document.getElementById("you-name");
const youChips = document.getElementById("you-chips");
const yourCards = document.getElementById("your-cards");
const playersGrid = document.getElementById("players-grid");
const actionLog = document.getElementById("action-log");
const lastHand = document.getElementById("last-hand");
const raiseInput = document.getElementById("raise-input");
const startHandButton = document.getElementById("start-hand-button");
const leaveTableButton = document.getElementById("leave-table-button");
const checkButton = document.getElementById("check-button");
const callButton = document.getElementById("call-button");
const foldButton = document.getElementById("fold-button");
const raiseButton = document.getElementById("raise-button");
const allInButton = document.getElementById("all-in-button");
const rebuyButton = document.getElementById("rebuy-button");

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  joinError.textContent = "";

  const form = new FormData(joinForm);
  const name = String(form.get("name") || "").trim();

  if (!name) {
    joinError.textContent = "Enter your name.";
    return;
  }

  try {
    const response = await request("/api/join", {
      method: "POST",
      body: JSON.stringify({ name })
    });

    session = response;
    saveSession(session);
    switchToTable();
    startPolling();
    await refreshState();
  } catch (error) {
    joinError.textContent = error.message;
  }
});

startHandButton.addEventListener("click", () => sendAction("startHand"));
checkButton.addEventListener("click", () => sendAction("check"));
callButton.addEventListener("click", () => sendAction("call"));
foldButton.addEventListener("click", () => sendAction("fold"));
raiseButton.addEventListener("click", () => sendAction("raise", Number(raiseInput.value)));
allInButton.addEventListener("click", () => sendAction("allIn"));
rebuyButton.addEventListener("click", () => sendAction("rebuy"));
leaveTableButton.addEventListener("click", async () => {
  if (!session) {
    showJoin();
    return;
  }

  try {
    await sendAction("leave", undefined, { suppressRender: true });
  } catch (error) {
    // Ignore leave failures and clear local session anyway.
  }

  clearSession();
  state = null;
  stopPolling();
  showJoin();
});

boot();

function boot() {
  if (!session) {
    showJoin();
    return;
  }

  switchToTable();
  refreshState();
  startPolling();
}

function showJoin() {
  joinView.hidden = false;
  tableView.hidden = true;
}

function switchToTable() {
  joinView.hidden = true;
  tableView.hidden = false;
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
      `/api/state?playerId=${encodeURIComponent(session.playerId)}&token=${encodeURIComponent(session.token)}`
    );
    state = nextState;
    render();
    actionError.textContent = "";
  } catch (error) {
    if (error.status === 401) {
      clearSession();
      stopPolling();
      showJoin();
      joinError.textContent = "Your session ended. Join the table again.";
      return;
    }

    actionError.textContent = error.message;
  }
}

async function sendAction(action, amount, options = {}) {
  if (!session) {
    return;
  }

  actionError.textContent = "";

  try {
    const response = await request("/api/action", {
      method: "POST",
      body: JSON.stringify({
        playerId: session.playerId,
        token: session.token,
        action,
        amount
      })
    });

    if (!options.suppressRender) {
      state = response;
      render();
    }
  } catch (error) {
    if (error.status === 401) {
      clearSession();
      stopPolling();
      showJoin();
      joinError.textContent = "Your session ended. Join the table again.";
      return;
    }

    actionError.textContent = error.message;
    throw error;
  }
}

function render() {
  if (!state) {
    return;
  }

  const { table, you } = state;
  const actingPlayer = table.players.find((player) => player.id === table.turnPlayerId);

  statusLine.textContent = buildStatusLine(table, you, actingPlayer);
  playerCount.textContent = `${table.players.length} players`;
  streetLabel.textContent = table.roundStats.stageLabel;
  potValue.textContent = formatChips(table.pot);
  currentBetValue.textContent = formatChips(table.roundStats.currentBet);
  toCallValue.textContent = formatChips(you.toCall);
  lastRaiseValue.textContent = formatChips(table.roundStats.lastRaiseAmount);
  streetTotalValue.textContent = formatChips(table.roundStats.streetTotal);
  youName.textContent = you.name;
  youChips.textContent = `${formatChips(you.chips)} chips`;

  renderCards(communityCards, table.communityCards, {
    fillerCount: Math.max(0, 5 - table.communityCards.length)
  });
  renderCards(yourCards, you.cards, { fillerCount: Math.max(0, 2 - you.cards.length) });
  renderPlayers(table.players);
  renderLastHand(table.lastHand);
  renderFeed(table.actionLog);
  renderControls(you);
}

function buildStatusLine(table, you, actingPlayer) {
  if (table.stage === "waiting") {
    if (table.canStart) {
      return "Ready for the next hand.";
    }

    return "Waiting for at least two connected players with chips.";
  }

  if (you.isTurn) {
    return `Your turn. ${you.toCall > 0 ? `Call ${formatChips(you.toCall)}, raise, or fold.` : "You can check or bet."}`;
  }

  if (actingPlayer) {
    return `${actingPlayer.name}'s turn.`;
  }

  return "Hand in progress.";
}

function renderPlayers(players) {
  playersGrid.innerHTML = "";

  for (const player of players) {
    const article = document.createElement("article");
    article.className = "player-card";
    if (player.isTurn) {
      article.classList.add("is-turn");
    }
    if (player.hasFolded) {
      article.classList.add("is-folded");
    }
    if (!player.connected) {
      article.classList.add("is-disconnected");
    }

    const badges = [];
    if (player.isDealer) {
      badges.push("D");
    }
    if (player.isSmallBlind) {
      badges.push("SB");
    }
    if (player.isBigBlind) {
      badges.push("BB");
    }
    if (player.isAllIn) {
      badges.push("All-in");
    }

    article.innerHTML = `
      <div class="player-head">
        <div>
          <h3>${escapeHtml(player.name)}</h3>
          <p>${formatChips(player.chips)} chips</p>
        </div>
        <div class="badge-row">
          ${badges.map((badge) => `<span class="badge">${badge}</span>`).join("")}
        </div>
      </div>
      <div class="mini-stats">
        <span>Bet ${formatChips(player.currentBet)}</span>
        <span>Total ${formatChips(player.totalContribution)}</span>
      </div>
      <div class="player-hand">${renderCardsMarkup(player.cards, player.cardsHidden ? 2 : 0)}</div>
      <p class="player-action">${escapeHtml(player.showdownHand || player.lastAction)}</p>
    `;

    playersGrid.appendChild(article);
  }
}

function renderLastHand(hand) {
  if (!hand) {
    lastHand.className = "last-hand-summary empty-state";
    lastHand.textContent = "No hand finished yet.";
    return;
  }

  const winnings = hand.winners
    .map((winner) => `${winner.name}: ${formatChips(winner.amount)}`)
    .join(" · ");

  const extra =
    hand.kind === "showdown" && Array.isArray(hand.potResults)
      ? hand.potResults
          .map((pot) => `${formatChips(pot.amount)} pot won with ${pot.hand}`)
          .join("<br>")
      : "";

  lastHand.className = "last-hand-summary";
  lastHand.innerHTML = `
    <strong>Last hand</strong>
    <p>${escapeHtml(hand.summary)}</p>
    <p>${escapeHtml(winnings)}</p>
    ${extra ? `<p>${extra}</p>` : ""}
  `;
}

function renderFeed(entries) {
  actionLog.innerHTML = "";

  for (const entry of entries) {
    const item = document.createElement("li");
    item.className = "feed-item";
    item.textContent = entry.text;
    actionLog.appendChild(item);
  }
}

function renderControls(you) {
  setEnabled(startHandButton, you.availableActions.startHand);
  setEnabled(checkButton, you.availableActions.check);
  setEnabled(callButton, you.availableActions.call);
  setEnabled(foldButton, you.availableActions.fold);
  setEnabled(raiseButton, you.availableActions.raise);
  setEnabled(allInButton, you.availableActions.allIn);
  setEnabled(rebuyButton, you.availableActions.rebuy);

  callButton.textContent = you.toCall > 0 ? `Call ${formatChips(you.toCall)}` : "Call";

  if (you.availableActions.raise) {
    raiseInput.disabled = false;
    raiseInput.min = String(you.minRaiseTo);
    raiseInput.max = String(you.maxBet);

    const currentValue = Number(raiseInput.value);
    if (!Number.isFinite(currentValue) || currentValue < you.minRaiseTo || currentValue > you.maxBet) {
      raiseInput.value = String(you.minRaiseTo);
    }
  } else {
    raiseInput.disabled = true;
    raiseInput.value = "";
  }
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

  for (let count = 0; count < hiddenCount; count += 1) {
    parts.push(`
      <div class="card is-hidden">
        <span class="card-back"></span>
      </div>
    `);
  }

  return parts.join("");
}

function setEnabled(button, enabled) {
  button.disabled = !enabled;
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
