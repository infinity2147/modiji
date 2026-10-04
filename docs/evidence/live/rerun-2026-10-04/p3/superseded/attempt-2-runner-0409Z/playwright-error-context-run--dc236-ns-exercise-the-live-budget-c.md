# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: p3-gate.live.spec.ts >> @live @p3 run E: several decisions exercise the live budget
- Location: e2e/live/p3-gate.live.spec.ts:169:1

# Error details

```
Error: live budget: at most 5 questions in 10 minutes

expect(received).toBeLessThanOrEqual(expected)

Expected: <= 5
Received:    6
```

# Test source

```ts
  96  |     await answerQuestions(expert, caseId, { waitMs: 14_000, max: 2, style: pausingAnswer, log: asked });
  97  |   }
  98  |   await answerQuestions(expert, TRAINING.at(-1) ?? "", { waitMs: 8000, max: 2, style: pausingAnswer, log: asked });
  99  |   const a = await finishRun(expert, { group: GROUP, name: `run-b-pause-${expert.sessionId}`, title: "P3 run B — long pause, then resumes mid-answer (LIVE, production)", asked });
  100 |   expectGreen(a);
  101 | });
  102 | 
  103 | test("@live @p3 run C: rapid case navigation and scrolling", async ({ page, request }) => {
  104 |   const expert = await Expert.open(page, request);
  105 |   await begin(expert, "Training", [], TRAINING);
  106 |   const asked: Asked[] = [];
  107 |   for (const [i, caseId] of TRAINING.entries()) {
  108 |     await expert.resetCursor();
  109 |     await expert.openCase(i);
  110 |     await expert.scrollCase(14, 320, 180);
  111 |     // Flip quickly through the queue and back.
  112 |     for (const j of [(i + 1) % 3, (i + 2) % 3, i]) {
  113 |       await expert.openCase(j);
  114 |       await page.waitForTimeout(350);
  115 |     }
  116 |     await expert.scrollCase(8, 260, 160);
  117 |     await expert.rate(plan(caseId).rating);
  118 |     await expert.decide(plan(caseId).outcome);
  119 |     // The question is queued now; keep moving for ~6 s (the gate must wait), then stop and listen.
  120 |     const until = Date.now() + 6000;
  121 |     let k = 0;
  122 |     while (Date.now() < until) {
  123 |       await expert.openCase((i + 1 + k) % 3);
  124 |       await expert.scrollCase(3, 300, 150);
  125 |       k += 1;
  126 |     }
  127 |     await expert.openCase(i);
  128 |     await answerQuestions(expert, caseId, { waitMs: 14_000, max: 2, log: asked });
  129 |   }
  130 |   await answerQuestions(expert, TRAINING.at(-1) ?? "", { waitMs: 8000, max: 2, log: asked });
  131 |   const a = await finishRun(expert, { group: GROUP, name: `run-c-scrolling-${expert.sessionId}`, title: "P3 run C — rapid case navigation and scrolling (LIVE, production)", asked });
  132 |   expect.soft(a.counts.scrollEvents, "scrolling actually happened").toBeGreaterThan(20);
  133 |   expectGreen(a);
  134 | });
  135 | 
  136 | test("@live @p3 run D: short noisy utterances near the VAD threshold", async ({ page, request }) => {
  137 |   const expert = await Expert.open(page, request);
  138 |   const SHORT = ["Okay.", "Mm-hm.", "Right.", "Yeah.", "Hmm."];
  139 |   await begin(expert, "Training", SHORT, TRAINING);
  140 |   const asked: Asked[] = [];
  141 |   // Quiet broadband noise under everything; answers at full level over the noise.
  142 |   await expert.noise(0.012);
  143 |   const gains = [0.12, 0.2, 0.3, 0.4, 0.15, 0.25];
  144 |   let g = 0;
  145 |   const murmur = async (count: number, gapMs: number) => {
  146 |     for (let k = 0; k < count; k += 1) {
  147 |       const gain = gains[g % gains.length] ?? 0.2;
  148 |       await expert.say(SHORT[g % SHORT.length] ?? "Okay.", `short@${gain}`, gain);
  149 |       g += 1;
  150 |       await page.waitForTimeout(gapMs);
  151 |     }
  152 |   };
  153 |   for (const [i, caseId] of TRAINING.entries()) {
  154 |     await expert.resetCursor();
  155 |     await expert.openCase(i);
  156 |     await murmur(3, 900);
  157 |     await expert.rate(plan(caseId).rating);
  158 |     await expert.decide(plan(caseId).outcome);
  159 |     // Question pending: short murmurs with < 1.2 s gaps keep the floor (if the VAD hears them).
  160 |     await murmur(5, 1000);
  161 |     await answerQuestions(expert, caseId, { waitMs: 14_000, max: 2, log: asked });
  162 |   }
  163 |   await answerQuestions(expert, TRAINING.at(-1) ?? "", { waitMs: 8000, max: 2, log: asked });
  164 |   await expert.noise(0);
  165 |   const a = await finishRun(expert, { group: GROUP, name: `run-d-noisy-${expert.sessionId}`, title: "P3 run D — short noisy utterances near the VAD threshold (LIVE, production)", asked });
  166 |   expectGreen(a);
  167 | });
  168 | 
  169 | test("@live @p3 run E: several decisions exercise the live budget", async ({ page, request }) => {
  170 |   const expert = await Expert.open(page, request);
  171 |   await begin(expert, "Practice", [], PRACTICE);
  172 |   const asked: Asked[] = [];
  173 |   for (const [i, caseId] of PRACTICE.entries()) {
  174 |     await expert.resetCursor();
  175 |     await expert.openCase(i);
  176 |     await page.waitForTimeout(800);
  177 |     await expert.rate(plan(caseId).rating);
  178 |     await expert.decide(plan(caseId).outcome);
  179 |     await answerQuestions(expert, caseId, { waitMs: 12_000, max: 2, log: asked });
  180 |   }
  181 |   await answerQuestions(expert, PRACTICE.at(-1) ?? "", { waitMs: 10_000, max: 2, log: asked });
  182 |   // What the server still has queued (unspent because of the budget) and what the gate says.
  183 |   const queue = (await (await request.get(`/api/sessions/${expert.sessionId}/questions`)).json()) as { queue: unknown[]; asked: unknown[] };
  184 |   await page.getByRole("button", { name: "Engineering view" }).click();
  185 |   await page.waitForTimeout(600);
  186 |   await page.screenshot({ path: evidencePath(GROUP, `run-e-budget-engineering-view-${expert.sessionId}.png`) });
  187 |   const hud = (await page.getByRole("region", { name: "Engineering view" }).textContent()) ?? "";
  188 |   const a = await finishRun(expert, {
  189 |     group: GROUP,
  190 |     name: `run-e-budget-${expert.sessionId}`,
  191 |     title: "P3 run E — six decisions exercise the live budget (5 per 10 min) (LIVE, production)",
  192 |     asked,
  193 |     notes: [`Server queue at the end: ${queue.queue.length} queued, ${queue.asked.length} asked.`, `Engineering view text at the end: ${hud.slice(0, 1200)}`],
  194 |     extra: { finalQueue: queue, engineeringView: hud },
  195 |   });
> 196 |   expect.soft(a.counts.questionsAuthorized, "live budget: at most 5 questions in 10 minutes").toBeLessThanOrEqual(5);
      |                                                                                               ^ Error: live budget: at most 5 questions in 10 minutes
  197 |   expectGreen(a);
  198 | });
  199 | 
```