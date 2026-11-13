# Team AI Box documentation

Team AI Box is a single-appliance workspace for NVIDIA DGX Spark.

## Build and install

- [Source build](open-source/BUILDING.md)
- [Source deployment](../install/SOURCE-INSTALL.md)
- [Independent Design source deployment](../install/DESIGN-SOURCE.md)
- [Optional offline package](../install/README.md)
- [Release scope and third-party boundaries](open-source/RELEASING.md)
- [Security reporting](../SECURITY.md)

Start with the source-deployment guide and its environment requirements. The
full-appliance source installer still calls the package installer; do not run
it on an occupied host merely to develop or verify a component. The independent
Design profile does not use the appliance installer. Historical deployment scripts
and acceptance records are not installation instructions and are not included
in this public source distribution. Never copy an installed guest disk or an
existing user's account data into a release.

## Use and integrate

- [Workspace user guide](operations/user-guide.md)
- [Virtual phones and cameras](operations/virtual-phone-camera.md)
- [Virtual computers](virtual-computers-user-guide.md)
- [Wireless casting](operations/wireless-casting-guide.md)
- [Plugin API](api/plugin-api-v1.md)
- [Compute API](api/compute-api-v1.md)

The public repository contains source and synthetic unit-test fixtures, not
private hardware acceptance evidence or a pre-authorized binary distribution.
See the root README and third-party notices for licensing and support boundaries.

## Develop and maintain

- [Project handbook: requirements, conventions, decisions and change record](project/README.md)
- [Codex project instructions](../AGENTS.md)
- [Contributing](../CONTRIBUTING.md)
- [Architecture and module boundaries](architecture/module-boundaries.md)

Development uses ordinary Markdown plans and scoped verification. No OpenSpec
workspace or private planning files are required.
