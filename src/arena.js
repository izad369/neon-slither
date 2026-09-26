// Neon Slither — Durable Object game arena (Cloudflare)
// Holds all players, food, lobby and runs the authoritative simulation.

const WORLD_SIZE = 4000;
const FOOD_TARGET = 260;
const BASE_SPEED = 160;
const BOOST_SPEED = 280;
const TURN_RATE = 3.2;
const SEG_SPACING = 9;
const START_LENGTH = 60;
const HEAD_RADIUS = 11;
const GROWTH_PER_FOOD = 6;
const BOOST_DRAIN_PER_SEC = 4;
const TICK_MS = 33;
const LOBBY_THRESHOLD = 2;
const LOBBY_MAX_WAIT_MS = 12000;
const DEFAULT_COLORS = ['#4fd6ff', '#ff5da2', '#7cff8f', '#ffd23f', '#b48bff', '#ff8a4f'];

function rand(a, b) {
  return a + Math.random() * (b - a);
}
function dist(x1, y1, x2, y2) {
  return Math.hypot(x1 - x2, y1 - y2);
}

export class Arena {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.players = new Map();
    this.waiting = new Map();
    this.food = [];
    this.nextFoodId = 1;
    this.nextPlayerId = 1;
    this.lastTick = Date.now();
    this.alarmScheduled = false;
    this.ensureFood();
  }

  ensureFood() {
    if (this.food.length < FOOD_TARGET) {
      const need = FOOD_TARGET - this.food.length;
      for (let i = 0; i < need; i++) {
        this.food.push({
          id: this.nextFoodId++,
          x: rand(-WORLD_SIZE / 2 + 50, WORLD_SIZE / 2 - 50),
          y: rand(-WORLD_SIZE / 2 + 50, WORLD_SIZE / 2 - 50),
          r: rand(4, 7),
          color: DEFAULT_COLORS[Math.floor(Math.random() * DEFAULT_COLORS.length)],
        });
      }
    }
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.handleSession(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('Arena Durable Object', { status: 200 });
  }

  handleSession(ws) {
    ws.accept();
    let playerId = null;

    ws.addEventListener('message', (evt) => {
      let msg;
      try {
        msg = JSON.parse(typeof evt.data === 'string' ? evt.data : new TextDecoder().decode(evt.data));
      } catch {
        return;
      }

      if (msg.type === 'lobby-join') {
        if (this.waiting.has(ws)) return;
        const timerId = setTimeout(() => {
          if (this.waiting.has(ws)) {
            this.waiting.delete(ws);
            this.safeSend(ws, { type: 'lobby-start' });
            this.broadcastLobbyCount();
          }
        }, LOBBY_MAX_WAIT_MS);
        this.waiting.set(ws, { joinedAt: Date.now(), timerId });
        this.broadcastLobbyCount();
        this.tryStartLobby();
      } else if (msg.type === 'lobby-leave') {
        const info = this.waiting.get(ws);
        if (info) clearTimeout(info.timerId);
        this.waiting.delete(ws);
        this.broadcastLobbyCount();
      } else if (msg.type === 'join') {
        const info = this.waiting.get(ws);
        if (info) clearTimeout(info.timerId);
        this.waiting.delete(ws);
        playerId = 'p' + this.nextPlayerId++;
        const p = this.makePlayer(playerId, msg.name, msg.color, msg.token);
        this.players.set(playerId, p);
        this.sessions.set(ws, { id: playerId });
        this.safeSend(ws, { type: 'welcome', id: playerId, color: p.color, worldSize: WORLD_SIZE });
        this.scheduleAlarm();
      } else if (msg.type === 'input' && playerId && this.players.has(playerId)) {
        const p = this.players.get(playerId);
        if (typeof msg.angle === 'number') p.targetAngle = msg.angle;
        p.boosting = !!msg.boost;
      } else if (msg.type === 'respawn' && playerId && this.players.has(playerId)) {
        const old = this.players.get(playerId);
        this.players.set(playerId, this.makePlayer(playerId, old.name, old.color, old.token));
      } else if (msg.type === 'chat' && playerId && this.players.has(playerId)) {
        const p = this.players.get(playerId);
        const text = String(msg.text || '').slice(0, 80).trim();
        if (text) {
          this.broadcastAll({ type: 'chat', name: p.name, text, color: p.color });
        }
      }
    });

    ws.addEventListener('close', () => {
      if (playerId) this.players.delete(playerId);
      this.sessions.delete(ws);
      const info = this.waiting.get(ws);
      if (info) {
        clearTimeout(info.timerId);
        this.waiting.delete(ws);
        this.broadcastLobbyCount();
      }
    });

    ws.addEventListener('error', () => {
      try { ws.close(); } catch {}
    });
  }

  makePlayer(id, name, color, token) {
    const startX = rand(-500, 500);
    const startY = rand(-500, 500);
    const angle = rand(0, Math.PI * 2);
    return {
      id,
      name: (name || 'Player').slice(0, 16),
      token: token || null,
      path: [{ x: startX, y: startY }],
      angle,
      targetAngle: angle,
      length: START_LENGTH,
      boosting: false,
      alive: true,
      color: color || DEFAULT_COLORS[Math.floor(Math.random() * DEFAULT_COLORS.length)],
    };
  }

  segmentsFor(p) {
    const segs = [];
    let travelled = 0;
    const need = p.length;
    segs.push(p.path[0]);
    for (let i = 1; i < p.path.length && travelled < need; i++) {
      const a = p.path[i - 1];
      const b = p.path[i];
      travelled += dist(a.x, a.y, b.x, b.y);
      if (travelled >= segs.length * SEG_SPACING) segs.push(b);
    }
    return segs;
  }

  scatterFoodFromDeath(pathPoints, count) {
    for (let i = 0; i < count; i++) {
      const p = pathPoints[Math.floor(rand(0, pathPoints.length))];
      if (!p) continue;
      this.food.push({
        id: this.nextFoodId++,
        x: p.x + rand(-20, 20),
        y: p.y + rand(-20, 20),
        r: rand(5, 9),
        color: DEFAULT_COLORS[Math.floor(Math.random() * DEFAULT_COLORS.length)],
      });
    }
  }

  async killPlayer(p) {
    p.alive = false;
    const segs = this.segmentsFor(p);
    this.scatterFoodFromDeath(segs, Math.min(40, Math.floor(p.length / 6)));
    if (p.token && this.env.USERS) {
      try {
        const key = await this.env.USERS.get('token:' + p.token);
        if (key) {
          const raw = await this.env.USERS.get('user:' + key);
          if (raw) {
            const u = JSON.parse(raw);
            const score = Math.floor(p.length);
            if (score > (u.bestScore || 0)) {
              u.bestScore = score;
              await this.env.USERS.put('user:' + key, JSON.stringify(u));
            }
          }
        }
      } catch (e) {
        console.error('score save failed', e);
      }
    }
    for (const [ws, sess] of this.sessions) {
      if (sess.id === p.id) {
        this.safeSend(ws, { type: 'dead', score: Math.floor(p.length) });
        break;
      }
    }
  }

  tick(dt) {
    this.ensureFood();
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      let diff = ((p.targetAngle - p.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      const maxTurn = TURN_RATE * dt;
      p.angle += Math.max(-maxTurn, Math.min(maxTurn, diff));
      const speed = p.boosting && p.length > START_LENGTH * 0.7 ? BOOST_SPEED : BASE_SPEED;
      if (p.boosting && p.length > START_LENGTH * 0.7) {
        p.length = Math.max(START_LENGTH * 0.6, p.length - BOOST_DRAIN_PER_SEC * dt);
        if (Math.random() < 0.25) this.scatterFoodFromDeath([p.path[0]], 1);
      }
      const head = p.path[0];
      const nx = head.x + Math.cos(p.angle) * speed * dt;
      const ny = head.y + Math.sin(p.angle) * speed * dt;
      p.path.unshift({ x: nx, y: ny });
      const maxPathLen = Math.ceil((p.length / SEG_SPACING) * 1.4) + 20;
      if (p.path.length > maxPathLen) p.path.length = maxPathLen;
      if (Math.abs(nx) > WORLD_SIZE / 2 || Math.abs(ny) > WORLD_SIZE / 2) {
        this.killPlayer(p);
        continue;
      }
    }

    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const head = p.path[0];
      for (let i = this.food.length - 1; i >= 0; i--) {
        const f = this.food[i];
        if (dist(head.x, head.y, f.x, f.y) < HEAD_RADIUS + f.r) {
          this.food.splice(i, 1);
          p.length += GROWTH_PER_FOOD;
        }
      }
    }

    const alivePlayers = [...this.players.values()].filter((p) => p.alive);
    const segCache = new Map();
    for (const p of alivePlayers) segCache.set(p.id, this.segmentsFor(p));
    for (const p of alivePlayers) {
      const head = p.path[0];
      for (const other of alivePlayers) {
        if (other.id === p.id) continue;
        const segs = segCache.get(other.id);
        for (let i = 1; i < segs.length; i++) {
          if (dist(head.x, head.y, segs[i].x, segs[i].y) < HEAD_RADIUS * 1.1) {
            this.killPlayer(p);
            break;
          }
        }
        if (!p.alive) break;
      }
    }
  }

  broadcastState() {
    const alive = [...this.players.values()].filter((p) => p.alive);
    const leaderboard = alive
      .slice()
      .sort((a, b) => b.length - a.length)
      .slice(0, 5)
      .map((p) => ({ name: p.name, score: Math.floor(p.length) }));
    const publicPlayers = alive.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      segs: this.segmentsFor(p).map((s) => ({ x: Math.round(s.x), y: Math.round(s.y) })),
      length: Math.floor(p.length),
    }));
    const payload = {
      type: 'state',
      players: publicPlayers,
      food: this.food.map((f) => ({ x: Math.round(f.x), y: Math.round(f.y), r: f.r, c: f.color })),
      leaderboard,
      worldSize: WORLD_SIZE,
    };
    this.broadcastAll(payload);
  }

  broadcastAll(obj) {
    const data = JSON.stringify(obj);
    for (const [ws] of this.sessions) {
      this.safeSendRaw(ws, data);
    }
  }

  broadcastLobbyCount() {
    const count = this.waiting.size;
    const data = JSON.stringify({ type: 'lobby-count', count });
    for (const ws of this.waiting.keys()) {
      this.safeSendRaw(ws, data);
    }
  }

  tryStartLobby() {
    if (this.waiting.size >= LOBBY_THRESHOLD) {
      for (const [ws, info] of this.waiting) {
        clearTimeout(info.timerId);
        this.safeSend(ws, { type: 'lobby-start' });
      }
      this.waiting.clear();
    }
  }

  safeSend(ws, obj) {
    this.safeSendRaw(ws, JSON.stringify(obj));
  }

  safeSendRaw(ws, data) {
    try {
      if (ws.readyState === 1) ws.send(data);
    } catch {}
  }

  scheduleAlarm() {
    if (this.alarmScheduled) return;
    this.alarmScheduled = true;
    this.state.storage.setAlarm(Date.now() + TICK_MS);
  }

  async alarm() {
    this.alarmScheduled = false;
    const now = Date.now();
    const dt = Math.min((now - this.lastTick) / 1000, 0.1);
    this.lastTick = now;
    if (this.players.size > 0 || this.waiting.size > 0) {
      this.tick(dt);
      this.broadcastState();
      this.scheduleAlarm();
    }
  }
}
