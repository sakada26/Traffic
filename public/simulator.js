let canvas = null;
let ctx = null;
let animationId = null;
let isSimulatorRunning = false;

// Sliders and stats UI references
let freqCarSlider = null;
let freqMotoSlider = null;
let speedSlider = null;
let statCarsVal = null;
let statMotosVal = null;

// Vehicle dispatches counters
let simCarsDispatched = 0;
let simMotosDispatched = 0;

// Vehicles Array
let vehicles = [];

// Detection line coordinate (X-axis center in pixels)
let detectionLineX = 0;

// Vehicle Class definition
class Vehicle {
    constructor(type, speed) {
        this.type = type; // 'car' or 'moto'
        this.width = type === 'car' ? 80 : 45;
        this.height = type === 'car' ? 45 : 25;
        
        // Spawn from left, moving to right
        this.x = -this.width;
        
        // Randomly select Lane 1 or Lane 2
        const lanes = [105, 175];
        this.y = lanes[Math.floor(Math.random() * lanes.length)] - (this.height / 2);
        
        this.speed = speed * (0.8 + Math.random() * 0.4); // slightly randomized speed
        this.color = this.getRandomColor();
        this.crossed = false;
        this.showAlert = 0; // frames to show alert box
        
        // AI detection labels
        this.confidence = (92 + Math.random() * 7).toFixed(1) + '%';
        this.label = type === 'car' ? `Car [${this.confidence}]` : `Moto [${this.confidence}]`;
    }

    getRandomColor() {
        if (this.type === 'moto') {
            const motoColors = ['#d946ef', '#a21caf', '#e879f9'];
            return motoColors[Math.floor(Math.random() * motoColors.length)];
        } else {
            const carColors = ['#06b6d4', '#3b82f6', '#10b981', '#f59e0b', '#38bdf8'];
            return carColors[Math.floor(Math.random() * carColors.length)];
        }
    }

    update() {
        this.x += this.speed;
        
        // Check if vehicle crosses detection line
        if (!this.crossed && (this.x + this.width / 2) >= detectionLineX) {
            this.crossed = true;
            this.showAlert = 30; // Flash red box for 30 frames
            triggerWebhook(this.type);
        }

        if (this.showAlert > 0) {
            this.showAlert--;
        }
    }

    draw() {
        // Draw the vehicle body
        ctx.fillStyle = this.color;
        
        if (this.type === 'car') {
            // Draw a rounded car shape
            drawRoundRect(ctx, this.x, this.y, this.width, this.height, 8, this.color, true);
            
            // Draw car wheels
            ctx.fillStyle = '#000';
            ctx.fillRect(this.x + 12, this.y - 3, 12, 4);
            ctx.fillRect(this.x + 55, this.y - 3, 12, 4);
            ctx.fillRect(this.x + 12, this.y + this.height - 1, 12, 4);
            ctx.fillRect(this.x + 55, this.y + this.height - 1, 12, 4);

            // Draw car windshield/windows
            ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
            ctx.fillRect(this.x + 48, this.y + 6, 18, this.height - 12);
            ctx.fillRect(this.x + 18, this.y + 6, 12, this.height - 12);
        } else {
            // Draw a simple motorcycle shape
            drawRoundRect(ctx, this.x, this.y, this.width, this.height, 4, this.color, true);
            
            // Draw wheels
            ctx.fillStyle = '#000';
            ctx.beginPath();
            ctx.arc(this.x + 8, this.y + this.height / 2, 7, 0, Math.PI * 2);
            ctx.arc(this.x + this.width - 8, this.y + this.height / 2, 7, 0, Math.PI * 2);
            ctx.fill();
            
            // Rider helmet
            ctx.fillStyle = '#fff';
            ctx.beginPath();
            ctx.arc(this.x + this.width / 2, this.y + this.height / 2, 6, 0, Math.PI * 2);
            ctx.fill();
        }

        // Draw AI Bounding Box & Label Overlay
        const isDetected = this.showAlert > 0;
        ctx.strokeStyle = isDetected ? '#ef4444' : (this.type === 'car' ? '#06b6d4' : '#d946ef');
        ctx.lineWidth = isDetected ? 3 : 1.5;
        
        // Draw bounding box
        ctx.strokeRect(this.x - 4, this.y - 4, this.width + 8, this.height + 8);
        
        // Draw Label Tag
        ctx.fillStyle = isDetected ? '#ef4444' : (this.type === 'car' ? '#06b6d4' : '#d946ef');
        ctx.font = 'bold 9px monospace';
        const labelText = isDetected ? 'DETECTED' : this.label;
        const textWidth = ctx.measureText(labelText).width;
        
        ctx.fillRect(this.x - 4, this.y - 17, textWidth + 8, 13);
        ctx.fillStyle = '#fff';
        ctx.fillText(labelText, this.x, this.y - 7);
    }
}

// Draw rounded rectangle utility
function drawRoundRect(c, x, y, width, height, radius, fillStyle, isFilled) {
    c.beginPath();
    c.moveTo(x + radius, y);
    c.lineTo(x + width - radius, y);
    c.quadraticCurveTo(x + width, y, x + width, y + radius);
    c.lineTo(x + width, y + height - radius);
    c.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    c.lineTo(x + radius, y + height);
    c.quadraticCurveTo(x, y + height, x, y + height - radius);
    c.lineTo(x, y + radius);
    c.quadraticCurveTo(x, y, x + radius, y);
    c.closePath();
    if (isFilled) {
        c.fillStyle = fillStyle;
        c.fill();
    }
    c.strokeStyle = 'rgba(255,255,255,0.1)';
    c.stroke();
}

// Initialise Canvas and Simulator parameters
function initSimulator() {
    if (canvas) return; // Already initialized
    
    canvas = document.getElementById('simulator-canvas');
    if (!canvas) return;
    
    ctx = canvas.getContext('2d');
    
    // Set internal dimension size matching aspect ratio 16:9
    canvas.width = 800;
    canvas.height = 450;
    
    detectionLineX = canvas.width / 2;
    
    // Gather UI control elements
    freqCarSlider = document.getElementById('sim-freq-car');
    freqMotoSlider = document.getElementById('sim-freq-moto');
    speedSlider = document.getElementById('sim-speed');
    
    statCarsVal = document.getElementById('sim-stat-cars');
    statMotosVal = document.getElementById('sim-stat-motos');
    
    // Setup Run/Stop Toggle Button
    const btnRunSim = document.getElementById('btn-toggle-sim-run');
    if (btnRunSim) btnRunSim.addEventListener('click', toggleSimulator);
    
    // Setup overlay triggers
    const btnStartOverlay = document.getElementById('btn-start-sim-overlay');
    const playTrigger = document.querySelector('.play-trigger');
    if (btnStartOverlay) btnStartOverlay.addEventListener('click', toggleSimulator);
    if (playTrigger) playTrigger.addEventListener('click', toggleSimulator);
}

// Toggle simulation active state
function toggleSimulator() {
    const btn = document.getElementById('btn-toggle-sim-run');
    const icon = document.getElementById('sim-run-icon');
    const text = document.getElementById('sim-run-text');
    
    if (isSimulatorRunning) {
        // Stop
        isSimulatorRunning = false;
        cancelAnimationFrame(animationId);
        if (btn) btn.className = 'btn btn-primary';
        if (icon) icon.setAttribute('data-lucide', 'play');
        if (text) text.textContent = 'Start Simulator';
        lucide.createIcons();
        
        // Show overlay, hide detection label
        const overlay = document.getElementById('simulator-overlay');
        const label = document.getElementById('detection-zone-label');
        if (overlay) overlay.classList.remove('hidden');
        if (label) label.classList.add('hidden');
        
        // Reset and sync status
        vehicles = [];
        updateSimulatorStatusOnServer();
    } else {
        // Start
        isSimulatorRunning = true;
        if (btn) btn.className = 'btn btn-secondary';
        if (icon) icon.setAttribute('data-lucide', 'square');
        if (text) text.textContent = 'Stop Simulator';
        lucide.createIcons();
        
        // Hide overlay, show detection label
        const overlay = document.getElementById('simulator-overlay');
        const label = document.getElementById('detection-zone-label');
        if (overlay) overlay.classList.add('hidden');
        if (label) label.classList.remove('hidden');
        
        updateSimulatorStatusOnServer();
        loop();
    }
}

// Send counting trigger to Python backend
async function triggerWebhook(type) {
    try {
        const response = await fetch('/api/detection', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: type })
        });
        const res = await response.json();
        console.log(`Simulator webhook fired for ${type}:`, res);
    } catch (e) {
        console.error('Error reporting simulated vehicle:', e);
    }
}

// Simulator draw and state Loop
function loop() {
    if (!isSimulatorRunning) return;
    
    updateState();
    drawScene();
    
    animationId = requestAnimationFrame(loop);
}

function updateState() {
    // 1. Spawning logic
    const carFreq = parseInt(freqCarSlider.value);
    const motoFreq = parseInt(freqMotoSlider.value);
    const speed = parseInt(speedSlider.value);
    
    // Cars spawning
    // High freq slider maps to higher probability
    if (Math.random() < (carFreq / 2500)) {
        vehicles.push(new Vehicle('car', speed));
        simCarsDispatched++;
        statCarsVal.textContent = simCarsDispatched;
    }

    // Motos spawning
    if (Math.random() < (motoFreq / 2000)) {
        vehicles.push(new Vehicle('moto', speed));
        simMotosDispatched++;
        statMotosVal.textContent = simMotosDispatched;
    }

    // 2. Update existing vehicles
    vehicles.forEach(v => v.update());
    
    // 3. Clear vehicles out of bounds
    vehicles = vehicles.filter(v => v.x < canvas.width + 100);
    
    // 4. Update status count on server
    updateSimulatorStatusOnServer();
}

function drawScene() {
    // 1. Draw Road Background
    ctx.fillStyle = '#1c1e28'; // Dark asphalt
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Draw grassy curbs (top & bottom margins)
    ctx.fillStyle = '#0f1118';
    ctx.fillRect(0, 0, canvas.width, 50);
    ctx.fillRect(0, canvas.height - 50, canvas.width, 50);
    
    // Curbs edge boundaries lines
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 50); ctx.lineTo(canvas.width, 50);
    ctx.moveTo(0, canvas.height - 50); ctx.lineTo(canvas.width, canvas.height - 50);
    ctx.stroke();

    // 2. Draw Lanes & Lane Dividers
    const middleY = canvas.height / 2;
    ctx.strokeStyle = '#f59e0b'; // Yellow center dashed line
    ctx.lineWidth = 3;
    ctx.setLineDash([20, 15]);
    ctx.beginPath();
    ctx.moveTo(0, middleY);
    ctx.lineTo(canvas.width, middleY);
    ctx.stroke();
    ctx.setLineDash([]); // Reset line dash

    // 3. Draw Camera Detection Line (Vertical Red/Orange line)
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.45)';
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(detectionLineX, 50);
    ctx.lineTo(detectionLineX, canvas.height - 50);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw active glowing rings along the detection line
    ctx.fillStyle = 'rgba(239, 68, 68, 0.7)';
    ctx.beginPath();
    ctx.arc(detectionLineX, 105, 4, 0, Math.PI * 2);
    ctx.arc(detectionLineX, 175, 4, 0, Math.PI * 2);
    ctx.fill();

    // 4. Draw Vehicles
    vehicles.forEach(v => v.draw());
    
    // 5. Drawing HUD / AI Feed Stats Overlay
    ctx.fillStyle = 'rgba(10, 11, 16, 0.7)';
    ctx.fillRect(15, 60, 190, 45);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.strokeRect(15, 60, 190, 45);
    
    ctx.fillStyle = '#06b6d4';
    ctx.font = 'bold 9px monospace';
    ctx.fillText('CAMERA FPS: 30', 25, 75);
    ctx.fillStyle = '#10b981';
    ctx.fillText('ANALYTICS: ACTIVE', 25, 90);
}

let lastSimCount = -1;
function updateSimulatorStatusOnServer() {
    let currentCount = isSimulatorRunning ? vehicles.length : 0;
    if (currentCount !== lastSimCount) {
        lastSimCount = currentCount;
        fetch('/api/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ count: currentCount })
        }).catch(err => console.error("Error updating simulator status:", err));
    }
}
