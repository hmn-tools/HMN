# Contributing to HMN

HMN is the private record of one life. A change must keep the two rules that make it safe:

1. Software can only propose a change to the graph. The owner approves, or a rule from the owner decides. Do not add a tool, a plugin, or a worker that writes directly.
2. One policy layer decides what a caller can read (`server/src/policy.ts`). Do not add a second place that decides this.

Read [docs/PRODUCT.md](docs/PRODUCT.md), [docs/SECURITY.md](docs/SECURITY.md), and [docs/SCHEMA.md](docs/SCHEMA.md) before you change the model.

## Before you send a change

- Run the tests: `cd server && bun test`. The server has no npm dependencies. Keep it so.
- Add a test for each rule that you add or change.
- Update [docs/SCHEMA.md](docs/SCHEMA.md) in the same commit as a change to the data model or the API.
- Update [docs/UX.md](docs/UX.md) in the same commit as a change to a screen.
- Use fictional data in tests, in the seed, and in the documents. Do not use the data of a real person.
- A fixture has a start time only. Do not add a score, a result, a winner, a standing, or points.
- Do not put a secret in git: no key, no token, no passphrase, and no data directory.

## Sign your commits

HMN has no contributor agreement. Each commit has a sign-off line instead. The line says that you wrote the change, or that you have the right to send it, under the terms of the Developer Certificate of Origin at https://developercertificate.org.

```sh
git commit -s
```

That adds a line of this form to the commit message, with your own name and address:

```text
Signed-off-by: A. Person <person@example.org>
```

Your contribution is under the Apache License, Version 2.0, the same licence as the project. See [LICENSE](LICENSE).

## Security faults

Do not open a public issue for a security fault. Use "Report a vulnerability" on the Security tab of the repository. That report is private.

## The name and the mark

The licence does not cover the name "HMN" or the mark. See [TRADEMARKS.md](TRADEMARKS.md).
