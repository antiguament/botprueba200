const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const logs = [];
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logs.push(line);
  if (logs.length > 200) logs.shift();
}

log('Iniciando servidor...');
log(`Node: ${process.version}`);
log(`Platform: ${process.platform}`);
log(`Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`);

// ===== BOT STATE =====
let qrCodeDataURL = null;
let status = 'starting';
let sock = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 10;
let botStarted = false;
let lastReconnectTime = 0;
const MIN_RECONNECT_INTERVAL = 10000;

const AUTH_DIR = path.join(__dirname, 'auth_info');
const LOCK_FILE = path.join(__dirname, '.bot.lock');

// ===== LOCK FILE =====
function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim());
      if (pid === process.pid) return true;
      process.kill(pid, 0);
      log(`Lock: proceso ${pid} activo. Esta instancia NO arrancara WhatsApp.`);
      return false;
    } catch {
      log('Lock: proceso anterior muerto. Limpiando lock.');
      try { fs.unlinkSync(LOCK_FILE); } catch {}
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  log(`Lock: PID ${process.pid} registrado.`);
  return true;
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim());
      if (pid === process.pid) fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); process.exit(0); });
process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

// ===== HELPERS =====
function normalizeNumber(value) {
  const raw = String(value || '').trim();
  if (raw.includes('@')) return raw.replace(/@c\.us|@g\.us|@lid/g, '');
  return raw.replace(/\D/g, '').replace(/^00/, '');
}

function toChatId(number) {
  return `${normalizeNumber(number)}@c.us`;
}

function createMessageId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// ===== AUTO-REPLY =====
function getAutoReply(message) {
  const lower = message.toLowerCase().trim();
  if (/^(hola|buenos dias|buenas tardes|buenas noches|hey|que tal|saludos|hello|hi)$/i.test(lower))
    return 'Hola! Bienvenido a Agencia Nexus. Como puedo ayudarte hoy?';
  if (/^(adios|hasta luego|chao|nos vemos|bye|gracias|muchas gracias)$/i.test(lower))
    return 'Gracias por escribirnos! Estamos aqui cuando nos necesites.';
  if (/(precio|precios|plan|planes|cuesta|costo|cuanto)/i.test(lower))
    return 'Tenemos diferentes planes:\n\nEssential: $290K COP\nStart: $490K COP (popular)\nPRO: $890K COP (mas vendido)\nEnterprise: $1.590K COP\n\nCual te interesa?';
  if (/(servicio|servicios|hacen|que hacen|que ofrecen)/i.test(lower))
    return 'Ofrecemos:\n- Paginas web profesional\n- Tiendas online\n- Integracion WhatsApp\n- SEO y marketing digital\n- Soporte 24/7\n\nQue necesitas para tu negocio?';
  if (/(pagina|web|sitio|landing|desarrollo)/i.test(lower))
    return 'Desarrollamos paginas web profesionales, tiendas online y landing pages. Que tipo de negocio tienes?';
  if (/(tienda|ecommerce|vender|productos)/i.test(lower))
    return 'Creamos tiendas online con catalogo, carrito y pasarela de pago. El plan Start o PRO son ideales. Cuantos productos manejas?';
  if (/(whatsapp|api|integracion)/i.test(lower))
    return 'Integramos WhatsApp Business API para mensajes automaticos y ventas por chat. El plan PRO la incluye.';
  if (/(hosting|servidor|dominio)/i.test(lower))
    return 'Todos nuestros planes incluyen hosting premium, dominio .com y SSL por 12 meses.';
  if (/(soporte|ayuda|problema)/i.test(lower))
    return 'Nuestro soporte esta disponible 24/7 VIP. En que puedo ayudarte?';
  if (/(demo|muestra|ejemplo|ver)/i.test(lower))
    return 'Tenemos demos en n1nexus.com. Que tipo de negocio tienes? Te muestro uno similar!';
  if (/(pago|pagar|factura|comprar)/i.test(lower))
    return 'Aceptamos transferencia, PSE, tarjeta y Nequi. El pago es unico sin suscripciones.';
  if (/(quien eres|que eres|tu nombre)/i.test(lower))
    return 'Soy NEXUS, tu asistente virtual de Agencia Nexus. Estoy aqui para ayudarte!';
  return null;
}

// ===== ROUTES =====
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/status', (req, res) => {
  res.json({
    node: process.version, platform: process.platform,
    uptime: process.uptime(),
    memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
    whatsappStatus: status, hasQR: !!qrCodeDataURL,
    logs: logs.slice(-30)
  });
});

app.get('/api/qr', (req, res) => {
  res.json({ qr: qrCodeDataURL, status });
});

app.get('/api/logs', (req, res) => {
  res.json({ logs: logs.slice(-50) });
});

// ===== SOCKET.IO =====
io.on('connection', (socket) => {
  log('Cliente web conectado: ' + socket.id);
  socket.emit('status', status);
  if (qrCodeDataURL && status === 'qr') {
    socket.emit('qr-code', qrCodeDataURL);
  }

  socket.on('disconnect', () => log('Cliente web desconectado'));
});

// ===== WHATSAPP BOT =====
async function startBot() {
  if (botStarted) {
    log('Bot ya esta corriendo, ignorando startBot()');
    return;
  }

  if (!acquireLock()) {
    log('Otra instancia tiene el lock. WhatsApp NO se iniciara.');
    status = 'error';
    io.emit('status', 'Otra instancia activa. Espera a que libere el puerto.');
    return;
  }

  botStarted = true;

  const authDir = AUTH_DIR;
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  if (sock) {
    try { sock.end(undefined); } catch (e) {}
    sock = null;
  }

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();
  log(`Baileys version: ${version.join('.')}`);

  sock = makeWASocket({
    version, auth: state,
    printQRInTerminal: true,
    browser: ['Bot WhatsApp', 'Chrome', '4.0.0'],
    markOnlineOnConnect: true,
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      reconnectAttempts = 0;
      lastReconnectTime = 0;
      qrCodeDataURL = await qrcode.toDataURL(qr);
      status = 'qr';
      io.emit('qr-code', qrCodeDataURL);
      io.emit('status', 'Escanea el codigo QR con WhatsApp');
      log('QR generado');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      log(`Conexion cerrada. Codigo: ${code}`);

      if (code === 440) {
        log('Code 440: otra instancia tomo el control. No reconectar.');
        status = 'error';
        io.emit('status', 'Sesion reemplazada. Elimina auth_info/ y re-escanea QR.');
        botStarted = false;
        releaseLock();
        return;
      }

      if (code === DisconnectReason.loggedOut || code === 401 || code === 404) {
        status = 'logged_out';
        io.emit('status', 'Sesion cerrada. Elimina auth_info/ y reinicia.');
        log('Sesion cerrada permanentemente');
        botStarted = false;
        releaseLock();
        return;
      }

      log(`Reconectando... Codigo: ${code}`);

      const now = Date.now();
      const timeSinceLast = now - lastReconnectTime;
      if (timeSinceLast < MIN_RECONNECT_INTERVAL) {
        const wait = MIN_RECONNECT_INTERVAL - timeSinceLast;
        log(`Cooldown: esperando ${Math.round(wait / 1000)}s antes de reconectar`);
        await new Promise(r => setTimeout(r, wait));
      }

      reconnectAttempts++;
      lastReconnectTime = Date.now();

      if (reconnectAttempts > MAX_RECONNECT) {
        status = 'error';
        io.emit('status', 'Demasiados reintentos. Elimina auth_info/ y reinicia.');
        log('Maximos reintentos alcanzados');
        botStarted = false;
        releaseLock();
        return;
      }

      status = 'reconnecting';
      io.emit('status', `Reconectando... (${reconnectAttempts}/${MAX_RECONNECT})`);
      const delay = Math.min(5000 * Math.pow(2, reconnectAttempts - 1), 60000);
      log(`Reconexion #${reconnectAttempts} en ${Math.round(delay / 1000)}s...`);
      botStarted = false;
      setTimeout(() => startBot(), delay);
    }

    if (connection === 'open') {
      reconnectAttempts = 0;
      lastReconnectTime = 0;
      status = 'ready';
      qrCodeDataURL = null;
      io.emit('status', 'WhatsApp conectado');
      io.emit('qr-code', '');
      log('WhatsApp CONECTADO');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;

    for (const msg of m.messages) {
      if (msg.key.fromMe) continue;
      if (!msg.key.remoteJid || !msg.key.remoteJid.endsWith('@c.us')) continue;

      const from = msg.key.remoteJid;
      const number = normalizeNumber(from);
      const body = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.buttonsResponseMessage?.selectedButtonId
        || msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId
        || '[mensaje multimedia]';

      const name = msg.pushName || number;
      const ts = new Date().toISOString();

      log(`Mensaje de ${name} (${number}): ${body}`);

      const autoReply = getAutoReply(body);
      if (autoReply) {
        try {
          await sock.sendMessage(from, { text: autoReply });
          log(`Auto-respuesta a ${number}: ${autoReply}`);
        } catch (err) {
          log(`Error auto-respuesta: ${err.message}`);
        }
      }
    }
  });
}

// ===== START =====
const PORT = process.env.PORT || 3000;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(`Puerto ${PORT} ya en uso. Cerrando esta instancia.`);
    process.exit(0);
  } else {
    log(`Error del servidor: ${err.message}`);
    process.exit(1);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  log(`Servidor en puerto ${PORT}`);
  log('Iniciando WhatsApp...');
  startBot().catch(err => {
    log('ERROR FATAL: ' + err.message);
    process.exit(1);
  });
});

process.on('unhandledRejection', (r) => log('UNHANDLED: ' + r));
process.on('uncaughtException', (e) => { log('EXCEPTION: ' + e.message); log(e.stack); });
