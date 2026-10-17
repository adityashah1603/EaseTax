# How AI was used

**Tool:** Claude Code (Anthropic), used as a pair programmer and a coordinator of parallel sub-agents.

**What I did:**
- Set the direction and made every product decision.
- The AI asked me before each major change. I chose among options, and each choice is logged as a numbered decision (66 so far).
- Reviewed the app in the browser as each role and reported what felt wrong. For example, the confusing "correct the read" dialog led to D-66.

**What the AI did:**
- **Profiling:** read the brief and profiled the packet, which produced the first list of planted errors.
- **Design:** drafted the system design and the decision log.
- **Building:** wrote the code across shared types, the server and the React UI. Independent pieces such as checks, views, filing and the UI were split across parallel sub-agents.
- **Tests:** wrote the test suite (vitest, server) and ran it after every change.
- **Audits:** checked the app against the brief and the design, checked every planted error by running the checks against the packet, and probed security on the deployed site before hand-in.

**Guardrails:**
- No number in this hand-in comes from the AI's say-so. Each error in `ERRORS.md` was confirmed by running the checks against the packet.
- The app itself uses **no AI at run time**. Every check is plain, testable code, so an issue can always be explained and reproduced.

**What didn't work:** sub-agents sometimes trusted the design doc over the code. The pre-hand-in audit caught stale counts and a few gaps this way (an unauthenticated live-update stream, sign-off holes) that were then fixed.
