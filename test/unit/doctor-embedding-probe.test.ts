/**
 * The embedding-runtime check follows the search PLANE, not the node's retired
 * in-process route.
 *
 * Before this, `brain doctor` reported `FAIL: 1 issue` on a completely healthy
 * host: the probe asked the node to run a search "so the node is forced to load
 * its ONNX model", the node correctly answered `503 search_plane_required`
 * (the in-process index was deliberately deleted), and there was no branch for
 * that — so it fell through to a generic failure advising "check the node log"
 * about a route working exactly as designed.
 *
 * The plane is INJECTED here rather than suppressed via `process.env`. `bun
 * test` shares one process across files, so an earlier version of this file
 * that set `HOME` and `LASTSEEK_DISABLE` broke unrelated `fbrain_search` tests
 * running alongside it.
 */
import { describe, expect, test } from "bun:test";
import { FbrainError, type NodeClient } from "../../src/client.ts";
import { runEmbeddingProbe } from "../../src/commands/doctor/g3-probes.ts";

/** A node whose in-process search route is retired, as Mini's now is. */
function retiredNode(code: string, message: string): NodeClient {
  return {
    async search() {
      throw new FbrainError({ code, message });
    },
  } as unknown as NodeClient;
}

/** No plane installed. */
const noPlane = async () => null;
/** A live plane with two hits. */
const livePlane = async () =>
  [
    { schema_name: "s", key_hash: "a", key_range: null, score: 0.8, text: "t" },
    { schema_name: "s", key_hash: "b", key_range: null, score: 0.7, text: "t" },
  ] as never;

describe("doctor embedding-runtime probe", () => {
  test("a live plane PASSES even though the node's route is retired", async () => {
    // The healthy-host case that used to read FAIL.
    const r = await runEmbeddingProbe(
      retiredNode("node_http_503", "Node /api/app/search returned HTTP 503."),
      undefined,
      { queryPlane: livePlane },
    );
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("search plane answered");
    expect(r.detail).toContain("2 hits");
  });

  test("a retired node route with no plane installed WARNS, and blames the plane not the node", async () => {
    // WARN rather than FAIL: brain still answers via BM25 keyword rescue, so
    // semantic recall is degraded, not broken. This preserves the judgement the
    // pre-existing 404 test encoded, and extends it to 503.
    const r = await runEmbeddingProbe(
      // The message brain actually receives: `mapNodeError` does not lift
      // Mini's plain-text `search_plane_required` body into it, which is why
      // this branch matches on status rather than on a body regex.
      retiredNode("node_http_503", "Node /api/app/search returned HTTP 503."),
      undefined,
      { queryPlane: noPlane },
    );
    expect(r.ok).toBe(true);
    expect(r.tag).toBe("WARN");
    expect(r.detail).toContain("no semantic search plane answered");
    expect(r.detail).toContain("retired by design");
    expect(r.detail).toContain("keyword fallback");
    // The instruction must point at installing a plane. Telling someone to read
    // the node log about a correctly-behaving route is what made the old
    // message useless.
    expect(r.fix).toContain("lastseek");
    expect(r.fix ?? "").not.toContain("check the node log");
  });

  test("a 404 from the same route is treated identically", async () => {
    // A fresh install serves 404 where an upgraded one serves 503; both mean
    // the same thing to a caller.
    const r = await runEmbeddingProbe(
      retiredNode("node_http_404", "Node /api/app/search returned HTTP 404."),
      undefined,
      { queryPlane: noPlane },
    );
    expect(r.ok).toBe(true);
    expect(r.tag).toBe("WARN");
    expect(r.detail).toContain("no semantic search plane answered");
  });

  test("a missing embedding model still reports the model, not the plane", async () => {
    // The one case where the node genuinely is the problem keeps its own
    // diagnosis and its own fix.
    const r = await runEmbeddingProbe(
      retiredNode("embedding_model_unavailable", "the ONNX file is missing"),
      undefined,
      { queryPlane: noPlane },
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("ONNX");
  });

  test("a plane that throws is reported as a plane fault, not a node fault", async () => {
    const r = await runEmbeddingProbe(
      retiredNode("node_http_503", "Node /api/app/search returned HTTP 503."),
      undefined,
      {
        queryPlane: async () => {
          throw new Error("index is wedged");
        },
      },
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("search plane errored");
    expect(r.fix).toContain("lastseek status");
  });
});
