import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_FILE = path.join(__dirname, '../data/pinnacle_live.json');
const OUTPUT_PREMATCH_FILE = path.join(__dirname, '../data/pinnacle_prematch.json');
const TOKEN_FILE = path.join(__dirname, '../data/pinnacle_token.json');

const WS_URL = "wss://api.arcadia.pinnacle.com/ws";
// 1. Endpoint de PRECIOS (Rápido, frecuente)
const API_URL_ODDS = "https://api.arcadia.pinnacle.com/0.1/sports/29/markets/live/straight?primaryOnly=false&withSpecials=false";
// 2. Endpoint de METADATA (Nombres, Ligas - Lento, menos frecuente)
const API_URL_FIXTURES = "https://api.arcadia.pinnacle.com/0.1/sports/29/matchups/live";
// 3. Endpoints PREMATCH (Canal separado, frecuencia baja anti-ban)
const API_URL_PREMATCH_ODDS = "https://api.arcadia.pinnacle.com/0.1/sports/29/markets/straight?primaryOnly=false&withSpecials=false";
const API_URL_PREMATCH_FIXTURES = "https://api.arcadia.pinnacle.com/0.1/sports/29/matchups";
const BASE_MIN_HTTP_GAP_MS = 600; // ~1.6 RPS global en este proceso
const MAX_HTTP_GAP_MS = 3500;
const NIGHT_MODE_START_HOUR_PE = 18;
const NEXT_DAY_CUTOFF_HOUR_PE = 6;
const EXCLUDED_MATCH_TERMS = [
    'corners',
    'corner',
    'bookings',
    'booking',
    'cards',
    'card',
    'tarjetas',
    '8 games',
    '8 game'
];

const normalizeMarketText = (value = '') => String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

const isExcludedMarketVariant = ({ home = '', away = '', league = '', units = '' } = {}) => {
    if (units && String(units).toLowerCase() !== 'regular') return true;
    const blob = normalizeMarketText(`${home} ${away} ${league} ${units}`);
    return EXCLUDED_MATCH_TERMS.some(term => blob.includes(term));
};

const getPrematchWindowUtc = () => {
    const nowUtcMs = Date.now();
    const peruOffsetMs = -5 * 60 * 60 * 1000;

    // Representación "local Perú" usando reloj UTC del objeto Date
    const nowPeru = new Date(nowUtcMs + peruOffsetMs);
    const hourPeru = nowPeru.getUTCHours();

    let endPeruMs;
    if (hourPeru >= NIGHT_MODE_START_HOUR_PE) {
        // Después de 18:00 PE: incluir hasta mañana 06:00 PE
        endPeruMs = Date.UTC(
            nowPeru.getUTCFullYear(),
            nowPeru.getUTCMonth(),
            nowPeru.getUTCDate() + 1,
            NEXT_DAY_CUTOFF_HOUR_PE,
            0,
            0,
            0
        );
    } else {
        // Antes de 18:00 PE: solo hoy
        endPeruMs = Date.UTC(
            nowPeru.getUTCFullYear(),
            nowPeru.getUTCMonth(),
            nowPeru.getUTCDate(),
            23,
            59,
            59,
            999
        );
    }

    // Convertir de timeline Perú a UTC real
    const endUtcMs = endPeruMs - peruOffsetMs;

    return { nowUtcMs, endUtcMs, hourPeru };
};

class PinnacleLight {
    constructor() {
        this.ws = null;
        this.pingInterval = null;
        this.fixturesInterval = null;
        this.saveInterval = null;
        this.prematchOddsInterval = null;
        this.prematchFixturesInterval = null;
        this.prematchSaveInterval = null;
        
        // Almacenes separados para mezclar
        this.oddsStore = {};     // Map<MatchupId, Markets[]>
        this.fixturesStore = {}; // Map<MatchupId, Metadata>

        // Canal PREMATCH (separado del live)
        this.prematchOddsStore = {};     // Map<MatchupId, Markets[]>
        this.prematchFixturesStore = {}; // Map<MatchupId, Metadata>
        
        this.headers = null;
        this.isRefreshing = false;

        // Techo automático de RPS (Arcadia HTTP)
        this.httpQueue = Promise.resolve();
        this.lastHttpAt = 0;
        this.minHttpGapMs = BASE_MIN_HTTP_GAP_MS;
        this.httpBackoffUntil = 0;
    }

    async arcadiaGet(url, config = {}) {
        const task = async () => {
            const now = Date.now();

            if (this.httpBackoffUntil > now) {
                await new Promise(r => setTimeout(r, this.httpBackoffUntil - now));
            }

            const elapsed = Date.now() - this.lastHttpAt;
            if (elapsed < this.minHttpGapMs) {
                await new Promise(r => setTimeout(r, this.minHttpGapMs - elapsed));
            }

            this.lastHttpAt = Date.now();

            try {
                const response = await axios.get(url, config);
                if (this.minHttpGapMs > BASE_MIN_HTTP_GAP_MS) {
                    this.minHttpGapMs = Math.max(BASE_MIN_HTTP_GAP_MS, this.minHttpGapMs - 100);
                }
                return response;
            } catch (error) {
                const status = error?.response?.status;
                if (status === 429 || status === 403) {
                    this.minHttpGapMs = Math.min(MAX_HTTP_GAP_MS, this.minHttpGapMs + 400);
                    this.httpBackoffUntil = Date.now() + 2500;
                    console.warn(`⚠️ Arcadia HTTP throttle/backoff. Gap=${this.minHttpGapMs}ms`);
                }
                throw error;
            }
        };

        const run = this.httpQueue.then(task, task);
        this.httpQueue = run.then(() => undefined, () => undefined);
        return run;
    }

    loadHeaders() {
        try {
            if (fs.existsSync(TOKEN_FILE)) {
                const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
                if (data && data.headers) {
                    // VERIFICACIÓN DE ANTIGÜEDAD (TTL)
                    if (data.updatedAt) {
                        const lastUpdate = new Date(data.updatedAt).getTime();
                        const now = Date.now();
                        const diffHours = (now - lastUpdate) / (1000 * 60 * 60);

                        // Si el token tiene más de 1 hora, lo consideramos viejo para evitar el feed retrasado
                        if (diffHours > 1) {
                            console.warn(`⏳ TOKEN CADUCADO (${diffHours.toFixed(1)}h de antigüedad). Se requiere renovación por seguridad (Delay detectado).`);
                            return false; 
                        }
                    }

                    this.headers = data.headers;

                    // [FIX] Limpieza de Headers para Axios (HTTP)
                    // Eliminamos headers exclusivos de WebSocket que axios podría malinterpretar
                    delete this.headers['Upgrade'];
                    delete this.headers['Connection'];
                    delete this.headers['Sec-WebSocket-Key'];
                    delete this.headers['Sec-WebSocket-Version'];
                    delete this.headers['Sec-WebSocket-Extensions'];
                    delete this.headers['Host']; // Axios pone su propio Host
                    delete this.headers['Content-Length'];

                    const date = new Date(data.updatedAt);
                    console.log(`✅ Headers cargados y válidos (Generados: ${date.toLocaleTimeString()}).`);
                    return true;
                }
            }
        } catch (e) {
            console.error("⚠️ Error leyendo headers:", e.message);
        }
        return false;
    }

    async refreshSession() {
        if (this.isRefreshing) return;
        this.isRefreshing = true;
        console.log("🔄 INICIANDO PROTOCOLO DE REFRESCO DE SESIÓN (PinnacleGateway)...");
        console.log("⚠️ Se abrirá una ventana de Chrome. INICIA SESIÓN MANUALMENTE; al detectar socket válido se cerrará automáticamente.");

        // Ejecutar el Gateway en otro proceso
        const gatewayScript = path.join(__dirname, 'pinnacleGateway.js');
        const child = spawn(process.execPath, [gatewayScript], {
            stdio: ['inherit', 'pipe', 'pipe'],
            shell: false,
            windowsHide: true
        });

        const isExpectedWindowsTaskkillNoise = (line = '') => {
            const value = String(line).trim();
            if (!value) return false;

            return (
                /^ERROR:\s+el proceso con PID\s+\d+\s+\(proceso secundario de PID\s+\d+\)$/i.test(value) ||
                /^no se pudo terminar\.$/i.test(value) ||
                /^Motivo:\s+No hay ninguna instancia activa de la tarea\.$/i.test(value) ||
                /^Motivo:\s+La operaci.n que se ha intentado no est. permitida\.$/i.test(value)
            );
        };

        const pipeWithFilter = (stream, writer) => {
            let buffer = '';
            stream.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split(/\r?\n/);
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!isExpectedWindowsTaskkillNoise(line)) {
                        writer.write(line + '\n');
                    }
                }
            });

            stream.on('end', () => {
                const line = buffer.trim();
                if (line && !isExpectedWindowsTaskkillNoise(line)) {
                    writer.write(line + '\n');
                }
            });
        };

        pipeWithFilter(child.stdout, process.stdout);
        pipeWithFilter(child.stderr, process.stderr);

        child.on('exit', (code) => {
            this.isRefreshing = false;
            console.log(`🏁 Generador de llaves finalizó (Código ${code})....`);

            if (this.loadHeaders()) {
                console.log("🚀 LEYENDO NUEVOS HEADERS... REINICIANDO CONEXIÓN.");
                this.start(); // Re-start simple
            } else {
                console.error("❌ Fallo crítico: No se generó el token o el usuario no inició sesión correctamente.");
                process.exit(1);
            }
        });
    }

    start() {
        if (!this.loadHeaders()) {
            console.log("⚠️ No hay token guardado. Iniciando Generador...");
            this.refreshSession();
            return;
        }

        console.log("⚡ [LIGHT MODE] Iniciando Pinnacle Light (Dual-Channel: Odds + Fixtures)...");

        // 1. Iniciar Polling de Fixtures (Nombres de equipos) - Cada 60s es suficiente
        this.fetchFixtures();
        if (this.fixturesInterval) clearInterval(this.fixturesInterval);
        this.fixturesInterval = setInterval(() => this.fetchFixtures(), 60000);

        // 2. Iniciar Polling de Odds (Precios) - Cada 5s
        this.fetchOdds();
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => this.fetchOdds(), 5000);

        // 3. Conectar WSS
        this.connectSocket();

        // 4. Autoguardado (Merge & Write)
        if (this.saveInterval) clearInterval(this.saveInterval);
        this.saveInterval = setInterval(() => this.saveData(), 2000);

        // 5. PREMATCH separado (frecuencia baja anti-ban)
        this.fetchPrematchFixtures();
        if (this.prematchFixturesInterval) clearInterval(this.prematchFixturesInterval);
        this.prematchFixturesInterval = setInterval(() => this.fetchPrematchFixtures(), 300000); // 5 min

        this.fetchPrematchOdds();
        if (this.prematchOddsInterval) clearInterval(this.prematchOddsInterval);
        this.prematchOddsInterval = setInterval(() => this.fetchPrematchOdds(), 30000); // 30s

        if (this.prematchSaveInterval) clearInterval(this.prematchSaveInterval);
        this.prematchSaveInterval = setInterval(() => this.savePrematchData(), 15000); // 15s
    }

    async fetchFixtures() {
        if (!this.headers) return;
        try {
            const { data } = await this.arcadiaGet(API_URL_FIXTURES, { headers: this.headers });
            if (data && Array.isArray(data)) {
                
                // [GC] Garbage Collection: Identificar eventos activos
                const activeIds = new Set();

                data.forEach(fix => {
                     const home = fix.participants?.find(p => p.alignment === 'home')?.name || '';
                     const away = fix.participants?.find(p => p.alignment === 'away')?.name || '';
                     const leagueName = fix.league?.name || '';
                     if (isExcludedMarketVariant({ home, away, league: leagueName, units: fix.units })) {
                         return;
                     }

                     activeIds.add(String(fix.id));
                     
                     // Guardar metadata clave: ID, Participantes, Liga, Periodo, Estado
                     this.fixturesStore[fix.id] = {
                         id: fix.id,
                         participants: fix.participants,
                         league: fix.league,
                         units: fix.units,
                         parentLeagueId: fix.league?.id,
                         startTime: fix.startTime,
                         status: fix.status, // live, etc.
                         state: fix.state, // [FIX] Capture Pinnacle's State object (minutes, period)
                         periods: fix.periods // [FIX] Capture Period statuses
                     };
                });
                
                // [GC] Eliminar eventos que ya no están en el feed live
                let deletedCount = 0;
                Object.keys(this.fixturesStore).forEach(storedId => {
                    if (!activeIds.has(String(storedId))) {
                        delete this.fixturesStore[storedId];
                        delete this.oddsStore[storedId]; // Limpiar también cuotas huérfanas
                        deletedCount++;
                    }
                });

                // Reduce log noise: only log if count changed meaningfully
                const count = activeIds.size;
                if (deletedCount > 0 || !this.lastFixCount || Math.abs(this.lastFixCount - count) > 5) {
                    console.log(`🏟️ Fixtures actualizados: ${count} activos. (🗑️ Limpiados: ${deletedCount})`);
                    this.lastFixCount = count;
                }
            }
        } catch (e) {
            console.error(`⚠️ Fixtures Error: ${e.message}`);
        }
    }

    async fetchOdds() {
        if (!this.headers) return;

        try {
            const { data } = await this.arcadiaGet(API_URL_ODDS, { headers: this.headers });
            if (data && Array.isArray(data)) {
                
                // [FIX] ESTRATEGIA DE REEMPLAZO "SNAPSHOT" (Anti-Zombies)
                // En lugar de hacer merge incremental, agrupamos por MatchID y REEMPLAZAMOS la lista.
                // Esto elimina automáticamente mercados que Pinnacle ha borrado (ej. líneas resueltas).
                
                const freshSnapshot = {};

                data.forEach(item => {
                    if (item.matchupId && item.prices) {
                        if (!freshSnapshot[item.matchupId]) freshSnapshot[item.matchupId] = [];
                        freshSnapshot[item.matchupId].push(item);
                    }
                });

                // Actualizar store (Atomic Swap por match)
                Object.keys(freshSnapshot).forEach(matchId => {
                    this.oddsStore[matchId] = freshSnapshot[matchId];
                });

                // Nota: Mantenemos processSnapshotData para el WebSocket (que sí es incremental)
                // pero el polling HTTP ahora actúa como un "Garbage Collector" de mercados cada 5s.
            }
        } catch (e) {
            // [FIX] Si falla el HTTP pero el Socket sigue vivo, NO refrescar sesión agresivamente.
            // El socket es la fuente de verdad principal.
            if (this.ws && this.ws.readyState === 1) { // 1 = OPEN
                 console.warn(`⚠️ HTTP Polling falló (${e.response?.status || e.message}), pero WebSocket sigue activo. Ignorando error.`);
                 return;
            }

            if (e.response?.status === 401 || e.response?.status === 403) {
                console.error("🛑 SESIÓN CADUCADA (HTTP 401/403) y Socket desconectado. Invocando Gateway...");
                this.cleanup();
                this.refreshSession();
            }
        }
    }

    cleanup() {
        if (this.ws) { this.ws.terminate(); this.ws = null; }
        clearInterval(this.pingInterval);
        clearInterval(this.saveInterval);
        clearInterval(this.fixturesInterval);
        clearInterval(this.prematchOddsInterval);
        clearInterval(this.prematchFixturesInterval);
        clearInterval(this.prematchSaveInterval);
    }

    async fetchPrematchFixtures() {
        if (!this.headers) return;
        try {
            const { data } = await this.arcadiaGet(API_URL_PREMATCH_FIXTURES, { headers: this.headers });
            if (!Array.isArray(data)) return;

            const { nowUtcMs, endUtcMs, hourPeru } = getPrematchWindowUtc();
            const activeIds = new Set();

            data.forEach(fix => {
                const startTs = fix.startTime ? new Date(fix.startTime).getTime() : 0;
                const looksLive = fix.liveMode || fix.state?.minutes !== undefined;
                const home = fix.participants?.find(p => p.alignment === 'home')?.name || '';
                const away = fix.participants?.find(p => p.alignment === 'away')?.name || '';
                const leagueName = fix.league?.name || '';

                // PREMATCH ONLY: excluir live y partidos vencidos
                if (looksLive) return;
                if (!startTs || startTs < nowUtcMs - 10 * 60 * 1000) return;
                if (startTs > endUtcMs) return;
                if (isExcludedMarketVariant({ home, away, league: leagueName, units: fix.units })) return;

                activeIds.add(String(fix.id));
                this.prematchFixturesStore[fix.id] = {
                    id: fix.id,
                    participants: fix.participants,
                    league: fix.league,
                    units: fix.units,
                    parentLeagueId: fix.league?.id,
                    startTime: fix.startTime,
                    status: fix.status,
                    state: fix.state,
                    periods: fix.periods
                };
            });

            let deletedCount = 0;
            Object.keys(this.prematchFixturesStore).forEach(storedId => {
                if (!activeIds.has(String(storedId))) {
                    delete this.prematchFixturesStore[storedId];
                    delete this.prematchOddsStore[storedId];
                    deletedCount++;
                }
            });

            const count = activeIds.size;
            if (deletedCount > 0 || !this.lastPreFixCount || Math.abs(this.lastPreFixCount - count) > 20) {
                console.log(`🗓️ Prematch Fixtures: ${count} activos. (🗑️ Limpiados: ${deletedCount}) [PE ${hourPeru}:00 window]`);
                this.lastPreFixCount = count;
            }
        } catch (e) {
            console.error(`⚠️ Prematch Fixtures Error: ${e.message}`);
        }
    }

    async fetchPrematchOdds() {
        if (!this.headers) return;

        try {
            const { data } = await this.arcadiaGet(API_URL_PREMATCH_ODDS, { headers: this.headers });
            if (!Array.isArray(data)) return;

            const validIds = new Set(Object.keys(this.prematchFixturesStore).map(String));
            if (validIds.size === 0) return;

            const freshSnapshot = {};
            data.forEach(item => {
                if (!item.matchupId || !item.prices) return;
                if (!validIds.has(String(item.matchupId))) return;

                if (!freshSnapshot[item.matchupId]) freshSnapshot[item.matchupId] = [];
                freshSnapshot[item.matchupId].push(item);
            });

            Object.keys(freshSnapshot).forEach(matchId => {
                this.prematchOddsStore[matchId] = freshSnapshot[matchId];
            });
        } catch (e) {
            if (this.ws && this.ws.readyState === 1) {
                console.warn(`⚠️ Prematch Odds Polling falló (${e.response?.status || e.message}), WS Live activo.`);
                return;
            }
            if (e.response?.status === 401 || e.response?.status === 403) {
                console.error("🛑 SESIÓN CADUCADA en canal PREMATCH. Invocando Gateway...");
                this.cleanup();
                this.refreshSession();
            }
        }
    }

    processSnapshotData(items) {
        // Mantiene el mapa de Odds y Fixtures actualizado
        items.forEach(item => {
            // A. UPDATE DE CUOTAS (Markets)
            if (item.matchupId && item.prices) {
                if (!this.oddsStore[item.matchupId]) {
                    this.oddsStore[item.matchupId] = [];
                }
                const existingIndex = this.oddsStore[item.matchupId].findIndex(m => m.key === item.key);
                if (existingIndex >= 0) {
                     // Update in place
                     Object.assign(this.oddsStore[item.matchupId][existingIndex], item);
                } else {
                     this.oddsStore[item.matchupId].push(item);
                }
            }
            // B. UPDATE DE PARTIDO (Tiempo, Score, Estado)
            else if (item.type === 'matchup' || (item.id && this.fixturesStore[item.id] && !item.prices)) {
                // Si es un update de matchup (tiene ID y NO tiene prices/matchupId)
                if (!this.fixturesStore[item.id]) {
                    // Si es nuevo (raro via socket update, pero posible en snap)
                    this.fixturesStore[item.id] = item;
                } else {
                    // MERGE INTELIGENTE para no perder datos viejos si el update es parcial
                    const current = this.fixturesStore[item.id];
                    
                    // Actualizar campos clave si vienen
                    if (item.state) current.state = { ...current.state, ...item.state };
                    if (item.participants) current.participants = item.participants;
                    if (item.periods) current.periods = item.periods;
                    if (item.status) current.status = item.status;
                    if (item.liveMode) current.liveMode = item.liveMode;
                    
                    // Update root properties
                    if (item.startTime) current.startTime = item.startTime;
                    if (item.league) current.league = item.league;
                }
            }
        });
    }

    connectSocket() {
        if (!this.headers) return; 
        if (this.ws) return; 

        try {
            this.ws = new WebSocket(WS_URL, { headers: this.headers });

            this.ws.on('open', () => {
                console.log("✅ Socket Conectado (Real-Time Mode).");
                // [MOD] Suscribirse TAMBIÉN a 'matchups' para recibir actualizaciones de reloj y marcador
                this.ws.send('{"op":"subscribe", "args":["straight", "matchups"]}'); 
            });

            this.ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    
                    // 1. UPDATE (Cambios incrementales)
                    if (msg.op === 'upd' && msg.rec) {
                        const updates = Array.isArray(msg.rec) ? msg.rec : [msg.rec];
                        this.processSnapshotData(updates);
                    }
                    
                    // 2. SNAPSHOT (Carga inicial por socket)
                    if (msg.op === 'snap' && Array.isArray(msg.rec)) {
                        console.log(`⚡ Socket Snap: ${msg.rec.length} items recibidos.`);
                        this.processSnapshotData(msg.rec);
                    }
                } catch (e) {
                    // Ignore ping/pong or garbage
                }
            });

            this.ws.on('error', (e) => console.log(`⚠️ Socket Warn: ${e.message}`));
            
            this.ws.on('close', () => {
                this.ws = null;
            });
        } catch (e) {
            console.error("Socket Init Error:", e.message);
        }
    }

    saveData() {
        // Hacemos JOIN de (Nombres/Ligas) + (Cuotas)
        const eventIds = Object.keys(this.fixturesStore);
        const mergedEvents = [];

        for (const id of eventIds) {
            const markets = this.oddsStore[id];
            
            // Solo exportar eventos que tengan mercados activos (Cuotas)
            if (markets && markets.length > 0) {
                const fixture = this.fixturesStore[id];
                mergedEvents.push({
                    id: parseInt(id),
                    // Spread participants info para que el Scanner pueda leer nombres
                    participants: fixture.participants,
                    startTime: fixture.startTime, // [FIX] Exponemos la hora para el Matcher
                    league: fixture.league || { id: fixture.parentLeagueId }, 
                    units: fixture.units,
                    state: fixture.state, // [FIX] Persist state to JSON
                    periods: fixture.periods, // [FIX] Persist periods to JSON
                    markets: markets
                });
            }
        }

        if (mergedEvents.length > 0) {
            const output = {
                updatedAt: new Date().toISOString(),
                count: mergedEvents.length,
                events: mergedEvents
            };

            // Escritura atómica con reintento (Fix EPERM Windows/OneDrive)
            const tempFile = OUTPUT_FILE + '.tmp';
            
            const robustWrite = (retries = 3) => {
                try {
                    fs.writeFileSync(tempFile, JSON.stringify(output, null, 2));
                    
                    try {
                        if (fs.existsSync(OUTPUT_FILE)) {
                            // Try to delete original first to reduce lock contention on rename
                            // Although rename is atomic, Windows sometimes prefers delete+rename
                            // But renameSync will overwrite. Let's stick to renameSync but retried.
                        }
                        fs.renameSync(tempFile, OUTPUT_FILE);
                    } catch (renameErr) {
                        // Si falla el rename (archivo bloqueado por lector), reintentar
                        if (retries > 0 && (renameErr.code === 'EPERM' || renameErr.code === 'EBUSY')) {
                            // setTimeout in sync loop is tricky. Use busy wait or just don't crash.
                            // Better: log and skip this write cycle instead of crashing loop
                            // console.log(`🔒 File locked, retrying write... (${retries})`);
                            // Small blocking delay
                            const start = Date.now(); while (Date.now() - start < 100) {} 
                            return robustWrite(retries - 1);
                        } else {
                            throw renameErr;
                        }
                    }
                } catch (e) {
                   if (e.code === 'EPERM' || e.code === 'EBUSY') {
                       // Silently ignore locking errors to keep process alive, reader will pick up next time
                       return; 
                   }
                   console.error("Write Error:", e.message);
                }
            };
            
            robustWrite();
        }
    }

    savePrematchData() {
        const eventIds = Object.keys(this.prematchFixturesStore);
        const mergedEvents = [];

        for (const id of eventIds) {
            const markets = this.prematchOddsStore[id];
            if (markets && markets.length > 0) {
                const fixture = this.prematchFixturesStore[id];
                mergedEvents.push({
                    id: parseInt(id),
                    participants: fixture.participants,
                    startTime: fixture.startTime,
                    league: fixture.league || { id: fixture.parentLeagueId },
                    units: fixture.units,
                    state: fixture.state,
                    periods: fixture.periods,
                    markets: markets
                });
            }
        }

        if (mergedEvents.length > 0) {
            const output = {
                updatedAt: new Date().toISOString(),
                count: mergedEvents.length,
                source: 'prematch',
                events: mergedEvents
            };

            const tempFile = OUTPUT_PREMATCH_FILE + '.tmp';
            const robustWrite = (retries = 3) => {
                try {
                    fs.writeFileSync(tempFile, JSON.stringify(output, null, 2));
                    try {
                        fs.renameSync(tempFile, OUTPUT_PREMATCH_FILE);
                    } catch (renameErr) {
                        if (retries > 0 && (renameErr.code === 'EPERM' || renameErr.code === 'EBUSY')) {
                            const start = Date.now(); while (Date.now() - start < 100) {}
                            return robustWrite(retries - 1);
                        }
                        throw renameErr;
                    }
                } catch (e) {
                    if (e.code === 'EPERM' || e.code === 'EBUSY') return;
                    console.error("Prematch Write Error:", e.message);
                }
            };

            robustWrite();
        }
    }
}

// Auto-arranque
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    new PinnacleLight().start();
}
