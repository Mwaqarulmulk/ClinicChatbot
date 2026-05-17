import { beforeAll, describe, expect, it } from "bun:test";
import { bootstrapDatabase } from "../db/bootstrap";
import { bookAppointment } from "./appointments";
import { upsertCustomer } from "./customer-store";
import { config } from "../config";

describe("bookAppointment", () => {
  beforeAll(async () => {
    await bootstrapDatabase();
  });

  it("rejects appointments in the past", async () => {
    const customer = await upsertCustomer({
      businessId: config.DEFAULT_BUSINESS_ID,
      phone: "923000000001",
      language: "en",
    });

    const result = await bookAppointment({
      businessId: config.DEFAULT_BUSINESS_ID,
      customerId: customer.id,
      startsAt: new Date("2020-01-01T10:00:00+05:00"),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("past_datetime");
  });

  it("prevents duplicate active bookings for the same slot", async () => {
    const firstCustomer = await upsertCustomer({
      businessId: config.DEFAULT_BUSINESS_ID,
      phone: "923000000002",
      language: "en",
    });
    const secondCustomer = await upsertCustomer({
      businessId: config.DEFAULT_BUSINESS_ID,
      phone: "923000000003",
      language: "en",
    });
    const startsAt = new Date(Date.UTC(2099, 0, 1, 5, 0, 0, Date.now() % 1000));

    const first = await bookAppointment({
      businessId: config.DEFAULT_BUSINESS_ID,
      customerId: firstCustomer.id,
      startsAt,
    });
    const second = await bookAppointment({
      businessId: config.DEFAULT_BUSINESS_ID,
      customerId: secondCustomer.id,
      startsAt,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("slot_unavailable");
  });
});
