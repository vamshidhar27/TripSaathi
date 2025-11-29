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
  n8nWebhookUrl: process.env.N8N_WEBHOOK_URL || 'https://tripsaathi-travelassitant.app.n8n.cloud/webhook-test/send-messages',
  batchWindowMs: parseInt(process.env.BATCH_WINDOW_MS || '10000', 10),
  axiosTimeoutMs: parseInt(process.env.AXIOS_TIMEOUT_MS || '20000', 10),
  puppeteerHeadless: process.env.PUPPETEER_HEADLESS !== 'false'
};

// === Data Members (stateful runtime variables) ===
// Keep all mutable runtime data in one section for readability.
let lastGroupChatId = null;      // last active group chat ID ("...@g.us")
let messageBuffer = [];          // collected messages within the batch window
let bufferTimer = null;          // timer handle for batch window
const participantsNameCache = new Map(); // groupId -> Map(memberId -> displayName)
// Hardcoded member ID -> display name mapping (override when known)
// Fill with entries like: { '919876543210@c.us': 'Alice', '911234567890@c.us': 'Bob' }
const HARDCODED_MEMBER_NAMES = {
  '918965012692@c.us': 'TripSaathi',
  '919573838939@c.us': 'Krishna',
  '917013614596@c.us': 'Vamshidhar'
};

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

/**
 * Format a JS Date or millisecond epoch to DD-MM-YYYY.
 * @param {number|Date} dateInput
 * @returns {string}
 */
function formatDateDDMMYYYY(dateInput) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
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
    topic: null,                        // High-level trip theme (e.g., beach, culture)
    purpose: null,                      // leisure | business | family | adventure | other
    originCities: [],                   // list of departure cities for members
    candidateDestinations: [],          // destinations mentioned but not yet finalized
    destination: null,                  // chosen destination (string)
    dates: {                            // target travel dates
      start: null,
      end: null,
      flexibility: 'flexible'           // flexible | semi-flexible | fixed
    },
    durationNights: null,               // derived or explicitly set
    budgetRange: {                      // group level budget understanding
      min: null,
      max: null,
      currency: 'INR',
      perPerson: true,                  // true if min/max are per-person values
      totalEstimate: null               // optional aggregate figure
    },
    headcount: null,                    // expected number of travelers
    preferences: {                      // aggregated preference signals
      stayType: null,                   // hotel | villa | hostel | resort | homestay
      accommodationStars: null,         // desired star rating or quality band
      roomsNeeded: null,                // number of rooms needed
      roomSharingPolicy: null,          // sharing rules (e.g., double, single)
      transport: null,                  // flight | train | road | mixed
      flightCabin: null,                // economy | premium | business | first
      trainClass: null,                 // sleeper | 3AC | 2AC | CC
      pace: 'balanced',                 // relaxed | balanced | packed
      activityInterests: [],            // beaches, trekking, museums, nightlife
      foodPreferences: [],              // veg, non-veg, vegan, local cuisine
      dietaryRestrictions: [],          // lactose-free, gluten-free, etc.
      mustSee: [],                      // must-see POIs mentioned
      avoid: []                         // places/activities to avoid
    },
    consensus: {                        // decision state tracking
      status: 'unknown',                // unknown | gathering | options_proposed | voting | agreed | blocked
      blockers: [],                     // list of short blocker descriptions
      lastOptionSet: [],                // array of last proposed option summaries
      selectedOption: null              // winning option reference/string
    },
    timeline: {                         // important planning timestamps
      planningStart: Date.now(),
      bookingDeadline: null,
      departure: null,
      return: null
    },
    bookingProgress: {                  // progress markers per component
      flights: 'pending',               // pending | research | quoted | booked
      stay: 'pending',
      activities: 'pending',
      localTransport: 'pending'
    },
    notes: [],                          // free-form aggregated notes fragments
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
    homeCity: null,                     // city of departure
    budget: { amount: null, currency: 'INR', ceiling: null },
    budgetFlexibility: 'flexible',      // strict | flexible
    destinationPrefs: [],               // preferred destinations
    avoidanceList: [],                  // destinations to avoid
    dateFlexibility: 'flexible',        // fixed | flexible | semi-flexible
    availabilityWindows: [],            // [{ start, end }]
    role: 'member',                     // member | planner | decision | finance | logistics
    commitments: {                      // member commitment clarity
      canTravel: null,                  // true | false | tentative
      reason: null,                     // reason if cannot or tentative
      tentative: null                   // extra flag for tentative state
    },
    preferences: {                      // personal preferences
      food: null,
      dietaryRestrictions: [],
      allergies: [],
      activities: [],
      stayType: null,
      preferredAmenities: [],           // pool, wifi, kitchen, parking
      transportPrefs: { flightCabin: null, trainClass: null, carType: null },
      roomSharing: 'ok',                // ok | preferPrivate | no
      pace: 'balanced'                  // relaxed | balanced | busy
    },
    travelDocuments: {                  // travel documentation state
      passportExpiry: null,
      visaNeeded: null,                 // true | false | unknown
      visaStatus: null,                 // not_started | in_progress | approved | rejected
      visaNotes: null
    },
    healthNotes: [],                    // any declared health considerations
    communicationStyle: 'concise',      // concise | detailed | emoji
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
    let participants = chat.participants || [];
    // Exclude ourselves from members list
    try {
      const myId = client.info?.wid?._serialized || client.info?.wid || null;
      if (myId) {
        participants = participants.filter(p => (p.id?._serialized || p.id) !== myId && p.isMe !== true);
      }
    } catch (_) {}
    members = await Promise.all(participants.map(async (p) => {
      const memberId = p.id?._serialized || p.id;
      // Attempt to resolve contact via contact id, preferring name then pushname
      let resolvedName = null;
      // 1) Hardcoded override if available
      if (HARDCODED_MEMBER_NAMES[memberId]) {
        resolvedName = HARDCODED_MEMBER_NAMES[memberId];
      }
      try {
        if (!resolvedName) {
          resolvedName = p.id.user || null;
        }
      } catch (_) {}
      const memberFile = path.join(dir, `${memberId}.json`);
      const existing = loadJSON(memberFile, null);
      let state = existing || defaultMemberState(memberId, resolvedName);

      // Persist newly created member
      if (!existing) {
        saveJSON(memberFile, state);
      }
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
  // Ensure we send plain JSON objects (no class instances, proxies)
  const safeGroup = JSON.parse(JSON.stringify(groupState || {}));
  const safeMembers = Array.isArray(members)
    ? JSON.parse(JSON.stringify(members))
    : [];

  return {
    messages,
    group: safeGroup,
    members: safeMembers,
    meta: {
      groupName: chat.name,
      groupId: chat.id._serialized,
      timestamp: Date.now(),
      dateStr: formatDateDDMMYYYY(Date.now())
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
    const res = await axios.post(
      CONFIG.n8nWebhookUrl,
      axiosPayload,
      {
        timeout: CONFIG.axiosTimeoutMs,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    console.log('n8nResponse.data:', res.data[0]);
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
            // chatId: m.chatId,
            senderName: m.senderName
          })) };
          // Enrich with group + members state to give AI context
          if (lastGroupChatId) {
            const chat = await client.getChatById(lastGroupChatId);
            const { groupState, members, groupDir } = await loadGroupAndMembersState(chat);
            payload = buildN8nPayload(payload.messages, groupState, members, chat, groupDir);
          }

          let data = await sendToN8n(payload);
          // Normalize to JSON: if webhook returned a JSON string, parse it
          if (typeof data === 'string') {
            try {
              data = JSON.parse(data);
            } catch (e) {
              console.error('Failed to parse n8n response string as JSON:', e.message);
              data = null;
            }
          }
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
            const responseText = data.output.response;
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
