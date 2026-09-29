import { dream } from "@ynm/service";
import { recordMetric } from "../../baseline.js";
import { availableJudges, availableWriter, judgeTag, seeded } from "../support.js";

const EPISODES: Record<string, string[]> = {
  "topic:release": [
    "Release 1.2 on 2026-08-04 slipped by two days because the gate was skipped and a broken migration reached staging.",
    "Release 1.3 on 2026-08-18 went out on time; the gate caught a failing parity test before tagging.",
    "Release 1.4 on 2026-09-01 slipped again when a hotfix bypassed the gate; rework took a day.",
  ],
  "entity:staging": [
    "On 2026-08-10 staging deploys failed until the blue-heron cluster in eu-west-2 was scaled to three nodes.",
    "On 2026-08-22 staging was healthy after the node pool autoscaler was enabled.",
    "On 2026-09-05 a staging outage traced to an expired certificate on blue-heron.",
  ],
};

/**
 * Reflection faithfulness (ADR-012 cascade shape): the writer drafts, the judge's Noul battery
 * verifies, and a flagged draft is withheld. Needs a writer; skipped without one.
 */
describe("tier2 faithfulness: reflect pass verified by the judge battery", () => {
  const writer = availableWriter();
  const judges = availableJudges().filter((j) => j.calibrated);
  it.skipIf(writer.name === "none" || judges.length === 0)(
    "writes verified reflections and records the unsupported-claim rate",
    async () => {
      const judge = judges[0] as NonNullable<(typeof judges)[0]>;
      const { ynm, config, now } = await seeded({ seed: 3, count: 0 }, judge, writer);
      for (const [subject, episodes] of Object.entries(EPISODES)) {
        for (const content of episodes)
          await ynm.remember({ type: "episodic", subject, content, tags: ["eval"] });
      }
      const report = await dream(ynm, { passes: ["reflect"] }, { judge, writer, config, now });
      const pass = report.passes.reflect;
      if (!pass) throw new Error("reflect pass did not run");
      const attempted = pass.changed.length + pass.flagged.length / 3;
      const unsupportedRate = attempted ? pass.flagged.length / 3 / attempted : 0;
      console.info(
        `reflect: ${pass.changed.length} written, ${pass.flagged.length / 3} withheld, notes: ${pass.notes.join("; ") || "none"}; writer ${writer.name}, judge ${judge.name}`
      );
      recordMetric(
        {
          name: `reflect-written-rate:${judgeTag(judge)}`,
          size: Object.keys(EPISODES).length,
          value: pass.changed.length / Object.keys(EPISODES).length,
        },
        0.5
      );
      recordMetric(
        {
          name: `reflect-unsupported-rate:${judgeTag(judge)}`,
          size: Object.keys(EPISODES).length,
          value: 1 - unsupportedRate,
        },
        0.5
      );
      const written = await ynm.list({ type: "reflective", includeTombstoned: false });
      for (const m of written) {
        expect(m.links.length).toBe(3);
        expect(m.subject).toBeDefined();
      }
      expect(pass.candidates).toBe(2);
    },
    900_000
  );
});
