import express from 'express'
import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import fetch from 'node-fetch'
import pino from 'pino'

const app = express()
app.use(express.json())

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL
const PORT = process.env.PORT || 3000

let sock = null

// =============================================
// BAILEYS: conectar ao WhatsApp
// =============================================
async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState('auth')

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) console.log('📱 Escaneie o QR Code acima com o WhatsApp!')
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
      if (code !== DisconnectReason.loggedOut) {
        console.log('🔄 Reconectando...')
        setTimeout(conectar, 3000)
      } else {
        console.log('❌ Deslogado. Delete a pasta auth e reinicie.')
      }
    }
    if (connection === 'open') console.log('✅ WhatsApp conectado!')
  })

  // Recebe mensagens do grupo e repassa ao Apps Script
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue

      const groupId = msg.key.remoteJid
      if (!groupId?.endsWith('@g.us')) continue

      const sender = msg.key.participant || msg.key.remoteJid
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        ''

      if (!text.trim()) continue

      console.log(`📩 [${groupId}] ${sender}: ${text}`)

      try {
        await fetch(APPS_SCRIPT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sender, message: text, groupId }),
        })
      } catch (e) {
        console.error('Erro ao repassar mensagem:', e.message)
      }
    }
  })
}

// =============================================
// API: enviar mensagem (chamada pelo Apps Script)
// =============================================
app.post('/send-message', async (req, res) => {
  const { groupId, message } = req.body
  if (!sock || !groupId || !message) {
    return res.status(400).json({ erro: 'Parâmetros inválidos ou bot desconectado' })
  }
  try {
    await sock.sendMessage(groupId, { text: message })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ erro: e.message })
  }
})

// =============================================
// API: status do bot
// =============================================
app.get('/status', (_, res) => {
  res.json({
    ok: true,
    conectado: !!sock,
    timestamp: new Date().toISOString()
  })
})

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`)
  conectar()
})
