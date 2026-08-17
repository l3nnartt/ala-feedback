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

// 1. Webhook Empfänger (Bestehend für FE2 API Alarmierung)
app.post('/api/webhook/alarm', (req, res) => {
    // Auth - Parameter Check
    if (req.query.token !== process.env.WEBHOOK_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const alarmId = req.body.externalId || req.body.alarmId || req.body.id;

    if (!alarmId) {
        return res.status(400).json({ error: 'Keine externalId/alarmId im Webhook empfangen' });
    }

    console.log(`Neuer Alarm empfangen! ID: ${alarmId}`);
    
    activeAlarm = {
        alarmId: alarmId,
        startedAt: Date.now(),
        responses: []
    };

    if (pollInterval) clearInterval(pollInterval);
    if (resetTimeout) clearTimeout(resetTimeout);

    fetchResponses();

    // Polling für 15 Minuten
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

    // Reset nach 30 Minuten
    const THIRTY_MINUTES = 30 * 60 * 1000;
    resetTimeout = setTimeout(() => {
        activeAlarm = { alarmId: null, startedAt: null, responses: [] };
    }, THIRTY_MINUTES);

    res.json({ status: 'ok', alarmId: alarmId });
});

// ==========================================
// 2. NEUER AMWEB WEBHOOK TEST-LISTENER
// ==========================================
app.post('/api/webhook/amweb-test', (req, res) => {
    console.log("----------------------------------------");
    console.log("🔔 AMWEB WEBHOOK EMPFANGEN UM:", new Date().toISOString());
    console.log("Headers:", req.headers);
    console.log("Body (Rohdaten von AMweb):", JSON.stringify(req.body, null, 2));
    console.log("----------------------------------------");

    // Dem AMweb eine erfolgreiche Antwort zurückgeben
    res.status(200).json({ success: true, message: "AMweb Webhook erfolgreich empfangen!" });
});

// Funktion zum Abrufen der Rückmeldungen gemäß FE2 Dokumentation
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
        console.log(`Rückmeldungen aktualisiert (${activeAlarm.responses.length} Personen)`);
    } catch (error) {
        console.error('Fehler beim Abrufen der Rückmeldungen:', error.response ? error.response.status : error.message);
    }
}

app.get('/api/current-alarm', (req, res) => {
    res.json(activeAlarm);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});