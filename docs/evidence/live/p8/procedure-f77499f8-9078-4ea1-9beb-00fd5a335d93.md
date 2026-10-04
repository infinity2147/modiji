# Northstar Bank — Synthetic KYC Review: confirmed rules

Rulebook revision 23. Compiled by code from rules a human expert confirmed. Each rule quotes the expert's own words. Do not edit by hand; export again instead.

Before you confirm any action on a case, check every rule below. When a rule's condition holds, follow its instruction and tell the user the expert's quote. When a condition depends on information you do not have, ask for it before acting. Never assume it.

## Review outcome

### Rule rule_03e987e9b68836 (guardrail)

- **When:** Country risk (Northstar list) is high and Source of funds is not verified
- **Then:** Do not take the action "Approve onboarding" (approve).
- **Why:** the expert (expert-cad2596d-53dd-427d-aa45-d73d91bd7844, 1:02.9–1:10.0) said:

> Never approve a customer from a high-risk country at desk level unless they've banked with us for two years with verified funds.

### Rule rule_0db2a2b89d2203 (guardrail)

- **When:** Politically exposed person is yes
- **Then:** Any "Review outcome" decision needs approval from a compliance_officer before it is committed.
- **Why:** the expert (expert-f77499f8-9078-4ea1-9beb-00fd5a335d93, 0:55.4–1:00.1) said:

> Never approve a politically exposed person without compliance sign-off.

### Rule rule_1e5796de1f0929 (guardrail)

- **When:** Country risk (Northstar list) is high and Relationship age (months) is less than 24 months
- **Then:** Do not take the action "Approve onboarding" (approve).
- **Why:** the expert (expert-cad2596d-53dd-427d-aa45-d73d91bd7844, 1:02.9–1:10.0) said:

> Never approve a customer from a high-risk country at desk level unless they've banked with us for two years with verified funds.

### Rule rule_03907d56eb787e (exception)

- **When:** Country risk (Northstar list) is high and Source of funds is verified and Customer status is existing
- **Then:** The expected action is "Approve onboarding" (approve).
- **Why:** the expert (expert-4dfb1645-5772-47fe-bf92-3e3babd6d2fc, 1:18.5–1:26.7) said:

> They've banked with us for three years, and their source of funds is verified, so the high-risk country on its own doesn't send them to enhanced review.

### Rule rule_1aba5eb68f9a3d (exception)

- **When:** Country risk (Northstar list) is high and Relationship age (months) is at least 36 months and Source of funds is verified
- **Then:** The expected action is "Approve onboarding" (approve).
- **Why:** the expert (expert-da9b8e52-07ac-4180-bee0-0bba455da897, 1:08.0–1:16.4) said:

> They've banked with us for three years, and their source of funds is verified, so the high-risk country on its own doesn't send them to enhanced review.

### Rule rule_01070ba187e2c5 (escalation)

- **When:** Politically exposed person is yes
- **Then:** The expected action is "Escalate to compliance officer" (escalateCompliance).
- **Why:** the expert (expert-4dfb1645-5772-47fe-bf92-3e3babd6d2fc, 2:10.0–2:19.8) said:

> She's a politically exposed person, so it goes to the compliance officer, whatever else the file says.

### Rule rule_0e6d5f56f47b3a (escalation)

- **When:** Politically exposed person is yes
- **Then:** The expected action is "Escalate to compliance officer" (escalateCompliance).
- **Why:** the expert (expert-1368ae76-e5c3-482d-b817-e68ff3e5b8f1, 1:37.7–1:41.9) said:

> She's a politically exposed person, so it goes to the compliance officer.

### Rule rule_03ab16bbfa0b70 (decision)

- **When:** Largest beneficial owner share is more than 25% and Largest owner identity verified is no
- **Then:** The expected action is "Send to enhanced review" (enhancedReview).
- **Why:** the expert (expert-cfa8cfb6-0c75-4370-882a-e6b49d62c019, 1:13.3–1:19.9) said:

> If the largest owner holds more than 25% and isn't verified, it goes to enhanced review.

### Rule rule_05e570a9eb1b78 (decision)

- **When:** Source of funds is not verified
- **Then:** The expected action is "Send to enhanced review" (enhancedReview).
- **Why:** the expert (expert-10556ebc-1bdc-4f1e-b283-10331978795f, 1:11.7–1:18.2) said:

> Without it, I'd want enhanced review.

### Rule rule_0825544f35bccb (decision)

- **When:** Largest beneficial owner share is more than 25% and Largest owner identity verified is no
- **Then:** The expected action is "Send to enhanced review" (enhancedReview).
- **Why:** the expert (expert-f4f88cde-7b1c-4ac6-892b-9dbe5279f192, 0:19.6–0:28.2) said:

> Anything over 25% that isn't verified goes to enhanced review.

### Rule rule_116f597cd629bd (decision)

- **When:** Largest beneficial owner share is more than 25% and Largest owner identity verified is no
- **Then:** The expected action is "Send to enhanced review" (enhancedReview).
- **Why:** the expert (expert-10556ebc-1bdc-4f1e-b283-10331978795f, 0:31.3–0:39.9) said:

> Anything over 25% that isn't verified goes to enhanced review.

### Rule rule_144f1d067b6d4e (decision)

- **When:** Largest beneficial owner share is more than 25% and Largest owner identity verified is no
- **Then:** The expected action is "Send to enhanced review" (enhancedReview).
- **Why:** the expert (expert-4dfb1645-5772-47fe-bf92-3e3babd6d2fc, 0:47.7–0:54.2) said:

> If the largest owner holds more than 25% and isn't verified, it goes to enhanced review.

### Rule rule_15ac7035644056 (decision)

- **When:** Largest beneficial owner share is more than 25% and Largest owner identity verified is no
- **Then:** The expected action is "Send to enhanced review" (enhancedReview).
- **Why:** the expert (expert-cfa8cfb6-0c75-4370-882a-e6b49d62c019, 0:19.6–0:28.2) said:

> Anything over 25% that isn't verified goes to enhanced review.

### Rule rule_15afbdc3922d03 (decision)

- **When:** Source of funds is not_provided and Expected monthly volume is more than 50,000 EUR
- **Then:** The expected action is "Request documents" (requestDocuments).
- **Why:** the expert (expert-e0ca4cd6-0101-4cc0-9014-33a0720adbeb, 1:04.7–1:12.6) said:

> Above 50,000 a month without a source of funds, I request documents.

### Rule rule_15c7a9caf6b031 (decision)

- **When:** Largest beneficial owner share is more than 25% and Largest owner identity verified is no
- **Then:** The expected action is "Send to enhanced review" (enhancedReview).
- **Why:** the expert (expert-e0ca4cd6-0101-4cc0-9014-33a0720adbeb, 1:27.9–1:34.3) said:

> If the largest owner holds more than 25% and isn't verified, it goes to enhanced review.

### Rule rule_171a5b41cd4ac8 (decision)

- **When:** Largest beneficial owner share is more than 25% and Largest owner identity verified is no
- **Then:** The expected action is "Send to enhanced review" (enhancedReview).
- **Why:** the expert (expert-cad2596d-53dd-427d-aa45-d73d91bd7844, 0:37.0–0:43.4) said:

> If the largest owner holds more than 25% and isn't verified, it goes to enhanced review.

### Rule rule_1779bf245d6bff (decision)

- **When:** Largest beneficial owner share is more than 25% and Largest owner identity verified is no
- **Then:** The expected action is "Send to enhanced review" (enhancedReview).
- **Why:** the expert (expert-cad2596d-53dd-427d-aa45-d73d91bd7844, 0:14.9–0:23.6) said:

> Anything over 25% that isn't verified goes to enhanced review.

### Rule rule_1841412ed4a1d8 (decision)

- **When:** Largest beneficial owner share is more than 25% and Largest owner identity verified is no
- **Then:** The expected action is "Send to enhanced review" (enhancedReview).
- **Why:** the expert (expert-1368ae76-e5c3-482d-b817-e68ff3e5b8f1, 0:15.6–0:24.2) said:

> Anything over 25% that isn't verified goes to enhanced review.

### Rule rule_1c0c500bd78c2d (decision)

- **When:** Largest beneficial owner share is more than 25% and Largest owner identity verified is no
- **Then:** The expected action is "Send to enhanced review" (enhancedReview).
- **Why:** the expert (expert-788b099b-d6d4-4c5c-88fe-fa319f0f4802, 0:19.6–0:28.2) said:

> Anything over 25% that isn't verified goes to enhanced review.

### Rule rule_1c41c261f0b59a (decision)

- **When:** Largest beneficial owner share is more than 25% and Largest owner identity verified is no
- **Then:** The expected action is "Send to enhanced review" (enhancedReview).
- **Why:** the expert (expert-94cf3b7b-e6dd-457c-a038-8908a4b6e885, 0:30.6–0:39.1) said:

> Anything over 25% that isn't verified goes to enhanced review.

### Rule rule_1cdbe70b974ed9 (decision)

- **When:** Largest beneficial owner share is more than 25% and Largest owner identity verified is no
- **Then:** The expected action is "Send to enhanced review" (enhancedReview).
- **Why:** the expert (expert-4dfb1645-5772-47fe-bf92-3e3babd6d2fc, 0:25.8–0:34.5) said:

> Anything over 25% that isn't verified goes to enhanced review.

### Rule rule_1e58bdad60bc40 (decision)

- **When:** Largest beneficial owner share is more than 25% and Largest owner identity verified is no
- **Then:** The expected action is "Send to enhanced review" (enhancedReview).
- **Why:** the expert (expert-f77499f8-9078-4ea1-9beb-00fd5a335d93, 0:16.5–0:25.0) said:

> Anything over 25% that isn't verified goes to enhanced review

### Rule rule_1f58dab96927e9 (decision)

- **When:** Largest beneficial owner share is more than 25% and Largest owner identity verified is no
- **Then:** The expected action is "Send to enhanced review" (enhancedReview).
- **Why:** the expert (expert-b1d397a6-0b92-427d-86ac-f61bb8838546, 0:20.9–0:29.5) said:

> Anything over 25% that isn't verified goes to enhanced review.

## Machine-readable copy

The same rules as data, generated together with the text above. Used to validate this export.

```json
{"format":"vashistha.procedure-rules/1","domainId":"kycNorthstar","rulebookRevision":23,"rules":[
{"id":"rule_03e987e9b68836","decisionFamily":"reviewOutcome","kind":"guardrail","predicate":{"and":[{"==":[{"var":"jurisdictionRisk"},"high"]},{"!=":[{"var":"sourceOfFunds"},"verified"]}]},"effect":{"type":"forbid","action":"approve"},"priority":40,"overrides":[]},
{"id":"rule_0db2a2b89d2203","decisionFamily":"reviewOutcome","kind":"guardrail","predicate":{"==":[{"var":"pep"},true]},"effect":{"type":"require_approval","role":"compliance_officer"},"priority":40,"overrides":[]},
{"id":"rule_1e5796de1f0929","decisionFamily":"reviewOutcome","kind":"guardrail","predicate":{"and":[{"==":[{"var":"jurisdictionRisk"},"high"]},{"<":[{"var":"accountAgeMonths"},24]}]},"effect":{"type":"forbid","action":"approve"},"priority":40,"overrides":[]},
{"id":"rule_03907d56eb787e","decisionFamily":"reviewOutcome","kind":"exception","predicate":{"and":[{"==":[{"var":"jurisdictionRisk"},"high"]},{"==":[{"var":"sourceOfFunds"},"verified"]},{"==":[{"var":"customerStatus"},"existing"]}]},"effect":{"type":"recommend","action":"approve"},"priority":30,"overrides":[]},
{"id":"rule_1aba5eb68f9a3d","decisionFamily":"reviewOutcome","kind":"exception","predicate":{"and":[{"==":[{"var":"jurisdictionRisk"},"high"]},{">=":[{"var":"accountAgeMonths"},36]},{"==":[{"var":"sourceOfFunds"},"verified"]}]},"effect":{"type":"recommend","action":"approve"},"priority":30,"overrides":[]},
{"id":"rule_01070ba187e2c5","decisionFamily":"reviewOutcome","kind":"escalation","predicate":{"==":[{"var":"pep"},true]},"effect":{"type":"recommend","action":"escalateCompliance"},"priority":20,"overrides":[]},
{"id":"rule_0e6d5f56f47b3a","decisionFamily":"reviewOutcome","kind":"escalation","predicate":{"==":[{"var":"pep"},true]},"effect":{"type":"recommend","action":"escalateCompliance"},"priority":20,"overrides":[]},
{"id":"rule_03ab16bbfa0b70","decisionFamily":"reviewOutcome","kind":"decision","predicate":{"and":[{">":[{"var":"uboOwnershipPct"},25]},{"==":[{"var":"uboVerified"},false]}]},"effect":{"type":"recommend","action":"enhancedReview"},"priority":10,"overrides":[]},
{"id":"rule_05e570a9eb1b78","decisionFamily":"reviewOutcome","kind":"decision","predicate":{"!=":[{"var":"sourceOfFunds"},"verified"]},"effect":{"type":"recommend","action":"enhancedReview"},"priority":10,"overrides":[]},
{"id":"rule_0825544f35bccb","decisionFamily":"reviewOutcome","kind":"decision","predicate":{"and":[{">":[{"var":"uboOwnershipPct"},25]},{"==":[{"var":"uboVerified"},false]}]},"effect":{"type":"recommend","action":"enhancedReview"},"priority":10,"overrides":[]},
{"id":"rule_116f597cd629bd","decisionFamily":"reviewOutcome","kind":"decision","predicate":{"and":[{">":[{"var":"uboOwnershipPct"},25]},{"==":[{"var":"uboVerified"},false]}]},"effect":{"type":"recommend","action":"enhancedReview"},"priority":10,"overrides":[]},
{"id":"rule_144f1d067b6d4e","decisionFamily":"reviewOutcome","kind":"decision","predicate":{"and":[{">":[{"var":"uboOwnershipPct"},25]},{"==":[{"var":"uboVerified"},false]}]},"effect":{"type":"recommend","action":"enhancedReview"},"priority":10,"overrides":[]},
{"id":"rule_15ac7035644056","decisionFamily":"reviewOutcome","kind":"decision","predicate":{"and":[{">":[{"var":"uboOwnershipPct"},25]},{"==":[{"var":"uboVerified"},false]}]},"effect":{"type":"recommend","action":"enhancedReview"},"priority":10,"overrides":[]},
{"id":"rule_15afbdc3922d03","decisionFamily":"reviewOutcome","kind":"decision","predicate":{"and":[{"==":[{"var":"sourceOfFunds"},"not_provided"]},{">":[{"var":"expectedMonthlyVolume"},50000]}]},"effect":{"type":"recommend","action":"requestDocuments"},"priority":10,"overrides":[]},
{"id":"rule_15c7a9caf6b031","decisionFamily":"reviewOutcome","kind":"decision","predicate":{"and":[{">":[{"var":"uboOwnershipPct"},25]},{"==":[{"var":"uboVerified"},false]}]},"effect":{"type":"recommend","action":"enhancedReview"},"priority":10,"overrides":[]},
{"id":"rule_171a5b41cd4ac8","decisionFamily":"reviewOutcome","kind":"decision","predicate":{"and":[{">":[{"var":"uboOwnershipPct"},25]},{"==":[{"var":"uboVerified"},false]}]},"effect":{"type":"recommend","action":"enhancedReview"},"priority":10,"overrides":[]},
{"id":"rule_1779bf245d6bff","decisionFamily":"reviewOutcome","kind":"decision","predicate":{"and":[{">":[{"var":"uboOwnershipPct"},25]},{"==":[{"var":"uboVerified"},false]}]},"effect":{"type":"recommend","action":"enhancedReview"},"priority":10,"overrides":[]},
{"id":"rule_1841412ed4a1d8","decisionFamily":"reviewOutcome","kind":"decision","predicate":{"and":[{">":[{"var":"uboOwnershipPct"},25]},{"==":[{"var":"uboVerified"},false]}]},"effect":{"type":"recommend","action":"enhancedReview"},"priority":10,"overrides":[]},
{"id":"rule_1c0c500bd78c2d","decisionFamily":"reviewOutcome","kind":"decision","predicate":{"and":[{">":[{"var":"uboOwnershipPct"},25]},{"==":[{"var":"uboVerified"},false]}]},"effect":{"type":"recommend","action":"enhancedReview"},"priority":10,"overrides":[]},
{"id":"rule_1c41c261f0b59a","decisionFamily":"reviewOutcome","kind":"decision","predicate":{"and":[{">":[{"var":"uboOwnershipPct"},25]},{"==":[{"var":"uboVerified"},false]}]},"effect":{"type":"recommend","action":"enhancedReview"},"priority":10,"overrides":[]},
{"id":"rule_1cdbe70b974ed9","decisionFamily":"reviewOutcome","kind":"decision","predicate":{"and":[{">":[{"var":"uboOwnershipPct"},25]},{"==":[{"var":"uboVerified"},false]}]},"effect":{"type":"recommend","action":"enhancedReview"},"priority":10,"overrides":[]},
{"id":"rule_1e58bdad60bc40","decisionFamily":"reviewOutcome","kind":"decision","predicate":{"and":[{">":[{"var":"uboOwnershipPct"},25]},{"==":[{"var":"uboVerified"},false]}]},"effect":{"type":"recommend","action":"enhancedReview"},"priority":10,"overrides":[]},
{"id":"rule_1f58dab96927e9","decisionFamily":"reviewOutcome","kind":"decision","predicate":{"and":[{">":[{"var":"uboOwnershipPct"},25]},{"==":[{"var":"uboVerified"},false]}]},"effect":{"type":"recommend","action":"enhancedReview"},"priority":10,"overrides":[]}
]}
```
