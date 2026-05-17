import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { and, eq, gte, sql } from "drizzle-orm";
import * as Sentry from "@sentry/node";
import { config } from "../config";
import { logger } from "../logger";
import { handleInboundMessage } from "../ai/orchestrator";
import { captureError } from "../monitoring/sentry";
import {
  deleteKnowledgeByTitle,
  listKnowledge,
  upsertKnowledge,
} from "../rag/knowledge-base";
import { upcomingAppointments, clearBusinessCache } from "../services/appointments";
import type { WhatsAppTransport } from "../types";
import { WindowGuard } from "../utils/window-guard";
import { db } from "../db/client";
import {
  analyticsEvents,
  appointments,
  businesses,
  customers,
} from "../db/schema";

export function createApp(transport: WhatsAppTransport) {
  const app = new Hono();
  const testChatGuard = new WindowGuard(30, 60_000);
  const adminRateGuard = new WindowGuard(100, 60_000); // 100 admin requests per minute

  // ── Security headers on every response ────────────────────────────────────
  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("X-XSS-Protection", "0");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    await next();
  });

  // ── Sentry request handler (tracing) ──────────────────────────────────────
  if (config.SENTRY_DSN) {
    app.use("*", async (c, next) => {
      const req = c.req.raw;
      return Sentry.withIsolationScope(async (scope) => {
        scope.setSDKProcessingMetadata({
          request: req,
        });
        await next();
      });
    });
  }

  // ── Request logging middleware ─────────────────────────────────────────────
  app.use("*", async (c, next) => {
    const start = Date.now();
    const method = c.req.method;
    const path = c.req.path;
    await next();
    const ms = Date.now() - start;
    const status = c.res.status;
    if (status >= 500) {
      logger.error({ method, path, status, ms }, "http request");
    } else if (status >= 400) {
      logger.warn({ method, path, status, ms }, "http request");
    } else {
      logger.debug({ method, path, status, ms }, "http request");
    }
  });

  // Restrict CORS to known origins — wildcard * allows any site to call admin APIs
  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (!origin) return null; // same-origin requests have no Origin header
        if (isAllowedOrigin(origin)) return origin;
        return null; // reject unknown origins
      },
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["content-type", "x-admin-key"],
    }),
  );

  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof z.ZodError)
      return c.json(
        { ok: false, error: "validation_error", issues: error.issues },
        400,
      );
    logger.error({ err: error }, "unhandled http error");
    captureError(error, {
      method: c.req.method,
      path: c.req.path,
    });
    return c.json({ ok: false, error: "internal_error" }, 500);
  });

  // ── Landing page ──────────────────────────────────────────────────────────
  app.get("/", (c) => c.html(landingPageHtml()));

  // ── Health & readiness ────────────────────────────────────────────────────
  app.get("/health", async (c) => {
    let dbOk = false;
    try {
      await db.run(sql`SELECT 1`);
      dbOk = true;
    } catch {
      dbOk = false;
    }
    const whatsappOk = !config.WHATSAPP_ENABLED || transport.isReady();
    return c.json({
      ok: dbOk && whatsappOk,
      service: "whatsapp-ai-chatbot",
      whatsappEnabled: config.WHATSAPP_ENABLED,
      whatsappReady: transport.isReady(),
      database: dbOk ? "connected" : "disconnected",
      timezone: config.DEFAULT_TIMEZONE,
      uptime: process.uptime(),
      nodeVersion: process.version,
    });
  });

  app.get("/ready", (c) => {
    const ready = !config.WHATSAPP_ENABLED || transport.isReady();
    const whatsappReady = transport.isReady();
    return c.json(
      {
        ok: ready,
        whatsappEnabled: config.WHATSAPP_ENABLED,
        whatsappReady,
      },
      ready ? 200 : 503,
    );
  });

  // ── MegiBot-style AI chatbot widget ────────────────────────────────────────────────────────
  // ── MegiBot-style AI chatbot widget ────────────────────────────────────────────────────────
  app.get("/chat/test", (c) =>
    c.html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Demo Clinic AI Chat</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{
      --bg:#06060e;--surface:rgba(255,255,255,.04);--surface2:rgba(255,255,255,.07);
      --surface3:rgba(255,255,255,.1);--border:rgba(255,255,255,.08);
      --indigo:#6366f1;--purple:#8b5cf6;--blue:#3b82f6;
      --green:#22c55e;--yellow:#f59e0b;--red:#ef4444;
      --text:#e2e8f0;--muted:#94a3b8;
      --font:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    }
    html{height:100%}
    body{font-family:var(--font);background:var(--bg);min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px;gap:0;overflow:hidden}

    body::before{content:'';position:fixed;inset:0;
      background:radial-gradient(ellipse 800px 600px at 30% 20%,rgba(99,102,241,.1),transparent),
                 radial-gradient(ellipse 600px 400px at 70% 80%,rgba(139,92,246,.08),transparent);
      animation:bgShift 20s ease-in-out infinite alternate;pointer-events:none;z-index:0}
    @keyframes bgShift{0%{transform:scale(1) rotate(0)}100%{transform:scale(1.1) rotate(3deg)}}

    .orb{position:fixed;border-radius:50%;filter:blur(60px);opacity:.2;pointer-events:none;z-index:0}
    .orb-1{width:300px;height:300px;background:var(--indigo);top:-80px;left:-80px;animation:orbFloat1 15s ease-in-out infinite}
    .orb-2{width:250px;height:250px;background:var(--purple);bottom:-60px;right:-60px;animation:orbFloat2 18s ease-in-out infinite}
    @keyframes orbFloat1{0%,100%{transform:translate(0,0)}50%{transform:translate(30px,40px)}}
    @keyframes orbFloat2{0%,100%{transform:translate(0,0)}50%{transform:translate(-40px,-30px)}}

    .widget{width:100%;max-width:420px;height:min(680px,92dvh);
      background:rgba(18,18,36,.7);backdrop-filter:blur(30px) saturate(1.3);-webkit-backdrop-filter:blur(30px) saturate(1.3);
      border-radius:24px;display:flex;flex-direction:column;
      box-shadow:0 40px 100px rgba(0,0,0,.6),0 0 0 1px rgba(99,102,241,.12),inset 0 1px 0 rgba(255,255,255,.05);
      overflow:hidden;position:relative;z-index:1;
      animation:widgetIn .6s cubic-bezier(.34,1.56,.64,1) both}
    @keyframes widgetIn{from{opacity:0;transform:translateY(30px) scale(.95)}to{opacity:1;transform:translateY(0) scale(1)}}

    .hdr{background:linear-gradient(160deg,rgba(46,42,85,.8),rgba(30,27,64,.9));
      padding:16px 18px;display:flex;align-items:center;gap:14px;flex-shrink:0;
      border-bottom:1px solid rgba(255,255,255,.06);position:relative;overflow:hidden}
    .hdr::before{content:'';position:absolute;top:-50px;right:-50px;width:140px;height:140px;border-radius:50%;
      background:radial-gradient(circle,rgba(99,102,241,.15),transparent 70%);pointer-events:none}
    .hdr-avatar{width:48px;height:48px;border-radius:14px;
      background:linear-gradient(135deg,#8b5cf6,#6366f1,#3b82f6);
      display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0;
      box-shadow:0 6px 20px rgba(99,102,241,.4);position:relative;z-index:1;
      animation:avatarPulse 3s ease-in-out infinite}
    @keyframes avatarPulse{0%,100%{box-shadow:0 6px 20px rgba(99,102,241,.4)}50%{box-shadow:0 6px 30px rgba(99,102,241,.6)}}
    .hdr-info{flex:1;min-width:0;position:relative;z-index:1}
    .hdr-name{color:#fff;font-size:16px;font-weight:800;letter-spacing:-.01em}
    .hdr-status{display:flex;align-items:center;gap:6px;margin-top:3px}
    .hdr-dot{width:8px;height:8px;border-radius:50%;background:var(--green);
      box-shadow:0 0 8px var(--green);animation:dotPulse 2.5s ease-in-out infinite}
    @keyframes dotPulse{0%,100%{box-shadow:0 0 0 0 rgba(34,197,94,.5)}60%{box-shadow:0 0 0 6px rgba(34,197,94,0)}}
    .hdr-txt{font-size:12px;color:var(--green);font-weight:600}
    .hdr-btns{display:flex;gap:6px;position:relative;z-index:1}
    .hdr-btn{width:34px;height:34px;border:none;border-radius:10px;background:rgba(255,255,255,.06);
      color:rgba(255,255,255,.5);cursor:pointer;display:flex;align-items:center;justify-content:center;
      font-size:14px;text-decoration:none;transition:all .2s;line-height:1}
    .hdr-btn:hover{background:rgba(255,255,255,.14);color:#fff;transform:scale(1.08)}

    #chat{flex:1;overflow-y:auto;padding:16px 16px 8px;display:flex;flex-direction:column;gap:4px;
      scrollbar-width:thin;scrollbar-color:rgba(99,102,241,.2) transparent}
    #chat::-webkit-scrollbar{width:4px}
    #chat::-webkit-scrollbar-thumb{background:rgba(99,102,241,.25);border-radius:2px}
    .row{display:flex;flex-direction:column;margin-bottom:4px;animation:msgIn .35s cubic-bezier(.34,1.56,.64,1) both}
    @keyframes msgIn{from{opacity:0;transform:translateY(12px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}
    .row.user{align-items:flex-end}.row.bot{align-items:flex-start}
    .bubble{max-width:82%;padding:12px 16px;font-size:14px;line-height:1.6;word-break:break-word}
    .bubble.bot{background:rgba(37,42,66,.8);color:var(--text);border-radius:6px 20px 20px 20px;
      border:1px solid rgba(255,255,255,.05)}
    .bubble.user{background:linear-gradient(135deg,#6366f1,#7c3aed);color:#fff;border-radius:20px 6px 20px 20px;
      box-shadow:0 4px 16px rgba(99,102,241,.3)}
    .bubble.sys{background:rgba(255,255,255,.04);color:rgba(255,255,255,.35);font-size:11px;
      border-radius:10px;text-align:center;max-width:100%;padding:6px 12px}
    .msg-time{font-size:10px;color:rgba(255,255,255,.2);margin-top:4px;padding:0 4px}

    .book-card{max-width:82%;border:1px solid rgba(34,197,94,.2);border-radius:16px;overflow:hidden;
      background:rgba(34,197,94,.05);animation:msgIn .35s cubic-bezier(.34,1.56,.64,1) both}
    .book-card-hd{background:rgba(34,197,94,.12);padding:8px 16px;font-size:11px;font-weight:800;
      color:#4ade80;letter-spacing:.06em}
    .book-card-bd{padding:12px 16px;font-size:13.5px;color:var(--text);line-height:1.5}
    .book-card-id{padding:0 16px 10px;font-size:10px;color:rgba(255,255,255,.2)}

    .typing-row{display:flex;margin-bottom:4px;animation:msgIn .3s ease both}
    .typing-bbl{background:rgba(37,42,66,.8);border-radius:6px 20px 20px 20px;padding:14px 18px;
      display:inline-flex;gap:6px;align-items:center;border:1px solid rgba(255,255,255,.05)}
    .tdot{width:7px;height:7px;background:var(--indigo);border-radius:50%;animation:tbounce 1.2s ease-in-out infinite both}
    .tdot:nth-child(2){animation-delay:.2s}.tdot:nth-child(3){animation-delay:.4s}
    @keyframes tbounce{0%,60%,100%{transform:translateY(0);opacity:.3}30%{transform:translateY(-8px);opacity:1}}

    .handoff-banner{border:1px solid rgba(251,191,36,.25);background:rgba(251,191,36,.06);color:#fbbf24;
      border-radius:12px;padding:8px 14px;font-size:12px;text-align:center;animation:msgIn .3s ease both}

    .day-sep{text-align:center;padding:10px 0}
    .day-sep span{font-size:11px;color:rgba(255,255,255,.18);background:rgba(255,255,255,.04);padding:4px 14px;border-radius:20px}

    #suggestions{display:none;flex-wrap:wrap;gap:8px;padding:12px 16px;flex-shrink:0}
    .chip{border:1px solid rgba(99,102,241,.25);background:rgba(99,102,241,.06);color:#a5b4fc;
      border-radius:22px;padding:7px 16px;font-size:12.5px;cursor:pointer;font-family:inherit;
      transition:all .2s;line-height:1.3}
    .chip:hover{background:rgba(99,102,241,.18);border-color:var(--indigo);color:#fff;transform:translateY(-1px)}

    .ibar{padding:12px 16px 16px;flex-shrink:0}
    .input-wrap{display:flex;align-items:center;background:rgba(37,42,66,.6);border-radius:28px;
      border:1.5px solid rgba(99,102,241,.12);padding:6px 6px 6px 18px;gap:8px;
      transition:border-color .25s,box-shadow .25s}
    .input-wrap:focus-within{border-color:rgba(99,102,241,.45);box-shadow:0 0 0 4px rgba(99,102,241,.08)}
    #msg{flex:1;background:transparent;border:none;color:var(--text);font:inherit;font-size:14px;
      outline:none;resize:none;max-height:100px;line-height:1.5;padding:6px 0}
    #msg::placeholder{color:rgba(255,255,255,.22)}
    .send-btn{width:42px;height:42px;border-radius:50%;
      background:linear-gradient(135deg,#6366f1,#8b5cf6);border:none;cursor:pointer;
      display:flex;align-items:center;justify-content:center;flex-shrink:0;
      box-shadow:0 4px 16px rgba(99,102,241,.4);transition:all .2s cubic-bezier(.34,1.56,.64,1)}
    .send-btn:hover:not(:disabled){transform:scale(1.1);box-shadow:0 6px 24px rgba(99,102,241,.55)}
    .send-btn:active:not(:disabled){transform:scale(.95)}
    .send-btn:disabled{opacity:.35;cursor:not-allowed;transform:none}
    .send-btn svg{width:18px;height:18px;fill:#fff}

    .sbar{display:flex;gap:10px;align-items:center;justify-content:center;padding:12px 0 8px;flex-wrap:wrap;position:relative;z-index:1}
    .sbar label{font-size:12px;color:rgba(255,255,255,.25);font-weight:600}
    .sbar input{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:10px;
      padding:6px 12px;color:rgba(255,255,255,.55);font:inherit;font-size:12px;width:140px;outline:none;transition:border-color .2s}
    .sbar input:focus{border-color:rgba(99,102,241,.4)}
    .sbtn{background:rgba(99,102,241,.1);border:1px solid rgba(99,102,241,.2);color:#a5b4fc;border-radius:10px;
      padding:6px 12px;font:inherit;font-size:12px;cursor:pointer;transition:all .2s}
    .sbtn:hover{background:rgba(99,102,241,.2);color:#fff}
    .bnav{display:flex;gap:20px;justify-content:center;padding:6px 0 14px;position:relative;z-index:1}
    .bnav a{color:rgba(255,255,255,.18);font-size:12px;text-decoration:none;font-weight:600;transition:color .2s}
    .bnav a:hover{color:rgba(255,255,255,.5)}

    @media(max-width:460px){
      body{padding:0;justify-content:flex-start;background:var(--bg)}
      .widget{max-width:100%;border-radius:0;height:100dvh}
      .sbar,.bnav{display:none}
    }
  </style>
</head>
<body>
  <div class="orb orb-1"></div>
  <div class="orb orb-2"></div>

  <div class="widget">
    <div class="hdr">
      <div class="hdr-avatar">🏥</div>
      <div class="hdr-info">
        <div class="hdr-name">Demo Clinic AI</div>
        <div class="hdr-status"><span class="hdr-dot" id="sDot"></span><span class="hdr-txt" id="statusTxt">Connecting...</span></div>
      </div>
      <div class="hdr-btns">
        <button class="hdr-btn" onclick="newUser()" title="New conversation">🔄</button>
        <button class="hdr-btn" onclick="clearChat()" title="Clear">&#128465;</button>
        <a class="hdr-btn" href="/admin" title="Admin">⚙</a>
      </div>
    </div>
    <div id="chat"></div>
    <div id="suggestions"></div>
    <div class="ibar">
      <div class="input-wrap">
        <textarea id="msg" rows="1" placeholder="Ask me anything..." onkeydown="handleKey(event)" oninput="grow(this)"></textarea>
        <button class="send-btn" id="sendBtn" onclick="send()" title="Send">
          <svg viewBox="0 0 24 24"><path d="M2 21L23 12 2 3v7l15 2-15 2v7z"/></svg>
        </button>
      </div>
    </div>
  </div>
  <div class="sbar">
    <label>Phone</label><input id="fromIn" value="923001234573" />
    <label>Name</label><input id="nameIn" value="Test User" style="width:100px" />
    <button class="sbtn" onclick="newUser()">+ New User</button>
    <button class="sbtn" onclick="clearChat()">Clear</button>
  </div>
  <div class="bnav">
    <a href="/">🏠 Home</a>
    <a href="/admin">⚙️ Admin</a>
    <a href="/health">❤️ Status</a>
  </div>
<script>
(function(){
  var from=document.getElementById('fromIn').value;
  var name=document.getElementById('nameIn').value;
  var isSending=false;
  var abortCtrl=null;
  var STORAGE_KEY='chatHistory_v3';
  var lastSendTime=0;
  var MIN_SEND_GAP=600;

  function now(){return new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});}
  function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\\n/g,'<br>');}
  window.grow=function(el){el.style.height='auto';el.style.height=Math.min(el.scrollHeight,130)+'px';};
  function grow(el){window.grow(el);}
  window.handleKey=function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();if(window.send)window.send();}};
  function handleKey(e){window.handleKey(e);}
  function scrollDown(){var c=document.getElementById('chat');if(c)c.scrollTop=c.scrollHeight;}

  function pollHealth(){
    fetch('/health').then(function(r){return r.json();}).then(function(d){
      var txt=document.getElementById('statusTxt');
      var dot=document.getElementById('sDot');
      if(!txt||!dot)return;
      txt.textContent=d.whatsappReady?'Online':'AI Mode';
      txt.style.color=d.whatsappReady?'#22c55e':'#f59e0b';
      dot.style.background=d.whatsappReady?'#22c55e':'#f59e0b';
      dot.style.boxShadow='0 0 6px '+(d.whatsappReady?'#22c55e':'#f59e0b');
    }).catch(function(){});
  }
  pollHealth();
  setInterval(pollHealth,30000);

  var SUGGESTIONS=[
    '\\ud83d\\udc4b Hi there!',
    '\\ud83d\\uddd3 Book an appointment',
    '\\ud83d\\udcdd My appointments',
    '\\ud83d\\udcb0 Consultation fees',
    '\\ud83e\\uddd1\\u200d\\u2695\\ufe0f Services offered',
    '\\ud83d\\udccd Clinic location',
    '\\u23f0 Opening hours',
    '\\u274c Cancel appointment',
  ];
  function showSuggestions(){
    var el=document.getElementById('suggestions');
    el.innerHTML=SUGGESTIONS.map(function(s){
      return '<button class="chip" onclick="useSuggestion(this.textContent)">'+esc(s)+'</button>';
    }).join('');
    el.style.display='flex';
  }
  function hideSuggestions(){
    document.getElementById('suggestions').style.display='none';
  }
  window.useSuggestion=function(text){
    document.getElementById('msg').value=text;
    document.getElementById('msg').focus();
    hideSuggestions();
    send();
  };

  var msgStore=[];
  function saveToStorage(){
    try{localStorage.setItem(STORAGE_KEY+'_'+from,JSON.stringify(msgStore.slice(-80)));}catch(e){}
  }
  function loadFromStorage(){
    try{var saved=localStorage.getItem(STORAGE_KEY+'_'+from);if(saved)msgStore=JSON.parse(saved);}catch(e){msgStore=[];}
  }
  function restoreMessages(){
    loadFromStorage();
    var chat=document.getElementById('chat');
    chat.innerHTML='<div class="day-sep"><span>Today</span></div>';
    if(msgStore.length===0){
      renderBubble('bot','Good day! \\ud83d\\udc4b I\\u2019m Demo Clinic AI, your intelligent health assistant.\\n\\nI can help you with:\\n\\u2022 Appointments & Bookings\\n\\u2022 Services & Fees\\n\\u2022 Doctor Information\\n\\u2022 Clinic Hours & Location\\n\\nWhat can I help you with today? \\ud83d\\ude0a','',now(),false);
      showSuggestions();
    }else{
      msgStore.forEach(function(m){renderBubble(m.role,m.text,m.extra,m.time,false);});
      hideSuggestions();
    }
    scrollDown();
  }

  function renderBubble(role,text,extra,time,save){
    var chat=document.getElementById('chat');
    var row=document.createElement('div');
    row.className='row '+(role==='user'?'user':'bot');
    if(role==='sys'){
      row.innerHTML='<div class="bubble sys">'+esc(text)+'</div>';
    }else if(role==='card'){
      row.innerHTML=text;
    }else{
      row.innerHTML='<div class="bubble '+role+'">'+esc(text)+'</div>'
        +'<div class="msg-time">'+(time||now())+'</div>';
    }
    chat.appendChild(row);
    if(save&&role!=='sys'&&role!=='card'){
      msgStore.push({role:role,text:text,extra:extra||'',time:time||now()});
      saveToStorage();
    }
    scrollDown();
  }

  function addBubble(role,text,extra){
    renderBubble(role,text,extra,now(),true);
  }

  function addBookingCard(text,meta){
    var chat=document.getElementById('chat');
    var row=document.createElement('div');
    row.className='row bot';
    row.innerHTML='<div class="book-card">'
      +'<div class="book-card-hd">✅ APPOINTMENT CONFIRMED</div>'
      +'<div class="book-card-bd">'+esc(text)+'</div>'
      +(meta&&meta.appointmentId?'<div class="book-card-id">ID: '+esc(meta.appointmentId)+'</div>':'')
      +'</div>'
      +'<div class="msg-time">'+now()+'</div>';
    chat.appendChild(row);
    msgStore.push({role:'bot',text:text,extra:'',time:now()});
    saveToStorage();
    scrollDown();
  }

  function showTyping(){
    if(document.getElementById('typing-row'))return;
    var chat=document.getElementById('chat');
    var row=document.createElement('div');
    row.className='typing-row';row.id='typing-row';
    row.innerHTML='<div class="typing-bbl"><div class="tdot"></div><div class="tdot"></div><div class="tdot"></div></div>';
    chat.appendChild(row);scrollDown();
  }
  function removeTyping(){var t=document.getElementById('typing-row');if(t)t.remove();}

  window.newUser=function(){
    if(abortCtrl){abortCtrl.abort();abortCtrl=null;}
    isSending=false;
    removeTyping();
    document.getElementById('sendBtn').disabled=false;
    var r=Math.floor(Math.random()*9000+1000);
    document.getElementById('fromIn').value='923'+r+'00000';
    document.getElementById('nameIn').value='User'+r;
    from='923'+r+'00000';
    name='User'+r;
    msgStore=[];
    clearChatUI();
  };

  window.clearChat=function(){
    if(abortCtrl){abortCtrl.abort();abortCtrl=null;}
    isSending=false;
    removeTyping();
    document.getElementById('sendBtn').disabled=false;
    from=document.getElementById('fromIn').value||'923001234573';
    name=document.getElementById('nameIn').value||'User';
    msgStore=[];
    saveToStorage();
    clearChatUI();
  };

  function clearChatUI(){
    var chat=document.getElementById('chat');
    chat.innerHTML='<div class="day-sep"><span>Today</span></div>';
    renderBubble('bot','Chat cleared. How can I help you today? \\ud83d\\ude0a','',now(),false);
    showSuggestions();
  }

  window.send=async function(){
    if(isSending)return;
    var text=document.getElementById('msg').value.trim();
    if(!text)return;
    var now_ms=Date.now();
    var gap=now_ms-lastSendTime;
    if(gap<MIN_SEND_GAP){
      await new Promise(function(res){setTimeout(res,MIN_SEND_GAP-gap);});
    }
    from=document.getElementById('fromIn').value||'923001234573';
    name=document.getElementById('nameIn').value||'User';
    isSending=true;
    lastSendTime=Date.now();
    var btn=document.getElementById('sendBtn');
    btn.disabled=true;
    hideSuggestions();
    addBubble('user',text,'<span class="tick">✓✓</span>');
    document.getElementById('msg').value='';
    document.getElementById('msg').style.height='auto';
    showTyping();
    abortCtrl=new AbortController();
    var signal=abortCtrl.signal;
    try{
      var r=await fetch('/chat/test',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({from:from,name:name,text:text}),
        signal:signal
      });
      abortCtrl=null;
      removeTyping();
      if(r.status===429){
        addBubble('sys','⚠️ Too many messages. Please wait 5 seconds and try again.');
        setTimeout(function(){isSending=false;btn.disabled=false;document.getElementById('msg').focus();},5000);
        return;
      }
      var d=await r.json();
      if(d.metadata&&d.metadata.booked&&d.text){
        addBookingCard(d.text,d.metadata);
      }else if(d.text){
        addBubble('bot',d.text);
      }
      if(d.handoff){
        var chat=document.getElementById('chat');
        var b=document.createElement('div');
        b.className='handoff-banner';
        b.textContent='🔁 Transferred to a human agent';
        chat.appendChild(b);scrollDown();
      }
      if(d.error&&!d.text)addBubble('sys','Error: '+d.error);
    }catch(e){
      removeTyping();
      if(e.name!=='AbortError'){
        addBubble('sys','⚠️ Could not reach the server. Please check your connection and retry.');
      }
    }
    isSending=false;
    btn.disabled=false;
    document.getElementById('msg').focus();
  };

  restoreMessages();
  document.getElementById('msg').focus();

  document.getElementById('fromIn').addEventListener('change',function(){
    from=this.value;
    restoreMessages();
  });

})();
</script>
</body>
</html>`),
  );
  // IMPORTANT: keep the POST handler below

  app.post("/chat/test", async (c) => {
    const body = testChatSchema.parse(await c.req.json());
    if (!testChatGuard.allow(body.from))
      throw new HTTPException(429, { message: "rate limit exceeded" });
    const reply = await handleInboundMessage({
      businessId: body.businessId ?? config.DEFAULT_BUSINESS_ID,
      channel: "api",
      from: body.from,
      name: body.name,
      text: body.text,
      timestamp: new Date(),
    });
    return c.json(reply);
  });

  // ── Admin dashboard SPA ───────────────────────────────────────────────────
  app.get("/admin", (c) => c.html(adminDashboardHtml()));

  // ── Admin API — existing routes ───────────────────────────────────────────
  app.post("/admin/knowledge", async (c) => {
    assertAdmin(c, c.req.header("x-admin-key"), adminRateGuard);
    const body = knowledgeSchema.parse(await c.req.json());
    const chunks = await upsertKnowledge({
      businessId: body.businessId ?? config.DEFAULT_BUSINESS_ID,
      title: body.title,
      content: body.content,
      source: body.source ?? "api",
    });
    return c.json({ ok: true, chunks });
  });

  app.get("/admin/appointments", async (c) => {
    assertAdmin(c, c.req.header("x-admin-key"), adminRateGuard);
    const businessId = c.req.query("businessId") ?? config.DEFAULT_BUSINESS_ID;
    // Join with customers so the UI can show name + phone instead of raw IDs
    const rows = await db
      .select({
        id: appointments.id,
        startsAt: appointments.startsAt,
        endsAt: appointments.endsAt,
        service: appointments.service,
        status: appointments.status,
        notes: appointments.notes,
        customerId: appointments.customerId,
        customerName: customers.name,
        customerPhone: customers.phone,
      })
      .from(appointments)
      .leftJoin(customers, eq(appointments.customerId, customers.id))
      .where(
        and(
          eq(appointments.businessId, businessId),
          gte(appointments.startsAt, new Date().toISOString()),
          eq(appointments.status, "scheduled"),
        ),
      )
      .orderBy(appointments.startsAt)
      .limit(50);
    return c.json({ appointments: rows });
  });

  app.post("/admin/send", async (c) => {
    assertAdmin(c, c.req.header("x-admin-key"), adminRateGuard);
    const body = sendSchema.parse(await c.req.json());
    await transport.sendText(body.to, body.text);
    return c.json({ ok: true });
  });

  /** GET /admin/knowledge-list — list all knowledge entries */
  app.get("/admin/knowledge-list", async (c) => {
    assertAdmin(c, c.req.header("x-admin-key"), adminRateGuard);
    const businessId = c.req.query("businessId") ?? config.DEFAULT_BUSINESS_ID;
    const entries = await listKnowledge(businessId);
    return c.json({ ok: true, entries });
  });

  /** DELETE /admin/knowledge — delete all chunks for a title slug */
  app.delete("/admin/knowledge", async (c) => {
    assertAdmin(c, c.req.header("x-admin-key"), adminRateGuard);
    const body = deleteKnowledgeSchema.parse(await c.req.json());
    await deleteKnowledgeByTitle(
      body.businessId ?? config.DEFAULT_BUSINESS_ID,
      body.titleSlug,
    );
    return c.json({ ok: true });
  });

  /** POST /admin/broadcast — send a message to all customers */
  app.post("/admin/broadcast", async (c) => {
    assertAdmin(c, c.req.header("x-admin-key"), adminRateGuard);
    const body = broadcastSchema.parse(await c.req.json());
    const businessId = body.businessId ?? config.DEFAULT_BUSINESS_ID;
    const allCustomers = await db
      .select({ phone: customers.phone, name: customers.name })
      .from(customers)
      .where(eq(customers.businessId, businessId))
      .limit(500);
    let sent = 0;
    let failed = 0;
    for (const cust of allCustomers) {
      try {
        await transport.sendText(cust.phone, body.text);
        sent++;
        // Small delay to avoid WhatsApp rate limits
        await new Promise((r) => setTimeout(r, 300));
      } catch {
        failed++;
      }
    }
    return c.json({ ok: true, sent, failed, total: allCustomers.length });
  });

  // ── Admin API — new routes ────────────────────────────────────────────────

  /** GET /admin/business — current business settings */
  app.get("/admin/business", async (c) => {
    assertAdmin(c, c.req.header("x-admin-key"), adminRateGuard);
    const businessId = c.req.query("businessId") ?? config.DEFAULT_BUSINESS_ID;
    const business = await db.query.businesses.findFirst({
      where: eq(businesses.id, businessId),
    });
    return c.json({ ok: true, business: business ?? null });
  });

  /** GET /admin/analytics — aggregated event stats */
  app.get("/admin/analytics", async (c) => {
    assertAdmin(c, c.req.header("x-admin-key"), adminRateGuard);
    const businessId = c.req.query("businessId") ?? config.DEFAULT_BUSINESS_ID;

    const now = new Date();
    const todayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).toISOString();
    const weekStart = new Date(
      now.getTime() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const monthStart = new Date(
      now.getTime() - 30 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const rows = await db
      .select({
        event: analyticsEvents.event,
        month: sql<number>`cast(count(*) as integer)`,
        week: sql<number>`cast(sum(case when ${analyticsEvents.createdAt} >= ${weekStart} then 1 else 0 end) as integer)`,
        today: sql<number>`cast(sum(case when ${analyticsEvents.createdAt} >= ${todayStart} then 1 else 0 end) as integer)`,
      })
      .from(analyticsEvents)
      .where(
        and(
          eq(analyticsEvents.businessId, businessId),
          gte(analyticsEvents.createdAt, monthStart),
        ),
      )
      .groupBy(analyticsEvents.event);

    const [custRow] = await db
      .select({ total: sql<number>`cast(count(*) as integer)` })
      .from(customers)
      .where(eq(customers.businessId, businessId));

    type Bucket = { today: number; week: number; month: number };
    const bucket = (key: string): Bucket => {
      const r = rows.find((x) => x.event === key);
      return r
        ? { today: r.today, week: r.week, month: r.month }
        : { today: 0, week: 0, month: 0 };
    };

    return c.json({
      ok: true,
      period: { todayStart, weekStart, monthStart },
      messagesReceived: bucket("message_received"),
      messageReplied: bucket("message_replied"),
      appointmentBooked: bucket("appointment_booked"),
      handoffCreated: bucket("handoff_created"),
      customers: { total: custRow?.total ?? 0 },
    });
  });

  /** GET /admin/customers — paginated customer list with appointment counts */
  app.get("/admin/customers", async (c) => {
    assertAdmin(c, c.req.header("x-admin-key"), adminRateGuard);
    const businessId = c.req.query("businessId") ?? config.DEFAULT_BUSINESS_ID;
    const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "50", 10)));
    const offset = (page - 1) * pageSize;

    // Use LEFT JOIN + COUNT instead of correlated subquery for SQLite compatibility
    const rows = await db
      .select({
        id: customers.id,
        phone: customers.phone,
        name: customers.name,
        language: customers.language,
        createdAt: customers.createdAt,
        appointmentCount: sql<number>`cast(count(${appointments.id}) as integer)`,
      })
      .from(customers)
      .leftJoin(appointments, eq(appointments.customerId, customers.id))
      .where(eq(customers.businessId, businessId))
      .groupBy(
        customers.id,
        customers.phone,
        customers.name,
        customers.language,
        customers.createdAt,
      )
      .orderBy(sql`${customers.createdAt} desc`)
      .limit(pageSize)
      .offset(offset);

    const [countRow] = await db
      .select({ total: sql<number>`cast(count(*) as integer)` })
      .from(customers)
      .where(eq(customers.businessId, businessId));

    return c.json({
      ok: true,
      customers: rows,
      pagination: {
        page,
        limit: pageSize,
        total: countRow?.total ?? 0,
        pages: Math.ceil((countRow?.total ?? 0) / pageSize),
      },
    });
  });

  /** POST /admin/update-business — patch business settings */
  app.post("/admin/update-business", async (c) => {
    assertAdmin(c, c.req.header("x-admin-key"), adminRateGuard);
    const body = updateBusinessSchema.parse(await c.req.json());
    const businessId = config.DEFAULT_BUSINESS_ID;

    // Verify business exists before updating
    const existing = await db.query.businesses.findFirst({
      where: eq(businesses.id, businessId),
    });
    if (!existing) {
      return c.json({ ok: false, error: "business not found" }, 404);
    }

    const patch: Partial<typeof businesses.$inferInsert> = {
      updatedAt: new Date().toISOString(),
    };
    if (body.name !== undefined) patch.name = body.name;
    if (body.openHour !== undefined) patch.openHour = body.openHour;
    if (body.closeHour !== undefined) patch.closeHour = body.closeHour;
    if (body.systemPrompt !== undefined) patch.systemPrompt = body.systemPrompt;
    if (body.timezone !== undefined) patch.timezone = body.timezone;
    if (body.appointmentDurationMinutes !== undefined)
      patch.appointmentDurationMinutes = body.appointmentDurationMinutes;

    await db.update(businesses).set(patch).where(eq(businesses.id, businessId));
    clearBusinessCache();

    return c.json({ ok: true });
  });

  /** POST /admin/update-appointment — cancel or update an appointment */
  app.post("/admin/update-appointment", async (c) => {
    assertAdmin(c, c.req.header("x-admin-key"), adminRateGuard);
    const body = updateAppointmentSchema.parse(await c.req.json());
    const businessId = body.businessId ?? config.DEFAULT_BUSINESS_ID;

    const result = await db
      .update(appointments)
      .set({ status: body.status, updatedAt: new Date().toISOString() })
      .where(and(eq(appointments.id, body.id), eq(appointments.businessId, businessId)));

    if (typeof result.rowsAffected === "number" && result.rowsAffected === 0) {
      return c.json({ ok: false, error: "appointment not found" }, 404);
    }
    return c.json({ ok: true });
  });

  return app;
}

// ── Validation schemas ────────────────────────────────────────────────────────

const testChatSchema = z.object({
  businessId: z.string().optional(),
  from: z.string().default("test-user"),
  name: z.string().optional(),
  text: z.string().min(1),
});

const knowledgeSchema = z.object({
  businessId: z.string().optional(),
  title: z.string().min(1),
  content: z.string().min(1),
  source: z.string().optional(),
});

const sendSchema = z.object({
  to: z.string().min(5),
  text: z.string().min(1),
});

const updateBusinessSchema = z.object({
  name: z.string().min(1).optional(),
  openHour: z.coerce.number().int().min(0).max(23).optional(),
  closeHour: z.coerce.number().int().min(1).max(24).optional(),
  systemPrompt: z.string().min(1).optional(),
  timezone: z.string().optional(),
  appointmentDurationMinutes: z.coerce
    .number()
    .int()
    .min(5)
    .max(120)
    .optional(),
});

const updateAppointmentSchema = z.object({
  businessId: z.string().optional(),
  id: z.string().min(1),
  status: z.enum(["scheduled", "cancelled", "completed", "no_show"]),
});

const deleteKnowledgeSchema = z.object({
  businessId: z.string().optional(),
  titleSlug: z.string().min(1),
});

const broadcastSchema = z.object({
  businessId: z.string().optional(),
  text: z.string().min(1).max(1000),
});

// ── Auth helper ───────────────────────────────────────────────────────────────

function assertAdmin(c: { req: { header: (name: string) => string | undefined } }, key: string | undefined, guard: WindowGuard) {
  // Rate limit admin endpoints by source IP
  const ip = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown";
  if (!guard.allow(ip)) {
    throw new HTTPException(429, { message: "admin rate limit exceeded" });
  }
  if (!config.ADMIN_API_KEY) {
    throw new HTTPException(503, {
      message: "admin endpoints disabled — set the ADMIN_API_KEY secret",
    });
  }
  if (key !== config.ADMIN_API_KEY) {
    throw new HTTPException(401, { message: "invalid admin key" });
  }
}

function isAllowedOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  if (url.origin === "https://clinicchatbot.fly.dev") return true;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return true;
  return false;
}

// ── HTML pages ────────────────────────────────────────────────────────────────

function landingPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Clinic Chatbot — AI-Powered WhatsApp Assistant</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{
      --bg:#06060e;--bg2:#0c0c1d;--surface:rgba(255,255,255,.03);
      --surface2:rgba(255,255,255,.06);--border:rgba(255,255,255,.08);
      --border-h:rgba(255,255,255,.15);
      --green:#22c55e;--green-g:rgba(34,197,94,.15);
      --indigo:#6366f1;--indigo-g:rgba(99,102,241,.15);
      --cyan:#06b6d4;--purple:#a855f7;--pink:#ec4899;
      --text:#f1f5f9;--text2:#94a3b8;--text3:#475569;
      --font:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      --mono:'JetBrains Mono',monospace;
    }
    html{scroll-behavior:smooth}
    body{font-family:var(--font);background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden;-webkit-font-smoothing:antialiased}

    /* ═══ ANIMATED GRADIENT MESH BACKGROUND ═══ */
    .mesh-bg{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}
    .mesh-bg::before{content:'';position:absolute;width:150vmax;height:150vmax;top:-50vmax;left:-50vmax;
      background:
        radial-gradient(ellipse 600px 600px at 20% 30%,rgba(99,102,241,.12),transparent),
        radial-gradient(ellipse 500px 500px at 75% 20%,rgba(168,85,247,.1),transparent),
        radial-gradient(ellipse 700px 400px at 60% 70%,rgba(34,197,94,.08),transparent),
        radial-gradient(ellipse 400px 400px at 30% 80%,rgba(6,182,212,.08),transparent);
      animation:meshDrift 25s ease-in-out infinite alternate}
    @keyframes meshDrift{
      0%{transform:translate(0,0) rotate(0deg) scale(1)}
      33%{transform:translate(3%,-4%) rotate(3deg) scale(1.02)}
      66%{transform:translate(-2%,3%) rotate(-2deg) scale(.98)}
      100%{transform:translate(4%,2%) rotate(4deg) scale(1.03)}}

    /* ═══ FLOATING BLOBS ═══ */
    .blob{position:fixed;border-radius:50%;filter:blur(80px);opacity:.35;pointer-events:none;z-index:0}
    .blob-1{width:400px;height:400px;background:var(--indigo);top:-100px;right:-100px;animation:blobFloat1 20s ease-in-out infinite}
    .blob-2{width:350px;height:350px;background:var(--purple);bottom:-80px;left:-80px;animation:blobFloat2 22s ease-in-out infinite}
    .blob-3{width:300px;height:300px;background:var(--cyan);top:50%;left:50%;transform:translate(-50%,-50%);animation:blobFloat3 18s ease-in-out infinite}
    @keyframes blobFloat1{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(-40px,60px) scale(1.15)}}
    @keyframes blobFloat2{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(50px,-40px) scale(1.1)}}
    @keyframes blobFloat3{0%,100%{transform:translate(-50%,-50%) scale(1)}50%{transform:translate(-50%,-50%) scale(1.2)}}

    /* ═══ PARTICLES ═══ */
    .particles{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}
    .particle{position:absolute;width:2px;height:2px;background:rgba(255,255,255,.3);border-radius:50%;animation:particleFloat linear infinite}
    @keyframes particleFloat{0%{transform:translateY(100vh) scale(0);opacity:0}10%{opacity:1}90%{opacity:1}100%{transform:translateY(-10vh) scale(1);opacity:0}}

    /* ═══ GLASSMORPHISM ═══ */
    .glass{background:rgba(255,255,255,.03);backdrop-filter:blur(20px) saturate(1.2);-webkit-backdrop-filter:blur(20px) saturate(1.2);border:1px solid var(--border)}
    .glass-strong{background:rgba(255,255,255,.05);backdrop-filter:blur(30px) saturate(1.4);-webkit-backdrop-filter:blur(30px) saturate(1.4);border:1px solid rgba(255,255,255,.1)}

    /* ═══ NAV ═══ */
    nav{position:fixed;top:0;left:0;right:0;z-index:100;padding:0 24px;height:64px;display:flex;align-items:center;justify-content:space-between;transition:all .4s}
    nav.scrolled{background:rgba(6,6,14,.85);backdrop-filter:blur(20px);border-bottom:1px solid var(--border)}
    .brand{display:flex;align-items:center;gap:10px;font-size:18px;font-weight:800;color:var(--text);text-decoration:none}
    .brand-icon{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,var(--green),var(--cyan));display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 4px 20px rgba(34,197,94,.3)}
    .nav-links{display:flex;gap:8px;align-items:center}
    .nav-link{padding:8px 16px;border-radius:10px;font-size:14px;font-weight:600;color:var(--text2);text-decoration:none;transition:all .25s;position:relative}
    .nav-link:hover{color:var(--text);background:var(--surface2)}
    .nav-link.primary{background:linear-gradient(135deg,var(--green),#16a34a);color:#000;box-shadow:0 4px 16px rgba(34,197,94,.25)}
    .nav-link.primary:hover{transform:translateY(-1px);box-shadow:0 6px 24px rgba(34,197,94,.35)}

    /* ═══ MAIN CONTENT ═══ */
    .content{position:relative;z-index:1}

    /* ═══ HERO ═══ */
    .hero{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:120px 24px 80px;position:relative}
    .hero-badge{display:inline-flex;align-items:center;gap:8px;padding:6px 16px 6px 8px;border-radius:99px;font-size:13px;font-weight:600;color:var(--green);margin-bottom:32px;animation:fadeSlideUp .8s ease both}
    .hero-badge-dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 8px var(--green);animation:pulseDot 2s ease-in-out infinite}
    @keyframes pulseDot{0%,100%{box-shadow:0 0 0 0 rgba(34,197,94,.5)}50%{box-shadow:0 0 0 8px rgba(34,197,94,0)}}
    .hero h1{font-size:clamp(40px,7vw,80px);font-weight:900;line-height:1.05;letter-spacing:-.03em;margin-bottom:24px;animation:fadeSlideUp .8s ease .1s both}
    .hero h1 .gradient-text{background:linear-gradient(135deg,var(--green),var(--cyan),var(--indigo));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
    .hero p{font-size:clamp(16px,2vw,20px);color:var(--text2);max-width:600px;line-height:1.7;margin:0 auto 40px;animation:fadeSlideUp .8s ease .2s both}
    .hero-actions{display:flex;gap:12px;flex-wrap:wrap;justify-content:center;animation:fadeSlideUp .8s ease .3s both}
    .btn{display:inline-flex;align-items:center;gap:8px;padding:12px 24px;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer;text-decoration:none;border:none;transition:all .3s cubic-bezier(.34,1.56,.64,1);position:relative;overflow:hidden}
    .btn::before{content:'';position:absolute;inset:0;background:linear-gradient(135deg,rgba(255,255,255,.1),transparent);opacity:0;transition:opacity .3s}
    .btn:hover::before{opacity:1}
    .btn-primary{background:linear-gradient(135deg,var(--green),#16a34a);color:#000;box-shadow:0 8px 32px rgba(34,197,94,.3)}
    .btn-primary:hover{transform:translateY(-2px) scale(1.02);box-shadow:0 12px 40px rgba(34,197,94,.4)}
    .btn-secondary{background:var(--surface2);color:var(--text);border:1px solid var(--border)}
    .btn-secondary:hover{transform:translateY(-2px);border-color:var(--border-h);background:rgba(255,255,255,.08)}

    /* ═══ STATUS BAR ═══ */
    .status-bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:20px;padding:16px 28px;border-radius:16px;margin-top:48px;animation:fadeSlideUp .8s ease .4s both}
    .status-item{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:500}
    .status-label{color:var(--text2)}
    .status-value{color:var(--text);font-weight:700}
    .status-divider{width:1px;height:20px;background:var(--border)}
    .badge{display:inline-flex;align-items:center;gap:5px;padding:4px 12px;border-radius:99px;font-size:12px;font-weight:700}
    .badge-green{background:var(--green-g);color:var(--green)}
    .badge-red{background:rgba(248,81,73,.15);color:#f85149}
    .badge-yellow{background:rgba(210,153,34,.15);color:#d29922}
    .badge-blue{background:rgba(88,166,255,.15);color:#58a6ff}
    .badge-dot{width:6px;height:6px;border-radius:50%;background:currentColor}

    /* ═══ SCROLL INDICATOR ═══ */
    .scroll-indicator{position:absolute;bottom:32px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:8px;animation:fadeSlideUp .8s ease .5s both}
    .scroll-indicator span{font-size:12px;color:var(--text3);font-weight:500;letter-spacing:.1em;text-transform:uppercase}
    .scroll-mouse{width:24px;height:38px;border:2px solid var(--border);border-radius:12px;position:relative}
    .scroll-mouse::before{content:'';position:absolute;top:6px;left:50%;transform:translateX(-50%);width:3px;height:8px;background:var(--text2);border-radius:2px;animation:scrollWheel 2s ease-in-out infinite}
    @keyframes scrollWheel{0%,100%{transform:translateX(-50%) translateY(0);opacity:1}50%{transform:translateX(-50%) translateY(10px);opacity:.3}}

    /* ═══ SECTION ═══ */
    .section{padding:80px 24px;max-width:1200px;margin:0 auto}
    .section-header{text-align:center;margin-bottom:56px}
    .section-label{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.15em;color:var(--indigo);margin-bottom:12px}
    .section-title{font-size:clamp(28px,4vw,44px);font-weight:900;letter-spacing:-.02em;line-height:1.15}
    .section-desc{font-size:16px;color:var(--text2);max-width:500px;margin:16px auto 0;line-height:1.6}

    /* ═══ BENTO GRID ═══ */
    .bento{display:grid;grid-template-columns:repeat(4,1fr);grid-auto-rows:minmax(180px,auto);gap:16px}
    @media(max-width:900px){.bento{grid-template-columns:repeat(2,1fr)}}
    @media(max-width:500px){.bento{grid-template-columns:1fr}}
    .bento-card{border-radius:20px;padding:28px;position:relative;overflow:hidden;transition:all .4s cubic-bezier(.34,1.56,.64,1);cursor:default;transform-style:preserve-3d;perspective:1000px}
    .bento-card:hover{transform:translateY(-4px);border-color:var(--border-h);box-shadow:0 20px 60px rgba(0,0,0,.3)}
    .bento-card::after{content:'';position:absolute;inset:0;background:radial-gradient(600px circle at var(--mx,50%) var(--my,50%),rgba(255,255,255,.04),transparent 40%);opacity:0;transition:opacity .3s;pointer-events:none}
    .bento-card:hover::after{opacity:1}
    .bento-wide{grid-column:span 2}
    .bento-tall{grid-row:span 2}
    .bento-icon{width:48px;height:48px;border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:24px;margin-bottom:16px;position:relative}
    .bento-card h3{font-size:18px;font-weight:800;margin-bottom:8px}
    .bento-card p{font-size:14px;color:var(--text2);line-height:1.6}

    /* ═══ STAT COUNTERS ═══ */
    .counter-value{font-size:42px;font-weight:900;line-height:1;margin-bottom:4px;font-variant-numeric:tabular-nums}
    .counter-label{font-size:13px;color:var(--text2);font-weight:600;text-transform:uppercase;letter-spacing:.08em}

    /* ═══ APPOINTMENTS PANEL ═══ */
    .apt-panel{border-radius:20px;padding:32px;position:relative;overflow:hidden}
    .apt-panel-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}
    .apt-panel-title{font-size:20px;font-weight:800}
    .apt-list{display:flex;flex-direction:column;gap:10px}
    .apt-item{display:flex;align-items:center;gap:14px;padding:14px 18px;border-radius:14px;background:var(--surface);border:1px solid var(--border);transition:all .25s}
    .apt-item:hover{border-color:var(--green);background:var(--green-g);transform:translateX(4px)}
    .apt-dot{width:10px;height:10px;border-radius:50%;background:var(--green);box-shadow:0 0 8px var(--green);flex-shrink:0}
    .apt-info{flex:1;min-width:0}
    .apt-service{font-size:15px;font-weight:700}
    .apt-time{font-size:13px;color:var(--text2);margin-top:2px;font-family:var(--mono)}
    .apt-empty{text-align:center;padding:40px 0;color:var(--text2);font-size:15px}

    /* ═══ KEY PROMPT ═══ */
    .key-prompt{border-radius:14px;padding:20px;margin-bottom:20px;border:1px solid rgba(210,153,34,.3);background:rgba(210,153,34,.06)}
    .key-prompt strong{color:#d29922}
    .key-input-row{display:flex;gap:10px;margin-top:12px}
    .key-input{flex:1;background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:10px 14px;color:var(--text);font:inherit;font-size:14px;outline:none;transition:border-color .2s}
    .key-input:focus{border-color:var(--green)}

    /* ═══ QUICK ACTIONS ═══ */
    .actions-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
    @media(max-width:500px){.actions-grid{grid-template-columns:repeat(2,1fr)}}
    .action-card{display:flex;flex-direction:column;align-items:center;gap:10px;padding:24px 16px;border-radius:16px;text-decoration:none;color:var(--text);font-size:14px;font-weight:600;text-align:center;transition:all .35s cubic-bezier(.34,1.56,.64,1);position:relative;overflow:hidden}
    .action-card:hover{transform:translateY(-4px) scale(1.02);border-color:var(--border-h)}
    .action-card::before{content:'';position:absolute;inset:0;background:linear-gradient(135deg,var(--indigo-g),transparent);opacity:0;transition:opacity .3s}
    .action-card:hover::before{opacity:1}
    .action-icon{font-size:28px;position:relative;z-index:1}
    .action-card span{position:relative;z-index:1}

    /* ═══ FOOTER ═══ */
    footer{border-top:1px solid var(--border);padding:32px 24px;text-align:center;font-size:14px;color:var(--text3)}
    footer a{color:var(--text2);text-decoration:none;font-weight:600;transition:color .2s}
    footer a:hover{color:var(--green)}

    /* ═══ ANIMATIONS ═══ */
    @keyframes fadeSlideUp{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:translateY(0)}}
    @keyframes fadeIn{from{opacity:0}to{opacity:1}}
    @keyframes scaleIn{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:scale(1)}}
    .reveal{opacity:0;transform:translateY(30px);transition:all .7s cubic-bezier(.22,1,.36,1)}
    .reveal.visible{opacity:1;transform:translateY(0)}
    .reveal-delay-1{transition-delay:.1s}
    .reveal-delay-2{transition-delay:.2s}
    .reveal-delay-3{transition-delay:.3s}
    .reveal-delay-4{transition-delay:.4s}

    /* ═══ LOADING ═══ */
    .spinner{width:24px;height:24px;border:2.5px solid var(--border);border-top-color:var(--green);border-radius:50%;animation:spin .7s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}

    /* ═══ RESPONSIVE ═══ */
    @media(max-width:768px){
      .hero{min-height:auto;padding:120px 20px 60px}
      .hero h1{font-size:36px}
      .status-bar{flex-direction:column;gap:12px;padding:16px}
      .status-divider{width:40px;height:1px}
      .bento{grid-template-columns:1fr}
      .bento-wide{grid-column:span 1}
      .actions-grid{grid-template-columns:repeat(2,1fr)}
      nav{padding:0 16px}
      .nav-link{padding:8px 12px;font-size:13px}
    }
  </style>
</head>
<body>
  <div class="mesh-bg"></div>
  <div class="blob blob-1"></div>
  <div class="blob blob-2"></div>
  <div class="blob blob-3"></div>
  <div class="particles" id="particles"></div>

  <div class="content">
    <nav id="mainNav">
      <a class="brand" href="/">
        <div class="brand-icon">💬</div>
        Clinic Chatbot
      </a>
      <div class="nav-links">
        <a class="nav-link" href="/chat/test">Test Chat</a>
        <a class="nav-link primary" href="/admin">Admin Panel</a>
      </div>
    </nav>

    <section class="hero">
      <div class="hero-badge glass">
        <span class="hero-badge-dot"></span>
        Production Ready
      </div>
      <h1>
        WhatsApp AI<br/>
        <span class="gradient-text">Clinic Assistant</span>
      </h1>
      <p>Automated appointment booking, patient support, and seamless human handoff — powered by Groq LLaMA 3.3 70B with RAG knowledge base.</p>
      <div class="hero-actions">
        <a class="btn btn-primary" href="/chat/test">
          <span>🧪</span> Try Demo Chat
        </a>
        <a class="btn btn-secondary" href="/admin">
          <span>⚙️</span> Admin Dashboard
        </a>
        <a class="btn btn-secondary" href="/health">
          <span>❤️</span> Health Check
        </a>
      </div>

      <div class="status-bar glass" id="statusBar">
        <div class="status-item">
          <span class="status-label">🏥</span>
          <strong class="status-value" id="clinicName">Loading…</strong>
        </div>
        <div class="status-divider"></div>
        <div class="status-item">
          <span class="status-label">WhatsApp:</span>
          <span class="badge badge-yellow" id="waBadge"><span class="badge-dot"></span> checking…</span>
        </div>
        <div class="status-divider"></div>
        <div class="status-item">
          <span class="status-label">AI:</span>
          <span class="badge badge-blue"><span class="badge-dot"></span> Groq LLaMA 3.3</span>
        </div>
        <div class="status-divider"></div>
        <div class="status-item">
          <span class="status-label">Uptime:</span>
          <span class="badge badge-green" id="uptimeBadge"><span class="badge-dot"></span> online</span>
        </div>
      </div>

      <div class="scroll-indicator">
        <div class="scroll-mouse"></div>
        <span>Scroll</span>
      </div>
    </section>

    <section class="section">
      <div class="section-header reveal">
        <div class="section-label">System Overview</div>
        <h2 class="section-title">Built for Scale</h2>
        <p class="section-desc">Every component designed for reliability, speed, and intelligent patient interactions.</p>
      </div>
      <div class="bento">
        <div class="bento-card glass reveal reveal-delay-1" data-tilt>
          <div class="bento-icon" style="background:linear-gradient(135deg,rgba(34,197,94,.15),rgba(34,197,94,.05))">📱</div>
          <h3>WhatsApp Status</h3>
          <div class="counter-value" id="waStatusCard" style="color:var(--green)">—</div>
          <p id="waStatusSub" style="font-size:13px">WhatsApp Business API</p>
        </div>
        <div class="bento-card glass reveal reveal-delay-2" data-tilt>
          <div class="bento-icon" style="background:linear-gradient(135deg,rgba(99,102,241,.15),rgba(99,102,241,.05))">🤖</div>
          <h3>AI Model</h3>
          <div class="counter-value" style="color:var(--indigo);font-size:28px">LLaMA 3.3</div>
          <p style="font-size:13px">70B parameters · Groq</p>
        </div>
        <div class="bento-card glass reveal reveal-delay-3" data-tilt>
          <div class="bento-icon" style="background:linear-gradient(135deg,rgba(6,182,212,.15),rgba(6,182,212,.05))">🚀</div>
          <h3>Deployment</h3>
          <div class="counter-value" style="color:var(--cyan);font-size:28px">Fly.io</div>
          <p style="font-size:13px">Amsterdam region</p>
        </div>
        <div class="bento-card glass reveal reveal-delay-4" data-tilt>
          <div class="bento-icon" style="background:linear-gradient(135deg,rgba(168,85,247,.15),rgba(168,85,247,.05))">🔗</div>
          <h3>API Endpoint</h3>
          <div class="counter-value" id="apiEndpoint" style="font-size:16px;color:var(--purple);font-family:var(--mono)">—</div>
          <p style="font-size:13px">REST / Webhook</p>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="bento" style="grid-template-columns:1.4fr 1fr">
        <div class="bento-card glass apt-panel reveal" data-tilt>
          <div class="apt-panel-header">
            <span class="apt-panel-title">📅 Upcoming Appointments</span>
            <button class="btn btn-secondary" style="font-size:13px;padding:8px 14px" onclick="loadAppointments()">↻ Refresh</button>
          </div>
          <div id="keyPrompt" class="key-prompt" style="display:none">
            <strong>⚠️ Admin key required</strong> to view appointments.
            <div class="key-input-row">
              <input class="key-input" id="keyInput" type="password" placeholder="Enter ADMIN_API_KEY…" />
              <button class="btn btn-primary" style="font-size:13px;padding:8px 16px" onclick="saveKey()">Save</button>
            </div>
          </div>
          <div class="apt-list" id="aptList"><div class="spinner"></div></div>
        </div>

        <div class="bento-card glass reveal reveal-delay-2" data-tilt style="display:flex;flex-direction:column;justify-content:center">
          <h3 style="font-size:18px;font-weight:800;margin-bottom:20px">⚡ Quick Actions</h3>
          <div class="actions-grid">
            <a class="action-card glass" href="/chat/test"><span class="action-icon">🧪</span><span>Test Chat</span></a>
            <a class="action-card glass" href="/admin"><span class="action-icon">🎛️</span><span>Admin</span></a>
            <a class="action-card glass" href="/admin#knowledge"><span class="action-icon">📚</span><span>Knowledge</span></a>
            <a class="action-card glass" href="/admin#messages"><span class="action-icon">📨</span><span>Messages</span></a>
            <a class="action-card glass" href="/admin#appointments"><span class="action-icon">📅</span><span>Appointments</span></a>
            <a class="action-card glass" href="/admin#settings"><span class="action-icon">⚙️</span><span>Settings</span></a>
          </div>
        </div>
      </div>
    </section>

    <footer class="reveal">
      Powered by
      <a href="https://groq.com" target="_blank">Groq</a> ·
      <a href="https://fly.io" target="_blank">Fly.io</a> ·
      <a href="https://github.com/whiskeysockets/baileys" target="_blank">Baileys</a> ·
      <a href="https://hono.dev" target="_blank">Hono</a>
    </footer>
  </div>

  <script>
    (function(){
      var c=document.getElementById('particles');if(!c)return;
      for(var i=0;i<30;i++){
        var p=document.createElement('div');p.className='particle';
        p.style.left=Math.random()*100+'%';
        p.style.animationDuration=(8+Math.random()*12)+'s';
        p.style.animationDelay=Math.random()*10+'s';
        p.style.width=p.style.height=(1+Math.random()*2)+'px';
        c.appendChild(p);
      }
    })();

    (function(){
      var nav=document.getElementById('mainNav');
      window.addEventListener('scroll',function(){nav.classList.toggle('scrolled',window.scrollY>40)},{passive:true});
    })();

    (function(){
      var obs=new IntersectionObserver(function(entries){
        entries.forEach(function(e){if(e.isIntersecting){e.target.classList.add('visible');obs.unobserve(e.target);}});
      },{threshold:0.1,rootMargin:'0px 0px -40px 0px'});
      document.querySelectorAll('.reveal').forEach(function(el){obs.observe(el);});
    })();

    (function(){
      document.querySelectorAll('[data-tilt]').forEach(function(card){
        card.addEventListener('mousemove',function(e){
          var r=card.getBoundingClientRect();
          var x=((e.clientX-r.left)/r.width-.5)*8;
          var y=((e.clientY-r.top)/r.height-.5)*-8;
          card.style.transform='perspective(800px) rotateY('+x+'deg) rotateX('+y+'deg) translateY(-4px)';
          card.style.setProperty('--mx',((e.clientX-r.left)/r.width*100)+'%');
          card.style.setProperty('--my',((e.clientY-r.top)/r.height*100)+'%');
        });
        card.addEventListener('mouseleave',function(){
          card.style.transform='';card.style.setProperty('--mx','50%');card.style.setProperty('--my','50%');
        });
      });
    })();

    var _tz='Asia/Karachi';
    fetch('/health').then(function(r){return r.json();}).then(function(d){
      if(d.timezone)_tz=d.timezone;
      document.getElementById('clinicName').textContent='Clinic Chatbot';
      document.getElementById('apiEndpoint').textContent=location.origin;
      var waReady=d.whatsappReady;
      var badge=document.getElementById('waBadge');
      var card=document.getElementById('waStatusCard');
      var sub=document.getElementById('waStatusSub');
      if(waReady){
        badge.className='badge badge-green';badge.innerHTML='<span class="badge-dot"></span> Online';
        card.textContent='Connected';sub.textContent='WhatsApp session active';
      }else if(!d.whatsappEnabled){
        badge.className='badge badge-yellow';badge.innerHTML='<span class="badge-dot"></span> Disabled';
        card.textContent='Disabled';sub.textContent='WHATSAPP_ENABLED=false';
      }else{
        badge.className='badge badge-red';badge.innerHTML='<span class="badge-dot"></span> Offline';
        card.textContent='Not connected';sub.textContent='Scan QR to connect';
      }
    }).catch(function(){
      document.getElementById('uptimeBadge').className='badge badge-red';
      document.getElementById('uptimeBadge').innerHTML='<span class="badge-dot"></span> error';
    });

    var adminKey=sessionStorage.getItem('adminKey');
    function loadAppointments(){
      var key=sessionStorage.getItem('adminKey');
      if(!key){document.getElementById('keyPrompt').style.display='block';document.getElementById('aptList').innerHTML='';return;}
      document.getElementById('keyPrompt').style.display='none';
      document.getElementById('aptList').innerHTML='<div class="spinner"></div>';
      fetch('/admin/appointments',{headers:{'x-admin-key':key}})
        .then(function(r){return r.json();})
        .then(function(d){
          var apts=d.appointments||[];
          if(apts.length===0){document.getElementById('aptList').innerHTML='<p class="apt-empty">No upcoming appointments.</p>';return;}
          var html='';
          apts.slice(0,8).forEach(function(a){
            var dt=new Date(a.startsAt);
            var dateStr=dt.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',timeZone:_tz});
            var timeStr=dt.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',timeZone:_tz});
            html+='<div class="apt-item"><div class="apt-dot"></div><div class="apt-info">'
              +'<div class="apt-service">'+escHtml(a.service||'consultation')+'</div>'
              +'<div class="apt-time">'+dateStr+' at '+timeStr+'</div>'
              +'</div></div>';
          });
          document.getElementById('aptList').innerHTML=html;
        })
        .catch(function(e){
          document.getElementById('aptList').innerHTML='<p class="apt-empty" style="color:#f85149">Failed to load: '+escHtml(String(e))+'</p>';
        });
    }
    function saveKey(){
      var val=document.getElementById('keyInput').value.trim();if(!val)return;
      sessionStorage.setItem('adminKey',val);adminKey=val;loadAppointments();
    }
    function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
    loadAppointments();
  </script>
</body>
</html>`;
}

function adminDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Admin Dashboard — Clinic Chatbot</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0d1117; --surface: #161b22; --surface2: #1c2128;
      --border: #30363d; --green: #25d366; --green-dark: #1aab53;
      --text: #e6edf3; --muted: #8b949e; --red: #f85149;
      --blue: #58a6ff; --yellow: #d29922; --purple: #a371f7;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    body { background: var(--bg); color: var(--text); min-height: 100vh; }

    /* TOP BAR */
    .topbar {
      position: sticky; top: 0; z-index: 200;
      background: rgba(13,17,23,.95); backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between;
      padding: 0 24px; height: 58px;
    }
    .brand { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 700; color: var(--green); text-decoration: none; }
    .topbar-right { display: flex; align-items: center; gap: 12px; }
    .key-status { font-size: 12px; color: var(--muted); }
    .key-status span { color: var(--green); }

    /* TAB NAV */
    .tab-nav {
      display: flex; gap: 2px; background: var(--surface);
      border-bottom: 1px solid var(--border); padding: 0 20px; overflow-x: auto;
    }
    .tab-btn {
      display: flex; align-items: center; gap: 7px;
      padding: 14px 18px; font-size: 14px; font-weight: 600;
      color: var(--muted); border: none; background: none; cursor: pointer;
      border-bottom: 2px solid transparent; white-space: nowrap; transition: .15s;
    }
    .tab-btn:hover { color: var(--text); }
    .tab-btn.active { color: var(--green); border-bottom-color: var(--green); }

    /* CONTENT */
    .tab-content { display: none; padding: 28px 24px; max-width: 1100px; margin: 0 auto; }
    .tab-content.active { display: block; }

    /* BUTTONS */
    .btn { display: inline-flex; align-items: center; gap: 6px; padding: 9px 18px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; border: none; transition: .15s; }
    .btn-green { background: var(--green); color: #000; }
    .btn-green:hover { background: var(--green-dark); }
    .btn-outline { background: transparent; color: var(--text); border: 1px solid var(--border); }
    .btn-outline:hover { border-color: var(--green); color: var(--green); }
    .btn-red { background: var(--red); color: #fff; }
    .btn-red:hover { opacity: .85; }
    .btn-sm { padding: 5px 11px; font-size: 12px; }
    button:disabled { opacity: .55; cursor: not-allowed; }

    /* CARDS & PANELS */
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; margin-bottom: 28px; }
    .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px 22px; }
    .stat-card:hover { border-color: var(--green); }
    .stat-num { font-size: 36px; font-weight: 800; line-height: 1; margin-bottom: 6px; }
    .stat-label { font-size: 12px; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); font-weight: 600; }
    .stat-sub { font-size: 12px; color: var(--muted); margin-top: 4px; }

    .panel { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 24px; margin-bottom: 24px; }
    .panel-title { font-size: 15px; font-weight: 700; margin-bottom: 18px; display: flex; align-items: center; gap: 8px; }

    /* FORM */
    .form-group { margin-bottom: 18px; }
    .form-label { display: block; font-size: 13px; font-weight: 600; color: var(--muted); margin-bottom: 7px; text-transform: uppercase; letter-spacing: .04em; }
    .form-control {
      width: 100%; background: var(--bg); border: 1px solid var(--border);
      border-radius: 8px; padding: 10px 14px; color: var(--text); font: inherit;
      font-size: 14px; outline: none; transition: border-color .15s;
    }
    .form-control:focus { border-color: var(--green); }
    textarea.form-control { min-height: 120px; resize: vertical; }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    @media (max-width: 600px) { .form-row { grid-template-columns: 1fr; } }
    .form-hint { font-size: 12px; color: var(--muted); margin-top: 5px; }

    /* TABLE */
    .table-wrap { overflow-x: auto; border-radius: 8px; border: 1px solid var(--border); }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    thead th { background: var(--surface2); color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .07em; padding: 11px 14px; text-align: left; font-weight: 600; }
    tbody td { padding: 12px 14px; border-top: 1px solid var(--border); vertical-align: middle; }
    tbody tr:hover { background: rgba(255,255,255,.02); }
    .badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 9px; border-radius: 99px; font-size: 11px; font-weight: 700; }
    .badge-green { background: rgba(37,211,102,.15); color: var(--green); }
    .badge-red { background: rgba(248,81,73,.15); color: var(--red); }
    .badge-yellow { background: rgba(210,153,34,.15); color: var(--yellow); }
    .badge-blue { background: rgba(88,166,255,.15); color: var(--blue); }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }

    /* ALERT */
    .alert { border-radius: 8px; padding: 12px 16px; font-size: 14px; margin-bottom: 16px; }
    .alert-green { background: rgba(37,211,102,.12); border: 1px solid rgba(37,211,102,.3); color: var(--green); }
    .alert-red { background: rgba(248,81,73,.12); border: 1px solid rgba(248,81,73,.3); color: var(--red); }
    .alert-yellow { background: rgba(210,153,34,.12); border: 1px solid rgba(210,153,34,.3); color: var(--yellow); }

    /* LOADING */
    .spinner { width: 22px; height: 22px; border: 2px solid var(--border); border-top-color: var(--green); border-radius: 50%; animation: spin .7s linear infinite; display: inline-block; vertical-align: middle; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading-area { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 40px; color: var(--muted); font-size: 14px; }

    /* MODAL OVERLAY */
    .modal-overlay {
      position: fixed; inset: 0; z-index: 999;
      background: rgba(0,0,0,.7); backdrop-filter: blur(4px);
      display: flex; align-items: center; justify-content: center; padding: 24px;
    }
    .modal-overlay.hidden { display: none; }
    .modal { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 32px; width: 100%; max-width: 420px; }
    .modal h2 { font-size: 20px; font-weight: 800; margin-bottom: 8px; }
    .modal p { font-size: 14px; color: var(--muted); margin-bottom: 20px; line-height: 1.5; }

    /* EMPTY STATE */
    .empty { text-align: center; padding: 40px; color: var(--muted); font-size: 14px; }
    .empty-icon { font-size: 40px; margin-bottom: 10px; }
  </style>
</head>
<body>

<!-- Admin key modal -->
<div class="modal-overlay" id="keyModal">
  <div class="modal">
    <h2>🔐 Admin Access</h2>
    <p>Enter your <code>ADMIN_API_KEY</code> to access the dashboard. It will be stored locally in your browser.</p>
    <div class="form-group">
      <label class="form-label">Admin API Key</label>
      <input class="form-control" id="modalKeyInput" type="password" placeholder="sk-…" autocomplete="current-password" />
    </div>
    <div id="keyModalError" style="display:none" class="alert alert-red">Incorrect key — check your ADMIN_API_KEY secret.</div>
    <button class="btn btn-green" style="width:100%" id="modalSaveBtn" onclick="verifyAndSaveKey()">Unlock Dashboard</button>
  </div>
</div>

<!-- Top bar -->
<div class="topbar">
  <a class="brand" href="/">💬 Clinic Chatbot</a>
  <div class="topbar-right">
    <span class="key-status">Key: <span id="keyIndicator">—</span></span>
    <button class="btn btn-outline" style="font-size:12px;padding:6px 12px;" onclick="changeKey()">🔑 Change Key</button>
    <a class="btn btn-outline" style="font-size:12px;padding:6px 12px;" href="/">← Home</a>
  </div>
</div>

<!-- Tab navigation -->
<div class="tab-nav">
  <button class="tab-btn active" onclick="switchTab('dashboard')">📊 Dashboard</button>
  <button class="tab-btn" onclick="switchTab('appointments')">📅 Appointments</button>
  <button class="tab-btn" onclick="switchTab('knowledge')">📚 Knowledge</button>
  <button class="tab-btn" onclick="switchTab('messages')">📨 Messages</button>
  <button class="tab-btn" onclick="switchTab('customers')">👥 Customers</button>
  <button class="tab-btn" onclick="switchTab('settings')">⚙️ Settings</button>
</div>

<!-- DASHBOARD TAB -->
<div class="tab-content active" id="tab-dashboard">
  <div id="dashAlerts"></div>
  <div class="stats-grid" id="statsGrid">
    <div class="stat-card"><div class="spinner"></div></div>
    <div class="stat-card"><div class="spinner"></div></div>
    <div class="stat-card"><div class="spinner"></div></div>
    <div class="stat-card"><div class="spinner"></div></div>
    <div class="stat-card"><div class="spinner"></div></div>
  </div>
  <div class="panel">
    <div class="panel-title">📅 Upcoming Appointments</div>
    <div id="dashAptContent"><div class="loading-area"><div class="spinner"></div> Loading…</div></div>
  </div>
</div>

<!-- APPOINTMENTS TAB -->
<div class="tab-content" id="tab-appointments">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
    <h2 style="font-size:20px;font-weight:800;">Upcoming Appointments</h2>
    <button class="btn btn-outline" onclick="loadAppointmentsTab()">↺ Refresh</button>
  </div>
  <div id="aptTabContent"><div class="loading-area"><div class="spinner"></div> Loading…</div></div>
</div>

<!-- KNOWLEDGE TAB -->
<div class="tab-content" id="tab-knowledge">
  <div class="panel">
    <div class="panel-title">➕ Add Knowledge Entry</div>
    <div id="knowledgeAlert"></div>
    <form id="knowledgeForm" onsubmit="submitKnowledge(event)">
      <div class="form-group">
        <label class="form-label">Title</label>
        <input class="form-control" id="kTitle" type="text" placeholder="e.g. Business Hours" required />
      </div>
      <div class="form-group">
        <label class="form-label">Content</label>
        <textarea class="form-control" id="kContent" placeholder="Enter the knowledge content…" required></textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Source <span style="font-weight:400;text-transform:none;letter-spacing:0">(optional)</span></label>
        <input class="form-control" id="kSource" type="text" placeholder="e.g. manual, website, pdf" />
      </div>
      <button class="btn btn-green" type="submit" id="kSubmitBtn">💾 Save to Knowledge Base</button>
    </form>
  </div>
  <div class="alert alert-blue" style="background:rgba(88,166,255,.1);border-color:rgba(88,166,255,.3);color:var(--blue);font-size:13px;">
    ℹ️ Entries are stored in the <strong>LanceDB</strong> vector store and automatically chunked for semantic search.
  </div>
  <!-- Knowledge list -->
  <div style="display:flex;align-items:center;justify-content:space-between;margin:24px 0 14px;">
    <div class="panel-title" style="margin:0">📚 Existing Knowledge Entries</div>
    <button class="btn btn-outline" style="font-size:12px;padding:6px 12px" onclick="loadKnowledgeList()">↺ Refresh</button>
  </div>
  <div id="knowledgeListContent"><div class="loading-area"><div class="spinner"></div> Loading…</div></div>
</div>

<!-- MESSAGES TAB -->
<div class="tab-content" id="tab-messages">
  <!-- Single message -->
  <div class="panel">
    <div class="panel-title">📨 Send Message to Patient</div>
    <div id="sendAlert"></div>
    <form id="sendForm" onsubmit="submitSend(event)">
      <div class="form-group">
        <label class="form-label">Phone Number</label>
        <input class="form-control" id="sendTo" type="text" placeholder="923001234567 (no + or spaces)" required />
        <div class="form-hint">International format, digits only. E.g. 923001234567</div>
      </div>
      <div class="form-group">
        <label class="form-label">Message</label>
        <textarea class="form-control" id="sendText" placeholder="Type your message here…" required style="min-height:90px"></textarea>
      </div>
      <button class="btn btn-green" type="submit" id="sendBtn">📤 Send Message</button>
    </form>
  </div>
  <!-- Broadcast -->
  <div class="panel">
    <div class="panel-title">📢 Broadcast to All Patients</div>
    <div id="broadcastAlert"></div>
    <div class="alert alert-yellow" style="margin-bottom:16px;font-size:13px;">⚠️ This will send a message to <strong>ALL</strong> registered patients. Use responsibly to avoid WhatsApp blocks.</div>
    <form id="broadcastForm" onsubmit="submitBroadcast(event)">
      <div class="form-group">
        <label class="form-label">Broadcast Message</label>
        <textarea class="form-control" id="broadcastText" placeholder="Type your broadcast message here…" required style="min-height:90px"></textarea>
      </div>
      <button class="btn btn-red" type="submit" id="broadcastBtn">📢 Send to All Patients</button>
    </form>
  </div>
</div>

<!-- CUSTOMERS TAB -->
<div class="tab-content" id="tab-customers">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:10px;">
    <h2 style="font-size:20px;font-weight:800;">Patients</h2>
    <div style="display:flex;gap:8px;">
      <input class="form-control" id="custSearch" placeholder="Search name or phone…" oninput="filterCustomers()" style="width:200px;padding:7px 12px;" />
      <button class="btn btn-outline" onclick="loadCustomers()">↺ Refresh</button>
    </div>
  </div>
  <div id="customersContent"><div class="loading-area"><div class="spinner"></div> Loading…</div></div>
</div>

<!-- SETTINGS TAB -->
<div class="tab-content" id="tab-settings">
  <div class="panel">
    <div class="panel-title">⚙️ Business Settings</div>
    <div id="settingsAlert"></div>
    <form id="settingsForm" onsubmit="submitSettings(event)">
      <div class="form-group">
        <label class="form-label">Business Name</label>
        <input class="form-control" id="sName" type="text" placeholder="e.g. Demo Clinic" />
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Opening Hour (0–23)</label>
          <input class="form-control" id="sOpenHour" type="number" min="0" max="23" placeholder="9" />
          <div class="form-hint">24-hour format. Default: 9</div>
        </div>
        <div class="form-group">
          <label class="form-label">Closing Hour (1–24)</label>
          <input class="form-control" id="sCloseHour" type="number" min="1" max="24" placeholder="18" />
          <div class="form-hint">24-hour format. Default: 18</div>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Timezone</label>
          <input class="form-control" id="sTimezone" type="text" placeholder="Asia/Karachi" />
          <div class="form-hint">IANA timezone. E.g. Asia/Karachi, UTC, Asia/Dubai</div>
        </div>
        <div class="form-group">
          <label class="form-label">Appointment Duration (mins)</label>
          <input class="form-control" id="sAptDuration" type="number" min="5" max="120" placeholder="30" />
          <div class="form-hint">Slot length in minutes. Default: 30</div>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">System Prompt (AI Personality)</label>
        <textarea class="form-control" id="sPrompt" style="min-height:200px;" placeholder="You are a helpful clinic assistant…"></textarea>
        <div class="form-hint">Defines the AI’s persona, tone, and instructions. Changes take effect immediately for new conversations.</div>
      </div>
      <div style="display:flex;gap:12px;align-items:center;">
        <button class="btn btn-green" type="submit" id="sSubmitBtn">💾 Save Settings</button>
        <button class="btn btn-outline" type="button" onclick="resetPrompt()">&#8635; Reset to Default</button>
      </div>
    </form>
  </div>
</div>

<script>
  /* ── State ── */
  var adminKey = sessionStorage.getItem("adminKey") || "";
  var currentTab = "dashboard";

  /* ── Init ── */
  (function init() {
    if (!adminKey) {
      document.getElementById("keyModal").classList.remove("hidden");
    } else {
      document.getElementById("keyModal").classList.add("hidden");
      updateKeyIndicator();
      loadDashboard();
      startAutoRefresh();
    }
    // Handle hash-based navigation from landing page quick actions
    var hash = location.hash.replace("#","");
    if (hash && ["dashboard","appointments","knowledge","messages","customers","settings"].indexOf(hash) !== -1) {
      setTimeout(function() { switchTab(hash); }, 100);
    }
  })();

  function updateKeyIndicator() {
    var ind = document.getElementById("keyIndicator");
    if (adminKey) {
      ind.textContent = adminKey.slice(0,4) + "••••";
      ind.style.color = "var(--green)";
    } else {
      ind.textContent = "not set";
      ind.style.color = "var(--red)";
    }
  }

  function changeKey() {
    document.getElementById("keyModal").classList.remove("hidden");
    document.getElementById("keyModalError").style.display = "none";
    document.getElementById("modalKeyInput").value = "";
  }

  function verifyAndSaveKey() {
    var val = document.getElementById("modalKeyInput").value.trim();
    if (!val) return;
    var btn = document.getElementById("modalSaveBtn");
    var errEl = document.getElementById("keyModalError");
    btn.disabled = true;
    btn.textContent = "Verifying\u2026";
    errEl.style.display = "none";
    fetch("/admin/appointments", { headers: { "x-admin-key": val } })
      .then(function(r) {
        btn.disabled = false;
        btn.textContent = "Unlock Dashboard";
        if (r.ok) {
          adminKey = val;
          sessionStorage.setItem("adminKey", val);
          document.getElementById("keyModal").classList.add("hidden");
          errEl.style.display = "none";
          updateKeyIndicator();
          loadDashboard();
          startAutoRefresh();
        } else if (r.status === 503) {
          errEl.style.display = "block";
          errEl.textContent = "\u26a0\ufe0f ADMIN_API_KEY is not configured on the server. Set it in your .env file.";
        } else if (r.status === 401) {
          errEl.style.display = "block";
          errEl.textContent = "\u274c Incorrect key \u2014 check your ADMIN_API_KEY in the .env file.";
        } else {
          errEl.style.display = "block";
          errEl.textContent = "Server error (" + r.status + "). Is the server running?";
        }
      })
      .catch(function() {
        btn.disabled = false;
        btn.textContent = "Unlock Dashboard";
        errEl.style.display = "block";
        errEl.textContent = "\uD83D\uDCF5 Network error \u2014 is the server running on port 3000?";
      });
  }

  /* ── Tab switching ── */
  var tabLoaders = {
    dashboard: loadDashboard,
    appointments: loadAppointmentsTab,
    knowledge: loadKnowledgeList,
    customers: loadCustomers,
    settings: loadSettings,
  };

  function switchTab(name) {
    document.querySelectorAll(".tab-btn").forEach(function(b, i) {
      var tabs = ["dashboard","appointments","knowledge","messages","customers","settings"];
      b.classList.toggle("active", tabs[i] === name);
    });
    document.querySelectorAll(".tab-content").forEach(function(c) {
      c.classList.toggle("active", c.id === "tab-" + name);
    });
    currentTab = name;
    if (tabLoaders[name] && adminKey) tabLoaders[name]();
  }

  /* ── Helpers ── */
  function escHtml(s) {
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }
  function apiGet(path) {
    return fetch(path, { headers: { "x-admin-key": adminKey } }).then(function(r){ return r.json(); });
  }
  function apiPost(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": adminKey },
      body: JSON.stringify(body)
    }).then(function(r){ return r.json(); });
  }
  function showAlert(containerId, type, msg) {
    document.getElementById(containerId).innerHTML =
      '<div class="alert alert-' + type + '">' + escHtml(msg) + '</div>';
    setTimeout(function() {
      var el = document.getElementById(containerId);
      if (el) el.innerHTML = "";
    }, 5000);
  }
  var _biz_tz = "Asia/Karachi";
  function fmtDate(iso) {
    if (!iso) return "\u2014";
    var d = new Date(iso);
    return d.toLocaleDateString("en-US", {weekday:"short",month:"short",day:"numeric",timeZone:_biz_tz})
      + " " + d.toLocaleTimeString("en-US", {hour:"2-digit",minute:"2-digit",timeZone:_biz_tz});
  }

  /* ── Dashboard ── */
  function loadDashboard() {
    // Load business timezone first so appointment times display correctly
    fetch("/health").then(function(r){return r.json();}).then(function(d){
      if(d.timezone) _biz_tz = d.timezone;
    }).catch(function(){});
    // Analytics stats
    apiGet("/admin/analytics").then(function(d) {
      if (!d.ok) return;
      var grid = document.getElementById("statsGrid");
      grid.innerHTML =
        statCard("📩", "Messages Today", d.messagesReceived.today, "this week: " + d.messagesReceived.week) +
        statCard("✅", "Replies Today", d.messageReplied.today, "this week: " + d.messageReplied.week) +
        statCard("📅", "Bookings (Month)", d.appointmentBooked.month, "today: " + d.appointmentBooked.today) +
        statCard("🤝", "Handoffs (Month)", d.handoffCreated.month, "today: " + d.handoffCreated.today) +
        statCard("👥", "Total Customers", d.customers.total, "all time");
    }).catch(function(e) {
      document.getElementById("dashAlerts").innerHTML =
        '<div class="alert alert-yellow">⚠️ Could not load analytics: ' + escHtml(String(e)) + '</div>';
    });

    // Upcoming appointments
    apiGet("/admin/appointments").then(function(d) {
      var apts = d.appointments || [];
      var el = document.getElementById("dashAptContent");
      if (apts.length === 0) {
        el.innerHTML = '<div class="empty"><div class="empty-icon">📭</div>No upcoming appointments.</div>';
        return;
      }
      el.innerHTML = '<div class="table-wrap">' + buildAptTable(apts.slice(0, 10), false) + '</div>';
    }).catch(function() {
      document.getElementById("dashAptContent").innerHTML =
        '<div class="empty" style="color:var(--red)">Failed to load appointments.</div>';
    });
  }

  function statCard(icon, label, num, sub) {
    return '<div class="stat-card"><div style="font-size:26px;margin-bottom:8px">' + icon + '</div>'
      + '<div class="stat-num" style="color:var(--green)">' + escHtml(String(num)) + '</div>'
      + '<div class="stat-label">' + escHtml(label) + '</div>'
      + '<div class="stat-sub">' + escHtml(sub) + '</div></div>';
  }

  /* ── Appointments tab ── */
  function loadAppointmentsTab() {
    var el = document.getElementById("aptTabContent");
    el.innerHTML = '<div class="loading-area"><div class="spinner"></div> Loading…</div>';
    apiGet("/admin/appointments").then(function(d) {
      var apts = d.appointments || [];
      if (apts.length === 0) {
        el.innerHTML = '<div class="empty"><div class="empty-icon">📭</div>No upcoming appointments.</div>';
        return;
      }
      el.innerHTML = '<div class="table-wrap">' + buildAptTable(apts, true) + '</div>';
    }).catch(function(e) {
      el.innerHTML = '<div class="empty" style="color:var(--red)">Error: ' + escHtml(String(e)) + '</div>';
    });
  }

  function buildAptTable(apts, showActions) {
    var rows = apts.map(function(a) {
      var dt = fmtDate(a.startsAt);
      var statusBadge = '<span class="badge badge-green"><span class="dot"></span>' + escHtml(a.status) + '</span>';
      // Show customer name + phone instead of internal ID
      var custInfo = (a.customerName || a.customerPhone)
        ? escHtml(a.customerName || '—') + '<br><span style="font-size:11px;color:var(--muted);font-family:monospace">' + escHtml(a.customerPhone || '') + '</span>'
        : '<span style="font-family:monospace;font-size:11px;color:var(--muted)">' + escHtml(a.customerId || '—') + '</span>';
      var sendBtn = showActions
        ? '<button class="btn btn-outline btn-sm" style="margin-right:6px" onclick="sendToPatient(\'' + escHtml(a.customerPhone || '') + '\')">💬 Message</button>'
        : '';
      var cancelBtn = showActions
        ? '<button class="btn btn-red btn-sm" onclick="cancelApt(\'' + escHtml(a.id) + '\',\'' + escHtml(a.customerPhone || '') + '\',\'' + escHtml(a.startsAt) + '\')">✕ Cancel</button>'
        : '';
      return '<tr><td>' + escHtml(dt) + '</td><td>' + escHtml(a.service || 'consultation')
        + '</td><td>' + custInfo
        + '</td><td>' + statusBadge + '</td>'
        + (showActions ? '<td>' + sendBtn + cancelBtn + '</td>' : '')
        + '</tr>';
    }).join('');
    var actionHeader = showActions ? '<th>Actions</th>' : '';
    return '<table><thead><tr><th>Date / Time</th><th>Service</th><th>Patient</th><th>Status</th>'
      + actionHeader + '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function cancelApt(id, phone, startsAt) {
    var msg = "Cancel this appointment?";
    if (phone && startsAt) {
      var dt = new Date(startsAt).toLocaleString();
      msg = "Cancel appointment on " + dt + " for " + phone + "?\n\nWould you also like to send a cancellation WhatsApp message to the patient?";
    }
    if (!confirm(msg)) return;
    apiPost("/admin/update-appointment", { id: id, status: "cancelled" }).then(function(d) {
      if (d.ok) {
        loadAppointmentsTab();
        // Offer to notify the patient
        if (phone && confirm("Appointment cancelled ✓\n\nSend cancellation notification to patient on " + phone + "?")) {
          var dt = startsAt ? new Date(startsAt).toLocaleString() : "your appointment";
          apiPost("/admin/send", {
            to: phone,
            text: "Dear patient, your appointment on " + dt + " has been cancelled by the clinic. We apologize for any inconvenience. Please contact us to reschedule."
          }).then(function(r) {
            if (r.ok) alert("✅ Cancellation notice sent to " + phone);
          });
        }
      } else alert("Failed: " + (d.error || "unknown error"));
    }).catch(function(e) { alert("Error: " + e); });
  }

  function sendToPatient(phone) {
    if (!phone) return;
    switchTab('messages');
    setTimeout(function() {
      var inp = document.getElementById('sendTo');
      if (inp) { inp.value = phone; inp.scrollIntoView({behavior:'smooth',block:'center'}); }
      var txt = document.getElementById('sendText');
      if (txt) txt.focus();
    }, 80);
  }

  /* ── Knowledge tab ── */
  var knowledgeListData = [];

  function submitKnowledge(e) {
    e.preventDefault();
    var btn = document.getElementById("kSubmitBtn");
    btn.disabled = true; btn.textContent = "Saving…";
    apiPost("/admin/knowledge", {
      title: document.getElementById("kTitle").value,
      content: document.getElementById("kContent").value,
      source: document.getElementById("kSource").value || "admin"
    }).then(function(d) {
      btn.disabled = false; btn.textContent = "💾 Save to Knowledge Base";
      if (d.ok) {
        showAlert("knowledgeAlert", "green", "✅ Saved " + (d.chunks || 1) + " chunk(s). Knowledge base updated.");
        document.getElementById("knowledgeForm").reset();
        loadKnowledgeList();
      } else {
        showAlert("knowledgeAlert", "red", "Error: " + (d.error || JSON.stringify(d)));
      }
    }).catch(function(e) {
      btn.disabled = false; btn.textContent = "💾 Save to Knowledge Base";
      showAlert("knowledgeAlert", "red", "Network error: " + e);
    });
  }

  function loadKnowledgeList() {
    var el = document.getElementById("knowledgeListContent");
    if (!el) return;
    el.innerHTML = '<div class="loading-area"><div class="spinner"></div> Loading…</div>';
    apiGet("/admin/knowledge-list").then(function(d) {
      var list = d.entries || [];
      knowledgeListData = list;
      if (!list.length) {
        el.innerHTML = '<div class="empty"><div class="empty-icon">📚</div>No knowledge entries yet. Add one above.</div>';
        return;
      }
      // Deduplicate by slug prefix (the part between businessId: and :chunkIndex)
      var seenSlug = {};
      var chunkCount = {};
      list.forEach(function(e) {
        var slug = e.id.split(':').slice(1, -1).join(':') || e.id;
        if (!seenSlug[slug]) { seenSlug[slug] = e; chunkCount[slug] = 0; }
        chunkCount[slug]++;
      });
      var rows = Object.keys(seenSlug).map(function(slug) {
        var e = seenSlug[slug];
        // Strip " (N)" suffix from chunked titles for display
        var displayTitle = e.title.replace(/\s*\(\d+\)$/, '');
        var chunks = chunkCount[slug];
        var chunkBadge = chunks > 1 ? ' <span class="badge" style="background:rgba(255,255,255,.07);color:var(--muted);font-size:10px">' + chunks + ' chunks</span>' : '';
        return '<tr>'
          + '<td style="font-weight:600">' + escHtml(displayTitle) + chunkBadge + '</td>'
          + '<td style="font-size:12px;color:var(--muted);max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(e.content.slice(0,120)) + '…</td>'
          + '<td><span class="badge badge-blue">' + escHtml(e.source || 'manual') + '</span></td>'
          + '<td><button class="btn btn-red btn-sm" onclick="deleteKnowledge(\'' + escHtml(slug) + '\',\'' + escHtml(displayTitle) + '\')">&#128465; Delete</button></td>'
          + '</tr>';
      }).join('');
      el.innerHTML = '<div class="table-wrap"><table>'
        + '<thead><tr><th>Title</th><th>Preview</th><th>Source</th><th>Actions</th></tr></thead>'
        + '<tbody>' + rows + '</tbody></table></div>';
    }).catch(function() {
      el.innerHTML = '<div class="empty" style="color:var(--red)">Could not load knowledge entries.</div>';
    });
  }

  function deleteKnowledge(slug, title) {
    if (!confirm('Delete all chunks for "' + title + '"? This cannot be undone.')) return;
    fetch('/admin/knowledge', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', 'x-admin-key': adminKey },
      body: JSON.stringify({ titleSlug: slug })
    }).then(function(r) { return r.json(); }).then(function(d) {
      if (d.ok) { showAlert('knowledgeAlert', 'green', '✅ Deleted "' + title + '" from knowledge base.'); loadKnowledgeList(); }
      else showAlert('knowledgeAlert', 'red', 'Error: ' + (d.error || 'unknown'));
    }).catch(function(e) { showAlert('knowledgeAlert', 'red', 'Network error: ' + e); });
  }

  /* ── Messages tab ── */
  function submitBroadcast(e) {
    e.preventDefault();
    var text = document.getElementById('broadcastText').value.trim();
    if (!text) return;
    if (!confirm('Send this message to ALL patients? This cannot be undone.')) return;
    var btn = document.getElementById('broadcastBtn');
    btn.disabled = true; btn.textContent = 'Sending…';
    apiPost('/admin/broadcast', { text: text }).then(function(d) {
      btn.disabled = false; btn.textContent = '📢 Send to All Patients';
      if (d.ok) {
        showAlert('broadcastAlert', 'green', '✅ Sent to ' + d.sent + ' patients. Failed: ' + d.failed + '.');
        document.getElementById('broadcastText').value = '';
      } else showAlert('broadcastAlert', 'red', 'Error: ' + (d.error || JSON.stringify(d)));
    }).catch(function(err) {
      btn.disabled = false; btn.textContent = '📢 Send to All Patients';
      showAlert('broadcastAlert', 'red', 'Network error: ' + err);
    });
  }

  function submitSend(e) {
    e.preventDefault();
    var btn = document.getElementById("sendBtn");
    btn.disabled = true; btn.textContent = "Sending…";
    apiPost("/admin/send", {
      to: document.getElementById("sendTo").value,
      text: document.getElementById("sendText").value
    }).then(function(d) {
      btn.disabled = false; btn.textContent = "📤 Send Message";
      if (d.ok) {
        showAlert("sendAlert", "green", "✅ Message sent successfully.");
        document.getElementById("sendForm").reset();
      } else {
        showAlert("sendAlert", "red", "Error: " + (d.error || JSON.stringify(d)));
      }
    }).catch(function(e) {
      btn.disabled = false; btn.textContent = "📤 Send Message";
      showAlert("sendAlert", "red", "Network error: " + e);
    });
  }

  /* ── Customers tab ── */
  var customersData = [];

  function loadCustomers() {
    var el = document.getElementById("customersContent");
    el.innerHTML = '<div class="loading-area"><div class="spinner"></div> Loading…</div>';
    apiGet("/admin/customers").then(function(d) {
      customersData = d.customers || [];
      renderCustomerTable(customersData);
    }).catch(function(e) {
      document.getElementById("customersContent").innerHTML = '<div class="empty" style="color:var(--red)">Error: ' + escHtml(String(e)) + '</div>';
    });
  }

  function filterCustomers() {
    var q = (document.getElementById('custSearch').value || '').toLowerCase();
    var filtered = q
      ? customersData.filter(function(c) {
          return (c.name || '').toLowerCase().includes(q) || (c.phone || '').includes(q);
        })
      : customersData;
    renderCustomerTable(filtered);
  }

  function renderCustomerTable(list) {
    var el = document.getElementById("customersContent");
    if (!list.length) {
      el.innerHTML = '<div class="empty"><div class="empty-icon">👤</div>' + (customersData.length ? 'No patients match your search.' : 'No patients registered yet.') + '</div>';
      return;
    }
    var rows = list.map(function(c) {
      var apptBadge = c.appointmentCount > 0
        ? '<span class="badge badge-green">' + c.appointmentCount + ' appts</span>'
        : '<span class="badge" style="background:rgba(255,255,255,.07);color:var(--muted)">0 appts</span>';
      var msgBtn = '<button class="btn btn-outline btn-sm" onclick="sendToPatient(\'' + escHtml(c.phone) + '\')">💬 Msg</button>';
      return '<tr>'
        + '<td style="font-family:monospace;font-size:13px">' + escHtml(c.phone) + '</td>'
        + '<td style="font-weight:600">' + escHtml(c.name || '—') + '</td>'
        + '<td><span class="badge badge-blue">' + escHtml(c.language || 'en') + '</span></td>'
        + '<td>' + apptBadge + '</td>'
        + '<td style="font-size:12px;color:var(--muted)">' + escHtml(c.createdAt ? new Date(c.createdAt).toLocaleDateString() : '—') + '</td>'
        + '<td>' + msgBtn + '</td>'
        + '</tr>';
    }).join('');
    el.innerHTML = '<div style="font-size:12px;color:var(--muted);margin-bottom:10px">' + list.length + ' of ' + customersData.length + ' patients</div>'
      + '<div class="table-wrap"><table>'
      + '<thead><tr><th>Phone</th><th>Name</th><th>Language</th><th>Appointments</th><th>Joined</th><th>Actions</th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table></div>';
  }

  /* ── Settings tab ── */
  function loadSettings() {
    apiGet("/admin/business").then(function(d) {
      var b = d.business;
      if (!b) return;
      document.getElementById("sName").value = b.name || "";
      document.getElementById("sOpenHour").value = b.openHour != null ? b.openHour : "";
      document.getElementById("sCloseHour").value = b.closeHour != null ? b.closeHour : "";
      document.getElementById("sTimezone").value = b.timezone || "";
      document.getElementById("sAptDuration").value = b.appointmentDurationMinutes != null ? b.appointmentDurationMinutes : "";
      document.getElementById("sPrompt").value = b.systemPrompt || "";
    }).catch(function() {
      showAlert("settingsAlert", "yellow", "Could not load current settings.");
    });
  }

  function submitSettings(e) {
    e.preventDefault();
    var btn = document.getElementById("sSubmitBtn");
    btn.disabled = true; btn.textContent = "Saving…";
    var payload = {};
    var name = document.getElementById("sName").value.trim();
    var openH = document.getElementById("sOpenHour").value;
    var closeH = document.getElementById("sCloseHour").value;
    var tz = document.getElementById("sTimezone").value.trim();
    var dur = document.getElementById("sAptDuration").value;
    var prompt = document.getElementById("sPrompt").value.trim();
    if (name) payload.name = name;
    if (openH !== "") payload.openHour = parseInt(openH, 10);
    if (closeH !== "") payload.closeHour = parseInt(closeH, 10);
    if (tz) payload.timezone = tz;
    if (dur !== "") payload.appointmentDurationMinutes = parseInt(dur, 10);
    if (prompt) payload.systemPrompt = prompt;
    apiPost("/admin/update-business", payload).then(function(d) {
      btn.disabled = false; btn.textContent = "💾 Save Settings";
      if (d.ok) {
        showAlert("settingsAlert", "green", "✅ Settings saved! New AI persona and hours take effect for all new conversations.");
      } else {
        showAlert("settingsAlert", "red", "Error: " + (d.error || JSON.stringify(d)));
      }
    }).catch(function(e) {
      btn.disabled = false; btn.textContent = "💾 Save Settings";
      showAlert("settingsAlert", "red", "Network error: " + e);
    });
  }

  function resetPrompt() {
    if (!confirm('Reset system prompt to the built-in default? This will overwrite your current custom prompt.')) return;
    var clinicName = document.getElementById('sName').value.trim() || 'the clinic';
    document.getElementById('sPrompt').value = [
      'You are the friendly WhatsApp AI assistant for ' + clinicName + '.',
      'Be warm, natural, and brief — WhatsApp messages should be 2-3 sentences maximum.',
      'Reply in the customer\'s language. Match their exact tone and style.',
      'NEVER copy knowledge snippet text verbatim.',
      'For appointment queries, ALWAYS call get_my_appointments before responding.',
      'For new bookings, ask for date and time if missing, then call book_appointment.',
      'Never invent availability.',
      'For greetings, reply warmly by name — no tool calls needed.'
    ].join(' ');
    showAlert('settingsAlert', 'yellow', '✏️ Default prompt loaded for "' + clinicName + '". Click Save Settings to apply.');
  }

  /* ── Auto-refresh ── */
  var refreshTimer = null;
  var refreshInterval = 30000; // 30 seconds

  function startAutoRefresh() {
    stopAutoRefresh();
    refreshTimer = setInterval(function() {
      if (currentTab === 'dashboard') loadDashboard();
      else if (currentTab === 'appointments') loadAppointmentsTab();
    }, refreshInterval);
  }

  function stopAutoRefresh() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  }

  /* ── Enter key on key modal ── */
  document.getElementById("modalKeyInput").addEventListener("keydown", function(e) {
    if (e.key === "Enter") verifyAndSaveKey();
  });
</script>
</body>
</html>`;
}
