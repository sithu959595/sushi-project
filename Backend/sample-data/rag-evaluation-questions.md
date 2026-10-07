# RAG evaluation questions

These questions are designed for `rag-test-menu.json`. Answers should use only
retrieved dish data, distinguish the recipe from cross-contact, and avoid calling
any dish "safe" for an allergy. The top-level `availability` field is the
authoritative current status: general schedules or quantity notes in `fullDishInfo`
must not override it. Recommendations for something orderable now must exclude
dishes marked `out`.

| # | Test question | Expected grounded behavior |
|---|---|---|
| 1 | What is akami, and is it cooked? | Retrieve `akami-nigiri`; identify bluefin tuna served raw and aged for 24 hours. |
| 2 | Compare akami and hamachi. | Retrieve both dishes; distinguish tuna from yellowtail while noting that both are raw and contain gluten as served. Report that akami is currently available and hamachi is currently out. |
| 3 | I have a shellfish allergy. Can I eat the Snowfox house roll? | Advise against it because it contains cooked snow crab; also mention shared preparation without claiming guaranteed safety. |
| 4 | Which menu items list wheat? | Return `akami-nigiri`, `hamachi-citrus`, `sora-house-roll`, `spicy-tuna-crunch`, `tempura-shrimp-roll`, `peanut-sesame-noodles`, `kinoko-robata`, `chicken-karaage`, `miso-black-cod`, `wagyu-tataki`, `crab-chawanmushi`, `matcha-cloud`, and `sora-omakase`; do not add the four remaining dishes. Do not silently remove matching dishes because they are out; label `hamachi-citrus` and `miso-black-cod` as currently out. |
| 5 | Which menu items list peanut, and where is it a confirmed recipe ingredient? | Identify `peanut-sesame-noodles` as containing peanut sauce and `sora-omakase` as variable but peanut-listed; distinguish both from general cross-contact warnings. |
| 6 | What can a vegan guest order? | Identify avocado cucumber maki, sea salt edamame, and yuzu shiso sorbet; describe kinoko robata only as a documented vegan modification. |
| 7 | I avoid raw food. Is the tempura shrimp roll suitable? | State that its shrimp is fully cooked, while still reporting shellfish, gluten, egg, fish-stock seasoning, and shared-fryer facts. |
| 8 | Does the house roll contain raw fish? | Say that the tuna is raw and the snow crab is cooked; do not merge their preparation states. |
| 9 | Can the spicy tuna roll be made mild? | State that chile mayonnaise can be omitted; do not invent a cooked-tuna version. |
| 10 | Can the black cod be made gluten-free tonight? | First state that black cod is currently out. Also explain that, even when available, its wheat-containing marinade is applied 48 hours ahead and cannot be changed to order. |
| 11 | Mochi says glutinous rice. Does Matcha Cloud contain gluten? | Say yes because of the wheat-flour sesame sponge; also clarify that glutinous rice itself does not contain gluten. |
| 12 | What warm vegan option is available? | Recommend the currently available kinoko robata only with oil replacing butter plus reserved gluten-free tamari; disclose the shared grill. Do not recommend any `out` dish. |
| 13 | Can I order hotate nigiri on Wednesday? | Say it is currently out. Its Friday-through-Sunday schedule does not override current availability or prove that it will be available on a future day. |
| 14 | Is the seasonal omakase appropriate for a vegan guest with a severe shellfish allergy? | Say no; cite the changing seafood menu, cross-contact risk, and explicit inability to accommodate vegan or shellfish-free omakase. |
| 15 | Is black cod definitely still available late tonight? | Say no: its current status is `out`. The twelve-portions note explains the limit but must not weaken or override the explicit current status. |
| 16 | Can I replace the crab in the house roll with vegetables? | Say that this substitution is not offered and suggest the currently available avocado cucumber maki instead. |
| 17 | Which desserts are dairy-free? | Identify yuzu shiso sorbet. Do not classify Matcha Cloud as dairy-free because it contains mousse and white chocolate cream. |
| 18 | What does the customer eat in the edamame dish? | Explain that the beans are eaten and the pods are not. |
| 19 | Which dishes are out right now? | Return exactly `hamachi-citrus`, `hotate-yuzu`, and `miso-black-cod`. Do not infer additional outages from words such as seasonal, limited, or until sold out in `fullDishInfo`. |
| 20 | Which nigiri or sashimi can I order right now? | Recommend only the available `akami-nigiri`; identify `hamachi-citrus` and `hotate-yuzu` as out rather than recommending them from their general schedules. |

## Update and deletion regression

After initial indexing, change one dish's `fullDishInfo` or flip its `availability`,
re-index that dish by its stable ID, and rerun its questions. The answer must
contain only the new fact or status. Specifically, flip `hamachi-citrus` from
`out` to `available`, confirm that it becomes recommendable, then flip it back
and confirm that no stale available vector remains. Delete a dish and confirm
that its vector no longer appears in retrieval.

Useful measurements include retrieval Recall@k, grounded-claim precision,
answer completeness, correct abstention rate, allergy-critical accuracy, and
availability accuracy, plus stale-answer rate. Allergy-critical and availability
accuracy should be 100%, and stale-answer rate should be zero.
