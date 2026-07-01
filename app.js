// State Variables
let lambda_max = 120;       // Max traffic amplitude (slider)
let mu = 30;               // Service capacity per server (slider)
let cost_server_hr = 10;   // Cost of running a server ($/hr)
let cost_sla_sec = 2.5;    // Penalty per second of latency ($/s)
let sim_speed = 1.0;       // Simulation speed multiplier
let activeStrategy = 'calcloud';
let isRunning = true;
let simTime = 0;
let simInterval = null;

// Production Friction Configuration
let startup_delay = 5;     // Ta: Boot latency (ticks/seconds)
let alpha_ema = 0.70;       // EMA smoothing weight
let anomaly_percent = 0;   // Manual load anomaly injection (%)

// Cumulative Metrics for BOTH strategies (running in parallel in background)
const metrics = {
    calcloud: {
        servers: 4,
        bootQueue: [],
        accumCost: 0.0,
        accumInfra: 0.0,
        accumSLA: 0.0,
        latencySum: 0.0,
        steps: 0,
        violations: 0,
        oscillations: 0,
        traffic_ema: 60.0,
        last_traffic_ema: 60.0
    },
    reactive: {
        servers: 4,
        bootQueue: [],
        accumCost: 0.0,
        accumInfra: 0.0,
        accumSLA: 0.0,
        latencySum: 0.0,
        steps: 0,
        violations: 0,
        oscillations: 0,
        cooldown: 0
    }
};

// History buffers for Chart.js (FIFO sliding window of 60 seconds)
const maxHistoryPoints = 60;
let trafficHistory = [];
let serversCalCloudHistory = [];
let serversReactiveHistory = [];
let timeHistory = [];
let lastSimulatedTime = new Date();

// State tracking for Toasts alerts
let lastCalCloudBootQueueLength = 0;
let lastReactiveBootQueueLength = 0;
let lastActiveViolations = 0;
let lastAnomalyPercent = 0;

// Chart instances
let realTimeChart = null;
let optimizationChart = null;

// --- SIMPLIFIED MATH MODEL (UNIT 2: DERIVATIVE AS VELOCITY) ---

// Response time (Latency W) based on a simple rational function (1 / (Capacity - Load))
function calculateLatency(S, lambda, mu) {
    const capacity = S * mu;
    if (lambda <= 0) return 1 / mu;
    if (capacity <= lambda) return 2.0; // System collapsed max penalty
    return 1 / (capacity - lambda);
}

// Cost Function: C(S) = C_infra * S + C_SLA * W(S)
function getHourlyCost(S, lambda, mu) {
    const latency = calculateLatency(S, lambda, mu);
    const costInfra = S * cost_server_hr;
    
    // SLA fine scales with latency
    const costSLA = latency > 0.15 ? (latency - 0.15) * 500 : 0; // Simple fine structure
    
    return {
        total: costInfra + costSLA,
        infra: costInfra,
        sla: costSLA,
        latency: latency
    };
}

// Simplest Server Capacity Rule:
// S = Tráfico / Capacidad del servidor (mu = 30 req/s)
function getOptimalServers(lambda) {
    return Math.max(1, Math.min(10, Math.ceil(lambda / mu)));
}

// Generate simulated traffic
function getTrafficAtTime(t) {
    const base = lambda_max * 0.45;
    const amp = lambda_max * 0.4;
    const wave = Math.sin(t / 15) + 0.35 * Math.cos(t / 5);
    let val = base + amp * wave;
    if (anomaly_percent > 0) {
        val = val * (1 + anomaly_percent / 100);
    }
    return Math.max(5, val);
}

// Toasts alerts system
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerText = message;
    container.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 50);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// Chart Initializations
function initCharts() {
    try {
        if (typeof Chart === 'undefined') {
            console.warn("Chart.js no está cargado. Los gráficos interactivos no estarán disponibles, pero la simulación continuará.");
            return;
        }
        const ctxRealTime = document.getElementById('chart-realtime').getContext('2d');
        const trafficGradient = ctxRealTime.createLinearGradient(0, 0, 0, 300);
        trafficGradient.addColorStop(0, 'rgba(6, 182, 212, 0.12)');
        trafficGradient.addColorStop(1, 'rgba(6, 182, 212, 0.00)');

        realTimeChart = new Chart(ctxRealTime, {
            type: 'line',
            data: {
                labels: timeHistory,
                datasets: [
                    {
                        label: 'Tráfico (req/s)',
                        data: trafficHistory,
                        borderColor: '#06B6D4',
                        backgroundColor: trafficGradient,
                        borderWidth: 3,
                        fill: true,
                        tension: 0.25,
                        yAxisID: 'y',
                        pointRadius: 0
                    },
                    {
                        label: 'Servidores Activos (Actual)',
                        data: [],
                        borderColor: '#22C55E',
                        borderWidth: 3,
                        pointRadius: 0,
                        fill: false,
                        tension: 0,
                        yAxisID: 'y1'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: {
                    duration: 350,
                    easing: 'easeOutQuad'
                },
                plugins: {
                    legend: { labels: { color: '#F8FAFC', font: { family: 'Inter', size: 11, weight: '500' } } },
                    tooltip: {
                        backgroundColor: '#1E293B',
                        titleColor: '#F8FAFC',
                        bodyColor: '#94A3B8',
                        borderColor: '#334155',
                        borderWidth: 1,
                        titleFont: { family: 'Inter', size: 11, weight: '600' },
                        bodyFont: { family: 'Roboto Mono', size: 10 },
                        cornerRadius: 4,
                        padding: 8
                    }
                },
                scales: {
                    x: {
                        grid: { color: 'rgba(255, 255, 255, 0.02)' },
                        ticks: { color: '#64748B', font: { family: 'Roboto Mono', size: 9 } }
                    },
                    y: {
                        title: { display: true, text: 'Peticiones (req/s)', color: '#06B6D4', font: { family: 'Inter', size: 10, weight: '600' } },
                        grid: { color: 'rgba(255, 255, 255, 0.02)' },
                        ticks: { color: '#64748B', font: { family: 'Roboto Mono', size: 9 } },
                        min: 0
                    },
                    y1: {
                        title: { display: true, text: 'Servidores', color: '#22C55E', font: { family: 'Inter', size: 10, weight: '600' } },
                        position: 'right',
                        grid: { drawOnChartArea: false },
                        ticks: { color: '#64748B', font: { family: 'Roboto Mono', size: 9 }, stepSize: 1 },
                        min: 0,
                        max: 11
                    }
                }
            }
        });

    const ctxOpt = document.getElementById('chart-optimization').getContext('2d');
    optimizationChart = new Chart(ctxOpt, {
        type: 'line',
        data: {
            labels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
            datasets: [
                {
                    label: 'Costo Total C(S)',
                    data: [],
                    borderColor: '#06B6D4',
                    backgroundColor: 'rgba(6, 182, 212, 0.02)',
                    borderWidth: 3,
                    fill: true,
                    tension: 0.3
                },
                {
                    label: 'Costo Infraestructura',
                    data: [],
                    borderColor: '#F59E0B',
                    borderWidth: 1.5,
                    borderDash: [5, 5],
                    fill: false
                },
                {
                    label: 'Costo Latencia SLA',
                    data: [],
                    borderColor: '#EF4444',
                    borderWidth: 1.5,
                    borderDash: [5, 5],
                    fill: false
                },
                {
                    label: 'Posición Actual',
                    data: [],
                    borderColor: '#22C55E',
                    backgroundColor: '#22C55E',
                    pointRadius: 6,
                    pointHoverRadius: 8,
                    showLine: false,
                    fill: false
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { labels: { color: '#F8FAFC', font: { family: 'Inter', size: 10 } } },
                tooltip: {
                    backgroundColor: '#1E293B',
                    titleColor: '#F8FAFC',
                    bodyColor: '#94A3B8',
                    borderColor: '#334155',
                    borderWidth: 1,
                    titleFont: { family: 'Inter', size: 11, weight: '600' },
                    bodyFont: { family: 'Roboto Mono', size: 10 },
                    cornerRadius: 4,
                    padding: 8
                }
            },
            scales: {
                x: {
                    title: { display: true, text: 'Número de Servidores (S)', color: '#94A3B8', font: { family: 'Inter', size: 10, weight: '600' } },
                    grid: { color: 'rgba(255, 255, 255, 0.02)' },
                    ticks: { color: '#64748B', font: { family: 'Roboto Mono', size: 9 } }
                },
                y: {
                    title: { display: true, text: 'Costo por Hora ($/h)', color: '#94A3B8', font: { family: 'Inter', size: 10, weight: '600' } },
                    grid: { color: 'rgba(255, 255, 255, 0.02)' },
                    ticks: { color: '#64748B', font: { family: 'Roboto Mono', size: 9 } },
                    min: 0
                }
            }
        }
    });
    } catch (e) {
        console.error("Error al inicializar los gráficos:", e);
    }
}

// Update Optimization Chart Curves
function updateOptimizationChart(currentTraffic, currentS) {
    if (!optimizationChart) return;
    const totalCosts = [], infraCosts = [], slaCosts = [];

    for (let s = 1; s <= 10; s++) {
        const costData = getHourlyCost(s, currentTraffic, mu);
        totalCosts.push(costData.total);
        infraCosts.push(costData.infra);
        slaCosts.push(costData.sla);
    }

    optimizationChart.data.datasets[0].data = totalCosts;
    optimizationChart.data.datasets[1].data = infraCosts;
    optimizationChart.data.datasets[2].data = slaCosts;
    optimizationChart.data.datasets[3].data = [{ x: currentS, y: totalCosts[currentS - 1] }];
    optimizationChart.update();
}

// Update Boot Queues (Decrements timer of booting servers and turns them active)
function updateBootQueue(strategyState) {
    let bootedCount = 0;
    strategyState.bootQueue = strategyState.bootQueue.map(ticksLeft => {
        const updated = ticksLeft - 1;
        if (updated <= 0) bootedCount++;
        return updated;
    }).filter(ticksLeft => ticksLeft > 0);
    
    if (bootedCount > 0) {
        strategyState.servers = Math.min(10, strategyState.servers + bootedCount);
    }
}

// Simulation Main Loop (Supports static updates when paused)
function tick(isStatic = false) {
    if (!isStatic) {
        simTime += 1;
        // Calculate simulated real time label (HH:MM:SS)
        lastSimulatedTime.setSeconds(lastSimulatedTime.getSeconds() + 1);
    }
    const timeLabel = lastSimulatedTime.toTimeString().split(' ')[0];
    
    // 1. Calculate Raw Current Traffic
    const currentTraffic = isStatic 
        ? lambda_max * (1 + anomaly_percent / 100)
        : getTrafficAtTime(simTime);
        
    const lastTraffic = trafficHistory.length > 0 ? parseFloat(trafficHistory[trafficHistory.length - 1]) : currentTraffic;
    
    // 2. Decrement server boot times only when running
    if (!isStatic) {
        updateBootQueue(metrics.calcloud);
        updateBootQueue(metrics.reactive);
    }

    // --- STRATEGY A: CALCLOUD (EMA SMOOTHING + PREDICTIVE VELOCITY DERIVATIVE) ---
    
    // Apply Exponential Moving Average (EMA) filter
    metrics.calcloud.traffic_ema = alpha_ema * currentTraffic + (1 - alpha_ema) * metrics.calcloud.traffic_ema;
    
    // Calculate rate of change based on smoothed signal (instantaneous velocity / derivative)
    const dR_dt = metrics.calcloud.traffic_ema - metrics.calcloud.last_traffic_ema;
    metrics.calcloud.last_traffic_ema = metrics.calcloud.traffic_ema;
    
    // Project traffic at t + Ta (linear approximation / differential)
    const dR = dR_dt * startup_delay;
    const predictedTraffic = Math.max(5, metrics.calcloud.traffic_ema + dR);
    
    // Calculate optimal server count S based on predicted traffic / mu
    let bestSCalCloud = getOptimalServers(predictedTraffic);
    
    // Hybrid Emergency Reactiva Fail-Safe
    const currentCalCloudCapacity = metrics.calcloud.servers * mu;
    if (currentTraffic / currentCalCloudCapacity > 0.85 && bestSCalCloud <= metrics.calcloud.servers) {
        bestSCalCloud = Math.min(10, metrics.calcloud.servers + 1);
    }

    // Provision new servers to the boot queue based on predictions
    const totalAllocatedCalCloud = metrics.calcloud.servers + metrics.calcloud.bootQueue.length;
    if (bestSCalCloud > totalAllocatedCalCloud) {
        const diff = bestSCalCloud - totalAllocatedCalCloud;
        for (let i = 0; i < diff; i++) {
            metrics.calcloud.bootQueue.push(startup_delay);
            metrics.calcloud.oscillations++;
        }
    } else if (bestSCalCloud < metrics.calcloud.servers) {
        metrics.calcloud.servers = Math.max(1, bestSCalCloud);
        metrics.calcloud.oscillations++;
    }
    
    // Accumulate metrics for CalCloud
    const calcloudLatency = calculateLatency(metrics.calcloud.servers, currentTraffic, mu);
    const calcloudCostData = getHourlyCost(metrics.calcloud.servers, currentTraffic, mu);
    
    metrics.calcloud.steps++;
    metrics.calcloud.accumInfra += calcloudCostData.infra / 3600;
    metrics.calcloud.accumSLA += calcloudCostData.sla / 3600;
    metrics.calcloud.accumCost = metrics.calcloud.accumInfra + metrics.calcloud.accumSLA;
    metrics.calcloud.latencySum += calcloudLatency;
    if (metrics.calcloud.servers * mu <= currentTraffic) {
        metrics.calcloud.violations++;
    }

    // --- STRATEGY B: REACTIVE TRADITIONAL (THRESHOLD BASED + COOLDOWN) ---
    let currentSReactive = metrics.reactive.servers;
    const totalAllocatedReactive = currentSReactive + metrics.reactive.bootQueue.length;
    const currentReactiveCapacity = currentSReactive * mu;
    const utilization = currentTraffic / currentReactiveCapacity;
    
    if (metrics.reactive.cooldown > 0) {
        metrics.reactive.cooldown--;
    } else {
        if (utilization > 0.8 && totalAllocatedReactive < 10) {
            metrics.reactive.bootQueue.push(startup_delay);
            metrics.reactive.oscillations++;
            metrics.reactive.cooldown = 5;
        } else if (utilization < 0.3 && currentSReactive > 1) {
            metrics.reactive.servers = Math.max(1, currentSReactive - 1);
            metrics.reactive.oscillations++;
            metrics.reactive.cooldown = 5;
        }
    }
    
    // Accumulate metrics for Reactive
    const reactiveLatency = calculateLatency(metrics.reactive.servers, currentTraffic, mu);
    const reactiveCostData = getHourlyCost(metrics.reactive.servers, currentTraffic, mu);
    
    metrics.reactive.steps++;
    metrics.reactive.accumInfra += reactiveCostData.infra / 3600;
    metrics.reactive.accumSLA += reactiveCostData.sla / 3600;
    metrics.reactive.accumCost = metrics.reactive.accumInfra + metrics.reactive.accumSLA;
    metrics.reactive.latencySum += reactiveLatency;
    if (metrics.reactive.servers * mu <= currentTraffic) {
        metrics.reactive.violations++;
    }

    // --- CURRENT VIEWPORT UPDATE ---
    const activeServers = activeStrategy === 'calcloud' ? metrics.calcloud.servers : metrics.reactive.servers;
    const currentLatency = activeStrategy === 'calcloud' ? calcloudLatency : reactiveLatency;
    const currentAccumCost = activeStrategy === 'calcloud' ? metrics.calcloud.accumCost : metrics.reactive.accumCost;
    const currentAccumSLA = activeStrategy === 'calcloud' ? metrics.calcloud.accumSLA : metrics.reactive.accumSLA;
    
    // Update live metrics cards
    const trafficEl = document.getElementById('stat-traffic');
    if (trafficEl) {
        trafficEl.innerText = `${currentTraffic.toFixed(0)} req/s`;
    }
    
    const trafficChange = currentTraffic - lastTraffic;
    const trafficDiffPercent = lastTraffic > 0 ? (trafficChange / lastTraffic) * 100 : 0;
    
    const statTrafficRate = document.getElementById('stat-traffic-rate');
    if (statTrafficRate) {
        const arrow = trafficChange >= 0 ? '↑' : '↓';
        statTrafficRate.innerHTML = `<span style="color: ${trafficChange >= 0 ? 'var(--error)' : 'var(--success)'}">${arrow} ${Math.abs(trafficDiffPercent).toFixed(1)}%</span>`;
    }

    document.getElementById('stat-servers').innerText = `${activeServers} / 10`;
    const latencyEl = document.getElementById('stat-latency');
    if (latencyEl) {
        latencyEl.innerText = `${(currentLatency * 1000).toFixed(0)} ms`;
    }
    
    const latencyStatusEmoji = document.getElementById('latency-status-emoji');
    const latencyStatusText = document.getElementById('latency-status-text');
    if (latencyStatusEmoji && latencyStatusText) {
        if (currentLatency > 0.5) {
            latencyStatusEmoji.innerText = '🔴';
            latencyStatusText.innerText = 'Crítica';
            latencyStatusText.style.color = 'var(--error)';
        } else if (currentLatency > 0.15) {
            latencyStatusEmoji.innerText = '🟡';
            latencyStatusText.innerText = 'Moderada';
            latencyStatusText.style.color = 'var(--warning)';
        } else {
            latencyStatusEmoji.innerText = '🟢';
            latencyStatusText.innerText = 'Estable';
            latencyStatusText.style.color = 'var(--success)';
        }
    }

    const slaCostEl = document.getElementById('stat-cost-sla');
    if (slaCostEl) {
        slaCostEl.innerText = `$${currentAccumSLA.toFixed(2)}`;
    }
    
    const currentViolations = activeStrategy === 'calcloud' ? metrics.calcloud.violations : metrics.reactive.violations;
    const slaStatusElement = document.getElementById('stat-sla-status');
    if (slaStatusElement) {
        slaStatusElement.innerText = `${currentViolations} s fuera de SLA`;
        slaStatusElement.style.color = currentViolations > 0 ? 'var(--error)' : 'var(--text-muted)';
    }

    const totalCostEl = document.getElementById('stat-cost');
    if (totalCostEl) {
        totalCostEl.innerText = `$${currentAccumCost.toFixed(2)}`;
    }

    // Update active KPI servers breakdown values
    const activeCal = metrics.calcloud.servers;
    const bootCal = metrics.calcloud.bootQueue.length;
    const inactiveCal = 10 - activeCal - bootCal;
    
    const activeReact = metrics.reactive.servers;
    const bootReact = metrics.reactive.bootQueue.length;
    const inactiveReact = 10 - activeReact - bootReact;
    
    const currentActive = activeStrategy === 'calcloud' ? activeCal : activeReact;
    const currentBoot = activeStrategy === 'calcloud' ? bootCal : bootReact;
    const currentInactive = activeStrategy === 'calcloud' ? inactiveCal : inactiveReact;
    
    document.getElementById('kpi-srv-active').innerText = currentActive;
    document.getElementById('kpi-srv-boot').innerText = currentBoot;
    document.getElementById('kpi-srv-inactive').innerText = currentInactive;

    const serverStatusElementDesc = document.getElementById('stat-servers-desc');
    if (serverStatusElementDesc) {
        const utilizationActive = currentTraffic / ((currentActive > 0 ? currentActive : 1) * mu);
        if (utilizationActive > 0.95) {
            serverStatusElementDesc.innerText = 'Al límite / Colapso';
            serverStatusElementDesc.style.color = 'var(--error)';
        } else if (utilizationActive < 0.4) {
            serverStatusElementDesc.innerText = 'Subutilizado';
            serverStatusElementDesc.style.color = 'var(--warning)';
        } else {
            serverStatusElementDesc.innerText = 'Eficiencia Óptima';
            serverStatusElementDesc.style.color = 'var(--success)';
        }
    }

    // Render chassis rack servers nodes
    const serversContainer = document.getElementById('servers-container');
    if (serversContainer) {
        serversContainer.innerHTML = '';
        const avgLoadPerServer = Math.min(100, (currentTraffic / (activeServers * mu)) * 100);
        const strategyState = activeStrategy === 'calcloud' ? metrics.calcloud : metrics.reactive;
        
        for (let s = 1; s <= 10; s++) {
            const node = document.createElement('div');
            
            if (s <= strategyState.servers) {
                node.className = 'server-node active';
                let loadClass = '#22C55E'; // Success green
                if (avgLoadPerServer > 85) loadClass = '#EF4444'; // Danger red
                else if (avgLoadPerServer > 65) loadClass = '#F59E0B'; // Warning yellow
                
                node.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 0.5rem;">
                        <span style="background-color: #22C55E; width: 8px; height: 8px; border-radius: 50%; display: inline-block;"></span>
                        <span style="font-weight: 700; font-family: var(--font-mono); font-size: 0.70rem; color: var(--text-main);">SRV-${s.toString().padStart(2, '0')}</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 0.75rem; flex-grow: 1; justify-content: flex-end;">
                        <span style="font-size: 0.65rem; color: var(--text-muted); font-family: var(--font-mono);">CPU: <strong style="color: var(--text-main); font-weight: 600;">${avgLoadPerServer.toFixed(0)}%</strong></span>
                        <div style="width: 50px; height: 4px; background: rgba(255,255,255,0.06); border-radius: 2px; overflow: hidden; position: relative;">
                            <div style="width: ${avgLoadPerServer}%; height: 100%; background: ${loadClass}; border-radius: 2px;"></div>
                        </div>
                        <span style="font-size: 0.65rem; color: #22C55E; font-weight: 700; text-transform: uppercase; font-family: var(--font-sans); letter-spacing: 0.3px;">Running</span>
                    </div>
                `;
            } else if (s <= strategyState.servers + strategyState.bootQueue.length) {
                node.className = 'server-node booting';
                const bootIndex = s - strategyState.servers - 1;
                const remainingTicks = strategyState.bootQueue[bootIndex] || startup_delay;
                
                node.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 0.5rem;">
                        <span style="background-color: #F59E0B; width: 8px; height: 8px; border-radius: 50%; display: inline-block; animation: pulse-boot-dot 1.5s infinite;"></span>
                        <span style="font-weight: 700; font-family: var(--font-mono); font-size: 0.70rem; color: var(--warning);">SRV-${s.toString().padStart(2, '0')}</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 0.75rem; flex-grow: 1; justify-content: flex-end;">
                        <span style="font-size: 0.65rem; color: var(--warning); font-family: var(--font-mono);">Booting... (${remainingTicks}s)</span>
                        <span style="font-size: 0.65rem; color: var(--warning); font-weight: 700; text-transform: uppercase; font-family: var(--font-sans); letter-spacing: 0.3px;">Booting</span>
                    </div>
                `;
            } else {
                node.className = 'server-node inactive';
                node.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 0.5rem; opacity: 0.45;">
                        <span style="background-color: var(--text-muted); width: 8px; height: 8px; border-radius: 50%; display: inline-block;"></span>
                        <span style="font-weight: 700; font-family: var(--font-mono); font-size: 0.70rem; color: var(--text-muted);">SRV-${s.toString().padStart(2, '0')}</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 0.75rem; flex-grow: 1; justify-content: flex-end; opacity: 0.45;">
                        <span style="font-size: 0.65rem; color: var(--text-muted); font-family: var(--font-mono);">CPU: --</span>
                        <span style="font-size: 0.65rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase; font-family: var(--font-sans); letter-spacing: 0.3px;">Offline</span>
                    </div>
                `;
            }
            serversContainer.appendChild(node);
        }
    }

    // Update real-time chart data
    if (!isStatic) {
        timeHistory.push(timeLabel);
        trafficHistory.push(currentTraffic);
        serversCalCloudHistory.push(metrics.calcloud.servers);
        serversReactiveHistory.push(metrics.reactive.servers);
        
        if (timeHistory.length > maxHistoryPoints) {
            timeHistory.shift();
            trafficHistory.shift();
            serversCalCloudHistory.shift();
            serversReactiveHistory.shift();
        }
    } else if (trafficHistory.length > 0) {
        // In static mode, overwrite the last history point to show manual slider movements on the graph
        trafficHistory[trafficHistory.length - 1] = currentTraffic;
        serversCalCloudHistory[serversCalCloudHistory.length - 1] = metrics.calcloud.servers;
        serversReactiveHistory[serversReactiveHistory.length - 1] = metrics.reactive.servers;
    }
    
    if (realTimeChart) {
        const maxTrafficInput = lambda_max + (anomaly_percent > 0 ? 100 : 0);
        realTimeChart.options.scales.y.suggestedMax = Math.ceil(maxTrafficInput * 1.2);
        if (realTimeChart.options.scales.y.max) delete realTimeChart.options.scales.y.max;

        realTimeChart.data.labels = timeHistory;
        realTimeChart.data.datasets[0].data = trafficHistory;
        realTimeChart.data.datasets[1].data = activeStrategy === 'calcloud' ? serversCalCloudHistory : serversReactiveHistory;
        realTimeChart.data.datasets[1].label = activeStrategy === 'calcloud' ? 'Servidores (CalCloud)' : 'Servidores (Reactiva)';
        realTimeChart.data.datasets[1].borderColor = activeStrategy === 'calcloud' ? '#00E676' : '#D500F9';
        realTimeChart.options.scales.y1.title.color = activeStrategy === 'calcloud' ? '#00E676' : '#D500F9';
        realTimeChart.update('none');
    }

    if (!isStatic) {
        const activeState = activeStrategy === 'calcloud' ? metrics.calcloud : metrics.reactive;
        lastActiveViolations = activeState.violations;
        lastCalCloudBootQueueLength = metrics.calcloud.bootQueue.length;
        lastReactiveBootQueueLength = metrics.reactive.bootQueue.length;
        lastAnomalyPercent = anomaly_percent;
    }

    // Update Cost Curve Optimization Chart
    updateOptimizationChart(currentTraffic, activeServers);

    // Update Comparison Table
    document.getElementById('comp-cost-reactive').innerText = `$${metrics.reactive.accumCost.toFixed(2)}`;
    document.getElementById('comp-cost-calcloud').innerText = `$${metrics.calcloud.accumCost.toFixed(2)}`;
    
    const costSaving = metrics.reactive.accumCost - metrics.calcloud.accumCost;
    const costSavingPercent = metrics.reactive.accumCost > 0 ? (costSaving / metrics.reactive.accumCost) * 100 : 0;
    const costDiffText = costSaving >= 0 
        ? `$${costSaving.toFixed(2)} (${costSavingPercent.toFixed(1)}%)`
        : `-$${Math.abs(costSaving).toFixed(2)} (${Math.abs(costSavingPercent).toFixed(1)}%)`;
    document.getElementById('comp-cost-diff').innerText = costDiffText;
    document.getElementById('comp-cost-diff').style.color = costSaving >= 0 ? 'var(--success)' : 'var(--error)';

    document.getElementById('comp-sla-reactive').innerText = `$${metrics.reactive.accumSLA.toFixed(2)}`;
    document.getElementById('comp-sla-calcloud').innerText = `$${metrics.calcloud.accumSLA.toFixed(2)}`;
    const slaSaving = metrics.reactive.accumSLA - metrics.calcloud.accumSLA;
    const slaSavingPercent = metrics.reactive.accumSLA > 0 ? (slaSaving / metrics.reactive.accumSLA) * 100 : 0;
    document.getElementById('comp-sla-diff').innerText = slaSaving >= 0
        ? `$${slaSaving.toFixed(2)} (${slaSavingPercent.toFixed(1)}%)`
        : `+$${Math.abs(slaSaving).toFixed(2)}`;
    document.getElementById('comp-sla-diff').style.color = slaSaving >= 0 ? 'var(--success)' : 'var(--error)';

    const avgLatReactive = metrics.reactive.steps > 0 ? (metrics.reactive.latencySum / metrics.reactive.steps) * 1000 : 0;
    const avgLatCalcloud = metrics.calcloud.steps > 0 ? (metrics.calcloud.latencySum / metrics.calcloud.steps) * 1000 : 0;
    document.getElementById('comp-latency-reactive').innerText = `${avgLatReactive.toFixed(1)} ms`;
    document.getElementById('comp-latency-calcloud').innerText = `${avgLatCalcloud.toFixed(1)} ms`;
    const latSaving = avgLatReactive - avgLatCalcloud;
    const latSavingPercent = avgLatReactive > 0 ? (latSaving / avgLatReactive) * 100 : 0;
    document.getElementById('comp-latency-diff').innerText = latSaving >= 0
        ? `${latSaving.toFixed(1)} ms (${latSavingPercent.toFixed(1)}%)`
        : `+${Math.abs(latSaving).toFixed(1)} ms`;
    document.getElementById('comp-latency-diff').style.color = latSaving >= 0 ? 'var(--success)' : 'var(--error)';

    document.getElementById('comp-violations-reactive').innerText = `${metrics.reactive.violations} s`;
    document.getElementById('comp-violations-calcloud').innerText = `${metrics.calcloud.violations} s`;
    const violSaving = metrics.reactive.violations - metrics.calcloud.violations;
    document.getElementById('comp-violations-diff').innerText = `${violSaving} s`;
    document.getElementById('comp-violations-diff').style.color = violSaving >= 0 ? 'var(--success)' : 'var(--error)';

    document.getElementById('comp-oscillations-reactive').innerText = `${metrics.reactive.oscillations} reconfig.`;
    document.getElementById('comp-oscillations-calcloud').innerText = `${metrics.calcloud.oscillations} reconfig.`;
    const oscDiff = metrics.reactive.oscillations - metrics.calcloud.oscillations;
    document.getElementById('comp-oscillations-diff').innerText = `${oscDiff}`;
    document.getElementById('comp-oscillations-diff').style.color = oscDiff >= 0 ? 'var(--success)' : 'var(--warning)';

    // --- MATH LAB UPDATES (DIRECT LATEX VARIABLES IN VIVO) ---
    document.getElementById('math-rate-val').innerText = dR_dt.toFixed(2);
    document.getElementById('math-dr-val').innerText = dR.toFixed(2);
    document.getElementById('math-lambda-val').innerText = currentTraffic.toFixed(1);
    document.getElementById('math-latency-val').innerText = currentLatency.toFixed(3);
    
    const calcloudCostInfo = getHourlyCost(activeServers, currentTraffic, mu);
    document.getElementById('math-cost-opt').innerText = `$${calcloudCostInfo.total.toFixed(2)}`;
    
}

// Start/Pause simulation
function toggleSimulation() {
    const btn = document.getElementById('btn-toggle-sim');
    const iconContainer = document.getElementById('play-pause-icon-container');
    const textLabel = document.getElementById('play-pause-text');
    const statusText = document.getElementById('sim-status-text');

    if (isRunning) {
        clearInterval(simInterval);
        
        btn.classList.remove('active');
        iconContainer.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
        textLabel.innerText = 'MODO MANUAL';
        
        statusText.innerText = '● CONTROL DE TRÁFICO MANUAL';
        statusText.style.color = 'var(--warning)';
        
        isRunning = false;
        tick(true); // Trigger a static update to sync manual values immediately
    } else {
        isRunning = true;
        startSimulationLoop();
        
        btn.classList.add('active');
        iconContainer.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>';
        textLabel.innerText = 'MODO AUTOMÁTICO';
        
        statusText.innerText = '● TRÁFICO DINÁMICO ACTIVO';
        statusText.style.color = 'var(--success)';
    }
}

function startSimulationLoop() {
    if (simInterval) clearInterval(simInterval);
    const intervalMs = 1000 / sim_speed;
    simInterval = setInterval(tick, intervalMs);
}

// Navigation Router (Hash change) with smooth transitions
function handleRouteChange() {
    const hash = window.location.hash || '#dashboard';
    
    const tabMap = {
        '#dashboard': { el: 'view-dashboard', nav: 'tab-link-dashboard', display: 'flex' },
        '#live': { el: 'view-live', nav: 'tab-link-live', display: 'flex' },
        '#math': { el: 'view-math', nav: 'tab-link-math', display: 'block' },
        '#config': { el: 'view-config', nav: 'tab-link-config', display: 'block' },
        '#about': { el: 'view-about', nav: 'tab-link-about', display: 'block' }
    };
    
    // Hide all tabs
    document.querySelectorAll('.tab-content').forEach(el => {
        el.classList.remove('active-tab');
        el.classList.add('hidden-tab');
    });
    document.querySelectorAll('.nav-tab').forEach(el => el.classList.remove('active'));
    
    const target = tabMap[hash];
    if (target) {
        const tabEl = document.getElementById(target.el);
        if (tabEl) {
            tabEl.classList.remove('hidden-tab');
            // Force reflow for animation
            void tabEl.offsetWidth;
            tabEl.classList.add('active-tab');
        }
        const navEl = document.getElementById(target.nav);
        if (navEl) navEl.classList.add('active');
        
        // Resize charts when switching to live tab
        if (hash === '#live') {
            setTimeout(() => {
                if (realTimeChart) realTimeChart.resize();
                if (optimizationChart) optimizationChart.resize();
            }, 400);
        }
    }
}

// Setup inputs events
function setupEvents() {
    const btnReactive = document.getElementById('btn-strategy-reactive');
    const btnCalCloud = document.getElementById('btn-strategy-calcloud');

    btnReactive.addEventListener('click', () => {
        activeStrategy = 'reactive';
        btnReactive.classList.add('active');
        btnCalCloud.classList.remove('active');
        tick();
    });

    btnCalCloud.addEventListener('click', () => {
        activeStrategy = 'calcloud';
        btnCalCloud.classList.add('active');
        btnReactive.classList.remove('active');
        tick();
    });

    document.getElementById('btn-toggle-sim').addEventListener('click', toggleSimulation);

    // Dashboard Sliders
    // Helper: bind slider to display
    function bindSlider(sliderId, callback) {
        const slider = document.getElementById(sliderId);
        if (!slider) return;
        slider.addEventListener('input', (e) => {
            callback(e);
        });
    }

    bindSlider('slider-traffic', (e) => {
        lambda_max = parseFloat(e.target.value);
        document.getElementById('val-traffic').innerText = `${lambda_max} req/s`;
        if (!isRunning) tick(true);
    });

    bindSlider('slider-anomaly', (e) => {
        anomaly_percent = parseFloat(e.target.value);
        document.getElementById('val-anomaly').innerText = `${anomaly_percent}%`;
        if (!isRunning) tick(true);
    });

    bindSlider('slider-startup', (e) => {
        startup_delay = parseInt(e.target.value);
        document.getElementById('val-startup').innerText = `${startup_delay} s`;
        if (!isRunning) tick(true);
    });

    bindSlider('slider-alpha', (e) => {
        alpha_ema = parseFloat(e.target.value);
        document.getElementById('val-alpha').innerText = `${alpha_ema.toFixed(2)}`;
        if (!isRunning) tick(true);
    });

    bindSlider('slider-mu', (e) => {
        mu = parseFloat(e.target.value);
        document.getElementById('val-mu').innerText = `${mu} req/s`;
        if (!isRunning) tick(true);
    });

    bindSlider('slider-cserver', (e) => {
        cost_server_hr = parseFloat(e.target.value);
        document.getElementById('val-cserver').innerText = `$${cost_server_hr.toFixed(1)}`;
        if (!isRunning) tick(true);
    });

    bindSlider('slider-csla', (e) => {
        cost_sla_sec = parseFloat(e.target.value);
        document.getElementById('val-csla').innerText = `$${cost_sla_sec.toFixed(1)}`;
        if (!isRunning) tick(true);
    });

    bindSlider('slider-speed', (e) => {
        sim_speed = parseFloat(e.target.value);
        document.getElementById('val-speed').innerText = `${sim_speed}x`;
        if (isRunning) startSimulationLoop();
    });

    // --- DeepSeek IA API Key ---
    const savedApiKey = localStorage.getItem('deepseek_api_key') || '';
    const apiKeyInput = document.getElementById('input-api-key');
    if (apiKeyInput && savedApiKey) {
        apiKeyInput.value = savedApiKey;
    }
    const btnSaveKey = document.getElementById('btn-save-api-key');
    if (btnSaveKey) {
        btnSaveKey.addEventListener('click', () => {
            const val = apiKeyInput ? apiKeyInput.value.trim() : '';
            if (val) {
                localStorage.setItem('deepseek_api_key', val);
                showToast('API Key guardada correctamente', 'info');
            } else {
                showToast('Ingresa una API Key válida', 'danger');
            }
        });
    }

    // Typewriter effect for premium conversational flow
    function typeMessage(element, htmlContent, onComplete) {
        element.innerHTML = "";
        let i = 0;
        const timer = setInterval(() => {
            if (i < htmlContent.length) {
                if (htmlContent[i] === '<') {
                    const closingIndex = htmlContent.indexOf('>', i);
                    if (closingIndex !== -1) {
                        element.innerHTML = htmlContent.substring(0, closingIndex + 1);
                        i = closingIndex + 1;
                    } else {
                        element.innerHTML = htmlContent.substring(0, i + 1);
                        i++;
                    }
                } else {
                    element.innerHTML = htmlContent.substring(0, i + 1);
                    i++;
                }
                const messagesEl = document.getElementById('ai-chat-messages');
                if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
            } else {
                clearInterval(timer);
                element.innerHTML = htmlContent;
                if (onComplete) onComplete();
            }
        }, 10);
    }

    async function sendMessageToAI() {
        const inputEl = document.getElementById('ai-chat-input');
        const messagesEl = document.getElementById('ai-chat-messages');
        const apiKey = localStorage.getItem('deepseek_api_key') || '';

        if (!inputEl || !messagesEl) return;
        const text = inputEl.value.trim();
        if (!text) return;

        if (!apiKey) {
            showToast("Configura tu API Key de DeepSeek en la pestaña Configuración", "danger");
            return;
        }

        // Append user bubble
        const userMsg = document.createElement('div');
        userMsg.className = 'ai-chat-msg user';
        userMsg.style.cssText = 'align-self: flex-end; background: #2A364F; border-radius: 6px; padding: 0.55rem 0.75rem; max-width: 80%; line-height: 1.4; color: #FFFFFF; margin-left: auto; margin-bottom: 0.5rem;';
        userMsg.innerText = text;
        messagesEl.appendChild(userMsg);
        
        inputEl.value = '';
        messagesEl.scrollTop = messagesEl.scrollHeight;

        // --- FROZEN STATE SNAPSHOT (capturado antes de cualquier async) ---
        const snapTraffic = trafficHistory.length > 0 ? trafficHistory[trafficHistory.length - 1] : 0;
        const snapPrevTraffic = trafficHistory.length > 1 ? trafficHistory[trafficHistory.length - 2] : snapTraffic;
        const snapActiveServers = activeStrategy === 'calcloud' ? metrics.calcloud.servers : metrics.reactive.servers;
        const snapCalServers = metrics.calcloud.servers;
        const snapMu = mu;
        const snapStartup = startup_delay;
        const snapAnomaly = anomaly_percent;
        const snapAccumCost = activeStrategy === 'calcloud' ? metrics.calcloud.accumCost : metrics.reactive.accumCost;
        const snapAccumSLA = activeStrategy === 'calcloud' ? metrics.calcloud.accumSLA : metrics.reactive.accumSLA;
        const snapLatency = calculateLatency(snapActiveServers, snapTraffic, mu);
        const snapCapacity = snapActiveServers * mu;
        const snapEma = metrics.calcloud.traffic_ema;
        const snapEmaDiff = metrics.calcloud.traffic_ema - metrics.calcloud.last_traffic_ema;
        // --- END SNAPSHOT ---

        // Append thinking steps animation
        const thinkingSteps = [
            "Analizando tendencia de tráfico",
            "Calculando diferencial",
            "Estimando demanda futura",
            "Buscando mínimo costo",
            "Aplicando configuración"
        ];
        const thinkingContainer = document.createElement('div');
        thinkingContainer.className = 'thinking-container';
        const stepElements = [];
        thinkingSteps.forEach((text) => {
            const step = document.createElement('div');
            step.className = 'thinking-step';
            step.innerHTML = `
                <span class="step-icon pending">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle></svg>
                </span>
                <span class="step-text">${text}</span>
            `;
            thinkingContainer.appendChild(step);
            stepElements.push(step);
        });
        messagesEl.appendChild(thinkingContainer);
        messagesEl.scrollTop = messagesEl.scrollHeight;

        let stepIndex = 0;
        const stepTimer = setInterval(() => {
            if (stepIndex < stepElements.length) {
                stepElements[stepIndex].classList.add('visible');
                stepIndex++;
                messagesEl.scrollTop = messagesEl.scrollHeight;
            } else {
                clearInterval(stepTimer);
            }
        }, 180);

        const promptText = `Métricas actuales (snapshot congelado):
- Tráfico anterior: ${snapPrevTraffic.toFixed(1)} req/s
- Tráfico actual: ${snapTraffic.toFixed(1)} req/s
- Servidores activos: ${snapCalServers}
- Capacidad por servidor (μ): ${snapMu} req/s
- Tiempo de arranque (Ta): ${snapStartup}s
- Anomalía: ${snapAnomaly}%
- Costo acumulado: $${snapAccumCost.toFixed(2)}
- Multas SLA: $${snapAccumSLA.toFixed(2)}

Debug (snapshot):
- traffic = ${snapTraffic.toFixed(1)} req/s
- servers = ${snapCalServers}
- latency = ${(snapLatency * 1000).toFixed(0)} ms
- cost = $${snapAccumCost.toFixed(2)}

Usuario: "${text}"`;

        try {
            const response = await fetch('https://api.deepseek.com/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: 'deepseek-chat',
                    messages: [
                        {
                            role: 'system',
                            content: `Eres CalCloud AI, un asistente de operaciones cloud. Tu tono es profesional, técnico y directo, como un SRE sénior. Hablas en español neutro.

Fórmulas del modelo:
1. v = (R_actual - R_anterior) / 1s
2. R_pred = R_actual + v · Ta
3. S = ⌈R_pred / μ⌉

Reglas:
- Usa EXCLUSIVAMENTE los valores reales de las métricas. NUNCA inventes.
- Si el tráfico no cambia, la derivada es 0.
- NO repitas datos crudos del dashboard (el usuario ya los ve arriba).
- NO incluyas código como Math.ceil(). Usa ⌈⌉.
- NO pongas "---" como separador. Usa "────".
- NO uses primera persona. Responde en tercera persona descriptiva.
- Si excede 10 servidores, indica escalamiento externo.
- Incluye siempre un nivel de confianza (0-100%) al final.

Estructura obligatoria de la respuesta (separar secciones con "────"):

Estado
[🟢/🟡/🔴] [Resumen ejecutivo: una línea]

────

Análisis
Tráfico
[valor] req/s

Proyección
[valor] req/s

Derivada
[valor] req/s²

────

Decisión
[Una frase clara: escalar / no escalar / ajustar / mitigar]

────

Justificación
[Breve explicación de máximo 3 líneas]

────

Acciones
✓ [Acción concreta 1]
✓ [Acción concreta 2]

────

Confianza
[XX]%

Si el usuario pide alterar parámetros (tráfico, mu, anomalías, servidores, pausar), inclúyelos en "updates". Para DDoS: separa tráfico legítimo vs anómalo y describe mitigación.

Debes incluir EXACTAMENTE los valores que recibiste en el campo "debug" para verificar sincronización. NO inventes ni redondees los debug values.

Responde EXCLUSIVAMENTE en JSON. NO uses bloques markdown \`\`\`json. Solo JSON crudo:
{
  "response": "Texto con la estructura exacta descrita arriba.",
  "updates": {
    "lambda_max": número opcional entre 40 y 200,
    "mu": número opcional entre 10 y 1000,
    "startup_delay": número opcional entre 1 y 15,
    "anomaly_percent": número opcional entre 0 y 1500,
    "servers": número opcional entre 1 y 10,
    "isRunning": booleano opcional
  },
  "debug": {
    "traffic": número (valor exacto de traffic recibido),
    "servers": número (valor exacto de servers recibido),
    "latency": número (valor exacto de latency recibido en ms),
    "cost": número (valor exacto de cost recibido)
  }
}`
                        },
                        {
                            role: 'user',
                            content: promptText
                        }
                    ],
                    stream: false
                })
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData?.error?.message || `HTTP ${response.status}`);
            }

            const data = await response.json();
            const reply = data.choices[0].message.content;
            
            // Complete thinking animation
            clearInterval(stepTimer);
            stepElements.forEach(el => {
                el.classList.add('visible');
                const icon = el.querySelector('.step-icon');
                icon.classList.remove('pending');
                icon.classList.add('done');
                icon.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
            });
            messagesEl.scrollTop = messagesEl.scrollHeight;

            await new Promise(r => setTimeout(r, 300));
            thinkingContainer.remove();

            let cleanReply = reply.trim();
            if (cleanReply.startsWith("```json")) {
                cleanReply = cleanReply.substring(7);
            }
            if (cleanReply.endsWith("```")) {
                cleanReply = cleanReply.substring(0, cleanReply.length - 3);
            }
            cleanReply = cleanReply.trim();
            
            const parsed = JSON.parse(cleanReply);

            const formattedResponse = parsed.response
                .replace(/─{2,}/g, '<hr>')
                .replace(/\n/g, '<br>');

            // Append agent response with Typewriter effect
            const aiMsg = document.createElement('div');
            aiMsg.className = 'ai-chat-msg ai agent-response';
            aiMsg.style.cssText = 'background: rgba(6, 182, 212, 0.03); border: 1px solid rgba(6, 182, 212, 0.15); border-radius: 6px; padding: 0.55rem 0.75rem; align-self: flex-start; max-width: 85%; line-height: 1.6; color: var(--text-main); margin-bottom: 0.5rem;';
            messagesEl.appendChild(aiMsg);
            
            typeMessage(aiMsg, `<strong>CloudOps Agent:</strong><br>${formattedResponse}`, () => {
                messagesEl.scrollTop = messagesEl.scrollHeight;
            });

            // Show debug synchronization data
            if (parsed.debug) {
                const debugMsg = document.createElement('div');
                debugMsg.style.cssText = 'background: rgba(255, 255, 255, 0.02); border: 1px dashed var(--border); border-radius: 4px; padding: 0.4rem 0.6rem; align-self: flex-start; max-width: 85%; line-height: 1.4; font-size: 10px; font-family: var(--font-mono); color: var(--text-muted); margin-bottom: 0.5rem;';
                const debugTrafficMatch = parsed.debug.traffic !== undefined ? Math.abs(parsed.debug.traffic - snapTraffic) < 0.5 : '?';
                const debugServersMatch = parsed.debug.servers !== undefined ? parsed.debug.servers === snapCalServers : '?';
                const syncOk = debugTrafficMatch === true && debugServersMatch === true;
                debugMsg.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">
                        <span style="color: ${syncOk ? 'var(--success)' : 'var(--error)'};">${syncOk ? '●' : '○'}</span>
                        <span style="font-weight: 600; color: var(--text-secondary);">Debug Sync</span>
                    </div>
                    <table style="width: 100%; border-collapse: collapse; font-size: 9px;">
                        <tr><td style="padding: 1px 4px; color: var(--text-tertiary);">Métrica</td><td style="padding: 1px 4px; color: var(--accent);">Snapshot</td><td style="padding: 1px 4px; color: var(--warning);">IA reporta</td></tr>
                        <tr><td style="padding: 1px 4px;">traffic</td><td style="padding: 1px 4px;">${snapTraffic.toFixed(1)}</td><td style="padding: 1px 4px;">${parsed.debug.traffic !== undefined ? parsed.debug.traffic : 'N/A'}</td></tr>
                        <tr><td style="padding: 1px 4px;">servers</td><td style="padding: 1px 4px;">${snapCalServers}</td><td style="padding: 1px 4px;">${parsed.debug.servers !== undefined ? parsed.debug.servers : 'N/A'}</td></tr>
                        <tr><td style="padding: 1px 4px;">latency (ms)</td><td style="padding: 1px 4px;">${(snapLatency * 1000).toFixed(0)}</td><td style="padding: 1px 4px;">${parsed.debug.latency !== undefined ? parsed.debug.latency : 'N/A'}</td></tr>
                        <tr><td style="padding: 1px 4px;">cost</td><td style="padding: 1px 4px;">${snapAccumCost.toFixed(2)}</td><td style="padding: 1px 4px;">${parsed.debug.cost !== undefined ? parsed.debug.cost : 'N/A'}</td></tr>
                    </table>
                `;
                messagesEl.appendChild(debugMsg);
                messagesEl.scrollTop = messagesEl.scrollHeight;
            }

            // Apply updates
            if (parsed.updates) {
                const applied = [];
                
                if (parsed.updates.lambda_max !== undefined) {
                    lambda_max = parseFloat(parsed.updates.lambda_max);
                    const slider = document.getElementById('slider-traffic');
                    if (slider) {
                        if (lambda_max > parseFloat(slider.max)) slider.max = lambda_max;
                        if (lambda_max < parseFloat(slider.min)) slider.min = lambda_max;
                        slider.value = lambda_max;
                    }
                    const val = document.getElementById('val-traffic');
                    if (val) val.innerText = `${lambda_max} req/s`;
                    applied.push(`Tráfico (${lambda_max} req/s)`);
                }

                if (parsed.updates.mu !== undefined) {
                    mu = parseFloat(parsed.updates.mu);
                    const slider = document.getElementById('slider-mu');
                    if (slider) {
                        if (mu > parseFloat(slider.max)) slider.max = mu;
                        if (mu < parseFloat(slider.min)) slider.min = mu;
                        slider.value = mu;
                    }
                    const val = document.getElementById('val-mu');
                    if (val) val.innerText = `${mu} req/s`;
                    applied.push(`Capacidad mu (${mu} req/s)`);
                }

                if (parsed.updates.startup_delay !== undefined) {
                    startup_delay = parseInt(parsed.updates.startup_delay);
                    const slider = document.getElementById('slider-startup');
                    if (slider) {
                        if (startup_delay > parseFloat(slider.max)) slider.max = startup_delay;
                        if (startup_delay < parseFloat(slider.min)) slider.min = startup_delay;
                        slider.value = startup_delay;
                    }
                    const val = document.getElementById('val-startup');
                    if (val) val.innerText = `${startup_delay} s`;
                    applied.push(`Arranque (${startup_delay}s)`);
                }

                if (parsed.updates.anomaly_percent !== undefined) {
                    anomaly_percent = parseFloat(parsed.updates.anomaly_percent);
                    const slider = document.getElementById('slider-anomaly');
                    if (slider) {
                        if (anomaly_percent > parseFloat(slider.max)) slider.max = anomaly_percent;
                        slider.value = anomaly_percent;
                    }
                    const val = document.getElementById('val-anomaly');
                    if (val) val.innerText = `${anomaly_percent}%`;
                    applied.push(`Anomalía (${anomaly_percent}%)`);
                }

                if (parsed.updates.servers !== undefined) {
                    metrics.calcloud.servers = Math.max(1, Math.min(10, parseInt(parsed.updates.servers)));
                    applied.push(`Servidores activos (${metrics.calcloud.servers})`);
                }

                if (parsed.updates.isRunning !== undefined) {
                    if (parsed.updates.isRunning !== isRunning) {
                        toggleSimulation();
                        applied.push(parsed.updates.isRunning ? "Simulación reanudada" : "Simulación pausada");
                    }
                }

                if (applied.length > 0) {
                    tick(true);
                }
            }

            messagesEl.scrollTop = messagesEl.scrollHeight;

        } catch (error) {
            clearInterval(stepTimer);
            if (thinkingContainer.parentNode) thinkingContainer.remove();
            const errMsg = document.createElement('div');
            errMsg.className = 'ai-chat-msg error';
            errMsg.style.cssText = 'background: rgba(255, 51, 102, 0.08); border: 1px solid rgba(255, 51, 102, 0.2); border-radius: 6px; padding: 0.55rem 0.75rem; align-self: flex-start; max-width: 85%; line-height: 1.4; color: var(--error); margin-bottom: 0.5rem;';
            errMsg.innerHTML = `<strong>Error de IA:</strong> ${error.message}`;
            messagesEl.appendChild(errMsg);
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }
    }

    const btnAiSend = document.getElementById('btn-ai-send');
    if (btnAiSend) {
        btnAiSend.addEventListener('click', sendMessageToAI);
    }

    const inputEl = document.getElementById('ai-chat-input');
    if (inputEl) {
        inputEl.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                sendMessageToAI();
            }
        });
    }

    window.addEventListener('hashchange', handleRouteChange);
}

// Inicialización de la Aplicación al Cargar el DOM
window.addEventListener('DOMContentLoaded', () => {
    initCharts();
    setupEvents();
    handleRouteChange();
    startSimulationLoop();
    tick();

    // Welcome notification removed per user request
});
