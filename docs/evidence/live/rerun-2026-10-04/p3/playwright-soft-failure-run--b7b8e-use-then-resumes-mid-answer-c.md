# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: p3-gate.live.spec.ts >> @live @p3 run B: long pause, then resumes mid-answer
- Location: e2e/live/p3-gate.live.spec.ts:71:1

# Error details

```
Error: authorization latency ≤ 250 ms

expect(received).toBeLessThanOrEqual(expected)

Expected: <= 250
Received:    5228
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - generic [ref=e2]:
    - banner [ref=e3]:
      - generic [ref=e4]:
        - generic [ref=e8]: Northstar Bank
        - heading "CaseDesk" [level=1] [ref=e10]
      - generic [ref=e11]: Synthetic data — fictional policy
      - generic [ref=e12]:
        - paragraph [ref=e13]: "Sensing (disclosed): DOM events · typing & scroll timing · microphone only when voice is on"
        - paragraph [ref=e18]:
          - generic [ref=e19]: Expert capture
          - generic [aria-hidden] [ref=e20]: ·
          - generic [ref=e21]: Training set
          - generic [aria-hidden] [ref=e22]: ·
          - generic "cb13274f-46f8-434f-9b58-ecb878f26a3e" [ref=e23]: cb13274f
        - link "New session" [ref=e24] [cursor=pointer]:
          - /url: /sandbox
    - generic [ref=e25]:
      - region [ref=e27]:
        - generic [ref=e28]:
          - generic [ref=e29]:
            - heading "Case queue" [level=2] [ref=e30]
            - paragraph [ref=e31]: 3 of 3 decided
          - progressbar "Cases decided" [ref=e32]
        - list "Cases" [ref=e34]:
          - listitem [ref=e35]:
            - 'button "NS-2026-0101 Decided Halvorsen Marine Logistics Ltd Company Estoria Medium risk Outcome: Send to enhanced review" [ref=e36]':
              - generic [ref=e37]:
                - generic [ref=e38]: NS-2026-0101
                - generic [ref=e39]: Decided
              - generic [ref=e41]: Halvorsen Marine Logistics Ltd
              - generic [ref=e42]:
                - generic [ref=e43]: Company
                - generic [aria-hidden] [ref=e44]: ·
                - generic [ref=e45]: Estoria
                - generic [ref=e46]: Medium risk
              - generic [ref=e48]: "Outcome: Send to enhanced review"
          - listitem [ref=e49]:
            - 'button "NS-2026-0102 Decided Quillfeather Agritrade Holdings Company Galvania High risk Outcome: Approve onboarding" [ref=e50]':
              - generic [ref=e51]:
                - generic [ref=e52]: NS-2026-0102
                - generic [ref=e53]: Decided
              - generic [ref=e55]: Quillfeather Agritrade Holdings
              - generic [ref=e56]:
                - generic [ref=e57]: Company
                - generic [aria-hidden] [ref=e58]: ·
                - generic [ref=e59]: Galvania
                - generic [ref=e60]: High risk
              - generic [ref=e62]: "Outcome: Approve onboarding"
          - listitem [ref=e63]:
            - 'button "NS-2026-0103 Decided · escalated Valentin Ashgrove Individual Aldermere Low risk Outcome: Escalate to compliance officer" [ref=e64]':
              - generic [ref=e66]:
                - generic [ref=e67]: NS-2026-0103
                - generic [ref=e68]: Decided · escalated
              - generic [ref=e71]: Valentin Ashgrove
              - generic [ref=e72]:
                - generic [ref=e73]: Individual
                - generic [aria-hidden] [ref=e74]: ·
                - generic [ref=e75]: Aldermere
                - generic [ref=e76]: Low risk
              - generic [ref=e78]: "Outcome: Escalate to compliance officer"
      - main [ref=e79]:
        - article [ref=e80]:
          - generic [ref=e81]:
            - generic [ref=e82]:
              - paragraph [ref=e83]: NS-2026-0103
              - heading "Valentin Ashgrove" [level=2] [ref=e84]
            - paragraph [ref=e85]:
              - text: Submitted
              - time [ref=e86]: 16 Sept 2026
          - generic [ref=e87]:
            - region [ref=e88]:
              - heading "Customer" [level=3] [ref=e90]
              - generic [ref=e96]:
                - term [ref=e97]: Name
                - definition [ref=e98]: Valentin Ashgrove
                - term [ref=e99]: Entity type
                - definition [ref=e100]: Individual
                - term [ref=e101]: Registration no.
                - definition [ref=e102]: ALD-P615042
                - term [ref=e103]: Country
                - definition [ref=e104]:
                  - generic [ref=e105]:
                    - text: Aldermere
                    - generic [ref=e106]: Low risk
                - term [ref=e108]: Address
                - definition [ref=e109]: 27 Cedar Court, Port Elsby, Aldermere
            - region [ref=e110]:
              - heading "Relationship" [level=3] [ref=e112]
              - generic [ref=e119]:
                - term [ref=e120]: Customer status
                - definition [ref=e121]:
                  - generic [ref=e122]: New customer
                - term [ref=e124]: Relationship age
                - definition [ref=e125]: New relationship
                - term [ref=e126]: Relationship manager
                - definition [ref=e127]: Signe Valcourt
          - region [ref=e128]:
            - heading "Beneficial owners" [level=3] [ref=e130]
            - table [ref=e138]:
              - rowgroup [ref=e139]:
                - row [ref=e140]:
                  - columnheader "Name" [ref=e141]
                  - columnheader "Role" [ref=e142]
                  - columnheader "Share" [ref=e143]
                  - columnheader "ID verified" [ref=e144]
                  - columnheader "PEP" [ref=e145]
              - rowgroup [ref=e146]:
                - row [ref=e147]:
                  - cell "Valentin Ashgrove" [ref=e148]
                  - cell "Account holder" [ref=e149]
                  - cell "100 %" [ref=e150]
                  - cell "Verified" [ref=e151]
                  - cell "Yes" [ref=e154]
          - generic [ref=e157]:
            - region [ref=e158]:
              - heading "Screening" [level=3] [ref=e160]
              - generic [ref=e164]:
                - term [ref=e165]: Sanctions
                - definition [ref=e166]:
                  - generic [ref=e167]:
                    - generic [ref=e168]: Clear
                    - generic [ref=e170]: No match on the Northstar Synthetic Sanctions List.
                - term [ref=e171]: Adverse media
                - definition [ref=e172]:
                  - generic [ref=e173]:
                    - generic [ref=e174]: None
                    - generic [ref=e176]: No relevant adverse media found.
            - region [ref=e177]:
              - heading "Source of funds" [level=3] [ref=e179]
              - generic [ref=e183]:
                - term [ref=e184]: Status
                - definition [ref=e185]:
                  - generic [ref=e186]: Verified
                - term [ref=e188]: Description
                - definition [ref=e189]: Salary as deputy minister of transport (fictional) and savings; payslips and bank statements reviewed.
                - term [ref=e190]: Expected monthly volume
                - definition [ref=e191]: €9,500
          - region [ref=e192]:
            - heading "Documents" [level=3] [ref=e194]
            - list [ref=e199]:
              - listitem [ref=e200]:
                - generic [ref=e201]: Passport — Valentin Ashgrove
                - generic [ref=e202]: Received
              - listitem [ref=e204]:
                - generic [ref=e205]: Proof of address
                - generic [ref=e206]: Received
              - listitem [ref=e208]:
                - generic [ref=e209]: Source-of-funds statement
                - generic [ref=e210]: Received
      - generic [ref=e212]:
        - region [ref=e213]:
          - generic [ref=e214]:
            - heading "Voice · Interviewer agent" [level=2] [ref=e215]
            - status "Voice status" [ref=e222]:
              - generic [ref=e223]: Ended
          - generic [ref=e225]:
            - button "Go off the record Alt+Shift+O" [ref=e226]:
              - text: Go off the record
              - generic [ref=e227]: Alt+Shift+O
            - button "Start interview" [ref=e228]
            - paragraph [ref=e229]: Disconnected.
            - list "Sensing" [ref=e230]:
              - listitem [ref=e231]: Microphone off (no conversation)
              - listitem [ref=e238]: Agent silent
            - status [ref=e243]: Highlighted “Country risk (Northstar list)” in the case file
            - region [ref=e247]:
              - heading "Transcript" [level=3] [ref=e248]
              - log [ref=e249]:
                - listitem [ref=e250]:
                  - generic [ref=e251]: "Expert:"
                  - text: Hmm. Let me think about this one.
                - listitem [ref=e252]:
                  - generic [ref=e253]: "Expert:"
                  - text: Okay. The key points here are the ownership and the country.
                - listitem [ref=e254]:
                  - generic [ref=e255]: "Agent:"
                  - text: What made you send this one to enhanced review? And what would have changed your mind?
                - listitem [ref=e256]:
                  - generic [ref=e257]: "Expert:"
                  - text: Well, let me think.
                - listitem [ref=e258]:
                  - generic [ref=e259]: "Expert:"
                  - text: The largest owner holds 35% and isn't verified. Anything over 25% that isn't verified goes to enhanced review.
                - listitem [ref=e260]:
                  - generic [ref=e261]: "Agent:"
                  - text: If the entity type were "trust" instead of company, what would you decide?
                - listitem [ref=e262]:
                  - generic [ref=e263]: "Expert:"
                  - text: Well, let me think.
                - listitem [ref=e264]:
                  - generic [ref=e265]: "Expert:"
                  - text: For a company or a trust, I look at the largest owner. For an individual, the owner threshold doesn't apply.
                - listitem [ref=e266]:
                  - generic [ref=e267]: "Expert:"
                  - text: Hmm. Let me think about this one.
                - listitem [ref=e268]:
                  - generic [ref=e269]: "Agent:"
                  - text: If the largest ...
                - listitem [ref=e270]:
                  - generic [ref=e271]: "Expert:"
                  - text: Okay. The key points here are the ownership and the country.
                - listitem [ref=e272]:
                  - generic [ref=e273]: "Expert:"
                  - text: Well, let me think.
                - listitem [ref=e274]:
                  - generic [ref=e275]: "Expert:"
                  - text: They've banked with us for three years, and their source of funds is verified, so the high-risk country on its own doesn't send them to enhanced review.
                - listitem [ref=e276]:
                  - generic [ref=e277]: "Agent:"
                  - text: If the analyst risk rating were "medium" instead of high, what would you decide?
                - listitem [ref=e278]:
                  - generic [ref=e279]: "Expert:"
                  - text: Well, let me think.
                - listitem [ref=e280]:
                  - generic [ref=e281]: "Expert:"
                  - text: They've banked with us for three years, and their source of funds is verified, so the high-risk country on its own doesn't send them to enhanced review.
                - listitem [ref=e282]:
                  - generic [ref=e283]: "Expert:"
                  - text: Hmm. Let me think about this one.
                - listitem [ref=e284]:
                  - generic [ref=e285]: "Agent:"
                  - text: If the country ...
                - listitem [ref=e286]:
                  - generic [ref=e287]: "Expert:"
                  - text: Okay. The key points here are the ownership and the country.
                - listitem [ref=e288]:
                  - generic [ref=e289]: "Expert:"
                  - text: Well, let me think.
                - listitem [ref=e290]:
                  - generic [ref=e291]: "Expert:"
                  - text: The country doesn't matter here. A politically exposed person always goes to the compliance officer.
        - region [ref=e292]:
          - generic [ref=e293]:
            - heading "Review" [level=2] [ref=e294]
            - generic [ref=e295]: NS-2026-0103
          - generic [ref=e297]:
            - status [ref=e298]: Decision committed
            - generic [ref=e302]:
              - term [ref=e303]: Outcome
              - definition [ref=e304]: Escalate to compliance officer
              - term [ref=e305]: Risk rating
              - definition [ref=e306]: High
              - term [ref=e307]: Interlock
              - definition [ref=e308]:
                - text: Needed approval
                - generic [ref=e309]: · 1 rule(s) matched
              - term [ref=e310]: Escalated
              - definition [ref=e311]: “Escalating to the compliance officer for sign-off.”
              - term [ref=e312]: Ledger entry
              - definition [ref=e313]: 9abe0d59
        - status [ref=e314]: All DOM events delivered
        - region [ref=e315]:
          - generic [ref=e316]:
            - heading "Screen capture" [level=2] [ref=e317]
            - status "Screen capture status" [ref=e325]:
              - generic [ref=e326]: Capturing
          - generic [ref=e328]:
            - paragraph [ref=e329]: "Screen frames: change-detected, best-effort PII blur in your browser before upload."
            - button "Stop sharing" [ref=e330]
            - paragraph [ref=e331]: "Vision: 2 events from 2 frames · p95 frame→event 3595 ms"
            - group [ref=e332]:
              - generic "Perception stats" [ref=e333] [cursor=pointer]
      - generic [ref=e335]:
        - generic [ref=e336]:
          - region "Speech gate" [ref=e338]:
            - 'status "Gate status: LISTENING" [ref=e339]': LISTENING
            - list "Gate conditions" [ref=e340]:
              - 'listitem "Typing: clear" [ref=e341]':
                - generic [ref=e342]: Typing
                - generic [ref=e343]: ✓
              - 'listitem "Speaking: clear" [ref=e344]':
                - generic [ref=e345]: Speaking
                - generic [ref=e346]: ✓
              - 'listitem "Screen moving: clear" [ref=e347]':
                - generic [ref=e348]: Screen moving
                - generic [ref=e349]: ✓
            - generic "Question value" [ref=e350]: —
            - paragraph [ref=e354]: "Reason: 5 questions queued · voice not connected, nothing will be asked"
          - button "Concepts 0" [ref=e356]
          - button "Engineering view" [ref=e357]
        - region [ref=e359]:
          - heading "Event ticker · live ledger" [level=2] [ref=e361]:
            - text: Event ticker
            - generic [ref=e362]: · live ledger
          - log "Ledger events" [ref=e363]:
            - listitem [ref=e364]:
              - time [ref=e365]: 09:51:17
              - generic [ref=e366]: engine
              - generic "Question queued · unexplained decision · EIG 1.20 bits · “What made you decide to approve onboarding here, and what would have …”" [ref=e367]
            - listitem [ref=e368]:
              - time [ref=e369]: 09:51:17
              - generic [ref=e370]: engine
              - generic "Question queued · competing explanations · EIG 0.60 bits · “If the analyst risk rating were \"medium\" instead of high, what would …”" [ref=e371]
            - listitem [ref=e372]:
              - time [ref=e373]: 09:51:17
              - generic [ref=e374]: engine
              - generic "Question queued · competing explanations · EIG 0.60 bits · “If the country risk were \"medium\" instead of high, what would you dec…”" [ref=e375]
            - listitem [ref=e376]:
              - time [ref=e377]: 09:51:17
              - generic [ref=e378]: engine
              - generic "Question queued · competing explanations · EIG 0.60 bits · “If the customer were \"new\" instead of existing, with a relationship a…”" [ref=e379]
            - listitem [ref=e380]:
              - time [ref=e381]: 09:51:17
              - generic [ref=e382]: engine
              - generic "Question queued · competing explanations · EIG 0.60 bits · “If the relationship age were 0 months instead of 36, with the custome…”" [ref=e383]
            - listitem [ref=e384]:
              - time [ref=e385]: 09:51:17
              - generic [ref=e386]: voice
              - 'generic "Expert: “Okay. The key points here are the ownership and the country.”" [ref=e387]'
            - listitem [ref=e388]:
              - time [ref=e389]: 09:51:18
              - generic [ref=e390]: engine
              - generic "Agent turn skipped (Not control message)" [ref=e391]
            - listitem [ref=e392]:
              - time [ref=e393]: 09:51:19
              - generic [ref=e394]: voice
              - 'generic "Expert: “Well, let me think.”" [ref=e395]'
            - listitem [ref=e396]:
              - time [ref=e397]: 09:51:30
              - generic [ref=e398]: engine
              - generic "Agent turn skipped (Not control message)" [ref=e399]
            - listitem [ref=e400]:
              - time [ref=e401]: 09:51:30
              - generic [ref=e402]: voice
              - 'generic "Expert: “They''ve banked with us for three years, and their source of funds is verified, so the hig…”" [ref=e403]'
            - listitem [ref=e404]:
              - time [ref=e405]: 09:51:34
              - generic [ref=e406]: engine
              - generic "Gate authorized · “What made you decide to approve onboarding here, and what would have …” · 12 ms after valid" [ref=e407]
            - listitem [ref=e408]:
              - time [ref=e409]: 09:51:35
              - generic [ref=e410]: control
              - generic "Control message" [ref=e411]
            - listitem [ref=e412]:
              - time [ref=e413]: 09:51:39
              - generic [ref=e414]: engine
              - generic "Agent asks · “What made you decide to approve onboarding here, and what would have …”" [ref=e415]
            - listitem [ref=e416]:
              - time [ref=e417]: 09:51:40
              - generic [ref=e418]: control
              - 'generic "Control message (refused: unknown_nonce)" [ref=e419]'
            - listitem [ref=e420]:
              - time [ref=e421]: 09:51:40
              - generic [ref=e422]: engine
              - generic "Agent turn skipped (Unknown nonce)" [ref=e423]
            - listitem [ref=e424]:
              - time [ref=e425]: 09:51:40
              - generic [ref=e426]: engine
              - generic "Gate authorized · “If the analyst risk rating were \"medium\" instead of high, what would …” · 5228 ms after valid" [ref=e427]
            - listitem [ref=e428]:
              - time [ref=e429]: 09:51:41
              - generic [ref=e430]: control
              - generic "Control message" [ref=e431]
            - listitem [ref=e432]:
              - time [ref=e433]: 09:51:41
              - generic [ref=e434]: engine
              - generic "Agent asks · “If the analyst risk rating were \"medium\" instead of high, what would …”" [ref=e435]
            - listitem [ref=e436]:
              - time [ref=e437]: 09:51:41
              - generic [ref=e438]: engine
              - generic "Answer parsed · 0 hypothesis(es) eliminated · 0 rule(s) stated · 0 new concept(s)" [ref=e439]
            - listitem [ref=e440]:
              - time [ref=e441]: 09:51:42
              - generic [ref=e442]: engine
              - 'generic "Agent: “If the analyst risk rating were \"medium\" instead of high, what would you decide?”" [ref=e443]'
            - listitem [ref=e444]:
              - time [ref=e445]: 09:51:46
              - generic [ref=e446]: engine
              - generic "Agent turn skipped (Not control message)" [ref=e447]
            - listitem [ref=e448]:
              - time [ref=e449]: 09:51:47
              - generic [ref=e450]: voice
              - 'generic "Expert: “Well, let me think.”" [ref=e451]'
            - listitem [ref=e452]:
              - time [ref=e453]: 09:51:58
              - generic [ref=e454]: engine
              - generic "Agent turn skipped (Not control message)" [ref=e455]
            - listitem [ref=e456]:
              - time [ref=e457]: 09:51:58
              - generic [ref=e458]: dom
              - generic "Opened case · NS-2026-0103" [ref=e459]
            - listitem [ref=e460]:
              - time [ref=e461]: 09:51:58
              - generic [ref=e462]: voice
              - 'generic "Expert: “They''ve banked with us for three years, and their source of funds is verified, so the hig…”" [ref=e463]'
            - listitem [ref=e464]:
              - time [ref=e465]: 09:52:00
              - generic [ref=e466]: engine
              - generic "Agent turn skipped (Not control message)" [ref=e467]
            - listitem [ref=e468]:
              - time [ref=e469]: 09:52:01
              - generic [ref=e470]: voice
              - 'generic "Expert: “Hmm. Let me think about this one.”" [ref=e471]'
            - listitem [ref=e472]:
              - time [ref=e473]: 09:52:05
              - generic [ref=e474]: engine
              - generic "Gate authorized · “If the country risk were \"medium\" instead of high, what would you dec…” · 0 ms after valid" [ref=e475]
            - listitem [ref=e476]:
              - time [ref=e477]: 09:52:05
              - generic [ref=e478]: control
              - generic "Control message" [ref=e479]
            - listitem [ref=e480]:
              - time [ref=e481]: 09:52:05
              - generic [ref=e482]: engine
              - generic "Agent asks · “If the country risk were \"medium\" instead of high, what would you dec…”" [ref=e483]
            - listitem [ref=e484]:
              - time [ref=e485]: 09:52:07
              - generic [ref=e486]: engine
              - 'generic "Agent: “If the country ...”" [ref=e487]'
            - listitem [ref=e488]:
              - time [ref=e489]: 09:52:10
              - generic [ref=e490]: dom
              - 'generic "Analyst risk rating changed: Unrated→High · NS-2026-0103" [ref=e491]'
            - listitem [ref=e492]:
              - time [ref=e493]: 09:52:10
              - generic [ref=e494]: engine
              - generic "Agent turn skipped (Not control message)" [ref=e495]
            - listitem [ref=e496]:
              - time [ref=e497]: 09:52:11
              - generic [ref=e498]: engine
              - generic "Interlock check · Escalate to compliance officer · NS-2026-0103 → Needs approval" [ref=e499]
            - listitem [ref=e500]:
              - time [ref=e501]: 09:52:12
              - generic [ref=e502]: engine
              - generic "Answer parsed · 0 hypothesis(es) eliminated · 0 rule(s) stated · 0 new concept(s)" [ref=e503]
            - listitem [ref=e504]:
              - time [ref=e505]: 09:52:12
              - generic [ref=e506]: voice
              - 'generic "Expert: “Okay. The key points here are the ownership and the country.”" [ref=e507]'
            - listitem [ref=e508]:
              - time [ref=e509]: 09:52:14
              - generic [ref=e510]: dom
              - 'generic "Decision saved: Escalate to compliance officer · NS-2026-0103 · escalated" [ref=e511]'
            - listitem [ref=e512]:
              - time [ref=e513]: 09:52:14
              - generic [ref=e514]: engine
              - 'generic "Contradiction detected · reviewOutcome · top: if largest beneficial owner share above 25% and largest owner identity verified is no then enhancedReview (0.11) · surprise 5.62 bits" [ref=e515]'
            - listitem [ref=e516]:
              - time [ref=e517]: 09:52:14
              - generic [ref=e518]: dom
              - 'generic "Action: Escalate to compliance officer · NS-2026-0103" [ref=e519]'
            - listitem [ref=e520]:
              - time [ref=e521]: 09:52:16
              - generic [ref=e522]: engine
              - generic "Question dropped (Superseded) · “If the relationship age were 0 months instead of 36, with the custome…”" [ref=e523]
            - listitem [ref=e524]:
              - time [ref=e525]: 09:52:16
              - generic [ref=e526]: engine
              - generic "Question queued · unexplained decision · EIG 5.62 bits · “What told you to escalate to the compliance officer here, and what wo…”" [ref=e527]
            - listitem [ref=e528]:
              - time [ref=e529]: 09:52:16
              - generic [ref=e530]: engine
              - generic "Question queued · contradiction detected · EIG 1.36 bits · “If the largest owner's identity were not verified, so \"no\" instead of…”" [ref=e531]
            - listitem [ref=e532]:
              - time [ref=e533]: 09:52:16
              - generic [ref=e534]: engine
              - generic "Question queued · contradiction detected · EIG 1.33 bits · “If the largest beneficial owner share were 40% instead of 100% for th…”" [ref=e535]
            - listitem [ref=e536]:
              - time [ref=e537]: 09:52:16
              - generic [ref=e538]: engine
              - generic "Question queued · contradiction detected · EIG 1.30 bits · “If the entity type were \"company\" instead of individual, what would y…”" [ref=e539]
            - listitem [ref=e540]:
              - time [ref=e541]: 09:52:16
              - generic [ref=e542]: engine
              - generic "Question queued · contradiction detected · EIG 1.28 bits · “If the country risk were \"medium\" instead of low, what would you deci…”" [ref=e543]
            - listitem [ref=e544]:
              - time [ref=e545]: 09:52:17
              - generic [ref=e546]: engine
              - generic "Agent turn skipped (Not control message)" [ref=e547]
            - listitem [ref=e548]:
              - time [ref=e549]: 09:52:17
              - generic [ref=e550]: voice
              - 'generic "Expert: “Well, let me think.”" [ref=e551]'
            - listitem [ref=e552]:
              - time [ref=e553]: 09:52:26
              - generic [ref=e554]: engine
              - generic "Agent turn skipped (Not control message)" [ref=e555]
            - listitem [ref=e556]:
              - time [ref=e557]: 09:52:26
              - generic [ref=e558]: voice
              - 'generic "Expert: “The country doesn''t matter here. A politically exposed person always goes to the complian…”" [ref=e559]'
            - listitem [ref=e560]:
              - time [ref=e561]: 09:52:41
              - generic [ref=e562]: engine
              - generic "Answer parsed · 4 hypothesis(es) eliminated · 1 rule(s) stated · 0 new concept(s)" [ref=e563]
            - listitem [ref=e564]:
              - time [ref=e565]: 09:52:41
              - generic [ref=e566]: engine
              - generic "Rule confirmed" [ref=e567]
            - listitem [ref=e568]:
              - time [ref=e569]: 09:52:41
              - generic [ref=e570]: engine
              - 'generic "Hypotheses updated · reviewOutcome · top: if country risk is not high and analyst risk rating is not medium then escalateCompliance (0.20)" [ref=e571]'
            - listitem [ref=e572]:
              - time [ref=e573]: 09:52:43
              - generic [ref=e574]: engine
              - generic "Question dropped (Superseded) · “What told you to escalate to the compliance officer here, and what wo…”" [ref=e575]
            - listitem [ref=e576]:
              - time [ref=e577]: 09:52:43
              - generic [ref=e578]: engine
              - generic "Question dropped (Superseded) · “If the largest beneficial owner share were 40% instead of 100% for th…”" [ref=e579]
            - listitem [ref=e580]:
              - time [ref=e581]: 09:52:43
              - generic [ref=e582]: engine
              - generic "Question dropped (Superseded) · “If the entity type were \"company\" instead of individual, what would y…”" [ref=e583]
            - listitem [ref=e584]:
              - time [ref=e585]: 09:52:43
              - generic [ref=e586]: engine
              - generic "Question dropped (Superseded) · “If the country risk were \"medium\" instead of low, what would you deci…”" [ref=e587]
            - listitem [ref=e588]:
              - time [ref=e589]: 09:52:43
              - generic [ref=e590]: engine
              - generic "Question queued · competing explanations · EIG 0.98 bits · “If the analyst risk rating were \"medium\" instead of high, what would …”" [ref=e591]
            - listitem [ref=e592]:
              - time [ref=e593]: 09:52:43
              - generic [ref=e594]: engine
              - generic "Question queued · competing explanations · EIG 0.79 bits · “If the politically exposed person flag were \"no\" instead of yes, what…”" [ref=e595]
            - listitem [ref=e596]:
              - time [ref=e597]: 09:52:43
              - generic [ref=e598]: engine
              - generic "Question queued · competing explanations · EIG 0.78 bits · “If the country risk were \"high\" instead of low, what would you decide?”" [ref=e599]
            - listitem [ref=e600]:
              - time [ref=e601]: 09:52:43
              - generic [ref=e602]: engine
              - generic "Question queued · competing explanations · EIG 0.72 bits · “If the largest beneficial owner share were 10% instead of 100%, for t…”" [ref=e603]
        - region [ref=e604]:
          - heading "Compliance · computed from the ledger" [level=2] [ref=e605]
          - list "Compliance" [ref=e606]:
            - 'listitem "Live questions: 6/3, earned" [ref=e607]':
              - generic [ref=e612]: Live questions
              - generic [ref=e613]: 6/3
            - 'listitem "Guardrail: ✗, pending" [ref=e614]':
              - generic [ref=e624]: Guardrail
              - generic [ref=e625]: ✗
            - 'listitem "Debrief gaps closed: 0/3, pending" [ref=e626]':
              - generic [ref=e636]: Debrief gaps closed
              - generic [ref=e637]: 0/3
            - 'listitem "Teach-back: ✗, pending" [ref=e638]':
              - generic [ref=e648]: Teach-back
              - generic [ref=e649]: ✗
            - 'listitem "Unseen case intercepted: ✗, pending" [ref=e650]':
              - generic [ref=e660]: Unseen case intercepted
              - generic [ref=e661]: ✗
  - alert [ref=e662]
```

# Test source

```ts
  1   | /**
  2   |  * @live @p3 — P3 acceptance, LIVE against production (plan §11 P3): five scripted typing/talking runs in
  3   |  * Expert sessions with the (synthetic) screen shared and a real ElevenLabs interviewer over WebRTC.
  4   |  * Expert speech is synthetic voice input (ElevenLabs TTS) played into the harness microphone, so the
  5   |  * script knows its own speech, typing and scrolling windows exactly. Per run: questions asked,
  6   |  * interruptions (must be 0), authorization latency p50/p95/max, first-audio p50/p95, and control turns
  7   |  * never in evidence. Evidence: docs/evidence/live/p3/.
  8   |  *
  9   |  * Answers avoid stop-rule wording ("never …"), so these runs add no forbid/approval rules to the shared
  10  |  * production rulebook (see support/answers.ts).
  11  |  */
  12  | import { expect, test } from "@playwright/test";
  13  | import { allAnswerLines, CASE_PLANS } from "./support/answers";
  14  | import { Expert } from "./support/expert";
  15  | import { answerQuestions, finishRun, type Asked, type AnswerStyle } from "./support/flow";
  16  | import { evidencePath } from "./support/report";
  17  | 
  18  | const GROUP = "p3";
  19  | const TRAINING = ["NS-2026-0101", "NS-2026-0102", "NS-2026-0103"];
  20  | const PRACTICE = ["NS-2026-0301", "NS-2026-0302", "NS-2026-0303", "NS-2026-0304", "NS-2026-0305", "NS-2026-0306"];
  21  | 
  22  | function plan(caseId: string) {
  23  |   const p = CASE_PLANS[caseId];
  24  |   if (p === undefined) throw new Error(`no plan for ${caseId}`);
  25  |   return p;
  26  | }
  27  | 
  28  | async function begin(expert: Expert, set: "Training" | "Practice", extraLines: string[], caseIds: string[]) {
  29  |   await expert.startSession(set);
  30  |   await expert.preload([...allAnswerLines(caseIds, false), ...extraLines]);
  31  |   await expert.shareScreen();
  32  |   await expert.startInterview();
  33  |   await expert.page.waitForTimeout(1000);
  34  | }
  35  | 
  36  | function expectGreen(a: Awaited<ReturnType<typeof finishRun>>) {
  37  |   expect.soft(a.interruptions.count, "interruptions").toBe(0);
  38  |   expect.soft(a.controlNeverEvidence.ok, "control turns never evidence").toBe(true);
> 39  |   for (const v of a.authorizationLatencyMs.values) expect.soft(v, "authorization latency ≤ 250 ms").toBeLessThanOrEqual(250);
      |                                                                                                     ^ Error: authorization latency ≤ 250 ms
  40  |   expect.soft(a.counts.questionsAuthorized, "at least one question asked").toBeGreaterThan(0);
  41  | }
  42  | 
  43  | 
  44  | 
  45  | test("@live @p3 run A: expert types a note while talking", async ({ page, request }) => {
  46  |   const expert = await Expert.open(page, request);
  47  |   const NARRATE = "Let me jot down the ownership details while I read through this file.";
  48  |   const notes = ["UBO 35 pct unverified - registry extract pending", "existing client 36m, funds verified, HR country", "PEP individual, low risk country"];
  49  |   await begin(expert, "Training", [NARRATE], TRAINING);
  50  |   const asked: Asked[] = [];
  51  |   // Answer while typing a note about it at the same time.
  52  |   const typingAnswer: AnswerStyle = async (e, answer) => {
  53  |     await Promise.all([e.say(answer, "answer+typing"), e.page.waitForTimeout(600).then(() => e.typeNote("noted: answered agent", 90))]);
  54  |   };
  55  |   for (const [i, caseId] of TRAINING.entries()) {
  56  |     await expert.resetCursor();
  57  |     await expert.openCase(i);
  58  |     await Promise.all([expert.say(NARRATE, "narrate+typing"), expert.typeNote(notes[i] ?? "note", 80)]);
  59  |     await expert.rateByKeyboard(plan(caseId).rating);
  60  |     await expert.decide(plan(caseId).outcome);
  61  |     // A question is now queued; keep typing — the gate must wait.
  62  |     await expert.typeNote("follow up: file the review memo", 110);
  63  |     await answerQuestions(expert, caseId, { waitMs: 14_000, max: 2, style: typingAnswer, log: asked });
  64  |     if (i === 0) await page.screenshot({ path: evidencePath(GROUP, "run-a-after-first-question.png") });
  65  |   }
  66  |   await answerQuestions(expert, TRAINING.at(-1) ?? "", { waitMs: 8000, max: 2, style: typingAnswer, log: asked });
  67  |   const a = await finishRun(expert, { group: GROUP, name: `run-a-typing-${expert.sessionId}`, title: "P3 run A — expert types a note while talking (LIVE, production)", asked });
  68  |   expectGreen(a);
  69  | });
  70  | 
  71  | test("@live @p3 run B: long pause, then resumes mid-answer", async ({ page, request }) => {
  72  |   const expert = await Expert.open(page, request);
  73  |   const THINK = "Hmm, let me think about this one.";
  74  |   const RESUME = "Okay. The key points here are the ownership and the country.";
  75  |   const WELL = "Well, let me think.";
  76  |   await begin(expert, "Training", [THINK, RESUME, WELL], TRAINING);
  77  |   const asked: Asked[] = [];
  78  |   // Starts answering, falls silent for 3.5 s mid-answer, then resumes.
  79  |   const pausingAnswer: AnswerStyle = async (e, answer) => {
  80  |     await e.say(WELL, "answer-part-1");
  81  |     await e.mark("long_pause_start");
  82  |     await e.page.waitForTimeout(3500);
  83  |     await e.mark("long_pause_end");
  84  |     await e.say(answer, "answer-part-2");
  85  |   };
  86  |   for (const [i, caseId] of TRAINING.entries()) {
  87  |     await expert.resetCursor();
  88  |     await expert.openCase(i);
  89  |     await expert.say(THINK, "think-aloud");
  90  |     await expert.mark("long_pause_start");
  91  |     await page.waitForTimeout(6000);
  92  |     await expert.mark("long_pause_end");
  93  |     await expert.say(RESUME, "resume");
  94  |     await expert.rate(plan(caseId).rating);
  95  |     await expert.decide(plan(caseId).outcome);
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
```