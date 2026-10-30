# Public source privacy boundary

The public product repository is a new source snapshot, not a mirror of the
private development history. The marketing website has its own private
repository and is not included here.

## Removed material

- Fixed deployment-test account names and passwords, and personal account lists.
- One-device deployment/recovery wrappers and scripts that recorded historical
  device identities or asserted results from private evidence.
- Actual host addresses, home directories, container/device identities and
  historical maintenance snapshots. Retained tests use explicitly synthetic
  fixtures; maintained operational tools require explicit target inputs.
- Guest disks, Android login state, browser sessions, installation packages,
  model weights and private evidence are outside the public source distribution.

The private archive and original delivery tags remain intact. Nothing in this
source cleanup changes appliance accounts, guest data, running services or
website deployment. The `admin / admin` factory default is deliberately retained;
it is not a private credential. Administrators must change it before exposure.

## Review and verification

Review both the worktree and every reachable commit/tag in the repository being
published. Use Gitleaks plus `tools/open_source_sensitive.py`; neither alone is
proof that low-entropy passwords or personal metadata are absent. Compare
confirmed old private values using a private external denylist, never a committed
test fixture. Review remaining findings individually, including test files.

The cleanup checks are source-policy, synthetic regression, configuration and
syntax checks. They do not log in using discovered credentials, reinstall a box
or repeat product acceptance. The earlier API packaging correction (including
the shared UI source and import-only entry-point check) remains in the source.

New clones must not import retired commits, refs or tags. Deleting a repository
does not recall copies already downloaded by others. No scan can establish that
an unknown credential was never copied; a credential that was actually used
must be rotated by its operator. This cleanup does not claim to have rotated it.

See [RELEASING.md](RELEASING.md) for source-export and review instructions and
[BUILDING.md](BUILDING.md) for build prerequisites and separately obtained assets.
