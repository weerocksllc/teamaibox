"""Package the tested managed-transfer Agent for fresh auxiliary installations."""
import build_portable_fleet_agent as base
import deploy_managed_fleet_transfer_agents as tested

if __name__=='__main__':
    base.RUN='installer-transfer-agent-20261014-a1'
    base.E=base.E.with_name(base.RUN+'.json')
    base.tested.E=tested.E
    base.tested.sources=tested.sources
    base.main()
