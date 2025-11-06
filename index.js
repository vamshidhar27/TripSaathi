

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
});

client.on('message', async msg => {
  console.log('Message from', msg.from, '->', msg.body);
  try {
    // Forward message to n8n webhook
    const n8nWebhookUrl = 'https://tripsaathitest.app.n8n.cloud/webhook/travel-intent'; // Set your n8n webhook URL here or via env
    const payload = {
      from: msg.from,
      body: msg.body,
      isGroupMsg: msg.from.endsWith('@g.us'),
      chatId: msg.from,
      timestamp: msg.timestamp,
      author: msg.author || null,
      senderName: msg._data?.notifyName || null
    };
    let n8nResponse;

    try {
      console.log('Sending payload to n8n:', payload);
      n8nResponse = await axios.post(n8nWebhookUrl, payload, { timeout: 15000 });
      console.log('n8nResponse.data:', n8nResponse.data);
    } catch (err) {
      console.error('Error sending to n8n webhook:', err.message);
      if (err.response) {
        console.error('n8n error response:', err.response.data);
      }
      return;
    }

    // If n8n returns a reply, send it back to the group or sender
    if (n8nResponse && n8nResponse.data && n8nResponse.data.response) {
      await randomDelay();
      await msg.reply(n8nResponse.data.response);
    }
  } catch (e) {
    console.error('Message handler error', e);
  }
});

client.initialize();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down client...');
  client.destroy();
  process.exit();
});
