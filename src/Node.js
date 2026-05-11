// ============================================================
//  SmartStation — Server Node.js
//  Stack: Express · MQTT · SQLite · Nodemailer · Socket.io
// ============================================================

require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const mqtt       = require('mqtt');
const sqlite3    = require('sqlite3').verbose();
const nodemailer = require('nodemailer');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
//  DATABASE
// ============================================================
const db = new sqlite3.Database('./smartstation.db', (err) => {
  if (err) console.error('[DB] Errore apertura:', err.message);
  else     console.log('[DB] Connesso a smartstation.db');
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS eventi (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo      TEXT    NOT NULL,
    messaggio TEXT,
    timestamp DATETIME DEFAULT (datetime('now','localtime'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS dati_sensori (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    temperatura REAL,
    umidita     REAL,
    pressione   REAL,
    uptime      INTEGER,
    timestamp   DATETIME DEFAULT (datetime('now','localtime'))
  )`);
});

// ============================================================
//  STATO IN MEMORIA
// ============================================================
let statoSistema = {
  armato:     false,
  allarme:    false,
  ultimiDati: null,
  connesso:   false,
  mqttOk:     false
};

// ============================================================
//  EMAIL
// ============================================================
const transporter = nodemailer.createTransport({
  host:   process.env.EMAIL_HOST   || 'smtp.gmail.com',
  port:   parseInt(process.env.EMAIL_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

async function inviaEmail(oggetto, testo) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn('[EMAIL] Credenziali non configurate, skip invio.');
    return;
  }
  try {
    await transporter.sendMail({
      from:    `"SmartStation 🏠" <${process.env.EMAIL_USER}>`,
      to:      process.env.EMAIL_TO,
      subject: oggetto,
      html: `
        <div style="font-family:monospace;background:#111;color:#eee;padding:24px;border-radius:8px;">
          <h2 style="color:#ff4444;margin-top:0;">🚨 ${oggetto}</h2>
          <pre style="color:#aaa;white-space:pre-wrap;">${testo}</pre>
          <hr style="border-color:#333;"/>
          <p style="color:#555;font-size:12px;">SmartStation • ${new Date().toLocaleString('it-IT')}</p>
        </div>
      `
    });
    console.log('[EMAIL] Inviata:', oggetto);
  } catch (e) {
    console.error('[EMAIL] Errore:', e.message);
  }
}

// ============================================================
//  HELPERS
// ============================================================
function salvaEvento(tipo, messaggio) {
  db.run(
    'INSERT INTO eventi (tipo, messaggio) VALUES (?, ?)',
    [tipo, messaggio],
    (err) => { if (err) console.error('[DB] Errore evento:', err.message); }
  );
  const evt = { tipo, messaggio, timestamp: new Date().toLocaleString('it-IT') };
  io.emit('nuovo_evento', evt);
  console.log(`[EVT] [${tipo}] ${messaggio}`);
}

// ============================================================
//  MQTT
// ============================================================
const MQTT_URL = `mqtt://${process.env.MQTT_HOST || 'localhost'}:${process.env.MQTT_PORT || 1883}`;
console.log('[MQTT] Connessione a', MQTT_URL);

const mqttClient = mqtt.connect(MQTT_URL, {
  clientId:      'SmartStation_Server',
  reconnectPeriod: 5000
});

mqttClient.on('connect', () => {
  console.log('[MQTT] Connesso al broker');
  statoSistema.mqttOk = true;
  mqttClient.subscribe(['stazione/dati', 'stazione/allarme', 'stazione/stato'], (err) => {
    if (err) console.error('[MQTT] Errore subscribe:', err.message);
  });
  io.emit('stato_aggiornato', statoSistema);
});

mqttClient.on('offline', () => {
  console.warn('[MQTT] Offline');
  statoSistema.mqttOk = false;
  statoSistema.connesso = false;
  io.emit('stato_aggiornato', statoSistema);
});

mqttClient.on('error', (err) => {
  console.error('[MQTT] Errore:', err.message);
});

mqttClient.on('message', (topic, payload) => {
  let data;
  try {
    data = JSON.parse(payload.toString());
  } catch {
    console.warn('[MQTT] Payload non JSON:', payload.toString());
    return;
  }

  // --- Dati sensori ---
  if (topic === 'stazione/dati') {
    statoSistema.ultimiDati   = { ...data, timestamp: new Date().toLocaleString('it-IT') };
    statoSistema.connesso     = true;
    db.run(
      'INSERT INTO dati_sensori (temperatura, umidita, pressione, uptime) VALUES (?,?,?,?)',
      [data.temp, data.umidita, data.pressione, data.uptime]
    );
    io.emit('dati_aggiornati', statoSistema.ultimiDati);
    io.emit('stato_aggiornato', statoSistema);
  }

  // --- Allarme ---
  if (topic === 'stazione/allarme') {
    const tipo = data.tipo     || 'ALLARME';
    const msg  = data.messaggio || 'Rilevamento allarme';
    salvaEvento(tipo, msg);
    statoSistema.allarme = true;
    io.emit('stato_aggiornato', statoSistema);
    io.emit('allarme_attivo');

    inviaEmail(
      `🚨 ALLARME SmartStation — ${tipo}`,
      `Tipo:      ${tipo}\nMessaggio: ${msg}\nData/Ora:  ${new Date().toLocaleString('it-IT')}\n\nAccedi al pannello: http://${process.env.SERVER_HOST || 'localhost'}:${process.env.PORT || 3000}`
    );
  }

  // --- Stato sistema (aggiornamento da ESP32) ---
  if (topic === 'stazione/stato') {
    statoSistema.armato  = !!data.armato;
    statoSistema.allarme = !!data.allarme;
    io.emit('stato_aggiornato', statoSistema);
  }
});

// ============================================================
//  API REST
// ============================================================

// Stato corrente
app.get('/api/stato', (req, res) => res.json(statoSistema));

// Storico eventi (con filtro opzionale tipo=ALLARME ecc.)
app.get('/api/eventi', (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  || '200'), 1000);
  const offset = parseInt(req.query.offset || '0');
  const tipo   = req.query.tipo;

  let sql    = 'SELECT * FROM eventi';
  const args = [];
  if (tipo) { sql += ' WHERE tipo = ?'; args.push(tipo); }
  sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
  args.push(limit, offset);

  db.all(sql, args, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Grafico sensori (ultimi N record)
app.get('/api/dati', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '60'), 500);
  db.all(
    'SELECT * FROM (SELECT * FROM dati_sensori ORDER BY timestamp DESC LIMIT ?) ORDER BY timestamp ASC',
    [limit],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// Invia comando generico
app.post('/api/cmd', (req, res) => {
  const { cmd } = req.body;
  if (!cmd) return res.status(400).json({ error: 'Campo cmd mancante' });
  mqttClient.publish('stazione/cmd', JSON.stringify({ cmd }));
  salvaEvento('COMANDO', `Comando inviato: ${cmd}`);
  res.json({ ok: true, cmd });
});

// Arma / disarma
app.post('/api/arma', (req, res) => {
  const armato = !!req.body.armato;
  const cmd    = armato ? 'arm' : 'disarm';
  mqttClient.publish('stazione/cmd', JSON.stringify({ cmd }));
  statoSistema.armato = armato;
  salvaEvento('SISTEMA', `Sistema ${armato ? 'ARMATO' : 'DISARMATO'} dal pannello web`);
  io.emit('stato_aggiornato', statoSistema);
  res.json({ ok: true });
});

// Reset allarme
app.post('/api/reset_allarme', (req, res) => {
  mqttClient.publish('stazione/cmd', JSON.stringify({ cmd: 'reset_allarme' }));
  statoSistema.allarme = false;
  salvaEvento('SISTEMA', 'Allarme resettato dal pannello web');
  io.emit('stato_aggiornato', statoSistema);
  res.json({ ok: true });
});

// Test email
app.post('/api/test_email', async (req, res) => {
  await inviaEmail('🧪 Test SmartStation', 'Email di test inviata correttamente dal pannello.');
  salvaEvento('SISTEMA', 'Email di test inviata');
  res.json({ ok: true });
});

// Elimina tutti gli eventi
app.delete('/api/eventi', (req, res) => {
  db.run('DELETE FROM eventi', (err) => {
    if (err) return res.status(500).json({ error: err.message });
    salvaEvento('SISTEMA', 'Storico eventi cancellato');
    res.json({ ok: true });
  });
});

// ============================================================
//  SOCKET.IO — gestione connessione client
// ============================================================
io.on('connection', (socket) => {
  console.log('[WS] Nuovo client connesso:', socket.id);
  // Invia subito lo stato corrente al nuovo client
  socket.emit('stato_aggiornato', statoSistema);
  if (statoSistema.ultimiDati) socket.emit('dati_aggiornati', statoSistema.ultimiDati);

  socket.on('disconnect', () => {
    console.log('[WS] Client disconnesso:', socket.id);
  });
});

// ============================================================
//  AVVIO
// ============================================================
const PORT = parseInt(process.env.PORT || '3000');
server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  SmartStation Server                 ║`);
  console.log(`║  http://localhost:${PORT}               ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
});