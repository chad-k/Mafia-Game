# Mafia
# Check out my app at - https://mafia-game-tj0v.onrender.com

Party game for 5 to 15 players. Everyone on their own phone, everyone on one phone, or a mix.
Roles are assigned and kept on the server, so each phone only receives its own players' secrets.

- `server.js` Node server (static files + WebSocket game logic). One dependency: `ws`.
- `public/index.html` the online game.
- `public/solo.html` standalone one-phone version, no server needed.

## Run locally
    npm install
    npm start        # http://localhost:3000

## Deploy on Render
1. Push this folder to a GitHub repo.
2. In Render: New > Blueprint (uses `render.yaml`), or New > Web Service and set
   Build command `npm install`, Start command `node server.js`.
3. Open the `.onrender.com` URL. WebSockets work with no extra setup.

## Limits
- Games live in server memory. A restart or redeploy ends active games.
- Run one instance only (do not scale horizontally).
- The free plan sleeps after about 15 minutes idle; the first visit then takes up to a minute.
