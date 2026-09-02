// Neon Slither — authoritative multiplayer server
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname; // Changed this line to read files from the root folder
const USERS_FILE = path.join(__dirname, 'users.json');

// ================================================================
// ACCOUNTS
// ================================================================
function loadUsers(){ try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return {}; } }
function saveUsers(users){ try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); } catch(e){ console.error('Failed to save users', e); } }
function hashPassword(password, salt){ return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex'); }
function makeToken(){ return crypto.randomBytes(24).toString('hex'); }

let users = loadUsers();
const tokens = new Map();

function readJsonBody(req){
  return new Promise((resolve, reject)=>{
    let body = '';
    req.on('data', chunk=>{ body += chunk; if(body.length > 1e6) req.destroy(); });
    req.on('end', ()=>{ try { resolve(body ? JSON.parse(body) : {}); } catch(e){ reject(e); } });
    req.on('error', reject);
  });
}

async function handleApi(req, res, pathname){
  res.setHeader('Content-Type', 'application/json');
  if(pathname === '/api/register' && req.method === 'POST'){
    const { username, password } = await readJsonBody(req);
    if(!username || !password || username.length < 3 || password.length < 4){ res.writeHead(400); res.end(JSON.stringify({ error:'Username needs 3+ chars, password 4+ chars.' })); return; }
    const key = username.toLowerCase();
    if(users[key]){ res.writeHead(409); res.end(JSON.stringify({ error:'That username is taken.' })); return; }
    const salt = crypto.randomBytes(16).toString('hex');
    users[key] = { username, salt, hash: hashPassword(password, salt), bestScore: 0, skin: 'classic' };
    saveUsers(users);
    const token = makeToken();
    tokens.set(token, key);
    res.writeHead(200); res.end(JSON.stringify({ token, username, bestScore:0, skin:'classic' }));
    return;
  }
  if(pathname === '/api/login' && req.method === 'POST'){
    const { username, password } = await readJsonBody(req);
    const key = (username||'').toLowerCase();
    const u = users[key];
    if(!u || hashPassword(password||'', u.salt) !== u.hash){ res.writeHead(401); res.end(JSON.stringify({ error:'Wrong username or password.' })); return; }
    const token = makeToken();
    tokens.set(token, key);
    res.writeHead(200); res.end(JSON.stringify({ token, username:u.username, bestScore:u.bestScore, skin:u.skin }));
    return;
  }
  if(pathname === '/api/profile' && req.method === 'POST'){
    const { token } = await readJsonBody(req);
    const key = tokens.get(token);
    const u = key && users[key];
    if(!u){ res.writeHead(401); res.end(JSON.stringify({ error:'Session expired, please log in again.' })); return; }
    res.writeHead(200); res.end(JSON.stringify({ username:u.username, bestScore:u.bestScore, skin:u.skin }));
    return;
  }
  if(pathname === '/api/set-skin' && req.method === 'POST'){
    const { token, skin } = await readJsonBody(req);
    const key = tokens.get(token);
    const u = key && users[key];
    if(!u){ res.writeHead(401); res.end(JSON.stringify({ error:'Not logged in.' })); return; }
    u.skin = skin;
    saveUsers(users);
    res.writeHead(200); res.end(JSON.stringify({ ok:true }));
    return;
  }
  res.writeHead(404); res.end(JSON.stringify({ error:'Not found' }));
}

function recordScoreForToken(token, score){
  const key = tokens.get(token);
  if(!key) return;
  const u = users[key];
  if(u && score > u.bestScore){
    u.bestScore = score;
    saveUsers(users);
  }
}

// ================================================================
// ARENA
// ================================================================
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
const TICK_RATE = 30;
const DEFAULT_COLORS = ['#4fd6ff','#ff5da2','#7cff8f','#ffd23f','#b48bff','#ff8a4f'];

let players = new Map();
let food = [];
let nextFoodId = 1;

function rand(a,b){ return a + Math.random()*(b-a); }
function dist(x1,y1,x2,y2){ return Math.hypot(x1-x2, y1-y2); }

function spawnFood(n){
  for(let i=0;i<n;i++){
    food.push({ id: nextFoodId++, x: rand(-WORLD_SIZE/2+50, WORLD_SIZE/2-50), y: rand(-WORLD_SIZE/2+50, WORLD_SIZE/2-50), r: rand(4,7), color: DEFAULT_COLORS[Math.floor(Math.random()*DEFAULT_COLORS.length)] });
  }
}
spawnFood(FOOD_TARGET);

function scatterFoodFromDeath(pathPoints, count){
  for(let i=0;i<count;i++){
    const p = pathPoints[Math.floor(rand(0, pathPoints.length))];
    if(!p) continue;
    food.push({ id: nextFoodId++, x: p.x+rand(-20,20), y: p.y+rand(-20,20), r: rand(5,9), color: DEFAULT_COLORS[Math.floor(Math.random()*DEFAULT_COLORS.length)] });
  }
}

function makePlayer(id, name, color, socket, token){
  const startX = rand(-500,500), startY = rand(-500,500);
  const angle = rand(0, Math.PI*2);
  return { id, name:(name||'Player').slice(0,16), socket, token, path:[{x:startX,y:startY}], angle, targetAngle:angle, length: START_LENGTH, boosting:false, alive:true, color: color || DEFAULT_COLORS[Math.floor(Math.random()*DEFAULT_COLORS.length)] };
}

function segmentsFor(p){
  const segs = [];
  let travelled = 0, need = p.length;
  segs.push(p.path[0]);
  for(let i=1;i<p.path.length && travelled < need; i++){
    const a=p.path[i-1], b=p.path[i];
    travelled += dist(a.x,a.y,b.x,b.y);
    if(travelled >= segs.length*SEG_SPACING) segs.push(b);
  }
  return segs;
}

function killPlayer(p){
  p.alive = false;
  const segs = segmentsFor(p);
  scatterFoodFromDeath(segs, Math.min(40, Math.floor(p.length/6)));
  if(p.token) recordScoreForToken(p.token, Math.floor(p.length));
  if(p.socket && p.socket.readyState === 1){ p.socket.send(JSON.stringify({ type:'dead', score: Math.floor(p.length) })); }
}

function tick(dt){
  if(food.length < FOOD_TARGET) spawnFood(Math.min(6, FOOD_TARGET-food.length));
  for(const p of players.values()){
    if(!p.alive) continue;
    let diff = ((p.targetAngle - p.angle + Math.PI*3) % (Math.PI*2)) - Math.PI;
    const maxTurn = TURN_RATE*dt;
    p.angle += Math.max(-maxTurn, Math.min(maxTurn, diff));
    const speed = (p.boosting && p.length > START_LENGTH*0.7) ? BOOST_SPEED : BASE_SPEED;
    if(p.boosting && p.length > START_LENGTH*0.7){
      p.length = Math.max(START_LENGTH*0.6, p.length - BOOST_DRAIN_PER_SEC*dt);
      if(Math.random() < 0.25) scatterFoodFromDeath([p.path[0]], 1);
    }
    const head = p.path[0];
    const nx = head.x + Math.cos(p.angle)*speed*dt;
    const ny = head.y + Math.sin(p.angle)*speed*dt;
    p.path.unshift({x:nx,y:ny});
    const maxPathLen = Math.ceil((p.length/SEG_SPACING)*1.4) + 20;
    if(p.path.length > maxPathLen) p.path.length = maxPathLen;
    if(Math.abs(nx) > WORLD_SIZE/2 || Math.abs(ny) > WORLD_SIZE/2){ killPlayer(p); continue; }
  }
  for(const p of players.values()){
    if(!p.alive) continue;
    const head = p.path[0];
    for(let i=food.length-1;i>=0;i--){
      const f = food[i];
      if(dist(head.x,head.y,f.x,f.y) < HEAD_RADIUS+f.r){ food.splice(i,1); p.length += GROWTH_PER_FOOD; }
    }
  }
  const alivePlayers = [...players.values()].filter(p=>p.alive);
  const segCache = new Map();
  for(const p of alivePlayers) segCache.set(p.id, segmentsFor(p));
  for(const p of alivePlayers){
    const head = p.path[0];
    for(const other of alivePlayers){
      if(other.id === p.id) continue;
      const segs = segCache.get(other.id);
      for(let i=1;i<segs.length;i++){
        if(dist(head.x,head.y,segs[i].x,segs[i].y) < HEAD_RADIUS*1.1){ killPlayer(p); break; }
      }
      if(!p.alive) break;
    }
  }
}

function broadcastState(){
  const alive = [...players.values()].filter(p=>p.alive);
  const leaderboard = alive.slice().sort((a,b)=>b.length-a.length).slice(0,5).map(p=>({ name:p.name, score:Math.floor(p.length) }));
  const publicPlayers = alive.map(p=>({ id:p.id, name:p.name, color:p.color, segs: segmentsFor(p).map(s=>({x:Math.round(s.x), y:Math.round(s.y)})), length: Math.floor(p.length) }));
  const payload = JSON.stringify({ type:'state', players:publicPlayers, food: food.map(f=>({x:Math.round(f.x), y:Math.round(f.y), r:f.r, c:f.color})), leaderboard, worldSize: WORLD_SIZE });
  for(const p of players.values()){
    if(p.socket && p.socket.readyState === 1) p.socket.send(payload);
  }
}

let lastTick = Date.now();
setInterval(()=>{
  const now = Date.now();
  const dt = Math.min((now-lastTick)/1000, 0.1);
  lastTick = now;
  tick(dt);
  broadcastState();
}, 1000/TICK_RATE);

// ================================================================
// LOBBY / MATCHMAKING
// ================================================================
const LOBBY_THRESHOLD = 2;
const LOBBY_MAX_WAIT = 12000;
let waiting = new Map();

function broadcastLobbyCount(){
  const count = waiting.size;
  for(const socket of waiting.keys()){
    if(socket.readyState === 1) socket.send(JSON.stringify({ type:'lobby-count', count }));
  }
}

function tryStartLobby(){
  if(waiting.size >= LOBBY_THRESHOLD){
    for(const [socket, info] of waiting){
      clearTimeout(info.timer);
      if(socket.readyState === 1) socket.send(JSON.stringify({ type:'lobby-start' }));
    }
    waiting.clear();
  }
}

// ================================================================
// STATIC FILE + API SERVER
// ================================================================
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8' };

const server = http.createServer((req,res)=>{
  const u = new URL(req.url, `http://${req.headers.host}`);
  if(u.pathname.startsWith('/api/')){
    handleApi(req, res, u.pathname).catch(()=>{ res.writeHead(500); res.end('{"error":"server error"}'); });
    return;
  }
  let filePath = u.pathname === '/' ? '/index.html' : u.pathname;
  filePath = path.join(PUBLIC_DIR, filePath);
  if(!filePath.startsWith(PUBLIC_DIR)){ res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err,data)=>{
    if(err){ res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path:'/ws' });

wss.on('connection', (socket)=>{
  let id = null;
  socket.on('message', (raw)=>{
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if(msg.type === 'lobby-join'){
      const timer = setTimeout(()=>{
        if(waiting.has(socket)){
          waiting.delete(socket);
          if(socket.readyState === 1) socket.send(JSON.stringify({ type:'lobby-start' }));
        }
      }, LOBBY_MAX_WAIT);
      waiting.set(socket, { joinedAt: Date.now(), timer });
      broadcastLobbyCount();
      tryStartLobby();
    } else if(msg.type === 'lobby-leave'){
      const info = waiting.get(socket);
      if(info) clearTimeout(info.timer);
      waiting.delete(socket);
      broadcastLobbyCount();
    } else if(msg.type === 'join'){
      const info = waiting.get(socket);
      if(info) clearTimeout(info.timer);
      waiting.delete(socket);
      id = 'p'+Math.random().toString(36).slice(2,9);
      const p = makePlayer(id, msg.name, msg.color, socket, msg.token);
      players.set(id, p);
      socket.send(JSON.stringify({ type:'welcome', id, color:p.color, worldSize: WORLD_SIZE }));
    } else if(msg.type === 'input' && id && players.has(id)){
      const p = players.get(id);
      if(typeof msg.angle === 'number') p.targetAngle = msg.angle;
      p.boosting = !!msg.boost;
    } else if(msg.type === 'respawn' && id && players.has(id)){
      const old = players.get(id);
      players.set(id, makePlayer(id, old.name, old.color, socket, old.token));
    }
  });
  socket.on('close', ()=>{
    if(id) players.delete(id);
    const info = waiting.get(socket);
    if(info){
      clearTimeout(info.timer);
      waiting.delete(socket);
      broadcastLobbyCount();
    }
  });
});

server.listen(PORT, ()=>{ console.log('Neon Slither server running on port', PORT); });
