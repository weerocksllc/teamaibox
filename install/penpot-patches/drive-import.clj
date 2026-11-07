;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy was not distributed with this file, obtain one at
;; https://mozilla.org/MPL/2.0/.
;; Copyright (c) Weerocks LLC
;;
;; Appended to the checksum-bound native binfile namespace. Import and the
;; result receipt share the same native transaction.

(def ^:private schema:teamaibox-drive-import-target
  [:map
   [:operation-id ::sm/uuid]
   [:target-profile-id ::sm/uuid]
   [:project-id ::sm/uuid]
   [:source-digest [:re #"^[a-f0-9]{64}$"]]])

(defn- private-import!
  [params]
  (let [request (rph/get-request params)
        key (cf/get :teamaibox-handoff-key)
        supplied (yreq/get-header request "authorization")]
    (when-not (and (string? key) (string? supplied)
                   (nil? (yreq/get-header request "origin"))
                   (nil? (yreq/get-header request "cookie"))
                   (java.security.MessageDigest/isEqual
                    (.getBytes (str "Bearer " key) "UTF-8")
                    (.getBytes supplied "UTF-8")))
      (tab-teams/deny!))))

(defn- drive-import-result
  [cfg {:keys [operation-id target-profile-id project-id source-digest]}]
  (when-let [row (db/exec-one! cfg ["select * from teamaibox_drive_import where operation_id=?" operation-id])]
    (when-not (= [target-profile-id project-id source-digest]
                 ((juxt :profile-id :project-id :source-digest) row))
      (tab-teams/deny!))
    {:operation-id operation-id :file-id (:file-id row)}))

(sv/defmethod ::teamaibox-drive-import-result
  {::rpc/auth false ::audit/skip true ::sm/params schema:teamaibox-drive-import-target}
  [cfg {:keys [target-profile-id project-id] :as params}]
  (private-import! params)
  (tab-teams/synchronize! cfg target-profile-id)
  (projects/check-edition-permissions! cfg target-profile-id project-id)
  (or (drive-import-result cfg params) {:state "pending"}))

(defn- verify-drive-file!
  [file digest]
  (let [path (fs/path (:path file))
        n (java.nio.file.Files/size path)
        sha (java.security.MessageDigest/getInstance "SHA-256")]
    (when-not (<= 30 n (* 32 1024 1024)) (tab-teams/deny!))
    (with-open [stream (java.security.DigestInputStream.
                       (java.nio.file.Files/newInputStream path (make-array java.nio.file.OpenOption 0)) sha)]
      (.transferTo stream (java.io.OutputStream/nullOutputStream)))
    (when-not (= digest (.formatHex (java.util.HexFormat/of) (.digest sha))) (tab-teams/deny!))
    (when-not (= 1 (count (:files (bf.v3/get-manifest path)))) (tab-teams/deny!))
    path))

(sv/defmethod ::teamaibox-drive-import
  {::rpc/auth false ::audit/skip true
   ::sm/params [:merge schema:teamaibox-drive-import-target
                [:map [:file media.v/schema:upload]]]}
  [cfg {:keys [operation-id target-profile-id project-id source-digest file] :as params}]
  (private-import! params)
  (db/tx-run! cfg
    (fn [{:keys [::db/conn] :as cfg}]
      (db/xact-lock! conn operation-id)
      (tab-teams/synchronize! cfg target-profile-id)
      (projects/check-edition-permissions! cfg target-profile-id project-id)
      (or (drive-import-result cfg params)
          (let [team (teams/get-team cfg :profile-id target-profile-id :project-id project-id)
                path (verify-drive-file! file source-digest)
                [file-id] (bf.v3/import-files!
                  (assoc cfg ::bfc/input path ::bfc/project-id project-id ::bfc/profile-id target-profile-id
                    ::bfc/features (cfeat/get-team-enabled-features cf/flags team)
                    ::bfc/import-max-object-size (cf/get :binfile-import-max-object-size)
                    ::bfc/import-max-zip-entries (cf/get :binfile-import-max-zip-entries)))]
            (when-not (uuid? file-id) (tab-teams/deny!))
            ;; Recheck native destination and original Drive version before
            ;; the native transaction becomes visible.
            (tab-teams/synchronize! cfg target-profile-id)
            (projects/check-edition-permissions! cfg target-profile-id project-id)
            (tab-teams/confirm-drive-import! target-profile-id operation-id source-digest)
            (db/exec-one! conn ["insert into teamaibox_drive_import
                (operation_id,profile_id,project_id,source_digest,file_id) values (?,?,?,?,?)"
              operation-id target-profile-id project-id source-digest file-id])
            {:operation-id operation-id :file-id file-id})))))
