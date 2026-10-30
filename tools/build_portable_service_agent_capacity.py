"""Package the tested service controller with corrected capacity accounting."""
import build_portable_fleet_agent as base
import deploy_fleet_capacity_accounting as tested

if __name__=='__main__':
    base.RUN='installer-service-agent-20261015-a3'
    base.E=base.E.with_name(base.RUN+'.json')
    base.tested.E=tested.E
    base.tested.sources=tested.sources
    base.main()
