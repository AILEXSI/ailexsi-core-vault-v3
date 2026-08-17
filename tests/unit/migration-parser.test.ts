import { describe, it, expect } from "vitest";
import { parseVaultMarkdown, validateNotes } from "@ailexsi/v2-migration";

const sample = `---
id: 33333333-3333-4333-8333-333333333333
type: decision
title: "Ship foundation"
tags: ["v2"]
relations:
  - target_id: 44444444-4444-4444-8444-444444444444
    relation_type: supports
    reason: "because tests pass"
---

Body here.
`;

describe("migration parser", () => {
  it("parses frontmatter and body", () => {
    const n = parseVaultMarkdown("20_memories/x.md", sample);
    expect(n.id).toBe("33333333-3333-4333-8333-333333333333");
    expect(n.type).toBe("decision");
    expect(n.title).toBe("Ship foundation");
    expect(n.relations).toHaveLength(1);
    expect(n.body).toContain("Body here");
    expect(n.parseErrors).toEqual([]);
  });

  it("flags missing frontmatter", () => {
    const n = parseVaultMarkdown("x.md", "# no fm\n");
    expect(n.parseErrors).toContain("missing_frontmatter");
    const issues = validateNotes([n]);
    expect(issues.some((i) => i.code === "missing_frontmatter")).toBe(true);
  });
});
