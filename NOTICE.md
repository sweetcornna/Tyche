# Notice

## Project base

This repository is a fork of **JiuwenSwarm** by the openJiuwen community
(<https://github.com/openJiuwen-ai/jiuwenswarm>), imported verbatim at commit
`b7a7c32564a98eb2033271ed93b7ad0124fc92c8` and licensed under the Apache License 2.0 (see `LICENSE`).
The import omits the six Git LFS demo videos under `docs/assets/videos/`; the documentation links to the
upstream copies instead. Third-party components bundled by JiuwenSwarm are listed in
`OPEN_SOURCE_SOFTWARE_NOTICE.md`.

JiuwenSwarm depends on the openJiuwen **agent-core** SDK (`openjiuwen`), pinned by upstream to commit
`9e3390195a9ea15235b2b5f7412cb2aa440622cc`. Tyche calls its public modules and does not modify them.

## Tyche additions

Files under `tyche/`, `tests/tyche/`, `scripts/tyche/`, `docs/tyche/`, and the skills
`jiuwenswarm/resources/agent/workspace/skills/tyche-iclr-paper/` and `.../skills/tyche-paper/` are original
work for the CCF BDCI 2026 openJiuwen track, released under the Apache License 2.0.

## ICLR style files

`tyche/paper/template/` contains the unmodified ICLR 2027 style files from the official ICLR template
repository (<https://github.com/ICLR/Master-Template>); see `tyche/paper/template/SOURCE.md`. They remain under
the terms stated in their own headers.

## Design references

During design the team consulted public descriptions of research-agent workflows, including the Stanford Agentic
Reviewer's published evaluation dimensions and the owner-authored analysis documents of the
`sweetcornna/claude_science_opensource` repository. Only general concepts were used: fresh-context review, a
findings ledger, provenance-tagged memory, and immutable artifact versions. No code, prompts, skill text, or
other expression from that repository or from any proprietary product was copied into this project.
