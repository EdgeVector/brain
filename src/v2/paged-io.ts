import type { NodeClient, QueryRow } from "../client.ts";
import { rawData } from "./store.ts";
import { readHead, type Directory, type PageSchemas } from "./paged-model.ts";

export type Selection = { schema_name: string; fields: string[]; keys: string[] };
export class PageIO {
  constructor(readonly node: NodeClient, readonly schemas: PageSchemas) {}
  query(selection: Selection): Record<string, unknown> {
    return { schema_name: selection.schema_name, fields: selection.fields,
      filter: { HashRangeKeys: selection.keys.map(key => [key, ""]) }, limit: Math.max(1, Math.min(500, selection.keys.length)), response_format: "values" };
  }
  clean(page: any): QueryRow[] {
    if (!Array.isArray(page.results) || page.unresolved_rows !== 0 || page.tombstoned_rows !== 0 || page.has_more !== false) throw new Error("Incomplete V2 page read");
    return page.results;
  }
  async batch(selections: Selection[]): Promise<QueryRow[][]> {
    const result = await this.replies(selections.map(s => this.query(s)));
    return result.map((reply: any, i: number) => {
      const rows = this.clean(reply), keys = new Set(selections[i]!.keys);
      if (new Set(rows.map(row => row.key.hash)).size !== rows.length
          || rows.some(row => !keys.has(row.key.hash ?? "") || row.key.range)) throw new Error("V2 batch returned an unexpected key");
      return rows;
    });
  }
  async replies(queries: Record<string, unknown>[]): Promise<any[]> {
    const result = await rawData(this.node, "POST", "/api/queries/batch", { queries });
    if (result.count !== queries.length || !Array.isArray(result.results) || result.results.length !== queries.length) throw new Error("Incomplete V2 batch");
    return result.results.map((entry: any) => {
      if (entry.status !== 200 || entry.response?.ok === false) throw new Error("V2 snapshot query failed");
      return entry.response.data ?? entry.response;
    });
  }
  root(): Selection { return { schema_name: this.schemas.directory, fields: ["bsd_doc"], keys: ["brain"] }; }
  async directory(): Promise<Directory> {
    const page = await rawData(this.node, "POST", "/api/query", this.query(this.root()));
    return readHead(this.clean(page)[0]?.fields.bsd_doc);
  }
  async pages(directory: Directory, ids: string[], extra: Selection[] = []): Promise<{ rows: QueryRow[]; extra: QueryRow[][] }> {
    const chunks: Selection[] = [];
    for (let i = 0; i < ids.length; i += 100) chunks.push({ schema_name: this.schemas.page, fields: ["bsp_doc"], keys: ids.slice(i, i + 100) });
    const [root, ...rows] = await this.batch([this.root(), ...chunks, ...extra]);
    if ((root?.[0]?.fields.bsd_doc ?? null) !== directory.raw) throw new Error("V2 summary snapshot changed");
    const pages = rows.slice(0, chunks.length).flat();
    if (directory.raw !== null && pages.length !== ids.length) throw new Error("V2 summary page is absent");
    return { rows: pages, extra: rows.slice(chunks.length) };
  }
}
