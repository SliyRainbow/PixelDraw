const socket = io();
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const quotaSpan = document.getElementById('quota');
const recoveryProgressBar = document.getElementById('recoveryProgressBar');
const statusDiv = document.getElementById('status');

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

window.addEventListener('resize', resizeCanvas);
function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    if (offsetX === 0 && offsetY === 0) {
        const optimalScale = Math.min(
            (canvas.width * 0.8) / BOARD_WIDTH,
            (canvas.height * 0.8) / BOARD_HEIGHT
        );
        scale = Math.max(MIN_ZOOM, Math.min(optimalScale, MAX_ZOOM));
        offsetX = (canvas.width - BOARD_WIDTH * scale) / 2;
        offsetY = (canvas.height - BOARD_HEIGHT * scale) / 2;
    }
    render();
    renderColorPresets();
}

function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

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
    ctx.restore();
}

function snapToBounds() {
    const fixedScale = scale;
    const boardWidth = BOARD_WIDTH * fixedScale;
    const boardHeight = BOARD_HEIGHT * fixedScale;
    const maxOffsetX = canvas.width * 0.3;
    const maxOffsetY = canvas.height * 0.3;
    const minOffsetX = canvas.width - boardWidth - maxOffsetX;
    const minOffsetY = canvas.height - boardHeight - maxOffsetY;

    let targetOffsetX = offsetX;
    let targetOffsetY = offsetY;
    let needsSnap = false;

    if (boardWidth < canvas.width) {
        targetOffsetX = (canvas.width - boardWidth) / 2;
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

    if (boardHeight < canvas.height) {
        targetOffsetY = (canvas.height - boardHeight) / 2;
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
    e.preventDefault();
    const zoomSpeed = 0.003;
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
    } else {
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
    }
});

window.addEventListener('mouseup', () => {
    if (isDragging) {
        isDragging = false;
        snapToBounds();
    }
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