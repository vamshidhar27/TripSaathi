# Trip Saathi — whatsapp-web.js starter

This is a minimal starter project that demonstrates using whatsapp-web.js to build a WhatsApp bot.

Quick start (PowerShell):

```powershell
cd 'e:\Projects\Trip Saathi'
npm install
npm start
```

What to expect:
- On first run you'll see a QR printed to the terminal — scan it with WhatsApp on your phone.
- The session is persisted using LocalAuth (folder `wwebjs_auth`), so you won't need to scan again on the same machine/user.
- The bot replies "pong" to `!ping`, and gives a short help reply when a message contains the word "help".

Send-on-startup example (optional):
Set environment variables before running to send a message once the client is ready:

```powershell
$env:SEND_TO = '123456789'   # phone number in international format without + or separators
$env:SEND_MESSAGE = 'Hello from Trip Saathi bot'
npm start
```

Notes & cautions:
- This uses an unofficial automation approach (controls WhatsApp Web). For production or high-scale usage prefer the official WhatsApp Business API.
- Using bots may violate WhatsApp terms of service; accounts may be rate-limited or banned.
