const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use('/images', express.static('images'));

// Game state storage
const lobbies = new Map();
const gameStates = new Map();
const disconnectedPlayers = new Map();

// Load images from directory
let gameImages = [];
const imagesDir = path.join(__dirname, 'images');

// Create images directory if it doesn't exist
if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir);
    console.log('Created images directory. Please add images to the images/ folder.');
}

// Function to load images
function loadImages() {
    try {
        const files = fs.readdirSync(imagesDir);
        gameImages = files
            .filter(file => {
                const ext = path.extname(file).toLowerCase();
                return ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
            })
            .map(file => `/images/${file}`);
        
        console.log(`Loaded ${gameImages.length} images from the images directory`);
        
        if (gameImages.length < 3) {
            console.warn(`Warning: Need at least 3 images for Shoot Shag Marry! Currently have ${gameImages.length}`);
            console.warn('Please add more image files (jpg, jpeg, png, gif, webp) to the images/ folder');
        }
    } catch (error) {
        console.error('Error loading images:', error);
        gameImages = [];
    }
}

// Load images on startup
loadImages();

// Reload images every 5 minutes to pick up new additions
setInterval(loadImages, 5 * 60 * 1000);

// Helper function to generate lobby codes
function generateLobbyCode() {
    return Math.random().toString(36).substr(2, 6).toUpperCase();
}

// Helper function to get 3 random images (can repeat)
function getRandomImages() {
    if (gameImages.length < 3) return [];
    
    const selectedImages = [];
    for (let i = 0; i < 3; i++) {
        const randomIndex = Math.floor(Math.random() * gameImages.length);
        selectedImages.push(gameImages[randomIndex]);
    }
    return selectedImages;
}

// API Routes
app.post('/api/lobby/create', (req, res) => {
    const { username } = req.body;
    
    if (!username || username.length < 2) {
        return res.status(400).json({ error: 'Username must be at least 2 characters' });
    }
    
    const code = generateLobbyCode();
    const lobby = {
        code,
        host: username,
        participants: [{ username, isHost: true, connected: true }],
        createdAt: new Date(),
        gameStarted: false
    };
    
    lobbies.set(code, lobby);
    
    res.json({ code, lobby });
});

app.post('/api/lobby/join', (req, res) => {
    const { code, username } = req.body;
    
    if (!code || !username) {
        return res.status(400).json({ error: 'Code and username are required' });
    }
    
    const lobby = lobbies.get(code);
    if (!lobby) {
        return res.status(404).json({ error: 'Lobby not found' });
    }
    
    // Check if this is a reconnection
    const existingParticipant = lobby.participants.find(p => p.username === username);
    if (existingParticipant) {
        existingParticipant.connected = true;
        return res.json({ lobby, reconnection: true });
    }
    
    // Add new participant
    lobby.participants.push({ username, isHost: false, connected: true });
    
    // If game is active, initialize score for new player
    const gameState = gameStates.get(code);
    if (gameState) {
        gameState.scores[username] = 0;
    }
    
    res.json({ lobby });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    socket.on('join-lobby', (data) => {
        const { code, username } = data;
        socket.join(code);
        socket.username = username;
        socket.lobbyCode = code;
        
        const lobby = lobbies.get(code);
        if (lobby) {
            const participant = lobby.participants.find(p => p.username === username);
            if (participant) {
                participant.connected = true;
            }
            
            io.to(code).emit('lobby-updated', lobby);
        }
    });
    
    socket.on('leave-lobby', (data) => {
        const { code, username } = data;
        const lobby = lobbies.get(code);
        const gameState = gameStates.get(code);
        
        if (lobby) {
            if (gameState && gameState.phase !== 'waiting') {
                const participant = lobby.participants.find(p => p.username === username);
                if (participant) {
                    participant.connected = false;
                    disconnectedPlayers.set(username, { code, timestamp: Date.now() });
                }
                io.to(code).emit('lobby-updated', lobby);
            } else {
                lobby.participants = lobby.participants.filter(p => p.username !== username);
                
                if (lobby.participants.length === 0 || username === lobby.host) {
                    lobbies.delete(code);
                    gameStates.delete(code);
                    io.to(code).emit('lobby-closed');
                } else {
                    io.to(code).emit('lobby-updated', lobby);
                }
            }
        }
        
        socket.leave(code);
    });
    
    socket.on('start-game', (data) => {
        const { code, username } = data;
        const lobby = lobbies.get(code);
        
        if (lobby && lobby.host === username && lobby.participants.length >= 2) {
            if (gameImages.length < 3) {
                socket.emit('error', { message: 'Need at least 3 images to play Shoot Shag Marry. Please add more images to the images/ folder' });
                return;
            }
            
            lobby.gameStarted = true;
            
            const gameState = {
                phase: 'discussion',
                roundNumber: 1,
                totalRounds: 30,
                currentImages: [],
                votes: {},
                scores: {},
                timer: 60,
                timerInterval: null
            };
            
            // Initialize scores
            lobby.participants.forEach(participant => {
                gameState.scores[participant.username] = 0;
            });
            
            gameStates.set(code, gameState);
            
            io.to(code).emit('game-started', { lobby, gameState });
            
            setTimeout(() => {
                startDiscussionPhase(code);
            }, 2000);
        }
    });
    
    socket.on('cast-vote', (data) => {
        const { code, username, vote } = data;
        const gameState = gameStates.get(code);
        
        if (gameState && gameState.phase === 'voting' && !gameState.votes[username]) {
            // Validate vote has all three choices
            if (vote.shoot && vote.shag && vote.marry) {
                gameState.votes[username] = vote;
                console.log(`Vote cast by ${username}:`, vote);
            }
        }
    });
    
    socket.on('restart-game', (data) => {
        const { code } = data;
        const lobby = lobbies.get(code);
        const gameState = gameStates.get(code);
        
        if (lobby && gameState && socket.username === lobby.host) {
            if (gameImages.length < 3) {
                socket.emit('error', { message: 'Need at least 3 images to play Shoot Shag Marry. Please add more images to the images/ folder' });
                return;
            }
            
            gameState.phase = 'discussion';
            gameState.roundNumber = 1;
            gameState.currentImages = [];
            gameState.votes = {};
            gameState.timer = 60;
            
            lobby.participants.forEach(participant => {
                gameState.scores[participant.username] = 0;
            });
            
            if (gameState.timerInterval) {
                clearInterval(gameState.timerInterval);
            }
            
            io.to(code).emit('game-started', { lobby, gameState });
            
            setTimeout(() => {
                startDiscussionPhase(code);
            }, 2000);
        }
    });
    
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        if (socket.lobbyCode && socket.username) {
            const lobby = lobbies.get(socket.lobbyCode);
            const gameState = gameStates.get(socket.lobbyCode);
            
            if (lobby) {
                const participant = lobby.participants.find(p => p.username === socket.username);
                
                if (participant) {
                    if (gameState && gameState.phase !== 'waiting') {
                        participant.connected = false;
                        disconnectedPlayers.set(socket.username, { 
                            code: socket.lobbyCode, 
                            timestamp: Date.now() 
                        });
                        io.to(socket.lobbyCode).emit('lobby-updated', lobby);
                    } else {
                        lobby.participants = lobby.participants.filter(p => p.username !== socket.username);
                        
                        if (lobby.participants.length === 0 || socket.username === lobby.host) {
                            if (gameState && gameState.timerInterval) {
                                clearInterval(gameState.timerInterval);
                            }
                            
                            lobbies.delete(socket.lobbyCode);
                            gameStates.delete(socket.lobbyCode);
                            io.to(socket.lobbyCode).emit('lobby-closed');
                        } else {
                            io.to(socket.lobbyCode).emit('lobby-updated', lobby);
                        }
                    }
                }
            }
        }
    });
});

// Clean up old disconnected players
setInterval(() => {
    const now = Date.now();
    const timeout = 5 * 60 * 1000; // 5 minutes
    
    disconnectedPlayers.forEach((data, username) => {
        if (now - data.timestamp > timeout) {
            const lobby = lobbies.get(data.code);
            if (lobby) {
                lobby.participants = lobby.participants.filter(p => p.username !== username);
                io.to(data.code).emit('lobby-updated', lobby);
            }
            disconnectedPlayers.delete(username);
        }
    });
}, 60000);

// Game logic functions
function startDiscussionPhase(code) {
    const gameState = gameStates.get(code);
    const lobby = lobbies.get(code);
    
    if (!gameState || !lobby) return;
    
    // Check if we have enough images and haven't exceeded total rounds
    if (gameImages.length < 3 || gameState.roundNumber > gameState.totalRounds) {
        endGame(code);
        return;
    }
    
    // Get 3 random images (can repeat)
    const selectedImages = getRandomImages();
    if (selectedImages.length < 3) {
        endGame(code);
        return;
    }
    
    gameState.currentImages = selectedImages;
    gameState.phase = 'discussion';
    gameState.votes = {};
    gameState.timer = 60;
    
    if (gameState.timerInterval) {
        clearInterval(gameState.timerInterval);
    }
    
    io.to(code).emit('images-selected', { images: selectedImages });
    io.to(code).emit('game-phase-update', {
        phase: 'discussion',
        roundNumber: gameState.roundNumber
    });
    
    startTimer(code, 60, () => {
        startVotingPhase(code);
    });
}

function startVotingPhase(code) {
    const gameState = gameStates.get(code);
    
    if (!gameState) return;
    
    gameState.phase = 'voting';
    gameState.timer = 30;
    
    io.to(code).emit('game-phase-update', { phase: 'voting' });
    
    startTimer(code, 30, () => {
        calculateResults(code);
    });
}

function calculateResults(code) {
    const gameState = gameStates.get(code);
    const lobby = lobbies.get(code);
    
    if (!gameState || !lobby) return;
    
    // Count votes for each category from connected players who completed all 3 choices
    const categoryVotes = {
        shoot: {},
        shag: {},
        marry: {}
    };
    
    const validVoters = [];
    
    lobby.participants.forEach(participant => {
        if (participant.connected) {
            const vote = gameState.votes[participant.username];
            if (vote && vote.shoot && vote.shag && vote.marry) {
                validVoters.push(participant.username);
                
                // Count votes for each image in each category
                categoryVotes.shoot[vote.shoot] = (categoryVotes.shoot[vote.shoot] || 0) + 1;
                categoryVotes.shag[vote.shag] = (categoryVotes.shag[vote.shag] || 0) + 1;
                categoryVotes.marry[vote.marry] = (categoryVotes.marry[vote.marry] || 0) + 1;
            }
        }
    });
    
    console.log('Valid voters:', validVoters);
    console.log('Category votes:', categoryVotes);
    
    // Find majority choice for each category
    const majorityChoices = {};
    ['shoot', 'shag', 'marry'].forEach(category => {
        const votes = categoryVotes[category];
        let maxVotes = 0;
        let majorityImage = null;
        
        // Find the image with the most votes
        Object.entries(votes).forEach(([image, count]) => {
            if (count > maxVotes) {
                maxVotes = count;
                majorityImage = image;
            }
        });
        
        // If no votes for this category, pick the first image as default
        if (!majorityImage && gameState.currentImages.length > 0) {
            majorityImage = gameState.currentImages[0];
        }
        
        majorityChoices[category] = majorityImage;
        console.log(`Majority for ${category}: ${majorityImage} with ${maxVotes} votes`);
    });
    
    // Award points to players who matched all three majority choices
    let pointsAwarded = 0;
    const winners = [];
    
    validVoters.forEach(username => {
        const vote = gameState.votes[username];
        console.log(`Checking ${username}'s vote:`, vote);
        console.log(`Majority choices:`, majorityChoices);
        
        const shootMatch = vote.shoot === majorityChoices.shoot;
        const shagMatch = vote.shag === majorityChoices.shag;
        const marryMatch = vote.marry === majorityChoices.marry;
        
        console.log(`${username} matches - shoot: ${shootMatch}, shag: ${shagMatch}, marry: ${marryMatch}`);
        
        if (shootMatch && shagMatch && marryMatch) {
            gameState.scores[username] = (gameState.scores[username] || 0) + 1;
            pointsAwarded++;
            winners.push(username);
            console.log(`${username} gets a point! New score: ${gameState.scores[username]}`);
        }
    });
    
    console.log(`Points awarded to: ${winners.join(', ')}`);
    console.log('Updated scores:', gameState.scores);
    
    gameState.phase = 'results';
    
    io.to(code).emit('game-phase-update', { phase: 'results' });
    io.to(code).emit('round-results', {
        majorityChoices: majorityChoices,
        pointsAwarded: pointsAwarded,
        totalVoters: validVoters.length,
        winners: winners
    });
    
    setTimeout(() => {
        showScoreboard(code);
    }, 5000);
}

function showScoreboard(code) {
    const gameState = gameStates.get(code);
    
    if (!gameState) return;
    
    gameState.phase = 'scoreboard';
    
    io.to(code).emit('game-phase-update', { phase: 'scoreboard' });
    io.to(code).emit('scoreboard-update', { scores: gameState.scores });
    
    setTimeout(() => {
        gameState.roundNumber++;
        
        if (gameState.roundNumber > gameState.totalRounds) {
            endGame(code);
        } else {
            gameState.phase = 'waiting';
            io.to(code).emit('game-phase-update', { phase: 'waiting' });
            
            setTimeout(() => {
                startDiscussionPhase(code);
            }, 3000);
        }
    }, 5000);
}

function endGame(code) {
    const gameState = gameStates.get(code);
    
    if (!gameState) return;
    
    if (gameState.timerInterval) {
        clearInterval(gameState.timerInterval);
    }
    
    io.to(code).emit('game-ended', {
        finalScores: gameState.scores
    });
}

function startTimer(code, seconds, callback) {
    const gameState = gameStates.get(code);
    if (!gameState) return;
    
    gameState.timer = seconds;
    
    if (gameState.timerInterval) {
        clearInterval(gameState.timerInterval);
    }
    
    gameState.timerInterval = setInterval(() => {
        gameState.timer--;
        io.to(code).emit('game-timer', { timeRemaining: gameState.timer });
        
        if (gameState.timer <= 0) {
            clearInterval(gameState.timerInterval);
            gameState.timerInterval = null;
            callback();
        }
    }, 1000);
}

// Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('Shoot Shag Marry Game Server Started!');
    console.log('========================================');
    console.log(`Images folder: ${imagesDir}`);
    console.log(`Images loaded: ${gameImages.length}`);
    if (gameImages.length < 3) {
        console.log('\n⚠️  WARNING: Need at least 3 images!');
        console.log('Please add more image files to the images/ folder');
        console.log('Supported formats: .jpg, .jpeg, .png, .gif, .webp');
    }
    console.log('========================================');
});
