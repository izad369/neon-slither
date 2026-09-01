const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    fs.readFile('./index.html', (err, data) => {
      if (err) { res.writeHead(500); res.end('Error loading index.html'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const wss = new WebSocket.Server({ server, path: "/ws" });

let waitingPlayers = [];
let activeRooms = [];
let nextId = 1;
let nextRoomId = 1;
const WORLD_SIZE = 4000;

console.log("Server is running...");

wss.on('connection', (ws) => {
    ws.id = nextId++;
    
    ws.on('message', (message) => {
        const msg = JSON.parse(message);
        
        if (msg.type === 'matchmaking') {
            ws.name = msg.name;
            ws.skin = msg.skin;
            ws.score = 0;
            waitingPlayers.push(ws);
            broadcastLobbyStatus();
            
            if (waitingPlayers.length >= 4) {
                createRoom(waitingPlayers.splice(0, 4));
            }
        } 
        else if (msg.type === 'input') {
            const room = activeRooms.find(r => r.players.some(p => p.ws === ws));
            if (room) {
                const player = room.players.find(p => p.ws === ws);
                if (player && player.alive) {
                    player.angle = msg.angle;
                    player.boost = msg.boost;
                }
            }
        } 
        else if (msg.type === 'respawn') {
            const room = activeRooms.find(r => r.players.some(p => p.ws === ws));
            if (room) {
                const player = room.players.find(p => p.ws === ws);
                if (player) {
                    player.segs = [{ x: (Math.random()-0.5)*WORLD_SIZE, y: (Math.random()-0.5)*WORLD_SIZE }];
                    player.length = 10;
                    player.alive = true;
                    ws.send(JSON.stringify({ type: 'start', id: ws.id, worldSize: WORLD_SIZE }));
                }
            }
        }
    });

    ws.on('close', () => {
        waitingPlayers = waitingPlayers.filter(p => p !== ws);
        broadcastLobbyStatus();
        activeRooms.forEach(room => {
            room.players = room.players.filter(p => p.ws !== ws);
            if (room.players.length === 0) {
                activeRooms = activeRooms.filter(r => r !== room);
            }
        });
    });
});

function broadcastLobbyStatus() {
    waitingPlayers.forEach(p => {
        if (p.readyState === WebSocket.OPEN) {
            p.send(JSON.stringify({ type: 'lobby', count: waitingPlayers.length }));
        }
    });
}

function createRoom(players) {
    const room = { id: nextRoomId++, players: [], food: [] };
    
    for (let i = 0; i < 100; i++) {
        room.food.push({
            x: (Math.random() - 0.5) * WORLD_SIZE,
            y: (Math.random() - 0.5) * WORLD_SIZE,
            r: 5,
            c: ['#4fd6ff', '#ff5da2', '#7cff8f', '#ffd23f'][Math.floor(Math.random() * 4)]
        });
    }
    
    players.forEach(p => {
        const playerObj = {
            ws: p,
            id: p.id,
            name: p.name,
            color: p.skin,
            segs: [{ x: (Math.random() - 0.5) * WORLD_SIZE, y: (Math.random() - 0.5) * WORLD_SIZE }],
            length: 10,
            angle: 0,
            boost: false,
            alive: true
        };
        room.players.push(playerObj);
        if (p.readyState === WebSocket.OPEN) {
            p.send(JSON.stringify({ type: 'start', id: p.id, worldSize: WORLD_SIZE }));
        }
    });
    
    activeRooms.push(room);
    startGameLoop(room);
}

function startGameLoop(room) {
    const interval = setInterval(() => {
        if (room.players.length === 0) {
            clearInterval(interval);
            return;
        }
        
        room.players.forEach(p => {
            if (!p.alive) return;
            
            let speed = 3;
            if (p.boost && p.length > 15) {
                speed = 5;
                p.length -= 0.05;
                if (Math.floor(p.length) % 2 === 0) {
                    room.food.push({ x: p.segs[0].x, y: p.segs[0].y, r: 4, c: p.color });
                }
            }
            
            const head = p.segs[0];
            const newHead = { x: head.x + Math.cos(p.angle) * speed, y: head.y + Math.sin(p.angle) * speed };
            p.segs.unshift(newHead);
            
            if (p.segs.length > p.length) p.segs.pop();
            
            if (Math.abs(newHead.x) > WORLD_SIZE/2 || Math.abs(newHead.y) > WORLD_SIZE/2) {
                p.alive = false;
                p.ws.send(JSON.stringify({ type: 'dead', score: Math.floor(p.length) }));
            }
            
            room.food.forEach(f => {
                if (Math.hypot(newHead.x - f.x, newHead.y - f.y) < 15) {
                    p.length += 2;
                    f.x = (Math.random() - 0.5) * WORLD_SIZE;
                    f.y = (Math.random() - 0.5) * WORLD_SIZE;
                }
            });
            
            room.players.forEach(other => {
                if (other === p || !other.alive) return;
                other.segs.forEach(seg => {
                    if (Math.hypot(newHead.x - seg.x, newHead.y - seg.y) < 12) {
                        p.alive = false;
                        p.ws.send(JSON.stringify({ type: 'dead', score: Math.floor(p.length) }));
                    }
                });
            });
        });
        
        const state = {
            type: 'state',
            worldSize: WORLD_SIZE,
            food: room.food,
            players: room.players.map(p => ({ id: p.id, name: p.name, color: p.color, segs: p.segs, length: Math.floor(p.length) }))
        };
        
        room.players.forEach(p => {
            if (p.ws.readyState === WebSocket.OPEN) {
                p.ws.send(JSON.stringify(state));
            }
        });
    }, 50);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Listening on port ${PORT}`);
});
