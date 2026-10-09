"use strict";
const http = require("http"), fs = require("fs"), path = require("path");
const { WebSocketServer } = require("ws");
const PORT = process.env.PORT || 3000, PUB = path.join(__dirname, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") { res.end("ok"); return; }
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const f = path.normalize(path.join(PUB, p));
  if (!f.startsWith(PUB)) { res.writeHead(403).end(); return; }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404).end("Not found"); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" });
    res.end(d);
  });
});
const wss = new WebSocketServer({ server });

/* ---------- state ---------- */
const games = new Map();   // code -> game
const clients = new Map(); // cid  -> { ws, code }
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const clean = s => String(s || "").trim().replace(/\s+/g, " ").slice(0, 16);
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const fail = (cid, msg) => { const c = clients.get(cid); if (c) send(c.ws, { t: "error", msg }); };
function gen() { let c; do { c = Array.from({ length: 4 }, () => "ABCDEFGHJKMNPQRSTUVWXYZ"[Math.random() * 23 | 0]).join(""); } while (games.has(c)); return c; }

function addPlayer(g, id, name, owner) {
  name = clean(name);
  if (!name) throw new Error("Enter a name.");
  if (g.players.length >= 15) throw new Error("The game is full.");
  if (g.players.some(p => p.name.toLowerCase() === name.toLowerCase())) throw new Error("That name is taken. Pick another.");
  g.players.push({ id, name, alive: true, owner });
}

/* Each client only receives its own players' secrets. */
function view(g, cid) {
  const own = g.players.filter(p => p.id === cid || p.owner === cid);
  const day = g.phase === "day", night = g.phase === "night", act = id => g.acts[id];
  const counts = {};
  if (day) g.players.filter(p => p.alive).forEach(p => { const a = act(p.id); if (a) counts[a.target] = (counts[a.target] || 0) + 1; });
  const mine = {};
  if (g.phase !== "lobby") own.forEach(p => {
    const o = { role: p.role, mates: p.mates || [], pick: act(p.id) ? act(p.id).target : null };
    if (p.peek && p.peek.round === g.round) o.peek = p.peek;
    if (night && p.role === "m") {
      const mc = {};
      [p.id, ...o.mates].forEach(i => { const a = act(i); if (a) mc[a.target] = (mc[a.target] || 0) + 1; });
      o.counts = mc;
    }
    mine[p.id] = o;
  });
  return {
    t: "state", code: g.code, phase: g.phase, round: g.round, isHost: g.host === cid, me: cid,
    msg: g.msg, out: g.out, win: g.win,
    players: g.players.map(p => ({ id: p.id, name: p.name, alive: p.alive, owner: p.owner })),
    mine, counts, voted: day ? g.players.filter(p => act(p.id)).map(p => p.id) : [],
    roles: g.phase === "over" ? Object.fromEntries(g.players.map(p => [p.id, p.role])) : null
  };
}
function push(g) { g.t = Date.now(); for (const [cid, c] of clients) if (c.code === g.code) send(c.ws, view(g, cid)); }

/* ---------- game rules ---------- */
function winner(g) {
  const al = g.players.filter(p => p.alive), m = al.filter(p => p.role === "m").length;
  return m === 0 ? "Town" : m >= al.length - m ? "Mafia" : null;
}
function endCheck(g, nextPhase) {
  g.acts = {};
  const w = winner(g);
  if (w) { g.phase = "over"; g.win = w; } else g.phase = nextPhase;
}
function step(g, force) {
  if (g.phase !== "night" && g.phase !== "day") return;
  const al = g.players.filter(p => p.alive), ok = p => !!g.acts[p.id];
  if (g.phase === "night") {
    const mafia = al.filter(p => p.role === "m"), doc = al.find(p => p.role === "h"), det = al.find(p => p.role === "d");
    if (![...mafia, doc, det].filter(Boolean).every(ok)) return;
    const cnt = {};
    mafia.forEach(p => { const t = g.acts[p.id].target; cnt[t] = (cnt[t] || 0) + 1; });
    const mx = Math.max(...Object.values(cnt)), top = Object.keys(cnt).filter(k => cnt[k] === mx);
    const kill = top[Math.random() * top.length | 0], save = doc && g.acts[doc.id].target;
    g.msg = "Someone was attacked, but the Doctor saved them. Nobody died."; g.out = null;
    if (kill !== save) {
      const v = g.players.find(p => p.id === kill); v.alive = false;
      g.out = { name: v.name, role: v.role }; g.msg = v.name + " was killed in the night.";
    }
    if (det) { const t = g.players.find(p => p.id === g.acts[det.id].target); det.peek = { round: g.round, name: t.name, mafia: t.role === "m" }; }
    endCheck(g, "day");
  } else {
    const votes = al.filter(ok);
    if (!votes.length || (!force && votes.length < al.length)) return;
    const cnt = {};
    votes.forEach(p => { const t = g.acts[p.id].target; cnt[t] = (cnt[t] || 0) + 1; });
    const mx = Math.max(...Object.values(cnt)), top = Object.keys(cnt).filter(k => cnt[k] === mx);
    g.msg = "The vote was tied. Nobody is out."; g.out = null;
    if (top.length === 1) {
      const v = g.players.find(p => p.id === top[0]); v.alive = false;
      g.out = { name: v.name, role: v.role }; g.msg = v.name + " was voted out.";
    }
    endCheck(g, "result");
  }
}
function start(g) {
  const n = g.players.length, m = Math.floor(n / 3);
  const rl = shuffle([..."m".repeat(m), "d", "h", ..."v".repeat(n - m - 2)]);
  g.players.forEach((p, i) => { p.role = rl[i]; p.alive = true; p.peek = null; });
  const mafia = g.players.filter(p => p.role === "m").map(p => p.id);
  g.players.forEach(p => { p.mates = p.role === "m" ? mafia.filter(x => x !== p.id) : []; });
  Object.assign(g, { phase: "night", round: 1, acts: {}, msg: "", out: null, win: null });
}

/* ---------- messages ---------- */
function handle(cid, m) {
  const c = clients.get(cid);
  if (m.t === "create") {
    const g = { code: gen(), host: cid, phase: "lobby", round: 0, players: [], acts: {}, msg: "", out: null, win: null, t: Date.now() };
    addPlayer(g, cid, m.name, null);
    games.set(g.code, g); c.code = g.code; return push(g);
  }
  if (m.t === "join") {
    const g = games.get(String(m.code || "").toUpperCase().trim());
    if (!g) throw new Error("No game with that code.");
    if (!g.players.some(p => p.id === cid)) {
      if (g.phase !== "lobby") throw new Error("That game has already started.");
      addPlayer(g, cid, m.name, null);
    }
    c.code = g.code; return push(g);
  }
  const g = games.get(c.code);
  if (!g) { c.code = null; return send(c.ws, { t: "home" }); }
  const host = () => { if (g.host !== cid) throw new Error("Only the host can do that."); };
  switch (m.t) {
    case "addLocal":
      if (g.phase !== "lobby") throw new Error("The game has started.");
      addPlayer(g, cid + "~" + Math.random().toString(36).slice(2, 7), m.name, cid); break;
    case "rmLocal": {
      if (g.phase !== "lobby") throw new Error("The game has started.");
      const i = g.players.findIndex(p => p.id === m.id && p.owner === cid);
      if (i >= 0) g.players.splice(i, 1); break;
    }
    case "start":
      host();
      if (g.phase !== "lobby") throw new Error("Already started.");
      if (g.players.length < 5) throw new Error("Need at least 5 players.");
      start(g); break;
    case "act": {
      if (g.phase !== "night" && g.phase !== "day") throw new Error("Not now.");
      const p = g.players.find(x => x.id === m.as), t = g.players.find(x => x.id === m.target);
      if (!p || !(p.id === cid || p.owner === cid) || !p.alive) throw new Error("Not allowed.");
      if (!t || !t.alive) throw new Error("Pick a living player.");
      if (g.phase === "night") {
        if (p.role === "v") throw new Error("Villagers have no night action.");
        if (p.role === "m" && (t.role === "m")) throw new Error("Pick someone outside the Mafia.");
        if (p.role === "d" && t === p) throw new Error("Pick someone else.");
      } else if (t === p) throw new Error("You can't vote for yourself.");
      g.acts[p.id] = { target: t.id }; step(g); break;
    }
    case "force": host(); if (g.phase === "day") step(g, true); break;
    case "next":
      host();
      if (g.phase === "result") { g.phase = "night"; g.round++; g.acts = {}; g.msg = ""; g.out = null; } break;
    case "again":
      host();
      if (g.phase === "over") {
        Object.assign(g, { phase: "lobby", round: 0, acts: {}, msg: "", out: null, win: null });
        g.players.forEach(p => { p.alive = true; p.role = null; p.mates = []; p.peek = null; });
      } break;
    case "leave": {
      if (g.phase === "lobby") {
        g.players = g.players.filter(p => p.id !== cid && p.owner !== cid);
        if (!g.players.length) games.delete(g.code);
        else if (g.host === cid) g.host = (g.players.find(p => !p.owner) || g.players[0]).id;
      }
      const code = c.code; c.code = null; send(c.ws, { t: "home" });
      return games.has(code) && push(games.get(code));
    }
    default: return;
  }
  push(g);
}

wss.on("connection", ws => {
  let cid = null;
  ws.on("message", raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === "hello") {
      if (typeof m.cid !== "string" || m.cid.length < 8 || m.cid.length > 64) return;
      cid = m.cid;
      const c = clients.get(cid) || { code: null };
      c.ws = ws; clients.set(cid, c);
      const g = c.code && games.get(c.code);
      if (g) send(ws, view(g, cid)); else { c.code = null; send(ws, { t: "home" }); }
      return;
    }
    if (!cid) return;
    try { handle(cid, m); } catch (e) { fail(cid, e.message); }
  });
  ws.on("close", () => { const c = clients.get(cid); if (c && c.ws === ws) c.ws = null; });
});
setInterval(() => { for (const w of wss.clients) w.ping(); }, 30000);
setInterval(() => { const cut = Date.now() - 6 * 3600e3; for (const [k, g] of games) if (g.t < cut) games.delete(k); }, 600000);

server.listen(PORT, () => console.log("Mafia listening on " + PORT));
