"""Carry the already tested model-capable Agent into new-node installers."""
import build_portable_fleet_agent as base
import deploy_fleet_model_agents as tested

if __name__ == '__main__':
    base.RUN='installer-model-agent-20261016-a1'
    base.E=base.E.with_name(base.RUN+'.json')
    base.tested.E=tested.E
    base.tested.sources=tested.sources
    base.main()
