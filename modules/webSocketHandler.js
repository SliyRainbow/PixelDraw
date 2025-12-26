const { log, logError } = require('./logger');
const config = require('./config');
const https = require('https'); // 引入https模块用于请求API

class WebSocketHandler {
    constructor(io, dataPersistence) {
        this.io = io;
        this.dataPersistence = dataPersistence;
        this.userRateLimits = {};
        this.activeConnections = new Map();
        
        // 添加Session内存存储
        this.sessions = new Map();

        // 添加Socket中间件进行鉴权
        this.io.use(async (socket, next) => {
            const auth = socket.handshake.auth || {};
            const token = auth.token;
            const sessionKey = auth.sessionKey;

            // 默认设置为游客身份
            socket.user = { isGuest: true, id: null, nickname: 'Guest' };

            if (sessionKey && this.sessions.has(sessionKey)) {
                socket.user = this.sessions.get(sessionKey);
                return next();
            }

            if (token) {
                const user = await this.verifyToken(token);
                if (user) {
                    const newSessionKey = 'sess_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                    this.sessions.set(newSessionKey, user);
                    // 将用户信息挂载到 socket
                    socket.user = user;
                    socket.newSessionKey = newSessionKey; // 暂存，连接成功后发给客户端
                }
            }
            
            next();
        });

        this.setupSocketHandlers();
    }

    // 对接后端API
    async verifyToken(token) {
        return new Promise((resolve) => {
            const verifyUrl = `https://eqmemory.cn/eu-json/eu-connect/v1/user-profile?token=${token}`;
            
            // 添加 User-Agent 防止被防火墙拦截，添加 Accept 声明接受 JSON
            const options = {
                headers: {
                    'User-Agent': 'PixelDraw-Server/1.0',
                    'Accept': 'application/json'
                }
            };

            const req = https.get(verifyUrl, options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    // 检查状态码
                    if (res.statusCode !== 200) {
                        logError(`Token验证请求失败，状态码: ${res.statusCode}`);
                        logError(`响应内容摘要: ${data.substring(0, 100)}...`);
                        resolve(null);
                        return;
                    }

                    try {
                        const userInfo = JSON.parse(data);
                        
                        if (userInfo && userInfo.id && !userInfo.error) {
                            resolve({
                                id: userInfo.id,
                                nickname: userInfo.nickname,
                                avatar: userInfo.avatar,
                                isGuest: false
                            });
                        } else {
                            resolve(null);
                        }
                    } catch (e) {
                        logError(`Token验证解析失败: ${e.message}`);
                        logError(`原始响应: ${data.substring(0, 200)}...`);
                        resolve(null);
                    }
                });
            });

            req.on('error', (e) => {
                logError('Token验证网络错误: ' + e.message);
                resolve(null);
            });
        });
    }

    setupSocketHandlers() {
        this.io.on('connection', (socket) => {
            const userIP = this.getUserIP(socket);
            const user = socket.user; // 获取鉴权后的用户对象

            log(`用户连接: ${userIP} (Socket: ${socket.id}, User: ${user.nickname})`);

            this.activeConnections.set(socket.id, {
                socket: socket,
                userIP: userIP,
                user: user, // 保存用户信息到连接记录
                connectedAt: Date.now()
            });

            if (!user.isGuest) {
                socket.emit('login-success', {
                    user: {
                        id: user.id,
                        nickname: user.nickname,
                        avatar: user.avatar
                    },
                    sessionKey: socket.newSessionKey // 发送新的 SessionKey 给客户端保存
                });
                delete socket.newSessionKey;
            }

            socket.emit('init-board', { 
                board: this.dataPersistence.getBoard(), 
                boardWidth: config.BOARD_WIDTH,
                boardHeight: config.BOARD_HEIGHT,
                minZoom: config.MIN_ZOOM,
                maxZoom: config.MAX_ZOOM,
                maxPixels: config.MAX_PIXELS_PER_WINDOW
            });
            
            this.updateUserQuota(socket); // 传入 socket 以便根据用户ID更新配额

            socket.on('draw-pixel', ({ x, y, color }) => {
                this.handleDrawPixel(socket, x, y, color); // 传入 socket
            });

            socket.on('disconnect', () => {
                log(`用户断开连接: ${userIP} (Socket: ${socket.id})`);
                this.activeConnections.delete(socket.id);
            });

            socket.on('request-quota-update', () => {
                this.updateUserQuota(socket);
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

    handleDrawPixel(socket, x, y, color) {
        // 游客检查
        if (socket.user.isGuest) {
            socket.emit('error-message', '游客无法绘图，请先登录！');
            return;
        }

        if (x < 0 || x >= config.BOARD_WIDTH || y < 0 || y >= config.BOARD_HEIGHT) {
            return;
        }

        const currentColor = this.dataPersistence.getPixel(x, y);
        if (currentColor === color) {
            return;
        }

        const now = Date.now();
        
        // 使用用户ID作为限流键，而不是IP
        const rateLimitKey = socket.user.id;
        
        let userLimit = this.userRateLimits[rateLimitKey];

        if (!userLimit) {
            userLimit = {
                tokens: config.MAX_PIXELS_PER_WINDOW,
                lastRefillTime: now,
                maxTokens: config.MAX_PIXELS_PER_WINDOW
            };
            this.userRateLimits[rateLimitKey] = userLimit;
        }

        const timeSinceLastRefill = now - userLimit.lastRefillTime;
        const tokensToRefill = Math.floor(timeSinceLastRefill / (60 * 1000)); // 每分钟1个
        
        if (tokensToRefill > 0) {
            userLimit.tokens = Math.min(userLimit.tokens + tokensToRefill, userLimit.maxTokens);
            userLimit.lastRefillTime = now;
        }

        if (userLimit.tokens > 0) {
            userLimit.tokens -= 1;
            
            if (this.dataPersistence.updatePixel(x, y, color)) {
                this.io.emit('pixel-update', { x, y, color });
                this.updateUserQuota(socket);
            }
        } else {
            // 计算还需要等待多少秒
            const waitTime = 60 - Math.floor((now - userLimit.lastRefillTime) / 1000) % 60;
            socket.emit('error-message', `像素已用完！请等待 ${waitTime} 秒。`);
        }
    }

    updateUserQuota(socket) {
        // 如果是游客，配额显示为0
        if (socket.user.isGuest) {
            socket.emit('quota-update', 0, null);
            return;
        }

        const now = Date.now();
        const rateLimitKey = socket.user.id; // 使用用户ID
        
        let userLimit = this.userRateLimits[rateLimitKey];
        
        if (!userLimit) {
            userLimit = {
                tokens: config.MAX_PIXELS_PER_WINDOW,
                lastRefillTime: now,
                maxTokens: config.MAX_PIXELS_PER_WINDOW
            };
            this.userRateLimits[rateLimitKey] = userLimit;
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
        for (const [key, limit] of Object.entries(this.userRateLimits)) {
            if (now > limit.lastRefillTime + (5 * 60 * 1000)) {
                delete this.userRateLimits[key];
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
