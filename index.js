import express from 'express';
import QRCode from 'qrcode';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { GoogleGenAI } from '@google/genai';

const app = express();
const PORT = process.env.PORT || 8080;

let currentQR = '';
let isConnected = false;

// Initialize Gemini Client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Fallback Model List (resolves 404/deprecation issues)
const MODEL_FALLBACKS = [
  'gemini-3.4-flash',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-3.8-flash'
];

async function generateWithFallback(prompt) {
  for (const modelName of MODEL_FALLBACKS) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: prompt,
        config: {
          systemInstruction: "You are Phinehas, a helpful and friendly AI assistant."
        }
      });
      return response;
    } catch (error) {
      console.warn(`Model ${modelName} failed (${error.status || error.message}). Trying next fallback...`);
    }
  }
  throw new Error("All Gemini model fallbacks failed.");
}

// HTTP Server Route to View QR Code
app.get('/qr', async (req, res) => {
  if (isConnected) {
    return res.send(`
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
        <h2 style="color: #2e7d32;">✅ WhatsApp Bot is already connected and active!</h2>
      </div>
    `);
  }

  if (!currentQR) {
    return res.send(`
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
        <h3>⏳ QR Code generating... Please refresh in a few seconds.</h3>
        <script>setTimeout(() => location.reload(), 3000);</script>
      </div>
    `);
  }

  try {
    const qrImage = await QRCode.toDataURL(currentQR);
    res.send(`
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
        <h2>Scan to Link Phinehas WhatsApp Bot</h2>
        <img src="${qrImage}" style="width:300px;height:300px;border:1px solid #ccc;padding:10px;border-radius:8px;"/>
        <p>Page auto-refreshes every 15 seconds if QR code updates.</p>
        <script>setTimeout(() => location.reload(), 15000);</script>
      </div>
    `);
  } catch (err) {
    res.status(500).send('Error generating QR Code');
  }
});

// Root route for Back4App health checks
app.get('/', (req, res) => {
  res.send('Phinehas Bot status: Active');
});

// Start WhatsApp Bot
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      isConnected = false;
    }

    if (connection === 'close') {
      isConnected = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      isConnected = true;
      currentQR = '';
      console.log('🤖 AI WhatsApp Assistant is online and thinking as Phinehas!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid;
      const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;

      if (!textMessage) continue;

      console.log(`📬 Message from ${remoteJid}: ${textMessage}`);

      try {
        const response = await generateWithFallback(textMessage);
        await sock.sendMessage(remoteJid, { text: response.text });
        console.log(`📩 Sent reply to ${remoteJid}`);
      } catch (error) {
        console.error('Gemini API Error:', error);
      }
    }
  });
}

// Start HTTP Server & Bot Engine
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  startBot();
});