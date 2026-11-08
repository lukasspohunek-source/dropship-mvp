import type { Repo } from "./db.js";
import type { Store, Supplier, SupplierLine } from "./types.js";

export interface TrackingConfig {
  notifyCustomer: boolean;
  unpaidWarnHours: number;
  urlTemplate: string;
}

export interface SyncResult {
  checked: number;
  fulfilled: number;
  errors: number;
}

export class TrackingService {
  private running = false;

  constructor(
    private repo: Repo,
    private supplier: Supplier,
    private storeFor: (shopId: number) => Store,
    private cfg: TrackingConfig,
    private now: () => Date = () => new Date(),
  ) {}

  async syncAll(): Promise<SyncResult> {
    if (this.running) return { checked: 0, fulfilled: 0, errors: 0 };
    this.running = true;
    const res: SyncResult = { checked: 0, fulfilled: 0, errors: 0 };
    try {
      for (const s of this.repo.openShipments()) {
        res.checked++;
        try {
          if (await this.syncShipment(s.id, s.order_id, s.ae_order_id, s.unpaid_warned === 1)) res.fulfilled++;
        } catch (e) {
          res.errors++;
          const msg = (e as Error).message;
          this.repo.setShipmentError(s.id, msg);
          this.repo.log(s.order_id, "error", `Tracking AE ${s.ae_order_id}: ${msg}`);
        }
      }
    } finally {
      this.running = false;
    }
    return res;
  }

  /** Vrací true, pokud byla zásilka právě vyřízena v Shopify. */
  private async syncShipment(shipmentId: number, orderId: number, aeOrderId: string, warned: boolean): Promise<boolean> {
    const order = this.repo.getOrder(orderId);
    if (!order) throw new Error("Objednávka zmizela z DB");
    const info = await this.supplier.getOrder(aeOrderId);
    const first = info.tracking[0];
    this.repo.updateShipmentStatus(shipmentId, {
      aeOrderStatus: info.orderStatus,
      logisticsStatus: info.logisticsStatus,
      trackingNumber: first?.number ?? null,
      carrier: first?.carrier ?? null,
      aeAmount: info.orderAmount?.amount ?? null,
      aeCurrency: info.orderAmount?.currency ?? null,
    });

    // PLACE_ORDER_SUCCESS dlouho po vytvoření obvykle znamená nezaplaceno – upozorni.
    if (!warned && info.orderStatus === "PLACE_ORDER_SUCCESS" && order.placed_at) {
      const ageH = (this.now().getTime() - Date.parse(order.placed_at)) / 3600_000;
      if (ageH >= this.cfg.unpaidWarnHours) {
        this.repo.log(
          orderId,
          "warn",
          `AE ${aeOrderId} je ${Math.round(ageH)} h ve stavu PLACE_ORDER_SUCCESS – zkontroluj v AliExpressu, zda je zaplacená`,
        );
        this.repo.markShipmentUnpaidWarned(shipmentId);
      }
    }

    if (!first) return false;

    const all = JSON.parse(order.supplier_lines_json ?? "[]") as SupplierLine[];
    const shipments = this.repo.shipmentsForOrder(orderId);
    // AE dělí objednávku podle prodejce; s jednou zásilkou patří všechno k ní.
    const lines = shipments.length === 1 ? all : all.filter((l) => info.productIds.includes(l.aeProductId));
    if (!lines.length) {
      this.repo.log(
        orderId,
        "warn",
        `AE ${aeOrderId}: tracking ${first.number}, ale nenašel jsem odpovídající položky – vyřiď ručně`,
      );
      return false;
    }

    const url = this.cfg.urlTemplate ? this.cfg.urlTemplate.replace("{number}", encodeURIComponent(first.number)) : null;
    const r = await this.storeFor(order.shop_id).fulfill({
      orderGid: order.shopify_order_gid,
      lineItems: lines.map((l) => ({ lineItemGid: l.lineItemGid, quantity: l.quantity })),
      trackingNumber: first.number,
      carrier: first.carrier,
      trackingUrl: url,
      notifyCustomer: this.cfg.notifyCustomer,
    });
    this.repo.markShipmentFulfilled(shipmentId, r.fulfillmentIds);
    this.repo.log(
      orderId,
      r.nothingOpen ? "warn" : "info",
      r.nothingOpen
        ? `AE ${aeOrderId}: tracking ${first.number}, ale v Shopify už nebylo nic otevřeného (vyřízeno ručně?)`
        : `Vyřízeno v Shopify, tracking ${first.number} (${first.carrier})`,
    );

    if (this.repo.shipmentsForOrder(orderId).every((s) => s.fulfilled_at)) {
      this.repo.setStatus(orderId, "FULFILLED");
      this.repo.log(orderId, "info", "Všechny zásilky vyřízeny");
    }
    return true;
  }
}
