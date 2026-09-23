# CLAUDE.md

> The **table of contents for the whole project documentation** (with links to the individual .md files per subsystem) is in [ARCHITECTURE.md](./ARCHITECTURE.md). Use it to quickly find the documentation for the feature you need.

Answer in the same language that was used in question.

## Architectural principles and style

- We are building a high-performance optimisation of postalserver, plus a test bench for verifying how far we managed to optimise our build of the mail server.
- At the moment we are at the PoC and MVP stage. Readability of the code and ease of maintaining it matter more than performance.
- Add documenting comments to the code in English. If it is a comment on a function, a class method or a property, it must be a documenting comment (that is, it must start with /\*\* )

## How to update the documentation

The CLAUDE.md and ARCHITECTURE.md files must contain the general baseline principles. Architectural details must live in separate .md files, while CLAUDE.md and ARCHITECTURE.md link to them, acting as a table of contents or glossary. This lets us avoid overloading these files with excessive detail and keep them up to date. If you make changes to the code that require documentation updates, then:

1. Determine which parts of the documentation need updating (CLAUDE.md, ARCHITECTURE.md or separate files)
2. Make the necessary changes to the code and test them
3. Update the corresponding parts of the documentation, adding links to new files in CLAUDE.md and ARCHITECTURE.md if necessary
4. Make sure the documentation is clear and matches the current state of the code

- Put documentation next to the code it describes (in the same folder).
- Call examples in documentation can go stale. It is better to keep function names and general purpose in the documentation, and to describe argument lists and call examples in the code, in a documenting comment.
- Explain new terms in the "Glossary" section of ARCHITECTURE.md

# roadmap.md

- If, while carrying out a task, the Agent left something unfinished, a note about it must be added to the roadmap.md file
- At the end of every task, propose adding to roadmap.md any new features or improvements you consider useful for developing the application and for the next steps in improving it.

# CHANGELOG.md

In CHANGELOG.md write a very brief list of completed tasks. It can be used for historical reference about what was done and when.
The detailed narrative (what went wrong, how it was caught) goes to [docs/engineering-log.md](docs/engineering-log.md).

# Public presentation

The repository doubles as a public portfolio. Keep README.md results-first, keep the Postal performance FAQ and tuning checklist in `docs/` in sync with RESULTS.md, and write headings the way people search for them (for example "Why is the Postal queue growing").
