const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
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
const DEPLOY_MARKER = path.join(__dirname, '.deploy.marker');
const CONVERSATIONS_PATH = path.join(__dirname, 'conversations.json');
const MY_START_TIME = Date.now();

// ===== CONVERSATION HISTORY =====
let conversations = {};

function loadConversations() {
  try { conversations = JSON.parse(fs.readFileSync(CONVERSATIONS_PATH, 'utf8')); }
  catch { conversations = {}; }
}

function saveConversations() {
  try { fs.writeFileSync(CONVERSATIONS_PATH, JSON.stringify(conversations, null, 2), 'utf8'); }
  catch (e) { log('Error guardando conversaciones: ' + e.message); }
}

function addToHistory(number, role, body) {
  if (!conversations[number]) conversations[number] = [];
  conversations[number].push({ role, body, ts: new Date().toISOString() });
  if (conversations[number].length > 50) conversations[number] = conversations[number].slice(-50);
  saveConversations();
}

function getHistory(number, lastN = 5) {
  return (conversations[number] || []).slice(-lastN);
}

loadConversations();

// ===== MISTRAL AI =====
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const MISTRAL_API_URL = 'https://api.mistral.ai/v1/chat/completions';
const BOT_KNOWLEDGE_PATH = path.join(__dirname, 'bot-knowledge.json');

let cachedKnowledge = null;
let knowledgeLastLoaded = 0;
const KNOWLEDGE_CACHE_TTL = 60000;

function loadKnowledge() {
  const now = Date.now();
  if (!cachedKnowledge || (now - knowledgeLastLoaded) > KNOWLEDGE_CACHE_TTL) {
    try {
      cachedKnowledge = JSON.parse(fs.readFileSync(BOT_KNOWLEDGE_PATH, 'utf8'));
      knowledgeLastLoaded = now;
    } catch (err) {
      console.error('Error cargando bot-knowledge.json:', err.message);
      if (!cachedKnowledge) cachedKnowledge = {};
    }
  }
  return cachedKnowledge;
}

function buildSystemPrompt() {
  const k = loadKnowledge();
  const customPrompt = k.nexus_system_prompt || `Eres "NEXUS", el asistente virtual de ventas de Agencia Nexus.
Responde en español de Colombia, con tono profesional, cercano, claro y orientado a ventas.
Tu objetivo es ayudar a prospectos y clientes a encontrar la solución digital perfecta para su negocio.`;
  const rules = `No inventes datos que no estén en la base de conocimiento.
Si falta información, invita a escribir por WhatsApp para asesoría personalizada.
Mantén respuestas breves para WhatsApp, idealmente entre 1 y 4 líneas, salvo que el usuario pida más detalle.`;

  const plans = k.catalogos_planes ? JSON.stringify(k.catalogos_planes, null, 2) : '';
  const faq = k.preguntas_frecuentes ? JSON.stringify(k.preguntas_frecuentes) : '';

  return `${customPrompt}\n\n${rules}\n\nPlanes:\n${plans}\n\nPreguntas frecuentes:\n${faq}`;
}

async function getMistralReply(message, number) {
  const history = getHistory(number, 6);
  const messages = [
    { role: 'system', content: buildSystemPrompt() }
  ];

  for (const h of history) {
    messages.push({
      role: h.role === 'user' ? 'user' : 'assistant',
      content: h.body
    });
  }

  messages.push({ role: 'user', content: message });

  try {
    const response = await axios.post(MISTRAL_API_URL, {
      model: 'mistral-tiny',
      messages,
      max_tokens: 300
    }, {
      headers: {
        'Authorization': `Bearer ${MISTRAL_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 25000
    });

    return response.data.choices[0].message.content.trim();
  } catch (err) {
    log(`Error Mistral AI: ${err.message}`);
    return null;
  }
}

// ===== LOCK FILE =====
function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const content = fs.readFileSync(LOCK_FILE, 'utf8').trim();
      const parts = content.split('|');
      const pid = parseInt(parts[0]);
      const lockTime = parseInt(parts[1]) || 0;

      if (pid === process.pid) return true;

      // Lock viejo: proceso muerto O heartbeat >60s
      const heartbeat = Date.now() - lockTime;
      if (heartbeat > 60000) {
        log(`Lock: heartbeat viejo (${Math.round(heartbeat/1000)}s). Forzando takeover.`);
        try { fs.unlinkSync(LOCK_FILE); } catch {}
      } else {
        try {
          process.kill(pid, 0);
          log(`Lock: proceso ${pid} activo (heartbeat ${Math.round(heartbeat/1000)}s). Esperando...`);
          return false;
        } catch {
          log('Lock: proceso anterior muerto. Limpiando lock.');
          try { fs.unlinkSync(LOCK_FILE); } catch {}
        }
      }
    } catch {
      try { fs.unlinkSync(LOCK_FILE); } catch {}
    }
  }
  // Escribir PID|timestamp
  fs.writeFileSync(LOCK_FILE, `${process.pid}|${Date.now()}`);
  log(`Lock: PID ${process.pid} registrado.`);
  return true;
}

function heartbeatLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const content = fs.readFileSync(LOCK_FILE, 'utf8').trim();
      const pid = parseInt(content.split('|')[0]);
      if (pid === process.pid) {
        fs.writeFileSync(LOCK_FILE, `${process.pid}|${Date.now()}`);
      }
    }
  } catch {}
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const content = fs.readFileSync(LOCK_FILE, 'utf8').trim();
      const pid = parseInt(content.split('|')[0]);
      if (pid === process.pid) fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

// Deploy marker: nueva instancia avisa a la vieja que debe apagarse
function writeDeployMarker() {
  try { fs.writeFileSync(DEPLOY_MARKER, `${process.pid}|${Date.now()}`); } catch {}
}

function checkDeployMarker() {
  try {
    if (fs.existsSync(DEPLOY_MARKER)) {
      const content = fs.readFileSync(DEPLOY_MARKER, 'utf8').trim();
      const markerTime = parseInt(content.split('|')[1]) || 0;
      if (markerTime > MY_START_TIME) {
        log('Deploy marker detectado: nueva instancia activa. Apagando...');
        return true;
      }
    }
  } catch {}
  return false;
}

function clearDeployMarker() {
  try { fs.unlinkSync(DEPLOY_MARKER); } catch {}
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

// ===== AUTO-REPLY CON CONTEXTO =====
function getAutoReply(message, number) {
  const lower = message.toLowerCase().trim();
  const history = getHistory(number, 5);
  const prevMessages = history.map(h => `${h.role}: ${h.body}`).join('\n');

  // Detectar intención del usuario
  const isGreeting = /^(hola|buenos dias|buenas tardes|buenas noches|hey|que tal|saludos|hello|hi)$/i.test(lower);
  const isFarewell = /^(adios|hasta luego|chao|nos vemos|bye|gracias|muchas gracias)$/i.test(lower);
  const isPrice = /(precio|precios|plan|planes|cuesta|costo|cuanto)/i.test(lower);
  const isService = /(servicio|servicios|hacen|que hacen|que ofrecen)/i.test(lower);
  const isWeb = /(pagina|web|sitio|landing|desarrollo)/i.test(lower);
  const isShop = /(tienda|ecommerce|vender|productos)/i.test(lower);
  const isWhatsApp = /(whatsapp|api|integracion)/i.test(lower);
  const isHosting = /(hosting|servidor|dominio)/i.test(lower);
  const isSupport = /(soporte|ayuda|problema)/i.test(lower);
  const isDemo = /(demo|muestra|ejemplo|ver)/i.test(lower);
  const isPayment = /(pago|pagar|factura|comprar)/i.test(lower);
  const isWho = /(quien eres|que eres|tu nombre)/i.test(lower);
  const isBusiness = /(negocio|empresa|emprendimiento)/i.test(lower);

  // Detectar si ya se habló de algo antes
  const talkedPrices = prevMessages.toLowerCase().includes('precio') || prevMessages.toLowerCase().includes('plan');
  const talkedServices = prevMessages.toLowerCase().includes('servicio') || prevMessages.toLowerCase().includes('ofrecemos');

  // Respuestas con contexto
  if (isGreeting) {
    if (history.length > 2) {
      return 'Hola de nuevo! En que te puedo ayudar?';
    }
    return 'Hola! Bienvenido a Agencia Nexus. Como puedo ayudarte hoy?';
  }

  if (isFarewell) {
    if (talkedPrices) return 'Gracias por tu interes! Cualquier pregunta sobre los planes, escribeme. Hasta pronto!';
    return 'Gracias por escribirnos! Estamos aqui cuando nos necesites.';
  }

  if (isPrice) {
    if (talkedPrices) {
      const lastPrice = [...history].reverse().find(h => h.body.toLowerCase().includes('plan'));
      return 'Vi que preguntaste sobre planes. Te recuerdo:\n\nEssential: $290K COP\nStart: $490K COP (popular)\nPRO: $890K COP\nEnterprise: $1.590K COP\n\nAlguno te llamo la atencion?';
    }
    return 'Tenemos diferentes planes:\n\nEssential: $290K COP\nStart: $490K COP (popular)\nPRO: $890K COP (mas vendido)\nEnterprise: $1.590K COP\n\nCual te interesa?';
  }

  if (isService) {
    if (talkedServices) return 'Ya te mencione nuestros servicios. Quieres que profundice en alguno en particular?';
    return 'Ofrecemos:\n- Paginas web profesional\n- Tiendas online\n- Integracion WhatsApp\n- SEO y marketing digital\n- Soporte 24/7\n\nQue necesitas para tu negocio?';
  }

  if (isWeb) return 'Desarrollamos paginas web profesionales, tiendas online y landing pages. Que tipo de negocio tienes?';
  if (isShop) return 'Creamos tiendas online con catalogo, carrito y pasarela de pago. El plan Start o PRO son ideales. Cuantos productos manejas?';
  if (isWhatsApp) return 'Integramos WhatsApp Business API para mensajes automaticos y ventas por chat. El plan PRO la incluye.';
  if (isHosting) return 'Todos nuestros planes incluyen hosting premium, dominio .com y SSL por 12 meses.';
  if (isSupport) return 'Nuestro soporte esta disponible 24/7 VIP. En que puedo ayudarte?';
  if (isDemo) return 'Tenemos demos en n1nexus.com. Que tipo de negocio tienes? Te muestro uno similar!';
  if (isPayment) return 'Aceptamos transferencia, PSE, tarjeta y Nequi. El pago es unico sin suscripciones.';
  if (isWho) return 'Soy NEXUS, tu asistente virtual de Agencia Nexus. Estoy aqui para ayudarte!';
  if (isBusiness) return 'Que bueno! Te puedo ayudar a llevar tu negocio al siguiente nivel con presencia digital. Que tipo es?';

  // Detectar preguntas de seguimiento
  if (/(cuanto|cuesta|vale|price|cost)/i.test(lower) && talkedPrices) {
    return 'Segun lo que vimos, el plan Start ($490K COP) es el mas popular. Incluye pagina web + tienda online + hosting. Te interesa?';
  }

  if (/(mas info|detalles|contame|cuentalo|explicame)/i.test(lower)) {
    if (talkedPrices) return 'Claro! Que plan te interesa? Te puedo dar todos los detalles.';
    if (talkedServices) return 'Cual de nuestros servicios te interesa mas? Te cuento los detalles.';
    return 'Que te gustaria saber? Puedo contarte sobre nuestros planes, servicios o hacer un demo personalizado.';
  }

  // Respuesta por defecto: preguntar qué necesita
  return 'Entiendo. Como te puedo ayudar? Puedo contarte sobre nuestros planes, servicios o hacer un demo personalizado.';
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

app.get('/api/conversations', (req, res) => {
  res.json(conversations);
});

app.get('/api/conversations/:number', (req, res) => {
  const num = normalizeNumber(req.params.number);
  res.json(conversations[num] || []);
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

  // Si hay otra instancia y no podemos tomar el lock, escribir deploy marker y esperar
  if (!acquireLock()) {
    log('Otra instancia tiene el lock. Escribiendo deploy marker...');
    writeDeployMarker();

    // Reintentar cada 5s hasta que la vieja se apague (max 30s)
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 5000));
      if (acquireLock()) {
        log('Lock adquirido despues de esperar.');
        clearDeployMarker();
        break;
      }
      log(`Esperando takeover... (${i+1}/6)`);
    }

    if (!acquireLock()) {
      log('No se pudo tomar el lock. Esta instancia se cierra.');
      status = 'error';
      io.emit('status', 'Otra instancia activa. Espera a que libere.');
      return;
    }
    clearDeployMarker();
  }

  botStarted = true;

  // Heartbeat: actualizar lock cada 15s
  const heartbeatInterval = setInterval(() => {
    heartbeatLock();
    // Tambien verificar si una instancia mas nueva nos reemplazo
    if (checkDeployMarker()) {
      log('Nueva instancia detectada. Apagando esta instancia...');
      clearInterval(heartbeatInterval);
      botStarted = false;
      if (sock) { try { sock.end(undefined); } catch {} sock = null; }
      releaseLock();
      process.exit(0);
    }
  }, 15000);

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
      clearDeployMarker();
      log('WhatsApp CONECTADO');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;

    for (const msg of m.messages) {
      if (msg.key.fromMe) continue;
      if (!msg.key.remoteJid || (!msg.key.remoteJid.endsWith('@c.us') && !msg.key.remoteJid.endsWith('@lid'))) continue;

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

      // Guardar en historial
      addToHistory(number, 'user', body);

      // Intentar Mistral AI, si falla usar keywords
      let autoReply = null;
      if (MISTRAL_API_KEY) {
        autoReply = await getMistralReply(body, number);
      }
      if (!autoReply) {
        autoReply = getAutoReply(body, number);
      }

      if (autoReply) {
        try {
          await sock.sendMessage(from, { text: autoReply });
          addToHistory(number, 'bot', autoReply);
          log(`Respuesta a ${number}: ${autoReply.substring(0, 80)}...`);
        } catch (err) {
          log(`Error respuesta: ${err.message}`);
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
