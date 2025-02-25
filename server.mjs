import { createServer } from 'node:http';
import { Server } from 'socket.io';
import 'dotenv/config';
import admin from 'firebase-admin';
import express from 'express';
import { rateLimit } from 'express-rate-limit';

// Initialize Firebase Admin SDK
// Note: You'll need to obtain a service account key from Firebase console
// and store it securely or use environment variables for the configuration
try {
  admin.initializeApp({
    // If using a JSON file (for development):
    // credential: admin.credential.cert('./service-account-key.json'),
    
    // For production, use environment variables:
    credential: admin.credential.cert({
      "type": process.env.FIREBASE_TYPE,
      "project_id": process.env.FIREBASE_PROJECT_ID,
      "private_key_id": process.env.FIREBASE_PRIVATE_KEY_ID,
      "private_key": process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      "client_email": process.env.FIREBASE_CLIENT_EMAIL,
      "client_id": process.env.FIREBASE_CLIENT_ID,
      "auth_uri": process.env.FIREBASE_AUTH_URI,
      "token_uri": process.env.FIREBASE_TOKEN_URI,
      "auth_provider_x509_cert_url": process.env.FIREBASE_AUTH_PROVIDER_CERT_URL,
      "client_x509_cert_url": process.env.FIREBASE_CLIENT_CERT_URL
    })
  });
  console.log('Firebase Admin SDK initialized successfully');
} catch (error) {
  console.error('Error initializing Firebase Admin SDK:', error);
}

// Create express app for better middleware support
const app = express();

// Apply rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests, please try again later.'
});

app.use(limiter);

// Create HTTP server with Express
const httpServer = createServer(app);

// Store active connections with their UID for tracking and security
const activeConnections = new Map();

// Create Socket.IO server with secure CORS configuration
const io = new Server(httpServer, {
  cors: {
    origin: process.env.NODE_ENV === 'production' 
      ? [process.env.FRONTEND_URL, "https://www.idoitjustforfun.com"].filter(Boolean)
      : process.env.FRONTEND_URL || "http://localhost:5173",
    methods: ["GET", "POST"],
    credentials: true,
    allowedHeaders: ["Authorization"]
  }
});

// Socket.IO authentication middleware
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    
    // If no token is provided, allow anonymous access but limit capabilities
    if (!token) {
      socket.user = { anonymous: true, id: socket.id };
      // Store rate limiting data for anonymous users
      socket.eventCount = {
        timestamp: Date.now(),
        count: 0
      };
      return next();
    }
    
    // Verify Firebase token
    const decodedToken = await admin.auth().verifyIdToken(token);
    
    // Set authenticated user data on socket
    socket.user = {
      uid: decodedToken.uid,
      email: decodedToken.email,
      name: decodedToken.name,
      anonymous: false
    };
    
    // Track this connection with the user's ID
    if (!activeConnections.has(decodedToken.uid)) {
      activeConnections.set(decodedToken.uid, new Set());
    }
    activeConnections.get(decodedToken.uid).add(socket.id);
    
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    // Allow connection but mark as anonymous
    socket.user = { anonymous: true, id: socket.id };
    socket.eventCount = {
      timestamp: Date.now(),
      count: 0
    };
    next();
  }
});

// Input validation functions
function validateMoveData(move) {
  if (!move || typeof move !== 'object') return false;
  
  // Validate the cells array structure
  if (!Array.isArray(move.cells)) return false;
  if (move.cells.length !== 3) return false;
  
  for (const row of move.cells) {
    if (!Array.isArray(row) || row.length !== 3) return false;
    for (const cell of row) {
      if (typeof cell !== 'object') return false;
      if (cell.value !== '' && cell.value !== 'X' && cell.value !== 'O') return false;
    }
  }
  
  // Validate other required fields
  if (move.currentPlayer !== 'X' && move.currentPlayer !== 'O') return false;
  if (typeof move.gameOver !== 'boolean') return false;
  
  // Winner can be null or X/O
  if (move.winner !== null && move.winner !== 'X' && move.winner !== 'O') return false;
  
  return true;
}

function sanitizePlayerData(playerData) {
  if (!playerData || typeof playerData !== 'object') {
    return { name: 'Anonymous', avatar: null };
  }
  
  // Sanitize player name
  let name = typeof playerData.name === 'string' ? playerData.name.trim() : 'Anonymous';
  
  // Limit name length and strip any HTML
  name = name.substring(0, 20).replace(/<[^>]*>?/gm, '');
  
  // Sanitize avatar URL if provided (could be enhanced with URL validation)
  let avatar = null;
  if (typeof playerData.avatar === 'string' && playerData.avatar.startsWith('https://')) {
    avatar = playerData.avatar;
  }
  
  return { name, avatar };
}

// Event rate limiting for socket events
function checkRateLimit(socket, increment = true) {
  // Skip for authenticated users
  if (!socket.user.anonymous) return true;
  
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute
  
  // Initialize or reset counters if window has expired
  if (!socket.eventCount || now - socket.eventCount.timestamp > windowMs) {
    socket.eventCount = {
      timestamp: now,
      count: increment ? 1 : 0
    };
    return true;
  }
  
  // Check if limit exceeded
  if (socket.eventCount.count >= 20) { // 20 events per minute for anonymous users
    return false;
  }
  
  // Increment counter if needed
  if (increment) {
    socket.eventCount.count++;
  }
  
  return true;
}

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
    this.moveHistory = []; // Track all moves for validation and replay
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

  addPlayer(playerId, playerData, userProfile = null) {
    if (this.players.size >= 2) return false;
    
    // Sanitize player data to prevent XSS
    const sanitizedPlayerData = sanitizePlayerData(playerData);
    
    const symbol = this.players.size === 0 ? 'X' : 'O';
    
    // Add authentication data if available
    const playerInfo = {
      ...sanitizedPlayerData,
      symbol,
      authenticated: !!userProfile,
      uid: userProfile?.uid || null,
      joinedAt: Date.now()
    };
    
    this.players.set(playerId, playerInfo);
    this.updateActivity();
    return true;
  }

  removePlayer(playerId) {
    console.log('Removing player:', playerId);
    
    const player = this.players.get(playerId);
    if (!player) {
      console.log('Player not found:', playerId);
      return { player: null, remainingPlayer: null };
    }
    
    this.players.delete(playerId);
    
    // Clear the turn timer when a player leaves
    this.clearTurnTimer();
    
    // If game was in progress, automatically update game state
    if (this.status === 'playing' && this.players.size === 1) {
      console.log('Game was in progress, updating state for remaining player');
      const remainingPlayer = Array.from(this.players.values())[0];
      
      this.state = {
        ...this.state,
        gameOver: true,
        winner: remainingPlayer.symbol,
        cells: this.state.cells,  // Preserve the current board state
        currentPlayer: remainingPlayer.symbol
      };
      this.status = 'finished';
      
      // Add to move history
      this.moveHistory.push({
        type: 'player_left',
        playerId,
        resulting_state: { ...this.state },
        timestamp: Date.now()
      });
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

  // Updated server validateMove function for GameRoom class
validateMove(move, playerId) {
  const player = this.getPlayerData(playerId);
  
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
  
  // Get previous state for comparison
  const prevState = this.state;
  
  // Find marks in both states
  const prevMarks = [];
  const newMarks = [];
  
  // Find marks in previous state
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (prevState.cells[i][j].value === player.symbol) {
        prevMarks.push({
          row: i,
          col: j,
          timestamp: prevState.cells[i][j].timestamp || 0
        });
      }
      
      if (move.cells[i][j].value === player.symbol) {
        newMarks.push({
          row: i,
          col: j,
          timestamp: move.cells[i][j].timestamp || 0
        });
      }
    }
  }
  
  console.log('Previous marks:', prevMarks);
  console.log('New marks:', newMarks);
  
  // Count changes
  const prevCount = prevMarks.length;
  const newCount = newMarks.length;
  
  console.log(`Previous count: ${prevCount}, New count: ${newCount}`);
  
  // If placing a 4th mark, we need to handle replacement logic correctly
  if (prevCount >= 3 && newCount === 3) {
    console.log('Player had 3+ marks and still has 3, checking replacement pattern');
    
    // Create maps of positions to timestamps for better comparison
    const prevPosMap = new Map();
    const newPosMap = new Map();
    
    for (const mark of prevMarks) {
      prevPosMap.set(`${mark.row},${mark.col}`, mark.timestamp);
    }
    
    for (const mark of newMarks) {
      newPosMap.set(`${mark.row},${mark.col}`, mark.timestamp);
    }
    
    // Check for positions that were removed or timestamps that changed
    let replacementFound = false;
    
    // Look for removed positions
    for (const [pos, time] of prevPosMap.entries()) {
      if (!newPosMap.has(pos)) {
        console.log('Found removed mark at:', pos);
        replacementFound = true;
        break;
      } else if (newPosMap.get(pos) !== time) {
        // Same position but different timestamp (valid replacement)
        console.log('Found updated timestamp at:', pos);
        replacementFound = true;
        break;
      }
    }
    
    // Look for new positions
    for (const pos of newPosMap.keys()) {
      if (!prevPosMap.has(pos)) {
        console.log('Found added mark at:', pos);
        replacementFound = true;
        break;
      }
    }
    
    if (!replacementFound) {
      console.log('Invalid move: No replacement found');
      return false;
    }
    
    return true;
  }
  // If just adding a mark normally (<= 3 total)
  else if (newCount === prevCount + 1 && newCount <= 3) {
    console.log('Player adding a new mark normally');
    
    // Make sure only one cell was added
    let addedCount = 0;
    for (const newMark of newMarks) {
      let existedBefore = false;
      for (const prevMark of prevMarks) {
        if (newMark.row === prevMark.row && newMark.col === prevMark.col) {
          existedBefore = true;
          break;
        }
      }
      if (!existedBefore) {
        addedCount++;
      }
    }
    
    if (addedCount !== 1) {
      console.log('Invalid move: Should add exactly one mark');
      return false;
    }
    
    return true;
  } else {
    console.log('Invalid move: Unexpected mark count change');
    return false;
  }
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
      
      // Add to move history
      this.moveHistory.push({
        type: 'game_draw',
        resulting_state: { ...this.state },
        timestamp: Date.now()
      });
      
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
    let removedMarkPos = null;
    if (countMarks(currentPlayerSymbol) >= 3) {
      const oldestPos = getOldestMark(currentPlayerSymbol);
      if (oldestPos) {
        removedMarkPos = oldestPos;
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
    
    // Add to move history
    this.moveHistory.push({
      type: 'auto_move',
      player: currentPlayerSymbol,
      row,
      col,
      removed_mark: removedMarkPos,
      resulting_state: { ...updatedState },
      timestamp: Date.now()
    });
    
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
  
  recordMove(playerId, move) {
    const player = this.getPlayerData(playerId);
    if (!player) return;
    
    // Create a move record for the history
    this.moveHistory.push({
      type: 'player_move',
      playerId,
      playerSymbol: player.symbol,
      resulting_state: { ...move },
      timestamp: Date.now()
    });
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
    // Generate a secure room ID
    const roomId = `room_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
    const room = new GameRoom(roomId);
    this.rooms.set(roomId, room);
    return room;
  }

  findOrCreateRoom(playerId, playerData, userProfile = null) {
    // Try to find an existing waiting room
    for (const [roomId, room] of this.rooms) {
      if (room.status === 'waiting' && !room.isReady()) {
        if (room.addPlayer(playerId, playerData, userProfile)) {
          return room;
        }
      }
    }

    // Create a new room if no suitable room found
    const newRoom = this.createRoom();
    newRoom.addPlayer(playerId, playerData, userProfile);
    return newRoom;
  }

  removePlayer(playerId) {
    this.waitingPlayers.delete(playerId);
    for (const [roomId, room] of this.rooms) {
      if (room.players.has(playerId)) {
        const result = room.removePlayer(playerId);
        if (room.status === 'finished') {
          this.rooms.delete(roomId);
        }
        return { roomId, ...result };
      }
    }
    return { roomId: null, player: null, remainingPlayer: null };
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
  console.log('Player connected:', socket.id, socket.user?.anonymous ? '(anonymous)' : '(authenticated)');

  // Handle reconnection with authentication
  socket.on('reconnect-game', ({ roomId, playerSymbol, token }) => {
    try {
      // Check rate limiting for anonymous users
      if (!checkRateLimit(socket)) {
        socket.emit('error', 'Rate limit exceeded');
        return;
      }
      
      // If token is provided, verify it
      if (token) {
        admin.auth().verifyIdToken(token)
          .then(decodedToken => {
            socket.user = {
              uid: decodedToken.uid,
              email: decodedToken.email,
              name: decodedToken.name,
              anonymous: false
            };
            
            // Track this connection
            if (!activeConnections.has(decodedToken.uid)) {
              activeConnections.set(decodedToken.uid, new Set());
            }
            activeConnections.get(decodedToken.uid).add(socket.id);
            
            // Now reconnect to the game room
            handleReconnection(roomId, playerSymbol);
          })
          .catch(error => {
            console.error('Token verification error:', error);
            socket.emit('error', 'Authentication failed');
          });
      } else {
        // Handle anonymous reconnection
        handleReconnection(roomId, playerSymbol);
      }
      
      function handleReconnection(roomId, playerSymbol) {
        const room = matchmaking.reconnectPlayer(socket.id, roomId);
        if (room) {
          socket.join(roomId);
          socket.emit('game-state', room.state);
          socket.emit('room-joined', {
            roomId,
            players: Array.from(room.players.entries()),
            playerSymbol
          });
        } else {
          socket.emit('error', 'Room not found');
        }
      }
    } catch (error) {
      console.error('Error in reconnect-game:', error);
      socket.emit('error', 'Failed to reconnect to game');
    }
  });

  // Handle matchmaking with authentication
  socket.on('join-matchmaking', (playerData = {}) => {
    try {
      // Check rate limiting for anonymous users
      if (!checkRateLimit(socket)) {
        socket.emit('error', 'Rate limit exceeded');
        return;
      }
      
      // Sanitize player data to prevent XSS
      const sanitizedPlayerData = sanitizePlayerData(playerData);
      
      // Create or find a room for the player
      const room = matchmaking.findOrCreateRoom(
        socket.id, 
        sanitizedPlayerData,
        socket.user?.anonymous ? null : socket.user
      );

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
        
        // Add to move history
        room.moveHistory.push({
          type: 'game_start',
          players: Array.from(room.players.entries()),
          first_player: firstPlayer,
          timestamp: Date.now()
        });
        
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

  // Handle game moves with validation
  socket.on('make-move', ({ roomId, move }) => {
    try {
      // Check rate limiting for anonymous users
      if (!checkRateLimit(socket)) {
        socket.emit('error', 'Rate limit exceeded');
        return;
      }
      
      // Validate move data structure
      if (!validateMoveData(move)) {
        socket.emit('error', 'Invalid move data structure');
        return;
      }
      
      const room = matchmaking.getRoom(roomId);
      if (!room) {
        socket.emit('error', 'Room not found');
        return;
      }

      // Verify the player is in this room
      const player = room.getPlayerData(socket.id);
      if (!player) {
        socket.emit('error', 'Player not found in this room');
        return;
      }
      
      // Check game state
      if (room.status !== 'playing') {
        socket.emit('error', 'Game not in progress');
        return;
      }

      // Check if it's this player's turn
      if (room.state.currentPlayer !== player.symbol) {
        socket.emit('error', 'Not your turn');
        return;
      }
      
      // Validate the move against the current game state
      if (!room.validateMove(move, socket.id)) {
        socket.emit('error', 'Invalid move');
        return;
      }

      // Clear the turn timer as the player made a move
      room.clearTurnTimer();

      // Update the state and switch the current player
      const updatedState = {
        ...move,
        currentPlayer: player.symbol === 'X' ? 'O' : 'X'
      };
      
      // Record this move in history
      room.recordMove(socket.id, updatedState);

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
      // Check rate limiting for anonymous users
      if (!checkRateLimit(socket)) {
        socket.emit('error', 'Rate limit exceeded');
        return;
      }
      
      const room = matchmaking.getRoom(roomId);
      if (!room) {
        socket.emit('error', 'Room not found');
        return;
      }
      
      // Verify the player is in this room
      if (!room.getPlayerData(socket.id)) {
        socket.emit('error', 'Player not found in this room');
        return;
      }

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
      // Check rate limiting for anonymous users
      if (!checkRateLimit(socket)) {
        socket.emit('error', 'Rate limit exceeded');
        return;
      }
      
      const room = matchmaking.getRoom(roomId);
      if (!room) {
        socket.emit('error', 'Room not found');
        return;
      }
      
      // Verify the player is in this room
      if (!room.getPlayerData(socket.id)) {
        socket.emit('error', 'Player not found in this room');
        return;
      }

      room.state = room.getInitialGameState();
      room.status = 'playing';
      room.updateActivity();
      
      // Add to move history
      room.moveHistory.push({
        type: 'rematch',
        timestamp: Date.now()
      });
      
      // Perform a coin toss for the rematch
      const firstPlayer = room.performCoinToss();
      
      // Add to move history
      room.moveHistory.push({
        type: 'coin_toss',
        result: firstPlayer,
        timestamp: Date.now()
      });
      
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
      // Check rate limiting for anonymous users
      if (!checkRateLimit(socket)) {
        socket.emit('error', 'Rate limit exceeded');
        return;
      }
      
      console.log('Player intentionally leaving:', socket.id, roomId);
      const room = matchmaking.getRoom(roomId);
      if (!room) {
        socket.emit('error', 'Room not found');
        return;
      }
      
      // Verify the player is in this room
      if (!room.getPlayerData(socket.id)) {
        socket.emit('error', 'Player not found in this room');
        return;
      }
      
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
    } catch (error) {
      console.error('Error in leave-game handler:', error);
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    try {
      console.log('Player disconnected:', socket.id);
      
      // Clean up authentication tracking if this was an authenticated user
      if (socket.user && !socket.user.anonymous) {
        const uid = socket.user.uid;
        if (activeConnections.has(uid)) {
          activeConnections.get(uid).delete(socket.id);
          if (activeConnections.get(uid).size === 0) {
            activeConnections.delete(uid);
          }
        }
      }
      
      // Handle game room cleanup
      const { roomId, player, remainingPlayer } = matchmaking.removePlayer(socket.id);
      
      if (roomId) {
        const room = matchmaking.getRoom(roomId);
        if (room) {
          const eventData = {
            playerId: socket.id,
            gameState: room.state,
            remainingPlayers: Array.from(room.players.entries()),
            gameStatus: room.status,
            reason: 'disconnect',
            leftPlayer: player,
            remainingPlayer: remainingPlayer
          };
          
          // Emit updated game state and player info
          io.to(roomId).emit('player-left', eventData);

          // Clean up empty rooms
          if (room.players.size === 0) {
            console.log('Removing empty room:', roomId);
            matchmaking.rooms.delete(roomId);
          }
        }
      }
    } catch (error) {
      console.error('Error in disconnect handler:', error);
      console.error('Error stack:', error.stack);
    }
  });
});

// Security related reporting routes
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: Date.now()
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
  console.log(`Secure server running on port ${PORT}`);
});