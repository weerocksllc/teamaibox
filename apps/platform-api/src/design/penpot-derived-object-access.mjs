import {PlatformError} from '../../../../packages/observability/src/index.mjs';

const denied=()=>new PlatformError('object_not_found','Object was not found',{status:404});

export function penpotDerivedObjectAccess({database,teamDirectory,nativePermissions}){
  if(!database?.query||!teamDirectory?.activeProfile||!nativePermissions?.check)throw new TypeError('Design download authority required');
  return async ({actorIdentityId,objectId,objectVersion})=>{
    try{
      // The original design-export row is retained even when Drive adds a
      // provenance row, moves the file, or copies the same object version.
      const {rows}=await database.query(`SELECT metadata->'source' AS source FROM objects.artifact_provenance
        WHERE object_id=$1 AND object_version=$2 AND artifact_kind='design-export' AND application_key='official.penpot'
        LIMIT 2`,[objectId,objectVersion]);
      if(rows.length!==1||!['png','pdf'].includes(rows[0].source?.format))throw denied();
      const profileId=await teamDirectory.activeProfile(actorIdentityId);
      await nativePermissions.check({profileId,fileId:rows[0].source.fileId,pageId:rows[0].source.pageId});
    }catch{throw denied();}
  };
}
