const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const { log, logError } = require('./logger');
const config = require('./config');
const DataPersistence = require('./dataPersistence');
const WebSocketHandler = require('./webSocketHandler');

class ServerManager {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.io = new Server(this.server);
        this.dataPersistence = new DataPersistence();
        this.webSocketHandler = null;
        this.isShuttingDown = false;
        this.setupMiddleware();
        this.setupRoutes();
        this.setupGracefulShutdown();
    }

    setupMiddleware() {
        this.app.use(express.static('public'));
    }

    setupRoutes() {
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'ok',
                timestamp: new Date().toISOString(),
                uptime: process.uptime()
            });
        });
        this.app.get('/api/board/status', (req, res) => {
            res.json({
                width: config.BOARD_WIDTH,
                height: config.BOARD_HEIGHT,
                lastSave: this.dataPersistence.lastSave || null
            });
        });
        this.app.get('/api/broadcast', (req, res) => {
            const broadcastPath = path.join(__dirname, '..', 'broadcast.txt');
            const versionPath = path.join(__dirname, '..', 'broadcast-ver.json');
            let broadcastContent = '';
            let version = 1;
            fs.readFile(broadcastPath, 'utf8', (err, data) => {
                if (err) {
                    res.status(500).json({ error: '公告文件不存在' });
                    return;
                }
                broadcastContent = data;
                fs.readFile(versionPath, 'utf8', (verErr, verData) => {
                    if (verErr) {
                        version = 1;
                    } else {
                        try {
                            const verJson = JSON.parse(verData);
                            version = verJson.version || 1;
                        } catch (e) {
                            version = 1;
                        }
                    }
                    res.json({ content: broadcastContent, version: version });
                });
            });
        });
    }

    start() {
        console.log(`   _____ _         _ ____`);
        console.log(`  |  _  |_|_ _ ___| |    \\ ___ ___ _ _ _`);
        console.log(`  |   __| |_'_| -_| |  |  |  _| .'| | | |`);
        console.log(`  |__|  |_|_,_|___|_|____/|_| |__,|_____|`);
        console.log(`             ----Draw Magic!----`);
        console.log(``);
        // 调用新的统一数据加载方法以恢复所有持久化数据
        this.dataPersistence.loadData();
        this.ensureBroadcastFile();
        this.webSocketHandler = new WebSocketHandler(this.io, this.dataPersistence);
        this.setupAutoSave();
        this.setupCleanupTask();
        this.server.listen(config.PORT, () => {
            log(`服务端已启动于 http://localhost:${config.PORT}`);
        });
    }

    setupAutoSave() {
        this.autoSaveInterval = setInterval(async () => {
            try {
                // 此方法现在会保存所有应用数据（画板、会话、配额）
                await this.dataPersistence.saveBoardData();
            } catch (error) {
                logError('自动保存失败: ' + error);
            }
        }, config.AUTO_SAVE_INTERVAL * 60 * 1000);
    }

    setupCleanupTask() {
        this.cleanupInterval = setInterval(() => {
            if (this.webSocketHandler) {
                this.webSocketHandler.cleanupInactiveUsers();
            }
        }, config.RATE_LIMIT_WINDOW * 60 * 1000);
    }

    ensureBroadcastFile() {
        const broadcastPath = path.join(__dirname, '..', 'broadcast.txt');
        const versionPath = path.join(__dirname, '..', 'broadcast-ver.json');
        if (!fs.existsSync(broadcastPath)) {
            const defaultContent = `公告文件（broadcast.txt）位于项目根目录，可自定义`;
            fs.writeFileSync(broadcastPath, defaultContent, 'utf8');
        }
        if (!fs.existsSync(versionPath)) {
            const defaultVersion = { version: 1 };
            fs.writeFileSync(versionPath, JSON.stringify(defaultVersion, null, 2), 'utf8');
        }
    }

    setupGracefulShutdown() {
        const shutdown = async (signal) => {
            if (this.isShuttingDown) {
                log(`服务端正在关闭`);
                return;
            }
            this.isShuttingDown = true;
            log(`收到 ${signal} 信号，正在关闭服务端`);
            try {
                if (this.webSocketHandler) {
                    await this.webSocketHandler.disconnectAllUsers();
                }
                if (this.server.listening) {
                    await new Promise((resolve, reject) => {
                        this.server.close((err) => {
                            if (err) {
                                if (err.code === 'ERR_SERVER_NOT_RUNNING') {
                                    resolve();
                                } else {
                                    reject(err);
                                }
                            } else {
                                resolve();
                            }
                        });
                    });
                }
                if (this.io) {
                    this.io.close();
                }
                log('正在保存画板数据');
                await this.dataPersistence.saveBoardData();
                if (config.ENABLE_BACKUP) {
                    log('正在创建备份');
                }              
                await this.dataPersistence.saveBoardData(true);
                if (this.autoSaveInterval) {
                    clearInterval(this.autoSaveInterval);
                }
                if (this.cleanupInterval) {
                    clearInterval(this.cleanupInterval);
                }
                const forceExitTimeout = setTimeout(() => {
                    log('服务端已关闭');
                    process.exit(0);
                }, 10000);
                setTimeout(() => {
                    log('服务端已关闭');
                    clearTimeout(forceExitTimeout);
                    process.exit(0);
                }, 500);
            } catch (error) {
                logError('发生错误: ' + error);
                process.exit(1);
            }
        };
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('uncaughtException', (error) => {
            logError('未捕获的异常: ' + error);
            shutdown('uncaughtException');
        });
        process.on('unhandledRejection', (reason, promise) => {
            if (reason && reason.code === 'ERR_SERVER_NOT_RUNNING') {
                return;
            }
            logError('未处理的Promise拒绝: ' + reason);
            shutdown('unhandledRejection');
        });
    }
}

module.exports = ServerManager;
