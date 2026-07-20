// ==========================================================================
// LabMod Multiplayer Server (server.js)
// Requires: npm install express socket.io
// Run: node server.js
// ==========================================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Serve static files from the current directory
app.use(express.static(__dirname));

// Route to serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// In-memory storage for active game servers
const activeServers = {};

// Helper function to generate unique IDs
function generateId() {
    return Math.random().toString(36).substr(2, 9);
}

// Helper function to get public server data (safe to send to clients)
function getPublicServerData(serverId) {
    const srv = activeServers[serverId];
    if (!srv) return null;
    return {
        id: srv.id,
        name: srv.name,
        owner: srv.owner,
        maxPlayers: srv.maxPlayers,
        hasPin: srv.hasPin,
        mods: srv.mods,
        currentPlayers: Object.keys(srv.players).length,
        players: Object.values(srv.players).map(p => ({ id: p.id, username: p.username, color: p.color, isAdmin: p.id === srv.owner }))
    };
}

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Request the list of active servers
    socket.on('get_servers', () => {
        const serverList = Object.keys(activeServers).map(id => getPublicServerData(id)).filter(s => s !== null);
        socket.emit('server_list', serverList);
    });

    // Create a new server
    socket.on('create_server', (data) => {
        // Leave any existing rooms first
        for (const room in socket.rooms) {
            if (room !== socket.id) socket.leave(room);
        }

        const serverId = generateId();
        const playerData = {
            id: socket.id,
            username: data.username,
            color: data.color || '#4f9cff',
            x: 10,
            y: 5,
            vx: 0,
            vy: 0
        };

        activeServers[serverId] = {
            id: serverId,
            name: data.name || 'Untitled Server',
            owner: socket.id,
            maxPlayers: data.maxPlayers || 10,
            hasPin: data.hasPin || false,
            pin: data.pin || '',
            mods: data.mods || [],
            players: {}
        };

        activeServers[serverId].players[socket.id] = playerData;
        socket.join(serverId);

        socket.emit('join_success', getPublicServerData(serverId));
        io.emit('server_list', Object.keys(activeServers).map(id => getPublicServerData(id)).filter(s => s !== null));
        console.log(`Server created: ${serverId} by ${data.username}`);
    });

    // Join an existing server
    socket.on('join_server', (data) => {
        const srv = activeServers[data.serverId];
        if (!srv) {
            socket.emit('join_error', 'Server not found.');
            return;
        }

        if (srv.hasPin && srv.pin !== data.pin) {
            socket.emit('join_error', 'Incorrect PIN.');
            return;
        }

        if (Object.keys(srv.players).length >= srv.maxPlayers) {
            socket.emit('join_error', 'Server is full.');
            return;
        }

        // Leave any existing rooms first
        for (const room in socket.rooms) {
            if (room !== socket.id) socket.leave(room);
        }

        const playerData = {
            id: socket.id,
            username: data.username,
            color: data.color || '#4f9cff',
            x: 10,
            y: 5,
            vx: 0,
            vy: 0
        };

        srv.players[socket.id] = playerData;
        socket.join(data.serverId);

        socket.emit('join_success', getPublicServerData(data.serverId));
        
        // Notify others in the room
        socket.to(data.serverId).emit('player_joined', playerData);
        console.log(`${data.username} joined server: ${srv.name}`);
    });

    // Leave a server
    socket.on('leave_server', () => {
        leaveServer(socket);
    });

    // Send chat message
    socket.on('send_chat', (message) => {
        for (const serverId in socket.rooms) {
            if (serverId === socket.id) continue;
            const srv = activeServers[serverId];
            if (srv && srv.players[socket.id]) {
                const player = srv.players[socket.id];
                io.to(serverId).emit('receive_chat', { username: player.username, message: message });
                break;
            }
        }
    });

    // Update player position
    socket.on('update_player', (data) => {
        for (const serverId in socket.rooms) {
            if (serverId === socket.id) continue;
            const srv = activeServers[serverId];
            if (srv && srv.players[socket.id]) {
                srv.players[socket.id].x = data.x;
                srv.players[socket.id].y = data.y;
                srv.players[socket.id].vx = data.vx;
                srv.players[socket.id].vy = data.vy;
                // Broadcast to others in the room
                socket.to(serverId).emit('player_updated', { id: socket.id, ...data });
                break;
            }
        }
    });

    // Canvas painting sync (Owner only action, broadcasted to clients)
    socket.on('paint_canvas', (data) => {
        for (const serverId in socket.rooms) {
            if (serverId === socket.id) continue;
            const srv = activeServers[serverId];
            if (srv && srv.owner === socket.id) {
                socket.to(serverId).emit('canvas_painted', data);
                break;
            }
        }
    });

    // Canvas clear sync (Owner only)
    socket.on('clear_canvas', () => {
        for (const serverId in socket.rooms) {
            if (serverId === socket.id) continue;
            const srv = activeServers[serverId];
            if (srv && srv.owner === socket.id) {
                socket.to(serverId).emit('canvas_cleared');
                break;
            }
        }
    });

    // Spawner sync (Owner only)
    socket.on('add_spawner', (data) => {
        for (const serverId in socket.rooms) {
            if (serverId === socket.id) continue;
            const srv = activeServers[serverId];
            if (srv && srv.owner === socket.id) {
                socket.to(serverId).emit('spawner_added', data);
                break;
            }
        }
    });

    socket.on('remove_spawner', (data) => {
        for (const serverId in socket.rooms) {
            if (serverId === socket.id) continue;
            const srv = activeServers[serverId];
            if (srv && srv.owner === socket.id) {
                socket.to(serverId).emit('spawner_removed', data);
                break;
            }
        }
    });

    // Kick player (Owner only)
    socket.on('kick_player', (targetId) => {
        for (const serverId in socket.rooms) {
            if (serverId === socket.id) continue;
            const srv = activeServers[serverId];
            if (srv && srv.owner === socket.id) {
                io.to(targetId).emit('kicked');
                // Force leave on the target socket's server side logic
                // We emit to target, target handles disconnect.
                break;
            }
        }
    });

    // Close server (Owner only)
    socket.on('close_server', () => {
        for (const serverId in socket.rooms) {
            if (serverId === socket.id) continue;
            const srv = activeServers[serverId];
            if (srv && srv.owner === socket.id) {
                io.to(serverId).emit('server_closed');
                delete activeServers[serverId];
                io.emit('server_list', Object.keys(activeServers).map(id => getPublicServerData(id)).filter(s => s !== null));
                console.log(`Server closed: ${serverId}`);
                break;
            }
        }
    });

    // Handle Disconnect
    socket.on('disconnect', () => {
        leaveServer(socket);
        console.log(`User disconnected: ${socket.id}`);
    });
});

function leaveServer(socket) {
    for (const serverId in socket.rooms) {
        if (serverId === socket.id) continue;
        const srv = activeServers[serverId];
        if (srv) {
            if (srv.players[socket.id]) {
                const username = srv.players[socket.id].username;
                delete srv.players[socket.id];
                socket.to(serverId).emit('player_left', socket.id);
                console.log(`${username} left server: ${srv.name}`);
            }
            
            // If owner leaves, close the server
            if (srv.owner === socket.id) {
                io.to(serverId).emit('server_closed');
                delete activeServers[serverId];
                io.emit('server_list', Object.keys(activeServers).map(id => getPublicServerData(id)).filter(s => s !== null));
                console.log(`Owner left, server closed: ${serverId}`);
            } else if (Object.keys(srv.players).length === 0) {
                // Clean up empty servers
                delete activeServers[serverId];
                io.emit('server_list', Object.keys(activeServers).map(id => getPublicServerData(id)).filter(s => s !== null));
            }
            
            socket.leave(serverId);
        }
    }
}

server.listen(PORT, () => {
    console.log(`LabMod Multiplayer Server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser.`);
});