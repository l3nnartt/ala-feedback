require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const mqtt = require('mqtt');

const app = express();

app.disable('x-powered-by');
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const HISTORY_FILE = path.join(__dirname, 'history.json');
const ACTIVE_ALARM_FILE = path.join(__dirname, 'active_alarm.json');

function safeWriteJsonFile(filePath, data) {
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
}

function loadHistory() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        }
    } catch (err) {
        writeLog('ERROR', 'Fehler beim Laden der history.json:', err.message);
    }
    return [];
}

function saveOrUpdateHistory(entry) {
    try {
        let history = loadHistory();
        const index = history.findIndex(h => h.alarmId === entry.alarmId);
        if (index !== -1) {
            history[index] = entry;
        } else {
            history.unshift(entry);
            if (history.length > 10) history = history.slice(0, 10);
        }
        safeWriteJsonFile(HISTORY_FILE, history);
    } catch (err) {
        writeLog('ERROR', 'Fehler beim Speichern der history.json:', err.message);
    }
}

function loadActiveAlarm() {
    try {
        if (fs.existsSync(ACTIVE_ALARM_FILE)) {
            return JSON.parse(fs.readFileSync(ACTIVE_ALARM_FILE, 'utf8'));
        }
    } catch (err) {
        writeLog('ERROR', 'Fehler beim Laden der active_alarm.json:', err.message);
    }
    return { alarmId: null, startedAt: null, responses: [], functions: [], keyword: '', location: '' };
}

function saveActiveAlarm(alarmData) {
    try {
        safeWriteJsonFile(ACTIVE_ALARM_FILE, alarmData);
    } catch (err) {
        writeLog('ERROR', 'Fehler beim Speichern der active_alarm.json:', err.message);
    }
}

function writeLog(level, message, data = null) {
    const timestamp = new Date().toISOString();
    let logString = `[${timestamp}] [${level}] ${message}`;
    
    if (data !== null) {
        logString += ` ${typeof data === 'object' ? JSON.stringify(data, null, 2) : data}`;
    }
    
    if (level === 'ERROR') {
        console.error(logString);
    } else {
        console.log(logString);
    }

    const logFilePath = path.join(__dirname, 'server.log');
    
    try {
        if (fs.existsSync(logFilePath) && fs.statSync(logFilePath).size > 5 * 1024 * 1024) {
            const backupLogPath = path.join(__dirname, 'server.log.old');
            if (fs.existsSync(backupLogPath)) fs.unlinkSync(backupLogPath);
            fs.renameSync(logFilePath, backupLogPath);
        }
    } catch (e) {}

    fs.appendFile(logFilePath, logString + '\n----------------------------------------\n', (err) => {
        if (err) console.error('[ERROR] Konnte nicht in server.log schreiben:', err);
    });
}

function mergeResponses(oldResponses, newResponses) {
    if (!oldResponses || oldResponses.length === 0) return newResponses || [];
    if (!newResponses || newResponses.length === 0) return oldResponses;

    const map = new Map();
    oldResponses.forEach(r => map.set(r.name, r));
    newResponses.forEach(r => map.set(r.name, r));
    return Array.from(map.values());
}

let activeAlarm = loadActiveAlarm();
let resetTimeout = null;

if (activeAlarm.alarmId && activeAlarm.startedAt) {
    const elapsed = Date.now() - activeAlarm.startedAt;
    const THIRTY_MINUTES = 30 * 60 * 1000;
    
    if (elapsed < THIRTY_MINUTES) {
        writeLog('INFO', `Stelle laufenden Einsatz nach Neustart wieder her (ID: ${activeAlarm.alarmId})`);
        resetTimeout = setTimeout(() => {
            writeLog('INFO', `Alarm (ID: ${activeAlarm.alarmId}) automatisch abgelaufen. Display geht in Bereitschaft.`);
            activeAlarm = { alarmId: null, startedAt: null, responses: [], functions: [], keyword: '', location: '' };
            saveActiveAlarm(activeAlarm);
        }, THIRTY_MINUTES - elapsed);
    } else {
        writeLog('INFO', `Laufender Einsatz (ID: ${activeAlarm.alarmId}) ist waehrend der Offline-Zeit abgelaufen.`);
        activeAlarm = { alarmId: null, startedAt: null, responses: [], functions: [], keyword: '', location: '' };
        saveActiveAlarm(activeAlarm);
    }
}

if (process.env.MQTT_HOST) {
    const mqttUrl = `mqtts://${process.env.MQTT_HOST}:8883`;
    const rejectUnauthorized = process.env.MQTT_REJECT_UNAUTHORIZED !== 'false';
    
    const mqttClient = mqtt.connect(mqttUrl, {
        username: process.env.MQTT_USER,
        password: process.env.MQTT_PASS,
        rejectUnauthorized: rejectUnauthorized
    });

    mqttClient.on('connect', () => {
        writeLog('INFO', 'Erfolgreich mit MQTT-Broker verbunden.');
        
        const topic = 'feuerwehr/leeste/rueckmeldungen';
        mqttClient.subscribe(topic, (err) => {
            if (!err) {
                writeLog('INFO', `Lausche auf MQTT-Topic: ${topic}`);
            } else {
                writeLog('ERROR', 'Fehler beim Abonnieren des Topics:', err);
            }
        });
    });

    mqttClient.on('offline', () => {
        writeLog('WARN', 'Verbindung zum MQTT-Broker verloren. Versuche Reconnect...');
    });

    mqttClient.on('message', (topic, message) => {
        const payload = message.toString();
        
        writeLog('INFO', `Neue Nachricht auf [${topic}]. Rohdaten:`, payload);
        
        try {
            const data = JSON.parse(payload);
            const alarmId = data.externalId || (data.parameters ? data.parameters.einsatznummer : null);
            
            if (alarmId && data.parameters) {
                const isUpdate = (activeAlarm.alarmId === alarmId);
                
                if (!isUpdate) {
                    writeLog('ALARM', `Neuer Einsatz erkannt! Alarm-ID: ${alarmId}`);
                    activeAlarm.alarmId = alarmId;
                    activeAlarm.startedAt = Date.now();
                    activeAlarm.responses = [];
                    activeAlarm.functions = [];
                } else {
                    writeLog('INFO', `Update fuer aktiven Einsatz erhalten (ID: ${alarmId})`);                    
                }

                activeAlarm.keyword = data.parameters.keyword || data.parameters.keyword_description || activeAlarm.keyword || 'Einsatz';
                activeAlarm.location = data.parameters.location_dest || data.parameters.street || activeAlarm.location || 'Unbekannter Ort';

                if (resetTimeout) clearTimeout(resetTimeout);
                const THIRTY_MINUTES = 30 * 60 * 1000;
                const elapsed = Date.now() - activeAlarm.startedAt;
                const remainingTime = THIRTY_MINUTES - elapsed;

                if (remainingTime > 0) {
                    resetTimeout = setTimeout(() => {
                        writeLog('INFO', `Alarm (ID: ${activeAlarm.alarmId}) automatisch exakt 30 Minuten nach Alarmeingang zurückgesetzt. Display geht in Bereitschaft.`);
                        activeAlarm = { alarmId: null, startedAt: null, responses: [], functions: [], keyword: '', location: '' };
                        saveActiveAlarm(activeAlarm);
                    }, remainingTime);
                }

                let parsedResponses = [];
                
                if (data.parameters.pluginmessage) {
                    const lines = data.parameters.pluginmessage.split('\n');
                    const keywordsNo  = ['komme nicht', 'nein', 'absage', 'abwesend'];
                    const keywordsYes = ['komme', 'ja', 'zusage', 'hier'];

                    lines.forEach(line => {
                        if (typeof line === 'string' && line.includes(':')) {
                            const parts = line.split(':');
                            const namePart = parts[0].trim();
                            const statusPart = parts[1].trim().toLowerCase();

                            if (!isNaN(Number(statusPart)) || namePart.toLowerCase().includes('funktionen') || namePart.toLowerCase().includes('gesamt')) {
                                return;
                            }

                            let mappedState = 'UNKNOWN';
                            
                            if (keywordsNo.some(kw => statusPart.includes(kw))) {
                                mappedState = 'NO';
                            } else if (keywordsYes.some(kw => statusPart.includes(kw))) {
                                mappedState = 'YES';
                            }

                            let freeText = parts[1].trim();
                            if (statusPart.includes('frei') && data.parameters.feedbackFreeText) {
                                freeText = data.parameters.feedbackFreeText;
                            }

                            parsedResponses.push({
                                name: namePart,
                                state: mappedState,
                                functions: [], 
                                free: freeText
                            });
                        }
                    });
                }

                activeAlarm.responses = mergeResponses(activeAlarm.responses, parsedResponses);

                let countYes = 0;
                let countNo = 0;
                let countUnknown = 0;

                activeAlarm.responses.forEach(r => {
                    if (r.state === 'YES') countYes++;
                    else if (r.state === 'NO') countNo++;
                    else countUnknown++;
                });

                if (data.parameters.function_all) {
                    let functionsSummary = [];
                    const funcLines = data.parameters.function_all.split('\n');
                    funcLines.forEach(line => {
                        if (line.includes(':') && !line.toLowerCase().includes('funktionen')) {
                            const parts = line.split(':');
                            functionsSummary.push({
                                label: parts[0].trim(),
                                count: parts[1].trim()
                            });
                        }
                    });
                    activeAlarm.functions = functionsSummary;
                }
                
                saveActiveAlarm(activeAlarm);

                const historyEntry = {
                    alarmId: alarmId,
                    keyword: activeAlarm.keyword,
                    location: activeAlarm.location,
                    date: data.parameters.date || new Date().toLocaleDateString('de-DE'),
                    time: data.parameters.time || new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
                    total: activeAlarm.responses.length,
                    yes: countYes,
                    no: countNo,
                    other: countUnknown,
                    timestamp: Date.now()
                };
                saveOrUpdateHistory(historyEntry);

                writeLog('INFO', 'Auswertung abgeschlossen.', {
                    gesamtPersonen: activeAlarm.responses.length,
                    zusagen: countYes,
                    absagen: countNo,
                    sonstige: countUnknown
                });

            } else {
                writeLog('WARN', 'MQTT Nachricht entsprach nicht dem erwarteten FE2-Format.', { payloadPreview: payload.substring(0, 100) });
            }
        } catch (error) {
            writeLog('ERROR', 'Fehler beim Verarbeiten (JSON Parse) der MQTT-Nachricht:', error.message);
        }
    });

    mqttClient.on('error', (err) => {
        writeLog('ERROR', 'Kritischer MQTT Verbindungsfehler:', err);
    });
} else {
    writeLog('WARN', 'Kein MQTT_HOST in .env definiert. Server laeuft ohne MQTT-Anbindung.');
}

app.get('/api/current-alarm', (req, res) => {
    res.json(activeAlarm);
});

app.get('/api/history', (req, res) => {
    res.json(loadHistory());
});

app.get('/api/test-log', (req, res) => {
    writeLog('INFO', "Test-Log manuell ausgelöst via Browser.", { ip: req.ip });
    res.status(200).json({ success: true, message: "Test-Log erfolgreich in server.log geschrieben." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    writeLog('INFO', `Webserver gestartet auf Port ${PORT}`);
});