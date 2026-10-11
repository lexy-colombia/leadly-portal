// Emulador MINIMO de supabase-js (query builder + rpc) sobre un cliente
// `postgres` real, solo para ejercitar legacyStore.ts / applyWebhookEvent.ts /
// salesOrderPayments.ts / registry.ts contra SQL real en la prueba de integracion.
// Cubre exactamente los patrones que esos modulos usan; cualquier otro lanza.
// deno-lint-ignore-file no-explicit-any
import type postgres from "npm:postgres@3";

const IDENT = /^[a-z_][a-z0-9_]*$/;
const COLS = /^[a-z_*][a-z0-9_*, ]*$/;
const ident = (s: string) => {
  if (!IDENT.test(s)) throw new Error(`identificador no soportado: ${s}`);
  return s;
};

class Q implements PromiseLike<{ data: any; error: any }> {
  private op: "select" | "insert" | "update" = "select";
  private cols = "*";
  private filters: Array<[string, "=" | "is null" | "in", unknown]> = [];
  private payload: Record<string, unknown> = {};
  private limitN: number | null = null;
  private mode: "many" | "maybe" = "many";
  private returning = false;
  constructor(private sql: postgres.Sql<any>, private table: string) {}
  select(cols = "*") {
    if (!COLS.test(cols)) throw new Error(`select no soportado: ${cols}`);
    if (this.op === "select") this.cols = cols;
    else this.returning = true;
    return this;
  }
  insert(obj: Record<string, unknown>) { this.op = "insert"; this.payload = obj; return this; }
  update(obj: Record<string, unknown>) { this.op = "update"; this.payload = obj; return this; }
  eq(c: string, v: unknown) { this.filters.push([ident(c), "=", v]); return this; }
  in(c: string, v: unknown[]) { this.filters.push([ident(c), "in", v]); return this; }
  is(c: string, v: unknown) {
    if (v !== null) throw new Error("is() solo soporta null");
    this.filters.push([ident(c), "is null", null]);
    return this;
  }
  limit(n: number) { this.limitN = n; return this; }
  maybeSingle() { this.mode = "maybe"; return this; }
  private where(params: unknown[], offset = 0) {
    if (!this.filters.length) return "";
    const parts = this.filters.map(([c, op, v]) => {
      if (op === "is null") return `${c} is null`;
      if (op === "in") {
        const list = v as unknown[];
        const ph = list.map((x) => { params.push(x); return `$${offset + params.length}`; });
        return `${c} in (${ph.join(", ")})`;
      }
      params.push(v);
      return `${c} = $${offset + params.length}`;
    });
    return ` where ${parts.join(" and ")}`;
  }
  private val(v: unknown) {
    return v !== null && typeof v === "object" ? this.sql.json(v as never) : v;
  }
  private async run(): Promise<{ data: any; error: any }> {
    const t = `public.${ident(this.table)}`;
    try {
      let rows: any[];
      const params: unknown[] = [];
      if (this.op === "select") {
        const w = this.where(params);
        rows = await this.sql.unsafe(`select ${this.cols} from ${t}${w}${this.limitN ? ` limit ${this.limitN}` : ""}`, params as never[]);
      } else if (this.op === "insert") {
        const keys = Object.keys(this.payload).map(ident);
        const vals = keys.map((k) => this.val(this.payload[k]));
        rows = await this.sql.unsafe(
          `insert into ${t} (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning *`,
          vals as never[],
        );
      } else {
        const keys = Object.keys(this.payload).map(ident);
        const sets = keys.map((k, i) => `${k} = $${i + 1}`);
        keys.forEach((k) => params.push(this.val(this.payload[k])));
        const w = this.where(params, 0);
        rows = await this.sql.unsafe(`update ${t} set ${sets.join(", ")}${w} returning *`, params as never[]);
      }
      if (this.op !== "select" && !this.returning) return { data: null, error: null };
      if (this.mode === "maybe") {
        if (rows.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
        return { data: rows[0] ?? null, error: null };
      }
      return { data: rows, error: null };
    } catch (e) {
      const er = e as { code?: string; message: string };
      return { data: null, error: { code: er.code, message: er.message } };
    }
  }
  then<T1 = any, T2 = never>(ok?: ((v: { data: any; error: any }) => T1 | PromiseLike<T1>) | null, ko?: ((r: unknown) => T2 | PromiseLike<T2>) | null) {
    return this.run().then(ok, ko);
  }
}

export function pgSupabase(sql: postgres.Sql<any>) {
  return {
    from: (table: string) => new Q(sql, table),
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      try {
        const keys = Object.keys(args).map(ident);
        const rows = await sql.unsafe(
          `select public.${ident(fn)}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`,
          keys.map((k) => args[k]) as never[],
        );
        return { data: rows[0].r, error: null };
      } catch (e) {
        const er = e as { code?: string; message: string };
        return { data: null, error: { code: er.code, message: er.message } };
      }
    },
  };
}
