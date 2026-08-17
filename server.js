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

// 1. webhook listen
app.post('/api/webhook/alarm', (req, res) => {
    // auth - param
    if (req.query.token !== process.env.WEBHOOK_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // FE2 übergibt die Einsatz-/Alarm-ID im Body (z.B. req.body.alarmId oder req.body.id)
    const alarmId = req.body.alarmId || req.body.id || req.body.alarm_id;

    if (!alarmId) {
        return res.status(400).json({ error: 'Keine alarmId im Webhook empfangen' });
    }

    console.log(`Neuer Alarm empfangen! ID: ${alarmId}`);
    
    // Aktiven Alarm setzen
    activeAlarm = {
        alarmId: alarmId,
        startedAt: Date.now(),
        responses: []
    };

    // Stoppe evtl. laufendes Polling
    if (pollInterval) clearInterval(pollInterval);

    // Sofort abrufen und dann alle 30 Sekunden
    fetchResponses();

    const FIFTEEN_MINUTES = 15 * 60 * 1000;
    pollInterval = setInterval(() => {
        const elapsed = Date.now() - activeAlarm.startedAt;
        if (elapsed >= FIFTEEN_MINUTES) {
            console.log('15 Minuten abgelaufen. Abfrage wird beendet.');
            clearInterval(pollInterval);
            pollInterval = null;
        } else {
            fetchResponses();
        }
    }, 30000);

    res.json({ status: 'ok', alarmId: alarmId });
});

// Funktion zum Abrufen der rueckmeldung von FE2
async function fetchResponses() {
    if (!activeAlarm.alarmId) return;

    try {
        const response = await axios.get(
            `${process.env.FE2_BASE_URL}/rest/api/v2/alarms/${activeAlarm.alarmId}/responses`,
            {
                headers: {
                    'Authorization': `Bearer ${process.env.FE2_API_KEY}`,
                    'Accept': 'application/json'
                }
            }
        );

        activeAlarm.responses = response.data || [];
        console.log(`Rückmeldungen aktualisiert (${activeAlarm.responses.length} Personen)`);
    } catch (error) {
        console.error('Fehler beim Abrufen der Rückmeldungen von FE2:', error.message);
    }
}

// 2. API für die HTML-Anzeige im Feuerwehrhaus
app.get('/api/current-alarm', (res) => {
    res.json(activeAlarm);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});