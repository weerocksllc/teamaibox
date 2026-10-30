# Development appliance safety policy

Normal development and automated tests may inspect state and create isolated,
bounded application containers. They must not mutate boot, root storage,
platform firmware, NVIDIA drivers, or high-speed network configuration.

The following operations are protected:

- root-disk-repartition
- luks-conversion
- secure-boot-change
- platform-firmware-change
- nvidia-driver-change
- connectx-roce-reconfiguration

Before any protected operation, copy maintenance-plan.template.json outside the
source tree's shared template, complete it without embedding credentials, have
the lab owner set its status to approved, and validate it during the stated
maintenance window with:

    tools/lab_maintenance_guard.py \
      --operation luks-conversion \
      --plan /absolute/path/to/approved-plan.json

The guard checks that the operation and target are explicit, the window is
bounded, data risk is acknowledged, an owner and approval are recorded, and
prechecks, implementation, validation, rollback, recovery, out-of-band access,
and evidence destinations are all present. It returns a SHA-256-bound receipt
but deliberately executes nothing.

Any future maintenance automation must:

1. refuse to run without a fresh successful guard receipt for the exact plan
   bytes, target, operation, and current maintenance window;
2. re-check target identity through non-secret stable inventory facts;
3. show a dry run and exact affected devices or interfaces;
4. stop on unexpected state instead of attempting repair;
5. preserve remote and out-of-band access until validation is complete;
6. retain before, command, result, after, and rollback evidence;
7. never place credentials, recovery keys, machine IDs,
   network addresses, serial numbers, or user content in repository evidence.

Repository tasks, ordinary administrator UI actions, model scheduling, and
Agent operation confirmations are not maintenance approvals. This policy is
specifically for changes capable of making the development appliance
unbootable, inaccessible, or difficult to recover.

