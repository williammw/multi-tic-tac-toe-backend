import { createServer } from 'node:http';
import { Server } from 'socket.io';

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: {
    origin: process.env.NODE_ENV === 'production' 
      ? process.env.FRONTEND_URL 
      : "http://localhost:5173",
    methods: ["GET", "POST"]
  }
});

const getInitialGameState = () => ({
  cells: Array(3).fill(null).map(() => Array(3).fill({ value: '' })),
  currentPlayer: 'X',
  gameOver: false,
  winner: null
});

let players = [];
let gameState = getInitialGameState();

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  if (players.length >= 2) {
    socket.emit('error', 'Game is full');
    socket.disconnect();
    return;
  }

  const symbol = players.length === 0 ? 'X' : 'O';
  players.push({ id: socket.id, symbol });
  socket.emit('player-symbol', symbol);
  socket.emit('game-state', gameState);

  socket.on('make-move', (newState) => {
    gameState = newState;
    io.emit('game-state', gameState);
  });

  socket.on('reset-game', () => {
    console.log('Resetting game...');
    gameState = getInitialGameState();
    io.emit('game-state', gameState);
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    players = players.filter(player => player.id !== socket.id);
    
    if (players.length === 0) {
      gameState = getInitialGameState();
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 