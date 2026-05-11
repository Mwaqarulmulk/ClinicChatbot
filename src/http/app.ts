import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { config } from "../config";
import { handleInboundMessage } from "../ai/orchestrator";
import { upsertKnowledge } from "../rag/knowledge-base";
import { upcomingAppointments } from "../services/appointments";
import type { WhatsAppTransport } from "../types";
import { WindowGuard } from "../utils/window-guard";

export function createApp(transport: WhatsAppTransport) {
  const app = new Hono();
  const testChatGuard = new WindowGuard(30, 60_000);
  app.use("*", cors());

  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof z.ZodError) return c.json({ ok: false, error: "validation_error", issues: error.issues }, 400);
    console.error(error);
    return c.json({ ok: false, error: "internal_error" }, 500);
  });

  app.get("/health", (c) =>
    c.json({
      ok: true,
      service: "whatsapp-ai-chatbot",
      whatsappEnabled: config.WHATSAPP_ENABLED,
      whatsappReady: transport.isReady(),
      whatsapp: transport.isReady()
    })
  );

  app.get("/ready", (c) =>
    c.json({
      ok: transport.isReady(),
      whatsappEnabled: config.WHATSAPP_ENABLED,
      whatsappReady: transport.isReady(),
      whatsapp: transport.isReady()
    }, transport.isReady() ? 200 : 503)
  );

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
</html>`)
  );

  app.post("/chat/test", async (c) => {
    const body = testChatSchema.parse(await c.req.json());
    if (!testChatGuard.allow(body.from)) throw new HTTPException(429, { message: "rate limit exceeded" });
    const reply = await handleInboundMessage({
      businessId: body.businessId ?? config.DEFAULT_BUSINESS_ID,
      channel: "api",
      from: body.from,
      name: body.name,
      text: body.text,
      timestamp: new Date()
    });
    return c.json(reply);
  });

  app.post("/admin/knowledge", async (c) => {
    assertAdmin(c.req.header("x-admin-key"));
    const body = knowledgeSchema.parse(await c.req.json());
    const chunks = await upsertKnowledge({
      businessId: body.businessId ?? config.DEFAULT_BUSINESS_ID,
      title: body.title,
      content: body.content,
      source: body.source ?? "api"
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

  return app;
}

function assertAdmin(key: string | undefined) {
  if (config.ADMIN_API_KEY && key !== config.ADMIN_API_KEY) {
    throw new HTTPException(401, { message: "admin key required" });
  }
}

const testChatSchema = z.object({
  businessId: z.string().optional(),
  from: z.string().default("test-user"),
  name: z.string().optional(),
  text: z.string().min(1)
});

const knowledgeSchema = z.object({
  businessId: z.string().optional(),
  title: z.string().min(1),
  content: z.string().min(1),
  source: z.string().optional()
});

const sendSchema = z.object({
  to: z.string().min(5),
  text: z.string().min(1)
});
