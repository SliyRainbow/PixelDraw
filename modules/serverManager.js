const express = require('express');
const http = require('http');
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
    }

    start() {
        console.log(`   _____ _         _ ____`);
        console.log(`  |  _  |_|_ _ ___| |    \\ ___ ___ _ _ _`);
        console.log(`  |   __| |_'_| -_| |  |  |  _| .'| | | |`);
        console.log(`  |__|  |_|_,_|___|_|____/|_| |__,|_____|`);
        console.log(`             ----Draw Magic!----`);
        console.log(``);

        this.dataPersistence.loadBoardData();

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

                log('正在创建备份');
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