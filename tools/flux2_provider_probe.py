#!/usr/bin/env python3
"""Exercise a TLS FLUX.2 Provider without retaining generated image content."""
from __future__ import annotations
import argparse,base64,hashlib,io,json,ssl,urllib.error,urllib.request,uuid
from typing import Any

def call(origin:str,token:str,ca:str,path:str,body:dict[str,Any]|None=None,authorized:bool=True,timeout:int=1800)->tuple[int,dict[str,Any]]:
    raw=None if body is None else json.dumps(body,separators=(",",":"),ensure_ascii=False).encode()
    headers={"Accept":"application/json"};
    if body is not None:headers["Content-Type"]="application/json"
    if authorized:headers["Authorization"]="Bearer "+token
    request=urllib.request.Request(origin.rstrip("/")+path,data=raw,headers=headers,method="POST" if body is not None else "GET")
    context=ssl.create_default_context(cafile=ca)
    try:
        with urllib.request.urlopen(request,context=context,timeout=timeout) as response:return response.status,json.loads(response.read())
    except urllib.error.HTTPError as error:return error.code,json.loads(error.read())
def facts(value:dict[str,Any])->dict[str,Any]:
    from PIL import Image,ImageStat
    encoded=value.get("data",[{}])[0].get("b64_json");assert isinstance(encoded,str)
    raw=bytearray(base64.b64decode(encoded,validate=True))
    try:
        image=Image.open(io.BytesIO(raw)).convert("RGB");assert image.size==(512,512) and sum(ImageStat.Stat(image).var)/3>=80
        return {"bytes":len(raw),"sha256":"sha256:"+hashlib.sha256(raw).hexdigest(),"width":image.width,"height":image.height,
                "runtime":{k:(value.get("x_teamaibox") or {}).get(k) for k in ("seed","steps","guidance_scale","output_format","preset_key","reference_count")}}
    finally:raw[:]=b"\0"*len(raw)
def main()->int:
    p=argparse.ArgumentParser(description=__doc__);p.add_argument("--origin",required=True);p.add_argument("--token-file",required=True);p.add_argument("--ca-file",required=True);p.add_argument("--run-id",required=True);a=p.parse_args()
    with open(a.token_file) as h:token=h.read().strip()
    status,unauth=call(a.origin,token,a.ca_file,"/v1/models",authorized=False);assert status==401 and unauth.get("error",{}).get("code")=="unauthorized"
    status,models=call(a.origin,token,a.ca_file,"/v1/models");assert status==200 and [x["id"] for x in models["data"]]==["flux2-klein-4b-nvfp4"]
    status,prepared=call(a.origin,token,a.ca_file,"/v1/models/prepare",{"model":"flux2-klein-4b-nvfp4"});assert status==200 and prepared.get("loaded") is True
    from PIL import Image,ImageDraw
    source=Image.new("RGB",(512,512),"white");ImageDraw.Draw(source).rectangle((96,96,416,416),fill=(208,40,48));buf=io.BytesIO();source.save(buf,format="PNG");encoded=base64.b64encode(buf.getvalue()).decode()
    namespace=uuid.uuid5(uuid.NAMESPACE_URL,"teamaibox:"+a.run_id)
    common={"model":"flux2-klein-4b-nvfp4","n":1,"size":"512x512","response_format":"b64_json"}
    body={**common,"prompt":"Studio photograph of a small green ceramic robot on a clean white desk, no text","x_teamaibox":{"job_id":str(uuid.uuid5(namespace,"generation")),"seed":53001,"steps":4,"guidance_scale":1.0,"negative_prompt":"","output_format":"png","preset_key":"drawing.fast.v1"}}
    status,generation=call(a.origin,token,a.ca_file,"/v1/images/generations",body);assert status==200
    edit={**common,"prompt":"Keep the composition and change the red square into a glossy green ceramic tile","image_b64":encoded,"x_teamaibox":{"job_id":str(uuid.uuid5(namespace,"edit")),"seed":53002,"steps":4,"guidance_scale":1.0,"negative_prompt":"","output_format":"png","preset_key":"drawing.edit.v1"}}
    status,edited=call(a.origin,token,a.ca_file,"/v1/images/edits",edit);assert status==200
    status,unloaded=call(a.origin,token,a.ca_file,"/v1/models/unload",{"model":"flux2-klein-4b-nvfp4"});assert status==200 and unloaded.get("loaded") is False
    result={"passed":True,"unauthenticatedHttpStatus":401,"model":"flux2-klein-4b-nvfp4","prepared":True,"generation":facts(generation),"edit":facts(edited),"unloaded":True,"contentRetained":False}
    token="[REDACTED]";encoded="[CLEARED]";print(json.dumps(result,sort_keys=True,separators=(",",":")));return 0
if __name__=="__main__":raise SystemExit(main())
