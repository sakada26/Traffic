let trafficChart = null;
let eventSource = null;
let currentConfig = {
    alert_threshold: 10,
    camera_url: "http://192.168.1.23/stream"
};

// UI Elements
const valCars = document.getElementById('val-cars');
const valMotos = document.getElementById('val-motos');
const valFlow = document.getElementById('val-flow');
const cardFlowRate = document.getElementById('card-flow-rate');
const logList = document.getElementById('log-list');
const alertBanner = document.getElementById('alert-banner');
const serverStatus = document.getElementById('server-status');
const cameraStream = document.getElementById('camera-stream');
const cameraFallback = document.getElementById('camera-fallback');
const fallbackUrl = document.getElementById('fallback-url');
const cameraStatusBadge = document.getElementById('camera-status');

// Webhook Simulation Elements
const webhookCopyUrl = document.getElementById('webhook-copy-url');

// Audio alert
const alertSound = document.getElementById('alert-sound');
const settingAudio = document.getElementById('setting-audio');

// Navigation Toggles
const navDashboard = document.getElementById('btn-dashboard');
const navSimulator = document.getElementById('btn-simulator');
const navSettings = document.getElementById('btn-settings');

const panelDashboard = document.getElementById('panel-dashboard');
const panelSimulator = document.getElementById('panel-simulator');
const panelSettings = document.getElementById('panel-settings');

// Initialize on Load
document.addEventListener('DOMContentLoaded', () => {
    // Initialize Lucide Icons
    lucide.createIcons();
    
    // Set up navigation
    setupNavigation();
    
    // Authenticate first, which triggers fetchStats() and setupSSE() on success
    checkAuthStatus();
    setupLoginForm();
    setupLogoutHandler();
    
    // Setup manual override trigger buttons
    setupWebhookSimulation();
    
    // Settings form submit handler
    setupSettingsForm();

    // Clear logs button
    document.getElementById('btn-clear-logs').addEventListener('click', () => {
        logList.innerHTML = '<li class="log-empty">Logs cleared. Waiting for detections...</li>';
    });

    // Setup AI Stream Controller parameters
    setupAIController();

    // Set up theme toggler and forms
    setupThemeSwitcher();
    setupAuthNavigation();
    setupSignupForm();
    setupForgotForm();
    
    // Load persisted theme
    const savedTheme = localStorage.getItem('trafical-theme') || 'dark';
    applyTheme(savedTheme);
});

// Navigation Handling
function setupNavigation() {
    const panels = [
        { btn: navDashboard, panel: panelDashboard },
        { btn: navSimulator, panel: panelSimulator },
        { btn: navSettings, panel: panelSettings }
    ];

    panels.forEach(p => {
        p.btn.addEventListener('click', (e) => {
            e.preventDefault();
            
            // Remove active classes
            panels.forEach(x => {
                x.btn.classList.remove('active');
                x.panel.classList.add('hidden');
            });
            
            // Set active class
            p.btn.classList.add('active');
            p.panel.classList.remove('hidden');

            // Specific page initializations
            if (p.btn === navSimulator) {
                // If simulator canvas is not running, start it
                if (typeof initSimulator === 'function') {
                    initSimulator();
                }
            }
        });
    });
}

// Chart.js Implementation
function initChart() {
    const ctx = document.getElementById('traffic-chart').getContext('2d');
    const isLight = document.body.classList.contains('light-theme');
    const labelColor = isLight ? '#475569' : '#9ca3af';
    const gridColor = isLight ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.04)';

    trafficChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {
                    label: 'Cars',
                    data: [],
                    borderColor: '#06b6d4',
                    backgroundColor: 'rgba(6, 182, 212, 0.05)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.3,
                    pointBackgroundColor: '#06b6d4'
                },
                {
                    label: 'Motorcycles',
                    data: [],
                    borderColor: '#d946ef',
                    backgroundColor: 'rgba(217, 70, 239, 0.05)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.3,
                    pointBackgroundColor: '#d946ef'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'top',
                    labels: {
                        color: labelColor,
                        font: { family: 'Inter', size: 11 }
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: gridColor },
                    ticks: { color: labelColor, font: { family: 'Inter', size: 10 } }
                },
                y: {
                    grid: { color: gridColor },
                    ticks: { color: labelColor, font: { family: 'Inter', size: 10 }, stepSize: 1 },
                    beginAtZero: true
                }
            }
        }
    });
}

// Fetch stats to fill chart and initial values
async function fetchStats() {
    try {
        const response = await fetch('/api/stats');
        if (!response.ok) throw new Error('Network error');
        const data = await response.json();
        updateUI(data);
        updateChart(data.history);
    } catch (err) {
        console.error('Error fetching stats:', err);
    }
}

// Setup EventSource for SSE real-time communication
function setupSSE() {
    if (eventSource) {
        eventSource.close();
    }
    
    eventSource = new EventSource('/api/events');
    
    eventSource.onopen = () => {
        serverStatus.className = 'connection-status connected';
        serverStatus.querySelector('.status-text').textContent = 'Connected to Server';
    };
    
    eventSource.onerror = () => {
        serverStatus.className = 'connection-status disconnected';
        serverStatus.querySelector('.status-text').textContent = 'Disconnected. Retrying...';
    };
    
    eventSource.onmessage = (event) => {
        if (!event.data || event.data === '{}') return;
        
        try {
            const payload = jsonParseSafe(event.data);
            if (!payload) return;
            
            const { type, data } = payload;
            
            if (type === 'init') {
                updateUI(data);
                currentConfig = data.config;
                syncSettingsUI();
            } else if (type === 'detection') {
                handleDetectionUpdate(data);
            } else if (type === 'status_change') {
                handleStatusUpdate(data);
            } else if (type === 'config') {
                currentConfig = data;
                syncSettingsUI();
                fetchStats(); // Update stats to reflect new threshold configuration
            } else if (type === 'clear') {
                valCars.textContent = '0';
                valMotos.textContent = '0';
                valFlow.textContent = '0';
                logList.innerHTML = '<li class="log-empty">No events recorded yet. Waiting for detections...</li>';
                handleStatusUpdate({ count: 0, status: 'Light', warning_active: false });
                fetchStats();
            }
        } catch (e) {
            console.error('Error processing event message:', e);
        }
    };
}

// Handle real-time detection event
function handleDetectionUpdate(data) {
    // 1. Update counter elements with animation bump
    if (data.type === 'car') {
        animateValue(valCars, data.total_cars);
    } else if (data.type === 'moto') {
        animateValue(valMotos, data.total_motos);
    }
    
    // Update Flow Rate VPM
    valFlow.textContent = data.flow_rate;
    
    // 2. Alert warning management
    updateAlertState(data.warning_active);
    
    // 3. Log event
    addLogEntry(data.type, data.timestamp);
    
    // 4. Update the chart history
    fetchStats();
}

// Animate visual number increments
function animateValue(element, newValue) {
    element.textContent = newValue;
    element.classList.add('bump');
    setTimeout(() => {
        element.classList.remove('bump');
    }, 150);
}

// Update alert overlay and state
function updateAlertState(warningActive) {
    if (warningActive) {
        document.body.classList.add('alert-active');
        alertBanner.classList.remove('hidden');
        cardFlowRate.classList.remove('alert'); // Alert is density alert now
        
        // Play alert audio warning
        if (settingAudio.checked) {
            alertSound.play().catch(e => console.log('Audio playback blocked: ', e));
        }
    } else {
        document.body.classList.remove('alert-active');
        alertBanner.classList.add('hidden');
    }
}

// Sync global variables directly with general UI
function updateUI(data) {
    valCars.textContent = data.total_cars;
    valMotos.textContent = data.total_motos;
    valFlow.textContent = data.flow_rate;
    updateAlertState(data.warning_active);
    
    // Density updates
    if (data.current_status !== undefined) {
        handleStatusUpdate({
            count: data.current_vehicle_count,
            status: data.current_status,
            warning_active: data.warning_active
        });
    }
    
    if (data.config) {
        currentConfig = data.config;
        syncSettingsUI();
    }
}

// Sync values to the input elements in setting panel and AI controller
function syncSettingsUI() {
    document.getElementById('setting-threshold').value = currentConfig.alert_threshold;
    document.getElementById('setting-camera-url').value = currentConfig.camera_url;
    
    // AI controller controls sync
    const confSlider = document.getElementById('ctrl-conf-threshold');
    const confVal = document.getElementById('val-conf-threshold');
    const showOverlayCheckbox = document.getElementById('ctrl-show-overlay');
    
    if (confSlider && currentConfig.conf_threshold !== undefined) {
        confSlider.value = currentConfig.conf_threshold;
        confVal.textContent = parseFloat(currentConfig.conf_threshold).toFixed(2);
    }
    if (showOverlayCheckbox && currentConfig.show_overlay !== undefined) {
        showOverlayCheckbox.checked = currentConfig.show_overlay;
    }
    
    // Update camera stream source
    const targetSrc = window.location.origin + '/video_feed';
    if (cameraStream.src !== targetSrc) {
        cameraStream.src = targetSrc;
        cameraStream.classList.remove('hidden');
        cameraFallback.classList.add('hidden');
        cameraStatusBadge.className = 'badge badge-success';
        cameraStatusBadge.textContent = 'Online';
    }
}

// Update Chart details
function updateChart(history) {
    if (!trafficChart) return;
    
    const labels = [];
    const carsData = [];
    const motosData = [];
    
    history.forEach(item => {
        labels.push(item.time);
        carsData.push(item.cars);
        motosData.push(item.motos);
    });
    
    trafficChart.data.labels = labels;
    trafficChart.data.datasets[0].data = carsData;
    trafficChart.data.datasets[1].data = motosData;
    trafficChart.update();
}

// Add detection log row
function addLogEntry(type, timestamp) {
    // Remove the empty log notice if it's there
    const emptyLog = logList.querySelector('.log-empty');
    if (emptyLog) {
        emptyLog.remove();
    }
    
    const timeStr = new Date(timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const li = document.createElement('li');
    li.className = 'log-item';
    
    li.innerHTML = `
        <div class="log-item-details">
            <span class="log-type ${type}">${type}</span>
            <span class="log-desc">Registered vehicle detection</span>
        </div>
        <span class="log-time">${timeStr}</span>
    `;
    
    logList.insertBefore(li, logList.firstChild);
    
    // Keep only last 15 items
    while (logList.children.length > 15) {
        logList.lastChild.remove();
    }
}

// Webhook simulation triggers
function setupWebhookSimulation() {
    const btnCar = document.getElementById('btn-trigger-car');
    const btnMoto = document.getElementById('btn-trigger-moto');
    
    btnCar.addEventListener('click', () => simulateWebhookTrigger('car'));
    btnMoto.addEventListener('click', () => simulateWebhookTrigger('moto'));
}

async function simulateWebhookTrigger(type) {
    try {
        const response = await fetch(`/api/detection?type=${type}`);
        const result = await response.json();
        console.log('Simulation trigger result:', result);
    } catch (e) {
        console.error('Error sending webhook simulation:', e);
    }
}

// Settings Forms config
function setupSettingsForm() {
    const form = document.getElementById('settings-form');
    const btnClearData = document.getElementById('btn-clear-data');
    
    if (btnClearData) {
        btnClearData.addEventListener('click', async () => {
            if (confirm("Are you sure you want to clear all vehicle counters, historical charts, and SQLite log databases? This action cannot be undone.")) {
                try {
                    const response = await fetch('/api/clear', { method: 'POST' });
                    if (response.ok) {
                        alert('All data has been cleared successfully.');
                        navDashboard.click();
                    } else {
                        alert('Failed to clear data.');
                    }
                } catch (err) {
                    console.error('Error clearing data:', err);
                    alert('Error: ' + err.message);
                }
            }
        });
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const threshold = parseInt(document.getElementById('setting-threshold').value);
        const cameraUrl = document.getElementById('setting-camera-url').value;
        
        try {
            const response = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    alert_threshold: threshold,
                    camera_url: cameraUrl
                })
            });
            
            if (response.ok) {
                const data = await response.json();
                currentConfig = data.config;
                alert('Configuration settings saved successfully.');
                
                // Return to dashboard
                navDashboard.click();
            } else {
                throw new Error('Failed to save config');
            }
        } catch (e) {
            alert('Error saving config details: ' + e.message);
        }
    });
}

// Error handlers for live camera stream
function handleStreamError() {
    cameraStream.classList.add('hidden');
    cameraFallback.classList.remove('hidden');
    fallbackUrl.textContent = "/video_feed";
    cameraStatusBadge.className = 'badge badge-warning';
    cameraStatusBadge.textContent = 'Offline';
}

function retryStream() {
    cameraStream.src = '';
    setTimeout(() => {
        cameraStream.src = '/video_feed';
        cameraStream.classList.remove('hidden');
        cameraFallback.classList.add('hidden');
        cameraStatusBadge.className = 'badge badge-success';
        cameraStatusBadge.textContent = 'Online';
    }, 100);
}

// Safe parsing helper
function jsonParseSafe(str) {
    try {
        return JSON.parse(str);
    } catch (e) {
        return null;
    }
}

// Authentication UI helper
function showLogin() {
    document.getElementById('login-screen').classList.remove('hidden');
}

function showDashboard() {
    document.getElementById('login-screen').classList.add('hidden');
    // Initialize chart if it has not been loaded yet
    if (!trafficChart) {
        initChart();
    }
    // Fetch stats and start SSE since we are authenticated now
    fetchStats();
    setupSSE();
}

async function checkAuthStatus() {
    try {
        const response = await fetch('/api/auth_status');
        const data = await response.json();
        if (data.logged_in) {
            showDashboard();
        } else {
            showLogin();
        }
    } catch (err) {
        console.error('Error checking auth status:', err);
        showLogin();
    }
}

function setupLoginForm() {
    const form = document.getElementById('login-form');
    
    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = document.getElementById('login-username').value;
            const password = document.getElementById('login-password').value;
            
            try {
                const response = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                
                if (response.ok) {
                    hideAuthAlert();
                    showDashboard();
                } else {
                    const data = await response.json().catch(() => ({}));
                    showAuthAlert(data.message || 'Invalid username or password.');
                }
            } catch (err) {
                console.error('Login error:', err);
                showAuthAlert('Network error during login.');
            }
        });
    }
}

function setupLogoutHandler() {
    const btnLogout = document.getElementById('btn-logout');
    if (btnLogout) {
        btnLogout.addEventListener('click', async () => {
            try {
                const response = await fetch('/api/logout', { method: 'POST' });
                if (response.ok) {
                    // Close SSE stream
                    if (eventSource) {
                        eventSource.close();
                    }
                    showLogin();
                }
            } catch (err) {
                console.error('Logout error:', err);
            }
        });
    }
}

function setupAIController() {
    const confSlider = document.getElementById('ctrl-conf-threshold');
    const confVal = document.getElementById('val-conf-threshold');
    const showOverlayCheckbox = document.getElementById('ctrl-show-overlay');
    
    if (confSlider) {
        confSlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value).toFixed(2);
            if (confVal) confVal.textContent = val;
        });
        
        confSlider.addEventListener('change', async (e) => {
            const val = parseFloat(e.target.value);
            saveAIConfig({ conf_threshold: val });
        });
    }
    
    if (showOverlayCheckbox) {
        showOverlayCheckbox.addEventListener('change', async (e) => {
            saveAIConfig({ show_overlay: e.target.checked });
        });
    }
}

async function saveAIConfig(configChange) {
    try {
        const response = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(configChange)
        });
        if (response.ok) {
            const data = await response.json();
            currentConfig = data.config;
            syncSettingsUI();
        }
    } catch (err) {
        console.error('Error saving AI config:', err);
    }
}

function handleStatusUpdate(data) {
    const valActiveCount = document.getElementById('val-active-count');
    const valDensity = document.getElementById('val-density');
    
    if (valActiveCount) valActiveCount.textContent = data.count;
    if (valDensity) valDensity.textContent = data.status;
    
    // Update density card classes
    const cardDensity = document.getElementById('card-density-status');
    if (cardDensity) {
        cardDensity.className = 'stat-card card-density';
        if (data.status === 'Moderate') {
            cardDensity.classList.add('moderate');
        } else if (data.status === 'Heavy') {
            cardDensity.classList.add('heavy');
        }
    }
    
    // Trigger/remove warning alert
    updateAlertState(data.warning_active);
}

// Auth notifications helper
function showAuthAlert(message, type = 'error') {
    const alertDiv = document.getElementById('auth-alert');
    const alertText = document.getElementById('auth-alert-text');
    const alertIcon = document.getElementById('auth-alert-icon');
    
    if (!alertDiv || !alertText) return;
    
    alertText.textContent = message;
    
    if (type === 'success') {
        alertDiv.className = 'login-success';
        if (alertIcon) alertIcon.setAttribute('data-lucide', 'check-circle');
    } else {
        alertDiv.className = 'login-error';
        if (alertIcon) alertIcon.setAttribute('data-lucide', 'alert-circle');
    }
    
    lucide.createIcons();
    alertDiv.classList.remove('hidden');
}

function hideAuthAlert() {
    const alertDiv = document.getElementById('auth-alert');
    if (alertDiv) alertDiv.classList.add('hidden');
}

// Switch auth forms
function setupAuthNavigation() {
    const linkForgot = document.getElementById('link-forgot');
    const linkSignup = document.getElementById('link-signup');
    const linkLoginFromSignup = document.getElementById('link-login-from-signup');
    const linkLoginFromForgot = document.getElementById('link-login-from-forgot');
    
    const loginForm = document.getElementById('login-form');
    const signupForm = document.getElementById('signup-form');
    const forgotForm = document.getElementById('forgot-form');
    
    const title = document.getElementById('auth-title');
    const subtitle = document.getElementById('auth-subtitle');
    
    const footerLogin = document.getElementById('footer-text-login');
    const footerSignup = document.getElementById('footer-text-signup');
    const footerForgot = document.getElementById('footer-text-forgot');
    
    function showForm(formType) {
        hideAuthAlert();
        
        // Hide all forms
        loginForm.classList.add('hidden');
        signupForm.classList.add('hidden');
        forgotForm.classList.add('hidden');
        
        // Hide all footers
        footerLogin.classList.add('hidden');
        footerSignup.classList.add('hidden');
        footerForgot.classList.add('hidden');
        
        if (formType === 'login') {
            title.textContent = 'System Authorization';
            subtitle.textContent = 'Please sign in to access the real-time telemetry dashboard & AI configurations.';
            loginForm.classList.remove('hidden');
            footerLogin.classList.remove('hidden');
        } else if (formType === 'signup') {
            title.textContent = 'Account Registration';
            subtitle.textContent = 'Create a new operator account to access the traffic control dashboard.';
            signupForm.classList.remove('hidden');
            footerSignup.classList.remove('hidden');
        } else if (formType === 'forgot') {
            title.textContent = 'Credential Recovery';
            subtitle.textContent = 'Reset your password using the system-wide security recovery key.';
            forgotForm.classList.remove('hidden');
            footerForgot.classList.remove('hidden');
        }
    }
    
    if (linkForgot) linkForgot.addEventListener('click', (e) => { e.preventDefault(); showForm('forgot'); });
    if (linkSignup) linkSignup.addEventListener('click', (e) => { e.preventDefault(); showForm('signup'); });
    if (linkLoginFromSignup) linkLoginFromSignup.addEventListener('click', (e) => { e.preventDefault(); showForm('login'); });
    if (linkLoginFromForgot) linkLoginFromForgot.addEventListener('click', (e) => { e.preventDefault(); showForm('login'); });
}

function setupSignupForm() {
    const form = document.getElementById('signup-form');
    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = document.getElementById('signup-username').value.trim();
            const password = document.getElementById('signup-password').value.trim();
            const confirmPassword = document.getElementById('signup-confirm-password').value.trim();
            
            if (!username || !password) {
                showAuthAlert('Username and password are required.');
                return;
            }
            if (password !== confirmPassword) {
                showAuthAlert('Passwords do not match.');
                return;
            }
            
            try {
                const response = await fetch('/api/signup', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                
                const data = await response.json();
                if (response.ok) {
                    showAuthAlert(data.message, 'success');
                    form.reset();
                    setTimeout(() => {
                        const linkLogin = document.getElementById('link-login-from-signup');
                        if (linkLogin) linkLogin.click();
                    }, 2000);
                } else {
                    showAuthAlert(data.message || 'Signup failed.');
                }
            } catch (err) {
                console.error('Signup error:', err);
                showAuthAlert('Network error during registration.');
            }
        });
    }
}

function setupForgotForm() {
    const form = document.getElementById('forgot-form');
    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = document.getElementById('forgot-username').value.trim();
            const securityKey = document.getElementById('forgot-security-key').value.trim();
            const newPassword = document.getElementById('forgot-new-password').value.trim();
            
            if (!username || !securityKey || !newPassword) {
                showAuthAlert('All fields are required.');
                return;
            }
            
            try {
                const response = await fetch('/api/reset_password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, security_key: securityKey, new_password: newPassword })
                });
                
                const data = await response.json();
                if (response.ok) {
                    showAuthAlert(data.message, 'success');
                    form.reset();
                    setTimeout(() => {
                        const linkLogin = document.getElementById('link-login-from-forgot');
                        if (linkLogin) linkLogin.click();
                    }, 2000);
                } else {
                    showAuthAlert(data.message || 'Reset failed.');
                }
            } catch (err) {
                console.error('Reset password error:', err);
                showAuthAlert('Network error during reset.');
            }
        });
    }
}

// Theme handling
function applyTheme(theme) {
    const themeCheckbox = document.getElementById('setting-theme');
    const themeText = document.getElementById('setting-theme-text');
    
    if (theme === 'light') {
        document.body.classList.add('light-theme');
        if (themeCheckbox) themeCheckbox.checked = true;
        if (themeText) themeText.textContent = 'Light Theme';
    } else {
        document.body.classList.remove('light-theme');
        if (themeCheckbox) themeCheckbox.checked = false;
        if (themeText) themeText.textContent = 'Dark Theme';
    }
    
    // Update Chart.js styles if initialized
    if (trafficChart) {
        const isLight = theme === 'light';
        const labelColor = isLight ? '#475569' : '#9ca3af';
        const gridColor = isLight ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.04)';
        
        trafficChart.options.plugins.legend.labels.color = labelColor;
        trafficChart.options.scales.x.ticks.color = labelColor;
        trafficChart.options.scales.y.ticks.color = labelColor;
        trafficChart.options.scales.x.grid.color = gridColor;
        trafficChart.options.scales.y.grid.color = gridColor;
        trafficChart.update();
    }
    
    localStorage.setItem('trafical-theme', theme);
}

function setupThemeSwitcher() {
    const themeCheckbox = document.getElementById('setting-theme');
    if (themeCheckbox) {
        themeCheckbox.addEventListener('change', (e) => {
            const newTheme = e.target.checked ? 'light' : 'dark';
            applyTheme(newTheme);
        });
    }
}
