import express from 'express';
import QRCode from 'qrcode';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, getContentType, downloadMediaMessage } from '@whiskeysockets/baileys';
import { GoogleGenAI } from '@google/genai';

const app = express();
const PORT = process.env.PORT || 8080;

let currentQR = '';
let isConnected = false;

// Initialize Gemini Client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Persistent Chat Sessions Map (remoteJid -> Gemini Chat Object)
const activeChats = new Map();

// Model Fallback Hierarchy
const MODEL_FALLBACKS = [
  'gemini-3.0-flash',
  'gemini-3.1-flash',
  'gemini-3.2-flash',
  'gemini-3.4-flash',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-3.8-flash',
  'gemini-flash-latest'
];

const SYSTEM_INSTRUCTION = `You are Phinehas. Respond directly as yourself in a natural, casual, and friendly human tone—just like texting a close friend on WhatsApp.

IDENTITY & CORE PERSONA:
1. NEVER refer to yourself as an AI, bot, language model, or assistant.
2. Avoid generic corporate language like "How can I help you?", "As an AI...", or "Feel free to ask."
3. Keep responses concise, relaxed, and tailored for WhatsApp messaging.

RIDDLES, GAMES & TRIVIA:
4. If you ask a riddle or question and the user gives up, asks for the answer ("what could it be?", "I don't know", "tell me"), ALWAYS give the answer to THAT exact riddle immediately. Never ask "what were we talking about?" or give a new riddle before resolving the active one.

CONVERSATION & MEMORY:
5. Remember the recent messages in the conversation. Do not repeat riddles or questions you or the user recently asked.
6. Match the user's energy and language style (e.g., casual slang, Sheng, or everyday English where appropriate).`;

/**
 * Sends a message using an existing chat or handles model fallbacks
 */
// Helper delay function
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendChatMessageWithFallback(remoteJid, messageInput) {
  let existingHistory = [];

  // 1. Try sending with the active chat session
  if (activeChats.has(remoteJid)) {
    const chat = activeChats.get(remoteJid);
    try {
      const response = await chat.sendMessage({ message: messageInput });
      return response;
    } catch (error) {
      console.warn(`Chat session for ${remoteJid} failed. Migrating history to fallback model...`);
      
      // Save history before deleting failed chat instance
      try {
        existingHistory = await chat.getHistory();
      } catch (histErr) {
        existingHistory = chat._history || [];
      }
      
      activeChats.delete(remoteJid);
    }
  }

  // 2. Iterate through fallbacks if active session fails or doesn't exist
  for (const modelName of MODEL_FALLBACKS) {
    try {
      const chat = ai.chats.create({
        model: modelName,
        history: existingHistory, // Preserves conversation context across models
        config: { systemInstruction: SYSTEM_INSTRUCTION }
      });

      const response = await chat.sendMessage({ message: messageInput });
      activeChats.set(remoteJid, chat);
      return response;
    } catch (error) {
      // Handle high demand / quota rate limits (429) with a short pause before trying next
      if (error.status === 429) {
        console.warn(`Model ${modelName} rate limited (429). Waiting 2s before switching fallback...`);
        await delay(2000);
      } else {
        console.warn(`Model ${modelName} failed (${error.message}). Trying next...`);
      }
    }
  }

  throw new Error("All Gemini model fallbacks failed or rate limit exceeded.");
}

async function parseMessagePayload(rawMessage, fullMessageCtx) {
  if (!rawMessage) return { text: null, mediaPart: null };

  let msg = rawMessage;

  // 1. Safe recursive view-once unwrapping
  while (
    msg?.viewOnceMessage?.message ||
    msg?.viewOnceMessageV2?.message ||
    msg?.viewOnceMessageV2Extension?.message
  ) {
    msg =
      msg?.viewOnceMessage?.message ||
      msg?.viewOnceMessageV2?.message ||
      msg?.viewOnceMessageV2Extension?.message;
  }

  // Replace line 93 with this safer content type resolver:
const contentType = getContentType(msg) || Object.keys(msg || {}).find(k => k === 'conversation' || k.endsWith('Message'));

if (!contentType) return { text: null, mediaPart: null };

// 2. Extract text caption or message (Lines 95 - 105)
let extractedText = null;
if (contentType === 'conversation') {
  extractedText = msg.conversation;
} else if (contentType === 'extendedTextMessage') {
  extractedText = msg.extendedTextMessage?.text;
} else if (contentType === 'imageMessage') {
  extractedText = msg.imageMessage?.caption || null;
} else if (contentType === 'videoMessage') {
  extractedText = msg.videoMessage?.caption || null;
}

  // 3. Extract media buffer (for view-once or regular media)
  // 3. Extract media buffer (for view-once or regular media)
let mediaPart = null;
const isImage = contentType === 'imageMessage';
const isVideo = contentType === 'videoMessage';

if (isImage || isVideo) {
  try {
    const buffer = await downloadMediaMessage(
      { message: msg, key: fullMessageCtx.key }, // ✅ Pass unwrapped msg inside context
      'buffer',
      {},
      { logger: console }
    );

    const mimeType = isImage 
      ? (msg.imageMessage?.mimetype || 'image/jpeg') 
      : (msg.videoMessage?.mimetype || 'video/mp4');

    mediaPart = {
      inlineData: {
        data: buffer.toString('base64'),
        mimeType: mimeType
      }
    };
  } catch (err) {
    console.error('Failed to download media buffer:', err);
  }
}

return { text: extractedText, mediaPart };
  } // Closes parseMessagePayload

  // Web Route for Displaying QR Code
  app.get('/qr', async (req, res) => {
    if (isConnected) {
      return res.send(`
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;">
          <h2 style="color: #2e7d32;">✅ WhatsApp Bot is active!</h2>
        </div>
      `);
    }

    if (!currentQR) {
      return res.send(`
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;">
          <h3>⌛ QR Code generating... Refreshing...</h3>
          <script>setTimeout(() => location.reload(), 3000);</script>
        </div>
      `);
    }

    // Serve QR code image...
  });

  app.get('/', (req, res) => {
    res.send('Phinehas Bot status: Active');
  });

async function startBot() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
        console.log('Connection closed. Reconnecting:', shouldReconnect);
        if (shouldReconnect) startBot();
      } else if (connection === 'open') {
        console.log('✅ Connected to WhatsApp successfully!');
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;

        const remoteJid = msg.key.remoteJid;
        const { text, mediaPart } = await parseMessagePayload(msg.message, msg);

        if (!text && !mediaPart) continue;

        let messageInput;
        if (mediaPart && text) {
          messageInput = [mediaPart, text];
        } else if (mediaPart) {
          messageInput = [mediaPart, "Describe what you see in this image in detail and respond naturally."];
        } else {
          messageInput = text;
        }

        try {
          const response = await sendChatMessageWithFallback(remoteJid, messageInput);
          await sock.sendMessage(remoteJid, { text: response.text });
          console.log(`📬 Sent reply to ${remoteJid}`);
        } catch (error) {
          console.error('Gemini API Error:', error);
        }
      }
    });

  } catch (err) {
    console.error('Bot startup error:', err);
  }
}

app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  startBot();
});