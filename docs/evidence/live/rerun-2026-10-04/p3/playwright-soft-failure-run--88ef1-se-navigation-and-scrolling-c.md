# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: p3-gate.live.spec.ts >> @live @p3 run C: rapid case navigation and scrolling
- Location: e2e/live/p3-gate.live.spec.ts:103:1

# Error details

```
Error: authorization latency ≤ 250 ms

expect(received).toBeLessThanOrEqual(expected)

Expected: <= 250
Received:    1785
```

```
Error: authorization latency ≤ 250 ms

expect(received).toBeLessThanOrEqual(expected)

Expected: <= 250
Received:    4157
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
          - generic "9f659c71-b22c-462a-9c4e-1fc2a1102909" [ref=e23]: 9f659c71
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
            - status [ref=e243]: “Analyst risk rating” is not on screen
            - region [ref=e247]:
              - heading "Transcript" [level=3] [ref=e248]
              - log [ref=e249]:
                - listitem [ref=e250]:
                  - generic [ref=e251]: "Agent:"
                  - text: What led you to send this to enhanced review? And what would have changed your mind?
                - listitem [ref=e252]:
                  - generic [ref=e253]: "Expert:"
                  - text: The largest owner holds 35% and isn't verified. Anything over 25% that isn't verified goes to enhanced review.
                - listitem [ref=e254]:
                  - generic [ref=e255]: "Agent:"
                  - text: If the country risk were "high" instead of medium, what would you decide?
                - listitem [ref=e256]:
                  - generic [ref=e257]: "Expert:"
                  - text: No, the country doesn't drive this one. It's the unverified owner holding 35%.
                - listitem [ref=e258]:
                  - generic [ref=e259]: "Agent:"
                  - text: What told you to approve onboarding here, and what would have changed your mind?
                - listitem [ref=e260]:
                  - generic [ref=e261]: "Expert:"
                  - text: They've banked with us for three years, and their source of funds is verified, so the high-risk country on its own doesn't send them to enhanced review.
                - listitem [ref=e262]:
                  - generic [ref=e263]: "Agent:"
                  - text: If the analyst risk rating were "medium" instead of high, what would you decide?
                - listitem [ref=e264]:
                  - generic [ref=e265]: "Expert:"
                  - text: They've banked with us for three years, and their source of funds is verified, so the high-risk country on its own doesn't send them to enhanced review.
                - listitem [ref=e266]:
                  - generic [ref=e267]: "Agent:"
                  - text: What pushed you to escalate to the compliance officer here, and what would have changed your mind?
                - listitem [ref=e268]:
                  - generic [ref=e269]: "Expert:"
                  - text: She's a politically exposed person, so it goes to the compliance officer, whatever else the file says.
        - region [ref=e270]:
          - generic [ref=e271]:
            - heading "Review" [level=2] [ref=e272]
            - generic [ref=e273]: NS-2026-0103
          - generic [ref=e275]:
            - status [ref=e276]: Decision committed
            - generic [ref=e280]:
              - term [ref=e281]: Outcome
              - definition [ref=e282]: Escalate to compliance officer
              - term [ref=e283]: Risk rating
              - definition [ref=e284]: High
              - term [ref=e285]: Interlock
              - definition [ref=e286]:
                - text: Needed approval
                - generic [ref=e287]: · 1 rule(s) matched
              - term [ref=e288]: Escalated
              - definition [ref=e289]: “Escalating to the compliance officer for sign-off.”
              - term [ref=e290]: Ledger entry
              - definition [ref=e291]: fec45088
        - status [ref=e292]: All DOM events delivered
        - region [ref=e293]:
          - generic [ref=e294]:
            - heading "Screen capture" [level=2] [ref=e295]
            - status "Screen capture status" [ref=e303]:
              - generic [ref=e304]: Capturing
          - generic [ref=e306]:
            - paragraph [ref=e307]: "Screen frames: change-detected, best-effort PII blur in your browser before upload."
            - button "Stop sharing" [ref=e308]
            - paragraph [ref=e309]: "Vision: 2 events from 41 frames · p95 frame→event 6417 ms"
            - group [ref=e310]:
              - generic "Perception stats" [ref=e311] [cursor=pointer]
      - generic [ref=e313]:
        - generic [ref=e314]:
          - region "Speech gate" [ref=e316]:
            - 'status "Gate status: LISTENING" [ref=e317]': LISTENING
            - list "Gate conditions" [ref=e318]:
              - 'listitem "Typing: clear" [ref=e319]':
                - generic [ref=e320]: Typing
                - generic [ref=e321]: ✓
              - 'listitem "Speaking: clear" [ref=e322]':
                - generic [ref=e323]: Speaking
                - generic [ref=e324]: ✓
              - 'listitem "Screen moving: clear" [ref=e325]':
                - generic [ref=e326]: Screen moving
                - generic [ref=e327]: ✓
            - generic "Question value" [ref=e328]: —
            - paragraph [ref=e332]: "Reason: 5 questions queued · voice not connected, nothing will be asked"
          - button "Concepts 0" [ref=e334]
          - button "Engineering view" [ref=e335]
        - region [ref=e337]:
          - heading "Event ticker · live ledger" [level=2] [ref=e339]:
            - text: Event ticker
            - generic [ref=e340]: · live ledger
          - log "Ledger events" [ref=e341]:
            - listitem [ref=e342]:
              - time [ref=e343]: 09:56:01
              - generic [ref=e344]: client
              - 'generic "Frame #64 received · 0 region(s) redacted" [ref=e345]'
            - listitem [ref=e346]:
              - time [ref=e347]: 09:56:02
              - generic [ref=e348]: client
              - 'generic "Frame #65 received · 0 region(s) redacted" [ref=e349]'
            - listitem [ref=e350]:
              - time [ref=e351]: 09:56:02
              - generic [ref=e352]: dom
              - 'generic "Analyst risk rating changed: Unrated→High · NS-2026-0103" [ref=e353]'
            - listitem [ref=e354]:
              - time [ref=e355]: 09:56:03
              - generic [ref=e356]: engine
              - generic "Interlock check · Escalate to compliance officer · NS-2026-0103 → Needs approval" [ref=e357]
            - listitem [ref=e358]:
              - time [ref=e359]: 09:56:06
              - generic [ref=e360]: dom
              - 'generic "Decision saved: Escalate to compliance officer · NS-2026-0103 · escalated" [ref=e361]'
            - listitem [ref=e362]:
              - time [ref=e363]: 09:56:06
              - generic [ref=e364]: engine
              - 'generic "Contradiction detected · reviewOutcome · top: if largest beneficial owner share above 25% and largest owner identity verified is no then enhancedReview (0.23) · surprise 6.31 bits" [ref=e365]'
            - listitem [ref=e366]:
              - time [ref=e367]: 09:56:06
              - generic [ref=e368]: dom
              - 'generic "Action: Escalate to compliance officer · NS-2026-0103" [ref=e369]'
            - listitem [ref=e370]:
              - time [ref=e371]: 09:56:06
              - generic [ref=e372]: dom
              - generic "Opened case · NS-2026-0101" [ref=e373]
            - listitem [ref=e374]:
              - time [ref=e375]: 09:56:06
              - generic [ref=e376]: client
              - 'generic "Frame #66 received · 0 region(s) redacted" [ref=e377]'
            - listitem [ref=e378]:
              - time [ref=e379]: 09:56:07
              - generic [ref=e380]: client
              - 'generic "Frame #67 received · 0 region(s) redacted" [ref=e381]'
            - listitem [ref=e382]:
              - time [ref=e383]: 09:56:07
              - generic [ref=e384]: dom
              - generic "Opened case · NS-2026-0102" [ref=e385]
            - listitem [ref=e386]:
              - time [ref=e387]: 09:56:07
              - generic [ref=e388]: client
              - 'generic "Frame #68 received · 0 region(s) redacted" [ref=e389]'
            - listitem [ref=e390]:
              - time [ref=e391]: 09:56:08
              - generic [ref=e392]: engine
              - generic "Question dropped (Superseded) · “If the relationship age were 0 months instead of 36, with the custome…”" [ref=e393]
            - listitem [ref=e394]:
              - time [ref=e395]: 09:56:08
              - generic [ref=e396]: engine
              - generic "Question dropped (Superseded) · “If the largest owner's identity were not verified, so \"no\" instead of…”" [ref=e397]
            - listitem [ref=e398]:
              - time [ref=e399]: 09:56:08
              - generic [ref=e400]: engine
              - generic "Question dropped (Superseded) · “If the analyst risk rating were unrated instead of high, what would y…”" [ref=e401]
            - listitem [ref=e402]:
              - time [ref=e403]: 09:56:08
              - generic [ref=e404]: engine
              - generic "Question dropped (Superseded) · “If the largest beneficial owner share were 35% instead of 20%, what w…”" [ref=e405]
            - listitem [ref=e406]:
              - time [ref=e407]: 09:56:08
              - generic [ref=e408]: engine
              - generic "Question queued · unexplained decision · EIG 6.31 bits · “What pushed you to escalate to the compliance officer here, and what …”" [ref=e409]
            - listitem [ref=e410]:
              - time [ref=e411]: 09:56:08
              - generic [ref=e412]: engine
              - generic "Question queued · contradiction detected · EIG 0.91 bits · “If the largest owner's identity were not verified, so \"no\" instead of…”" [ref=e413]
            - listitem [ref=e414]:
              - time [ref=e415]: 09:56:08
              - generic [ref=e416]: engine
              - generic "Question queued · contradiction detected · EIG 0.86 bits · “Suppose the largest beneficial owner share were 40% instead of 100%, …”" [ref=e417]
            - listitem [ref=e418]:
              - time [ref=e419]: 09:56:08
              - generic [ref=e420]: engine
              - generic "Question queued · contradiction detected · EIG 0.81 bits · “If the entity type were \"company\" instead of individual, what would y…”" [ref=e421]
            - listitem [ref=e422]:
              - time [ref=e423]: 09:56:08
              - generic [ref=e424]: engine
              - generic "Question queued · contradiction detected · EIG 0.80 bits · “If the analyst risk rating were \"medium\" instead of high, what would …”" [ref=e425]
            - listitem [ref=e426]:
              - time [ref=e427]: 09:56:08
              - generic [ref=e428]: dom
              - generic "Opened case · NS-2026-0103" [ref=e429]
            - listitem [ref=e430]:
              - time [ref=e431]: 09:56:08
              - generic [ref=e432]: client
              - 'generic "Frame #69 received · 0 region(s) redacted" [ref=e433]'
            - listitem [ref=e434]:
              - time [ref=e435]: 09:56:08
              - generic [ref=e436]: client
              - 'generic "Frame #70 received · 0 region(s) redacted" [ref=e437]'
            - listitem [ref=e438]:
              - time [ref=e439]: 09:56:08
              - generic [ref=e440]: dom
              - generic "Opened case · NS-2026-0101" [ref=e441]
            - listitem [ref=e442]:
              - time [ref=e443]: 09:56:09
              - generic [ref=e444]: client
              - 'generic "Frame #71 received · 0 region(s) redacted" [ref=e445]'
            - listitem [ref=e446]:
              - time [ref=e447]: 09:56:09
              - generic [ref=e448]: client
              - 'generic "Frame #72 received · 0 region(s) redacted" [ref=e449]'
            - listitem [ref=e450]:
              - time [ref=e451]: 09:56:09
              - generic [ref=e452]: dom
              - generic "Opened case · NS-2026-0102" [ref=e453]
            - listitem [ref=e454]:
              - time [ref=e455]: 09:56:10
              - generic [ref=e456]: dom
              - generic "Opened case · NS-2026-0103" [ref=e457]
            - listitem [ref=e458]:
              - time [ref=e459]: 09:56:10
              - generic [ref=e460]: client
              - 'generic "Frame #73 received · 0 region(s) redacted" [ref=e461]'
            - listitem [ref=e462]:
              - time [ref=e463]: 09:56:11
              - generic [ref=e464]: dom
              - generic "Opened case · NS-2026-0101" [ref=e465]
            - listitem [ref=e466]:
              - time [ref=e467]: 09:56:11
              - generic [ref=e468]: client
              - 'generic "Frame #74 received · 0 region(s) redacted" [ref=e469]'
            - listitem [ref=e470]:
              - time [ref=e471]: 09:56:11
              - generic [ref=e472]: client
              - 'generic "Frame #75 received · 0 region(s) redacted" [ref=e473]'
            - listitem [ref=e474]:
              - time [ref=e475]: 09:56:11
              - generic [ref=e476]: dom
              - generic "Opened case · NS-2026-0102" [ref=e477]
            - listitem [ref=e478]:
              - time [ref=e479]: 09:56:12
              - generic [ref=e480]: client
              - 'generic "Frame #76 received · 0 region(s) redacted" [ref=e481]'
            - listitem [ref=e482]:
              - time [ref=e483]: 09:56:12
              - generic [ref=e484]: dom
              - generic "Opened case · NS-2026-0103" [ref=e485]
            - listitem [ref=e486]:
              - time [ref=e487]: 09:56:12
              - generic [ref=e488]: client
              - 'generic "Frame #77 received · 0 region(s) redacted" [ref=e489]'
            - listitem [ref=e490]:
              - time [ref=e491]: 09:56:13
              - generic [ref=e492]: engine
              - generic "Answer parsed · 2 hypothesis(es) eliminated · 0 rule(s) stated · 0 new concept(s)" [ref=e493]
            - listitem [ref=e494]:
              - time [ref=e495]: 09:56:13
              - generic [ref=e496]: engine
              - 'generic "Hypotheses updated · reviewOutcome · top: if largest beneficial owner share above 25% and largest owner identity verified is no then enhancedReview (0.27)" [ref=e497]'
            - listitem [ref=e498]:
              - time [ref=e499]: 09:56:19
              - generic [ref=e500]: engine
              - generic "Gate authorized · “What pushed you to escalate to the compliance officer here, and what …” · 4157 ms after valid" [ref=e501]
            - listitem [ref=e502]:
              - time [ref=e503]: 09:56:20
              - generic [ref=e504]: engine
              - generic "Question dropped (Superseded) · “If the largest owner's identity were not verified, so \"no\" instead of…”" [ref=e505]
            - listitem [ref=e506]:
              - time [ref=e507]: 09:56:20
              - generic [ref=e508]: engine
              - generic "Question dropped (Superseded) · “Suppose the largest beneficial owner share were 40% instead of 100%, …”" [ref=e509]
            - listitem [ref=e510]:
              - time [ref=e511]: 09:56:20
              - generic [ref=e512]: engine
              - generic "Question dropped (Superseded) · “If the entity type were \"company\" instead of individual, what would y…”" [ref=e513]
            - listitem [ref=e514]:
              - time [ref=e515]: 09:56:20
              - generic [ref=e516]: engine
              - generic "Question dropped (Superseded) · “If the analyst risk rating were \"medium\" instead of high, what would …”" [ref=e517]
            - listitem [ref=e518]:
              - time [ref=e519]: 09:56:20
              - generic [ref=e520]: engine
              - generic "Question queued · competing explanations · EIG 0.92 bits · “If the largest owner's identity were not verified, so \"no\" instead of…”" [ref=e521]
            - listitem [ref=e522]:
              - time [ref=e523]: 09:56:20
              - generic [ref=e524]: engine
              - generic "Question queued · competing explanations · EIG 0.90 bits · “If the largest beneficial owner share were 40% instead of 100% for th…”" [ref=e525]
            - listitem [ref=e526]:
              - time [ref=e527]: 09:56:20
              - generic [ref=e528]: engine
              - generic "Question queued · competing explanations · EIG 0.86 bits · “If the entity type were \"company\" instead of individual, what would y…”" [ref=e529]
            - listitem [ref=e530]:
              - time [ref=e531]: 09:56:20
              - generic [ref=e532]: engine
              - generic "Question queued · competing explanations · EIG 0.78 bits · “If the expected monthly volume were EUR 15,000 instead of EUR 9,500, …”" [ref=e533]
            - listitem [ref=e534]:
              - time [ref=e535]: 09:56:20
              - generic [ref=e536]: engine
              - generic "Question queued · competing explanations · EIG 0.78 bits · “If the customer were not a politically exposed person, so pep is \"no\"…”" [ref=e537]
            - listitem [ref=e538]:
              - time [ref=e539]: 09:56:20
              - generic [ref=e540]: control
              - generic "Control message" [ref=e541]
            - listitem [ref=e542]:
              - time [ref=e543]: 09:56:20
              - generic [ref=e544]: engine
              - generic "Agent asks · “What pushed you to escalate to the compliance officer here, and what …”" [ref=e545]
            - listitem [ref=e546]:
              - time [ref=e547]: 09:56:22
              - generic [ref=e548]: engine
              - 'generic "Agent: “What pushed you to escalate to the compliance officer here, and what would have changed y…”" [ref=e549]'
            - listitem [ref=e550]:
              - time [ref=e551]: 09:56:31
              - generic [ref=e552]: engine
              - generic "Agent turn skipped (Not control message)" [ref=e553]
            - listitem [ref=e554]:
              - time [ref=e555]: 09:56:33
              - generic [ref=e556]: engine
              - generic "Agent turn skipped (Not control message)" [ref=e557]
            - listitem [ref=e558]:
              - time [ref=e559]: 09:56:34
              - generic [ref=e560]: voice
              - 'generic "Expert: “She''s a politically exposed person, so it goes to the compliance officer, whatever else t…”" [ref=e561]'
            - listitem [ref=e562]:
              - time [ref=e563]: 09:56:48
              - generic [ref=e564]: engine
              - generic "Answer parsed · 1 hypothesis(es) eliminated · 1 rule(s) stated · 0 new concept(s)" [ref=e565]
            - listitem [ref=e566]:
              - time [ref=e567]: 09:56:48
              - generic [ref=e568]: engine
              - generic "Rule confirmed" [ref=e569]
            - listitem [ref=e570]:
              - time [ref=e571]: 09:56:48
              - generic [ref=e572]: engine
              - 'generic "Hypotheses updated · reviewOutcome · top: if largest beneficial owner share above 25% and largest owner identity verified is no then enhancedReview (0.27)" [ref=e573]'
            - listitem [ref=e574]:
              - time [ref=e575]: 09:56:51
              - generic [ref=e576]: engine
              - generic "Question dropped (Superseded) · “If the customer were not a politically exposed person, so pep is \"no\"…”" [ref=e577]
            - listitem [ref=e578]:
              - time [ref=e579]: 09:56:51
              - generic [ref=e580]: engine
              - generic "Question queued · competing explanations · EIG 0.82 bits · “If country risk were \"medium\" instead of low, what would you decide?”" [ref=e581]
        - region [ref=e582]:
          - heading "Compliance · computed from the ledger" [level=2] [ref=e583]
          - list "Compliance" [ref=e584]:
            - 'listitem "Live questions: 5/3, earned" [ref=e585]':
              - generic [ref=e590]: Live questions
              - generic [ref=e591]: 5/3
            - 'listitem "Guardrail: ✗, pending" [ref=e592]':
              - generic [ref=e602]: Guardrail
              - generic [ref=e603]: ✗
            - 'listitem "Debrief gaps closed: 0/3, pending" [ref=e604]':
              - generic [ref=e614]: Debrief gaps closed
              - generic [ref=e615]: 0/3
            - 'listitem "Teach-back: ✗, pending" [ref=e616]':
              - generic [ref=e626]: Teach-back
              - generic [ref=e627]: ✗
            - 'listitem "Unseen case intercepted: ✗, pending" [ref=e628]':
              - generic [ref=e638]: Unseen case intercepted
              - generic [ref=e639]: ✗
  - alert [ref=e640]
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