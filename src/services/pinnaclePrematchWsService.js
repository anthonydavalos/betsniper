import fs from 'fs';
import path from 'path';
import axios from 'axios';
import https from 'https';
import mqtt from 'mqtt';
import { fileURLToPath } from 'url';
import db, { initDB } from '../db/database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

const WS_URL = 'wss://api.arcadia.pinnacle.com/ws';
const TOKEN_FILE = path.join(projectRoot, 'data', 'pinnacle_token.json');
const OUTPUT_PREMATCH_FILE = path.join(projectRoot, 'data', 'pinnacle_prematch.json');
const ARCADIA_BASE_URL = process.env.PINNACLE_ARCADIA_ROOT || 'https://api.arcadia.pinnacle.com/0.1';

const DEFAULT_DISCOVERY_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_SAVE_INTERVAL_MS = 15 * 1000;
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 12 * 1000;
const DEFAULT_WS_STALE_MS = 70 * 1000;
const DEFAULT_FALLBACK_POLL_INTERVAL_MS = 45 * 1000;
const DEFAULT_SAFETY_POLL_INTERVAL_MS = 6 * 60 * 1000;
const DEFAULT_LEAGUE_LIMIT = 120;
const DEFAULT_PREMATCH_PRIMARY_HOURS = 6;
const DEFAULT_PREMATCH_PREFETCH_HOURS = 6;
const DEFAULT_PREMATCH_OVERLAP_MINUTES = 30;
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 60000;
const MISSING_TOPICS_RECOVERY_INTERVAL_MS = 30 * 1000;

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

const parseBool = (value, fallback = false) => {
    if (value === undefined || value === null || String(value).trim() === '') return fallback;
    const txt = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(txt)) return true;
    if (['0', 'false', 'no', 'off'].includes(txt)) return false;
    return fallback;
};

const parsePositive = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const isExcludedMarketVariant = ({ home = '', away = '', league = '', units = '' } = {}) => {
    if (units && String(units).toLowerCase() !== 'regular') return true;
    const blob = normalizeMarketText(`${home} ${away} ${league} ${units}`);
    return EXCLUDED_MATCH_TERMS.some((term) => blob.includes(term));
};

const getCanonicalTeams = (participants = []) => {
    const home = Array.isArray(participants)
        ? participants.find((p) => p?.alignment === 'home')
        : null;
    const away = Array.isArray(participants)
        ? participants.find((p) => p?.alignment === 'away')
        : null;

    return {
        hasCanonicalTeams: Boolean(home && away),
        homeName: home?.name || '',
        awayName: away?.name || ''
    };
};

const getPrematchWindowUtc = () => {
    const nowUtcMs = Date.now();
    const primaryHours = parsePositive(process.env.PREMATCH_WINDOW_PRIMARY_HOURS, DEFAULT_PREMATCH_PRIMARY_HOURS);
    const prefetchHours = parsePositive(process.env.PREMATCH_WINDOW_PREFETCH_HOURS, DEFAULT_PREMATCH_PREFETCH_HOURS);
    const overlapMinutes = parsePositive(process.env.PREMATCH_WINDOW_OVERLAP_MINUTES, DEFAULT_PREMATCH_OVERLAP_MINUTES);

    const startUtcMs = nowUtcMs - overlapMinutes * 60 * 1000;
    const endUtcMs = nowUtcMs + (primaryHours + prefetchHours) * 60 * 60 * 1000;
    return { nowUtcMs, startUtcMs, endUtcMs, overlapMinutes, primaryHours, prefetchHours };
};

const ensureDirForFile = (filePath) => {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const toSafeIso = (value) => {
    const ts = new Date(value || '').getTime();
    if (!Number.isFinite(ts)) return null;
    return new Date(ts).toISOString();
};

const isProbablyLive = (fixture = {}) => {
    if (!fixture || typeof fixture !== 'object') return false;
    if (fixture.isLive === true) return true;
    if (fixture.liveMode) return true;
    if (fixture.state && fixture.state.minutes !== undefined && fixture.state.minutes !== null) return true;
    return false;
};

class PinnaclePrematchWsService {
    constructor() {
        this.wsClient = null;
        this.started = false;
        this.isConnecting = false;
        this.reconnectTimer = null;
        this.discoveryTimer = null;
        this.saveTimer = null;
        this.healthTimer = null;

        this.fixtureStore = new Map();
        this.marketStore = new Map();
        this.targetLeagueIds = new Set();
        this.subscribedTopics = new Set();
        this.lastTopicRefreshAt = 0;

        this.lastWsFrameAt = 0;
        this.lastUsefulWsFrameAt = 0;
        this.lastPollingSyncAt = 0;
        this.lastFallbackReason = null;
        this.lastSaveAt = 0;
        this.pollingInFlight = false;
        this.reconnectAttempt = 0;
        this.wsConnected = false;
        this.cachedSessionKey = null;
        this.cachedMqttUsername = null;
        this.cachedMqttTokenBase = null;
        this.lastLeaguesRecoveryAttemptAt = 0;

        this.discoveryIntervalMs = parsePositive(
            process.env.PINNACLE_PREMATCH_WS_DISCOVERY_INTERVAL_MS,
            DEFAULT_DISCOVERY_INTERVAL_MS
        );
        this.saveIntervalMs = parsePositive(
            process.env.PINNACLE_PREMATCH_WS_SAVE_INTERVAL_MS,
            DEFAULT_SAVE_INTERVAL_MS
        );
        this.healthCheckIntervalMs = parsePositive(
            process.env.PINNACLE_PREMATCH_WS_HEALTH_CHECK_INTERVAL_MS,
            DEFAULT_HEALTH_CHECK_INTERVAL_MS
        );
        this.wsStaleMs = parsePositive(
            process.env.PINNACLE_PREMATCH_WS_STALE_MS,
            DEFAULT_WS_STALE_MS
        );
        this.fallbackPollIntervalMs = parsePositive(
            process.env.PINNACLE_PREMATCH_WS_FALLBACK_POLL_INTERVAL_MS,
            DEFAULT_FALLBACK_POLL_INTERVAL_MS
        );
        this.safetyPollIntervalMs = parsePositive(
            process.env.PINNACLE_PREMATCH_WS_SAFETY_POLL_INTERVAL_MS,
            DEFAULT_SAFETY_POLL_INTERVAL_MS
        );
        this.leagueLimit = Math.max(
            20,
            Math.floor(parsePositive(process.env.PINNACLE_PREMATCH_WS_LEAGUE_LIMIT, DEFAULT_LEAGUE_LIMIT))
        );
        this.useSpcTopics = parseBool(process.env.PINNACLE_PREMATCH_WS_INCLUDE_SPC_TOPICS, true);
        this.useRegTopics = parseBool(process.env.PINNACLE_PREMATCH_WS_INCLUDE_REG_TOPICS, true);
    }

    loadHeaders() {
        try {
            if (!fs.existsSync(TOKEN_FILE)) return null;
            const payload = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
            const headers = payload?.headers || null;
            if (!headers || typeof headers !== 'object') return null;

            // Limpieza mínima para evitar ruido de handshake heredado.
            const nextHeaders = { ...headers };
            delete nextHeaders.Upgrade;
            delete nextHeaders.Connection;
            delete nextHeaders['Sec-WebSocket-Key'];
            delete nextHeaders['Sec-WebSocket-Version'];
            delete nextHeaders['Sec-WebSocket-Extensions'];
            delete nextHeaders.Host;
            delete nextHeaders['Content-Length'];

            return nextHeaders;
        } catch (error) {
            console.error(`⚠️ [PrematchWS] Error leyendo token Pinnacle: ${error.message}`);
            return null;
        }
    }

    randomAlphaNum(size = 4) {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        const len = Math.max(1, Number(size) || 4);
        let out = '';
        for (let i = 0; i < len; i += 1) {
            out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
        }
        return out;
    }

    async resolveMqttCredentials(headers = {}) {
        const forcedUsername = String(process.env.PINNACLE_PREMATCH_MQTT_USERNAME || '').trim();
        const forcedPassword = String(process.env.PINNACLE_PREMATCH_MQTT_PASSWORD || '').trim();
        if (forcedUsername && forcedPassword) {
            return { username: forcedUsername, password: forcedPassword };
        }

        const xSession = String(headers['X-Session'] || headers['x-session'] || '').trim();
        if (!xSession) return null;

        let username = forcedUsername || null;
        let tokenBase = xSession;

        if (this.cachedSessionKey === xSession) {
            if (!username && this.cachedMqttUsername) username = this.cachedMqttUsername;
            if (this.cachedMqttTokenBase) tokenBase = this.cachedMqttTokenBase;
        }

        if (!username) {
            try {
                const sessionInfo = await this.arcadiaGet(`/sessions/${xSession}`, {}, headers);
                username = String(
                    sessionInfo?.username ||
                    sessionInfo?.userName ||
                    sessionInfo?.id ||
                    ''
                ).trim() || null;
                tokenBase = String(sessionInfo?.token || tokenBase || '').trim() || tokenBase;
            } catch (error) {
                console.warn(`⚠️ [PrematchWS] No se pudo resolver username MQTT desde /sessions: ${error.message}`);
            }
        }

        if (!username) return null;

        const suffix = String(process.env.PINNACLE_PREMATCH_MQTT_SUFFIX || '').trim() || this.randomAlphaNum(4);
        const password = forcedPassword || `${tokenBase}|${suffix}`;

        this.cachedSessionKey = xSession;
        this.cachedMqttUsername = username;
        this.cachedMqttTokenBase = tokenBase;

        return { username, password };
    }

    async arcadiaGet(endpoint = '', params = {}, providedHeaders = null) {
        const headers = providedHeaders || this.loadHeaders();
        if (!headers) {
            throw new Error('Arcadia headers no disponibles');
        }

        const requestHeaders = {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Origin: 'https://www.pinnacle.com',
            Referer: 'https://www.pinnacle.com/',
            ...headers
        };

        const response = await axios.get(`${ARCADIA_BASE_URL}${endpoint}`, {
            headers: requestHeaders,
            params,
            timeout: 15000,
            httpsAgent: new https.Agent({ rejectUnauthorized: false })
        });

        return response.data;
    }

    shouldKeepFixture(fixture = {}) {
        const { nowUtcMs, startUtcMs, endUtcMs } = getPrematchWindowUtc();
        const startTs = new Date(fixture?.startTime || '').getTime();
        if (!Number.isFinite(startTs)) return false;
        if (startTs < startUtcMs || startTs > endUtcMs) return false;
        if (startTs < nowUtcMs) return false;
        if (isProbablyLive(fixture)) return false;

        const { hasCanonicalTeams, homeName, awayName } = getCanonicalTeams(fixture?.participants || []);
        if (!hasCanonicalTeams) return false;

        return !isExcludedMarketVariant({
            home: homeName,
            away: awayName,
            league: fixture?.league?.name || '',
            units: fixture?.units || ''
        });
    }

    ensureMarketMap(matchupId) {
        const key = String(matchupId || '');
        if (!key) return null;
        if (!this.marketStore.has(key)) {
            this.marketStore.set(key, new Map());
        }
        return this.marketStore.get(key);
    }

    upsertFixture(rawFixture = {}) {
        if (!rawFixture || typeof rawFixture !== 'object') return 0;
        const id = String(rawFixture.id || '');
        if (!id) return 0;

        const normalized = {
            id: Number(rawFixture.id),
            participants: Array.isArray(rawFixture.participants) ? rawFixture.participants : [],
            startTime: toSafeIso(rawFixture.startTime) || rawFixture.startTime || null,
            league: rawFixture.league || null,
            units: rawFixture.units || 'Regular',
            state: rawFixture.state || {},
            periods: Array.isArray(rawFixture.periods) ? rawFixture.periods : [],
            status: rawFixture.status || null,
            liveMode: rawFixture.liveMode || null,
            updatedAt: new Date().toISOString()
        };

        const current = this.fixtureStore.get(id);
        if (!current) {
            this.fixtureStore.set(id, normalized);
            return 1;
        }

        const merged = {
            ...current,
            ...normalized,
            participants: normalized.participants.length > 0 ? normalized.participants : current.participants,
            league: normalized.league || current.league,
            periods: normalized.periods.length > 0 ? normalized.periods : current.periods,
            state: { ...(current.state || {}), ...(normalized.state || {}) }
        };

        const changed = JSON.stringify(current) !== JSON.stringify(merged);
        if (changed) {
            this.fixtureStore.set(id, merged);
            return 1;
        }
        return 0;
    }

    buildMarketCompositeKey(market = {}) {
        if (market.key) return String(market.key);
        const type = String(market.type || 'unknown');
        const period = Number.isFinite(Number(market.period)) ? String(market.period) : 'na';
        const points = Number.isFinite(Number(market.points)) ? String(market.points) : 'na';
        return `${type};${period};${points}`;
    }

    upsertMarket(matchupId, market = {}) {
        const targetId = String(matchupId || market?.matchupId || '');
        if (!targetId) return 0;
        if (!market || typeof market !== 'object') return 0;
        if (!Array.isArray(market.prices) || market.prices.length === 0) return 0;

        const key = this.buildMarketCompositeKey(market);
        const bucket = this.ensureMarketMap(targetId);
        if (!bucket) return 0;

        const current = bucket.get(key);
        const nextMarket = {
            ...market,
            matchupId: Number(targetId),
            updatedAt: new Date().toISOString()
        };

        if (!current) {
            bucket.set(key, nextMarket);
            return 1;
        }

        // Evita retroceder versiones si llega update tardío.
        if (
            Number.isFinite(Number(current.version)) &&
            Number.isFinite(Number(nextMarket.version)) &&
            Number(nextMarket.version) < Number(current.version)
        ) {
            return 0;
        }

        const changed = JSON.stringify(current) !== JSON.stringify(nextMarket);
        if (changed) {
            bucket.set(key, nextMarket);
            return 1;
        }
        return 0;
    }

    upsertMarkets(matchupId, markets = []) {
        if (!Array.isArray(markets) || markets.length === 0) return 0;
        let changes = 0;
        for (const market of markets) {
            changes += this.upsertMarket(matchupId, market);
        }
        return changes;
    }

    processMatchupRecord(record = {}) {
        let changes = 0;

        changes += this.upsertFixture(record);
        if (Array.isArray(record.markets) && record.markets.length > 0) {
            changes += this.upsertMarkets(record.id, record.markets);
        }

        // Cuando llega un hijo especial (spc) con parent regular, preservamos parent para alimentar pre-match estándar.
        if (record.parent && typeof record.parent === 'object') {
            changes += this.upsertFixture(record.parent);
            if (Array.isArray(record.parent.markets) && record.parent.markets.length > 0) {
                changes += this.upsertMarkets(record.parent.id, record.parent.markets);
            }
        }

        return changes;
    }

    processWsPayload(topic = '', payloadBuffer = Buffer.from([])) {
        const payloadText = Buffer.isBuffer(payloadBuffer)
            ? payloadBuffer.toString('utf-8')
            : String(payloadBuffer || '');
        if (!payloadText || payloadText[0] !== '{') return 0;

        try {
            const parsed = JSON.parse(payloadText);
            const records = Array.isArray(parsed?.rec)
                ? parsed.rec
                : (parsed?.rec ? [parsed.rec] : []);

            let changes = 0;

            for (const record of records) {
                if (!record || typeof record !== 'object') continue;

                if (record.type === 'matchup' || record.participants || record.startTime) {
                    changes += this.processMatchupRecord(record);
                    continue;
                }

                if (record.matchupId && Array.isArray(record.prices)) {
                    changes += this.upsertMarket(record.matchupId, record);
                    continue;
                }

                if (record.id && Array.isArray(record.markets)) {
                    changes += this.upsertMarkets(record.id, record.markets);
                    continue;
                }
            }

            if (changes > 0) {
                this.lastUsefulWsFrameAt = Date.now();
            }

            return changes;
        } catch (_error) {
            // Ignorar payloads no JSON (keepalive binarios o mensajes de control).
            return 0;
        }
    }

    pruneOutOfWindowFixtures() {
        let removed = 0;
        for (const [id, fixture] of this.fixtureStore.entries()) {
            if (!this.shouldKeepFixture(fixture)) {
                this.fixtureStore.delete(id);
                this.marketStore.delete(id);
                removed += 1;
            }
        }
        return removed;
    }

    serializeEvents() {
        this.pruneOutOfWindowFixtures();

        const rows = [];
        for (const [id, fixture] of this.fixtureStore.entries()) {
            if (!this.shouldKeepFixture(fixture)) continue;
            const markets = Array.from(this.marketStore.get(id)?.values() || []);
            if (!Array.isArray(markets) || markets.length === 0) continue;

            rows.push({
                id: Number(id),
                participants: fixture.participants || [],
                startTime: fixture.startTime,
                league: fixture.league || null,
                units: fixture.units || 'Regular',
                state: fixture.state || {},
                periods: fixture.periods || [],
                markets
            });
        }

        rows.sort((a, b) => new Date(a.startTime || 0).getTime() - new Date(b.startTime || 0).getTime());
        return rows;
    }

    savePrematchSnapshot(reason = 'periodic') {
        const events = this.serializeEvents();
        const output = {
            updatedAt: new Date().toISOString(),
            count: events.length,
            source: this.wsConnected ? 'prematch-ws' : 'prematch-fallback-polling',
            diagnostics: {
                reason,
                wsConnected: this.wsConnected,
                lastWsFrameAt: this.lastWsFrameAt ? new Date(this.lastWsFrameAt).toISOString() : null,
                lastUsefulWsFrameAt: this.lastUsefulWsFrameAt ? new Date(this.lastUsefulWsFrameAt).toISOString() : null,
                lastPollingSyncAt: this.lastPollingSyncAt ? new Date(this.lastPollingSyncAt).toISOString() : null,
                subscribedTopics: this.subscribedTopics.size,
                discoveredLeagues: this.targetLeagueIds.size,
                fallbackReason: this.lastFallbackReason
            },
            events
        };

        ensureDirForFile(OUTPUT_PREMATCH_FILE);
        const tmpFile = `${OUTPUT_PREMATCH_FILE}.tmp`;
        try {
            fs.writeFileSync(tmpFile, JSON.stringify(output, null, 2));
            fs.renameSync(tmpFile, OUTPUT_PREMATCH_FILE);
            this.lastSaveAt = Date.now();
        } catch (error) {
            if (error?.code !== 'EPERM' && error?.code !== 'EBUSY') {
                console.error(`❌ [PrematchWS] Error guardando snapshot: ${error.message}`);
            }
        }
    }

    async refreshLeagues() {
        try {
            const leagues = await this.arcadiaGet('/sports/29/leagues', { hasMatchups: true });
            if (!Array.isArray(leagues)) return;

            const top = leagues
                .filter((l) => Number(l?.matchupCount || 0) > 0)
                .sort((a, b) => Number(b.matchupCount || 0) - Number(a.matchupCount || 0))
                .slice(0, this.leagueLimit);

            this.targetLeagueIds = new Set(top.map((l) => String(l.id)).filter(Boolean));
            this.lastTopicRefreshAt = Date.now();

            if (this.wsConnected) {
                this.subscribeLeagueTopics();
            }
        } catch (error) {
            console.warn(`⚠️ [PrematchWS] No se pudo refrescar ligas activas: ${error.message}`);
        }
    }

    buildLeagueTopics() {
        const topics = [];
        for (const leagueId of this.targetLeagueIds) {
            if (this.useRegTopics) topics.push(`matchups/reg/lg/${leagueId}/pre`);
            if (this.useSpcTopics) topics.push(`matchups/spc/lg/${leagueId}/pre`);
        }
        return topics;
    }

    subscribeLeagueTopics() {
        if (!this.wsClient || !this.wsConnected) return;
        const topics = this.buildLeagueTopics();
        if (topics.length === 0) return;

        this.wsClient.subscribe(topics, { qos: 0 }, (error, granted = []) => {
            if (error) {
                console.warn(`⚠️ [PrematchWS] Error suscribiendo topics: ${error.message}`);
                return;
            }

            this.subscribedTopics = new Set(granted.map((g) => g?.topic).filter(Boolean));
            console.log(`📡 [PrematchWS] Suscrito a ${this.subscribedTopics.size} topics prematch.`);
        });
    }

    scheduleReconnect(reason = 'unknown') {
        if (!this.started) return;
        if (this.reconnectTimer) return;

        this.reconnectAttempt += 1;
        const waitMs = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * (2 ** Math.min(this.reconnectAttempt, 5)));
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connectWs();
        }, waitMs);
        console.warn(`⚠️ [PrematchWS] Reintentando conexión WS en ${Math.ceil(waitMs / 1000)}s (${reason}).`);
    }

    async connectWs() {
        if (!this.started) return;
        if (this.wsConnected || this.isConnecting) return;

        const headers = this.loadHeaders();
        if (!headers) {
            console.warn('⚠️ [PrematchWS] Token Pinnacle no disponible. Modo polling temporal.');
            this.scheduleReconnect('missing-token');
            return;
        }

        this.isConnecting = true;

        const mqttCreds = await this.resolveMqttCredentials(headers);
        if (!mqttCreds?.username || !mqttCreds?.password) {
            this.isConnecting = false;
            console.warn('⚠️ [PrematchWS] Sin credenciales MQTT válidas. Se mantiene fallback polling.');
            this.scheduleReconnect('missing-mqtt-creds');
            return;
        }

        const options = {
            protocol: 'wss',
            clean: true,
            reconnectPeriod: 0,
            connectTimeout: 15000,
            protocolVersion: 4,
            clientId: `sub-${Math.random().toString(36).slice(2, 16)}`,
            username: mqttCreds.username,
            password: mqttCreds.password,
            wsOptions: {
                headers
            }
        };

        const client = mqtt.connect(WS_URL, options);
        this.wsClient = client;

        client.on('connect', () => {
            this.wsConnected = true;
            this.isConnecting = false;
            this.reconnectAttempt = 0;
            this.lastWsFrameAt = Date.now();
            this.lastUsefulWsFrameAt = Date.now();
            console.log('✅ [PrematchWS] Conectado a Arcadia MQTT.');
            this.subscribeLeagueTopics();
        });

        client.on('message', (topic, payload) => {
            this.lastWsFrameAt = Date.now();
            this.processWsPayload(String(topic || ''), payload);
        });

        client.on('error', (error) => {
            this.wsConnected = false;
            this.isConnecting = false;
            console.warn(`⚠️ [PrematchWS] Error WS MQTT: ${error.message}`);
        });

        client.on('close', () => {
            this.wsConnected = false;
            this.isConnecting = false;
            this.wsClient = null;
            this.scheduleReconnect('ws-close');
        });

        client.on('offline', () => {
            this.wsConnected = false;
        });
    }

    async runFallbackPolling(reason = 'unknown') {
        if (this.pollingInFlight) return;

        const now = Date.now();
        if ((now - this.lastPollingSyncAt) < this.fallbackPollIntervalMs) return;

        this.pollingInFlight = true;
        this.lastFallbackReason = reason;

        try {
            const [marketData, matchupData] = await Promise.all([
                this.arcadiaGet('/sports/29/markets/straight', { primaryOnly: false, withSpecials: false, _: Date.now() }),
                this.arcadiaGet('/sports/29/matchups', { brandId: 0, _: Date.now() })
            ]);

            const { nowUtcMs, startUtcMs, endUtcMs } = getPrematchWindowUtc();
            const fixtures = Array.isArray(matchupData) ? matchupData : [];
            const markets = Array.isArray(marketData) ? marketData : [];

            const activeIds = new Set();
            for (const fix of fixtures) {
                const startTs = new Date(fix?.startTime || '').getTime();
                if (!Number.isFinite(startTs)) continue;
                if (startTs < startUtcMs || startTs > endUtcMs) continue;
                if (startTs < nowUtcMs) continue;
                if (isProbablyLive(fix)) continue;

                const { hasCanonicalTeams, homeName, awayName } = getCanonicalTeams(fix?.participants || []);
                if (!hasCanonicalTeams) continue;
                if (isExcludedMarketVariant({
                    home: homeName,
                    away: awayName,
                    league: fix?.league?.name,
                    units: fix?.units
                })) {
                    continue;
                }

                this.upsertFixture(fix);
                activeIds.add(String(fix.id));
            }

            for (const market of markets) {
                const matchupId = String(market?.matchupId || '');
                if (!matchupId || !activeIds.has(matchupId)) continue;
                this.upsertMarket(matchupId, market);
            }

            // Limpieza de IDs que salieron de la ventana.
            for (const id of this.fixtureStore.keys()) {
                if (!activeIds.has(String(id))) {
                    const fixture = this.fixtureStore.get(String(id));
                    if (!this.shouldKeepFixture(fixture)) {
                        this.fixtureStore.delete(String(id));
                        this.marketStore.delete(String(id));
                    }
                }
            }

            // Degradación secundaria: si Arcadia polling no devolvió fixtures,
            // usar snapshot ya persistido en DB (upcomingMatches) para no dejar ciego el scanner.
            if (activeIds.size === 0) {
                const dbRows = await this.hydrateFromDbUpcoming();
                if (dbRows > 0) {
                    console.log(`🗂️ [PrematchWS] Fallback DB aplicado: ${dbRows} eventos desde upcomingMatches.`);
                }
            }

            this.lastPollingSyncAt = Date.now();
            console.log(`🛟 [PrematchWS] Fallback polling OK (${reason}). Fixtures activas=${activeIds.size}.`);
            this.savePrematchSnapshot(`fallback:${reason}`);
        } catch (error) {
            console.error(`❌ [PrematchWS] Fallback polling falló (${reason}): ${error.message}`);
        } finally {
            this.pollingInFlight = false;
        }
    }

    async hydrateFromDbUpcoming() {
        try {
            await initDB();
            await db.read();

            const rows = Array.isArray(db.data?.upcomingMatches) ? db.data.upcomingMatches : [];
            if (!rows.length) return 0;

            let hydrated = 0;
            for (const row of rows) {
                const startIso = toSafeIso(row?.date || row?.startTime);
                if (!startIso) continue;

                const fixture = {
                    id: Number(row?.id),
                    startTime: startIso,
                    participants: [
                        { alignment: 'home', name: row?.home || 'Home', order: 0, stats: [{ period: 0 }] },
                        { alignment: 'away', name: row?.away || 'Away', order: 1, stats: [{ period: 0 }] }
                    ],
                    league: row?.league || { name: 'Unknown League' },
                    units: 'Regular',
                    state: {},
                    periods: [{ period: 0, status: 'open' }],
                    status: 'open'
                };

                if (!this.shouldKeepFixture(fixture)) continue;

                this.upsertFixture(fixture);

                const odds = row?.odds || {};
                const moneylineMarkets = [];
                if (Number(odds.home) > 1 && Number(odds.away) > 1) {
                    const prices = [
                        { designation: 'home', price: Number(odds.home) },
                        { designation: 'away', price: Number(odds.away) }
                    ];
                    if (Number(odds.draw) > 1) {
                        prices.push({ designation: 'draw', price: Number(odds.draw) });
                    }
                    moneylineMarkets.push({
                        matchupId: Number(row.id),
                        key: 's;0;m',
                        period: 0,
                        status: 'open',
                        type: 'moneyline',
                        prices
                    });
                }

                const totalMarkets = Array.isArray(odds.totals)
                    ? odds.totals
                        .filter((t) => Number(t?.over) > 1 && Number(t?.under) > 1)
                        .map((t) => ({
                            matchupId: Number(row.id),
                            key: `s;0;ou;${Number(t.line)}`,
                            period: 0,
                            status: 'open',
                            type: 'total',
                            points: Number(t.line),
                            prices: [
                                { designation: 'over', price: Number(t.over), points: Number(t.line) },
                                { designation: 'under', price: Number(t.under), points: Number(t.line) }
                            ]
                        }))
                    : [];

                this.upsertMarkets(String(row.id), [...moneylineMarkets, ...totalMarkets]);
                hydrated += 1;
            }

            return hydrated;
        } catch (error) {
            console.warn(`⚠️ [PrematchWS] Fallback DB falló: ${error.message}`);
            return 0;
        }
    }

    async healthTick() {
        if (!this.started) return;

        const now = Date.now();
        const wsIsStale = !this.wsConnected || !this.lastUsefulWsFrameAt || (now - this.lastUsefulWsFrameAt) > this.wsStaleMs;
        if (wsIsStale) {
            await this.runFallbackPolling(this.wsConnected ? 'ws-stale' : 'ws-disconnected');
        }

        if ((now - this.lastPollingSyncAt) > this.safetyPollIntervalMs) {
            await this.runFallbackPolling('safety-poll');
        }

        if ((now - this.lastSaveAt) > this.saveIntervalMs) {
            this.savePrematchSnapshot('health-tick');
        }

        const missingTopicsState = this.wsConnected && (this.targetLeagueIds.size === 0 || this.subscribedTopics.size === 0);
        if (missingTopicsState && (now - this.lastLeaguesRecoveryAttemptAt) > MISSING_TOPICS_RECOVERY_INTERVAL_MS) {
            this.lastLeaguesRecoveryAttemptAt = now;
            await this.refreshLeagues();
        }

        if (this.wsConnected && this.subscribedTopics.size === 0 && this.targetLeagueIds.size > 0) {
            this.subscribeLeagueTopics();
        }
    }

    async start() {
        if (this.started) return;
        this.started = true;
        console.log('🛰️ [PrematchWS] Iniciando ingesta prematch WS + fallback polling...');

        await this.refreshLeagues();
        await this.runFallbackPolling('startup-bootstrap');
        this.connectWs();

        this.discoveryTimer = setInterval(() => {
            this.refreshLeagues();
        }, this.discoveryIntervalMs);

        this.saveTimer = setInterval(() => {
            this.savePrematchSnapshot('periodic-save');
        }, this.saveIntervalMs);

        this.healthTimer = setInterval(() => {
            this.healthTick();
        }, this.healthCheckIntervalMs);
    }

    stop() {
        this.started = false;
        if (this.discoveryTimer) {
            clearInterval(this.discoveryTimer);
            this.discoveryTimer = null;
        }
        if (this.saveTimer) {
            clearInterval(this.saveTimer);
            this.saveTimer = null;
        }
        if (this.healthTimer) {
            clearInterval(this.healthTimer);
            this.healthTimer = null;
        }
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.wsClient) {
            try {
                this.wsClient.end(true);
            } catch (_) {
                // noop
            }
            this.wsClient = null;
        }

        this.wsConnected = false;
        this.isConnecting = false;
    }

    getHealthSnapshot() {
        const now = Date.now();
        const enabled = process.env.DISABLE_PINNACLE_PREMATCH_WS !== 'true';
        const usefulAgeMs = this.lastUsefulWsFrameAt > 0 ? Math.max(0, now - this.lastUsefulWsFrameAt) : null;
        const wsStale = Boolean(this.wsConnected) && Number.isFinite(usefulAgeMs) && usefulAgeMs > this.wsStaleMs;

        let mode = 'idle';
        if (!enabled) {
            mode = 'disabled';
        } else if (this.wsConnected && !wsStale) {
            mode = 'ws-live';
        } else if (this.lastPollingSyncAt > 0) {
            mode = 'fallback-polling';
        } else if (this.isConnecting) {
            mode = 'connecting';
        }

        return {
            enabled,
            mode,
            started: this.started,
            wsConnected: this.wsConnected,
            wsStale,
            isConnecting: this.isConnecting,
            reconnectAttempt: this.reconnectAttempt,
            reconnectScheduled: Boolean(this.reconnectTimer),
            lastWsFrameAt: toSafeIso(this.lastWsFrameAt),
            lastUsefulWsFrameAt: toSafeIso(this.lastUsefulWsFrameAt),
            lastUsefulWsFrameAgeMs: usefulAgeMs,
            lastPollingSyncAt: toSafeIso(this.lastPollingSyncAt),
            lastFallbackReason: this.lastFallbackReason || null,
            lastSaveAt: toSafeIso(this.lastSaveAt),
            lastTopicRefreshAt: toSafeIso(this.lastTopicRefreshAt),
            wsStaleMs: this.wsStaleMs,
            fallbackPollIntervalMs: this.fallbackPollIntervalMs,
            safetyPollIntervalMs: this.safetyPollIntervalMs,
            counts: {
                fixtures: this.fixtureStore.size,
                marketBuckets: this.marketStore.size,
                targetLeagues: this.targetLeagueIds.size,
                subscribedTopics: this.subscribedTopics.size
            },
            outputFile: OUTPUT_PREMATCH_FILE,
            now: new Date(now).toISOString()
        };
    }
}

const singleton = new PinnaclePrematchWsService();

export const startPinnaclePrematchWsService = async () => {
    await singleton.start();
};

export const stopPinnaclePrematchWsService = () => {
    singleton.stop();
};

export const getPinnaclePrematchWsHealth = () => {
    return singleton.getHealthSnapshot();
};
