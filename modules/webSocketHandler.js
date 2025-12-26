const { log, logError } = require('./logger');
const config = require('./config');

class WebSocketHandler {
    constructor(io, dataPersistence) {
        this.io = io;
        this.dataPersistence = dataPersistence;
        this.userRateLimits = {};
        this.activeConnections = new Map();
        this.setupSocketHandlers();
    }

    setupSocketHandlers() {
        this.io.on('connection', (socket) => {
            const userIP = this.getUserIP(socket);
            log(`用户连接: ${userIP} (Socket: ${socket.id})`);

            this.activeConnections.set(socket.id, {
                socket: socket,
                userIP: userIP,
                connectedAt: Date.now()
            });

            socket.emit('init-board', { 
                board: this.dataPersistence.getBoard(), 
                boardWidth: config.BOARD_WIDTH,
                boardHeight: config.BOARD_HEIGHT,
                minZoom: config.MIN_ZOOM,
                maxZoom: config.MAX_ZOOM,
                maxPixels: config.MAX_PIXELS_PER_WINDOW
            });
            
            this.updateUserQuota(socket, userIP);

            socket.on('draw-pixel', ({ x, y, color }) => {
                this.handleDrawPixel(socket, userIP, x, y, color);
            });

            socket.on('disconnect', () => {
                log(`用户断开连接: ${userIP} (Socket: ${socket.id})`);
                this.activeConnections.delete(socket.id);
            });

            socket.on('request-quota-update', () => {
                this.updateUserQuota(socket, userIP);
            });

            socket.on('ping', () => {
                socket.emit('pong');
            });
        });
    }

getUserIP(socket) {
        let ip = socket.handshake.headers['x-forwarded-for'];
        if (ip) {
            ip = ip.split(',')[0].trim();
        } else {
            ip = socket.handshake.address;
            if (ip && ip.startsWith('::ffff:')) {
                ip = ip.substring(7);
            }
        }
        return ip || 'unknown';
    }

    handleDrawPixel(socket, userIP, x, y, color) {
        if (x < 0 || x >= config.BOARD_WIDTH || y < 0 || y >= config.BOARD_HEIGHT) {
            return;
        }

        const currentColor = this.dataPersistence.getPixel(x, y);
        if (currentColor === color) {
            return;
        }

        const now = Date.now();
        let userLimit = this.userRateLimits[userIP];

        if (!userLimit) {
            userLimit = {
                tokens: config.MAX_PIXELS_PER_WINDOW,
                lastRefillTime: now,
                maxTokens: config.MAX_PIXELS_PER_WINDOW
            };
            this.userRateLimits[userIP] = userLimit;
        }

        const timeSinceLastRefill = now - userLimit.lastRefillTime;
        const tokensToRefill = Math.floor(timeSinceLastRefill / (60 * 1000));
        
        if (tokensToRefill > 0) {
            userLimit.tokens = Math.min(userLimit.tokens + tokensToRefill, userLimit.maxTokens);
            userLimit.lastRefillTime = now;
        }

        if (userLimit.tokens > 0) {
            userLimit.tokens -= 1;
            
            if (this.dataPersistence.updatePixel(x, y, color)) {
                this.io.emit('pixel-update', { x, y, color });
                this.updateUserQuota(socket, userIP);
            }
        } else {
            socket.emit('error-message', `像素已用完！`);
        }
    }

    updateUserQuota(socket, userIP) {
        const now = Date.now();
        let userLimit = this.userRateLimits[userIP];
        
        if (!userLimit) {
            userLimit = {
                tokens: config.MAX_PIXELS_PER_WINDOW,
                lastRefillTime: now,
                maxTokens: config.MAX_PIXELS_PER_WINDOW
            };
            this.userRateLimits[userIP] = userLimit;
        }
        
        const timeSinceLastRefill = now - userLimit.lastRefillTime;
        const tokensToRefill = Math.floor(timeSinceLastRefill / (60 * 1000));
        
        if (tokensToRefill > 0) {
            userLimit.tokens = Math.min(userLimit.tokens + tokensToRefill, userLimit.maxTokens);
            userLimit.lastRefillTime = now;
        }
        
        let nextRefillTime = null;
        if (userLimit.tokens < userLimit.maxTokens) {
            const timeUntilNextRefill = 60 * 1000 - (now - userLimit.lastRefillTime) % (60 * 1000);
            nextRefillTime = Math.ceil(timeUntilNextRefill / 1000);
        }
        
        socket.emit('quota-update', userLimit.tokens, nextRefillTime);
    }

    cleanupInactiveUsers() {
        const now = Date.now();
        for (const [userIP, limit] of Object.entries(this.userRateLimits)) {
            if (now > limit.lastRefillTime + (5 * 60 * 1000)) {
                delete this.userRateLimits[userIP];
            }
        }
    }

    async disconnectAllUsers() {
        const connectionCount = this.activeConnections.size;
        log(`正在断开所有连接`);
        
        if (connectionCount === 0) {
            return;
        }
        
        this.io.emit('server-shutdown', { 
            timestamp: new Date().toISOString()
        });
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        for (const [socketId, connection] of this.activeConnections) {
            try {
                if (connection.socket.connected) {
                    connection.socket.disconnect(true);
                }
            } catch (error) {
                logError(`断开连接失败 ${connection.userIP} (${socketId}): ${error.message}`);
            }
        }
        
        await new Promise(resolve => setTimeout(resolve, 200));
        
        this.activeConnections.clear();
    }
}

module.exports = WebSocketHandler;