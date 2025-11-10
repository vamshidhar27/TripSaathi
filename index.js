// Store the last group chatId
let lastGroupChatId = null;
// Buffer for incoming messages
let messageBuffer = [];
let bufferTimer = null;


const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');

// Helper to add a random delay (min-max ms)
function randomDelay(min = 1200, max = 3500) {
  return new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));
}

// Create client with LocalAuth to persist session (no QR each restart)
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true }
});

client.on('qr', (qr) => {
  console.log('QR RECEIVED — scan with your phone:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
  console.log('WhatsApp client is ready.');

  // try {
  //   const chats = await client.getChats();
  //   for (const chat of chats) {
  //     if (chat.isGroup && chat.name === 'Trip Planner') {
  //       const groupMeta = await client.getChatById(chat.id._serialized);
  // // Build mention list using names
  // // const mentions = groupMeta.participants.map(p => `@${p.name || p.pushname || p.id.user}`).join(', ');
  // const message = `Hi TripSaathi Vamshidhar, Namrata, Shubham and Vamsi Krishna needs your assistance in planning a trip.`;
  //       let n8nResponse;
  //       const n8nWebhookUrl = 'https://tripsaathitest.app.n8n.cloud/webhook/7c0d1a7c-2f7d-4af2-836d-535f160660d9';
  //       const payload = {
  //         messages: [{
  //           // from: chat.id._serialized,
  //           message: message,
  //           // isGroupMsg: true,
  //           // chatId: chat.id._serialized,
  //           // timestamp: Date.now(),
  //           // author: null,
  //           senderName: 'TripSaathiBot'
  //         }]
  //       };
  //       try {
  //         n8nResponse = await axios.post(n8nWebhookUrl, payload);
  //         console.log('Sent Hi TripSaathi message to n8n webhook for group:', chat.name);
  //       } catch (err) {
  //         console.error('Error sending Hi TripSaathi message to n8n:', err.message);
  //       }
  //       // If n8n returns a response, send it to WhatsApp group
  //       if (n8nResponse && n8nResponse.data && typeof n8nResponse.data.response === 'string' && n8nResponse.data.response.trim().toLowerCase() !== 'skip') {
  //         await client.sendMessage(chat.id._serialized, n8nResponse.data.response);
  //         console.log('Sent n8n response to WhatsApp group:', chat.name);
  //       }
  //     }
  //   }
  // } catch (err) {
  //   console.error('Error sending group message to n8n:', err.message);
  // }
});

client.on('message', async msg => {
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
      // Send all buffered messages to n8n as a batch
      const n8nWebhookUrl = 'https://tripsaathitest.app.n8n.cloud/webhook/7c0d1a7c-2f7d-4af2-836d-535f160660d9';
      const payload = { messages: messageBuffer.map(m => ({
        // from: m.from,
        message: m.body,
        // isGroupMsg: m.isGroupMsg,
        chatId: m.chatId,
        // timestamp: m.timestamp,
        // author: m.author,
        senderName: m.senderName
      })) };
      let n8nResponse;
      try {
        console.log('Sending batch payload to n8n:', payload);
        n8nResponse = await axios.post(n8nWebhookUrl, payload, { timeout: 20000 });
        console.log('n8nResponse.data:', n8nResponse.data);
      } catch (err) {
        console.error('Error sending batch to n8n webhook:', err.message);
        if (err.response) {
          console.error('n8n error response:', err.response.data);
        }
        messageBuffer = [];
        bufferTimer = null;
        return;
      }

      // If n8n returns a response, send it to the last known group chatId
      if (n8nResponse && n8nResponse.data && n8nResponse.data.response && lastGroupChatId) {
        if (typeof n8nResponse.data.response === 'string' && n8nResponse.data.response.trim().toLowerCase() === 'skip') {
          console.log('AI response is "skip". Not sending message to group.');
        } else {
          console.log('Sending message to group:', lastGroupChatId);
          await client.sendMessage(lastGroupChatId, n8nResponse.data.response);
        }
      }
      // Clear buffer and timer
      messageBuffer = [];
      bufferTimer = null;
    }, 10000);
  }
});

client.initialize();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down client...');
  client.destroy();
  process.exit();
});
