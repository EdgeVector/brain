// The acknowledgement a status write prints must distinguish a write the node
// has flushed from one it has only accepted.
//
// Measured defect (papercut-brain-papercut-close-acks-a-status-transition-
// with-no-durability-and-the-write-can-revert-20261001): `papercut close`
// printed `wontfix → open` on a live defect, an immediate re-read confirmed
// `open`, and ten minutes later the record read `wontfix` with the closure's
// evidence stanza absent. It had not been re-closed — a second close appends a
// second stanza and the record carried exactly one. The write was queued and
// lost across a node restart, and neither the ack nor the re-read could tell
// that from a flushed write.
import { describe, expect, test } from "bun:test";

import {
  writeDurabilityOf,
  writeDurabilityTokens,
  writeDurabilityWarning,
} from "../../src/write-confirmation.ts";
import {
  PAPERCUT_FLAGS_BY_SUBCOMMAND,
  PAPERCUT_OPTIONS,
  assertPapercutFlagsConsumed,
} from "../../src/cli.ts";

describe("writeDurabilityOf", () => {
  test("reports the node's claim when it makes one", () => {
    expect(writeDurabilityOf({ durability: "durable" })).toBe("durable");
    expect(writeDurabilityOf({ durability: "queued" })).toBe("queued");
  });

  // `durability` is OPTIONAL on BatchMutationResult — an older node omits it.
  // Absent is NOT the same claim as `queued`: both mean "do not assume disk",
  // and they want different follow-ups. Collapsing them would report a fact
  // about the write that the node never stated.
  test("an absent field is `unreported`, not `queued`", () => {
    expect(writeDurabilityOf({})).toBe("unreported");
    expect(writeDurabilityOf(undefined)).toBe("unreported");
    expect(writeDurabilityOf(null)).toBe("unreported");
  });

  test("an unrecognised value is not reported as durable", () => {
    expect(writeDurabilityOf({ durability: "maybe" })).toBe("unreported");
  });
});

describe("writeDurabilityTokens", () => {
  // Always present, including on the good path. A token that appears only when
  // something is wrong reads as noise and gets filtered; one that is always
  // there is a field a caller can condition on.
  test("carries the state on every path", () => {
    expect(writeDurabilityTokens({ durability: "durable" })).toEqual([
      "durability=durable",
    ]);
    expect(writeDurabilityTokens({})).toEqual(["durability=unreported"]);
  });

  test("carries the revision when the receipt has one", () => {
    expect(
      writeDurabilityTokens({ durability: "queued", mutationIds: ["m1", "m2"] }),
    ).toEqual(["durability=queued", "revision=m1"]);
  });

  test("omits the revision rather than printing an empty one", () => {
    expect(writeDurabilityTokens({ durability: "queued", mutationIds: [] })).toEqual(
      ["durability=queued"],
    );
  });
});

describe("writeDurabilityWarning", () => {
  test("silent on a durable write", () => {
    expect(writeDurabilityWarning("durable", { verb: "papercut close" })).toBeNull();
  });

  // The one thing the caller cannot work out for itself, and the reason the
  // fleet's standing "re-read every brain write" protocol passed on the
  // measured revert: the re-read is served from the state the write landed in.
  test("says that a re-read cannot detect this", () => {
    for (const state of ["queued", "unreported"] as const) {
      const w = writeDurabilityWarning(state, { verb: "brain status" });
      expect(w).toBeTruthy();
      expect(w!.toLowerCase()).toContain("re-read");
      // The claim that matters: the caller's own verification is not evidence.
      expect(w!).toContain("CANNOT confirm it persisted");
    }
  });

  // The two non-durable states have different causes and the text must not
  // claim the node said something it did not.
  test("distinguishes a queued write from an unanswered one", () => {
    expect(writeDurabilityWarning("queued", { verb: "x" })!).toContain(
      "not flushed to disk yet",
    );
    expect(writeDurabilityWarning("unreported", { verb: "x" })!).toContain(
      "did not report durability",
    );
  });

  // The live primary answers `queued` on an ordinary status write, so this
  // warning fires on the normal case. A multi-line warning on every closure is
  // how a true warning gets filtered out, so the line is pinned to one line.
  test("is one line, so it survives being printed on every closure", () => {
    for (const state of ["queued", "unreported"] as const) {
      const w = writeDurabilityWarning(state, {
        verb: "papercut close",
        retryHint: "Re-run with --durable to demand a disk receipt.",
      })!;
      expect(w.split("\n")).toHaveLength(1);
    }
  });

  test("offers the retry the caller can actually run, when given one", () => {
    expect(
      writeDurabilityWarning("queued", {
        verb: "papercut close",
        retryHint: "Re-run with `--durable`.",
      })!,
    ).toContain("--durable");
    expect(
      writeDurabilityWarning("queued", { verb: "brain status" })!,
    ).not.toContain("--durable");
  });
});

describe("--durable is scoped to the verb that consumes it", () => {
  test("defined in the papercut option table", () => {
    expect(Object.keys(PAPERCUT_OPTIONS)).toContain("durable");
  });

  test("close consumes it", () => {
    expect(PAPERCUT_FLAGS_BY_SUBCOMMAND.close).toContain("durable");
    expect(() =>
      assertPapercutFlagsConsumed("close", { durable: true }),
    ).not.toThrow();
  });

  // The shared-table silent-drop class this repo already closed once: a flag a
  // subcommand does not apply is REFUSED, not accepted and dropped. A durable
  // receipt means nothing to a reader.
  test("every other subcommand refuses it", () => {
    for (const sub of ["file", "set", "census", "list"]) {
      expect(PAPERCUT_FLAGS_BY_SUBCOMMAND[sub]).not.toContain("durable");
      expect(() => assertPapercutFlagsConsumed(sub, { durable: true })).toThrow(
        /does not use --durable/,
      );
    }
  });
});
