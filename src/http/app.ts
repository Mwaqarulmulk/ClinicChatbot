import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { and, eq, gte, sql } from "drizzle-orm";
import { config } from "../config";
import { logger } from "../logger";
import { handleInboundMessage } from "../ai/orchestrator";
import { upsertKnowledge } from "../rag/knowledge-base";
import { upcomingAppointments } from "../services/appointments";
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
  app.use("*", cors());

  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof z.ZodError)
      return c.json(
        { ok: false, error: "validation_error", issues: error.issues },
        400,
      );
    logger.error({ err: error }, "unhandled http error");
    return c.json({ ok: false, error: "internal_error" }, 500);
  });

  // ── Landing page ──────────────────────────────────────────────────────────
  app.get("/", (c) => c.html(landingPageHtml()));

  // ── Health & readiness ────────────────────────────────────────────────────
  app.get("/health", (c) =>
    c.json({
      ok: true,
      service: "whatsapp-ai-chatbot",
      whatsappEnabled: config.WHATSAPP_ENABLED,
      whatsappReady: transport.isReady(),
    }),
  );

  app.get("/ready", (c) => {
    const ready = transport.isReady();
    return c.json(
      {
        ok: ready,
        whatsappEnabled: config.WHATSAPP_ENABLED,
        whatsappReady: ready,
      },
      ready ? 200 : 503,
    );
  });

  // ── Chat test console ─────────────────────────────────────────────────────
  app.get("/chat/test", (c) =>
    c.html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Chatbot Test Console</title>
    <style>
      :root { color-scheme: light dark; font-family: Inter, Segoe UI, Arial, sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f7f9; color: #14213d; }
      main { width: min(760px, calc(100vw - 32px)); background: white; border: 1px solid #d8e0e7; border-radius: 8px; padding: 24px; box-shadow: 0 18px 50px rgba(20, 33, 61, .08); }
      h1 { font-size: 24px; margin: 0 0 16px; }
      label { display: grid; gap: 6px; font-weight: 650; margin-top: 14px; }
      input, textarea, button { font: inherit; border-radius: 6px; border: 1px solid #bcc8d4; padding: 11px 12px; }
      textarea { min-height: 110px; resize: vertical; }
      button { margin-top: 16px; background: #128c7e; color: white; border-color: #128c7e; cursor: pointer; font-weight: 700; }
      button:disabled { opacity: .65; cursor: wait; }
      pre { white-space: pre-wrap; word-break: break-word; background: #101820; color: #e8f3f1; border-radius: 8px; padding: 16px; min-height: 90px; }
      .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      @media (max-width: 640px) { .row { grid-template-columns: 1fr; } main { padding: 18px; } }
    </style>
  </head>
  <body>
    <main>
      <h1>WhatsApp AI Chatbot Test</h1>
      <div class="row">
        <label>Phone<input id="from" value="923001234573" /></label>
        <label>Name<input id="name" value="Test User" /></label>
      </div>
      <label>Message<textarea id="text">What are your business hours?</textarea></label>
      <button id="send">Send Test Message</button>
      <h2>Reply</h2>
      <pre id="output">Ready.</pre>
    </main>
    <script>
      const button = document.getElementById("send");
      const output = document.getElementById("output");
      button.addEventListener("click", async () => {
        button.disabled = true;
        output.textContent = "Sending...";
        try {
          const response = await fetch("/chat/test", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              from: document.getElementById("from").value,
              name: document.getElementById("name").value,
              text: document.getElementById("text").value
            })
          });
          const json = await response.json();
          output.textContent = JSON.stringify(json, null, 2);
        } catch (error) {
          output.textContent = String(error);
        } finally {
          button.disabled = false;
        }
      });
    </script>
  </body>
</html>`),
  );

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
    assertAdmin(c.req.header("x-admin-key"));
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
    assertAdmin(c.req.header("x-admin-key"));
    const businessId = c.req.query("businessId") ?? config.DEFAULT_BUSINESS_ID;
    const rows = await upcomingAppointments(businessId, 50);
    return c.json({ appointments: rows });
  });

  app.post("/admin/send", async (c) => {
    assertAdmin(c.req.header("x-admin-key"));
    const body = sendSchema.parse(await c.req.json());
    await transport.sendText(body.to, body.text);
    return c.json({ ok: true });
  });

  // ── Admin API — new routes ────────────────────────────────────────────────

  /** GET /admin/business — current business settings */
  app.get("/admin/business", async (c) => {
    assertAdmin(c.req.header("x-admin-key"));
    const businessId = c.req.query("businessId") ?? config.DEFAULT_BUSINESS_ID;
    const business = await db.query.businesses.findFirst({
      where: eq(businesses.id, businessId),
    });
    return c.json({ ok: true, business: business ?? null });
  });

  /** GET /admin/analytics — aggregated event stats */
  app.get("/admin/analytics", async (c) => {
    assertAdmin(c.req.header("x-admin-key"));
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
      messagesReceived: bucket("messages_received"),
      messageReplied: bucket("message_replied"),
      appointmentBooked: bucket("appointment_booked"),
      handoffCreated: bucket("handoff_created"),
      customers: { total: custRow?.total ?? 0 },
    });
  });

  /** GET /admin/customers — paginated customer list */
  app.get("/admin/customers", async (c) => {
    assertAdmin(c.req.header("x-admin-key"));
    const businessId = c.req.query("businessId") ?? config.DEFAULT_BUSINESS_ID;

    const rows = await db
      .select({
        id: customers.id,
        phone: customers.phone,
        name: customers.name,
        language: customers.language,
        createdAt: customers.createdAt,
      })
      .from(customers)
      .where(eq(customers.businessId, businessId))
      .orderBy(customers.createdAt)
      .limit(200);

    return c.json({ ok: true, customers: rows });
  });

  /** POST /admin/update-business — patch business settings */
  app.post("/admin/update-business", async (c) => {
    assertAdmin(c.req.header("x-admin-key"));
    const body = updateBusinessSchema.parse(await c.req.json());
    const businessId = config.DEFAULT_BUSINESS_ID;

    const patch: Partial<typeof businesses.$inferInsert> = {
      updatedAt: new Date().toISOString(),
    };
    if (body.name !== undefined) patch.name = body.name;
    if (body.openHour !== undefined) patch.openHour = body.openHour;
    if (body.closeHour !== undefined) patch.closeHour = body.closeHour;
    if (body.systemPrompt !== undefined) patch.systemPrompt = body.systemPrompt;

    await db.update(businesses).set(patch).where(eq(businesses.id, businessId));

    return c.json({ ok: true });
  });

  /** POST /admin/update-appointment — cancel or update an appointment */
  app.post("/admin/update-appointment", async (c) => {
    assertAdmin(c.req.header("x-admin-key"));
    const body = updateAppointmentSchema.parse(await c.req.json());

    await db
      .update(appointments)
      .set({ status: body.status, updatedAt: new Date().toISOString() })
      .where(eq(appointments.id, body.id));

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
});

const updateAppointmentSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["scheduled", "cancelled", "completed", "no_show"]),
});

// ── Auth helper ───────────────────────────────────────────────────────────────

function assertAdmin(key: string | undefined) {
  if (!config.ADMIN_API_KEY) {
    throw new HTTPException(503, {
      message: "admin endpoints disabled — set the ADMIN_API_KEY secret",
    });
  }
  if (key !== config.ADMIN_API_KEY) {
    throw new HTTPException(401, { message: "admin key required" });
  }
}

// ── HTML pages ────────────────────────────────────────────────────────────────

function landingPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Clinic Chatbot</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0d1117; --surface: #161b22; --surface2: #1c2128;
      --border: #30363d; --green: #25d366; --green-dark: #1aab53;
      --text: #e6edf3; --muted: #8b949e; --red: #f85149;
      --blue: #58a6ff; --yellow: #d29922;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    body { background: var(--bg); color: var(--text); min-height: 100vh; }

    /* NAV */
    nav {
      position: sticky; top: 0; z-index: 100;
      background: rgba(13,17,23,.92); backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between;
      padding: 0 24px; height: 60px;
    }
    .brand { display: flex; align-items: center; gap: 10px; font-size: 18px; font-weight: 700; color: var(--green); text-decoration: none; }
    .nav-actions { display: flex; gap: 10px; }
    .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; text-decoration: none; border: none; transition: .15s; }
    .btn-outline { background: transparent; color: var(--text); border: 1px solid var(--border); }
    .btn-outline:hover { border-color: var(--green); color: var(--green); }
    .btn-green { background: var(--green); color: #000; }
    .btn-green:hover { background: var(--green-dark); }

    /* HERO */
    .hero { text-align: center; padding: 80px 24px 40px; }
    .hero-badge { display: inline-flex; align-items: center; gap: 6px; background: rgba(37,211,102,.12); color: var(--green); border: 1px solid rgba(37,211,102,.25); border-radius: 99px; padding: 5px 14px; font-size: 13px; font-weight: 600; margin-bottom: 24px; }
    .hero h1 { font-size: clamp(32px,6vw,60px); font-weight: 800; line-height: 1.1; margin-bottom: 16px; }
    .hero h1 span { color: var(--green); }
    .hero p { font-size: 18px; color: var(--muted); max-width: 560px; margin: 0 auto 32px; line-height: 1.6; }

    /* STATUS BAR */
    .status-bar {
      display: flex; flex-wrap: wrap; align-items: center; justify-content: center;
      gap: 16px; background: var(--surface); border: 1px solid var(--border);
      border-radius: 12px; padding: 14px 24px; max-width: 800px; margin: 0 auto 48px;
    }
    .status-item { display: flex; align-items: center; gap: 8px; font-size: 14px; }
    .badge { display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; border-radius: 99px; font-size: 12px; font-weight: 600; }
    .badge-green { background: rgba(37,211,102,.15); color: var(--green); }
    .badge-red { background: rgba(248,81,73,.15); color: var(--red); }
    .badge-yellow { background: rgba(210,153,34,.15); color: var(--yellow); }
    .badge-blue { background: rgba(88,166,255,.15); color: var(--blue); }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }

    /* MAIN LAYOUT */
    .container { max-width: 1100px; margin: 0 auto; padding: 0 24px 64px; }

    /* STAT CARDS */
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 40px; }
    .stat-card {
      background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
      padding: 20px 24px; transition: border-color .2s;
    }
    .stat-card:hover { border-color: var(--green); }
    .stat-icon { font-size: 28px; margin-bottom: 10px; }
    .stat-label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; font-weight: 600; margin-bottom: 6px; }
    .stat-value { font-size: 16px; font-weight: 700; color: var(--text); }
    .stat-sub { font-size: 12px; color: var(--muted); margin-top: 3px; }

    /* TWO-COL LAYOUT */
    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
    @media (max-width: 768px) { .two-col { grid-template-columns: 1fr; } }

    .panel {
      background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
      padding: 24px;
    }
    .panel-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
    .panel-title { font-size: 15px; font-weight: 700; }

    /* APPOINTMENTS */
    .apt-list { display: flex; flex-direction: column; gap: 10px; }
    .apt-item { display: flex; align-items: center; gap: 12px; background: var(--surface2); border-radius: 8px; padding: 12px 14px; }
    .apt-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); flex-shrink: 0; }
    .apt-info { flex: 1; min-width: 0; }
    .apt-service { font-size: 14px; font-weight: 600; }
    .apt-time { font-size: 12px; color: var(--muted); margin-top: 2px; }
    .apt-empty { font-size: 14px; color: var(--muted); text-align: center; padding: 24px 0; }

    /* QUICK ACTIONS */
    .actions-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .action-card {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 8px; background: var(--surface2); border: 1px solid var(--border);
      border-radius: 10px; padding: 20px 12px; text-decoration: none; color: var(--text);
      font-size: 13px; font-weight: 600; text-align: center; transition: .15s; cursor: pointer;
    }
    .action-card:hover { border-color: var(--green); background: rgba(37,211,102,.06); color: var(--green); }
    .action-icon { font-size: 24px; }

    /* ADMIN KEY PROMPT */
    .key-prompt { background: var(--surface2); border: 1px solid var(--yellow); border-radius: 10px; padding: 16px 20px; margin-bottom: 20px; font-size: 14px; }
    .key-prompt strong { color: var(--yellow); }
    .key-input-row { display: flex; gap: 8px; margin-top: 10px; }
    .key-input { flex: 1; background: var(--bg); border: 1px solid var(--border); border-radius: 7px; padding: 8px 12px; color: var(--text); font: inherit; font-size: 14px; outline: none; }
    .key-input:focus { border-color: var(--green); }

    /* FOOTER */
    footer { border-top: 1px solid var(--border); padding: 24px; text-align: center; font-size: 13px; color: var(--muted); }
    footer a { color: var(--green); text-decoration: none; }

    /* LOADING SPINNER */
    .spinner { width: 20px; height: 20px; border: 2px solid var(--border); border-top-color: var(--green); border-radius: 50%; animation: spin .7s linear infinite; margin: 24px auto; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <nav>
    <a class="brand" href="/"><span>💬</span> Clinic Chatbot</a>
    <div class="nav-actions">
      <a class="btn btn-outline" href="/chat/test">🧪 Test Chat</a>
      <a class="btn btn-green" href="/admin">⚙️ Admin Panel</a>
    </div>
  </nav>

  <div class="hero">
    <div class="hero-badge"><span class="dot"></span> Production</div>
    <h1>WhatsApp AI <span>Clinic Bot</span></h1>
    <p>Automated appointment booking, patient support, and seamless human handoff — powered by Groq LLaMA 3.3 70B.</p>

    <div class="status-bar" id="statusBar">
      <div class="status-item">
        <span>🏥</span>
        <strong id="clinicName">Loading…</strong>
      </div>
      <div class="status-item">
        <span>WhatsApp:</span>
        <span class="badge badge-yellow" id="waBadge"><span class="dot"></span> checking…</span>
      </div>
      <div class="status-item">
        <span>AI:</span>
        <span class="badge badge-blue"><span class="dot"></span> Groq LLaMA 3.3</span>
      </div>
      <div class="status-item">
        <span>Uptime:</span>
        <span class="badge badge-green" id="uptimeBadge"><span class="dot"></span> online</span>
      </div>
    </div>
  </div>

  <div class="container">
    <!-- Stat cards -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon">📱</div>
        <div class="stat-label">WhatsApp Status</div>
        <div class="stat-value" id="waStatusCard">Checking…</div>
        <div class="stat-sub" id="waStatusSub">WhatsApp Business API</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">🤖</div>
        <div class="stat-label">AI Model</div>
        <div class="stat-value">Groq LLaMA 3.3 70B</div>
        <div class="stat-sub">llama-3.3-70b-versatile</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">🚀</div>
        <div class="stat-label">Deployment</div>
        <div class="stat-value">Fly.io — ams</div>
        <div class="stat-sub">Amsterdam region</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">🔗</div>
        <div class="stat-label">API Endpoint</div>
        <div class="stat-value" id="apiEndpoint" style="font-size:13px;word-break:break-all;">—</div>
        <div class="stat-sub">REST / Webhook</div>
      </div>
    </div>

    <!-- Two-column -->
    <div class="two-col">
      <!-- Appointments -->
      <div class="panel">
        <div class="panel-header">
          <span class="panel-title">📅 Upcoming Appointments</span>
          <button class="btn btn-outline" style="font-size:12px;padding:5px 10px;" onclick="loadAppointments()">Refresh</button>
        </div>
        <div id="keyPrompt" class="key-prompt" style="display:none">
          <strong>⚠️ Admin key required</strong> to view appointments.
          <div class="key-input-row">
            <input class="key-input" id="keyInput" type="password" placeholder="Enter ADMIN_API_KEY…" />
            <button class="btn btn-green" style="font-size:13px;padding:8px 14px;" onclick="saveKey()">Save</button>
          </div>
        </div>
        <div class="apt-list" id="aptList"><div class="spinner"></div></div>
      </div>

      <!-- Quick actions -->
      <div class="panel">
        <div class="panel-header"><span class="panel-title">⚡ Quick Actions</span></div>
        <div class="actions-grid">
          <a class="action-card" href="/chat/test"><span class="action-icon">🧪</span>Test Chat</a>
          <a class="action-card" href="/admin"><span class="action-icon">🎛️</span>Admin Panel</a>
          <a class="action-card" href="/admin#knowledge"><span class="action-icon">📚</span>Knowledge Base</a>
          <a class="action-card" href="/admin#messages"><span class="action-icon">📨</span>Send Message</a>
          <a class="action-card" href="/admin#appointments"><span class="action-icon">📅</span>Appointments</a>
          <a class="action-card" href="/admin#settings"><span class="action-icon">⚙️</span>Settings</a>
        </div>
      </div>
    </div>
  </div>

  <footer>
    Powered by <a href="https://groq.com" target="_blank">Groq</a> ·
    <a href="https://fly.io" target="_blank">Fly.io</a> ·
    <a href="https://github.com/whiskeysockets/baileys" target="_blank">Baileys</a> ·
    <a href="https://hono.dev" target="_blank">Hono</a>
  </footer>

  <script>
    var adminKey = localStorage.getItem("adminKey");

    // Fetch health
    fetch("/health").then(function(r){ return r.json(); }).then(function(d){
      document.getElementById("clinicName").textContent = "Clinic Chatbot";
      document.getElementById("apiEndpoint").textContent = location.origin;
      var waReady = d.whatsappReady;
      var badge = document.getElementById("waBadge");
      var card = document.getElementById("waStatusCard");
      var sub = document.getElementById("waStatusSub");
      if (waReady) {
        badge.className = "badge badge-green";
        badge.innerHTML = '<span class="dot"></span> Online';
        card.textContent = "Connected";
        sub.textContent = "WhatsApp session active";
      } else if (!d.whatsappEnabled) {
        badge.className = "badge badge-yellow";
        badge.innerHTML = '<span class="dot"></span> Disabled';
        card.textContent = "Disabled";
        sub.textContent = "WHATSAPP_ENABLED=false";
      } else {
        badge.className = "badge badge-red";
        badge.innerHTML = '<span class="dot"></span> Offline';
        card.textContent = "Not connected";
        sub.textContent = "Scan QR to connect";
      }
    }).catch(function(){
      document.getElementById("uptimeBadge").className = "badge badge-red";
      document.getElementById("uptimeBadge").innerHTML = '<span class="dot"></span> error';
    });

    function loadAppointments() {
      var key = localStorage.getItem("adminKey");
      if (!key) {
        document.getElementById("keyPrompt").style.display = "block";
        document.getElementById("aptList").innerHTML = "";
        return;
      }
      document.getElementById("keyPrompt").style.display = "none";
      document.getElementById("aptList").innerHTML = '<div class="spinner"></div>';
      fetch("/admin/appointments", { headers: { "x-admin-key": key } })
        .then(function(r){ return r.json(); })
        .then(function(d){
          var apts = d.appointments || [];
          if (apts.length === 0) {
            document.getElementById("aptList").innerHTML = '<p class="apt-empty">No upcoming appointments.</p>';
            return;
          }
          var html = "";
          apts.slice(0,8).forEach(function(a){
            var dt = new Date(a.startsAt);
            var dateStr = dt.toLocaleDateString(undefined, {weekday:"short",month:"short",day:"numeric"});
            var timeStr = dt.toLocaleTimeString(undefined, {hour:"2-digit",minute:"2-digit"});
            html += '<div class="apt-item"><div class="apt-dot"></div><div class="apt-info">'
              + '<div class="apt-service">' + escHtml(a.service || "consultation") + '</div>'
              + '<div class="apt-time">' + dateStr + " at " + timeStr + '</div>'
              + '</div></div>';
          });
          document.getElementById("aptList").innerHTML = html;
        })
        .catch(function(e){
          document.getElementById("aptList").innerHTML = '<p class="apt-empty" style="color:var(--red)">Failed to load: ' + escHtml(String(e)) + '</p>';
        });
    }

    function saveKey() {
      var val = document.getElementById("keyInput").value.trim();
      if (!val) return;
      localStorage.setItem("adminKey", val);
      adminKey = val;
      loadAppointments();
    }

    function escHtml(s) {
      return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    }

    loadAppointments();
  </script>
</body>
</html>`;
}

// ── Admin dashboard SPA ───────────────────────────────────────────────────────

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
</div>

<!-- MESSAGES TAB -->
<div class="tab-content" id="tab-messages">
  <div class="panel">
    <div class="panel-title">📨 Send WhatsApp Message</div>
    <div id="sendAlert"></div>
    <form id="sendForm" onsubmit="submitSend(event)">
      <div class="form-group">
        <label class="form-label">Phone Number</label>
        <input class="form-control" id="sendTo" type="text" placeholder="923001234567 (international format, no +)" required />
        <div class="form-hint">Include country code without + or spaces. E.g. 923001234567</div>
      </div>
      <div class="form-group">
        <label class="form-label">Message</label>
        <textarea class="form-control" id="sendText" placeholder="Type your message here…" required></textarea>
      </div>
      <button class="btn btn-green" type="submit" id="sendBtn">📤 Send Message</button>
    </form>
  </div>
</div>

<!-- CUSTOMERS TAB -->
<div class="tab-content" id="tab-customers">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
    <h2 style="font-size:20px;font-weight:800;">Customers</h2>
    <button class="btn btn-outline" onclick="loadCustomers()">↺ Refresh</button>
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
        <input class="form-control" id="sName" type="text" placeholder="e.g. My Clinic" />
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Opening Hour (0–23)</label>
          <input class="form-control" id="sOpenHour" type="number" min="0" max="23" placeholder="9" />
          <div class="form-hint">24-hour format</div>
        </div>
        <div class="form-group">
          <label class="form-label">Closing Hour (1–24)</label>
          <input class="form-control" id="sCloseHour" type="number" min="1" max="24" placeholder="18" />
          <div class="form-hint">24-hour format</div>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">System Prompt</label>
        <textarea class="form-control" id="sPrompt" style="min-height:180px;" placeholder="You are a helpful clinic assistant…"></textarea>
        <div class="form-hint">This defines the AI's personality and instructions.</div>
      </div>
      <button class="btn btn-green" type="submit" id="sSubmitBtn">💾 Save Settings</button>
    </form>
  </div>
</div>

<script>
  /* ── State ── */
  var adminKey = localStorage.getItem("adminKey") || "";
  var currentTab = "dashboard";

  /* ── Init ── */
  (function init() {
    if (!adminKey) {
      document.getElementById("keyModal").classList.remove("hidden");
    } else {
      document.getElementById("keyModal").classList.add("hidden");
      updateKeyIndicator();
      loadDashboard();
    }
    // Handle hash-based navigation from landing page
    var hash = location.hash.replace("#","");
    if (hash && ["dashboard","appointments","knowledge","messages","customers","settings"].indexOf(hash) !== -1) {
      switchTab(hash);
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
    btn.disabled = true;
    btn.textContent = "Verifying…";
    fetch("/admin/appointments", { headers: { "x-admin-key": val } })
      .then(function(r) {
        btn.disabled = false;
        btn.textContent = "Unlock Dashboard";
        if (r.ok) {
          adminKey = val;
          localStorage.setItem("adminKey", val);
          document.getElementById("keyModal").classList.add("hidden");
          document.getElementById("keyModalError").style.display = "none";
          updateKeyIndicator();
          loadDashboard();
        } else {
          document.getElementById("keyModalError").style.display = "block";
        }
      })
      .catch(function() {
        btn.disabled = false;
        btn.textContent = "Unlock Dashboard";
        document.getElementById("keyModalError").style.display = "block";
        document.getElementById("keyModalError").textContent = "Network error — is the server running?";
      });
  }

  /* ── Tab switching ── */
  var tabLoaders = {
    appointments: loadAppointmentsTab,
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
  function fmtDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    return d.toLocaleDateString(undefined, {weekday:"short",month:"short",day:"numeric"})
      + " " + d.toLocaleTimeString(undefined, {hour:"2-digit",minute:"2-digit"});
  }

  /* ── Dashboard ── */
  function loadDashboard() {
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
      var actions = showActions
        ? '<button class="btn btn-red btn-sm" onclick="cancelApt(\'' + escHtml(a.id) + '\')">✕ Cancel</button>'
        : '';
      return '<tr><td>' + escHtml(dt) + '</td><td>' + escHtml(a.service || "consultation")
        + '</td><td style="font-family:monospace;font-size:12px">' + escHtml(a.customerId)
        + '</td><td>' + statusBadge + '</td>'
        + (showActions ? '<td>' + actions + '</td>' : '')
        + '</tr>';
    }).join("");
    var actionHeader = showActions ? '<th>Actions</th>' : '';
    return '<table><thead><tr><th>Date / Time</th><th>Service</th><th>Customer ID</th><th>Status</th>'
      + actionHeader + '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function cancelApt(id) {
    if (!confirm("Cancel this appointment?")) return;
    apiPost("/admin/update-appointment", { id: id, status: "cancelled" }).then(function(d) {
      if (d.ok) loadAppointmentsTab();
      else alert("Failed: " + (d.error || "unknown error"));
    }).catch(function(e) { alert("Error: " + e); });
  }

  /* ── Knowledge tab ── */
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
        showAlert("knowledgeAlert", "green", "✅ Saved " + (d.chunks || 1) + " chunk(s) to the knowledge base.");
        document.getElementById("knowledgeForm").reset();
      } else {
        showAlert("knowledgeAlert", "red", "Error: " + (d.error || JSON.stringify(d)));
      }
    }).catch(function(e) {
      btn.disabled = false; btn.textContent = "💾 Save to Knowledge Base";
      showAlert("knowledgeAlert", "red", "Network error: " + e);
    });
  }

  /* ── Messages tab ── */
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
  function loadCustomers() {
    var el = document.getElementById("customersContent");
    el.innerHTML = '<div class="loading-area"><div class="spinner"></div> Loading…</div>';
    apiGet("/admin/customers").then(function(d) {
      var list = d.customers || [];
      if (list.length === 0) {
        el.innerHTML = '<div class="empty"><div class="empty-icon">👤</div>No customers yet.</div>';
        return;
      }
      var rows = list.map(function(c) {
        return '<tr>'
          + '<td style="font-family:monospace;font-size:12px">' + escHtml(c.phone) + '</td>'
          + '<td>' + escHtml(c.name || "—") + '</td>'
          + '<td><span class="badge badge-blue">' + escHtml(c.language || "en") + '</span></td>'
          + '<td style="font-size:12px;color:var(--muted)">' + escHtml(c.createdAt ? new Date(c.createdAt).toLocaleDateString() : "—") + '</td>'
          + '</tr>';
      }).join("");
      el.innerHTML = '<div class="table-wrap"><table>'
        + '<thead><tr><th>Phone</th><th>Name</th><th>Language</th><th>Joined</th></tr></thead>'
        + '<tbody>' + rows + '</tbody></table></div>';
    }).catch(function(e) {
      el.innerHTML = '<div class="empty" style="color:var(--red)">Error: ' + escHtml(String(e)) + '</div>';
    });
  }

  /* ── Settings tab ── */
  function loadSettings() {
    apiGet("/admin/business").then(function(d) {
      var b = d.business;
      if (!b) return;
      document.getElementById("sName").value = b.name || "";
      document.getElementById("sOpenHour").value = b.openHour != null ? b.openHour : "";
      document.getElementById("sCloseHour").value = b.closeHour != null ? b.closeHour : "";
      document.getElementById("sPrompt").value = b.systemPrompt || "";
    }).catch(function() {
      showAlert("settingsAlert", "yellow", "Could not load current settings — form is empty.");
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
    var prompt = document.getElementById("sPrompt").value.trim();
    if (name) payload.name = name;
    if (openH !== "") payload.openHour = parseInt(openH, 10);
    if (closeH !== "") payload.closeHour = parseInt(closeH, 10);
    if (prompt) payload.systemPrompt = prompt;
    apiPost("/admin/update-business", payload).then(function(d) {
      btn.disabled = false; btn.textContent = "💾 Save Settings";
      if (d.ok) {
        showAlert("settingsAlert", "green", "✅ Business settings saved successfully.");
      } else {
        showAlert("settingsAlert", "red", "Error: " + (d.error || JSON.stringify(d)));
      }
    }).catch(function(e) {
      btn.disabled = false; btn.textContent = "💾 Save Settings";
      showAlert("settingsAlert", "red", "Network error: " + e);
    });
  }

  /* ── Enter key on key modal ── */
  document.getElementById("modalKeyInput").addEventListener("keydown", function(e) {
    if (e.key === "Enter") verifyAndSaveKey();
  });
</script>
</body>
</html>`;
}
