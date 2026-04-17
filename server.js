"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const {
  applyAction,
  authenticate,
  createTable,
  getClientState,
  joinPlayer
} = require("./game");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const games = new Map();

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (requestUrl.pathname.startsWith("/api/")) {
      await handleApiRequest(req, res, requestUrl);
      return;
    }

    await serveStaticFile(res, requestUrl.pathname);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Server error." });
  }
});

async function handleApiRequest(req, res, requestUrl) {
  if (req.method === "POST" && requestUrl.pathname === "/api/create-game") {
    const body = await readJsonBody(req);
    const table = createUniqueTable({ turnTimeLimitSeconds: body.turnTimeLimitSeconds });
    const hostPlayer = joinPlayer(table, body.name);
    table.hostPlayerId = hostPlayer.id;
    games.set(table.gameCode, table);
    sendJson(res, 201, {
      gameCode: table.gameCode,
      playerId: hostPlayer.id,
      token: hostPlayer.token
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/join-game") {
    const body = await readJsonBody(req);
    const gameCode = normalizeGameCode(body.gameCode);
    const table = games.get(gameCode);

    if (!table) {
      sendJson(res, 404, { error: "Game not found." });
      return;
    }

    const player = joinPlayer(table, body.name);
    sendJson(res, 201, {
      gameCode: table.gameCode,
      playerId: player.id,
      token: player.token
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/state") {
    const gameCode = normalizeGameCode(requestUrl.searchParams.get("gameCode"));
    const playerId = requestUrl.searchParams.get("playerId");
    const token = requestUrl.searchParams.get("token");
    const table = games.get(gameCode);

    if (!table) {
      sendJson(res, 404, { error: "Game not found." });
      return;
    }

    const player = authenticate(table, playerId, token);
    if (!player) {
      sendJson(res, 401, { error: "Session expired. Join again." });
      return;
    }

    sendJson(res, 200, getClientState(table, player));
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/action") {
    const body = await readJsonBody(req);
    const gameCode = normalizeGameCode(body.gameCode);
    const table = games.get(gameCode);

    if (!table) {
      sendJson(res, 404, { error: "Game not found." });
      return;
    }

    const player = authenticate(table, body.playerId, body.token);
    if (!player) {
      sendJson(res, 401, { error: "Session expired. Join again." });
      return;
    }

    applyAction(table, player, body.action, body.amount);
    pruneEmptyGame(gameCode);
    sendJson(res, 200, getClientState(table, player));
    return;
  }

  sendJson(res, 404, { error: "Not found." });
}

function createUniqueTable(options) {
  let table = createTable(options);

  while (games.has(table.gameCode)) {
    table = createTable(options);
  }

  return table;
}

function normalizeGameCode(rawValue) {
  return String(rawValue || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
}

function pruneEmptyGame(gameCode) {
  const table = games.get(gameCode);
  if (!table) {
    return;
  }

  if (table.players.length === 0) {
    games.delete(gameCode);
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";

    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!data) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(new Error("Invalid JSON body."));
      }
    });

    req.on("error", reject);
  });
}

async function serveStaticFile(res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden." });
    return;
  }

  let fileToRead = filePath;

  try {
    const stats = await fs.promises.stat(fileToRead);
    if (stats.isDirectory()) {
      fileToRead = path.join(fileToRead, "index.html");
    }
  } catch (error) {
    sendJson(res, 404, { error: "Not found." });
    return;
  }

  const extension = path.extname(fileToRead);
  const mimeType = MIME_TYPES[extension] || "application/octet-stream";

  try {
    const contents = await fs.promises.readFile(fileToRead);
    res.writeHead(200, {
      "Content-Type": mimeType,
      "Cache-Control": "no-store"
    });
    res.end(contents);
  } catch (error) {
    sendJson(res, 404, { error: "Not found." });
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

server.listen(PORT, HOST, () => {
  process.stdout.write(`Poker app running at http://${HOST}:${PORT}\n`);
});
