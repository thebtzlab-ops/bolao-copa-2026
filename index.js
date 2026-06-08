import express from 'express'
import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import fetch from 'node-fetch'
import pino from 'pino'
import qrcode from 'qrcode-terminal'

const app = express()
app.use(express.json())

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL
const PORT = process.env.PORT || 3000

let sock = null
let qrAtual = null

async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState('auth')

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrAtual = qr
      console.log('\n📱 QR CODE GERADO — acesse /qr no navegador para escanear\n')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
      if (code !== DisconnectReason.loggedOut) {
        console.log('🔄 Reconectando...')
        setTimeout(conectar, 5000)
      } else {
        console.log('❌ Deslogado. Delete a pasta auth e reinicie o servidor.')
        qrAtual = null
      }
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp conectado com sucesso!')
      qrAtual = null
    }
  })

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

      if (!APPS_SCRIPT_URL) {
        console.log('⚠️ APPS_SCRIPT_URL não configurada')
        continue
      }

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
// ROTA: exibe QR Code no navegador
// =============================================
app.get('/qr', (req, res) => {
  if (!qrAtual) {
    return res.send(`
      <html><body style="font-family:sans-serif;padding:40px;text-align:center">
        <h2>✅ WhatsApp já está conectado!</h2>
        <p>Nenhum QR Code disponível no momento.</p>
        <a href="/status">Ver status</a>
      </body></html>
    `)
  }

  res.send(`
    <html>
    <head>
      <title>QR Code — BolãoBot</title>
      <meta http-equiv="refresh" content="30">
    </head>
    <body style="font-family:sans-serif;padding:40px;text-align:center;background:#f5f5f5">
      <h2>📱 Escaneie com o WhatsApp</h2>
      <p style="color:#666">No celular: WhatsApp → três pontinhos → Aparelhos conectados → Conectar aparelho</p>
      <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrAtual)}" 
           style="border:8px solid white;border-radius:12px;margin:20px auto;display:block" />
      <p style="color:#999;font-size:13px">Esta página atualiza automaticamente a cada 30 segundos</p>
    </body>
    </html>
  `)
})

// =============================================
// ROTA: enviar mensagem (chamada pelo Apps Script)
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
// ROTA: status do bot
// =============================================
app.get('/status', (_, res) => {
  res.json({
    ok: true,
    conectado: !!sock,
    qr_disponivel: !!qrAtual,
    timestamp: new Date().toISOString()
  })
})

app.get('/', (_, res) => {
  res.send(`
    <html><body style="font-family:sans-serif;padding:40px;text-align:center">
      <h2>🏆 BolãoBot — Copa 2026</h2>
      <p><a href="/qr">📱 Escanear QR Code</a></p>
      <p><a href="/status">📊 Ver status</a></p>
    </body></html>
  `)
})

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`)
  console.log(`🌐 Acesse /qr para escanear o QR Code`)
  conectar()
})
