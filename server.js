/**
 * Einsatz-Display Server für die Feuerwehr Leeste
 * 
 * Dieses Skript stellt einen lokalen Webserver bereit (Express) und 
 * verbindet sich parallel als Client mit einem MQTT-Broker (HiveMQ), 
 * um Echtzeit-Alarmierungen aus FE2 zu empfangen und für das Display aufzubereiten.
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
 * Hilfsfunktion für das Logging.
 * Schreibt Meldungen zeitgleich in die Konsole und in die Datei "log.txt".
 * 
 * @param {string} message - Die Hauptnachricht, die geloggt werden soll.
 * @param {any} data - Optionale Zusatzdaten (z.B. JSON-Objekte), die mit ausgegeben werden.
 */
function writeLog(message, data = null) {
    const timestamp = new Date().toISOString();
    let logString = `[${timestamp}] ${message}`;
    
    // Falls ein Objekt übergeben wurde, wird es für die Lesbarkeit in einen String umgewandelt
    if (data !== null) {
        logString += ` ${typeof data === 'object' ? JSON.stringify(data, null, 2) : data}`;
    }
    
    console.log(logString);

    try {
        const logFilePath = path.join(__dirname, 'log.txt');
        // Hängt den Log-Eintrag an die Datei an und fügt eine Trennlinie hinzu
        fs.appendFileSync(logFilePath, logString + '\n----------------------------------------\n');
    } catch (err) {
        console.error('Konnte nicht in log.txt schreiben:', err);
    }
}

// === ALARM STATE ===
// Hier wird der aktuell laufende Einsatz im Arbeitsspeicher des Servers gehalten
let activeAlarm = {
    alarmId: null,
    startedAt: null,
    responses: []
};

// Timer-Variable, um den Alarm nach einer bestimmten Zeit automatisch zu beenden
let resetTimeout = null;

// === MQTT CLIENT ===
if (process.env.MQTT_HOST) {
    // Erzwingt eine sichere TLS-Verbindung über Port 8883
    const mqttUrl = `mqtts://${process.env.MQTT_HOST}:8883`;
    
    const mqttClient = mqtt.connect(mqttUrl, {
        username: process.env.MQTT_USER,
        password: process.env.MQTT_PASS,
        rejectUnauthorized: false // Wichtig für Cloud-Broker, um Zertifikats-Fehler zu vermeiden
    });

    // Event: Erfolgreiche Verbindung zum Broker
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

    // Event: Neue Nachricht auf dem abonnierten Topic empfangen
    mqttClient.on('message', (topic, message) => {
        const payload = message.toString();
        
        // Vollständige Rohdaten zur Fehlersuche loggen
        writeLog(`Neue MQTT Nachricht auf Topic [${topic}] empfangen. Rohdaten:`, payload);
        
        try {
            const data = JSON.parse(payload);
            
            // Validierung: Handelt es sich um das erwartete FE2-Format?
            if (data.externalId && data.parameters && data.parameters.pluginmessage) {
                const alarmId = data.externalId;
                writeLog(`Alarm erkannt per MQTT. ID: ${alarmId}`);

                // Prüfen, ob es sich um einen neuen Einsatz handelt oder nur um ein Update
                if (activeAlarm.alarmId !== alarmId) {
                    activeAlarm.alarmId = alarmId;
                    activeAlarm.startedAt = Date.now();
                    
                    // Alten Reset-Timer löschen, falls noch einer lief
                    if (resetTimeout) clearTimeout(resetTimeout);
                    
                    // Automatischen Reset nach 30 Minuten (1.800.000 Millisekunden) einrichten
                    const THIRTY_MINUTES = 30 * 60 * 1000;
                    resetTimeout = setTimeout(() => {
                        writeLog('Alarm automatisch nach 30 Minuten zurückgesetzt.');
                        activeAlarm = { alarmId: null, startedAt: null, responses: [] };
                    }, THIRTY_MINUTES);
                }

                // === DATEN-VERARBEITUNG ===
                let parsedResponses = [];
                
                // Der Textblock aus FE2 wird an jedem Zeilenumbruch aufgespalten
                const lines = data.parameters.pluginmessage.split('\n');

                lines.forEach(line => {
                    // Zeile muss existieren und einen Doppelpunkt enthalten (Format: "Name: Status")
                    if (typeof line === 'string' && line.includes(':')) {
                        const parts = line.split(':');
                        const namePart = parts[0].trim();
                        const statusPart = parts[1].trim().toLowerCase();

                        // 1. Filter: Überspringe Zeilen, die reine Statistiken (Zahlen) oder Summen enthalten
                        if (!isNaN(statusPart) || namePart.toLowerCase().includes('funktionen') || namePart.toLowerCase().includes('gesamt')) {
                            return;
                        }

                        // 2. Status-Mapping: Den deutschen Text in ein einheitliches System (YES/NO/UNKNOWN) übersetzen
                        let mappedState = 'UNKNOWN';
                        if (statusPart.includes('komme nicht') || statusPart.includes('nein') || statusPart.includes('absage') || statusPart.includes('abwesend')) {
                            mappedState = 'NO';
                        } else if (statusPart.includes('komme') || statusPart.includes('ja') || statusPart.includes('zusage') || statusPart.includes('hier')) {
                            mappedState = 'YES';
                        }

                        // 3. Freitext-Verarbeitung: Wenn der Status "frei" ist, prüfen ob FE2 einen extra Text liefert
                        let freeText = parts[1].trim();
                        if (statusPart.includes('frei') && data.parameters.feedbackFreeText) {
                            freeText = data.parameters.feedbackFreeText;
                        }

                        // Person zur Liste hinzufügen
                        parsedResponses.push({
                            name: namePart,
                            state: mappedState,
                            functions: [], 
                            free: freeText
                        });
                    }
                });

                // Die aufbereitete Liste im aktiven Alarm speichern
                activeAlarm.responses = parsedResponses;
                writeLog(`Rückmeldungen verarbeitet: ${parsedResponses.length} Personen gefunden.`);
            }
        } catch (error) {
            writeLog('Fehler beim Verarbeiten der MQTT-Nachricht:', error.message);
        }
    });

    // Event: Fehler bei der MQTT-Verbindung
    mqttClient.on('error', (err) => {
        writeLog('MQTT Verbindungsfehler:', err);
    });
} else {
    writeLog('Kein MQTT_HOST in .env definiert. MQTT-Client ist inaktiv.');
}

// === REST API ENDPUNKTE (Frontend-Schnittstellen) ===

/**
 * Endpunkt für das Frontend-Display.
 * Liefert alle 5 Sekunden den aktuellen Status als JSON zurück.
 */
app.get('/api/current-alarm', (req, res) => {
    res.json(activeAlarm);
});

/**
 * Endpunkt für administrative Tests.
 * Schreibt beim Aufruf über den Browser manuell einen Eintrag in die log.txt.
 */
app.get('/api/test-log', (req, res) => {
    writeLog("Test-Log manuell ausgelöst.", {
        query: req.query,
        ip: req.ip
    });

    res.status(200).json({ 
        success: true, 
        message: "Test-Log erfolgreich geschrieben." 
    });
});

// === SERVER START ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    writeLog(`Server gestartet auf Port ${PORT}`);
});
