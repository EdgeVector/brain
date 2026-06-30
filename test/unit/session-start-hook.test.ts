import { describe, expect, test } from "bun:test";

import {
  buildAdditionalContext,
  buildSessionStartQuery,
  runSessionStartHook,
} from "../../src/commands/session-start-hook.ts";
import { buildTestCfg } from "../util.ts";

describe("session-start hook", () => {
  test("builds a query from cwd, repo context, and prompt-like hook fields", () => {
    const query = buildSessionStartQuery(
      {
        hook_event_name: "SessionStart",
        source: "startup",
        prompt: "Fix the fbrain hook installer",
      },
      "/tmp/project",
      {
        root: "/tmp/project",
        repo: "EdgeVector/fbrain",
        branch: "feature/hook",
      },
    );
    expect(query).toContain("Claude Code session start");
    expect(query).toContain("source: startup");
    expect(query).toContain("cwd: /tmp/project");
    expect(query).toContain("repo: EdgeVector/fbrain");
    expect(query).toContain("branch: feature/hook");
    expect(query).toContain("prompt: Fix the fbrain hook installer");
  });

  test("prints Claude SessionStart additionalContext for strong matches only", async () => {
    const lines: string[] = [];
    const code = await runSessionStartHook({
      cfg: buildTestCfg(),
      input: JSON.stringify({ cwd: "/tmp/project", source: "startup" }),
      repoContext: () => ({ repo: "EdgeVector/fbrain", branch: "main" }),
      print: (line) => lines.push(line),
      ask: async () => [
        {
          slug: "strong-one",
          score: 0.03,
          type: "design",
          title: "Strong one",
          snippet: "Relevant context from the brain.",
          confidence: "strong",
        },
        {
          slug: "weak-one",
          score: 0.01,
          type: "concept",
          title: "Weak one",
          snippet: "Should not appear.",
          confidence: "weak",
        },
      ],
    });
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    const context = parsed.hookSpecificOutput.additionalContext;
    expect(context).toContain("strong-one - Strong one");
    expect(context).toContain("Relevant context");
    expect(context).not.toContain("weak-one");
  });

  test("is quiet for weak/no matches and ask failures", async () => {
    const weakLines: string[] = [];
    await runSessionStartHook({
      cfg: buildTestCfg(),
      input: "{}",
      print: (line) => weakLines.push(line),
      ask: async () => [
        {
          slug: "noise",
          score: 0.01,
          type: "concept",
          title: "Noise",
          snippet: "Closest known candidate.",
          confidence: "weak",
        },
      ],
    });
    expect(weakLines).toEqual([]);

    const errorLines: string[] = [];
    await runSessionStartHook({
      cfg: buildTestCfg(),
      input: "{}",
      print: (line) => errorLines.push(line),
      ask: async () => {
        throw new Error("node unavailable");
      },
    });
    expect(errorLines).toEqual([]);
  });

  test("formats capped snippets compactly", () => {
    const body = buildAdditionalContext([
      {
        slug: "alpha",
        score: 0.03,
        type: "project",
        title: "Alpha",
        snippet: "x ".repeat(200),
        confidence: "strong",
      },
    ]);
    expect(body).toContain("alpha - Alpha");
    expect(body).toContain("...");
    expect(body.length).toBeLessThan(280);
  });
});
