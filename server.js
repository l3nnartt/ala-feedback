/**
 * Einsatz-Display Server für die Feuerwehr Leeste
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const mqtt = require('mqtt');

// === SETUP & CONFIGURATION ===
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Verbesserte Logging-Funktion
 * Nutzt nun Loglevel und schreibt asynchron in eine .log Datei, 
 * um den Server bei vielen Anfragen nicht zu blockieren.
 */
function writeLog(level, message, data = null) {
    const timestamp = new Date().toISOString();
    let logString = `[${timestamp}] [${level}] ${message}`;
    
    if (data !== null) {
        logString += ` ${typeof data === 'object' ? JSON.stringify(data, null, 2) : data}`;
    }
    
    // Ausgabe in der Konsole je nach Level farblich/strukturiert
    if (level === 'ERROR') {
        console.error(logString);
    } else {
        console.log(logString);
    }

    // In Datei server.log schreiben (asynchron)
    const logFilePath = path.join(__dirname, 'server.log');
    fs.appendFile(logFilePath, logString + '\n----------------------------------------\n', (err) => {
        if (err) console.error('[ERROR] Konnte nicht in server.log schreiben:', err);
    });
}

// === ALARM STATE ===
let activeAlarm = {
    alarmId: null,
    startedAt: null,
    responses: [],
    functions: [] // Neu hinzugefügt
};

let resetTimeout = null;

// === MQTT CLIENT ===
if (process.env.MQTT_HOST) {
    const mqttUrl = `mqtts://${process.env.MQTT_HOST}:8883`;
    
    const mqttClient = mqtt.connect(mqttUrl, {
        username: process.env.MQTT_USER,
        password: process.env.MQTT_PASS,
        rejectUnauthorized: false
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

    // Verbindungsabbrueche aufzeichnen
    mqttClient.on('offline', () => {
        writeLog('WARN', 'Verbindung zum MQTT-Broker verloren. Versuche Reconnect...');
    });

    mqttClient.on('message', (topic, message) => {
        const payload = message.toString();
        
        // Vollstaendige Daten bei Alarm immer als INFO wegschreiben
        writeLog('INFO', `Neue Nachricht auf [${topic}]. Rohdaten:`, payload);
        
        try {
            const data = JSON.parse(payload);
            
            if (data.externalId && data.parameters && data.parameters.pluginmessage) {
                const alarmId = data.externalId;
                
                if (activeAlarm.alarmId !== alarmId) {
                    writeLog('ALARM', `Neuer Einsatz erkannt! Alarm-ID: ${alarmId}`);
                    activeAlarm.alarmId = alarmId;
                    activeAlarm.startedAt = Date.now();
                    
                    if (resetTimeout) clearTimeout(resetTimeout);
                    
                    const THIRTY_MINUTES = 30 * 60 * 1000;
                    resetTimeout = setTimeout(() => {
                        writeLog('INFO', `Alarm (ID: ${activeAlarm.alarmId}) automatisch nach 30 Minuten zurückgesetzt. Display geht in Bereitschaft.`);
                        activeAlarm = { alarmId: null, startedAt: null, responses: [], functions: [] };
                    }, THIRTY_MINUTES);
                } else {
                    writeLog('INFO', `Update fuer aktiven Einsatz erhalten (ID: ${alarmId})`);
                }

                // === DATEN-VERARBEITUNG: PERSONEN ===
                let parsedResponses = [];
                let countYes = 0;
                let countNo = 0;
                let countUnknown = 0;
                
                const lines = data.parameters.pluginmessage.split('\n');
                const keywordsNo  = ['komme nicht', 'nein', 'absage', 'abwesend'];
                const keywordsYes = ['komme', 'ja', 'zusage', 'hier'];

                lines.forEach(line => {
                    if (typeof line === 'string' && line.includes(':')) {
                        const parts = line.split(':');
                        const namePart = parts[0].trim();
                        const statusPart = parts[1].trim().toLowerCase();

                        if (!isNaN(statusPart) || namePart.toLowerCase().includes('funktionen') || namePart.toLowerCase().includes('gesamt')) {
                            return;
                        }

                        let mappedState = 'UNKNOWN';
                        
                        if (keywordsNo.some(kw => statusPart.includes(kw))) {
                            mappedState = 'NO';
                            countNo++;
                        } else if (keywordsYes.some(kw => statusPart.includes(kw))) {
                            mappedState = 'YES';
                            countYes++;
                        } else {
                            countUnknown++;
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

                // === DATEN-VERARBEITUNG: FUNKTIONEN (NEU) ===
                let functionsSummary = [];
                if (data.parameters && data.parameters.function_all) {
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
                }

                activeAlarm.responses = parsedResponses;
                activeAlarm.functions = functionsSummary; // Funktionen speichern
                
                // Detaillierte Zusammenfassung loggen
                writeLog('INFO', 'Auswertung abgeschlossen.', {
                    gesamtPersonen: parsedResponses.length,
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

// === REST API ENDPUNKTE (Frontend-Schnittstellen) ===

app.get('/api/current-alarm', (req, res) => {
    res.json(activeAlarm);
});

app.get('/api/test-log', (req, res) => {
    writeLog('INFO', "Test-Log manuell ausgelöst via Browser.", { ip: req.ip });
    res.status(200).json({ success: true, message: "Test-Log erfolgreich in server.log geschrieben." });
});

// === SERVER START ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    writeLog('INFO', `Webserver gestartet auf Port ${PORT}`);
});
