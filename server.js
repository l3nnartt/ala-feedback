require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Hilfsfunktion zum gleichzeitigen Ausgeben in die Konsole und in die log.txt
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

let pollInterval = null;
let resetTimeout = null;

// 1. Webhook Empfänger (FE2 API Alarmierung)
app.post('/api/webhook/alarm', (req, res) => {
    if (req.query.token !== process.env.WEBHOOK_SECRET) {
        writeLog('Unautorisierter Zugriffversuch auf /api/webhook/alarm');
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const alarmId = req.body.externalId || req.body.alarmId || req.body.id;

    if (!alarmId) {
        writeLog('Keine externalId/alarmId im Webhook empfangen', req.body);
        return res.status(400).json({ error: 'Keine externalId/alarmId im Webhook empfangen' });
    }

    writeLog(`Neuer Alarm empfangen! ID: ${alarmId}`);
    
    activeAlarm = {
        alarmId: alarmId,
        startedAt: Date.now(),
        responses: []
    };

    if (pollInterval) clearInterval(pollInterval);
    if (resetTimeout) clearTimeout(resetTimeout);

    fetchResponses();

    const FIFTEEN_MINUTES = 15 * 60 * 1000;
    pollInterval = setInterval(() => {
        const elapsed = Date.now() - activeAlarm.startedAt;
        if (elapsed >= FIFTEEN_MINUTES) {
            clearInterval(pollInterval);
            pollInterval = null;
        } else {
            fetchResponses();
        }
    }, 30000);

    const THIRTY_MINUTES = 30 * 60 * 1000;
    resetTimeout = setTimeout(() => {
        writeLog('Alarm automatisch nach 30 Minuten zurückgesetzt.');
        activeAlarm = { alarmId: null, startedAt: null, responses: [] };
    }, THIRTY_MINUTES);

    res.json({ status: 'ok', alarmId: alarmId });
});

// 2. AMweb Webhook Test-Listener
app.post('/api/webhook/amweb-test', (req, res) => {
    writeLog("AMWEB WEBHOOK EMPFANGEN:", {
        headers: req.headers,
        body: req.body
    });

    res.status(200).json({ success: true, message: "AMweb Webhook erfolgreich empfangen!" });
});

// 3. NEUER TEST-ENDPUNKT ZUM TESTEN DER LOG-FUNKTION
app.get('/api/test-log', (req, res) => {
    writeLog("Test-Log manuell über den Browser/GET-Request ausgelöst!", {
        query: req.query,
        ip: req.ip
    });

    res.status(200).json({ 
        success: true, 
        message: "Test-Log erfolgreich geschrieben! Prüfe die log.txt auf dem Server." 
    });
});

// Funktion zum Abrufen der Rückmeldungen
async function fetchResponses() {
    if (!activeAlarm.alarmId) return;

    try {
        const response = await axios.get(
            `${process.env.FE2_BASE_URL}/rest/addressbook/external/${activeAlarm.alarmId}/feedback`,
            {
                headers: {
                    'Authorization': process.env.FE2_API_KEY,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            }
        );

        activeAlarm.responses = response.data || [];
        writeLog(`Rückmeldungen aktualisiert (${activeAlarm.responses.length} Personen)`);
    } catch (error) {
        writeLog('Fehler beim Abrufen der Rückmeldungen:', error.response ? error.response.status : error.message);
    }
}

app.get('/api/current-alarm', (req, res) => {
    res.json(activeAlarm);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    writeLog(`Server gestartet auf Port ${PORT}`);
});