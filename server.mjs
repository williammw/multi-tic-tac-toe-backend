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
    this.turnTimer = null;
    this.turnTimeLimit = 10000; // 10 seconds per turn
    this.turnStartTime = null;
  }

  getInitialGameState() {
    // Randomly select the first player
    const firstPlayer = Math.random() < 0.5 ? 'X' : 'O';
    return {
      cells: Array(3).fill(null).map(() => Array(3).fill({ value: '' })),
      currentPlayer: firstPlayer,
      gameOver: false,
      winner: null
    };
  }

  performCoinToss() {
    const firstPlayer = Math.random() < 0.5 ? 'X' : 'O';
    this.state.currentPlayer = firstPlayer;
    return firstPlayer;
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
    
    // Clear the turn timer when a player leaves
    this.clearTurnTimer();
    
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

  startTurnTimer(io) {
    // Clear any existing timer
    this.clearTurnTimer();
    
    // Set the turn start time
    this.turnStartTime = Date.now();
    
    // Emit the turn start event with time information
    io.to(this.id).emit('turn-timer-start', {
      startTime: this.turnStartTime,
      duration: this.turnTimeLimit,
      currentPlayer: this.state.currentPlayer
    });
    
    // Set a timeout for the turn
    this.turnTimer = setTimeout(() => {
      this.handleTurnTimeout(io);
    }, this.turnTimeLimit);
  }
  
  clearTurnTimer() {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
  }
  
  handleTurnTimeout(io) {
    console.log(`Turn timeout for player ${this.state.currentPlayer} in room ${this.id}`);
    
    // Only process timeout if game is still playing
    if (this.status !== 'playing' || this.state.gameOver) {
      return;
    }
    
    // Make a random move for the current player
    this.makeRandomMove(io);
  }
  
  makeRandomMove(io) {
    // Find all empty cells
    const emptyCells = [];
    this.state.cells.forEach((row, rowIndex) => {
      row.forEach((cell, colIndex) => {
        if (!cell.value) {
          emptyCells.push({ row: rowIndex, col: colIndex });
        }
      });
    });
    
    // If no empty cells, game is a draw
    if (emptyCells.length === 0) {
      this.state.gameOver = true;
      this.status = 'finished';
      io.to(this.id).emit('game-state', this.state);
      return;
    }
    
    // Select a random empty cell
    const randomIndex = Math.floor(Math.random() * emptyCells.length);
    const { row, col } = emptyCells[randomIndex];
    
    // Get current player
    const currentPlayerSymbol = this.state.currentPlayer;
    
    // Get player data for the current player
    const currentPlayer = Array.from(this.players.values()).find(
      player => player.symbol === currentPlayerSymbol
    );
    
    // Create a copy of the cells
    const newCells = this.state.cells.map(r => r.map(c => ({ ...c })));
    
    // For tic-tac-toe with 3 marks per player, check if we need to remove the oldest mark
    const countMarks = (symbol) => {
      return newCells.flat().filter(cell => cell.value === symbol).length;
    };
    
    const getOldestMark = (symbol) => {
      let oldest = { timestamp: Infinity, pos: null };
      
      newCells.forEach((row, i) => {
        row.forEach((cell, j) => {
          if (cell.value === symbol && cell.timestamp && cell.timestamp < oldest.timestamp) {
            oldest = { timestamp: cell.timestamp, pos: { row: i, col: j } };
          }
        });
      });
      
      return oldest.pos;
    };
    
    // Check if player already has 3 marks
    if (countMarks(currentPlayerSymbol) >= 3) {
      const oldestPos = getOldestMark(currentPlayerSymbol);
      if (oldestPos) {
        newCells[oldestPos.row][oldestPos.col] = { value: '' };
      }
    }
    
    // Add the new mark
    newCells[row][col] = { value: currentPlayerSymbol, timestamp: Date.now() };
    
    // Check for a winner
    const winner = this.checkWinner(newCells);
    
    // Update the state
    const updatedState = {
      cells: newCells,
      currentPlayer: currentPlayerSymbol === 'X' ? 'O' : 'X',
      gameOver: !!winner,
      winner
    };
    
    this.state = updatedState;
    
    // Emit the auto-move event
    io.to(this.id).emit('auto-move', {
      player: currentPlayer,
      row,
      col,
      reason: 'timeout'
    });
    
    // Emit the updated game state
    io.to(this.id).emit('game-state', updatedState);
    
    // If game continues, start the next turn timer
    if (!updatedState.gameOver) {
      this.startTurnTimer(io);
    }
  }
  
  checkWinner(cells) {
    // Check rows
    for (let i = 0; i < 3; i++) {
      if (cells[i][0].value && cells[i][0].value === cells[i][1].value && cells[i][1].value === cells[i][2].value) {
        return cells[i][0].value;
      }
    }

    // Check columns
    for (let j = 0; j < 3; j++) {
      if (cells[0][j].value && cells[0][j].value === cells[1][j].value && cells[1][j].value === cells[2][j].value) {
        return cells[0][j].value;
      }
    }

    // Check diagonals
    if (cells[0][0].value && cells[0][0].value === cells[1][1].value && cells[1][1].value === cells[2][2].value) {
      return cells[0][0].value;
    }
    if (cells[0][2].value && cells[0][2].value === cells[1][1].value && cells[1][1].value === cells[2][0].value) {
      return cells[0][2].value;
    }

    return null;
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
        // Perform the coin toss
        const firstPlayer = room.performCoinToss();
        // Emit coin toss result first
        io.to(room.id).emit('coin-toss', {
          result: firstPlayer,
          startingPlayer: Array.from(room.players.values()).find(player => player.symbol === firstPlayer)
        });
        
        // Then emit game start
        io.to(room.id).emit('game-start', {
          gameState: room.state,
          players: Array.from(room.players.entries())
        });
        
        // Start the turn timer for the first move
        room.startTurnTimer(io);
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

      // Clear the turn timer as the player made a move
      room.clearTurnTimer();

      // Update the state and switch the current player
      const updatedState = {
        ...move,
        currentPlayer: player.symbol === 'X' ? 'O' : 'X'
      };

      room.state = updatedState;
      room.updateActivity();
      io.to(roomId).emit('game-state', updatedState);
      
      // If the game isn't over, start the turn timer for the next player
      if (!updatedState.gameOver) {
        room.startTurnTimer(io);
      }
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
      
      // Perform a coin toss for the rematch
      const firstPlayer = room.performCoinToss();
      io.to(roomId).emit('coin-toss', {
        result: firstPlayer,
        startingPlayer: Array.from(room.players.values()).find(player => player.symbol === firstPlayer)
      });
      
      io.to(roomId).emit('game-start', {
        gameState: room.state,
        players: Array.from(room.players.entries())
      });
      
      // Start the turn timer for the first move of the rematch
      room.startTurnTimer(io);
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