# ZetaIQ fork of Apache Superset

This repository is ZetaIQ's fork of [apache/superset](https://github.com/apache/superset). It carries only the
changes that need edits to Superset's own code. Everything else (config, identity, tenancy, theme, the shell bridge)
lives as an overlay in the ZetaIQ telemetry repository under `services/zeta-superset/`, which builds the image from a
pinned commit of this fork. The playbook is `services/zeta-superset/FORK.md` there.

## Branches

| Branch | What it is | Rule |
|---|---|---|
| `master` | Clean copy of upstream | Never commit here. Sync only |
| `zetaiq/<upstream tag>` (e.g. `zetaiq/7.0.0rc2`) | Upstream release tag + our patch stack | The only place our commits live |

## Rules

1. **Overlay first.** If a change fits Superset's extension points, it goes in the telemetry overlay, not here.
2. **One change per commit**, revertable on its own. The message says why it exists and ends with
   `Upstream: <PR url | none: reason>`.
3. **Modified upstream files** get a line `Modified by ZetaIQ: <what>` next to their licence header (Apache-2.0 §4).
   Keep `LICENSE.txt` and `NOTICE` unchanged.
4. **Upgrading:** cut `zetaiq/<new tag>` from the new upstream tag, replay our commits, compare with
   `git range-diff <old-tag>..zetaiq/<old-tag> <new-tag>..zetaiq/<new-tag>`, retest from scratch. Never merge
   upstream into a `zetaiq/*` branch.
5. **Pull requests** target this repository: `gh repo set-default zetaiq-robotics/superset`, and pass
   `--repo zetaiq-robotics/superset --base zetaiq/<tag>` to `gh pr create`. Never open one against `apache/superset`
   by accident; upstream contributions are deliberate, from a separate branch cut from upstream `master`.
6. **GitHub Actions stay off.** Never add Docker Hub or any publishing secrets to this repository.
7. **This repository is public** (forks of public repositories must be). Nothing secret goes here.
8. **Security:** a Superset release with a CVE fix means a rebase within days. Never fix a security issue silently;
   report it to security@superset.apache.org.
9. **Name:** the build is "ZetaIQ Dashboards, based on Apache Superset &lt;version&gt;". Check with the Superset PMC
   before using the Superset name for anything customer-facing.
