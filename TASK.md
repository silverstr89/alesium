# Working session: prop-engine

About 2 hours, together with the engineer you would build the product with.

`prop-engine` is the core of our trading engine in miniature: one account, one writer, a journal, snapshots. The real one is what you would work on with us. **No trading experience needed:** the README explains the few terms the code uses.

- Use your usual AI tools. We want to see how you actually work.
- Think out loud.
- Ask us anything. Some product questions have answers only we know.

## Setup (5 min)

Everything runs in a Docker container: nothing gets installed on your machine, and afterwards you can remove it all in one step.

```bash
git clone <the link we send you> prop-engine
cd prop-engine
docker compose run --rm dev                      # installs the dependencies inside the container (first run only) and runs the tests
docker compose run --rm dev npm run typecheck    # any other command works the same way
```

Your AI tools work on the files in this folder as usual; run tests and commands through `docker compose run --rm dev ...`. This repository is yours for the session. **At the end,** commit everything (`TRIAGE.md`, tests, the fix, `PLAN.md`, the slice) and push it to a branch named `session`.

**Safety.** The repo has three dev dependencies (`typescript`, `vitest`, `@types/node`) and no install scripts, and the container installs them with `npm ci --ignore-scripts`. Feel free to read `package.json`, `package-lock.json` and `compose.yaml` first. No database is needed.

**Afterwards:**

```bash
docker compose down -v --rmi all     # removes the container, its volume and the image
cd .. && rm -rf prop-engine
```

No Docker? `npm ci --ignore-scripts && npm test` works too.

Start with `README.md`: it lists the invariants the code must keep.

The pull request under review is `feature/journal-engine` → `main`. It is also open as a pull request on GitHub.

## Part 1. An AI reviewed this PR (35 min)

`AI_REVIEW.md` is an AI code review of this PR. Like any AI output, some of it is right, some is wrong, and some needs a decision.

1. Sort every finding into **real bug**, **not a bug** or **needs a decision**, with one line of why. The "Checked and fine" section counts too. Write this in `TRIAGE.md`.
2. Pick the 3 real bugs that matter most. For each one, write a test that fails because of the bug.
3. Fix one of them: its test goes green and the rest of the suite stays green.

The review may have missed things. If you find one, add it.

## Part 2. A feature (55 min)

We will hand you a short feature card: the next thing we build in this engine. You plan it, then build a small first slice that the card defines.

## Part 3. Debrief (15 min)

You walk us through your plan and tell us what you would do next and how you would run it in production.
