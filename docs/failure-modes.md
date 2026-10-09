# Failure modes

Write every way foxbench can fail before you write the code. Then write a test
for each failure mode, and commit the tests before the code. Prefer an E2E
check. Write an isolated test only when an E2E check cannot reach the failure.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| F1 | FILL: what goes wrong | FILL: what the code does then | FILL: the test or E2E check |
