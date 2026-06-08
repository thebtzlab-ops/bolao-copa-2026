import express from 'express'
import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import fetch from 'node-fetch'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import fs from 'fs'
import path from 'path'

const app = express()
app.use(express.json())

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL
const PORT = process.env.PORT || 3000
const AUTH_DIR = './auth'

let sock = null
let qrAtual = null
let tentativas = 0

// =============================================
// Limpa a pasta auth (sessão corrompida)
// =============================================
function limparAuth() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true })
      console.log('🗑️ Sessão antiga removida.')
    }
    fs.mkdirSync(AUTH_DIR)
  } catch (e) {
    console.log('Aviso ao limpar auth:', e.message)
  }
}

// =============================================
// BAILEYS: conectar ao WhatsApp
// =============================================
async function conectar(limpar = false) {
  if (limpar) limparAuth()

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrAtual = qr
      tentativas = 0
      console.log('\n📱 QR CODE GERADO!\n')
      console.log('👉 Acesse no navegador: /qr\n')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'close') {
      const err = new Boom(lastDisconnect?.error)
      const code = err?.output?.statusCode
      console.log(`❌ Conexão fechada. Código: ${code}`)

      if (code === DisconnectReason.loggedOut) {
        console.log('🚪 Deslogado. Limpando sessão e reiniciando...')
        setTimeout(() => conectar(true), 3000)
        return
      }

      tentativas++
      if (tentativas >= 5) {
        console.log('⚠️ Muitas tentativas falhas. Limpando sessão...')
        tentativas = 0
        setTimeout(() => conectar(true), 3000)
        return
      }

      console.log(`🔄 Reconectando (tentativa ${tentativas}/5)...`)
      setTimeout(() => conectar(false), 5000)
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp conectado com sucesso!')
      qrAtual = null
      tentativas = 0
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
        msg.message.extendedTextMessage?.text || ''

      if (!text.trim()) continue
      console.log(`📩 Grupo: ${groupId} | De: ${sender} | Msg: ${text}`)

      if (!APPS_SCRIPT_URL) continue
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
// ROTA: página inicial
// =============================================
app.get('/', (_, res) => {
  res.send(`
    <html><body style="font-family:sans-serif;padding:40px;text-align:center;background:#f9f9f9">
      <h2>🏆 BolãoBot — Copa 2026</h2>
      <p><a href="/qr" style="font-size:18px">📱 Escanear QR Code</a></p>
      <p><a href="/status" style="font-size:18px">📊 Ver status</a></p>
      <p><a href="/resetar" style="font-size:18px;color:red">🗑️ Resetar sessão</a></p>
    </body></html>
  `)
})

// =============================================
// ROTA: exibe QR Code no navegador
// =============================================
app.get('/qr', (_, res) => {
  if (!qrAtual) {
    return res.send(`
      <html><body style="font-family:sans-serif;padding:40px;text-align:center">
        <h2>⏳ Aguardando QR Code...</h2>
        <p>O servidor ainda está iniciando ou o WhatsApp já está conectado.</p>
        <p><a href="/status">Ver status</a> | <a href="/resetar">Resetar sessão</a></p>
        <script>setTimeout(()=>location.reload(), 5000)</script>
      </body></html>
    `)
  }

  res.send(`
    <html>
    <head>
      <title>QR Code — BolãoBot</title>
      <meta http-equiv="refresh" content="25">
    </head>
    <body style="font-family:sans-serif;padding:40px;text-align:center;background:#f5f5f5">
      <h2>📱 Escaneie com o WhatsApp</h2>
      <p style="color:#555">No celular: <b>WhatsApp → três pontinhos → Aparelhos conectados → Conectar aparelho</b></p>
      <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrAtual)}"
           style="border:8px solid white;border-radius:12px;margin:20px auto;display:block" />
      <p style="color:#999;font-size:13px">Página atualiza automaticamente a cada 25 segundos</p>
      <p><a href="/resetar" style="color:red;font-size:13px">Resetar sessão</a></p>
    </body>
    </html>
  `)
})

// =============================================
// ROTA: resetar sessão manualmente
// =============================================
app.get('/resetar', (_, res) => {
  console.log('🔁 Reset manual solicitado via navegador.')
  if (sock) {
    try { sock.end() } catch (e) {}
  }
  setTimeout(() => conectar(true), 1000)
  res.send(`
    <html><body style="font-family:sans-serif;padding:40px;text-align:center">
      <h2>🗑️ Sessão resetada!</h2>
      <p>Aguarde 10 segundos e acesse <a href="/qr">/qr</a> para escanear o novo QR Code.</p>
      <script>setTimeout(()=>window.location='/qr', 10000)</script>
    </body></html>
  `)
})

// =============================================
// ROTA: status
// =============================================
app.get('/status', (_, res) => {
  res.json({
    ok: true,
    conectado: sock?.user ? true : false,
    numero: sock?.user?.id || null,
    qr_disponivel: !!qrAtual,
    tentativas,
    timestamp: new Date().toISOString()
  })
})

// =============================================
// ROTA: enviar mensagem (Apps Script)
// =============================================
app.post('/send-message', async (req, res) => {
  const { groupId, message } = req.body
  if (!sock || !groupId || !message) {
    return res.status(400).json({ erro: 'Bot desconectado ou parâmetros inválidos' })
  }
  try {
    await sock.sendMessage(groupId, { text: message })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ erro: e.message })
  }
})

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`)
  console.log(`🌐 Acesse /qr para escanear o QR Code`)
  conectar(true) // inicia sempre limpando a sessão antiga
})
