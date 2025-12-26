// 获取URL中的Token和本地存储的SessionKey
const urlParams = new URLSearchParams(window.location.search);
const euToken = urlParams.get('eu_token');
const euSessionKey = localStorage.getItem('eu_session_key');

// 初始化Socket连接，携带认证信息
const socket = io({
    auth: {
        token: euToken,
        sessionKey: euSessionKey
    }
});

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const quotaSpan = document.getElementById('quota');
const recoveryProgressBar = document.getElementById('recoveryProgressBar');
const statusDiv = document.getElementById('status');
const connectionStatusDiv = document.getElementById('connection-status');
const pingTextSpan = document.getElementById('ping-text');

// 获取UI元素引用
const loginBtn = document.getElementById('loginBtn');
const userInfoDiv = document.getElementById('userInfo');
const userAvatar = document.getElementById('userAvatar');
const userName = document.getElementById('userName');

const BROADCAST_VERSION_KEY = 'pixelDraw_broadcastVersion';
let BOARD_WIDTH;
let BOARD_HEIGHT;
let board = [];
let selectedColor = '#000000';
let isEraserSelected = false;
let MIN_ZOOM;
let MAX_ZOOM;
const COLOR_PRESETS_KEY = 'pixelDraw_colorPresets';
const MAX_COLOR_PRESETS = 10;
let colorPresets = [];
let scale;
let offsetX = 0;
let offsetY = 0;
let isDragging = false;
let lastMousePos = { x: 0, y: 0 };
let hoverPixel = null;
let initialPinchDistance = 0;
let initialScale = 1;
let initialTouchCenter = { x: 0, y: 0 };
let initialOffset = { x: 0, y: 0 };
let isPinching = false;
let wasPinching = false;
let touchStartTime = 0;
let touchStartPos = { x: 0, y: 0 };
let lastTouchPos = { x: 0, y: 0 };
let isTouchDragging = false;
let pixelRecoveryInterval;
let currentQuota = 10;
let maxQuota;
let recoveryCountdown = 0;
let isAnimating = false;
let zoomAnimationId = null;
let zoomStartTime = null;
let zoomStartScale = null;
let zoomStartOffsetX = null;
let zoomStartOffsetY = null;
let zoomTargetScale = null;
let zoomTargetOffsetX = null;
let zoomTargetOffsetY = null;
let reconnectInterval = null;
const RECONNECT_DELAY = 10000;
let pingInterval = null;
let currentPing = 0;

if (loginBtn) {
    loginBtn.addEventListener('click', () => {
        window.location.href = 'https://eqmemory.cn/eu-authorize/?callback=' + encodeURIComponent(window.location.href);
    });
}

function updateConnectionStatus(status) {
    connectionStatusDiv.className = 'connection-status ' + status;
    const statusText = connectionStatusDiv.querySelector('.status-text');
    switch (status) {
        case 'connected':
            statusText.textContent = '已连接';
            break;
        case 'reconnecting':
            statusText.textContent = '重连中...';
            break;
    }
}

function measurePing() {
    const startTime = Date.now();
    socket.emit('ping');
    socket.once('pong', () => {
        currentPing = Date.now() - startTime;
        pingTextSpan.textContent = currentPing + 'ms';
    });
}

function startPingMeasurement() {
    if (pingInterval) {
        clearInterval(pingInterval);
    }
    measurePing();
    pingInterval = setInterval(measurePing, 1000);
}

function stopPingMeasurement() {
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
    pingTextSpan.textContent = '';
}

socket.on('connect', () => {
    updateConnectionStatus('connected');
    if (reconnectInterval) {
        clearInterval(reconnectInterval);
        reconnectInterval = null;
    }
    startPingMeasurement();
});

socket.on('disconnect', () => {
    updateConnectionStatus('reconnecting');
    stopPingMeasurement();
    if (!reconnectInterval) {
        reconnectInterval = setInterval(() => {
            socket.connect();
        }, RECONNECT_DELAY);
    }
});

socket.on('connect_error', () => {
    if (!socket.connected) {
        updateConnectionStatus('reconnecting');
    }
});

window.addEventListener('resize', resizeCanvas);

function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.scale(dpr, dpr);
    if (offsetX === 0 && offsetY === 0) {
        const optimalScale = Math.min(
            (window.innerWidth * 0.8) / BOARD_WIDTH,
            (window.innerHeight * 0.8) / BOARD_HEIGHT
        );
        scale = Math.max(MIN_ZOOM, Math.min(optimalScale, MAX_ZOOM));
        offsetX = (window.innerWidth - BOARD_WIDTH * scale) / 2;
        offsetY = (window.innerHeight - BOARD_HEIGHT * scale) / 2;
    }
    render();
    renderColorPresets();
}

function render() {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    ctx.fillStyle = '#eee';
    ctx.fillRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);
    board.forEach((row, y) => {
        if (y < BOARD_HEIGHT) {
            row.forEach((color, x) => {
                if (x < BOARD_WIDTH && color !== '#FFFFFF') {
                    ctx.fillStyle = color;
                    ctx.fillRect(x, y, 1, 1);
                }
            });
        }
    });
    if (scale > 10) {
        ctx.lineWidth = 0.05;
        ctx.strokeStyle = "#ccc";
        for (let i = 0; i <= BOARD_WIDTH; i++) {
            ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, BOARD_HEIGHT); ctx.stroke();
        }
        for (let i = 0; i <= BOARD_HEIGHT; i++) {
            ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(BOARD_WIDTH, i); ctx.stroke();
        }
    }
    if (hoverPixel && hoverPixel.x >= 0 && hoverPixel.x < BOARD_WIDTH && hoverPixel.y >= 0 && hoverPixel.y < BOARD_HEIGHT) {
        const pixelColor = board[hoverPixel.y][hoverPixel.x] || '#eee';
        ctx.fillStyle = darkenColor(pixelColor, 30);
        ctx.fillRect(hoverPixel.x, hoverPixel.y, 1, 1);
    }
    ctx.restore();
}

function darkenColor(color, percent) {
    const num = parseInt(color.replace('#', ''), 16);
    const amt = Math.round(2 * percent);
    const R = Math.max((num >> 16) - amt, 0);
    const G = Math.max((num >> 8 & 0x00FF) - amt, 0);
    const B = Math.max((num & 0x0000FF) - amt, 0);
    return '#' + (0x1000000 + R * 0x10000 + G * 0x100 + B).toString(16).slice(1);
}

function snapToBounds() {
    const fixedScale = scale;
    const boardWidth = BOARD_WIDTH * fixedScale;
    const boardHeight = BOARD_HEIGHT * fixedScale;
    const maxOffsetX = window.innerWidth * 0.3;
    const maxOffsetY = window.innerHeight * 0.3;
    const minOffsetX = window.innerWidth - boardWidth - maxOffsetX;
    const minOffsetY = window.innerHeight - boardHeight - maxOffsetY;
    let targetOffsetX = offsetX;
    let targetOffsetY = offsetY;
    let needsSnap = false;
    if (boardWidth < window.innerWidth) {
        targetOffsetX = (window.innerWidth - boardWidth) / 2;
        needsSnap = true;
    } else {
        if (offsetX > maxOffsetX) {
            targetOffsetX = maxOffsetX;
            needsSnap = true;
        } else if (offsetX < minOffsetX) {
            targetOffsetX = minOffsetX;
            needsSnap = true;
        }
    }
    if (boardHeight < window.innerHeight) {
        targetOffsetY = (window.innerHeight - boardHeight) / 2;
        needsSnap = true;
    } else {
        if (offsetY > maxOffsetY) {
            targetOffsetY = maxOffsetY;
            needsSnap = true;
        } else if (offsetY < minOffsetY) {
            targetOffsetY = minOffsetY;
            needsSnap = true;
        }
    }
    if (needsSnap) {
        const startX = offsetX;
        const startY = offsetY;
        const startTime = performance.now();
        const duration = 300;
        function animate(currentTime) {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const easedProgress = 1 - Math.pow(1 - progress, 3);
            offsetX = startX + (targetOffsetX - startX) * easedProgress;
            offsetY = startY + (targetOffsetY - startY) * easedProgress;
            render();
            if (progress < 1) {
                requestAnimationFrame(animate);
            } else {
                isAnimating = false;
            }
        }
        isAnimating = true;
        requestAnimationFrame(animate);
    }
}

canvas.addEventListener('wheel', (e) => {
    if (isDragging) {
        return;
    }
    e.preventDefault();
    const zoomSpeed = 0.005;
    const rawDelta = -e.deltaY;
    const zoomFactor = Math.exp(rawDelta * zoomSpeed);
    const mouseX = e.clientX;
    const mouseY = e.clientY;
    const currentScale = scale;
    const currentOffsetX = offsetX;
    const currentOffsetY = offsetY;
    let newScale = currentScale * zoomFactor;
    newScale = Math.min(Math.max(newScale, MIN_ZOOM), MAX_ZOOM);
    if (newScale === currentScale) {
        return;
    }
    const zoomRatio = newScale / currentScale;
    const newOffsetX = mouseX - (mouseX - currentOffsetX) * zoomRatio;
    const newOffsetY = mouseY - (mouseY - currentOffsetY) * zoomRatio;
    if (zoomAnimationId) {
        const elapsed = performance.now() - zoomStartTime;
        const progress = Math.min(elapsed / 150, 1);
        const easedProgress = 1 - Math.pow(1 - progress, 2);
        scale = zoomStartScale + (zoomTargetScale - zoomStartScale) * easedProgress;
        offsetX = zoomStartOffsetX + (zoomTargetOffsetX - zoomStartOffsetX) * easedProgress;
        offsetY = zoomStartOffsetY + (zoomTargetOffsetY - zoomStartOffsetY) * easedProgress;
        zoomStartScale = scale;
        zoomStartOffsetX = offsetX;
        zoomStartOffsetY = offsetY;
    } else {
        zoomStartScale = currentScale;
        zoomStartOffsetX = currentOffsetX;
        zoomStartOffsetY = currentOffsetY;
    }
    zoomTargetScale = newScale;
    zoomTargetOffsetX = newOffsetX;
    zoomTargetOffsetY = newOffsetY;
    zoomStartTime = performance.now();
    function animate() {
        const elapsed = performance.now() - zoomStartTime;
        const duration = 150;
        const progress = Math.min(elapsed / duration, 1);
        const easedProgress = 1 - Math.pow(1 - progress, 2);
        scale = zoomStartScale + (zoomTargetScale - zoomStartScale) * easedProgress;
        offsetX = zoomStartOffsetX + (zoomTargetOffsetX - zoomStartOffsetX) * easedProgress;
        offsetY = zoomStartOffsetY + (zoomTargetOffsetY - zoomStartOffsetY) * easedProgress;
        render();
        if (progress < 1) {
            zoomAnimationId = requestAnimationFrame(animate);
        } else {
            zoomAnimationId = null;
        }
    }
    if (!zoomAnimationId) {
        zoomAnimationId = requestAnimationFrame(animate);
    }
}, { passive: false });

canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0) {
        const worldX = Math.floor((e.clientX - offsetX) / scale);
        const worldY = Math.floor((e.clientY - offsetY) / scale);
        if (worldX >= 0 && worldX < BOARD_WIDTH && worldY >= 0 && worldY < BOARD_HEIGHT) {
            const drawColor = isEraserSelected ? '#FFFFFF' : selectedColor;
            if (board[worldY] && board[worldY][worldX] === drawColor) {
                return;
            }
            socket.emit('draw-pixel', { x: worldX, y: worldY, color: drawColor });
        }
    } else if (e.button === 1) {
        isDragging = true;
        lastMousePos = { x: e.clientX, y: e.clientY };
    }
});

window.addEventListener('mousemove', (e) => {
    if (isDragging) {
        offsetX += e.clientX - lastMousePos.x;
        offsetY += e.clientY - lastMousePos.y;
        lastMousePos = { x: e.clientX, y: e.clientY };
        render();
    } else {
        const worldX = Math.floor((e.clientX - offsetX) / scale);
        const worldY = Math.floor((e.clientY - offsetY) / scale);
        if (worldX >= 0 && worldX < BOARD_WIDTH && worldY >= 0 && worldY < BOARD_HEIGHT) {
            hoverPixel = { x: worldX, y: worldY };
        } else {
            hoverPixel = null;
        }
        render();
    }
});

window.addEventListener('mouseup', () => {
    if (isDragging) {
        isDragging = false;
        snapToBounds();
    }
});

canvas.addEventListener('mouseleave', () => {
    hoverPixel = null;
    render();
});

canvas.oncontextmenu = (e) => e.preventDefault();

socket.on('init-board', (data) => {
    if (data.board) {
        board = data.board;
        BOARD_WIDTH = data.boardWidth || BOARD_WIDTH;
        BOARD_HEIGHT = data.boardHeight || BOARD_HEIGHT;
        MIN_ZOOM = data.minZoom || MIN_ZOOM;
        MAX_ZOOM = data.maxZoom || MAX_ZOOM;
        maxQuota = data.maxPixels || maxQuota;
        resizeCanvas();
    } else {
        board = data;
        resizeCanvas();
    }
    renderColorPresets();
    socket.emit('request-quota-update');
    startPixelRecoveryTimer();
    hideLoadingScreen();
});

// 监听登录成功事件
socket.on('login-success', (data) => {
    // 保存SessionKey到本地，用于下次自动登录
    if (data.sessionKey) {
        localStorage.setItem('eu_session_key', data.sessionKey);
    }

    // 更新UI显示用户信息
    if (data.user) {
        if (loginBtn) loginBtn.style.display = 'none';
        if (userInfoDiv) userInfoDiv.style.display = 'flex';
        if (userName) userName.textContent = data.user.nickname || '用户';
        if (userAvatar && data.user.avatar) userAvatar.src = data.user.avatar;
    }

    showStatus('登录成功！', 'success');
});

socket.on('pixel-update', ({ x, y, color }) => {
    if (y >= 0 && y < BOARD_HEIGHT && x >= 0 && x < BOARD_WIDTH && board[y]) {
        board[y][x] = color;
    }
    render();
});

socket.on('quota-update', (q, nextRefillTime) => {
    quotaSpan.innerText = q;
    currentQuota = q;
    if (currentQuota >= maxQuota) {
        stopPixelRecoveryTimer();
        recoveryProgressBar.style.opacity = '0';
        recoveryProgressBar.style.strokeDasharray = '0, 100';
        recoveryCountdown = 0;
    } else if (nextRefillTime) {
        recoveryCountdown = nextRefillTime;
        recoveryProgressBar.style.opacity = '1';
        updateRecoveryProgress();
        startRecoveryCountdown();
    }
});

socket.on('error-message', (msg) => {
    showStatus(msg, 'error');
    const match = msg.match(/(\d+)秒后/);
    if (match) {
        recoveryCountdown = parseInt(match[1]);
        recoveryProgressBar.style.opacity = '1';
        updateRecoveryProgress();
        startRecoveryCountdown();
    }
});

function loadColorPresets() {
    const saved = localStorage.getItem(COLOR_PRESETS_KEY);
    if (saved) {
        try {
            colorPresets = JSON.parse(saved);
        } catch (e) {
            colorPresets = [];
        }
    }
}

function saveColorPresets() {
    localStorage.setItem(COLOR_PRESETS_KEY, JSON.stringify(colorPresets));
}

function addColorPreset(color) {
    const existingIndex = colorPresets.indexOf(color);
    if (existingIndex !== -1) {
        colorPresets.splice(existingIndex, 1);
    }
    colorPresets.unshift(color);
    if (colorPresets.length > MAX_COLOR_PRESETS) {
        colorPresets = colorPresets.slice(0, MAX_COLOR_PRESETS);
    }
    saveColorPresets();
    renderColorPresets();
    selectColor(color);
    return existingIndex === -1;
}

function clearColorPresets() {
    colorPresets = [];
    saveColorPresets();
    renderColorPresets();
}

function renderColorPresets() {
    const colorPicker = document.getElementById('colorPicker');
    colorPicker.innerHTML = '';
    if (colorPresets.length === 0) {
        colorPicker.style.display = 'none';
        return;
    }
    colorPicker.style.display = 'flex';
    const isMobile = window.innerWidth <= 768;
    const maxColors = isMobile ? 6 : colorPresets.length;
    colorPresets.slice(0, maxColors).forEach((color, index) => {
        const btn = document.createElement('div');
        btn.className = 'color-btn';
        btn.style.background = color;
        btn.dataset.color = color;
        if (index === 0 && selectedColor === color) {
            btn.classList.add('selected');
        }
        colorPicker.appendChild(btn);
    });
}

function selectColor(color) {
    selectedColor = color;
    isEraserSelected = false;
    document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
    document.getElementById('customColorPicker').classList.remove('selected');
    document.getElementById('eraser').classList.remove('selected');
    const targetBtn = document.querySelector(`[data-color="${color}"]`);
    if (targetBtn) {
        targetBtn.classList.add('selected');
    } else {
        document.getElementById('customColorPicker').classList.add('selected');
    }
    document.getElementById('customColorPicker').value = color;
}

function selectEraser() {
    isEraserSelected = true;
    document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
    document.getElementById('customColorPicker').classList.remove('selected');
    document.getElementById('eraser').classList.add('selected');
}

loadColorPresets();
if (colorPresets.length === 0) {
    colorPresets = ['#000000'];
    saveColorPresets();
}
if (colorPresets.length > 0) {
    selectedColor = colorPresets[0];
    document.getElementById('customColorPicker').value = selectedColor;
}

document.getElementById('customColorPicker').addEventListener('change', (e) => {
    selectColor(e.target.value);
});

document.getElementById('addColorPreset').addEventListener('click', () => {
    const color = selectedColor;
    if (addColorPreset(color)) {
        showStatus(`颜色已添加到预设`, 'success');
    }
});

document.getElementById('colorPicker').addEventListener('click', (e) => {
    if (e.target.dataset.color) {
        selectColor(e.target.dataset.color);
    }
});

document.getElementById('eraser').addEventListener('click', () => {
    selectEraser();
});

document.getElementById('broadcastBtn').addEventListener('click', () => {
    showBroadcastModalForce();
});

function showStatus(message, type = 'info') {
    const statusDiv = document.getElementById('status');
    if (statusDiv.hideTimeout) {
        clearTimeout(statusDiv.hideTimeout);
    }
    statusDiv.classList.remove('show', 'hide', 'status-success', 'status-error', 'status-warning');
    switch (type) {
        case 'success':
            statusDiv.classList.add('status-success');
            break;
        case 'error':
            statusDiv.classList.add('status-error');
            break;
        case 'warning':
            statusDiv.classList.add('status-warning');
            break;
    }
    void statusDiv.offsetWidth;
    statusDiv.innerText = message;
    statusDiv.classList.add('show');
    statusDiv.hideTimeout = setTimeout(() => {
        statusDiv.classList.add('hide');
        setTimeout(() => {
            statusDiv.innerText = '';
            statusDiv.classList.remove('show', 'hide', 'status-success', 'status-error', 'status-warning');
        }, 300);
    }, 2000);
}

function startPixelRecoveryTimer() {
    if (currentQuota < maxQuota && !pixelRecoveryInterval) {
        pixelRecoveryInterval = setInterval(() => {
            socket.emit('request-quota-update');
        }, 1000);
    }
}

function stopPixelRecoveryTimer() {
    if (pixelRecoveryInterval) {
        clearInterval(pixelRecoveryInterval);
        pixelRecoveryInterval = null;
    }
}

function startRecoveryCountdown() {
    if (currentQuota >= maxQuota) {
        recoveryProgressBar.style.opacity = '0';
        recoveryProgressBar.style.strokeDasharray = '0, 100';
        return;
    }
    if (window.recoveryCountdownInterval) {
        clearInterval(window.recoveryCountdownInterval);
    }
    updateRecoveryProgress();
    window.recoveryCountdownInterval = setInterval(() => {
        recoveryCountdown--;
        if (recoveryCountdown >= 0) {
            updateRecoveryProgress();
        } else {
            recoveryProgressBar.style.opacity = '0';
            recoveryProgressBar.style.strokeDasharray = '0, 100';
            clearInterval(window.recoveryCountdownInterval);
            setTimeout(() => {
                socket.emit('request-quota-update');
            }, 500);
        }
    }, 1000);
}

function updateRecoveryProgress() {
    const progress = 100 - (recoveryCountdown * (100 / 60));
    recoveryProgressBar.style.strokeDasharray = `${progress}, 100`;
}

window.addEventListener('beforeunload', () => {
    stopPixelRecoveryTimer();
    if (window.recoveryCountdownInterval) {
        clearInterval(window.recoveryCountdownInterval);
    }
});

function getTouchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
}

function getTouchCenter(touches) {
    return {
        x: (touches[0].clientX + touches[1].clientX) / 2,
        y: (touches[0].clientY + touches[1].clientY) / 2
    };
}

canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (e.touches.length === 2) {
        isPinching = true;
        wasPinching = true;
        initialPinchDistance = getTouchDistance(e.touches);
        initialScale = scale;
        initialTouchCenter = getTouchCenter(e.touches);
        initialOffset = { x: offsetX, y: offsetY };
    } else if (e.touches.length === 1) {
        touchStartTime = Date.now();
        touchStartPos = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        lastTouchPos = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        isTouchDragging = false;
    }
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (e.touches.length === 2 && isPinching) {
        const currentDistance = getTouchDistance(e.touches);
        const currentCenter = getTouchCenter(e.touches);
        if (initialPinchDistance > 0) {
            const zoomFactor = currentDistance / initialPinchDistance;
            let newScale = initialScale * zoomFactor;
            newScale = Math.min(Math.max(newScale, MIN_ZOOM), MAX_ZOOM);
            const scaleChange = newScale / initialScale;
            offsetX = currentCenter.x - (initialTouchCenter.x - initialOffset.x) * scaleChange;
            offsetY = currentCenter.y - (initialTouchCenter.y - initialOffset.y) * scaleChange;
            scale = newScale;
            render();
        }
    } else if (e.touches.length === 1) {
        const moveDistance = Math.sqrt(
            Math.pow(e.touches[0].clientX - touchStartPos.x, 2) +
            Math.pow(e.touches[0].clientY - touchStartPos.y, 2)
        );
        if (moveDistance > 10) {
            isTouchDragging = true;
            const dx = e.touches[0].clientX - lastTouchPos.x;
            const dy = e.touches[0].clientY - lastTouchPos.y;
            offsetX += dx;
            offsetY += dy;
            lastTouchPos = { x: e.touches[0].clientX, y: e.touches[0].clientY };
            render();
        }
    }
}, { passive: false });

canvas.addEventListener('touchend', (e) => {
    e.preventDefault();
    if (e.touches.length === 0) {
        if (isPinching) {
            isPinching = false;
            initialPinchDistance = 0;
            snapToBounds();
        } else if (!wasPinching && !isTouchDragging && Date.now() - touchStartTime < 300) {
            const worldX = Math.floor((touchStartPos.x - offsetX) / scale);
            const worldY = Math.floor((touchStartPos.y - offsetY) / scale);
            if (worldX >= 0 && worldX < BOARD_WIDTH && worldY >= 0 && worldY < BOARD_HEIGHT) {
                const drawColor = isEraserSelected ? '#FFFFFF' : selectedColor;
                if (board[worldY] && board[worldY][worldX] === drawColor) {
                    return;
                }
                socket.emit('draw-pixel', { x: worldX, y: worldY, color: drawColor });
            }
        }
        if (isTouchDragging) {
            isTouchDragging = false;
            snapToBounds();
        }
        wasPinching = false;
    } else if (e.touches.length === 1) {
        isPinching = false;
        initialPinchDistance = 0;
        touchStartTime = Date.now();
        touchStartPos = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        lastTouchPos = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        isTouchDragging = false;
    }
}, { passive: false });

canvas.addEventListener('touchcancel', (e) => {
    e.preventDefault();
    isPinching = false;
    initialPinchDistance = 0;
    if (isTouchDragging) {
        isTouchDragging = false;
        snapToBounds();
    }
}, { passive: false });

function showBroadcastModal() {
    const broadcastModal = document.getElementById('broadcast-modal');
    const broadcastContent = document.getElementById('broadcast-content');
    const closeBtn = document.querySelector('.modal-close');
    fetch('/api/broadcast')
        .then(response => response.json())
        .then(data => {
            if (data.content) {
                const currentVersion = localStorage.getItem(BROADCAST_VERSION_KEY);
                if (currentVersion === String(data.version)) {
                    return;
                }
                broadcastContent.textContent = data.content;
                broadcastModal.classList.add('show');
                const closeModal = () => {
                    broadcastModal.style.animation = 'fadeOut 0.3s ease forwards';
                    broadcastModal.querySelector('.modal-content').style.animation = 'slideOut 0.3s ease forwards';
                    setTimeout(() => {
                        broadcastModal.classList.remove('show');
                        broadcastModal.style.animation = '';
                        broadcastModal.querySelector('.modal-content').style.animation = '';
                        localStorage.setItem(BROADCAST_VERSION_KEY, String(data.version));
                    }, 300);
                };
                closeBtn.onclick = closeModal;
                broadcastModal.onclick = (e) => {
                    if (e.target === broadcastModal) {
                        closeModal();
                    }
                };
            }
        })
}

function showBroadcastModalForce() {
    const broadcastModal = document.getElementById('broadcast-modal');
    const broadcastContent = document.getElementById('broadcast-content');
    const closeBtn = document.querySelector('.modal-close');
    fetch('/api/broadcast')
        .then(response => response.json())
        .then(data => {
            if (data.content) {
                broadcastContent.textContent = data.content;
                broadcastModal.classList.add('show');
                const closeModal = () => {
                    broadcastModal.style.animation = 'fadeOut 0.3s ease forwards';
                    broadcastModal.querySelector('.modal-content').style.animation = 'slideOut 0.3s ease forwards';
                    setTimeout(() => {
                        broadcastModal.classList.remove('show');
                        broadcastModal.style.animation = '';
                        broadcastModal.querySelector('.modal-content').style.animation = '';
                    }, 300);
                };
                closeBtn.onclick = closeModal;
                broadcastModal.onclick = (e) => {
                    if (e.target === broadcastModal) {
                        closeModal();
                    }
                };
            }
        })
}

function hideLoadingScreen() {
    const loadingScreen = document.getElementById('loading-screen');
    if (loadingScreen) {
        setTimeout(() => {
            loadingScreen.classList.add('hidden');
            checkAndShowBroadcast();
        }, 800);
    }
}

function checkAndShowBroadcast() {
    setTimeout(() => {
        showBroadcastModal();
    }, 600);
}
