import type { Request } from "express";
import { ValidationError } from "./errors.js";

export const idParam = (req: Request, name = "id"): number => {
  const id = Number(req.params[name]);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError(`Neplatné ${name}`);
  return id;
};

export const optStr = (v: unknown, field: string, max = 5000): string | null => {
  if (v == null || v === "") return null;
  if (typeof v !== "string") throw new ValidationError(`${field} musí být text`);
  const t = v.trim();
  if (t.length > max) throw new ValidationError(`${field} je delší než ${max} znaků`);
  return t || null;
};

export const reqStr = (v: unknown, field: string, max = 5000): string => {
  const s = optStr(v, field, max);
  if (!s) throw new ValidationError(`${field} je povinné`);
  return s;
};

export const optNum = (v: unknown, field: string, min = 0): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) throw new ValidationError(`${field} musí být číslo ≥ ${min}`);
  return n;
};

export const optDate = (v: unknown, field: string): string | null => {
  const s = optStr(v, field, 10);
  if (s == null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new ValidationError(`${field} musí být datum RRRR-MM-DD`);
  return s;
};

export function oneOf<T extends string>(v: unknown, allowed: readonly T[], field: string): T {
  if (typeof v !== "string" || !allowed.includes(v as T)) throw new ValidationError(`${field} musí být jedno z: ${allowed.join(", ")}`);
  return v as T;
}
