const fs = require('fs');
const path = require('path');
const { log, logError } = require('./logger');
const config = require('./config');

class DataPersistence {
    constructor() {
        this.board = Array(config.BOARD_HEIGHT).fill(null).map(() => 
            Array(config.BOARD_WIDTH).fill('#FFFFFF')
        );
        // 初始化会话和用户配额，用于存储持久化数据
        this.sessions = new Map();
        this.userRateLimits = {};
        this.lastSave = null;
        this.createBackupDir();
    }

    createBackupDir() {
        if (!fs.existsSync(path.join(__dirname, '..', 'backup'))) {
            fs.mkdirSync(path.join(__dirname, '..', 'backup'), { recursive: true });
        }
    }

    // 将 loadBoardData 方法扩展为加载所有应用数据
    loadData() {
        try {
            if (fs.existsSync(path.join(__dirname, '..', 'board_data.json'))) {
                const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'board_data.json'), 'utf8'));
                if (data.board && Array.isArray(data.board)) {
                    this.board = data.board;
                    this.lastSave = data.lastSave;
                    log('画板数据加载成功');
                }
            }
        } catch (error) {
            logError('画板数据加载失败: ' + error);
        }
        
        // 加载持久化的会话数据
        try {
            const sessionPath = path.join(__dirname, '..', 'sessions.json');
            if (fs.existsSync(sessionPath)) {
                const data = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
                this.sessions = new Map(data);
                log('会话数据加载成功');
            }
        } catch (error) {
            logError('会话数据加载失败: ' + error);
        }

        // 加载持久化的用户配额数据
        try {
            const rateLimitPath = path.join(__dirname, '..', 'rate_limits.json');
            if (fs.existsSync(rateLimitPath)) {
                this.userRateLimits = JSON.parse(fs.readFileSync(rateLimitPath, 'utf8'));
                log('用户配额数据加载成功');
            }
        } catch (error) {
            logError('用户配额数据加载失败: ' + error);
        }
    }

    // 将 saveBoardData 方法扩展为保存所有应用数据
    saveBoardData(isBackup = false) {
        return new Promise((resolve, reject) => {
            try {
                if (isBackup && !config.ENABLE_BACKUP) {
                    resolve();
                    return;
                }
                
                this.lastSave = new Date().toISOString();

                if (isBackup) {
                    const data = {
                        board: this.board,
                        boardWidth: config.BOARD_WIDTH,
                        boardHeight: config.BOARD_HEIGHT,
                        lastSave: this.lastSave
                    };
                    const fileName = path.join(path.join(__dirname, '..', 'backup'), `board_backup_${Date.now()}.json`);
                    fs.writeFile(fileName, JSON.stringify(data, null, 2), (err) => {
                        if (err) {
                            logError('数据备份失败: ' + err);
                            reject(err);
                        } else {
                            this.cleanOldBackups();
                            resolve();
                        }
                    });
                    return;
                }

                // 使用 Promise.all 并发保存所有数据
                const saveDataPromises = [];

                // 准备画板数据保存
                const boardData = { board: this.board, boardWidth: config.BOARD_WIDTH, boardHeight: config.BOARD_HEIGHT, lastSave: this.lastSave };
                const boardPath = path.join(__dirname, '..', 'board_data.json');
                saveDataPromises.push(fs.promises.writeFile(boardPath, JSON.stringify(boardData, null, 2)));

                // 准备会话数据保存
                const sessionPath = path.join(__dirname, '..', 'sessions.json');
                const sessionData = JSON.stringify(Array.from(this.sessions.entries()));
                saveDataPromises.push(fs.promises.writeFile(sessionPath, sessionData));
                
                // 准备用户配额数据保存
                const rateLimitPath = path.join(__dirname, '..', 'rate_limits.json');
                const rateLimitData = JSON.stringify(this.userRateLimits, null, 2);
                saveDataPromises.push(fs.promises.writeFile(rateLimitPath, rateLimitData));

                Promise.all(saveDataPromises).then(resolve).catch(err => {
                    logError('数据保存失败: ' + err);
                    reject(err);
                });

            } catch (error) {
                logError('数据保存失败: ' + error);
                reject(error);
            }
        });
    }

    cleanOldBackups() {
        try {
            const backupDir = path.join(__dirname, '..', 'backup');
            if (!fs.existsSync(backupDir)) {
                return;
            }
            const files = fs.readdirSync(backupDir)
                .filter(file => file.startsWith('board_backup_') && file.endsWith('.json'))
                .map(file => ({
                    name: file,
                    path: path.join(backupDir, file),
                    time: fs.statSync(path.join(backupDir, file)).mtime.getTime()
                }))
                .sort((a, b) => b.time - a.time);
            if (files.length > config.MAX_BACKUPS) {
                const filesToDelete = files.slice(config.MAX_BACKUPS);
                filesToDelete.forEach(file => {
                    fs.unlinkSync(file.path);
                    log(`删除旧备份: ${file.name}`);
                });
            }
        } catch (error) {
            logError('旧备份删除失败: ' + error);
        }
    }

    getBoard() {
        return this.board;
    }

    // 提供对会话数据的访问接口
    getSessions() {
        return this.sessions;
    }

    //提供对用户配额数据的访问接口
    getUserRateLimits() {
        return this.userRateLimits;
    }

    setBoard(board) {
        this.board = board;
    }

    updatePixel(x, y, color) {
        if (x >= 0 && x < config.BOARD_WIDTH && y >= 0 && y < config.BOARD_HEIGHT) {
            this.board[y][x] = color;
            return true;
        }
        return false;
    }

    getPixel(x, y) {
        if (x >= 0 && x < config.BOARD_WIDTH && y >= 0 && y < config.BOARD_HEIGHT) {
            return this.board[y][x];
        }
        return null;
    }
}

module.exports = DataPersistence;
