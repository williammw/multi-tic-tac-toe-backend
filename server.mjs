import { createServer } from 'node:http';
import { Server } from 'socket.io';
import 'dotenv/config';

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: {
    // Update this to include both your local and production domains
    origin: [
      process.env.FRONTEND_URL || "http://localhost:5173",
      "https://www.idoitjustforfun.com"
    ],
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Game State Management
class GameRoom {
  constructor(id) {
    this.id = id;
    this.players = new Map();
    this.state = this.getInitialGameState();
    this.status = 'waiting'; // waiting, playing, finished
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.maxInactivityTime = 5 * 60 * 1000; // 5 minutes
  }

  getInitialGameState() {
    return {
      cells: Array(3).fill(null).map(() => Array(3).fill({ value: '' })),
      currentPlayer: 'X',
      gameOver: false,
      winner: null
    };
  }

  addPlayer(playerId, playerData) {
    if (this.players.size >= 2) return false;
    const symbol = this.players.size === 0 ? 'X' : 'O';
    this.players.set(playerId, { ...playerData, symbol });
    this.updateActivity();
    return true;
  }

  removePlayer(playerId) {
    console.log('Removing player:', playerId);
    console.log('Current room state:', {
      players: Array.from(this.players.entries()),
      status: this.status,
      state: this.state
    });

    const player = this.players.get(playerId);
    console.log('Found player to remove:', player);
    
    this.players.delete(playerId);
    console.log('Players after deletion:', Array.from(this.players.entries()));
    
    // If game was in progress, automatically update game state
    if (this.status === 'playing' && this.players.size === 1) {
      console.log('Game was in progress, updating state for remaining player');
      const remainingPlayer = Array.from(this.players.values())[0];
      console.log('Remaining player:', remainingPlayer);
      
      this.state = {
        ...this.state,
        gameOver: true,
        winner: remainingPlayer.symbol,
        cells: this.state.cells,  // Preserve the current board state
        currentPlayer: remainingPlayer.symbol
      };
      this.status = 'finished';
      console.log('Updated game state:', this.state);
    } else if (this.players.size === 0) {
      console.log('No players remaining, resetting game state');
      this.status = 'finished';
      this.state = this.getInitialGameState();
    }
    
    this.updateActivity();
    const result = {
      player,
      remainingPlayer: this.players.size === 1 ? Array.from(this.players.values())[0] : null
    };
    console.log('RemovePlayer result:', result);
    return result;
  }

  isReady() {
    return this.players.size === 2;
  }

  getPlayerData(playerId) {
    return this.players.get(playerId);
  }

  updateActivity() {
    this.lastActivity = Date.now();
  }

  isInactive() {
    return Date.now() - this.lastActivity > this.maxInactivityTime;
  }

  validateMove(move, playerId) {
    const player = this.getPlayerData(playerId);
    console.log('Validating move:', {
      move,
      playerId,
      player,
      roomStatus: this.status,
      currentPlayer: move.currentPlayer
    });
    
    if (!player) {
      console.log('Invalid move: Player not found');
      return false;
    }
    if (this.status !== 'playing') {
      console.log('Invalid move: Game not in playing state');
      return false;
    }
    if (move.currentPlayer !== player.symbol) {
      console.log('Invalid move: Wrong player turn');
      return false;
    }
    return true;
  }
}

// Matchmaking System
class MatchmakingSystem {
  constructor() {
    this.rooms = new Map();
    this.waitingPlayers = new Map();
    this.setupCleanup();
  }

  setupCleanup() {
    setInterval(() => {
      this.cleanupInactiveRooms();
    }, 60000); // Check every minute
  }

  cleanupInactiveRooms() {
    for (const [roomId, room] of this.rooms) {
      if (room.isInactive()) {
        console.log(`Cleaning up inactive room: ${roomId}`);
        this.rooms.delete(roomId);
      }
    }
  }

  createRoom() {
    const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const room = new GameRoom(roomId);
    this.rooms.set(roomId, room);
    return room;
  }

  findOrCreateRoom(playerId, playerData) {
    // Try to find an existing waiting room
    for (const [roomId, room] of this.rooms) {
      if (room.status === 'waiting' && !room.isReady()) {
        if (room.addPlayer(playerId, playerData)) {
          return room;
        }
      }
    }

    // Create a new room if no suitable room found
    const newRoom = this.createRoom();
    newRoom.addPlayer(playerId, playerData);
    return newRoom;
  }

  removePlayer(playerId) {
    this.waitingPlayers.delete(playerId);
    for (const [roomId, room] of this.rooms) {
      if (room.players.has(playerId)) {
        room.removePlayer(playerId);
        if (room.status === 'finished') {
          this.rooms.delete(roomId);
        }
        return roomId;
      }
    }
    return null;
  }

  getRoom(roomId) {
    return this.rooms.get(roomId);
  }

  reconnectPlayer(playerId, roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return room;
  }
}

// Initialize matchmaking system
const matchmaking = new MatchmakingSystem();

// Socket.IO event handlers
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  // Handle reconnection
  socket.on('reconnect-game', ({ roomId, playerSymbol }) => {
    const room = matchmaking.reconnectPlayer(socket.id, roomId);
    if (room) {
      socket.join(roomId);
      socket.emit('game-state', room.state);
      socket.emit('room-joined', {
        roomId,
        players: Array.from(room.players.entries()),
        playerSymbol
      });
    }
  });

  // Handle matchmaking
  socket.on('join-matchmaking', (playerData = {}) => {
    try {
      const room = matchmaking.findOrCreateRoom(socket.id, {
        name: playerData.name || `Player_${socket.id.substr(0, 4)}`,
        avatar: playerData.avatar,
        joinedAt: Date.now()
      });

      socket.join(room.id);
      
      socket.emit('room-joined', {
        roomId: room.id,
        players: Array.from(room.players.entries()),
        playerSymbol: room.getPlayerData(socket.id).symbol
      });

      if (room.isReady()) {
        room.status = 'playing';
        io.to(room.id).emit('game-start', {
          gameState: room.state,
          players: Array.from(room.players.entries())
        });
      } else {
        socket.emit('waiting-for-opponent');
      }
    } catch (error) {
      console.error('Error in join-matchmaking:', error);
      socket.emit('error', 'Failed to join matchmaking');
    }
  });

  // Handle game moves
  socket.on('make-move', ({ roomId, move }) => {
    try {
      // console.log('Received move:', { roomId, move, playerId: socket.id });
      
      const room = matchmaking.getRoom(roomId);
      if (!room) {
        socket.emit('error', 'Room not found');
        return;
      }

      const player = room.getPlayerData(socket.id);
      if (!player) {
        socket.emit('error', 'Player not found');
        return;
      }

      if (room.status !== 'playing') {
        socket.emit('error', 'Game not in progress');
        return;
      }

      if (room.state.currentPlayer !== player.symbol) {
        socket.emit('error', 'Not your turn');
        return;
      }

      // Update the state and switch the current player
      const updatedState = {
        ...move,
        currentPlayer: player.symbol === 'X' ? 'O' : 'X'
      };

      room.state = updatedState;
      room.updateActivity();
      io.to(roomId).emit('game-state', updatedState);
    } catch (error) {
      console.error('Error in make-move:', error);
      socket.emit('error', 'Failed to process move');
    }
  });

  // Handle rematch requests
  socket.on('request-rematch', (roomId) => {
    try {
      const room = matchmaking.getRoom(roomId);
      if (!room) return;

      room.updateActivity();
      socket.to(roomId).emit('rematch-requested', socket.id);
    } catch (error) {
      console.error('Error in request-rematch:', error);
      socket.emit('error', 'Failed to request rematch');
    }
  });

  // Handle rematch acceptance
  socket.on('accept-rematch', (roomId) => {
    try {
      const room = matchmaking.getRoom(roomId);
      if (!room) return;

      room.state = room.getInitialGameState();
      room.status = 'playing';
      room.updateActivity();
      
      io.to(roomId).emit('game-start', {
        gameState: room.state,
        players: Array.from(room.players.entries())
      });
    } catch (error) {
      console.error('Error in accept-rematch:', error);
      socket.emit('error', 'Failed to start rematch');
    }
  });

  // Handle player intentionally leaving game
  socket.on('leave-game', ({ roomId, intentional }) => {
    try {
      console.log('Player intentionally leaving:', socket.id, roomId);
      const room = matchmaking.getRoom(roomId);
      if (room) {
        const { player, remainingPlayer } = room.removePlayer(socket.id);
        
        // Emit updated game state and player info
        io.to(roomId).emit('player-left', {
          playerId: socket.id,
          gameState: room.state,
          remainingPlayers: Array.from(room.players.entries()),
          gameStatus: room.status,
          reason: 'left',
          leftPlayer: player,
          remainingPlayer: remainingPlayer,
          intentional: true
        });

        // Clean up empty rooms
        if (room.players.size === 0) {
          matchmaking.rooms.delete(roomId);
        }
      }
    } catch (error) {
      console.error('Error in leave-game handler:', error);
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    try {
      console.log('Player disconnected:', socket.id);
      let disconnectedRoomId = null;
      // Find the room the player was in
      for (const [roomId, room] of matchmaking.rooms) {
        if (room.players.has(socket.id)) {
          disconnectedRoomId = roomId;
          console.log('Found player\'s room:', roomId);
          break;
        }
      }

      if (disconnectedRoomId) {
        const room = matchmaking.getRoom(disconnectedRoomId);
        console.log('Room before player removal:', {
          players: Array.from(room.players.entries()),
          status: room.status,
          state: room.state
        });

        if (room) {
          const { player, remainingPlayer } = room.removePlayer(socket.id);
          console.log('Player removal result:', { player, remainingPlayer });
          
          const eventData = {
            playerId: socket.id,
            gameState: room.state,
            remainingPlayers: Array.from(room.players.entries()),
            gameStatus: room.status,
            reason: 'disconnect',
            leftPlayer: player,
            remainingPlayer: remainingPlayer
          };
          console.log('Emitting player-left event:', eventData);
          
          // Emit updated game state and player info
          io.to(disconnectedRoomId).emit('player-left', eventData);

          // Clean up empty rooms
          if (room.players.size === 0) {
            console.log('Removing empty room:', disconnectedRoomId);
            matchmaking.rooms.delete(disconnectedRoomId);
          }
        }
      } else {
        console.log('Could not find room for disconnected player:', socket.id);
      }
    } catch (error) {
      console.error('Error in disconnect handler:', error);
      console.error('Error stack:', error.stack);
    }
  });
});

// Error handling for the server
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start the server
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});