"""One fresh public HTTPS queued OCR job against the deployed successor."""
import argparse,datetime as dt,json,re,subprocess
import appliance_container_operations as d

def main():
 p=argparse.ArgumentParser();p.add_argument('--run-id',required=True);p.add_argument('--api-id',required=True);a=p.parse_args()
 d.need(re.fullmatch(r'ocr-resource-protocol-\d{8}-a[1-9]\d*',a.run_id),'invalid_run')
 d.need(re.fullmatch('[a-f0-9]{64}',a.api_id),'invalid_api')
 out=d.ROOT/'evidence/validation/acceptance'/(a.run_id+'.json');d.need(not out.exists(),'occupied')
 source=d.ROOT/'tools/main_box_postboot_ocr_probe.mjs'
 code=source.read_text().replace('main-box-postboot-ocr-20260907-a1',a.run_id)
 code=code.replace('body.input={reference_id:referenceId};',"body.input={reference_id:referenceId};body.x_teamaibox={...body.x_teamaibox,model_profile_id:process.env.OCR_PROFILE_ID};")
 code=code.replace("report.status='passed';break;", "assert.equal(report.profileId,process.env.OCR_PROFILE_ID);report.status='passed';break;")
 result=dict(runId=a.run_id,status='failed',startedAt=dt.datetime.now(dt.timezone.utc).isoformat(),apiId=a.api_id,
     sources={str(source.relative_to(d.ROOT)):d.sha(source.read_bytes()),'tools/run_ocr_resource_protocol.py':d.sha((d.ROOT/'tools/run_ocr_resource_protocol.py').read_bytes())},executedSourceDigest=d.sha(code.encode()),phonesBefore=d.phones())
 try:
  # Keep the transport exit code even for a failed protocol assertion.
  raw=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=8','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3',d.MAIN,'sudo -n docker exec -i '+a.api_id+' node --input-type=module -'],input=code,text=True,capture_output=True,timeout=240)
  result['protocol']=json.loads(raw.stdout);result['exitCode']=raw.returncode
  d.need(raw.returncode==0 and result['protocol']['status']=='passed','protocol_failed')
  result['phonesAfter']=d.phones();d.need(result['phonesBefore']==result['phonesAfter'],'phones_changed');result['status']='passed'
 except Exception as e:result['failure']=str(e)
 result['completedAt']=dt.datetime.now(dt.timezone.utc).isoformat()
 with out.open('x') as f:json.dump(result,f,indent=2)
 print(json.dumps(result));return result['status']!='passed'
if __name__=='__main__':raise SystemExit(main())
