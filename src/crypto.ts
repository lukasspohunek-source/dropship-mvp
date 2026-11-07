import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** Šifrování tajných údajů e-shopů v DB (AES-256-GCM). Klíč = SHA-256(SECRET_KEY). */
export class SecretBox {
  private key: Buffer;

  constructor(secret: string) {
    if (secret.length < 32) throw new Error("SECRET_KEY musí mít aspoň 32 znaků");
    this.key = createHash("sha256").update(secret).digest();
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
  }

  open(sealed: string): string {
    const [v, iv, tag, ct] = sealed.split(":");
    if (v !== "v1" || !iv || !tag || !ct) throw new Error("Neznámý formát šifrovaného údaje");
    const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
  }
}
