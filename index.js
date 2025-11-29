/**
 * TripSaathi: WhatsApp group AI travel agent
 * High-level responsibilities:
 * - Listen to group chat messages
 * - Batch messages over a 10s window to avoid spam
 * - Send the batch + state (group + members) to n8n webhook
 * - Receive an AI response and optional updated JSON states
 * - Persist updates and post a single reply to the group (unless 'skip')
 * - (Optional) Admin commands can be added, but are removed per request
 */

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// === Configuration ===
// Centralize runtime configuration and allow overrides via environment.
const CONFIG = {
  n8nWebhookUrl: process.env.N8N_WEBHOOK_URL || 'https://tripsaathitest.app.n8n.cloud/webhook/7c0d1a7c-2f7d-4af2-836d-535f160660d9',
  batchWindowMs: parseInt(process.env.BATCH_WINDOW_MS || '10000', 10),
  axiosTimeoutMs: parseInt(process.env.AXIOS_TIMEOUT_MS || '20000', 10),
  puppeteerHeadless: process.env.PUPPETEER_HEADLESS !== 'false'
};

// === Data Members (stateful runtime variables) ===
// Keep all mutable runtime data in one section for readability.
let lastGroupChatId = null;      // last active group chat ID ("...@g.us")
let messageBuffer = [];          // collected messages within the batch window
let bufferTimer = null;          // timer handle for batch window

// Helper to add a random delay (min-max ms)
/**
 * Optional human-like delay before sending messages.
 * @param {number} [min=1200] - Minimum ms.
 * @param {number} [max=3500] - Maximum ms.
 * @returns {Promise<void>} resolves after delay
 */
function randomDelay(min = 1200, max = 3500) {
  return new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));
}

// === Client Initialization ===
// Create WhatsApp client with LocalAuth to persist session (no QR each restart).
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
   headless: true,
   args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--no-zygote',
      '--single-process'
    ]
  }
});

// === Event Handlers ===
// QR Code event: emitted when a new session needs authentication.
client.on('qr', (qr) => {
  console.log('QR RECEIVED — scan with your phone:');
  qrcode.generate(qr, { small: true });
});

// Ready event: fired once the client has initialized and is connected.
client.on('ready', async () => {
  console.log('WhatsApp client is ready.');
});

// === Simple state management (per-group and per-member JSONs) ===
const DATA_DIR = path.join(__dirname, 'data');
const GROUPS_DIR = path.join(DATA_DIR, 'groups');

/** Ensure required data directories exist. */
function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  if (!fs.existsSync(GROUPS_DIR)) fs.mkdirSync(GROUPS_DIR);
}

/**
 * Get or create the directory for a group.
 * @param {string} groupId - WhatsApp group id (serialized).
 * @returns {string} absolute path to the group's directory
 */
function getGroupDir(groupId) {
  ensureDirs();
  const dir = path.join(GROUPS_DIR, groupId.replace(/[^a-zA-Z0-9_.-]/g, '_'));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  return dir;
}

/**
 * Load a JSON file safely.
 * @param {string} filePath
 * @param {*} defaultValue - returned if file missing or parse fails
 * @returns {*}
 */
function loadJSON(filePath, defaultValue) {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('Failed to load JSON', filePath, e.message);
  }
  return defaultValue;
}

/**
 * Save a JSON file safely.
 * @param {string} filePath
 * @param {*} obj
 * @returns {boolean}
 */
function saveJSON(filePath, obj) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('Failed to save JSON', filePath, e.message);
    return false;
  }
}

// Default schemas
/**
 * Default group state schema.
 * @returns {object}
 */
function defaultGroupState() {
  return {
    topic: null,
    destination: null,
    dates: { start: null, end: null },
    budgetRange: { min: null, max: null, currency: 'INR' },
    headcount: null,
    preferences: { stayType: null, transport: null, pace: 'balanced' },
    consensus: { status: 'unknown', blockers: [] },
    adminControls: { locked: false, quietHours: null },
    lastUpdated: Date.now()
  };
}

/**
 * Default member state schema.
 * @param {string} memberId
 * @param {string} [memberName]
 * @returns {object}
 */
function defaultMemberState(memberId, memberName) {
  return {
    id: memberId,
    name: memberName || null,
    budget: { amount: null, currency: 'INR' },
    destinationPrefs: [],
    dateFlexibility: 'flexible',
    role: 'member',
    commitments: { canTravel: null, notes: null },
    preferences: { food: null, activities: [], stayType: null },
    lastUpdated: Date.now()
  };
}

/**
 * Load group and member state for a chat, creating defaults if missing.
 * @param {import('whatsapp-web.js').Chat} chat
 * @returns {Promise<{groupState: object, members: object[], groupDir: string}>}
 */
async function loadGroupAndMembersState(chat) {
  const groupId = chat.id._serialized;
  const dir = getGroupDir(groupId);
  const groupFile = path.join(dir, 'group.json');
  let groupState = loadJSON(groupFile, defaultGroupState());

  let members = [];
  try {
    const participants = chat.participants || [];
    members = await Promise.all(participants.map(async (p) => {
      const memberId = p.id?._serialized || p.id?.user || 'unknown';
      const name = p.name || p.pushname || p.formattedName || p.id?.user || null;
      const memberFile = path.join(dir, `${memberId}.json`);
      const existing = loadJSON(memberFile, null);
      const state = existing || defaultMemberState(memberId, name);
      // Ensure we persist if newly created
      if (!existing) saveJSON(memberFile, state);
      return state;
    }));
  } catch (e) {
    console.error('Failed loading members state', e.message);
  }

  // Ensure group persisted
  saveJSON(groupFile, groupState);
  return { groupState, members, groupDir: dir };
}

/**
 * Persist updated group/member states returned from n8n.
 * @param {string} groupDir
 * @param {{group?: object, members?: object[]}} updated
 */
function persistUpdatedStates(groupDir, updated) {
  if (!updated) return;
  if (updated.group) {
    const groupFile = path.join(groupDir, 'group.json');
    saveJSON(groupFile, updated.group);
  }
  if (Array.isArray(updated.members)) {
    updated.members.forEach(m => {
      if (!m || !m.id) return;
      const memberFile = path.join(groupDir, `${m.id}.json`);
      saveJSON(memberFile, m);
    });
  }
}

// === AI Orchestration ===
/**
 * Build the payload for n8n webhook.
 * @param {Array<{body:string,chatId:string,senderName:string}>} messages
 * @param {object} groupState
 * @param {Array<object>} members
 * @param {import('whatsapp-web.js').Chat} chat
 * @param {string} groupDir
 * @returns {object} payload with metadata and instructions
 */
function buildN8nPayload(messages, groupState, members, chat, groupDir) {
  return {
    messages,
    group: groupState,
    members,
    meta: {
      groupName: chat.name,
      groupId: chat.id._serialized,
      timestamp: Date.now()
    },
    instructions: {
      system: 'You are TripSaathi, an AI travel agent embedded into a WhatsApp group. Detect travel intent, reduce friction, coordinate consensus, and when appropriate, guide planning, quotes, and booking steps inline. Be concise and avoid spamming; reply at most once per batch and use actionable next steps. If no travel intent, respond with "skip".',
      style: 'Clear bullets, short actionable steps, ask for missing info, propose consensus options, and confirm before committing to bookings.'
    },
    _groupDir: groupDir // internal only; stripped before sending
  };
}

/**
 * Send payload to n8n and return response data.
 * @param {object} payload
 * @returns {Promise<object|null>} response data or null on error
 */
async function sendToN8n(payload) {
  const axiosPayload = { ...payload };
  delete axiosPayload._groupDir;
  try {
    console.log('Sending batch payload to n8n:', axiosPayload);
    const res = await axios.post(CONFIG.n8nWebhookUrl, axiosPayload, { timeout: CONFIG.axiosTimeoutMs });
    console.log('n8nResponse.data:', res.data);
    return res.data;
  } catch (err) {
    console.error('Error sending batch to n8n webhook:', err.message);
    if (err.response) {
      console.error('n8n error response:', err.response.data);
    }
    return null;
  }
}


// Message event: handles incoming messages and batching logic.
client.on('message', async msg => {
  try {
    console.log('Message from', msg.from, '->', msg.body);
    // Buffer the message
    const isGroupMsg = msg.from.endsWith('@g.us');
    if (isGroupMsg) {
      lastGroupChatId = msg.from;
    }
    messageBuffer.push({
      from: msg.from,
      body: msg.body,
      isGroupMsg,
      chatId: msg.from,
      timestamp: msg.timestamp,
      author: msg.author || null,
      senderName: msg._data?.notifyName || null,
      msgObj: msg // keep reference for reply
    });

    // Start timer if not already started
    if (!bufferTimer) {
      bufferTimer = setTimeout(async () => {
        try {
          // Build base messages for payload
          let payload = { messages: messageBuffer.map(m => ({
            message: m.body,
            chatId: m.chatId,
            senderName: m.senderName
          })) };
          // Enrich with group + members state to give AI context
          if (lastGroupChatId) {
            const chat = await client.getChatById(lastGroupChatId);
            const { groupState, members, groupDir } = await loadGroupAndMembersState(chat);
            payload = buildN8nPayload(payload.messages, groupState, members, chat, groupDir);
          }

          const data = await sendToN8n(payload);
          if (!data) {
            console.warn('No data from n8n; skipping send.');
            return;
          }
          // Persist any updated JSON states
          try {
            if (payload._groupDir) {
              persistUpdatedStates(payload._groupDir, data.updated);
            }
          } catch (e) {
            console.error('Failed to persist updated states', e.message);
          }
          // Post response to group unless 'skip'
          if (lastGroupChatId) {
            const responseText = data.response;
            if (typeof responseText === 'string' && responseText.trim().toLowerCase() === 'skip') {
              console.log('AI response is "skip". Not sending message to group.');
            } else if (typeof responseText === 'string' && responseText.trim().length > 0) {
              console.log('Sending message to group:', lastGroupChatId);
              await client.sendMessage(lastGroupChatId, responseText);
            }
          }
        } finally {
          // Clear buffer and timer regardless of outcome
          messageBuffer = [];
          bufferTimer = null;
        }
      }, CONFIG.batchWindowMs);
    }
  } catch (e) {
    console.error('Error handling incoming message', e.message);
  }
});

client.initialize();

// === Shutdown Handling ===
// Graceful shutdown on Ctrl+C (SIGINT).
process.on('SIGINT', () => {
  console.log('Shutting down client...');
  client.destroy();
  process.exit();
});
