require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const mqtt = require('mqtt');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function writeLog(message, data = null) {
    const timestamp = new Date().toISOString();
    let logString = `[${timestamp}] ${message}`;
    if (data !== null) {
        logString += ` ${typeof data === 'object' ? JSON.stringify(data, null, 2) : data}`;
    }
    
    console.log(logString);

    try {
        const logFilePath = path.join(__dirname, 'log.txt');
        fs.appendFileSync(logFilePath, logString + '\n----------------------------------------\n');
    } catch (err) {
        console.error('Konnte nicht in log.txt schreiben:', err);
    }
}

let activeAlarm = {
    alarmId: null,
    startedAt: null,
    responses: []
};

let resetTimeout = null;

// MQTT Client
if (process.env.MQTT_HOST) {
    const mqttUrl = `mqtts://${process.env.MQTT_HOST}:8883`;
    
    const mqttClient = mqtt.connect(mqttUrl, {
        username: process.env.MQTT_USER,
        password: process.env.MQTT_PASS,
        rejectUnauthorized: false
    });

    mqttClient.on('connect', () => {
        writeLog('Erfolgreich mit MQTT-Broker verbunden.');
        
        const topic = 'feuerwehr/leeste/rueckmeldungen';
        mqttClient.subscribe(topic, (err) => {
            if (!err) {
                writeLog(`Lausche auf MQTT-Topic: ${topic}`);
            } else {
                writeLog('Fehler beim Abonnieren des Topics:', err);
            }
        });
    });

    mqttClient.on('message', (topic, message) => {
        const payload = message.toString();
        
        try {
            const data = JSON.parse(payload);
            
            if (data.type === 'ALARM' && data.data) {
                const alarmId = data.data.externalId || 'unbekannt';
                writeLog(`Alarm erkannt per MQTT. ID: ${alarmId}`);

                // Pruefen, ob es sich um einen neuen Alarm handelt
                if (activeAlarm.alarmId !== alarmId) {
                    activeAlarm.alarmId = alarmId;
                    activeAlarm.startedAt = Date.now();
                    
                    if (resetTimeout) clearTimeout(resetTimeout);
                    
                    const THIRTY_MINUTES = 30 * 60 * 1000;
                    resetTimeout = setTimeout(() => {
                        writeLog('Alarm automatisch nach 30 Minuten zurückgesetzt.');
                        activeAlarm = { alarmId: null, startedAt: null, responses: [] };
                    }, THIRTY_MINUTES);
                }

                // Nachricht extrahieren und parsen
                let parsedResponses = [];
                if (Array.isArray(data.data.message)) {
                    data.data.message.forEach(line => {
                        if (typeof line === 'string' && line.includes(':')) {
                            const parts = line.split(':');
                            const namePart = parts[0].trim();
                            const statusPart = parts[1].trim().toLowerCase();

                            // Ueberspringe Zeilen, die nur Zahlen enthalten (z.B. "Komme: 1")
                            if (!isNaN(statusPart) || namePart.toLowerCase().includes('funktionen')) {
                                return;
                            }

                            let mappedState = 'UNKNOWN';
                            if (statusPart.includes('komme nicht') || statusPart.includes('nein') || statusPart.includes('absage')) {
                                mappedState = 'NO';
                            } else if (statusPart.includes('komme') || statusPart.includes('ja') || statusPart.includes('zusage') || statusPart.includes('hier')) {
                                mappedState = 'YES';
                            }

                            parsedResponses.push({
                                name: namePart,
                                state: mappedState,
                                functions: [], // Funktionen werden in diesem reinen Textformat aktuell nicht pro Person uebertragen
                                free: parts[1].trim()
                            });
                        }
                    });
                }

                activeAlarm.responses = parsedResponses;
                writeLog(`Rueckmeldungen verarbeitet: ${parsedResponses.length} Personen gefunden.`);
            }
        } catch (error) {
            writeLog('Fehler beim Verarbeiten der MQTT-Nachricht:', error.message);
        }
    });

    mqttClient.on('error', (err) => {
        writeLog('MQTT Verbindungsfehler:', err);
    });
} else {
    writeLog('Kein MQTT_HOST in .env definiert. MQTT-Client inaktiv.');
}

// API Endpunkt fuer das Display
app.get('/api/current-alarm', (req, res) => {
    res.json(activeAlarm);
});

// Test-Endpunkt Log
app.get('/api/test-log', (req, res) => {
    writeLog("Test-Log manuell ausgeloest.", {
        query: req.query,
        ip: req.ip
    });

    res.status(200).json({ 
        success: true, 
        message: "Test-Log erfolgreich geschrieben." 
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    writeLog(`Server gestartet auf Port ${PORT}`);
});