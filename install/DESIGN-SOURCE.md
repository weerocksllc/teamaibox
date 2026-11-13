# Deploy Design from source

For normal Team AI Box installations, use the [standard source installer](SOURCE-INSTALL.md)
and open **All applications → Design** after signing in. The standalone procedure below
is a separate maintainer option, not part of the product installation or login.

Use this profile to run a separate Team AI Box Design workspace with the native
Penpot editor. It does not invoke the appliance installer or modify an existing
installation. Use a checkout that includes the `design` subcommand.

On a Linux ARM64 host with Docker Engine, the Docker Compose plugin, Git, Python
3.10+ with PyYAML, and OpenSSL, run from the checkout:

```sh
sudo bash install/from-source.sh design up --root /srv/teamaibox-design
```

Choose a new directory whose parent already exists. The command builds only
the required core images and the pinned native Penpot stack, then generates
the instance configuration, keys and local HTTPS certificate. It applies the
platform migrations and registers Design against the running service images.
Internet access is needed to build uncached public inputs. This profile needs
neither a GPU/model download nor KVM, and does not install host packages.

Open `https://localhost:18443` on the host, or forward that loopback port over
SSH. For the initial setup, verify the generated CA at `https/ca.crt` under the
instance directory, trust it in the browser you use, and read the setup token
from `secrets/owner-setup-token` with local administrator access. Enter it in
the setup page and choose your owner credentials. No default password or prior
accounts are imported. Open **Design** from the workbench and create a file.

This profile includes the protected object service. By default it does not
start AI or model workers. It does not install VMs or other appliance apps.
The native Design database and assets are stored under `data/` in the instance
directory. Use an encrypted host filesystem if you need at-rest protection
for those files; this command does not provision LUKS or manage host disks.

## Enable Design AI

On a supported NVIDIA Linux ARM64 host, use an empty Docker daemon dedicated
to this instance, with the NVIDIA runtime configured. Its root-owned private
directory must contain its own `docker.sock`, and its Docker data root must
be the `docker-data` subdirectory. Do not point it at a shared daemon, reuse
an appliance socket, or share Docker/containerd state with another daemon.

Use a trusted Team AI Box release manifest and its declared Assistant model
files. The setup checks the manifest SHA-256 and all model files, then stages
a private read-only copy for inference. Allow disk space for that copy and
memory for the NVIDIA model worker in addition to the editor.

```sh
sudo bash install/from-source.sh design up --root /srv/teamaibox-design-ai \
  --with-ai --engine-root /srv/design-docker \
  --assistant-model-release /path/to/release.json \
  --model-release-sha256 <trusted-release-manifest-sha256>
```

The installer configures the existing per-user OpenCode controller, official
Penpot MCP and local model gateway. Open a design file, choose an Assistant
session, and select **Connect this design**. Review proposed edits in the
side panel. Model credentials stay with the private gateway and the model
does not expose a host port. To stop this instance, use the same `--root` and
`--engine-root` with `design stop`. This stops its per-user sandboxes without
deleting workspaces or design files.

## Prepare, reuse and stop

- Add `--prepare-only` to build and verify the image IDs without starting
  services. The resulting `image-map.json` lists the exact role-to-image IDs.
  Use the same options if you intend to resume in that root. An AI image-only
  build may omit the model options if it uses a separate build root.
- If Docker Hub is unreachable, use `--registry-mirror https://<registry>/<prefix>`
  with a registry that serves the same digest-pinned Docker Hub images. This
  changes the source for those downloads only, not their digests or the host's
  Docker configuration. Other publishers and source downloads still need to be
  reachable.
- Rerun the same `up` command with the same checkout and root after interruption.
  Completed source stages are checked and reused. A different source or
  configuration requires a separate root; this is not a migration command.
- For already-loaded, trusted source-built artifacts, pass `--reuse-images
  /path/to/image-map.json --images-sha256 <trusted-map-sha256>`. Use a map from
  a build you trust, with its checksum obtained separately. The installer
  checks the exact role set and Linux ARM64 image IDs. It will not pull or
  import images on this path. The checksum verifies identity, not provenance.
- `--internal-only` publishes no ports and uses Docker internal networks. It is
  suitable for an isolated browser runner with access only to the instance
  network. For local use without this flag, only the HTTPS port is bound to
  loopback. `--port` chooses a different loopback port.
- Stop only this instance with `sudo bash install/from-source.sh design stop
  --root /srv/teamaibox-design`. This retains its files, credentials and volumes.
  The same `up` command brings it back. Never use this mode to replace a live
  appliance or open its databases.

## Upgrade and roll back a standalone Design workspace

These commands cover compatible image updates for a **Design workspace on its
own Docker engine** (created with `--engine-root`), including one started with
`--with-ai`. They require the same application manifests and exact PostgreSQL
images; they do not update an appliance or a shared engine.

Build the new checkout's image map with `design up --prepare-only` in a
separate build directory and engine. Make the exact new images available on the
workspace engine. Keep the old images and checkout. Plan a maintenance window,
ask users to save and exit, and allow room for a second copy of `data/`.
Choose an unused sibling directory for the candidate:

```sh
sudo bash install/from-source.sh design upgrade \
  --root /srv/teamaibox-design --target-root /srv/teamaibox-design-next \
  --engine-root /srv/design-docker \
  --reuse-images /path/to/new-image-map.json \
  --images-sha256 <trusted-map-sha256>
```

The installer verifies the candidate images, stops the old instance, checks
that both databases stopped cleanly, and copies its data, keys, and HTTPS
identity. The candidate starts with its own data directory and Docker volumes
at the same HTTPS address. Before reopening the workspace to users, verify
that expected designs, assets and permissions are present.

For an AI workspace, start the original instance first and use an AI image map
from `design up --with-ai --prepare-only`. Add these options to `design upgrade`:

```sh
--assistant-model-release /path/to/release.json \
--model-release-sha256 <original-trusted-release-manifest-sha256>
```

Do not add `--with-ai` to `upgrade` or `rollback`; the commands inherit that
setting. The upgrade verifies a private copy of the already-deployed model
against the original manifest. Allow room for both the data and the model copy.
It refuses to switch while Assistant work is active, an OpenCode terminal is
still open, or activity cannot be verified. Finish prompts and close terminals
before retrying. A compatible Agent image must keep the same native OpenCode
binary and state paths; a different binary, state layout, or model needs a
separate compatibility migration.
Each user’s workspace, native sessions, and MCP settings are carried over in
the copy. Sandboxes start again on demand; live terminal processes do not carry
over.

To restore the pre-upgrade state, including after an interrupted switch:

```sh
sudo bash install/from-source.sh design rollback \
  --root /srv/teamaibox-design --target-root /srv/teamaibox-design-next \
  --engine-root /srv/design-docker
```

Rollback starts the original images, model, and workspaces with the original data.
It does not need the model manifest again. Changes made only
after the upgrade remain in the candidate directory; they are **not** merged
into the old workspace. Do not remove either directory or start an inactive
generation using Docker Compose directly. The current switch supports one
active candidate per baseline, not a chain of successive upgrades. After
rollback you can try a new candidate in another unused sibling directory.

For complete appliance and optional offline delivery, see the
[Penpot integration guide](PENPOT-DEVELOPMENT.md).
