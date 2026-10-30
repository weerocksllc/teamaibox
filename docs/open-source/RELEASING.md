# Release boundaries / 发行边界

## Separate artifacts

1. **MIT source candidate**: original code, current specifications, reviewed
   build/test tools and notices; no Git history or private lab evidence.
2. **Third-party material**: exact upstream source/binaries/models with their
   own license and attribution. Copyleft source obligations travel with binaries.
3. **Complete offline appliance package**: built by `install/`; not automatically
   licensed for public redistribution. GMS, HunyuanOCR, NVIDIA components and
   guest/firmware licenses require artifact-specific review. Do not publish the
   private package, model bundles or signed-in images under the MIT label.
4. **Marketing website**: `website/`, including its article templates, content,
   design assets, analytics and deployment configuration, stays in the private
   `weerocksllc/teamaibox.com` GitHub repository. GitLab is a historical archive,
   not the website development repository. The website is not part of the public product source distribution.
   The appliance browser UI in `apps/` remains part of the open-source product.

Historical one-device deployment, recovery and evidence-recording scripts are
not reusable product tooling. The release policy excludes retired scripts and
snapshots; do not restore them from the private archive. Retained tools require
explicit operator-supplied targets instead of a developer's hosts, accounts,
containers or evidence files. Run the supplementary sensitive scan as well as
Gitleaks: device IDs, container IDs, GSF hashes and personal account names are
testing metadata even when they are not usable login credentials.
Public-history cleanup requires
explicit owner authorization and must never rewrite the private archive or its
delivery tags. After an authorized rewrite, use a fresh public clone rather than
merging the retired history back into the maintained repository.

The internal development repository and its tags stay intact. Its reachable
history contains old deployment records and retired proprietary SDK assets;
it must not be made public unchanged. A fresh exported tree provides the
public starting point without silently rewriting the original delivery history.

## Local preparation

Use **Gitleaks 8.30.1**, downloaded from its official GitHub release and verify
its checksum. The audit tool never installs system packages or uploads data.
Private output goes in ignored `.runtime/open-source-audit/`, not a public PR.

```sh
python3 tools/open_source_release.py baseline --output .runtime/open-source-audit/before.json
python3 tools/open_source_release.py scan --gitleaks /path/to/gitleaks --output .runtime/open-source-audit/review
python3 tools/open_source_sensitive.py --output .runtime/open-source-audit/project-review.json
python3 tools/open_source_inventory.py
python3 tools/open_source_release.py export --gitleaks /path/to/gitleaks --output .runtime/open-source-audit/source-candidate
```

Outputs must be new paths; the tools never overwrite previous candidates.
Review redacted locations, not only counts. Document synthetic fixtures,
public bootstrap credentials, identifier false positives and actual/possible
private credentials separately. Pattern scans cannot validate credentials or
OCR screenshots. Binary artifacts are excluded, not declared scanned-clean.
The source exporter admits only Git-known files and explicit untracked inputs
in [release-policy.json](release-policy.json). New untracked inputs need review.
It rejects symlinks and path traversal and emits per-file SHA-256 plus exclusions.
`website/` is always excluded, even if tracked or listed as an untracked input.
Never copy the private repository's `.git` directory into a public checkout.
Before publishing, verify both the tree and all reachable public commits contain
no website files; deleting files in a later commit does not remove old history.

The supplementary check includes reachable commit/tag messages, low-entropy
credential and login literals, device identities and development addresses.
Tests are not automatically exempt: explain why each retained fixture is
synthetic. Known private values can be supplied with `--denylist` as an external
JSON array of `{id, value, word?}` records. Use opaque, non-sensitive IDs; keep
this file outside the source checkout. Reports show locations and hashes, never
the values. A known-marker match makes the check fail. Use `--scope worktree`
while cleaning; inspect `--scope all` in the new parentless release repository
before publishing. Do not publish the old history or private review reports.

The only intentional factory administrator default is `admin / admin`; change
it during deployment. Deployment/browser test tools must receive existing
account credentials through protected local input. Newly created smoke-test
accounts use random credentials and are disabled during cleanup. A failed
cleanup is a test failure, not a successful run. Abrupt process termination can
prevent cleanup; operators must reconcile their temporary accounts after such
an interruption. No public document claims a test credential is currently valid.

Only the
maintained `install/` entry point is a clean-appliance installation path.
The component ownership assessment is in [OWNERSHIP.md](OWNERSHIP.md).

No command here pushes Git, changes visibility, rewrites history, rotates live
credentials, changes a device or grants third-party redistribution rights.
Public release requires an explicitly chosen public destination and final
artifact review. Preserve `delivery-2026-10-22` in the private repository.

中文：本流程只生成本地源码候选及审阅报告，不自动公开仓库。历史敏感记录保留在
私有仓库；如发现有效凭据，应由所有者安排轮换，不能把删文件当作已撤销凭据。
官网及文章模板在独立私有 GitHub 仓库维护，GitLab 只作历史归档；官网不属于公开产品源码，盒子内部的应用界面
仍属于开源产品。公开源码目录不能包含 `website/`，也不能继承曾包含官网的历史。
