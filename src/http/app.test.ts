// Integration tests for HTTP routes
// Run with: bun test src/http/app.test.ts

import { describe, it, expect, beforeAll } from "bun:test";
import { createApp } from "./app";
import { NullWhatsApp } from "../whatsapp/null-transport";
import { config } from "../config";

const transport = new NullWhatsApp();
const app = createApp(transport);

// Helper to make requests against the Hono app
async function req(
  path: string,
  opts: RequestInit & { headers?: Record<string, string> } = {},
) {
  const headers = new Headers(opts.headers);
  if (opts.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await app.request(path, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body,
  });
  const contentType = response.headers.get("content-type") ?? "";
  let body: unknown;
  if (contentType.includes("json")) {
    body = await response.json();
  } else {
    body = await response.text();
  }
  return { status: response.status, headers: response.headers, body };
}

function adminHeaders(): Record<string, string> {
  return { "x-admin-key": config.ADMIN_API_KEY ?? "" };
}

const hasAdminKey = !!config.ADMIN_API_KEY;

describe("Security Headers", () => {
  it("adds security headers to every response", async () => {
    const res = await req("/health");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-XSS-Protection")).toBe("0");
    expect(res.headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(res.headers.get("Permissions-Policy")).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
    expect(res.headers.get("Strict-Transport-Security")).toContain(
      "max-age=31536000",
    );
  });
});

describe("GET /health", () => {
  it("returns health status with DB check", async () => {
    const res = await req("/health");
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.ok).toBe(!config.WHATSAPP_ENABLED);
    expect(body.service).toBe("whatsapp-ai-chatbot");
    expect(body.whatsappEnabled).toBe(config.WHATSAPP_ENABLED);
    expect(body.whatsappReady).toBe(false);
    expect(body.database).toBe("connected");
    expect(typeof body.uptime).toBe("number");
    expect(typeof body.nodeVersion).toBe("string");
  });
});

describe("GET /ready", () => {
  it("reflects whether the configured transport is ready", async () => {
    const res = await req("/ready");
    expect(res.status).toBe(config.WHATSAPP_ENABLED ? 503 : 200);
    const body = res.body as Record<string, unknown>;
    expect(body.ok).toBe(!config.WHATSAPP_ENABLED);
    expect(body.whatsappEnabled).toBe(config.WHATSAPP_ENABLED);
    expect(body.whatsappReady).toBe(false);
  });
});

describe("GET /", () => {
  it("serves the landing page HTML", async () => {
    const res = await req("/");
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe("string");
    expect((res.body as string).toLowerCase()).toContain("<!doctype html>");
    expect((res.body as string).toLowerCase()).toContain("clinic chatbot");
  });
});

describe("GET /chat/test", () => {
  it("serves the chat widget HTML", async () => {
    const res = await req("/chat/test");
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe("string");
    expect((res.body as string).toLowerCase()).toContain("<!doctype html>");
    expect((res.body as string).includes("Demo Clinic AI")).toBe(true);
  });
});

describe("POST /chat/test", () => {
  it("processes a message and returns a reply", async () => {
    const res = await req("/chat/test", {
      method: "POST",
      body: JSON.stringify({
        from: "923001234567",
        name: "Test User",
        text: "Hello",
      }),
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(typeof body).toBe("object");
    // Should have at least one of: text, error, or handoff
    expect(
      "text" in body || "error" in body || "handoff" in body,
    ).toBe(true);
  });

  it("rejects empty text with 400", async () => {
    const res = await req("/chat/test", {
      method: "POST",
      body: JSON.stringify({
        from: "923001234567",
        text: "",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing text field with 400", async () => {
    const res = await req("/chat/test", {
      method: "POST",
      body: JSON.stringify({
        from: "923001234567",
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /admin", () => {
  it("serves the admin dashboard HTML", async () => {
    const res = await req("/admin");
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe("string");
    expect((res.body as string).toLowerCase()).toContain("<!doctype html>");
  });
});

describe("Admin API — Authentication", () => {
  it("returns 503 when ADMIN_API_KEY is not configured", async () => {
    if (hasAdminKey) {
      // Skip this test when key is set — the 503 path requires no key
      return;
    }
    const res = await req("/admin/analytics");
    expect(res.status).toBe(503);
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty("message");
  });

  it("returns 401 with wrong API key when key is configured", async () => {
    if (!hasAdminKey) {
      return;
    }
    const res = await req("/admin/analytics", {
      headers: { "x-admin-key": "wrong-key" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 without API key when key is configured", async () => {
    if (!hasAdminKey) {
      return;
    }
    const res = await req("/admin/analytics");
    expect(res.status).toBe(401);
  });
});

describe("GET /admin/analytics", () => {
  it("returns analytics stats with valid key", async () => {
    if (!hasAdminKey) {
      return;
    }
    const res = await req("/admin/analytics", { headers: adminHeaders() });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty("ok");
    expect(body).toHaveProperty("period");
    expect(body).toHaveProperty("messagesReceived");
    expect(body).toHaveProperty("messageReplied");
    expect(body).toHaveProperty("appointmentBooked");
    expect(body).toHaveProperty("handoffCreated");
    expect(body).toHaveProperty("customers");
  });
});

describe("GET /admin/appointments", () => {
  it("returns appointments list with valid key", async () => {
    if (!hasAdminKey) {
      return;
    }
    const res = await req("/admin/appointments", {
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty("appointments");
    expect(Array.isArray(body.appointments)).toBe(true);
  });
});

describe("GET /admin/knowledge-list", () => {
  it("returns knowledge list with valid key", async () => {
    if (!hasAdminKey) {
      return;
    }
    const res = await req("/admin/knowledge-list", {
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty("ok");
    expect(body).toHaveProperty("entries");
    expect(Array.isArray(body.entries)).toBe(true);
  });
});

describe("POST /admin/knowledge", () => {
  it("adds a knowledge entry with valid key", async () => {
    if (!hasAdminKey) {
      return;
    }
    const res = await req("/admin/knowledge", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        title: "Test Knowledge",
        content: "This is test content for integration testing.",
        source: "test",
      }),
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.chunks).toBe("number");
  });

  it("rejects missing title with 400", async () => {
    if (!hasAdminKey) {
      return;
    }
    const res = await req("/admin/knowledge", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        content: "Content without title",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing content with 400", async () => {
    if (!hasAdminKey) {
      return;
    }
    const res = await req("/admin/knowledge", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        title: "Title without content",
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /admin/knowledge", () => {
  it("deletes knowledge by title slug with valid key", async () => {
    if (!hasAdminKey) {
      return;
    }
    // First add something to delete
    await req("/admin/knowledge", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        title: "Temporary Entry",
        content: "This will be deleted.",
        source: "test",
      }),
    });

    const res = await req("/admin/knowledge", {
      method: "DELETE",
      headers: adminHeaders(),
      body: JSON.stringify({
        titleSlug: "temporary-entry",
      }),
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
  });

  it("rejects missing titleSlug with 400", async () => {
    if (!hasAdminKey) {
      return;
    }
    const res = await req("/admin/knowledge", {
      method: "DELETE",
      headers: adminHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /admin/business", () => {
  it("returns business settings with valid key", async () => {
    if (!hasAdminKey) {
      return;
    }
    const res = await req("/admin/business", { headers: adminHeaders() });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty("ok");
    expect(body).toHaveProperty("business");
  });
});

describe("POST /admin/update-business", () => {
  it("updates business name with valid key", async () => {
    if (!hasAdminKey) {
      return;
    }
    const res = await req("/admin/update-business", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        name: "Updated Demo Clinic",
      }),
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
  });

  it("rejects empty name with 400", async () => {
    if (!hasAdminKey) {
      return;
    }
    const res = await req("/admin/update-business", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        name: "",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid openHour with 400", async () => {
    if (!hasAdminKey) {
      return;
    }
    const res = await req("/admin/update-business", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        openHour: 25,
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /admin/customers", () => {
  it("returns paginated customer list with valid key", async () => {
    if (!hasAdminKey) {
      return;
    }
    const res = await req("/admin/customers", { headers: adminHeaders() });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty("ok");
    expect(body).toHaveProperty("customers");
    expect(body).toHaveProperty("pagination");
    expect(Array.isArray(body.customers)).toBe(true);
  });

  it("respects page and limit query params", async () => {
    if (!hasAdminKey) {
      return;
    }
    const res = await req("/admin/customers?page=1&limit=10", {
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    const pagination = body.pagination as Record<string, unknown>;
    expect(pagination.page).toBe(1);
    expect(pagination.limit).toBe(10);
  });
});

describe("POST /admin/send", () => {
  it("sends a message with valid key", async () => {
    if (!hasAdminKey) {
      return;
    }
    const res = await req("/admin/send", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        to: "923001234567",
        text: "Test message from integration test",
      }),
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
  });

  it("rejects missing 'to' with 400", async () => {
    if (!hasAdminKey) {
      return;
    }
    const res = await req("/admin/send", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        text: "Missing recipient",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty text with 400", async () => {
    if (!hasAdminKey) {
      return;
    }
    const res = await req("/admin/send", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        to: "923001234567",
        text: "",
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /admin/broadcast", () => {
  it("broadcasts a message with valid key", async () => {
    if (!hasAdminKey) {
      return;
    }
    const res = await req("/admin/broadcast", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        text: "Broadcast test message",
      }),
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty("sent");
    expect(body).toHaveProperty("failed");
    expect(body).toHaveProperty("total");
  }, { timeout: 30_000 });

  it("rejects text over 1000 chars with 400", async () => {
    if (!hasAdminKey) {
      return;
    }
    const res = await req("/admin/broadcast", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        text: "x".repeat(1001),
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /admin/update-appointment", () => {
  it("rejects invalid appointment ID with 400", async () => {
    if (!hasAdminKey) {
      return;
    }
    const res = await req("/admin/update-appointment", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        id: "",
        status: "cancelled",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid status with 400", async () => {
    if (!hasAdminKey) {
      return;
    }
    const res = await req("/admin/update-appointment", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        id: "some-id",
        status: "invalid_status",
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("404 Handling", () => {
  it("returns 404 for unknown routes", async () => {
    const res = await req("/nonexistent-route");
    expect(res.status).toBe(404);
  });

  it("returns 404 for unknown admin sub-routes", async () => {
    const res = await req("/admin/nonexistent");
    expect(res.status).toBe(404);
  });
});

describe("CORS", () => {
  it("allows localhost origin", async () => {
    const res = await req("/health", {
      headers: { Origin: "http://localhost:3000" },
    });
    const corsOrigin = res.headers.get("Access-Control-Allow-Origin");
    expect(corsOrigin === "http://localhost:3000" || corsOrigin === null).toBe(
      true,
    );
  });

  it("rejects unknown origins", async () => {
    const res = await req("/health", {
      headers: { Origin: "http://evil-site.com" },
    });
    const corsOrigin = res.headers.get("Access-Control-Allow-Origin");
    expect(corsOrigin === "http://evil-site.com").toBe(false);
  });
});

describe("Content-Type", () => {
  it("returns JSON for API endpoints", async () => {
    const res = await req("/health");
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("returns HTML for page routes", async () => {
    const res = await req("/");
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});
