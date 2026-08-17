require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let activeAlarm = {
    alarmId: null,
    startedAt: null,
    responses: []
};

let pollInterval = null;
let resetTimeout = null;

// 1. Webhook Empfänger
app.post('/api/webhook/alarm', (req, res) => {
    // Auth - Parameter Check
    if (req.query.token !== process.env.WEBHOOK_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const alarmId = req.body.alarmId || req.body.id || req.body.alarm_id;

    if (!alarmId) {
        return res.status(400).json({ error: 'Keine alarmId im Webhook empfangen' });
    }

    console.log(`Neuer Alarm empfangen! ID: ${alarmId}`);
    
    activeAlarm = {
        alarmId: alarmId,
        startedAt: Date.now(),
        responses: []
    };

    // Vorherige Timer löschen, falls ein neuer Alarm reinkommt
    if (pollInterval) clearInterval(pollInterval);
    if (resetTimeout) clearTimeout(resetTimeout);

    // Sofort Daten abrufen
    fetchResponses();

    // Polling: 15 Minuten lang alle 30 Sekunden abrufen
    const FIFTEEN_MINUTES = 15 * 60 * 1000;
    pollInterval = setInterval(() => {
        const elapsed = Date.now() - activeAlarm.startedAt;
        if (elapsed >= FIFTEEN_MINUTES) {
            console.log('15 Minuten abgelaufen. Polling beendet.');
            clearInterval(pollInterval);
            pollInterval = null;
        } else {
            fetchResponses();
        }
    }, 30000);

    // Automatischer Reset: Nach 30 Minuten den Alarm auf dem Display beenden
    const THIRTY_MINUTES = 30 * 60 * 1000;
    resetTimeout = setTimeout(() => {
        console.log('30 Minuten abgelaufen. Display wird resettet.');
        activeAlarm = {
            alarmId: null,
            startedAt: null,
            responses: []
        };
        resetTimeout = null;
    }, THIRTY_MINUTES);

    res.json({ status: 'ok', alarmId: alarmId });
});

// Funktion zum Abrufen der Rückmeldungen von FE2 (via Basic Auth)
async function fetchResponses() {
    if (!activeAlarm.alarmId) return;

    try {
        const response = await axios.get(
            `${process.env.FE2_BASE_URL}/rest/api/v2/alarms/${activeAlarm.alarmId}/responses`,
            {
                auth: {
                    username: process.env.FE2_ALARM_USER,
                    password: process.env.FE2_ALARM_PASSWORD
                },
                headers: {
                    'Accept': 'application/json'
                }
            }
        );

        activeAlarm.responses = response.data || [];
        console.log(`Rückmeldungen aktualisiert (${activeAlarm.responses.length} Personen)`);
    } catch (error) {
        console.error('Fehler beim Abrufen der Rückmeldungen von FE2:', error.response ? error.response.data : error.message);
    }
}

// 2. API für das FE-Display
app.get('/api/current-alarm', (req, res) => {
    res.json(activeAlarm);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});