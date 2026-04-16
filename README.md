# Simple Poker

A clean multiplayer Texas Hold'em app built as a small Node server with a plain browser front end.

## GitHub Setup

This project is already initialized as a local git repository on the `main` branch.

To connect it to a real GitHub repository:

```bash
git remote set-url origin YOUR_GITHUB_REPO_URL
git push -u origin main
```

If you have not created the GitHub repository yet, create an empty repo first, then run the commands above.

## What it does

- Multiple players can join the same table from different browsers, devices, or tabs.
- Players see their own cards, community cards, turn order, blinds, pot, current bet, last raise, and total chips committed this street.
- The table feed shows who checked, called, raised, folded, or won.
- Hands run with dealer rotation, blinds, flop/turn/river, fold wins, and showdown winner calculation.

## Run it

```bash
npm start
```

Then open:

```text
http://127.0.0.1:3000
```

If you want it reachable from other devices on your network or on a host:

```bash
HOST=0.0.0.0 PORT=3000 npm start
```

## Notes

- Each browser tab keeps its own player session, so you can test multiple players from one machine.
- Game state is kept in memory, so restarting the server resets the table.

## Free Hosting

This repo includes [render.yaml](/Users/kvlnraju/Projects/games/Poker/render.yaml) for a simple Render deploy.

- Push the repo to GitHub.
- In Render, create a new Blueprint or Web Service from the repo.
- Render will run `npm install` and `npm start`.
- The app will be available on a `*.onrender.com` URL.

Important: this app currently stores the table in memory, so any server restart will reset the game.
