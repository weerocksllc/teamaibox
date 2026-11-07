;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy was not distributed with this file, obtain one at
;; https://mozilla.org/MPL/2.0/.
;; Copyright (c) Weerocks LLC
(ns app.teamaibox.teams
  (:require
   [app.common.exceptions :as ex]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.db :as db]
   [app.util.json :as json])
  (:import
   [java.net URI]
   [java.net.http HttpClient HttpClient$Redirect HttpClient$Version HttpRequest HttpRequest$BodyPublishers HttpResponse$BodyHandlers]
   [java.time Duration]))

(defn enabled? [] (some? (cf/get :teamaibox-team-roles-uri)))
(defn deny! [] (ex/raise :type :not-found :code :object-not-found))

(def ^:private directory-client
  (delay (-> (HttpClient/newBuilder)
             (.connectTimeout (Duration/ofMillis 500))
             (.version HttpClient$Version/HTTP_1_1)
             (.followRedirects HttpClient$Redirect/NEVER)
             (.build))))

(defn confirm-drive-import!
  [profile-id operation-id digest]
  (let [uri (cf/get :teamaibox-drive-import-check-uri)
        key (cf/get :teamaibox-handoff-key)]
    (when-not (and uri (string? key)) (deny!))
    (try
      (let [request (-> (HttpRequest/newBuilder (URI/create (str uri)))
                        (.timeout (Duration/ofMillis 3000))
                        (.header "authorization" (str "Bearer " key))
                        (.header "content-type" "application/json")
                        (.POST (HttpRequest$BodyPublishers/ofString (json/encode-str
                                 {:profileId (str profile-id) :operationId (str operation-id) :sourceDigest digest})))
                        (.build))
            response (.send @directory-client request (HttpResponse$BodyHandlers/discarding))]
        (when-not (= 200 (.statusCode response)) (deny!)))
      (catch Exception _ (deny!)))))

(defn roles!
  "Fetch live role facts for a native profile. Operator-configured destination
  only; no browser cookie, native credential, or design data leaves Penpot."
  [profile-id]
  (let [key (cf/get :teamaibox-handoff-key)
        uri (cf/get :teamaibox-team-roles-uri)]
    (when-not (and (uuid? profile-id) uri (string? key)) (deny!))
    (try
      (let [request (-> (HttpRequest/newBuilder (URI/create (str uri)))
                        (.timeout (Duration/ofMillis 750))
                        (.header "authorization" (str "Bearer " key))
                        (.header "content-type" "application/json")
                        (.POST (HttpRequest$BodyPublishers/ofString (json/encode-str {:profileId (str profile-id)})))
                        (.build))
            response (.send @directory-client request (HttpResponse$BodyHandlers/ofByteArray))
            body (.body response)]
        (when-not (and (= 200 (.statusCode response)) (<= (alength body) 131072)) (deny!))
        (let [{:keys [profileId memberships]} (json/decode body)
              entries (mapv (fn [{:keys [teamId role]}] [(uuid/parse* teamId) role]) memberships)]
          (when-not (and (= (str profile-id) profileId) (vector? memberships) (<= (count entries) 1000)
                         (= (count entries) (count (into {} entries)))
                         (every? (fn [[id role]] (and id (#{"admin" "editor" "viewer"} role))) entries))
            (deny!))
          (into {} entries)))
      (catch Exception _ (deny!)))))

(defn managed?
  [cfg team-id]
  (and (uuid? team-id)
       (some? (:teamaibox-founder-id
               (db/exec-one! cfg ["select teamaibox_founder_id from team where id = ?" team-id])))))

(defn synchronize!
  "Only projects platform-managed team grants. No profiles, files, project
  roles or private native teams are altered. Fetch under the per-profile lock
  so a late response cannot reapply a grant from an earlier request."
  [cfg profile-id]
  (when (enabled?)
    (db/tx-run! cfg
      (fn [{:keys [::db/conn]}]
        (db/xact-lock! conn profile-id)
        (let [roles (roles! profile-id)
              current (db/exec! conn
                        ["select t.id,t.teamaibox_founder_id,r.is_owner,r.is_admin,r.can_edit
                           from team t left join team_profile_rel r on r.team_id=t.id and r.profile_id=?
                          where t.teamaibox_founder_id is not null
                            and (r.id is not null or t.id = any(?))"
                         profile-id (db/create-array conn "uuid" (keys roles))])]
          (doseq [{:keys [id teamaibox-founder-id is-owner is-admin can-edit]} current]
            (if-let [role (get roles id)]
              (let [admin (= role "admin")
                    owner (and admin (= profile-id teamaibox-founder-id))
                    edit (not= role "viewer")]
                (when-not (= [owner admin edit] [is-owner is-admin can-edit])
                  (db/exec-one! conn
                    ["insert into team_profile_rel (id,team_id,profile_id,is_owner,is_admin,can_edit)
                      values (?,?,?,?,?,?) on conflict (team_id,profile_id) do update
                      set is_owner=excluded.is_owner,is_admin=excluded.is_admin,can_edit=excluded.can_edit"
                     (uuid/next) id profile-id owner admin edit])))
              (db/exec-one! conn ["delete from team_profile_rel where team_id=? and profile_id=?" id profile-id]))))))))

(def ^:private native-directory-mutations
  {"leave-team" :id "delete-team" :id "update-team" :id
   "update-team-member-role" :team-id "delete-team-member" :team-id
   "create-team-invitations" :team-id "create-team-access-request" :team-id
   "update-team-invitation-role" :team-id "delete-team-invitation" :team-id})

(defn check-rpc!
  [cfg profile-id method params]
  (when (enabled?)
    (synchronize! cfg profile-id)
    (when-let [key (get native-directory-mutations method)]
      (let [value (get params key)
            id (if (uuid? value) value (uuid/parse* value))]
        (when (managed? cfg id) (deny!))))))
